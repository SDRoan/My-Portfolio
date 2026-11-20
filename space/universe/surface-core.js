// The surface model of a solid body, with no dependencies — the same code runs
// on the main thread (collision, landing, walking, readouts) and in the
// surface workers (terrain chunks, buildings, roads), so every one of them
// agrees on where the ground is.
//
// Body-local frame: +Y north pole, +X the prime meridian, −Z longitude 90° E.
// A unit direction d gives latitude = asin(d.y), longitude = atan2(−d.z, d.x),
// the same convention as every elevation grid and map, so data lines up.
//
// Ground radius in a direction = reference shape (WGS 84 ellipsoid for Earth,
// triaxial ellipsoid for small moons, otherwise a sphere)
//   + real elevation where a dataset exists: a global grid, refined by nested
//     regional patches (finest wins, blended at their edges)
//   + microdetail strictly below the local grid's resolution, scaled by the
//     local slope, so it can roughen ground but never move a mountain, a
//     valley or a coastline.

import { terrainHeight, fbm } from "../engine/noise.js";
import { FeatureSet, character } from "./features.js";

const D2R = Math.PI / 180;
export const NODATA = -32768;

// Catmull-Rom weights for fraction t: the curve passes through every grid
// value (measured heights stay exact at the samples) and, unlike bilinear,
// its slope is continuous across cell edges, so lighting doesn't show the
// grid as square facets.
function crw(t, w) {
  const t2 = t * t, t3 = t2 * t;
  w[0] = -0.5 * t3 + t2 - 0.5 * t; w[1] = 1.5 * t3 - 2.5 * t2 + 1; w[2] = -1.5 * t3 + 2 * t2 + 0.5 * t; w[3] = 0.5 * t3 - 0.5 * t2;
}
const _wx = [0, 0, 0, 0], _wy = [0, 0, 0, 0];

