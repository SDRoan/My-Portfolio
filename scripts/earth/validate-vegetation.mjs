// Checks generated and mapped vegetation against the map data, by running the
// simulator's own placement code (space/earth/veg-core.js) on real tiles:
//
//   node scripts/earth/validate-vegetation.mjs [--sample=N]
//
// Checks: no plants in the ocean / tidal water, inside buildings, on roads
// (generated), on the launch pad, on runways, in the Central Park Reservoir,
// near the Everest summit, on snow or ice; trees present in known wooded
// areas; streets in Midtown stay navigable. Writes
// space/data/earth/vegetation-report.txt.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Surface, HeightField, Patch } from "../../space/universe/surface-core.js";
import { decodeGrid, readBundle } from "../../space/engine/packs.js";
import { decodeTile, tileOf, tileKey, tileBounds } from "../../space/earth/tile-format.js";
import { VEG_CELL, CLASS, decodeTrees } from "../../space/earth/veg-format.js";
import { buildVegTile } from "../../space/earth/veg-core.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const S = join(ROOT, "space", "data", "surfaces"), RG = join(ROOT, "space", "data", "earth", "regions");
const DEBUG = process.argv.includes("--debug"), examples = {};
const ex = (kind, R, r, i, extra) => { if (!DEBUG) return; (examples[kind] = examples[kind] || []).length < 6 && examples[kind].push(R.id + " " + r.key + " fam " + r.fam[i] + " src " + r.src[i] + " at " + r.ll[i].map((v) => v.toFixed(6)).join(",") + " h " + r.inst[i * 8 + 3].toFixed(1) + (extra ? " " + extra : "")); };
const SAMPLE = +(process.argv.find((a) => a.startsWith("--sample=")) || "--sample=25").split("=")[1];
const D2R = Math.PI / 180;
const ROAD_W = [11, 10, 9, 8, 7, 6, 5.5, 4, 5, 5, 2, 2, 1.5, 2, 3, 3.2, 2.6, 45, 23];

