// Regression tests that do not need Godot. GODOT_PATH points to node itself: it answers
// --version, so the server accepts it, and it fails on the Godot flags (--headless, --path),
// which simulates a Godot that crashes without printing anything.

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
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

  // 2D tools: bad arguments are rejected before Godot runs.
  const code = (result) => result.structuredContent?.error?.code;
  writeFileSync(join(project, 'sheet.png'), 'not really a png');

  const noOutput = await callTool('import_spritesheet', { projectPath: project, texturePath: 'sheet.png' });
  check('import_spritesheet requires outputPath', noOutput.isError === true && code(noOutput) === 'INVALID_ARGUMENT');

  const noFrame = await callTool('import_spritesheet', { projectPath: project, texturePath: 'sheet.png', outputPath: 'a.tres' });
  check('import_spritesheet requires a frame size', noFrame.isError === true && textOf(noFrame).includes('frameWidth'));

  const badExt = await callTool('import_spritesheet', { projectPath: project, texturePath: 'sheet.png', outputPath: 'a.res', frameWidth: 8, frameHeight: 8 });
  check('import_spritesheet requires a .tres output', badExt.isError === true && textOf(badExt).includes('.tres'));

  const outside = await callTool('import_spritesheet', { projectPath: project, texturePath: 'sheet.png', outputPath: '../escape.tres', frameWidth: 8, frameHeight: 8 });
  check('import_spritesheet keeps the output inside the project', outside.isError === true);

  const okArgs = await callTool('import_spritesheet', { projectPath: project, texturePath: 'sheet.png', outputPath: 'frames/a.tres', frameWidth: 8, frameHeight: 8 });
  check('import_spritesheet reports a Godot that failed', okArgs.isError === true && !textOf(okArgs).includes('Saved'), textOf(okArgs).slice(0, 200));

  const badKind = await callTool('auto_collision', { projectPath: project, scenePath: 'scenes/main.tscn', nodePath: 'Main/Icon', kind: 'wall' });
  check('auto_collision rejects an unknown kind', badKind.isError === true && textOf(badKind).includes('kind'));

  const noScene = await callTool('auto_collision', { projectPath: project, scenePath: 'scenes/none.tscn', nodePath: 'Main/Icon' });
  check('auto_collision reports a missing scene', noScene.isError === true && textOf(noScene).includes('does not exist'));

  const badLegend = await callTool('build_tilemap', { projectPath: project, scenePath: 'scenes/main.tscn', rows: ['#.@'], legend: { '#': { x: 0, y: 0 } } });
  check('build_tilemap finds a character missing from the legend', badLegend.isError === true && textOf(badLegend).includes('@'));

  const badRows = await callTool('build_tilemap', { projectPath: project, scenePath: 'scenes/main.tscn', rows: [], legend: {} });
  check('build_tilemap rejects empty rows', badRows.isError === true && textOf(badRows).includes('rows'));

  const emptyLayers = await callTool('setup_parallax_2d', { projectPath: project, scenePath: 'scenes/main.tscn', layers: [] });
  check('setup_parallax_2d rejects empty layers', emptyLayers.isError === true && textOf(emptyLayers).includes('layers'));

  const missingTexture = await callTool('setup_parallax_2d', { projectPath: project, scenePath: 'scenes/main.tscn', layers: [{ name: 'Sky', texturePath: 'sky.png' }] });
  check('setup_parallax_2d checks that the texture exists', missingTexture.isError === true && textOf(missingTexture).includes('does not exist'));

  const bigRender = await callTool('render_scene_2d', { projectPath: project, scenePath: 'scenes/main.tscn', width: 99999 });
  check('render_scene_2d limits the size', bigRender.isError === true && code(bigRender) === 'INVALID_ARGUMENT');

  const failedRender = await callTool('render_scene_2d', { projectPath: project, scenePath: 'scenes/main.tscn' });
  check('render_scene_2d reports a Godot that failed', failedRender.isError === true && !failedRender.content.some((c) => c.type === 'image'));

  // 3D tools: bad arguments are rejected before Godot runs.
  mkdirSync(join(project, 'textures'));
  const noLegend = await callTool('build_blockout', { projectPath: project, scenePath: 'scenes/main.tscn', rows: ['#@'], legend: { '#': { height: 2 } } });
  check('build_blockout finds a character missing from the legend', noLegend.isError === true && textOf(noLegend).includes('@'));

  const badHeight = await callTool('build_blockout', { projectPath: project, scenePath: 'scenes/main.tscn', rows: ['#'], legend: { '#': { height: -1 } } });
  check('build_blockout checks the height', badHeight.isError === true && textOf(badHeight).includes('height'));

  const badColor = await callTool('build_blockout', { projectPath: project, scenePath: 'scenes/main.tscn', rows: ['#'], legend: { '#': { color: 'red' } } });
  check('build_blockout checks the color', badColor.isError === true && textOf(badColor).includes('color'));

  const noFolder = await callTool('create_pbr_material', { projectPath: project, folder: 'textures/none', outputPath: 'm.tres' });
  check('create_pbr_material reports a missing folder', noFolder.isError === true && textOf(noFolder).includes('Folder does not exist'));

  const noNode = await callTool('create_pbr_material', { projectPath: project, folder: 'textures', outputPath: 'm.tres', scenePath: 'scenes/main.tscn' });
  check('create_pbr_material needs nodePath with scenePath', noNode.isError === true && textOf(noNode).includes('nodePath'));

  const manyCopies = await callTool('scatter_multimesh', { projectPath: project, scenePath: 'scenes/main.tscn', count: 99999 });
  check('scatter_multimesh limits the count', manyCopies.isError === true && textOf(manyCopies).includes('count'));

  const badMesh = await callTool('scatter_multimesh', { projectPath: project, scenePath: 'scenes/main.tscn', meshPath: 'tree.png' });
  check('scatter_multimesh asks for a Mesh resource', badMesh.isError === true && textOf(badMesh).includes('Mesh resource'));

  const badGeometry = await callTool('bake_navmesh', { projectPath: project, scenePath: 'scenes/main.tscn', parsedGeometry: 'lights' });
  check('bake_navmesh checks parsedGeometry', badGeometry.isError === true && textOf(badGeometry).includes('parsedGeometry'));

  const badView = await callTool('render_scene_3d', { projectPath: project, scenePath: 'scenes/main.tscn', views: ['iso', 'iso'] });
  check('render_scene_3d rejects repeated views', badView.isError === true && code(badView) === 'INVALID_ARGUMENT');

  const failedRender3d = await callTool('render_scene_3d', { projectPath: project, scenePath: 'scenes/main.tscn' });
  check('render_scene_3d reports a Godot that failed', failedRender3d.isError === true && !failedRender3d.content.some((c) => c.type === 'image'));

  // A scene whose MultiMesh holds data keeps it: here Godot fails (it is node), and the file must stay as it was.
  const multiText = '[gd_scene format=3]\n\n[sub_resource type="MultiMesh" id="M"]\ntransform_format = 1\ninstance_count = 1\nbuffer = PackedFloat32Array(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0)\n\n[node name="Main" type="Node3D"]\n\n[node name="Trees" type="MultiMeshInstance3D" parent="."]\nmultimesh = SubResource("M")\n';
  writeFileSync(join(project, 'scenes', 'multi.tscn'), multiText);
  const kept = await callTool('add_node', { projectPath: project, scenePath: 'scenes/multi.tscn', nodeType: 'Node3D', nodeName: 'Extra' });
  check('a failed operation reports the failure', kept.isError === true);
  check('a failed operation leaves the MultiMesh data as it was', readFileSync(join(project, 'scenes', 'multi.tscn'), 'utf8') === multiText);

  // UI tools: bad arguments are rejected before Godot runs.
  const badTree = await callTool('build_ui', { projectPath: project, scenePath: 'scenes/ui.tscn', tree: { type: 'Button', props: { script: 'res://x.gd' } } });
  check('build_ui does not accept a script', badTree.isError === true && textOf(badTree).includes('script'));

  const badType = await callTool('build_ui', { projectPath: project, scenePath: 'scenes/ui.tscn', tree: { type: '../Evil' } });
  check('build_ui rejects an invalid node type', badType.isError === true && textOf(badType).includes('Invalid node type'));

  const badChild = await callTool('build_ui', { projectPath: project, scenePath: 'scenes/ui.tscn', tree: { type: 'VBoxContainer', children: [{ type: 'Button', name: 'a/b' }] } });
  check('build_ui rejects an unsafe node name', badChild.isError === true && textOf(badChild).includes('Invalid node name'));

  let deep = { type: 'Control' };
  for (let i = 0; i < 14; i++) deep = { type: 'VBoxContainer', children: [deep] };
  const tooDeep = await callTool('build_ui', { projectPath: project, scenePath: 'scenes/ui.tscn', tree: deep });
  check('build_ui limits the depth', tooDeep.isError === true && textOf(tooDeep).includes('levels'));

  const notScene = await callTool('build_ui', { projectPath: project, scenePath: 'scenes/ui.res', tree: { type: 'Control' } });
  check('build_ui needs a .tscn path', notScene.isError === true && textOf(notScene).includes('.tscn'));

  const newScene = await callTool('build_ui', { projectPath: project, scenePath: 'scenes/ui.tscn', tree: { type: 'Control' } });
  check('build_ui reports a Godot that failed on a new scene', newScene.isError === true && !textOf(newScene).includes('Created'));

  const badPalette = await callTool('make_theme', { projectPath: project, outputPath: 'themes/a.tres', palette: { primary: 'blue' } });
  check('make_theme checks the colors', badPalette.isError === true && textOf(badPalette).includes('primary'));

  const unknownColor = await callTool('make_theme', { projectPath: project, outputPath: 'themes/a.tres', palette: { sky: '#ffffff' } });
  check('make_theme rejects an unknown palette key', unknownColor.isError === true && textOf(unknownColor).includes('sky'));

  const badSize = await callTool('render_scene_ui', { projectPath: project, scenePath: 'scenes/main.tscn', sizes: ['huge'] });
  check('render_scene_ui rejects an unknown size', badSize.isError === true && code(badSize) === 'INVALID_ARGUMENT');

  const manySizes = await callTool('ui_lint', { projectPath: project, scenePath: 'scenes/main.tscn', sizes: ['small', 'phone', 'tablet', 'hd', 'fhd'] });
  check('ui_lint limits the sizes', manySizes.isError === true && textOf(manySizes).includes('1 to 4'));

  const badTouch = await callTool('ui_lint', { projectPath: project, scenePath: 'scenes/main.tscn', minTouchSize: -5 });
  check('ui_lint checks minTouchSize', badTouch.isError === true && textOf(badTouch).includes('minTouchSize'));

  const failedInspect = await callTool('ui_check_focus', { projectPath: project, scenePath: 'scenes/main.tscn' });
  check('ui_check_focus reports a Godot that failed', failedInspect.isError === true && code(failedInspect) !== 'INVALID_ARGUMENT');

  const missingScene = await callTool('ui_check_contrast', { projectPath: project, scenePath: 'scenes/none.tscn' });
  check('ui_check_contrast reports a missing scene', missingScene.isError === true && textOf(missingScene).includes('does not exist'));

  // Particle tools: bad arguments are rejected before Godot runs.
  const badPreset = await callTool('create_particles', { projectPath: project, scenePath: 'scenes/main.tscn', preset: 'lava' });
  check('create_particles rejects an unknown preset', badPreset.isError === true && textOf(badPreset).includes('preset'));

  const manyParticles = await callTool('create_particles', { projectPath: project, scenePath: 'scenes/main.tscn', amount: 100000 });
  check('create_particles limits the amount', manyParticles.isError === true && textOf(manyParticles).includes('amount'));

  const badColors = await callTool('create_particles', { projectPath: project, scenePath: 'scenes/main.tscn', colors: ['red'] });
  check('create_particles checks the colors', badColors.isError === true && textOf(badColors).includes('colors'));

  const badGravity = await callTool('create_particles', { projectPath: project, scenePath: 'scenes/main.tscn', gravity: [1] });
  check('create_particles checks the vectors', badGravity.isError === true && textOf(badGravity).includes('gravity'));

  const badDimension = await callTool('create_particles', { projectPath: project, scenePath: 'scenes/main.tscn', dimension: '4d' });
  check('create_particles checks the dimension', badDimension.isError === true && textOf(badDimension).includes('dimension'));

  const failedParticles = await callTool('create_particles', { projectPath: project, scenePath: 'scenes/main.tscn', preset: 'fire' });
  check('create_particles reports a Godot that failed', failedParticles.isError === true && !textOf(failedParticles).includes('Added'));

  const nothingToTune = await callTool('tune_particles', { projectPath: project, scenePath: 'scenes/main.tscn', nodePath: 'Main/Fire' });
  check('tune_particles needs a value to change', nothingToTune.isError === true && textOf(nothingToTune).includes('at least one'));

  const tuneSize = await callTool('tune_particles', { projectPath: project, scenePath: 'scenes/main.tscn', nodePath: 'Main/Fire', size: 2 });
  check('tune_particles refuses size', tuneSize.isError === true && textOf(tuneSize).includes('size'));

  const unsortedTimes = await callTool('render_particles', { projectPath: project, scenePath: 'scenes/main.tscn', times: [0.5, 0.2] });
  check('render_particles needs ascending times', unsortedTimes.isError === true && code(unsortedTimes) === 'INVALID_ARGUMENT');

  const badBackground = await callTool('render_particles', { projectPath: project, scenePath: 'scenes/main.tscn', background: 'black' });
  check('render_particles checks the background', badBackground.isError === true && textOf(badBackground).includes('background'));

  const failedParticleRender = await callTool('render_particles', { projectPath: project, scenePath: 'scenes/main.tscn' });
  check('render_particles reports a Godot that failed', failedParticleRender.isError === true && !failedParticleRender.content.some((c) => c.type === 'image'));
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
