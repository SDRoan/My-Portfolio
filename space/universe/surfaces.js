// Surfaces: the shape of every solid body, one source of truth for terrain
// geometry, collision, landing and walking. The model itself lives in
// surface-core.js (no dependencies, so the surface workers run the identical
// code); this module adds the browser side: loading the manifest and the
// elevation grids, the GPU copy of a grid, and frame conversion.

import * as THREE from "three";
import { HeightField, Patch } from "./surface-core.js";
import { decodeGrid, fetchBundle, gunzip } from "../engine/packs.js";
import { cachedBytes } from "../engine/datacache.js";
export { Surface, HeightField, Patch, NODATA, latLon, dirFromLatLon, fmtLatLon } from "./surface-core.js";

const DATA = new URL("../data/surfaces/", import.meta.url);
let manifestPromise = null;
export function loadManifest() {
  if (!manifestPromise) manifestPromise = fetch(new URL("manifest.json", DATA)).then((r) => (r.ok ? r.json() : { bodies: {} })).catch(() => ({ bodies: {} }));
  return manifestPromise;
}

// ── real elevation grids ──
const fields = new Map();
// Grids ship as gzip-compressed, row-delta-encoded int16; the browser
// decompresses them itself (no server configuration, works on GitHub Pages).
export async function loadGrid(t, base = DATA) {
  const gz = await cachedBytes(new URL(t.file, base));        // bounded persistent cache (engine/datacache.js)
  const raw = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  return decodeGrid(raw, t.width, t.height);         // H2D1 or legacy row-delta (engine/packs.js)
}
export function loadField(entry) {
  const t = entry.terrain;
  if (!t || !t.file) return Promise.resolve(null);
  if (fields.has(t.file)) return fields.get(t.file);
  const p = (async () => {
    const f = new HeightField(await loadGrid(t), t.width, t.height, t.scale || 1, entry.id);
    // Where only part of the body was mapped: 1 mapped … 0 unmapped (procedural fill).
    if (t.coverage) f.coverage = new HeightField(await loadGrid(t.coverage), t.coverage.width, t.coverage.height, t.coverage.scale, entry.id + ":coverage");
    // Detail patches are optional: the global grid still works without them.
    for (const pt of t.patches || []) {
      if (pt.lazy) continue;                         // regional packs load on approach (see addPatch)
      try { const pp = new Patch(await loadGrid(pt), pt.width, pt.height, pt.scale || 1, pt.bounds); pp.source = pt.source; f.addPatch(pp); }
      catch (e) { console.warn("[space] detail patch unavailable", pt.file, e.message); }
    }
    return f;
  })();
  fields.set(t.file, p);
  p.catch(() => fields.delete(t.file));
  return p;
}

// Data-constrained features (features.json), loaded once on approach to
// the first world that has some.
let featuresPromise = null;
export function loadFeatures(id) {
  if (!featuresPromise) featuresPromise = fetch(new URL("features.json", DATA)).then((r) => (r.ok ? r.json() : { bodies: {} })).catch(() => ({ bodies: {} }));
  return featuresPromise.then((j) => j.bodies[id] || []);
}
export function featureLegend() { return featuresPromise ? featuresPromise.then((j) => j.legend || {}) : Promise.resolve({}); }

// GPU copy (half-float, filterable in WebGL2) for shading from orbit.
HeightField.prototype.texture = function () {
  if (this.tex) return this.tex;
  const n = this.W * this.H, half = new Uint16Array(n);
  for (let i = 0; i < n; i++) half[i] = THREE.DataUtils.toHalfFloat(this.h[i] * this.scale);
  const t = new THREE.DataTexture(half, this.W, this.H, THREE.RedFormat, THREE.HalfFloatType);
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter;
  t.wrapS = THREE.RepeatWrapping; t.flipY = false;
  t.needsUpdate = true;
  this.tex = t;
  return t;
};

// ── geodesy helpers ──
// World-frame offset from the body centre → body-local unit direction and distance.
const _q = new THREE.Quaternion(), _v = new THREE.Vector3();
export function toLocal(bodyQuat, rel) {
  _v.set(rel[0], rel[1], rel[2]);
  const r = _v.length() || 1;
  _v.applyQuaternion(_q.copy(bodyQuat).invert()).divideScalar(r);
  return { x: _v.x, y: _v.y, z: _v.z, r };
}