// Earth's surface as in the simulator: global grid + region DEMs.
const e = JSON.parse(readFileSync(join(S, "manifest.json"), "utf8")).bodies.earth, t = e.terrain;
const surf = new Surface({ radius: e.radiusMeters, flattening: e.flattening }, e, {});
surf.field = new HeightField(decodeGrid(gunzipSync(readFileSync(join(S, t.file))), t.width, t.height), t.width, t.height, t.scale || 1, "earth");
for (const p of t.patches || []) { const q = new Patch(decodeGrid(gunzipSync(readFileSync(join(S, p.file))), p.width, p.height), p.width, p.height, p.scale || 1, p.bounds); surf.field.addPatch(q); }
const index = JSON.parse(readFileSync(join(RG, "index.json"), "utf8"));
const regions = new Map();
for (const r of index.regions) {
  const m = JSON.parse(readFileSync(join(RG, r.id, "meta.json"), "utf8"));
  for (const d of m.dem) surf.field.addPatch(new Patch(decodeGrid(gunzipSync(readFileSync(join(RG, r.id, d.file))), d.width, d.height), d.width, d.height, d.scale, d.bounds));
  if (!m.veg) continue;
  const raw = readFileSync(join(RG, r.id, m.veg.file)), b = readBundle(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const J = (k) => JSON.parse(gunzipSync(b.get(k)).toString());
  const pack = { meta: J("meta"), grid: new Uint8Array(gunzipSync(b.get("grid"))), trees: decodeTrees(new Uint8Array(gunzipSync(b.get("trees")))), rows: J("rows"), fields: J("fields") };
  const osm = new Map();
  for (const bk of Object.keys(m.bundles || {})) {
    const rb = readFileSync(join(RG, r.id, "t", bk + ".bin"));
    for (const [k, gz] of readBundle(rb.buffer.slice(rb.byteOffset, rb.byteOffset + rb.byteLength))) osm.set(k, gunzipSync(gz));
  }
  regions.set(r.id, { id: r.id, meta: m, pack, osm });
}

function subGrid(P, iy, ix) {
  const m = P.meta, b = tileBounds(iy, ix), pad = 2 * VEG_CELL;
  const x0 = Math.max(0, Math.floor((b.west - pad - m.bounds.west) / VEG_CELL)), x1 = Math.min(m.W, Math.ceil((b.east + pad - m.bounds.west) / VEG_CELL));
  const y0 = Math.max(0, Math.floor((m.bounds.north - b.north - pad) / VEG_CELL)), y1 = Math.min(m.H, Math.ceil((m.bounds.north - b.south + pad) / VEG_CELL));
  const W = Math.max(0, x1 - x0), H = Math.max(0, y1 - y0), data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) data.set(P.grid.subarray((y0 + y) * m.W + x0, (y0 + y) * m.W + x0 + W), y * W);
  return { data, W, H, west: m.bounds.west + x0 * VEG_CELL, north: m.bounds.north - y0 * VEG_CELL, south: m.bounds.north - y1 * VEG_CELL, east: m.bounds.west + x1 * VEG_CELL };
}
const cache = new Map();
function tile(R, iy, ix, lod = 0) {
  const key = tileKey(iy, ix);
  if (cache.has(R.id + key)) return cache.get(R.id + key);
  const osm = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const b = R.osm.get(tileKey(iy + dy, ix + dx)); if (b) osm.push(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }
  const inT = (la, lo) => { const [y, x] = tileOf(la, lo); return y === iy && x === ix; };
  const tb = tileBounds(iy, ix);
  const near = (pts) => pts.some(([la, lo]) => la > tb.south - 0.01 && la < tb.north + 0.01 && lo > tb.west - 0.01 && lo < tb.east + 0.01);
  const r = buildVegTile(surf, { key, lod, pMax: [1, 1, 0.25, 0.04][lod], density: 1, region: R.id, grid: subGrid(R.pack, iy, ix), box: R.meta.bbox, osm,
    trees: R.pack.trees.filter((x) => inT(x.lat, x.lon)), rows: R.pack.rows.filter((x) => near(x.pts)), fields: R.pack.fields.filter((x) => near(x.rings[0])), exclude: R.meta.exclude || [] });
  // Back to latitude/longitude for the checks.
  r.ll = [];
  for (let i = 0; i < r.n; i++) {
    const x = r.inst[i * 8] + r.origin[0], y = r.inst[i * 8 + 1] + r.origin[1], z = r.inst[i * 8 + 2] + r.origin[2], rr = Math.hypot(x, y, z);
    r.ll.push([Math.asin(y / rr) / D2R, Math.atan2(-z, x) / D2R]);
  }
  r.map = osm.map((b) => decodeTile(new Uint8Array(b)));
  cache.set(R.id + key, r);
  return r;
}
const inRing = (la, lo, ring) => { let inside = false; for (let i = 0, j = ring.length / 2 - 1; i < ring.length / 2; j = i++) { const yi = ring[i * 2], xi = ring[i * 2 + 1], yj = ring[j * 2], xj = ring[j * 2 + 1]; if ((yi > la) !== (yj > la) && lo < ((xj - xi) * (la - yi)) / (yj - yi) + xi) inside = !inside; } return inside; };
const inPoly = (la, lo, rings) => rings.reduce((s, r) => s ^ inRing(la, lo, r), false);
function roadDist(la, lo, rd) {
  const kx = 111320 * Math.cos(la * D2R), ky = 111320, p = rd.pts;
  let best = Infinity;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = (p[i + 1] - lo) * kx, ay = (p[i] - la) * ky, bx = (p[i + 3] - lo) * kx, by = (p[i + 2] - la) * ky;
    const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1e-9)));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}
const gH = (la, lo) => { const d = [Math.cos(la * D2R) * Math.cos(lo * D2R), Math.sin(la * D2R), -Math.cos(la * D2R) * Math.sin(lo * D2R)]; return surf.heightAt(d[0], d[1], d[2], 5); };
const classAt = (R, la, lo) => { const m = R.pack.meta, x = Math.floor((lo - m.bounds.west) / VEG_CELL), y = Math.floor((m.bounds.north - la) / VEG_CELL); return x < 0 || y < 0 || x >= m.W || y >= m.H ? -1 : R.pack.grid[y * m.W + x] >> 4; };
const TREE = (f) => f < 8;