// A finer grid over a lat/lon box (degrees, cell edges). Cells marked NODATA
// fall back to the coarser data underneath.
export class Patch {
  // blend: degrees over which the patch fades into the coarser data at its
  // edges (default 10% of the box, at most 0.25°); 0 for tiles of a global
  // tiling, whose margins overlap their neighbours exactly.
  constructor(h, W, H, scale, b, blend) {
    this.h = h; this.W = W; this.H = H; this.scale = scale; this.b = b;
    this.cell = ((b.north - b.south) / H) * D2R;                         // cell size, radians
    this.blend = blend !== undefined ? blend : Math.min(0.25, 0.1 * Math.min(b.north - b.south, b.east - b.west));
  }
  contains(lat, lon) { const b = this.b, la = lat / D2R, lo = lon / D2R; return la > b.south && la < b.north && lo > b.west && lo < b.east; }
  // [height m, weight 0…1], or null outside the box or over missing data.
  sample(lat, lon) {
    const b = this.b, la = lat / D2R, lo = lon / D2R;
    if (la <= b.south || la >= b.north || lo <= b.west || lo >= b.east) return null;
    const W = this.W, H = this.H;
    const fx = (lo - b.west) / (b.east - b.west) * W - 0.5, fy = (b.north - la) / (b.north - b.south) * H - 0.5;
    const x0 = Math.max(0, Math.min(W - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(H - 2, Math.floor(fy)));
    const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0)), h = this.h;
    const a = h[y0 * W + x0], c1 = h[y0 * W + x0 + 1], c = h[(y0 + 1) * W + x0], d = h[(y0 + 1) * W + x0 + 1];
    if (a === NODATA || c1 === NODATA || c === NODATA || d === NODATA) return null;
    // Bicubic over the 4 × 4 neighbourhood (rows/columns clamped at the box
    // edge); bilinear if any of it is missing data.
    crw(tx, _wx); crw(ty, _wy);
    let v = 0;
    for (let j = 0; j < 4 && v === v; j++) {
      const r = Math.max(0, Math.min(H - 1, y0 - 1 + j)) * W;
      for (let i = 0; i < 4; i++) {
        const q = h[r + Math.max(0, Math.min(W - 1, x0 - 1 + i))];
        if (q === NODATA) { v = NaN; break; }
        v += q * _wx[i] * _wy[j];
      }
    }
    if (v !== v) v = (a + (c1 - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    v *= this.scale;
    const edge = Math.min(la - b.south, b.north - la, lo - b.west, b.east - lo);
    return [v, this.blend > 0 ? Math.min(1, edge / this.blend) : 1];
  }
  plain() { return { h: this.h, W: this.W, H: this.H, scale: this.scale, b: this.b, blend: this.blend, source: this.source }; }
  static from(o) { const p = new Patch(o.h, o.W, o.H, o.scale, o.b, o.blend); p.source = o.source; return p; }
}

export class HeightField {
  constructor(h, W, H, scale, id) { this.h = h; this.W = W; this.H = H; this.scale = scale; this.id = id; this.tex = null; this.patches = []; this.tiles = new Map(); this.tileDeg = 0; }
  // Patches are kept coarse → fine, so finer data is blended in last.
  addPatch(p) { this.patches.push(p); this.patches.sort((a, b) => b.cell - a.cell); }
  // Global tiling (one level, tileDeg-square tiles keyed "row_col" from the
  // north-west): found by index, not by search, so hundreds stay cheap.
  addTile(key, p) { this.tiles.set(key, p); }
  tileAt(lat, lon) {
    if (!this.tiles.size) return null;
    const T = this.tileDeg, la = lat / D2R, lo = lon / D2R;
    return this.tiles.get(Math.min(180 / T - 1, Math.floor((90 - la) / T)) + "_" + Math.min(360 / T - 1, Math.floor((lo + 180) / T))) || null;
  }
  // Elevation in metres at latitude/longitude (radians): the finest data there is.
  sample(lat, lon) {
    let v = this.sampleGlobal(lat, lon);
    const t = this.tileAt(lat, lon);
    if (t) { const s = t.sample(lat, lon); if (s) v = s[0]; }
    for (const p of this.patches) {
      const s = p.sample(lat, lon);
      if (s) v += (s[0] - v) * s[1];
    }
    return v;
  }
  // Name of the finest dataset covering a point (null: the global grid).
  sourceAt(lat, lon) {
    let c = Math.PI / this.H, s = null;
    const t = this.tileAt(lat, lon);
    if (t && t.cell < c) { c = t.cell; s = t.source || null; }
    for (const p of this.patches) if (p.cell < c && p.contains(lat, lon)) { c = p.cell; s = p.source || null; }
    return s;
  }
  // Size (radians) of the finest grid cell covering a point.
  cellAt(lat, lon) {
    let c = Math.PI / this.H;
    const t = this.tileAt(lat, lon);
    if (t && t.cell < c) c = t.cell;
    for (const p of this.patches) if (p.cell < c && p.contains(lat, lon)) c = p.cell;
    return c;
  }
  sampleGlobal(lat, lon) {
    const W = this.W, H = this.H;
    const fx = ((lon / Math.PI + 1) * 0.5) * W - 0.5, fy = (0.5 - lat / Math.PI) * H - 0.5;
    const x0 = Math.floor(fx), y0 = Math.max(0, Math.min(H - 1, Math.floor(fy)));
    const y1 = Math.min(H - 1, y0 + 1), tx = fx - x0, ty = Math.max(0, Math.min(1, fy - y0));
    const xa = ((x0 % W) + W) % W, xb = (xa + 1) % W, h = this.h;
    // Bicubic; longitude wraps, latitude clamps at the poles.
    crw(tx, _wx); crw(ty, _wy);
    let v = 0;
    for (let j = 0; j < 4; j++) {
      const r = Math.max(0, Math.min(H - 1, y0 - 1 + j)) * W;
      v += _wy[j] * (_wx[0] * h[r + (xa + W - 1) % W] + _wx[1] * h[r + xa] + _wx[2] * h[r + xb] + _wx[3] * h[r + (xa + 2) % W]);
    }
    return v * this.scale;
  }
  // Plain data for a worker (the typed arrays are copied, not shared).
  serialize() {
    return { h: this.h, W: this.W, H: this.H, scale: this.scale, id: this.id, coverage: this.coverage ? this.coverage.serialize() : null,
      patches: this.patches.map((p) => p.plain()), tileDeg: this.tileDeg, tiles: [...this.tiles].map(([k, p]) => [k, p.plain()]) };
  }
  static from(o) {
    const f = new HeightField(o.h, o.W, o.H, o.scale, o.id);
    if (o.coverage) f.coverage = HeightField.from(o.coverage);
    for (const p of o.patches) f.addPatch(Patch.from(p));
    f.tileDeg = o.tileDeg || 0;
    for (const [k, p] of o.tiles || []) f.addTile(k, Patch.from(p));
    return f;
  }
}

// Modes, as labelled in the surface manifest.
export const REAL = "real-base-procedural-microdetail";

export class Surface {
  // def: { radius (m), flattening, triaxial }; entry: manifest entry; look: shader options
  constructor(def, entry, look) {
    this.def = def;
    this.entry = entry || null;
    this.R = def.radius;
    const tri = def.triaxial || [1, 1, 1];
    // Triaxial bodies: scale the semi-axes so the volume matches the mean radius.
    const k = def.triaxial ? 1 / Math.cbrt(tri[0] * tri[1] * tri[2]) : 1;
    this.axes = [tri[0] * k, tri[2] * k * (1 - (def.flattening || 0)), tri[1] * k];   // local x, y, z
    this.solid = !entry || entry.surfaceType === "solid";
    this.version = 0;                               // bumped on every data change (workers re-sync)
    this._field = null;
    this.sites = [];                                // graded ground under built structures
    this.sea = !!(entry && entry.id === "earth");   // oceans are a flat water surface at 0 m
    this._exag = 1;                                 // vertical exaggeration (developer mode only)
    this.mode = entry && entry.terrain ? entry.terrain.mode : "procedural";
    // Where the elevation data is the body's whole shape (radius-valued, as
    // for Phobos and Enceladus), the reference is a sphere, not an ellipsoid.
    if (entry && entry.terrain && entry.terrain.shapeFromData) this.axes = [1, 1, 1];
    // Microdetail strength: amplitude per metre of wavelength (body-specific).
    this.rough = entry && entry.microdetail ? entry.microdetail.roughness : 0.045;
    this.log = [];                                  // recent data changes, for incremental worker updates
    // Procedural relief, only for bodies with no elevation data.
    const L = look || {};
    this.P = { seed: L.seed || 7, cont: L.cont || 1.6, mount: L.mount || 0.45, crater: L.crater || 0.3, craterFreq: L.craterFreq || 6, warp: L.warp || 0.3 };
    // A thick atmosphere (Venus 92 bar, Titan 1.5 bar) burns up small
    // impactors: no procedural cratering there.
    if (entry && entry.atmosphere && entry.atmosphere.pressureBar >= 1 && entry.surfaceType === "solid") this.P.crater = 0;
    const Rkm = this.R / 1000;
    this.relief = this.mode === "none" ? 0 : L.reliefKm ? L.reliefKm * 1000 : Math.min(8000, 3000 * Math.pow(Rkm / 1000, 0.35));
    // Imagery but no DEM: relief and cratering held to the body's typical values.
    const t = entry && entry.terrain;
    if (t && t.proceduralReliefM) { this.relief = t.proceduralReliefM; this.P.crater = t.craters; }
    // Terrain character for worlds without a DEM (europa, io, titan, triton).
    this.character = t && t.character ? t.character : null;
    this.features = null; this.featureList = null;
  }
  // Data-constrained features (features.js); a full re-sync for the workers.
  setFeatures(list) {
    this.featureList = list || [];
    this.features = this.featureList.length ? new FeatureSet(this.featureList, this.R) : null;
    if (this.features) this.features.setStripeAxis();
    this.version++; this._range = null;
  }
  featureHeight(x, y, z) { return this.features ? this.features.height(x, y, z) : 0; }
  get field() { return this._field; }
  set field(f) { this._field = f; this.version++; this._range = null; }
  get exag() { return this._exag; }
  set exag(k) { this._exag = k; this.version++; this._range = null; }
  // A regional elevation patch or a global tile arriving later.
  addPatch(p) { if (!this._field) return; this._field.addPatch(p); this.change("patch", { p: p.plain() }); }
  addTile(key, p) { if (!this._field) return; this._field.addTile(key, p); this.change("tile", { key, p: p.plain() }); }
  removeTile(key) { if (!this._field || !this._field.tiles.has(key)) return; const b = this._field.tiles.get(key).b; this._field.tiles.delete(key); this.change("untile", { key, b }); }
  change(kind, data) {
    this.version++;
    this.log.push({ v: this.version, kind, ...data });
    if (this.log.length > 600) this.log.splice(0, this.log.length - 600);
    if (kind === "patch") this._range = null;
  }
  // Apply a change recorded on another thread's copy.
  apply(e) {
    if (e.kind === "patch") this._field.addPatch(Patch.from(e.p));
    else if (e.kind === "tile") this._field.addTile(e.key, Patch.from(e.p));
    else if (e.kind === "untile") this._field.tiles.delete(e.key);
    this.version = e.v;
  }
  needsField() { return this.mode === REAL && !this.field; }
  ready() { return !this.needsField(); }

