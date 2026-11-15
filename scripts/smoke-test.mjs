// Smoke test: starts the built MCP server over stdio, performs the
// initialize handshake, and checks that every expected tool is listed.
// It does not require Godot to be installed.

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, '..', 'build', 'index.js');

const EXPECTED_TOOLS = [
  'launch_editor',
  'run_project',
  'get_debug_output',
  'stop_project',
  'get_godot_version',
  'list_projects',
  'get_project_info',
  'create_scene',
  'add_node',
  'load_sprite',
  'export_mesh_library',
  'save_scene',
  'get_uid',
  'update_project_uids',
  'check_script',
  'check_project_scripts',
  'run_tests',
  'diagnose_project',
  'read_scene',
  'set_node_property',
];

const TIMEOUT_MS = 15000;

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const server = spawn(process.execPath, [serverPath], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

const timer = setTimeout(() => fail(`no response within ${TIMEOUT_MS} ms`), TIMEOUT_MS);

const responses = new Map();
let buffer = '';

server.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail(`server wrote non-JSON to stdout: ${line.slice(0, 200)}`);
    }
    if (message.id !== undefined) {
      responses.set(message.id, message);
    }
  }
});

let finished = false;

server.on('exit', (code) => {
  if (!finished) {
    fail(`server exited early with code ${code}`);
  }
});

function send(message) {
  server.stdin.write(JSON.stringify(message) + '\n');
}

function waitFor(id) {
  return new Promise((resolve) => {
    const check = () => {
      if (responses.has(id)) return resolve(responses.get(id));
      setTimeout(check, 20);
    };
    check();
  });
}

async function main() {
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '0.0.0' },
    },
  });
  const init = await waitFor(1);
  if (init.error) fail(`initialize returned error: ${JSON.stringify(init.error)}`);
  if (!init.result?.capabilities?.tools) fail('server did not advertise the tools capability');

  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const list = await waitFor(2);
  if (list.error) fail(`tools/list returned error: ${JSON.stringify(list.error)}`);

  const names = list.result.tools.map((t) => t.name);
  const missing = EXPECTED_TOOLS.filter((name) => !names.includes(name));
  if (missing.length > 0) fail(`missing tools: ${missing.join(', ')}`);

  const unexpected = names.filter((name) => !EXPECTED_TOOLS.includes(name));
  if (unexpected.length > 0) {
    console.warn(`WARN: tools not in the expected list: ${unexpected.join(', ')}`);
  }

  clearTimeout(timer);
  finished = true;
  console.log(`OK: initialize and tools/list passed (${names.length} tools)`);
  server.kill();
  process.exit(0);
}

main().catch((error) => fail(error.message));