// Generic checks over a tile; returns counts of violations.
function check(R, r) {
  const v = { water: 0, building: 0, road: 0, runway: 0, pad: 0, snow: 0, lake: 0, n: r.n, trees: 0, generated: 0, mapped: 0 };
  for (let i = 0; i < r.n; i++) {
    const [la, lo] = r.ll[i], f = r.fam[i], gen = r.src[i] === 0;
    if (TREE(f)) { v.trees++; if (gen) v.generated++; else v.mapped++; }
    if (gen && gH(la, lo) < -0.5) v.water++;
    for (const m of r.map) {
      for (const b of m.buildings) if (inPoly(la, lo, b.rings)) { v.building++; ex("building", R, r, i, "bldg h " + b.h); break; }
      for (const w of m.water) if (w.kind === 1 && inPoly(la, lo, w.rings)) { v.lake++; ex("lake", R, r, i); break; }
      if (gen) for (const rd of m.roads) {
        const d = roadDist(la, lo, rd), half = (rd.width || ROAD_W[rd.cls] || 5) / 2;
        if (rd.cls === 17 && d < half + 5) v.runway++;
        else if (rd.cls <= 9 && d < half) { v.road++; ex("road", R, r, i, "road cls " + rd.cls + " d " + d.toFixed(2) + " half " + half); }
      }
    }
    for (const ex of R.meta.exclude || []) if (Math.hypot((la - ex.lat) * 111320, (lo - ex.lon) * 111320 * Math.cos(la * D2R)) < ex.r) v.pad++;
    if (gen && classAt(R, la, lo) === CLASS.snow) { v.snow++; ex("snow", R, r, i); }
  }
  return v;
}

if (process.argv.includes("--time")) {
  for (const [id, la, lo] of [["nyc", 40.758, -73.9855], ["nyc", 40.778, -73.9695], ["rainier", 46.7505, -121.812], ["kennedy", 28.66, -80.69], ["grand-canyon", 36.215, -112.05]]) {
    const R = regions.get(id), [iy, ix] = tileOf(la, lo);
    const row = [];
    for (const lod of [0, 1, 2, 3]) {
      cache.clear(); const t0 = performance.now(); const r = tile(R, iy, ix, lod); row.push("L" + lod + " " + (performance.now() - t0).toFixed(0) + " ms / " + r.n);
    }
    console.log(id.padEnd(13), la, lo, row.join(" · "));
  }
  process.exit(0);
}
const lines = [], results = [];
const out = (s) => { lines.push(s); console.log(s); };
const result = (name, pass, detail) => { results.push([name, pass]); out((pass ? "PASS " : "FAIL ") + name + " — " + detail); };
const sum = (vs) => vs.reduce((a, v) => { for (const k in v) a[k] = (a[k] || 0) + v[k]; return a; }, {});