  // Reference-shape radius along a unit direction (body frame).
  baseRadius(x, y, z) {
    const a = this.axes;
    return this.R / Math.sqrt((x * x) / (a[0] * a[0]) + (y * y) / (a[1] * a[1]) + (z * z) / (a[2] * a[2]));
  }
  // A built site (a launch pad): ground graded flat at elevM within radiusM,
  // blending back into the dataset by twice that. steps: [[radius m, height m
  // above the graded ground], …] — the structure's decks, so landing and
  // walking stand on them.
  addSite(latDeg, lonDeg, radiusM, elevM, steps = []) {
    const la = latDeg * D2R, lo = lonDeg * D2R;
    this.sites.push({ d: [Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)], r: radiusM / this.R, elev: elevM,
      steps: steps.map(([r, h]) => [r / this.R, h]).sort((a, b) => a[0] - b[0]), lat: latDeg, lon: lonDeg, radiusM, rawSteps: steps });
    this.version++;
  }
  structureAt(x, y, z) {
    for (const s of this.sites) {
      const dot = x * s.d[0] + y * s.d[1] + z * s.d[2];
      if (dot < 0.9999) continue;
      const a = Math.acos(Math.min(1, dot));
      for (const [r, h] of s.steps) if (a < r) return h;
    }
    return 0;
  }
  groundRadius(x, y, z) { return this.baseRadius(x, y, z) + Math.max(0, this.elevation(x, y, z)); }
  siteWeight(x, y, z) {
    let w = 0, e = 0;
    for (const s of this.sites) {
      const dot = x * s.d[0] + y * s.d[1] + z * s.d[2];
      if (dot < 0.999) continue;                    // > ~280 km away
      const a = Math.acos(Math.min(1, dot)), t = Math.min(1, Math.max(0, (2 * s.r - a) / s.r));
      const k = t * t * (3 - 2 * t);
      if (k > w) { w = k; e = s.elev; }
    }
    return [w, e];
  }
  // Dataset elevation (m), before exaggeration — below 0 is sea floor on Earth.
  elevation(x, y, z) {
    if (!this.field) return 0;
    const e = this.field.sample(Math.asin(Math.max(-1, Math.min(1, y))), Math.atan2(-z, x));
    if (!this.sites.length) return e;
    const [w, se] = this.siteWeight(x, y, z);
    return w > 0 ? e + (se - e) * w : e;
  }
  // Microdetail strictly below the data's resolution: the longest
  // wavelength is a quarter of the local grid cell and never more than 24 m;
  // amplitude grows with wavelength (rough × λ, ≈1 m at most on Mars), so it
  // can roughen ground and add boulder-scale lumps but never make a hill,
  // move a ridge or a coastline. Stronger on the slopes of the real data.
  micro(x, y, z, e, detail) {
    if (detail <= 0 || !(this.rough > 0)) return 0;
    let cellM = Infinity, slope = 0;
    if (this.field) {
      const lat = Math.asin(Math.max(-1, Math.min(1, y))), lon = Math.atan2(-z, x);
      const cell = this.field.cellAt(lat, lon);
      cellM = cell * this.R;
      const k = 1 / Math.max(0.05, Math.cos(lat));
      const de = this.field.sample(lat, lon + cell * k) - this.field.sample(lat, lon - cell * k);
      const dn = this.field.sample(lat + cell, lon) - this.field.sample(lat - cell, lon);
      slope = Math.min(0.6, Math.hypot(de, dn) / (2 * cellM));
    }
    const lambda = Math.min(24, cellM * 0.25);
    if (lambda < 0.6) return 0;
    let amp = this.rough * lambda * (0.7 + 1.5 * slope);
    if (this.sea) amp *= Math.min(1, Math.max(0, e / 20));            // none at the shore or on water
    if (this.sites.length) amp *= 1 - this.siteWeight(x, y, z)[0];
    const f = this.R / lambda;
    return amp * fbm(x * f, y * f, z * f, this.P.seed + 211, 3 + Math.min(3, detail));
  }
  // Largest microdetail displacement (m), for the manifest and the UI.
  microMax() { return +(this.rough * 24 * 1.6).toFixed(2); }
  // Height of the walkable surface above the reference shape (m).
  heightAt(x, y, z, detail = 2) {
    if (this.mode === "none") return 0;
    if (this.mode === REAL) {
      if (!this.field) return 0;
      const e = this.elevation(x, y, z);
      if (this.sea && e <= 0) return 0;                               // the sea surface
      const deck = this.sites.length ? this.structureAt(x, y, z) : 0;
      let h = e + this.micro(x, y, z, e, detail);
      // Unmapped parts of a partly mapped body: smooth fill from the mapped
      // edges (built in) plus procedural relief, faded in by the coverage mask.
      if (this.field.coverage) {
        const c = this.field.coverage.sample(Math.asin(Math.max(-1, Math.min(1, y))), Math.atan2(-z, x));
        if (c < 0.999) h += (1 - Math.max(0, c)) * terrainHeight(x, y, z, this.P, detail) * this.relief * 0.5;
      }
      return (h + this.featureHeight(x, y, z)) * this.exag + deck;
    }
    // A real map but no elevation data: the real shape, plus microdetail only
    // — no invented hills, craters or ridges.
    if (this.mode === "real-imagery-no-relief") return (this.micro(x, y, z, 0, detail) + this.featureHeight(x, y, z)) * this.exag;
    const base = this.character ? character(this.character, x, y, z, this.P.seed, this.relief, detail) : terrainHeight(x, y, z, this.P, detail) * this.relief * 0.5;
    return (base + this.featureHeight(x, y, z) + this.micro(x, y, z, 0, detail)) * this.exag;
  }
  radiusAt(x, y, z, detail = 2) { return this.baseRadius(x, y, z) + this.heightAt(x, y, z, detail); }
  // Conservative bounds (m) of heightAt anywhere on the body, for culling.
  heightRange() {
    if (this.mode === "none" || this.mode === "real-imagery-no-relief") return [-60, 60];
    if (this.mode === REAL && this.field) {
      if (!this._range) {
        let lo = Infinity, hi = -Infinity;
        for (const g of [this.field, ...this.field.patches]) for (let i = 0; i < g.h.length; i++) { if (g.h[i] === NODATA) continue; const v = g.h[i] * g.scale; if (v < lo) lo = v; if (v > hi) hi = v; }
        const pad = 0.05 * (hi - lo) + 200 + (this.field.coverage ? this.relief : 0);   // microdetail, built sites, procedural fill
        this._range = [(Math.min(this.sea ? 0 : lo, lo) - pad) * this.exag, (hi + pad) * this.exag];
      }
      return this._range;
    }
    // Features: the deepest crater or tallest ridge bounds the range.
    let fd = 0, fu = 0;
    for (const f of this.featureList || []) { fd = Math.max(fd, (f.depthM || 0) + (f.heightM && f.kind === "scarp" ? f.heightM / 2 : 0)); fu = Math.max(fu, f.heightM || 0, (f.rimM || 0) + (f.peakM || 0)); }
    return [(-this.relief * 1.6 - fd) * this.exag, (this.relief * 1.6 + fu) * this.exag];
  }
  // Largest |elevation| in the data (m), for shading scales.
  elevSpan() { const r = this.heightRange(); return Math.max(1, Math.abs(r[0]), Math.abs(r[1])); }
  // waterAt (main thread, Earth): an optional (lat, lon) → true/false/null
  // override — outside the region packs the global land cover knows the
  // shoreline better than a 10′ elevation cell does.
  isWater(x, y, z) {
    if (!this.sea) return false;
    if (this.waterAt) { const w = this.waterAt(Math.asin(Math.max(-1, Math.min(1, y))) * 180 / Math.PI, Math.atan2(-z, x) * 180 / Math.PI); if (w !== null) return w; }
    return this.elevation(x, y, z) <= 0;
  }

