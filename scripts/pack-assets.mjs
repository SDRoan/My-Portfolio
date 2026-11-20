// Re-packs runtime data in place, losslessly:
//
//   node scripts/pack-assets.mjs
//
//  1. every height grid (*.i16.gz) → the H2D1 encoding (space/engine/packs.js)
//  2. planetary global tiles → 2 × 2 bundles (tiles/<body>/b<row>_<col>.bin)
//  3. Earth map tiles → 5 × 5 bundles (regions/<id>/t/<row>_<col>.bin)
// The build scripts call the same functions, so rebuilds stay packed.
// Idempotent: already-packed data is left alone.

import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync, statSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeGrid, encodeGrid, writeBundle } from "../space/engine/packs.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const S = join(ROOT, "space", "data", "surfaces"), R = join(ROOT, "space", "data", "earth", "regions");

// A grid file, given its dimensions → H2D1 (returns bytes saved).
export function reencodeGrid(file, W, H) {
  const gz = readFileSync(file), raw = gunzipSync(gz);
  if (raw[0] === 0x48 && raw[1] === 0x32 && raw[2] === 0x44 && raw[3] === 0x31) return 0;
  if (raw.length !== W * H * 2) throw new Error(file + ": size " + raw.length + " ≠ " + W + "×" + H);
  const out = gzipSync(encodeGrid(decodeGrid(raw, W, H), W, H), { level: 9 });
  if (out.length >= gz.length) return 0;
  writeFileSync(file, out);
  return gz.length - out.length;
}

// Planetary tiles of one body: <body>-tiles.json lists "row_col" keys.
export function packPlanetTiles(id, span = 2) {
  const ixFile = join(S, id + "-tiles.json");
  if (!existsSync(ixFile)) return null;
  const ix = JSON.parse(readFileSync(ixFile, "utf8"));
  if (ix.bundles) return null;
  const dir = join(S, "tiles", id), n = ix.cells + 2 * ix.margin, groups = new Map();
  let saved = 0;
  for (const key of Object.keys(ix.tiles)) {
    const f = join(dir, key + ".i16.gz");
    saved += reencodeGrid(f, n, n);
    const [ty, tx] = key.split("_").map(Number), b = "b" + Math.floor(ty / span) + "_" + Math.floor(tx / span);
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b).push([key, readFileSync(f)]);
  }
  ix.bundles = {}; ix.bundleSpan = span;
  for (const [b, list] of groups) {
    const bytes = writeBundle(list);
    writeFileSync(join(dir, b + ".bin"), bytes);
    ix.bundles[b] = bytes.length;
  }
  for (const key of Object.keys(ix.tiles)) unlinkSync(join(dir, key + ".i16.gz"));
  writeFileSync(ixFile, JSON.stringify(ix));
  return { id, tiles: Object.keys(ix.tiles).length, bundles: groups.size, saved };
}

// Earth map tiles of one region (meta.tiles: "iy_ix" → bytes).
export function packRegionTiles(id, span = 5) {
  const metaFile = join(R, id, "meta.json");
  const m = JSON.parse(readFileSync(metaFile, "utf8"));
  if (m.bundles) return null;
  const dir = join(R, id, "t"), groups = new Map();
  for (const key of Object.keys(m.tiles)) {
    const [iy, ix] = key.split("_").map(Number), b = Math.floor(iy / span) + "_" + Math.floor(ix / span);
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b).push([key, readFileSync(join(dir, key + ".bin.gz"))]);
  }
  m.bundles = {}; m.bundleSpan = span;
  for (const [b, list] of groups) { const bytes = writeBundle(list); writeFileSync(join(dir, b + ".bin"), bytes); m.bundles[b] = bytes.length; }
  for (const key of Object.keys(m.tiles)) unlinkSync(join(dir, key + ".bin.gz"));
  // Region DEMs too.
  for (const d of m.dem) d.bytes = statSync(join(R, id, d.file)).size - reencodeGrid(join(R, id, d.file), d.width, d.height);
  writeFileSync(metaFile, JSON.stringify(m));
  return { id, tiles: Object.keys(m.tiles).length, bundles: groups.size };
}