// ── streaming the finer data around the camera ──
// A body's global tiles (tiles/<body>/<row>_<col>.i16.gz, listed in
// <body>-tiles.json) and its lazily loaded landmark patches arrive as you
// approach; distant tiles are dropped beyond a budget.
export class TerrainStreamer {
  constructor(surface, entry) {
    this.surface = surface; this.entry = entry;
    this.index = null; this.loading = 0; this.pending = new Set(); this.failed = new Set();
    this.patches = ((entry.terrain && entry.terrain.patches) || []).filter((p) => p.lazy).map((p) => ({ ...p, state: 0 }));
    const ts = entry.terrain && entry.terrain.tileSet;
    if (ts) fetch(new URL(ts, DATA)).then((r) => (r.ok ? r.json() : null)).then((ix) => {
      if (!ix) return;
      this.index = ix;
      if (surface.field) surface.field.tileDeg = ix.tileDeg;
    }).catch(() => {});
  }
  // lat, lon in degrees; alt above the ground in metres.
  update(lat, lon, alt) {
    const S = this.surface, f = S.field;
    if (!f) return;
    const R = S.R, D = Math.PI / 180;
    // Landmark patches within reach (a few hundred km, more when high).
    const reach = Math.max(3e5, alt * 4) / R / D;
    for (const p of this.patches) {
      if (p.state || this.loading >= 3) continue;
      const b = p.bounds, dLat = Math.max(0, b.south - lat, lat - b.north), dLon = Math.max(0, b.west - lon, lon - b.east) * Math.cos(lat * D);
      if (Math.hypot(dLat, dLon) > reach) continue;
      p.state = 1; this.loading++;
      loadGrid(p).then((h) => { const pp = new Patch(h, p.width, p.height, p.scale || 1, p.bounds); pp.source = p.source + (p.resolutionM ? " · " + p.resolutionM + " m" : ""); S.addPatch(pp); })
        .catch((e) => { console.warn("[space] patch", p.file, e.message); }).finally(() => { this.loading--; });
    }
    // Global tiles: those within reach of the camera (below ~3000 km).
    const ix = this.index;
    if (!ix || alt > 3e6) return;
    f.tileDeg = ix.tileDeg;
    const T = ix.tileDeg, rDeg = Math.min(60, Math.max(T * 0.75, (alt * 2.5 + 1.5e5) / R / D));
    const want = [];
    const ty0 = Math.max(0, Math.floor((90 - lat - rDeg) / T)), ty1 = Math.min(180 / T - 1, Math.floor((90 - lat + rDeg) / T));
    const k = 1 / Math.max(0.15, Math.cos(lat * D)), span = Math.min(180, rDeg * k);
    for (let ty = ty0; ty <= ty1; ty++) for (let x = Math.floor((lon - span + 180) / T); x <= Math.floor((lon + span + 180) / T); x++) {
      const tx = ((x % (360 / T)) + 360 / T) % (360 / T), key = ty + "_" + tx;
      if (!ix.tiles[key]) continue;
      const cLat = 90 - (ty + 0.5) * T, cLon = -180 + (tx + 0.5) * T;
      want.push({ key, d: Math.hypot(cLat - lat, ((cLon - lon + 540) % 360 - 180) / k) });
    }
    want.sort((a, b) => a.d - b.d);
    for (const w of want) {
      if (f.tiles.has(w.key) || this.pending.has(w.key) || this.failed.has(w.key)) continue;
      if (this.loading >= 4) break;
      this.loadTile(w.key);
    }
    // Keep at most 160 tiles: drop the farthest.
    if (f.tiles.size > 160) {
      const far = [...f.tiles.keys()].map((key) => { const [ty, tx] = key.split("_").map(Number); return { key, d: Math.hypot(90 - (ty + 0.5) * T - lat, ((-180 + (tx + 0.5) * T - lon + 540) % 360 - 180) / k) }; }).sort((a, b) => b.d - a.d);
      for (const t of far.slice(0, f.tiles.size - 160)) S.removeTile(t.key);
    }
  }
  loadTile(key) {
    const ix = this.index, T = ix.tileDeg, n = ix.cells, m = ix.margin, c = ix.cellDeg;
    const [ty, tx] = key.split("_").map(Number);
    const bounds = { north: 90 - ty * T + m * c, south: 90 - (ty + 1) * T - m * c, west: -180 + tx * T - m * c, east: -180 + (tx + 1) * T + m * c };
    this.pending.add(key); this.loading++;
    const W = n + 2 * m;
    // Packed: tiles come in 2 × 2 bundles (one request per bundle).
    const span = ix.bundleSpan, load = ix.bundles
      ? fetchBundle(new URL("tiles/" + this.entry.id + "/b" + Math.floor(ty / span) + "_" + Math.floor(tx / span) + ".bin", DATA))
          .then((b) => { const g = b.get(key); if (!g) throw new Error("tile missing from bundle"); return gunzip(g); }).then((raw) => decodeGrid(raw, W, W))
      : loadGrid({ file: "tiles/" + this.entry.id + "/" + key + ".i16.gz", width: W, height: W });
    load
      .then((h) => { const p = new Patch(h, n + 2 * m, n + 2 * m, ix.scale, bounds, 0); p.source = ix.source + " · " + ix.resolutionM + " m"; this.surface.addTile(key, p); })
      .catch((e) => { this.failed.add(key); console.warn("[space] tile", key, e.message); })
      .finally(() => { this.pending.delete(key); this.loading--; });
  }
}
