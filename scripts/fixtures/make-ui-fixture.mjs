// Writes a small Godot project to try the UI tools: scenes/broken.tscn is a menu with defects on purpose
// (a button outside the screen, a label that is cut off, text with little contrast, a panel that blocks a
// button, a tiny button, a focus neighbor that does not exist).
// Usage: node scripts/fixtures/make-ui-fixture.mjs [folder]
// It prints the project folder.

import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const folder = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'godot-mcp-ui-'));
mkdirSync(join(folder, 'scenes'), { recursive: true });

writeFileSync(join(folder, 'project.godot'), 'config_version=5\n\n[application]\n\nconfig/name="Prueba UI"\n');

const rect = (left, top, width, height) => `layout_mode = 0\noffset_left = ${left}\noffset_top = ${top}\noffset_right = ${left + width}\noffset_bottom = ${top + height}\n`;

writeFileSync(join(folder, 'scenes', 'broken.tscn'), `[gd_scene format=3]

[node name="Menu" type="Control"]
layout_mode = 3
anchors_preset = 15
anchor_right = 1.0
anchor_bottom = 1.0
grow_horizontal = 2
grow_vertical = 2

[node name="Title" type="Label" parent="."]
${rect(40, 20, 300, 40)}text = "Menu principal"

[node name="Jugar" type="Button" parent="."]
${rect(40, 100, 200, 48)}text = "Jugar"

[node name="Salir" type="Button" parent="."]
${rect(1200, 650, 150, 48)}text = "Salir"
focus_neighbor_right = NodePath("NoExiste")

[node name="Tiny" type="Button" parent="."]
${rect(300, 100, 20, 20)}text = "x"

[node name="Fondo" type="ColorRect" parent="."]
${rect(40, 300, 360, 70)}color = Color(0.5, 0.5, 0.5, 1)

[node name="Pale" type="Label" parent="Fondo"]
${rect(10, 10, 340, 40)}theme_override_colors/font_color = Color(0.58, 0.58, 0.58, 1)
text = "Texto casi invisible sobre gris"

[node name="Largo" type="Label" parent="."]
${rect(40, 420, 120, 30)}clip_text = true
text = "Este texto es demasiado largo para su caja"

[node name="Sin foco" type="Button" parent="."]
${rect(40, 480, 200, 48)}text = "Sin foco"
focus_mode = 0

[node name="Aceptar" type="Button" parent="."]
${rect(600, 100, 200, 48)}text = "Aceptar"

[node name="Cortina" type="ColorRect" parent="."]
${rect(580, 90, 240, 70)}color = Color(0.1, 0.1, 0.1, 0.4)
`);

console.log(folder);