// Whole-body grids, coverage masks and landmark patches (from their .json).
export function packSurfaceGrids() {
  let saved = 0, n = 0;
  for (const f of readdirSync(S).filter((f) => /-elevation\.json$/.test(f))) {
    const j = JSON.parse(readFileSync(join(S, f), "utf8"));
    saved += reencodeGrid(join(S, j.file), j.width, j.height); n++;
    if (j.coverage && j.coverage.file) { saved += reencodeGrid(join(S, j.coverage.file), j.coverage.width, j.coverage.height); n++; }
  }
  return { grids: n, saved };
}

// Images → WebP only where it saves ≥ 20% at ≥ 40 dB PSNR (cwebp from
// libwebp). Detailed greyscale mosaics usually don't qualify and stay JPEG.
// References in the imagery .json files and region metas are rewritten.
export function packImages() {
  const T = join(ROOT, "textures"), done = [];
  const cands = [...readdirSync(T).filter((f) => /^(earth_(bluemarble|blackmarble|clouds)|\w+_(usgs|newhorizons))\.(jpe?g|png)$/.test(f)).map((f) => join(T, f))];
  if (existsSync(R)) for (const id of readdirSync(R)) if (existsSync(join(R, id, "meta.json"))) for (const f of readdirSync(join(R, id))) if (/^img-.*\.jpg$/.test(f)) cands.push(join(R, id, f));
  for (const f of cands) {
    const out = f.replace(/\.(jpe?g|png)$/, ".webp");
    let psnr = 0;
    try {
      // cwebp reports "PSNR: … Total:xx.xx" on stderr.
      const r = execFileSync("sh", ["-c", "cwebp -q 88 -m 6 -print_psnr \"$0\" -o \"$1\" 2>&1", f, out]).toString();
      const m = r.match(/Total:\s*([\d.]+)/); psnr = m ? +m[1] : 0;
    } catch (e) { continue; }
    const a = statSync(f).size, b = statSync(out).size;
    if (b < 0.8 * a && psnr >= 40) { unlinkSync(f); done.push([f, out, a, b, psnr]); } else unlinkSync(out);
  }
  // Rewrite references.
  const rename = new Map(done.map(([f, o]) => [f.split("/").pop(), o.split("/").pop()]));
  for (const j of readdirSync(S).filter((f) => f.endsWith("-imagery.json"))) {
    const p = join(S, j), m = JSON.parse(readFileSync(p, "utf8"));
    if (rename.has(m.file)) { m.file = rename.get(m.file); m.bytes = statSync(join(T, m.file)).size; writeFileSync(p, JSON.stringify(m, null, 1)); }
  }
  if (existsSync(R)) for (const id of readdirSync(R)) {
    const p = join(R, id, "meta.json"); if (!existsSync(p)) continue;
    const m = JSON.parse(readFileSync(p, "utf8")); let ch = false;
    for (const im of m.imagery) if (rename.has(im.file)) { im.file = rename.get(im.file); im.bytes = statSync(join(R, id, im.file)).size; ch = true; }
    if (ch) writeFileSync(p, JSON.stringify(m));
  }
  return done;
}

if (process.argv[1] && process.argv[1].endsWith("pack-assets.mjs")) {
  if (process.argv.includes("--images")) {
    for (const [f, , a, b, q] of packImages()) console.log("webp", f.split("/").slice(-2).join("/"), (a / 1024).toFixed(0), "→", (b / 1024).toFixed(0), "KB, PSNR", q, "dB");
    process.exit(0);
  }
  const g = packSurfaceGrids();
  console.log("surface grids:", g.grids, "re-encoded, saved", (g.saved / 1048576).toFixed(2), "MB");
  for (const id of readdirSync(join(S, "tiles"))) { const r = packPlanetTiles(id); if (r) console.log("tiles", r.id, r.tiles, "→", r.bundles, "bundles, saved", (r.saved / 1048576).toFixed(2), "MB"); }
  if (existsSync(R)) for (const id of readdirSync(R).filter((d) => existsSync(join(R, d, "meta.json")))) { const r = packRegionTiles(id); if (r) console.log("region", r.id, r.tiles, "tiles →", r.bundles, "bundles"); }
}