  // Everything a worker needs to rebuild an identical Surface.
  serialize() {
    return { def: { radius: this.def.radius, flattening: this.def.flattening, triaxial: this.def.triaxial }, entry: this.entry, P: this.P, relief: this.relief,
      mode: this.mode, exag: this.exag, rough: this.rough, axes: this.axes, version: this.version, character: this.character, features: this.featureList, sites: this.sites.map((s) => [s.lat, s.lon, s.radiusM, s.elev, s.rawSteps]), field: this.field ? this.field.serialize() : null };
  }
  static from(o) {
    const s = new Surface(o.def, o.entry, {});
    s.P = o.P; s.relief = o.relief; s.mode = o.mode; s.exag = o.exag; s.rough = o.rough; s.axes = o.axes; s.character = o.character;
    if (o.features) s.setFeatures(o.features);
    for (const a of o.sites) s.addSite(...a);
    if (o.field) s.field = HeightField.from(o.field);
    s.version = o.version;
    return s;
  }
}

// ── geodesy helpers ──
export function latLon(d) {
  return { lat: Math.asin(Math.max(-1, Math.min(1, d.y))) * 180 / Math.PI, lon: Math.atan2(-d.z, d.x) * 180 / Math.PI };
}
// Latitude/longitude (degrees) → body-local unit direction.
export function dirFromLatLon(latDeg, lonDeg) {
  const la = latDeg * D2R, lo = lonDeg * D2R;
  return [Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)];
}
export function fmtLatLon(latDeg, lonDeg) {
  return Math.abs(latDeg).toFixed(4) + "° " + (latDeg >= 0 ? "N" : "S") + "  " + Math.abs(lonDeg).toFixed(4) + "° " + (lonDeg >= 0 ? "E" : "W");
}

