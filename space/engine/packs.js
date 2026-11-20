import { cachedBytes } from "./datacache.js";
// Compact runtime data formats, shared by the browser and the build scripts.
//
// Height grids (int16, row-major, north row first), gzip-compressed. Two
// encodings, told apart by the first bytes after decompression:
//   legacy      each value minus its western neighbour (no header)
//   "H2D1"      planar prediction (left + up − up-left), the residuals split
//               into a low-byte plane and a high-byte plane — 8–20% smaller
//               after gzip, and exactly lossless.
//
// Bundles ("SXB1"): many small gzip members in one file, with an index, so a
// block of neighbouring tiles costs one request and one file:
//   "SXB1" · u32 count · count × (u16 key length · key · u32 offset · u32 length) · members…

const MAGIC_GRID = [0x48, 0x32, 0x44, 0x31];         // "H2D1"
const MAGIC_BUNDLE = [0x53, 0x58, 0x42, 0x31];       // "SXB1"
const isMagic = (u8, m) => u8.length >= 4 && u8[0] === m[0] && u8[1] === m[1] && u8[2] === m[2] && u8[3] === m[3];

// raw: decompressed bytes (ArrayBuffer or Uint8Array) → Int16Array(W*H)
export function decodeGrid(raw, W, H) {
  const u8 = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const h = new Int16Array(W * H);
  if (isMagic(u8, MAGIC_GRID)) {
    const n = W * H, lo = 4, hi = 4 + n;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const a = x ? h[i - 1] : y ? h[i - W] : 0, b = y ? h[i - W] : a, c = x && y ? h[i - W - 1] : b;
      const r = (u8[lo + i] | (u8[hi + i] << 8)) << 16 >> 16;
      h[i] = (a + b - c + r) << 16 >> 16;
    }
    return h;
  }
  const src = new Int16Array(u8.buffer, u8.byteOffset, (u8.byteLength >> 1));
  for (let y = 0; y < H; y++) { let v = 0; for (let x = 0; x < W; x++) { v = (v + src[y * W + x]) << 16 >> 16; h[y * W + x] = v; } }
  return h;
}
// Int16Array(W*H) → bytes to gzip (H2D1).
export function encodeGrid(h, W, H) {
  const n = W * H, out = new Uint8Array(4 + 2 * n);
  out.set(MAGIC_GRID, 0);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const a = x ? h[i - 1] : y ? h[i - W] : 0, b = y ? h[i - W] : a, c = x && y ? h[i - W - 1] : b;
    const r = (h[i] - (a + b - c)) & 0xffff;
    out[4 + i] = r & 255; out[4 + n + i] = r >> 8;
  }
  return out;
}

// entries: [[key, Uint8Array], …] → Uint8Array
export function writeBundle(entries) {
  const enc = new TextEncoder(), keys = entries.map(([k]) => enc.encode(k));
  let head = 8; for (const k of keys) head += 2 + k.length + 8;
  const total = head + entries.reduce((s, [, b]) => s + b.length, 0);
  const out = new Uint8Array(total), v = new DataView(out.buffer);
  out.set(MAGIC_BUNDLE, 0); v.setUint32(4, entries.length, true);
  let o = 8, data = head;
  entries.forEach(([, b], i) => {
    v.setUint16(o, keys[i].length, true); o += 2; out.set(keys[i], o); o += keys[i].length;
    v.setUint32(o, data, true); v.setUint32(o + 4, b.length, true); o += 8;
    out.set(b, data); data += b.length;
  });
  return out;
}
// ArrayBuffer → Map(key → Uint8Array view)
export function readBundle(buf) {
  const u8 = new Uint8Array(buf), v = new DataView(buf);
  if (!isMagic(u8, MAGIC_BUNDLE)) throw new Error("not a bundle");
  const n = v.getUint32(4, true), dec = new TextDecoder(), map = new Map();
  let o = 8;
  for (let i = 0; i < n; i++) {
    const kl = v.getUint16(o, true); o += 2;
    const key = dec.decode(u8.subarray(o, o + kl)); o += kl;
    const off = v.getUint32(o, true), len = v.getUint32(o + 4, true); o += 8;
    map.set(key, u8.subarray(off, off + len));
  }
  return map;
}

// Browser: gunzip bytes with the built-in stream decompressor.
export async function gunzip(bytes) {
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}
// One fetch per bundle, shared by every tile in it.
const bundles = new Map();
export function fetchBundle(url) {
  const k = String(url);
  if (!bundles.has(k)) {
    // Through the bounded persistent cache (engine/datacache.js).
    const p = cachedBytes(url).then(readBundle);
    p.catch(() => bundles.delete(k));
    bundles.set(k, p);
    // Keep the most recent ~64 bundles in memory.
    if (bundles.size > 64) bundles.delete(bundles.keys().next().value);
  }
  return bundles.get(k);
}
