// The global Earth base pack (scripts/earth/build-global.mjs), shared by the
// builder, the surface workers and the main thread.
//
// Land cover: 1/120° cells (≈ 925 m) in 3° tiles named like ESA WorldCover's
// (N48E000 = south-west corner 48° N 0° E), bundled per 15° × 15°. One byte
// per cell: class << 4 | water share (0–3 quarters) << 2 (low two bits 0).
// Classes are veg-format.js CLASS (1–11, the WorldCover classes).
//
// Lines: Natural Earth roads and rivers: u32 count, then per line u8 kind,
// u16 width (m), the point count and the deltas (1e-5°), all zigzag varints.

export const GLOBAL_CELL = 1 / 120;
export const GLOBAL_TILE = 3;
export const GLOBAL_BUNDLE = 15;
export const LINE_KIND = { highway: 1, primary: 2, road: 3, track: 4, river: 10, riverDry: 11 };

export const tileName = (lat, lon) => {
  const la = Math.floor(lat / GLOBAL_TILE) * GLOBAL_TILE, lo = Math.floor(lon / GLOBAL_TILE) * GLOBAL_TILE;
  return (la >= 0 ? "N" : "S") + String(Math.abs(la)).padStart(2, "0") + (lo >= 0 ? "E" : "W") + String(Math.abs(lo)).padStart(3, "0");
};
export const bundleKey = (lat, lon) => Math.floor(lat / GLOBAL_BUNDLE) * GLOBAL_BUNDLE + "_" + Math.floor(lon / GLOBAL_BUNDLE) * GLOBAL_BUNDLE;

// → [{ kind, width, pts: Float64Array [lat, lon, …] }]
export function decodeLines(u8) {
  let o = 0;
  const n = u8[0] | (u8[1] << 8) | (u8[2] << 16) | (u8[3] * 16777216); o = 4;
  const vi = () => { let v = 0, m = 1, b; do { b = u8[o++]; v += (b & 127) * m; m *= 128; } while (b & 128); return v % 2 ? -(v + 1) / 2 : v / 2; };
  const out = [];
  for (let i = 0; i < n; i++) {
    const kind = u8[o], width = u8[o + 1] | (u8[o + 2] << 8); o += 3;
    let len = 0, m = 1, b; do { b = u8[o++]; len += (b & 127) * m; m *= 128; } while (b & 128);
    len /= 2;                                                          // the count is zigzag-encoded like the deltas
    const pts = new Float64Array(len * 2);
    let x = 0, y = 0;
    for (let k = 0; k < len; k++) { x += vi(); y += vi(); pts[k * 2] = y / 1e5; pts[k * 2 + 1] = x / 1e5; }
    out.push({ kind, width, pts });
  }
  return out;
}
