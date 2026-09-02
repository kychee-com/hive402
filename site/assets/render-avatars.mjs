// smith's avatar as a face: the two upper cells become eyes, the lower one is
// either a mouth or the cell it is today.
//
// Supersampled 4x4 because a hand-rolled rasteriser with hard edges looks like
// a screenshot of 1998 at avatar size, and the eyes are small enough that
// aliasing on a circle is the first thing anyone would notice.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const S = 256, SS = 4;
const BG = [0x0d, 0x11, 0x17];
const GOLD = [0xe0, 0xa9, 0x2e];   // the hexagon, from site/avatar.svg
const IRIS = [0xd2, 0x99, 0x22];   // the deeper brand gold, so it reads apart
const WHITE = [0xff, 0xff, 0xff];

const HEX = [[128, 46], [199, 87], [199, 169], [128, 210], [57, 169], [57, 87]];
const inPoly = (poly, x, y) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const near = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

// A smile: the lower part of a ring, ends tapered by clipping to an angle.
function inSmile(x, y) {
  const cx = 128, cy = 138, r = 27, w = 9;
  const d = Math.hypot(x - cx, y - cy);
  if (d < r - w / 2 || d > r + w / 2) return false;
  const a = Math.atan2(y - cy, x - cx);          // 0 = right, +pi/2 = down
  return a > Math.PI * 0.16 && a < Math.PI * 0.84;
}

function colourAt(x, y, smiling) {
  if (!inPoly(HEX, x, y)) return BG;
  for (const [ex, ey] of [[105, 112], [151, 112]]) {
    if (near(x, y, ex, ey, 5.5)) return BG;        // pupil
    if (near(x, y, ex, ey, 10.5)) return IRIS;     // iris
    if (near(x, y, ex, ey, 17)) return WHITE;      // sclera
  }
  if (smiling ? inSmile(x, y) : near(x, y, 128, 161, 17)) return BG;
  return GOLD;
}

function render(smiling, file) {
  const raw = Buffer.alloc(S * (S * 3 + 1));
  let p = 0;
  for (let y = 0; y < S; y += 1) {
    raw[p++] = 0;
    for (let x = 0; x < S; x += 1) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const c = colourAt(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, smiling);
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const n = SS * SS;
      raw[p++] = Math.round(r / n); raw[p++] = Math.round(g / n); raw[p++] = Math.round(b / n);
    }
  }
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => { let c = 0xffffffff; for (const v of buf) c = table[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]));
  console.log("wrote", file);
}

render(true, "smith-A-smiling.png");
render(false, "smith-B-cell.png");
