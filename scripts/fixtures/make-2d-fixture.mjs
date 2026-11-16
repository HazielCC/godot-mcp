// Writes a small Godot project to try the 2D tools: a 4x2 sprite sheet (8 frames of 16x16),
// a tile atlas (4x1 tiles of 16x16), and a scene with a StaticBody2D that holds a Sprite2D.
// Usage: node scripts/fixtures/make-2d-fixture.mjs [folder]
// It prints the project folder.

import { deflateSync } from 'zlib';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** PNG (RGBA, 8 bit) from a function that returns [r, g, b, a] for each pixel. */
function png(width, height, pixel) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      row.set([r, g, b, a], 1 + x * 4);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const folder = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'godot-mcp-2d-'));
mkdirSync(join(folder, 'art'), { recursive: true });
mkdirSync(join(folder, 'scenes'), { recursive: true });

// Sheet: each frame is a filled circle whose color changes with the frame number.
writeFileSync(join(folder, 'art', 'sheet.png'), png(64, 32, (x, y) => {
  const frame = Math.floor(x / 16) + 4 * Math.floor(y / 16);
  const dx = (x % 16) - 8;
  const dy = (y % 16) - 8;
  return dx * dx + dy * dy <= 49 ? [30 * frame + 20, 200 - 20 * frame, 90, 255] : [0, 0, 0, 0];
}));

// Atlas: four solid tiles in different colors.
writeFileSync(join(folder, 'art', 'tiles.png'), png(64, 16, (x) => {
  const colors = [[90, 90, 90, 255], [60, 140, 60, 255], [60, 90, 170, 255], [170, 130, 60, 255]];
  return colors[Math.floor(x / 16)];
}));

writeFileSync(join(folder, 'project.godot'), 'config_version=5\n\n[application]\n\nconfig/name="Prueba 2D"\n\n[rendering]\n\ntextures/canvas_textures/default_texture_filter=0\n');
writeFileSync(join(folder, 'scenes', 'main.tscn'), '[gd_scene format=3]\n\n[ext_resource type="Texture2D" path="res://art/sheet.png" id="1"]\n\n[node name="Main" type="Node2D"]\n\n[node name="Body" type="StaticBody2D" parent="."]\nposition = Vector2(64, 64)\n\n[node name="Sprite2D" type="Sprite2D" parent="Body"]\ntexture = ExtResource("1")\nhframes = 4\nvframes = 2\nframe = 1\n');

console.log(folder);
