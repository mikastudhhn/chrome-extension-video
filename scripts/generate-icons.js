// Reproducible extension icons based on the existing green pause mark.
// Explicit output keeps asset preparation separate from schema-3 activation.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { deflateSync } from 'node:zlib';

const output = process.argv[2];
if (!output) throw new Error('Bitte einen expliziten Ausgabeordner angeben.');
await mkdir(resolve(output), { recursive: true });
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const label = Buffer.from(type);
  const length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  crc.writeUInt32BE(crc32(Buffer.concat([label, bytes])));
  return Buffer.concat([length, label, bytes, crc]);
}
for (const size of [16, 32, 48, 128]) {
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let coverage = 0, white = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const px = (x + (sx + .5) / 4) / size, py = (y + (sy + .5) / 4) / size;
      const dx = Math.max(.24 - px, 0, px - .76), dy = Math.max(.24 - py, 0, py - .76);
      if (dx * dx + dy * dy > .22 * .22) continue;
      coverage++;
      if (py >= .28 && py <= .72 && ((px >= .31 && px <= .44) || (px >= .56 && px <= .69))) white++;
    }
    const index = y * (size * 4 + 1) + 1 + x * 4;
    const blend = coverage ? white / coverage : 0;
    [40, 86, 64].forEach((value, i) => { pixels[index + i] = Math.round(value + (255 - value) * blend); });
    pixels[index + 3] = Math.round(coverage / 16 * 255);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  await writeFile(join(output, `pause-${size}.png`), Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))
  ]));
}
