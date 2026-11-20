// Builds the global Earth base pack: what every place on Earth has, outside
// the detailed region packs too.
//
//   node scripts/earth/fetch-global-landcover.mjs      (once: WorldCover overviews, cached)
//   node scripts/earth/build-global.mjs
//
// Sources
//   land cover  ESA WorldCover 10 m 2021 v200 (CC BY 4.0), its level-5 overview
//               (≈ 300 m), aggregated to 1/120° cells (≈ 925 m): the dominant
//               class (3 × 3 majority-filtered) and the share of water in the cell.
//   roads       Natural Earth 10 m roads v5 (public domain): major roads only.
//   rivers      Natural Earth 10 m rivers + lake centerlines, with the Europe and
//               North America supplements (public domain).
//
// Output: space/data/earth/global/
//   index.json            bundle list, classes, sources
//   b<lat>_<lon>.bin      one SXB1 bundle per 15° × 15° cell that has land:
//     "lc/<N48E000>"      a 3° tile: 360 × 360 bytes, rows from the north,
//                         class << 4 | water quarter << 2 (low two bits 0);
//                         lossless WebP (the byte in R, G and B) or gzip, whichever is smaller
//     "vec"               gzip: roads and rivers crossing the cell (see encodeLines)

import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readShapefile } from "../lib/shapefile.mjs";
import { writeBundle } from "../../space/engine/packs.js";
import { CLASS_NAMES } from "../../space/earth/veg-format.js";
import { GLOBAL_CELL, GLOBAL_TILE, GLOBAL_BUNDLE, LINE_KIND } from "../../space/earth/global-format.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "space", "data", "earth", "global");
const CACHE = join(tmpdir(), "open-earth-cache");
const WC = join(CACHE, "worldcover-L5"), NE = join(CACHE, "ne"), TMP = join(CACHE, "global-tmp");
mkdirSync(TMP, { recursive: true });
const N = Math.round(GLOBAL_TILE / GLOBAL_CELL);             // 360 cells per 3° tile
// WorldCover value → class (veg-format.js CLASS); 0 (no data: open sea in coastal tiles) → water.
const WC_CLASS = new Uint8Array(256).fill(8);
Object.entries({ 10: 1, 20: 2, 30: 3, 40: 4, 50: 5, 60: 6, 70: 7, 80: 8, 90: 9, 95: 10, 100: 11 }).forEach(([k, v]) => { WC_CLASS[k] = v; });

function tileGrid(name) {
  const raw = gunzipSync(readFileSync(join(WC, name + ".u8.gz"))), W = raw.readUInt32LE(0), H = raw.readUInt32LE(4), px = raw.subarray(16);
  const out = new Uint8Array(N * N), cls = new Uint8Array(N * N), wq = new Uint8Array(N * N), h = new Uint16Array(12), k = W / N;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    h.fill(0);
    let n = 0, water = 0, tree = 0;
    const sy0 = Math.floor(y * k), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * k)), sx0 = Math.floor(x * k), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * k));
    for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) {
      const c = WC_CLASS[px[sy * W + sx]]; h[c]++; n++;
      if (c === 8) water++; else if (c === 1 || c === 10) tree++;
    }
    let b = 1; for (let c = 1; c < 12; c++) if (h[c] > h[b]) b = c;
    cls[y * N + x] = b; wq[y * N + x] = Math.round(water / n * 3);
    void tree;
  }
  // A 3 × 3 majority filter on the class (a cell that disagrees with at least
  // five of its neighbours joins them): removes single-cell speckle, halves the size.
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let c = cls[y * N + x];
    if (y > 0 && x > 0 && y < N - 1 && x < N - 1) {
      h.fill(0);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) h[cls[(y + dy) * N + x + dx]]++;
      let b = c; for (let q = 1; q < 12; q++) if (h[q] > h[b]) b = q;
      if (h[b] >= 5) c = b;
    }
    out[y * N + x] = (c << 4) | (wq[y * N + x] << 2);
  }
  return out;
}
async function encodeTile(name, grid) {
  const gz = gzipSync(grid, { level: 9 });
  const pam = join(TMP, name + ".pam"), webp = join(TMP, name + ".webp");
  const rgba = Buffer.alloc(N * N * 4);
  for (let i = 0; i < N * N; i++) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = grid[i]; rgba[i * 4 + 3] = 255; }
  writeFileSync(pam, Buffer.concat([Buffer.from("P7\nWIDTH " + N + "\nHEIGHT " + N + "\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n"), rgba]));
  await run("cwebp", ["-quiet", "-lossless", "-exact", "-z", "6", pam, "-o", webp]);
  const wb = readFileSync(webp);
  rmSync(pam); rmSync(webp);
  // Prefix: "W" for WebP, "G" for gzip.
  return wb.length < gz.length ? Buffer.concat([Buffer.from("W"), wb]) : Buffer.concat([Buffer.from("G"), gz]);
}

