// Writes a small Godot project to try the 3D tools: a texture folder with brick albedo, normal and
// roughness maps, a crate model (models/crate.glb), and a scene with a 30 x 30 m floor (mesh and collider).
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

// A 1 m crate as a binary glTF: 8 vertices and 12 triangles, built here so no model file is needed.
function crateGlb() {
  const positions = [];
  for (const x of [-0.5, 0.5]) for (const y of [0, 1]) for (const z of [-0.5, 0.5]) positions.push(x, y, z);
  const indices = [0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3];
  const bin = Buffer.alloc(72 + 96);
  indices.forEach((value, i) => bin.writeUInt16LE(value, i * 2));
  positions.forEach((value, i) => bin.writeFloatLE(value, 72 + i * 4));
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'Crate' }],
    meshes: [{ name: 'Crate', primitives: [{ attributes: { POSITION: 1 }, indices: 0 }] }],
    accessors: [
      { bufferView: 0, componentType: 5123, count: 36, type: 'SCALAR' },
      { bufferView: 1, componentType: 5126, count: 8, type: 'VEC3', min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 72, target: 34963 }, { buffer: 0, byteOffset: 72, byteLength: 96, target: 34962 }],
    buffers: [{ byteLength: bin.length }],
  };
  let jsonText = JSON.stringify(json);
  while (jsonText.length % 4 !== 0) jsonText += ' ';
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonText.length + 8 + bin.length, 8);
  const chunkHeader = (length, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(length, 0); b.writeUInt32LE(type, 4); return b; };
  return Buffer.concat([header, chunkHeader(jsonText.length, 0x4e4f534a), Buffer.from(jsonText), chunkHeader(bin.length, 0x004e4942), bin]);
}
mkdirSync(join(folder, 'models'), { recursive: true });
writeFileSync(join(folder, 'models', 'crate.glb'), crateGlb());

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