out("Vegetation validation · " + new Date().toISOString().slice(0, 10));
// 1. Random sample of tiles per region (deterministic), generic checks.
for (const R of regions.values()) {
  const keys = [...R.osm.keys()].sort(), pick = [];
  for (let i = 0; i < Math.min(SAMPLE, keys.length); i++) pick.push(keys[Math.floor((i + 0.5) * keys.length / Math.min(SAMPLE, keys.length))]);
  const vs = pick.map((k) => check(R, tile(R, ...k.split("_").map(Number))));
  const s = sum(vs);
  out("\n" + R.id + ": " + pick.length + " sampled tiles · " + s.n + " plants (" + s.trees + " trees: " + s.mapped + " mapped, " + s.generated + " generated)");
  result(R.id + " no generated plants in tidal water / ocean", s.water === 0, s.water + " found");
  result(R.id + " no plants inside buildings", s.building === 0, s.building + " found");
  result(R.id + " no generated plants on roads", s.road === 0, s.road + " found");
  result(R.id + " no plants in lakes / reservoirs", s.lake === 0, s.lake + " found");
  result(R.id + " no generated plants on snow / ice", s.snow === 0, s.snow + " found");
}
// 2. Specific places.
const at = (id, la, lo) => { const R = regions.get(id); return { R, r: tile(R, ...tileOf(la, lo)) }; };
const within = (r, la, lo, m, pred = () => true) => r.ll.reduce((n, [a, b], i) => n + (pred(i) && Math.hypot((a - la) * 111320, (b - lo) * 111320 * Math.cos(la * D2R)) < m ? 1 : 0), 0);
{
  const { R, r } = at("kennedy", 28.6083, -80.6042), v = check(R, r);
  result("Kennedy: launch pad LC-39A clear (350 m)", v.pad === 0 && within(r, 28.6083, -80.6042, 350) === 0, within(r, 28.6083, -80.6042, 350) + " plants within 350 m");
  // Shuttle Landing Facility runway (OSM aeroway=runway) — tiles along it.
  let rw = 0, tiles = 0;
  for (let la = 28.6; la <= 28.64; la += 0.01) { const x = at("kennedy", la, -80.694); rw += check(x.R, x.r).runway; tiles++; }
  result("Kennedy: runways clear", rw === 0, rw + " generated plants within a runway (+5 m), " + tiles + " tiles along the Shuttle Landing Facility");
  // Natural areas of Merritt Island have vegetation.
  const n = at("kennedy", 28.66, -80.69).r.n;
  result("Kennedy: vegetation outside the developed launch area (Merritt Island, 28.66 N 80.69 W)", n > 500, n + " plants in the tile");
}
{
  const { R, r } = at("nyc", 40.7856, -73.9625);
  const res = r.map.flatMap((m) => m.water).filter((w) => w.kind === 1 && inPoly(40.7856, -73.9625, w.rings));
  const inRes = r.ll.reduce((n, [a, b]) => n + (res.some((w) => inPoly(a, b, w.rings)) ? 1 : 0), 0);
  result("Central Park Reservoir clear", res.length > 0 && inRes === 0, (res.length ? "reservoir polygon found; " : "reservoir polygon NOT found; ") + inRes + " plants inside");
  const ramble = at("nyc", 40.778, -73.9695).r, lawn = at("nyc", 40.7812, -73.9665).r;
  const nR = within(ramble, 40.778, -73.9695, 120, (i) => TREE(ramble.fam[i])), nL = within(lawn, 40.7812, -73.9665, 80, (i) => TREE(lawn.fam[i]));
  result("Central Park: trees concentrate in the Ramble, the Great Lawn stays open", nR > 3 * Math.max(1, nL), "Ramble " + nR + " trees within 120 m · Great Lawn " + nL + " trees within 80 m");
  const ts = at("nyc", 40.758, -73.9855), v = check(ts.R, ts.r);
  const gen = within(ts.r, 40.758, -73.9855, 150, (i) => ts.r.src[i] === 0 && TREE(ts.r.fam[i]));
  result("Times Square: no forest, streets navigable", v.road === 0 && gen < 40, gen + " generated trees within 150 m · " + v.road + " on roads");
  void R;
}
{
  const { r } = at("everest", 27.9881, 86.925);
  const n = within(r, 27.9881, 86.925, 2000);
  result("Everest: no vegetation within 2 km of the summit", n === 0, n + " plants");
}
{
  // Rainier: lowland forest (Longmire area) dense; summit and glaciers bare.
  const low = at("rainier", 46.75, -121.81).r, top = at("rainier", 46.853, -121.76).r;
  const tl = low.ll.filter((_, i) => TREE(low.fam[i])).length, tt = top.ll.filter((_, i) => TREE(top.fam[i])).length;
  result("Rainier: forest in the lowland valley (46.75 N 121.81 W)", tl > 2000, tl + " trees in the tile");
  result("Rainier: no trees at the summit (46.853 N 121.760 W)", tt === 0, tt + " trees in the tile");
  // Tree count falls with elevation.
  const bands = new Map();
  const RR = regions.get("rainier"), bb = RR.meta.bbox;
  for (let la = bb.south + 0.005; la < bb.north; la += 0.04) for (let lo = bb.west + 0.005; lo < bb.east; lo += 0.04) {
    const x = tile(RR, ...tileOf(la, lo));
    for (let i = 0; i < x.n; i++) if (TREE(x.fam[i])) { const b = Math.floor(gH(...x.ll[i]) / 500) * 500; bands.set(b, (bands.get(b) || 0) + 1); }
  }
  out("  Rainier trees by elevation band (m): " + [...bands.entries()].sort((a, b) => a[0] - b[0]).map(([b, n]) => b + "–" + (b + 500) + ": " + n).join(", "));
}
{
  // Grand Canyon: rim forest vs. canyon walls and floor.
  const rim = at("grand-canyon", 36.215, -112.05).r, wall = at("grand-canyon", 36.10, -112.10).r;
  const tr = rim.ll.filter((_, i) => TREE(rim.fam[i])).length, tw = wall.ll.filter((_, i) => TREE(wall.fam[i])).length;
  result("Grand Canyon: the North Rim is wooded, the inner canyon much sparser", tr > 3 * Math.max(1, tw), "rim tile " + tr + " trees · inner-canyon tile " + tw + " trees");
}
if (DEBUG) for (const [k, list] of Object.entries(examples)) out("examples " + k + ":\n  " + list.join("\n  "));
const pass = results.filter((r) => r[1]).length;
out("\n" + pass + "/" + results.length + " checks passed");
writeFileSync(join(ROOT, "space", "data", "earth", "vegetation-report.txt"), lines.join("\n") + "\n");
if (!existsSync(join(RG, "index.json"))) process.exit(1);