// ── terrain chunk geometry (cube-sphere quadtree node) ──
export const FACES = [
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] }, { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] }, { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] }
];
export function faceDir(face, u, v) {
  const f = FACES[face];
  const a = u * 2 - 1, b = v * 2 - 1;
  const x = f.n[0] + a * f.u[0] + b * f.v[0], y = f.n[1] + a * f.u[1] + b * f.v[1], z = f.n[2] + a * f.u[2] + b * f.v[2];
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}
// Vertices relative to the chunk centre (float32-safe), with skirts. Returns
// typed arrays ready for a BufferGeometry, transferable from a worker.
export function buildChunk(surface, n, N) {
  const M = N + 2;                                 // one extra ring for seamless normals
  const detail = Math.min(5, Math.max(0, n.level - 3));
  const pos = new Float64Array(M * M * 3), dirs = new Float32Array(M * M * 3), elev = new Float32Array(M * M);
  for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
    const u = n.u0 + (n.u1 - n.u0) * (i - 1) / (N - 1), v = n.v0 + (n.v1 - n.v0) * (j - 1) / (N - 1);
    const d = faceDir(n.face, u, v);
    const r = surface.radiusAt(d[0], d[1], d[2], detail);
    const k = (j * M + i) * 3;
    pos[k] = d[0] * r; pos[k + 1] = d[1] * r; pos[k + 2] = d[2] * r;
    dirs[k] = d[0]; dirs[k + 1] = d[1]; dirs[k + 2] = d[2];
    elev[k / 3] = surface.elevation(d[0], d[1], d[2]);
  }
  const ci = ((M >> 1) * M + (M >> 1)) * 3;
  const ox = pos[ci], oy = pos[ci + 1], oz = pos[ci + 2];
  const skirt = (surface.R * 1.6 / (1 << n.level)) * 0.03;
  const vcount = N * N + 4 * N;
  const P = new Float32Array(vcount * 3), D = new Float32Array(vcount * 3), Nn = new Float32Array(vcount * 3), E = new Float32Array(vcount);
  const at = (i, j) => (j * M + i) * 3;
  let w = 0;
  const put = (i, j, drop) => {
    const k = at(i, j);
    const dx = dirs[k], dy = dirs[k + 1], dz = dirs[k + 2];
    P[w * 3] = pos[k] - ox - dx * drop; P[w * 3 + 1] = pos[k + 1] - oy - dy * drop; P[w * 3 + 2] = pos[k + 2] - oz - dz * drop;
    D[w * 3] = dx; D[w * 3 + 1] = dy; D[w * 3 + 2] = dz;
    E[w] = elev[k / 3];
    const l = at(i - 1, j), r = at(i + 1, j), b = at(i, j - 1), t = at(i, j + 1);
    const ax = pos[r] - pos[l], ay = pos[r + 1] - pos[l + 1], az = pos[r + 2] - pos[l + 2];
    const bx = pos[t] - pos[b], by = pos[t + 1] - pos[b + 1], bz = pos[t + 2] - pos[b + 2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    if (nx * dx + ny * dy + nz * dz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const nl = Math.hypot(nx, ny, nz) || 1;
    Nn[w * 3] = nx / nl; Nn[w * 3 + 1] = ny / nl; Nn[w * 3 + 2] = nz / nl;
    return w++;
  };
  const grid = new Uint32Array(N * N);
  for (let j = 1, q = 0; j <= N; j++) for (let i = 1; i <= N; i++) grid[q++] = put(i, j, 0);
  const idx = [];
  const g = (i, j) => grid[j * N + i];
  for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
    const a = g(i, j), b = g(i + 1, j), c = g(i, j + 1), d = g(i + 1, j + 1);
    idx.push(a, b, d, a, d, c);
  }
  const edge = (list) => {
    const sk = list.map(([i, j]) => put(i + 1, j + 1, skirt));
    for (let k = 0; k < list.length - 1; k++) {
      const a = g(list[k][0], list[k][1]), b = g(list[k + 1][0], list[k + 1][1]);
      idx.push(a, sk[k], b, b, sk[k], sk[k + 1], a, b, sk[k], b, sk[k + 1], sk[k]);
    }
  };
  const row = (j) => Array.from({ length: N }, (_, i) => [i, j]);
  const col = (i) => Array.from({ length: N }, (_, j) => [i, j]);
  edge(row(0)); edge(row(N - 1)); edge(col(0)); edge(col(N - 1));
  // The chunk's origin modulo 2048 m: with chunk-relative positions this gives
  // the shader a continuous, float32-precise metric coordinate for fine detail
  // (its noise repeats every 2048 m, so the wrap is seamless).
  const mod = (v) => ((v % 2048) + 2048) % 2048;
  const Bv = new Float32Array(vcount * 3);
  for (let i = 0; i < vcount; i++) { Bv[i * 3] = mod(ox); Bv[i * 3 + 1] = mod(oy); Bv[i * 3 + 2] = mod(oz); }
  return { P, N: Nn, D, E, B: Bv, index: new Uint32Array(idx), origin: [ox, oy, oz] };
}
