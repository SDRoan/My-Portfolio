// Windowed reads from a remote Cloud-Optimized GeoTIFF (single band, 8-bit,
// tiled, DEFLATE or uncompressed, no predictor) — ESA WorldCover's format.
// Only the header and the internal tiles that overlap the window are
// fetched, with HTTP range requests; raw files are cached outside the
// repository by the caller.
//
//   const r = await readCogWindow(url, { south, north, west, east }, fetchRange)
//   → { W, H, data: Uint8Array (row-major, north row first), bounds, px }
//
// The window is snapped outward to whole source pixels; `bounds` are the
// snapped pixel edges, `px` the pixel size in degrees.

import { inflateSync } from "node:zlib";
import { parseHeader } from "./geotiff.mjs";

export async function readCogWindow(url, box, fetchRange) {
  let head = await fetchRange(url, 0, 65535);
  let t = parseHeader(head);
  if (t.bps !== 8) throw new Error("COG window: 8-bit only");
  if (t.predictor && t.predictor !== 1) throw new Error("COG window: no predictor support");
  if (!t.tileW) throw new Error("COG window: tiled files only");
  for (const k of ["tileOffsets", "tileBytes"]) if (t[k] && t[k].deferred) {
    const d = t[k], b = await fetchRange(url, d.at, d.at + d.cnt * 4 - 1);
    t[k] = Array.from({ length: d.cnt }, (_, i) => (t.be ? b.readUInt32BE(i * 4) : b.readUInt32LE(i * 4)));
  }
  const [sx, sy] = t.pixelScale, west0 = t.tiepoint[3], north0 = t.tiepoint[4];
  const x0 = Math.max(0, Math.floor((box.west - west0) / sx)), x1 = Math.min(t.W, Math.ceil((box.east - west0) / sx));
  const y0 = Math.max(0, Math.floor((north0 - box.north) / sy)), y1 = Math.min(t.H, Math.ceil((north0 - box.south) / sy));
  const W = Math.max(0, x1 - x0), H = Math.max(0, y1 - y0), data = new Uint8Array(W * H);
  const across = Math.ceil(t.W / t.tileW);
  const tx0 = Math.floor(x0 / t.tileW), tx1 = Math.floor((x1 - 1) / t.tileW), ty0 = Math.floor(y0 / t.tileH), ty1 = Math.floor((y1 - 1) / t.tileH);
  for (let ty = ty0; ty <= ty1; ty++) {
    // One request per row of tiles (they are stored consecutively).
    const idx = []; for (let tx = tx0; tx <= tx1; tx++) idx.push(ty * across + tx);
    const a = Math.min(...idx.map((i) => t.tileOffsets[i])), z = Math.max(...idx.map((i) => t.tileOffsets[i] + t.tileBytes[i]));
    const contiguous = idx.every((i) => t.tileOffsets[i] >= a && t.tileOffsets[i] + t.tileBytes[i] <= z) && z - a < 64 << 20;
    const blob = contiguous ? await fetchRange(url, a, z - 1) : null;
    for (let tx = tx0; tx <= tx1; tx++) {
      const i = ty * across + tx, o = t.tileOffsets[i], n = t.tileBytes[i];
      if (!n) continue;
      const raw = blob ? blob.subarray(o - a, o - a + n) : await fetchRange(url, o, o + n - 1);
      const px = t.compression === 8 || t.compression === 32946 ? inflateSync(raw) : raw;
      for (let y = 0; y < t.tileH; y++) {
        const gy = ty * t.tileH + y;
        if (gy < y0 || gy >= y1) continue;
        for (let x = 0; x < t.tileW; x++) {
          const gx = tx * t.tileW + x;
          if (gx < x0 || gx >= x1) continue;
          data[(gy - y0) * W + gx - x0] = px[y * t.tileW + x];
        }
      }
    }
  }
  return { W, H, data, px: sx, bounds: { west: west0 + x0 * sx, east: west0 + x1 * sx, north: north0 - y0 * sy, south: north0 - y1 * sy } };
}

// A whole internal overview of a COG (level 0 = full resolution, 1 = half, …),
// little-endian, 8-bit, tiled. The overview's georeferencing follows level 0's,
// scaled. Two or three range requests: the header, then the overview's tiles.
//   → { W, H, data: Uint8Array, bounds, px }
export async function readCogOverview(url, level, fetchRange) {
  const head = await fetchRange(url, 0, 131071);
  if (head.toString("latin1", 0, 2) !== "II") throw new Error("COG overview: little-endian only");
  const ifd = (off) => {
    const n = head.readUInt16LE(off), t = {};
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12, tag = head.readUInt16LE(e), type = head.readUInt16LE(e + 2), cnt = head.readUInt32LE(e + 4);
      const size = { 3: 2, 4: 4, 12: 8 }[type] || 1, at = size * cnt <= 4 ? e + 8 : head.readUInt32LE(e + 8);
      const rd = (k) => (type === 3 ? head.readUInt16LE(at + k * 2) : type === 4 ? head.readUInt32LE(at + k * 4) : type === 12 ? head.readDoubleLE(at + k * 8) : head[at + k]);
      t[tag] = at + size * cnt <= head.length ? Array.from({ length: cnt }, (_, k) => rd(k)) : null;
    }
    return { t, next: head.readUInt32LE(off + 2 + n * 12) };
  };
  let off = head.readUInt32LE(4), base = null, cur = null;
  for (let k = 0; off && k <= level; k++) { const r = ifd(off); if (!k) base = r.t; cur = r.t; off = r.next; if (k < level && !off) throw new Error("no overview level " + level); }
  const W = cur[256][0], H = cur[257][0], tw = cur[322][0], th = cur[323][0], offs = cur[324], lens = cur[325];
  if (!offs || !lens) throw new Error("overview tile table beyond the header");
  if (cur[258][0] !== 8) throw new Error("COG overview: 8-bit only");
  const across = Math.ceil(W / tw), data = new Uint8Array(W * H);
  const a = Math.min(...offs.filter((o, i) => lens[i])), z = Math.max(...offs.map((o, i) => o + lens[i]));
  const blob = await fetchRange(url, a, z - 1);
  offs.forEach((o, i) => {
    if (!lens[i]) return;
    const raw = blob.subarray(o - a, o - a + lens[i]), px = cur[259][0] === 8 || cur[259][0] === 32946 ? inflateSync(raw) : raw;
    const x0 = (i % across) * tw, y0 = Math.floor(i / across) * th;
    for (let y = 0; y < th && y0 + y < H; y++) for (let x = 0; x < tw && x0 + x < W; x++) data[(y0 + y) * W + x0 + x] = px[y * tw + x];
  });
  const sx = base[33550][0] * base[256][0] / W, west = base[33922][3], north = base[33922][4];
  return { W, H, data, px: sx, bounds: { west, north, east: west + sx * W, south: north - sx * H } };
}
