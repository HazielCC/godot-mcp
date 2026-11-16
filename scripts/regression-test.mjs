// Regression tests that do not need Godot. GODOT_PATH points to node itself: it answers
// --version, so the server accepts it, and it fails on the Godot flags (--headless, --path),
// which simulates a Godot that crashes without printing anything.

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, '..', 'build', 'index.js');

const project = mkdtempSync(join(tmpdir(), 'godot-mcp-regression-'));
writeFileSync(join(project, 'project.godot'), 'config_version=5\n\n[application]\n\nconfig/name="Mi Juego"\n');
mkdirSync(join(project, 'scenes'));
writeFileSync(join(project, 'scenes', 'main.tscn'), '[gd_scene format=3]\n\n[node name="Main" type="Node2D"]\n');

const server = spawn(process.execPath, [serverPath], {
  stdio: ['pipe', 'pipe', 'ignore'],
  env: { ...process.env, GODOT_PATH: process.execPath },
});

const responses = new Map();
let buffer = '';
server.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      if (message.id !== undefined) responses.set(message.id, message);
    }
  }
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (responses.has(id)) return resolve(responses.get(id));
      if (Date.now() - started > 30000) return reject(new Error(`no answer to ${method}`));
      setTimeout(check, 20);
    };
    check();
  });
}

const callTool = async (name, args) => (await request('tools/call', { name, arguments: args })).result;
const textOf = (result) => result.content.map((c) => c.text ?? '').join('\n');

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`ok   ${name}`);
  } else {
    failures++;
    console.error(`FAIL ${name} ${detail}`);
  }
}

async function main() {
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'regression-test', version: '0.0.0' },
  });
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // A Godot that stops with an error and prints nothing must not be reported as a success.
  const created = await callTool('create_scene', { projectPath: project, scenePath: 'scenes/new.tscn' });
  check('create_scene reports a Godot that failed', created.isError === true, textOf(created).slice(0, 200));

  const added = await callTool('add_node', {
    projectPath: project, scenePath: 'scenes/main.tscn', nodeType: 'Sprite2D', nodeName: 'Icon',
  });
  check('add_node reports a Godot that failed', added.isError === true, textOf(added).slice(0, 200));

  // The project name comes from project.godot (it used to fall back to the folder name).
  const info = await callTool('get_project_info', { projectPath: project });
  check('get_project_info reads config/name', textOf(info).includes('"name": "Mi Juego"'), textOf(info).slice(0, 200));

  // A file name that contains two dots is not a path traversal.
  const dots = await callTool('read_scene', { projectPath: project, scenePath: 'scenes/main..tscn' });
  check('a name with two dots is not rejected as traversal', !textOf(dots).includes('Invalid path'), textOf(dots).slice(0, 200));

  const climb = await callTool('read_scene', { projectPath: project, scenePath: '../main.tscn' });
  check('a ".." segment is still rejected', climb.isError === true);
}

main()
  .catch((error) => {
    failures++;
    console.error(`FAIL ${error.message}`);
  })
  .finally(() => {
    server.kill();
    rmSync(project, { recursive: true, force: true });
    if (failures > 0) {
      console.error(`${failures} regression test(s) failed`);
      process.exit(1);
    }
    console.log('OK: regression tests passed');
    process.exit(0);
  });