// ── lines: Douglas–Peucker, then zigzag varint deltas in 1e-5° ──
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [x0, y0] = pts[a], [x1, y1] = pts[b], c = Math.cos(y0 * Math.PI / 180);
    let best = -1, bd = tol;
    for (let i = a + 1; i < b; i++) {
      const dx = (x1 - x0) * c, dy = y1 - y0, px = (pts[i][0] - x0) * c, py = pts[i][1] - y0, L = dx * dx + dy * dy || 1e-12;
      const t = Math.max(0, Math.min(1, (px * dx + py * dy) / L)), d = Math.hypot(px - t * dx, py - t * dy);
      if (d > bd) { bd = d; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function varint(out, v) { v = v < 0 ? -2 * v - 1 : 2 * v; while (v >= 128) { out.push((v & 127) | 128); v = Math.floor(v / 128); } out.push(v); }
// lines: [{ kind, width (m), pts: [[lon, lat], …] }] → u32 count, then per line: u8 kind, u16 width, varint n, deltas.
function encodeLines(lines) {
  const out = [];
  const n = lines.length; out.push(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255);
  for (const l of lines) {
    out.push(l.kind, l.width & 255, l.width >> 8);
    varint(out, l.pts.length);
    let px = 0, py = 0;
    for (const [x, y] of l.pts) { const qx = Math.round(x * 1e5), qy = Math.round(y * 1e5); varint(out, qx - px); varint(out, qy - py); px = qx; py = qy; }
  }
  return gzipSync(Buffer.from(out), { level: 9 });
}
function loadLines() {
  const lines = [];
  const shp = (n) => readShapefile(readFileSync(join(NE, n + ".shp")), readFileSync(join(NE, n + ".dbf")));
  // Roads: no ferries; class by Natural Earth type.
  for (const f of shp("ne_10m_roads")) {
    const t = f.props.type || "";
    if (/Ferry/.test(t)) continue;
    const kind = /Major Highway|Beltway|Bypass/.test(t) ? LINE_KIND.highway : /Secondary/.test(t) ? LINE_KIND.primary : /Track/.test(t) ? LINE_KIND.track : LINE_KIND.road;
    for (const p of f.parts) lines.push({ kind, width: 0, pts: simplify(p, 0.0004) });
  }
  // Rivers: width estimated from Natural Earth's rank (lower = more important).
  for (const n of ["ne_10m_rivers_lake_centerlines", "ne_10m_rivers_europe", "ne_10m_rivers_north_america"]) {
    for (const f of shp(n)) {
      const c = f.props.featurecla || "";
      if (/Lake Centerline/.test(c)) continue;                       // lakes come from the land cover
      const r = f.props.scalerank ?? 8, width = r <= 2 ? 500 : r <= 4 ? 250 : r <= 6 ? 120 : r <= 8 ? 70 : 40;
      for (const p of f.parts) lines.push({ kind: /Intermittent/.test(c) ? LINE_KIND.riverDry : LINE_KIND.river, width, pts: simplify(p, 0.0003) });
    }
  }
  return lines;
}
function clipLinesToBox(lines, b, m) {
  const inb = (p) => p[0] > b.west - m && p[0] < b.east + m && p[1] > b.south - m && p[1] < b.north + m;
  const out = [];
  for (const l of lines) {
    let cur = null;
    for (let i = 0; i < l.pts.length; i++) {
      const p = l.pts[i], q = l.pts[i + 1];
      if (inb(p) || (q && inb(q))) { if (!cur) { cur = { kind: l.kind, width: l.width, pts: [] }; out.push(cur); } cur.pts.push(p); }
      else if (cur) { cur = null; }
    }
  }
  return out.filter((l) => l.pts.length > 1);
}

const names = readdirSync(WC).filter((f) => f.endsWith(".u8.gz")).map((f) => f.slice(0, -6));
const tileSW = (n) => [(n[0] === "N" ? 1 : -1) * +n.slice(1, 3), (n[3] === "E" ? 1 : -1) * +n.slice(4, 7)];
const bundles = new Map();
for (const n of names) {
  const [la, lo] = tileSW(n), key = Math.floor(la / GLOBAL_BUNDLE) * GLOBAL_BUNDLE + "_" + Math.floor(lo / GLOBAL_BUNDLE) * GLOBAL_BUNDLE;
  if (!bundles.has(key)) bundles.set(key, []);
  bundles.get(key).push(n);
}
console.log(names.length + " land-cover tiles → " + bundles.size + " bundles");
const lines = loadLines();
console.log(lines.length + " road/river lines, " + lines.reduce((s, l) => s + l.pts.length, 0) + " points after simplification");
if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });
const index = { version: 1, cell: GLOBAL_CELL, tile: GLOBAL_TILE, bundle: GLOBAL_BUNDLE, classes: CLASS_NAMES, bundles: {},
  sources: { landCover: "ESA WorldCover 10 m 2021 v200 (CC BY 4.0), overview level 5 aggregated to 1/120°, dominant class (3 × 3 majority filter) + water share", roads: "Natural Earth 10 m roads v5.1 (public domain)", rivers: "Natural Earth 10 m rivers and lake centerlines, Europe and North America supplements (public domain)" },
  built: new Date().toISOString().slice(0, 10) };
