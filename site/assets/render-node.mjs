// The NODE's avatar: the three-cell cluster from site/hive-cells.svg.
//
// A hive is several cells; an agent is one. smith wears the single-cell mark,
// so the node wearing the cluster reads correctly at a glance and, at 32px in a
// member list, "three shapes" and "one shape" stay apart even when the detail
// does not survive.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const S = 256, BG = [0x0d, 0x11, 0x17], GOLD = [0xd2, 0x99, 0x22];

// Straight from hive-cells.svg, in its own coordinates.
const cells = [[120, 88], [237.8, 88], [178.9, 190]];
const hexAt = (cx, cy) => [
  [cx, cy - 68], [cx + 58.9, cy - 34], [cx + 58.9, cy + 34],
  [cx, cy + 68], [cx - 58.9, cy + 34], [cx - 58.9, cy - 34],
];
// Fit the cluster inside the circle a client crops to.
const CX = 178.9, CY = 139, SCALE = 0.62;
const map = ([x, y]) => [(x - CX) * SCALE + S / 2, (y - CY) * SCALE + S / 2];
const polys = cells.map((c) => hexAt(...c).map(map));

const inPoly = (poly, x, y) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
// The occupant dot each cell holds, punched back out in the background colour.
const dots = cells.map((c) => map(c));
const inDot = (x, y) => dots.some(([dx, dy]) => (x - dx) ** 2 + (y - dy) ** 2 <= (15 * SCALE * 1.9) ** 2);

const raw = Buffer.alloc(S * (S * 3 + 1));
let p = 0;
for (let y = 0; y < S; y += 1) {
  raw[p++] = 0;
  for (let x = 0; x < S; x += 1) {
    const fx = x + 0.5, fy = y + 0.5;
    const on = polys.some((poly) => inPoly(poly, fx, fy)) && !inDot(fx, fy);
    const px = on ? GOLD : BG;
    raw[p++] = px[0]; raw[p++] = px[1]; raw[p++] = px[2];
  }
}

const table = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b) => { let c = 0xffffffff; for (const v of b) c = table[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 2;
writeFileSync("hive402-node.png", Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
]));
console.log("wrote hive402-node.png");
