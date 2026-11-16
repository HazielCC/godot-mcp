// Writes a small Godot game to try the testing tools: a main scene with a player that moves with ui_right and
// a score label, a scene whose script fails in _ready, and a scene that points to a file that does not exist.
// Usage: node scripts/fixtures/make-game-fixture.mjs [folder]
// It prints the project folder.

import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const folder = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'godot-mcp-game-'));
mkdirSync(join(folder, 'scripts'), { recursive: true });
mkdirSync(join(folder, 'scenes'), { recursive: true });

const lines = (...rows) => rows.join('\n') + '\n';

writeFileSync(join(folder, 'project.godot'), lines('config_version=5', '', '[application]', '', 'config/name="Prueba juego"', 'run/main_scene="res://scenes/main.tscn"'));

writeFileSync(join(folder, 'scripts', 'player.gd'), lines(
  'extends Node2D',
  'class_name Player',
  '',
  'signal moved(x)',
  '',
  'var speed := 200.0',
  'var score := 0',
  '',
  'func _process(delta):',
  '\tif Input.is_action_pressed("ui_right"):',
  '\t\tposition.x += speed * delta',
  '\t\tmoved.emit(position.x)',
  '',
  'func add_score(amount: int) -> int:',
  '\tscore += amount',
  '\treturn score',
  '',
  'static func double(value: int) -> int:',
  '\treturn value * 2',
  '',
  'func _private_helper():',
  '\tpass',
));

writeFileSync(join(folder, 'scripts', 'broken.gd'), lines(
  'extends Node',
  '',
  'func _ready():',
  '\tvar missing = null',
  '\tmissing.explode()',
));

writeFileSync(join(folder, 'scenes', 'main.tscn'), lines(
  '[gd_scene load_steps=2 format=3]',
  '',
  '[ext_resource type="Script" path="res://scripts/player.gd" id="1"]',
  '',
  '[node name="Main" type="Node2D"]',
  '',
  '[node name="Player" type="Node2D" parent="."]',
  'script = ExtResource("1")',
  '',
  '[node name="Score" type="Label" parent="."]',
  'offset_left = 20.0',
  'offset_top = 20.0',
  'offset_right = 220.0',
  'offset_bottom = 60.0',
  'text = "Score: 0"',
));

writeFileSync(join(folder, 'scenes', 'broken_ready.tscn'), lines(
  '[gd_scene load_steps=2 format=3]',
  '',
  '[ext_resource type="Script" path="res://scripts/broken.gd" id="1"]',
  '',
  '[node name="Broken" type="Node"]',
  'script = ExtResource("1")',
));

writeFileSync(join(folder, 'scenes', 'missing.tscn'), lines(
  '[gd_scene load_steps=2 format=3]',
  '',
  '[ext_resource type="Texture2D" path="res://art/nope.png" id="1"]',
  '',
  '[node name="Missing" type="Sprite2D"]',
  'texture = ExtResource("1")',
));

console.log(folder);