let total = 0, lcBytes = 0, vecBytes = 0, done = 0, fmt = { W: 0, G: 0 };
for (const [key, list] of [...bundles.entries()].sort()) {
  const [bla, blo] = key.split("_").map(Number);
  const entries = [];
  const sorted = list.sort(), enc = new Array(sorted.length);
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (let k; (k = next++) < sorted.length; ) enc[k] = await encodeTile(sorted[k], tileGrid(sorted[k]));
  }));
  sorted.forEach((n, k) => {
    const e = enc[k];
    fmt[String.fromCharCode(e[0])]++;
    entries.push(["lc/" + n, e]); lcBytes += e.length;
    if (++done % 200 === 0) console.log("  " + done + "/" + names.length);
  });
  const vec = encodeLines(clipLinesToBox(lines, { south: bla, north: bla + GLOBAL_BUNDLE, west: blo, east: blo + GLOBAL_BUNDLE }, 0.02));
  entries.push(["vec", vec]); vecBytes += vec.length;
  const bytes = writeBundle(entries);
  writeFileSync(join(OUT, "b" + key + ".bin"), bytes);
  index.bundles[key] = { bytes: bytes.length, tiles: list.length };
  total += bytes.length;
}
writeFileSync(join(OUT, "index.json"), JSON.stringify(index));
console.log("global pack: " + bundles.size + " bundles · " + (total / 1048576).toFixed(2) + " MB (land cover " + (lcBytes / 1048576).toFixed(2) + " MB, " + JSON.stringify(fmt) + "; roads/rivers " + (vecBytes / 1048576).toFixed(2) + " MB)");
