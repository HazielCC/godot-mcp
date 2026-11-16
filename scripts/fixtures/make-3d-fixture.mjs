// Writes a small Godot project to try the 3D tools: a texture folder with brick albedo, normal and
// roughness maps, and a scene with a 30 x 30 m floor (mesh and collider).
// Usage: node scripts/fixtures/make-3d-fixture.mjs [folder]
// It prints the project folder.

import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { png } from './png.mjs';

const folder = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'godot-mcp-3d-'));
mkdirSync(join(folder, 'textures', 'brick'), { recursive: true });
mkdirSync(join(folder, 'scenes'), { recursive: true });

const brick = (x, y) => (y % 8 < 1 || (x + (Math.floor(y / 8) % 2) * 8) % 16 < 1);
writeFileSync(join(folder, 'textures', 'brick', 'brick_albedo.png'), png(32, 32, (x, y) => (brick(x, y) ? [200, 190, 180, 255] : [150, 70, 50, 255])));
writeFileSync(join(folder, 'textures', 'brick', 'brick_normal.png'), png(32, 32, () => [128, 128, 255, 255]));
writeFileSync(join(folder, 'textures', 'brick', 'brick_roughness.png'), png(32, 32, (x, y) => (brick(x, y) ? [230, 230, 230, 255] : [150, 150, 150, 255])));
writeFileSync(join(folder, 'textures', 'brick', 'notes.png'), png(4, 4, () => [0, 0, 0, 255]));

writeFileSync(join(folder, 'project.godot'), 'config_version=5\n\n[application]\n\nconfig/name="Prueba 3D"\n');
writeFileSync(join(folder, 'scenes', 'level.tscn'), `[gd_scene format=3]

[sub_resource type="PlaneMesh" id="PlaneMesh_1"]
size = Vector2(30, 30)

[sub_resource type="BoxShape3D" id="BoxShape3D_1"]
size = Vector3(30, 0.2, 30)

[node name="Level" type="Node3D"]

[node name="Floor" type="StaticBody3D" parent="."]

[node name="Mesh" type="MeshInstance3D" parent="Floor"]
mesh = SubResource("PlaneMesh_1")

[node name="Shape" type="CollisionShape3D" parent="Floor"]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, -0.1, 0)
shape = SubResource("BoxShape3D_1")
`);

console.log(folder);
