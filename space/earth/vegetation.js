// Earth vegetation at runtime: trees, shrubs, grass and crops in the region
// packs, from each region's vegetation pack (scripts/earth/build-vegetation.mjs)
// and its OpenStreetMap tiles. Only the Earth gets any: no other world has
// plants.
//
// Streaming follows the 0.01° map tiles. A tile's level of detail comes from
// its distance to the camera (altitude included):
//   L0  ≲ d0        every tree, shrubs, and the 2 m ground-cover raster (grass)
//   L1  ≲ 2·d0      every tree
//   L2  ≲ 5·d0      a thinned subset (¼)
//   L3  ≲ reach     a sparser subset (1/25)
// When drawing, trees beyond d0 are thinned continuously — kept with
// probability (d0/d)² — and the survivors widened by 1/√p, so a distant
// forest reads as a closed canopy of crown clusters rather than dots and the
// number drawn grows only with log(distance). Above ~reach no tree is built;
// from high up the aerial imagery shows the real canopy.
//
// Everything is batched: one instanced draw per (family, level of detail)
// for the whole field, never an object per tree. Instances live in an
// "anchor" frame (east, up, south) on the ground near the camera, rebuilt when
// the camera moves far, so positions stay float32-precise. Geometry level per
// instance: near (full 3D) · middle (simplified) · far (low-poly cluster).
//
// Nearby trees cast shadows (HIGH/ULTRA) through the local shadow maps; larger
// trunks near a walker block like rocks do; mapped OSM trees report their tags.

import * as THREE from "three";
import { fetchBundle, gunzip } from "../engine/packs.js";
import { surfaceWorkers } from "../render/terrain.js";
import { LOGDEPTH_VERT_PARS, LOGDEPTH_VERT, LOGDEPTH_FRAG_PARS, LOGDEPTH_FRAG } from "../engine/noise-glsl.js";
import { SHADOW_GLSL, shadowUniforms, CASTER_LAYER } from "../render/shadows.js";
import { TILE_DEG, tileOf, tileKey, tileBounds } from "./tile-format.js";
import { VEG_CELL, decodeTrees } from "./veg-format.js";
import { buildModels, FAMILY, FAMILY_NAMES, TREE_FAMILIES } from "./veg-models.js";

const D2R = Math.PI / 180;
// Outside the region packs (global base pack): no mapped trees, no edge fade.
const GLOBAL_R = { id: "global", meta: { bbox: { south: -90, north: 90, west: -180, east: 180 }, exclude: [] } };
const GLOBAL_P = { ready: true, global: true, meta: { strings: [""] }, byTile: new Map() };
const WORLD = { south: -90, north: 90, west: -180, east: 180 };
const NF = FAMILY_NAMES.length;
// Per quality preset: tree reach, full-density radius d0, near/middle geometry
// radii, shrub radius, grass radius (near blades / far tufts), density, shadows.
const Q = {
  low: { reach: 1500, d0: 150, near: 35, mid: 180, shrub: 60, grass: 0, grassNear: 0, density: 0.6, shadow: 0 },
  medium: { reach: 2500, d0: 250, near: 55, mid: 300, shrub: 110, grass: 28, grassNear: 14, density: 0.8, shadow: 1 },
  high: { reach: 4000, d0: 350, near: 60, mid: 420, shrub: 160, grass: 45, grassNear: 22, density: 1, shadow: 1 },
  ultra: { reach: 5500, d0: 450, near: 90, mid: 560, shrub: 220, grass: 70, grassNear: 30, density: 1.15, shadow: 2 }
};

const VERT = /* glsl */ `
  attribute float sway; attribute float ao;
  attribute vec4 iA; attribute vec4 iB;          // iA: x, up, z, height · iB: crown width, yaw, hash, tone (or ground type)
  uniform float uTime; uniform vec2 uWind;
  varying vec3 vC, vN, vW; varying float vAO, vTone;
  void main() {
    float h = iA.w, cw = iB.x, c = cos(iB.y), s = sin(iB.y);
    vec3 p = position * vec3(cw, h, cw);
    p = vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
    vec3 n = vec3(c * normal.x - s * normal.z, normal.y, s * normal.x + c * normal.z);
    // Wind (visual only): a slow sway growing with height on the plant, plus
    // leaf flutter; trunks (sway 0) stay put.
    float ph = iB.z * 6.2832 + dot(iA.xz, vec2(0.071, 0.053));
    float gust = 0.65 + 0.35 * sin(uTime * 0.31 + iA.x * 0.004 + iA.z * 0.003);
    float bend = sway * sway * gust * (0.55 + 0.45 * sin(uTime * 1.3 + ph));
    float flutter = sway * sin(uTime * 6.1 + ph + position.y * 11.0 + position.x * 7.0) * 0.012;
    p.xz += uWind * bend * min(h, 30.0) * 0.018 + vec2(flutter) * max(cw, 0.5);
    vec4 wp = modelMatrix * vec4(iA.xyz + p, 1.0);
    vW = wp.xyz; vN = normalize(mat3(modelMatrix) * n); vC = color; vAO = ao; vTone = iB.w;
    gl_Position = projectionMatrix * viewMatrix * wp;` + LOGDEPTH_VERT + `
  }`;
function vegMaterial(ground) {
  return new THREE.ShaderMaterial({
    uniforms: { uLightDir: { value: new THREE.Vector3(1, 0, 0) }, uLightCol: { value: new THREE.Vector3(1, 1, 1) }, uNight: { value: 0 },
      uTime: { value: 0 }, uWind: { value: new THREE.Vector2(1, 0) }, ...shadowUniforms },
    vertexShader: LOGDEPTH_VERT_PARS + VERT,
    fragmentShader: LOGDEPTH_FRAG_PARS + /* glsl */ `uniform vec3 uLightDir, uLightCol; uniform float uNight;` + SHADOW_GLSL + /* glsl */ `
      varying vec3 vC, vN, vW; varying float vAO, vTone;
      void main() {
        vec3 N = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0), L = normalize(uLightDir);
        float ndl = dot(N, L);
        // Foliage: wrapped diffuse (light through thin leaves), shadowed by the local sun shadows.
        float diff = max(ndl, 0.0) * 0.78 + clamp(ndl * 0.5 + 0.5, 0.0, 1.0) * 0.22;
        float sh = localShadow(vW, max(ndl, 0.08));
        vec3 base = vC;
        ${ground ? `
        // Ground cover: colour by type (1 lawn, 2 meadow, 3 dry grass, 4 reeds, 5 crop, 6 forest floor, 7 scrub floor).
        int t = int(vTone + 0.5);
        vec3 k = t == 1 ? vec3(1.0, 1.08, 0.95) : t == 3 ? vec3(2.3, 1.55, 1.6) : t == 4 ? vec3(1.3, 1.05, 1.1) : t == 5 ? vec3(1.15, 1.05, 0.9) : t == 6 ? vec3(0.85, 0.9, 0.9) : t == 7 ? vec3(1.4, 1.15, 1.2) : vec3(1.1, 1.0, 0.95);
        base *= k;` : `
        base *= mix(vec3(0.82, 0.88, 0.8), vec3(1.2, 1.1, 0.95), vTone);`}
        vec3 c = base * (uLightCol * diff * sh * 1.1 + vec3(0.1, 0.12, 0.15) * (1.0 - 0.8 * uNight) * vAO + 0.01);
        gl_FragColor = vec4(c, 1.0);
      ` + LOGDEPTH_FRAG + "}",
    side: THREE.DoubleSide, vertexColors: true
  });
}
function depthMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uWind: { value: new THREE.Vector2(1, 0) } },
    vertexShader: VERT.replace(LOGDEPTH_VERT, ""), fragmentShader: "void main() { gl_FragColor = vec4(gl_FragCoord.z, 0.0, 0.0, 1.0); }",
    side: THREE.DoubleSide, vertexColors: true
  });
}

// One instanced batch: a family's model at one level of detail. Its shadow
// caster shares the instances but draws a simpler model (shadowGeo): a crown's
// shadow doesn't need its full detail.
const instGeo = (geo) => { const g = new THREE.InstancedBufferGeometry(); for (const k of ["position", "normal", "color", "sway", "ao"]) g.setAttribute(k, geo.attributes[k]); return g; };
class Batch {
  constructor(geo, mat, shadowMat, shadowGeo) {
    this.geo = instGeo(geo);
    this.sgeo = shadowMat ? instGeo(shadowGeo || geo) : null;
    this.cap = 0; this.n = 0; this.data = null; this.alloc(256);
    this.mesh = new THREE.Mesh(this.geo, mat); this.mesh.frustumCulled = false;
    this.tris = geo.attributes.position.count / 3;
    if (shadowMat) { this.shadow = new THREE.Mesh(this.sgeo, shadowMat); this.shadow.frustumCulled = false; this.shadow.layers.set(CASTER_LAYER); }
  }
  alloc(cap) {
    const d = new Float32Array(cap * 8);
    if (this.data) d.set(this.data.subarray(0, this.n * 8));
    this.data = d; this.cap = cap;
    const ib = new THREE.InstancedInterleavedBuffer(d, 8); ib.setUsage(THREE.DynamicDrawUsage);
    for (const g of [this.geo, this.sgeo]) if (g) {
      g.setAttribute("iA", new THREE.InterleavedBufferAttribute(ib, 4, 0));
      g.setAttribute("iB", new THREE.InterleavedBufferAttribute(ib, 4, 4));
      // three.js caches the drawable instance count at first bind; a bigger
      // buffer must reset it or only the first `cap` instances would draw.
      g._maxInstanceCount = undefined;
    }
    this.ib = ib;
  }
  push(x, y, z, h, cw, yaw, hs, tone) {
    if (this.n >= this.cap) this.alloc(this.cap * 2);
    const d = this.data, o = this.n * 8;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = h; d[o + 4] = cw; d[o + 5] = yaw; d[o + 6] = hs; d[o + 7] = tone;
    this.n++;
  }
  commit() {
    this.geo.instanceCount = this.n; if (this.sgeo) this.sgeo.instanceCount = this.n;
    this.ib.updateRange.offset = 0; this.ib.updateRange.count = this.n * 8; this.ib.needsUpdate = true;
    this.mesh.visible = this.n > 0;
    if (this.shadow) this.shadow.visible = this.n > 0 && this.castShadow;
  }
  dispose() { this.geo.dispose(); if (this.sgeo) this.sgeo.dispose(); }
}

export class Vegetation {
  constructor(regions, scene) {
    this.regions = regions; this.scene = scene;
    this.packs = new Map();            // region id → pack (or a promise)
    this.tiles = new Map();            // key → { key, R, pack, lod, want, pending, raw, O, inst, fam, src, info, cover }
    this.osmCache = new Map();         // map tile key → ArrayBuffer (decompressed), small LRU
    this.models = buildModels();
    this.mat = vegMaterial(false); this.groundMat = vegMaterial(true); this.depthMat = depthMaterial();
    this.group = new THREE.Group(); scene.add(this.group);
    this.shadowScene = new THREE.Scene(); this.shadowGroup = new THREE.Group(); this.shadowScene.add(this.shadowGroup);
    this.batches = [];                 // [family][lod]
    for (let f = 0; f < NF; f++) {
      this.batches[f] = this.models[f].map((g, l) => {
        if (!g) return null;
        const b = new Batch(g, f >= FAMILY.grass ? this.groundMat : this.mat, f < TREE_FAMILIES ? this.depthMat : null, this.models[f][Math.min(2, l + 1)] || g);
        this.group.add(b.mesh); if (b.shadow) this.shadowGroup.add(b.shadow);
        return b;
      });
    }
    this.anchor = null; this.cam = null; this.ground = null; this.groundPending = false; this.groundAt = null;
    this.lastBucket = 0; this.lastBucketCam = null; this.dirty = true;
    this.trunks = []; this.mapped = [];
    this.stats = { tiles: 0, jobs: 0, jobMs: 0, instances: 0, drawn: [0, 0, 0], trees: 0, shrubs: 0, grass: 0, mapped: 0, generated: 0, tris: 0 };
    this.cfg = Q.high; this.quality = "high";
  }
  setQuality(name) { this.quality = Q[name] ? name : "high"; this.cfg = Q[this.quality]; this.dirty = true; }

  // ── packs ──
  pack(R) {
    if (!R.meta || !R.meta.veg) return null;
    let P = this.packs.get(R.id);
    if (P) return P.ready ? P : null;
    P = { ready: false };
    this.packs.set(R.id, P);
    P.promise = (async () => {
      const b = await fetchBundle(new URL(R.meta.veg.file, R.dir));
      const json = async (k) => JSON.parse(new TextDecoder().decode(await gunzip(b.get(k))));
      const meta = await json("meta"), grid = new Uint8Array(await gunzip(b.get("grid")));
      const trees = decodeTrees(new Uint8Array(await gunzip(b.get("trees")))), rows = await json("rows"), fields = await json("fields");
      const byTile = new Map(), add = (k, x) => { if (!byTile.has(k)) byTile.set(k, { trees: [], rows: [], fields: [] }); byTile.get(k)[x[0]].push(x[1]); };
      for (const t of trees) add(tileKey(...tileOf(t.lat, t.lon)), ["trees", t]);
      const spanTiles = (pts, x) => {
        let s = 90, n = -90, w = 180, e = -180;
        for (const p of pts) { s = Math.min(s, p[0]); n = Math.max(n, p[0]); w = Math.min(w, p[1]); e = Math.max(e, p[1]); }
        const [y0, x0] = tileOf(s, w), [y1, x1] = tileOf(n, e);
        for (let iy = y0; iy <= y1; iy++) for (let ix = x0; ix <= x1; ix++) add(tileKey(iy, ix), x);
      };
      for (const r of rows) spanTiles(r.pts, ["rows", r]);
      for (const f of fields) spanTiles(f.rings[0], ["fields", f]);
      Object.assign(P, { meta, grid, byTile, ready: true, R });
      this.dirty = true;
    })().catch((e) => { console.warn("[space] vegetation pack " + R.id + " unavailable", e.message); P.failed = true; });
    return null;
  }
  // The pack grid around one tile (plus two cells), for a worker job.
  subGrid(P, iy, ix) {
    const m = P.meta, b = tileBounds(iy, ix), pad = 2 * VEG_CELL;
    const x0 = Math.max(0, Math.floor((b.west - pad - m.bounds.west) / VEG_CELL)), x1 = Math.min(m.W, Math.ceil((b.east + pad - m.bounds.west) / VEG_CELL));
    const y0 = Math.max(0, Math.floor((m.bounds.north - b.north - pad) / VEG_CELL)), y1 = Math.min(m.H, Math.ceil((m.bounds.north - b.south + pad) / VEG_CELL));
    const W = Math.max(0, x1 - x0), H = Math.max(0, y1 - y0), data = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) data.set(P.grid.subarray((y0 + y) * m.W + x0, (y0 + y) * m.W + x0 + W), y * W);
    return { data, W, H, west: m.bounds.west + x0 * VEG_CELL, north: m.bounds.north - y0 * VEG_CELL, south: m.bounds.north - y1 * VEG_CELL, east: m.bounds.west + x1 * VEG_CELL };
  }
  async osmTile(R, key) {
    if (!R.meta.tiles[key]) return null;
    if (this.osmCache.has(key)) return this.osmCache.get(key);
    const M = R.meta, [iy, ix] = key.split("_").map(Number), sp = M.bundleSpan;
    const b = await fetchBundle(new URL("t/" + Math.floor(iy / sp) + "_" + Math.floor(ix / sp) + ".bin", R.dir));
    const g = b.get(key);
    const buf = g ? await gunzip(g) : null;
    this.osmCache.set(key, buf);
    if (this.osmCache.size > 120) this.osmCache.delete(this.osmCache.keys().next().value);
    return buf;
  }

  // Before the launch: load the pack and start the tiles around a point, so
  // the pad's surroundings are there at liftoff (doesn't block).
  async prewarm(lat, lon, surface) {
    for (const R of this.regions.regions.values()) {
      if (!R.loaded) continue;
      this.pack(R);
      const P = this.packs.get(R.id);
      if (P && P.promise) await P.promise.catch(() => {});
    }
    if (!this.cam) this.plan({ lat, lon, alt: 60 }, surface);
  }

  // ── each frame (cheap): which tiles at which level; start jobs; rebucket ──
  // cam: { lat, lon, alt, ahead, pos: body-local metres [x, y, z] }
  update(cam, surface, timeSec) {
    const C = this.cfg;
    this.mat.uniforms.uTime.value = this.groundMat.uniforms.uTime.value = this.depthMat.uniforms.uTime.value = timeSec;
    const wa = 0.6 + 0.25 * Math.sin(timeSec * 0.013);                 // a slowly veering, deterministic wind
    for (const m of [this.mat, this.groundMat, this.depthMat]) m.uniforms.uWind.value.set(Math.cos(wa), Math.sin(wa));
    if (!cam || cam.alt > C.reach * 1.2) { if (this.tiles.size) { this.trim(new Map()); this.dirty = true; } this.bucket(cam, true); return; }
    this.cam = cam;
    this.plan(cam, surface);
    this.groundCover(surface);
    this.bucket(cam, false);
  }
  plan(cam, surface) {
    const C = this.cfg;
    const want = new Map();
    const consider = (lat, lon, alt) => {
      const kx = 111320 * Math.max(0.05, Math.cos(lat * D2R)), reach = Math.sqrt(Math.max(0, C.reach * C.reach - alt * alt));        // bounded near the poles
      const dLon = Math.min(reach / kx, 0.4), [iy0, ix0] = tileOf(lat - reach / 111320, lon - dLon), [iy1, ix1] = tileOf(lat + reach / 111320, lon + dLon);
      for (const R of this.regions.regions.values()) {
        if (!R.loaded) continue;                                       // its elevation must be in the surface first
        const P = this.pack(R);
        if (!P) continue;
        const bb = R.meta.bbox;
        for (let iy = iy0; iy <= iy1; iy++) for (let ix = ix0; ix <= ix1; ix++) {
          const tb = tileBounds(iy, ix);
          if (tb.north <= bb.south || tb.south >= bb.north || tb.east <= bb.west || tb.west >= bb.east) continue;
          const dx = Math.max(0, tb.west - lon, lon - tb.east) * kx, dy = Math.max(0, tb.south - lat, lat - tb.north) * 111320;
          const d = Math.hypot(dx, dy, alt);
          const lod = d < C.d0 ? 0 : d < 2 * C.d0 ? 1 : d < 5 * C.d0 ? 2 : d < C.reach ? 3 : -1;
          if (lod < 0) continue;
          const key = tileKey(iy, ix), prev = want.get(key);
          if (!prev || lod < prev.lod) want.set(key, { R, P, lod, d });
        }
      }
    };
    // Everywhere outside the region packs: land cover from the global base pack.
    const considerGlobal = (lat, lon, alt) => {
      const G = this.regions.global;
      if (!G || !G.index) return;
      const kx = 111320 * Math.max(0.05, Math.cos(lat * D2R)), reach = Math.sqrt(Math.max(0, C.reach * C.reach - alt * alt));        // bounded near the poles
      const dLon = Math.min(reach / kx, 0.4), [iy0, ix0] = tileOf(lat - reach / 111320, lon - dLon), [iy1, ix1] = tileOf(lat + reach / 111320, lon + dLon);
      for (let iy = iy0; iy <= iy1; iy++) for (let ix = ix0; ix <= ix1; ix++) {
        if (this.regions.tileInPack(iy, ix)) continue;
        const tb = tileBounds(iy, ix);
        const dx = Math.max(0, tb.west - lon, lon - tb.east) * kx, dy = Math.max(0, tb.south - lat, lat - tb.north) * 111320;
        const d = Math.hypot(dx, dy, alt);
        const lod = d < C.d0 ? 0 : d < 2 * C.d0 ? 1 : d < 5 * C.d0 ? 2 : d < C.reach ? 3 : -1;
        if (lod < 0) continue;
        const key = tileKey(iy, ix), prev = want.get(key);
        if (!prev || lod < prev.lod) want.set(key, { R: GLOBAL_R, P: GLOBAL_P, lod, d });
      }
    };
    consider(cam.lat, cam.lon, cam.alt); considerGlobal(cam.lat, cam.lon, cam.alt);
    if (cam.ahead) { consider(cam.ahead.lat, cam.ahead.lon, cam.ahead.alt); considerGlobal(cam.ahead.lat, cam.ahead.lon, cam.ahead.alt); }
    this.trim(want);
    const list = [...want.entries()].sort((a, b) => a[1].d - b[1].d);
    const W = surfaceWorkers();
    for (const [key, w] of list) {
      let t = this.tiles.get(key);
      if (!t) { t = { key, R: w.R, P: w.P, lod: -1, pending: false }; this.tiles.set(key, t); }
      t.want = w.lod; t.d = w.d;
      if (t.pending || t.lod === t.want) continue;
      if (t.retryAt && performance.now() < t.retryAt) continue;
      if (W.inflight > 8) break;
      this.build(t, surface);
    }
  }
  trim(want) {
    for (const [key, t] of this.tiles) {
      if (want.has(key) || t.pending) continue;
      this.tiles.delete(key); this.dirty = true;
    }
  }
  async build(t, surface) {
    t.pending = true;
    const lod = t.want, [iy, ix] = t.key.split("_").map(Number), P = t.P, R = t.R;
    try {
      const osm = [];
      let grid;
      if (R === GLOBAL_R) {
        // Global: the synthetic map tiles (urban fallback, roads, rivers) mask the plants.
        const G = this.regions.global;
        grid = G.vegGrid(iy, ix, 3);
        if (!grid) { t.retryAt = performance.now() + 500; return; }            // land cover still loading
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (this.regions.tileInPack(iy + dy, ix + dx)) continue;
          const b = await G.synthTile(tileKey(iy + dy, ix + dx)); if (b) osm.push(b.slice(0));
        }
      } else {
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const b = await this.osmTile(R, tileKey(iy + dy, ix + dx)); if (b) osm.push(b.slice(0)); }
        grid = this.subGrid(P, iy, ix);
      }
      const extra = P.byTile.get(t.key) || { trees: [], rows: [], fields: [] };
      const W = surfaceWorkers();
      W.sync("earth", surface);
      const t0 = performance.now();
      const res = await W.run("veg", { key: "earth", args: {
        key: t.key, lod, pMax: [1, 1, 0.25, 0.04][lod], density: this.cfg.density, region: R.id, grid, box: WORLD,
        osm, trees: extra.trees, rows: extra.rows, fields: extra.fields, exclude: R.meta.exclude || [] },
        priority: 5 + Math.min(3, (t.d || 0) / 2000), stale: () => !this.tiles.has(t.key) || this.tiles.get(t.key).want !== lod });
      this.stats.jobs++; this.stats.jobMs += performance.now() - t0;
      if (this.tiles.get(t.key) !== t) return;
      Object.assign(t, { lod, O: res.origin, raw: res.inst, fam: res.fam, src: res.src, info: res.info, cover: res.cover, n: res.n, nTrees: res.nTrees, tstats: res.stats, inst: null });
      this.toAnchor(t);
      this.dirty = true;
    } catch (e) {
      if (e.message !== "stale") {
        t.fails = (t.fails || 0) + 1;
        console.warn("[space] vegetation tile " + t.key + " failed (" + t.fails + ")", e.message);
        if (t.fails >= 4) { t.lod = t.want; t.failed = true; } else t.retryAt = performance.now() + 2000 * t.fails;
      }
    } finally { t.pending = false; }
  }

  // ── anchor frame: east, up, south at a ground point near the camera ──
  setAnchor(pos) {
    const r = Math.hypot(pos[0], pos[1], pos[2]), U = [pos[0] / r, pos[1] / r, pos[2] / r];
    const lon = Math.atan2(-U[2], U[0]), E = [-Math.sin(lon), 0, -Math.cos(lon)];
    const N = [U[1] * E[2] - U[2] * E[1], U[2] * E[0] - U[0] * E[2], U[0] * E[1] - U[1] * E[0]];
    this.anchor = { A: pos.slice(), E, U, N, q: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(...E), new THREE.Vector3(...U), new THREE.Vector3(-N[0], -N[1], -N[2]))) };
    for (const t of this.tiles.values()) if (t.raw) this.toAnchor(t);
    if (this.ground) this.groundToAnchor();
    this.dirty = true;
  }
  toLocal(v) { const a = this.anchor; return [v[0] * a.E[0] + v[1] * a.E[1] + v[2] * a.E[2], v[0] * a.U[0] + v[1] * a.U[1] + v[2] * a.U[2], -(v[0] * a.N[0] + v[1] * a.N[1] + v[2] * a.N[2])]; }
  toAnchor(t) {
    if (!this.anchor) return;
    const a = this.anchor, off = this.toLocal([t.O[0] - a.A[0], t.O[1] - a.A[1], t.O[2] - a.A[2]]);
    const raw = t.raw, out = t.inst && t.inst.length === raw.length ? t.inst : new Float32Array(raw.length);
    const E = a.E, U = a.U, N = a.N;
    for (let o = 0; o < raw.length; o += 8) {
      const x = raw[o], y = raw[o + 1], z = raw[o + 2];
      out[o] = x * E[0] + y * E[1] + z * E[2] + off[0];
      out[o + 1] = x * U[0] + y * U[1] + z * U[2] + off[1];
      out[o + 2] = -(x * N[0] + y * N[1] + z * N[2]) + off[2];
      out[o + 3] = raw[o + 3]; out[o + 4] = raw[o + 4]; out[o + 5] = raw[o + 5]; out[o + 6] = raw[o + 6]; out[o + 7] = raw[o + 7];
    }
    t.inst = out;
  }

  // ── grass, reeds and crops around the camera ──
  groundCover(surface) {
    const C = this.cfg, cam = this.cam;
    if (!C.grass || !cam || cam.alt > 120) { if (this.ground) { this.ground = null; this.dirty = true; } return; }
    if (this.groundPending) return;
    const covers = [];
    for (const t of this.tiles.values()) if (t.cover && t.lod === 0) covers.push(t.cover);
    if (!covers.length) return;
    const kx = 111320 * Math.cos(cam.lat * D2R);
    const moved = this.groundAt ? Math.hypot((cam.lat - this.groundAt.lat) * 111320, (cam.lon - this.groundAt.lon) * kx) : Infinity;
    if (moved < C.grass * 0.15 && this.groundAt.covers === covers.length) return;
    this.groundPending = true;
    const at = { lat: cam.lat, lon: cam.lon, covers: covers.length };
    const W = surfaceWorkers();
    W.sync("earth", surface);
    W.run("ground", { key: "earth", args: { lat: cam.lat, lon: cam.lon, radius: C.grass, nearR: C.grassNear, density: C.density, covers, global: !this.regions.inPack(cam.lat, cam.lon) }, priority: 1,
      stale: () => !this.cam })
      .then((r) => { this.ground = r; this.groundAt = at; this.groundToAnchor(); this.dirty = true; }, () => {})
      .finally(() => { this.groundPending = false; });
  }
  groundToAnchor() {
    if (!this.anchor || !this.ground) return;
    const g = this.ground;
    if (!g.raw) { g.raw = g.inst; g.inst = null; g.O = g.origin; g.n = g.fam.length; }
    this.toAnchor(g);
  }

  // ── sort instances into batches by distance (throttled) ──
  bucket(cam, clear) {
    const now = performance.now();
    if (!clear && this.anchor && !this.dirty && now - this.lastBucket < 250) return;
    if (clear || !cam) {
      for (const row of this.batches) for (const b of row) if (b) { b.n = 0; b.commit(); }
      this.trunks = []; this.mapped = []; this.stats.drawn = [0, 0, 0]; return;
    }
    if (!this.anchor || Math.hypot(cam.pos[0] - this.anchor.A[0], cam.pos[1] - this.anchor.A[1], cam.pos[2] - this.anchor.A[2]) > 2500) this.setAnchor(cam.pos);
    const c = this.toLocal([cam.pos[0] - this.anchor.A[0], cam.pos[1] - this.anchor.A[1], cam.pos[2] - this.anchor.A[2]]);
    if (!this.dirty && this.lastBucketCam && Math.hypot(c[0] - this.lastBucketCam[0], c[1] - this.lastBucketCam[1], c[2] - this.lastBucketCam[2]) < 6) return;
    this.lastBucket = now; this.lastBucketCam = c; this.dirty = false;
    const tb0 = performance.now();
    const C = this.cfg, B = this.batches;
    for (const row of B) for (const b of row) if (b) b.n = 0;
    const trunks = [], mapped = [];
    let trees = 0, shrubs = 0, gen = 0, nmap = 0;
    const R2 = C.reach, d0 = C.d0, fadeIn = R2 * 0.82;
    for (const t of this.tiles.values()) {
      const I = t.inst, Fm = t.fam, S = t.src;
      if (!I) continue;
      // Shrubs follow the trees in each tile; skip them where out of range.
      const end = (t.d || 0) > C.shrub ? t.nTrees : t.n;
      for (let i = 0, o = 0; i < end; i++, o += 8) {
        const f = Fm[i], dx = I[o] - c[0], dy = I[o + 1] - c[1], dz = I[o + 2] - c[2], d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        let h = I[o + 3], cw = I[o + 4], lod;
        if (f < TREE_FAMILIES) {
          if (d > R2) continue;
          // Beyond d0: thin to probability (d0/d)², widening the survivors into
          // crown clusters. Mapped trees stay individual out to 1.5 km.
          if (d > d0 && !(S[i] && d < 1500)) {
            const p = (d0 / d) * (d0 / d);
            if (I[o + 6] > p) continue;
            cw *= Math.min(3.5, 1 / Math.sqrt(p));
          }
          if (d > fadeIn) { const k = 1 - (d - fadeIn) / (R2 - fadeIn); h *= k; cw *= k; }
          lod = d < C.near ? 0 : d < C.mid ? 1 : 2;
          trees++; if (S[i]) nmap++; else gen++;
          if (d < 30 && this.anchor) trunks.push(I[o], I[o + 1], I[o + 2], Math.min(0.6, Math.max(0.12, h * (f === FAMILY.palm ? 0.02 : 0.013))), h);
          if (S[i] === 1 && d < 40) mapped.push({ x: I[o], y: I[o + 1], z: I[o + 2], h: I[o + 3], cw: I[o + 4], f, info: t.info[i], strings: t.P.meta.strings, d });
        } else {
          if (d > C.shrub) continue;
          if (d > C.shrub * 0.8) { const k = 1 - (d - C.shrub * 0.8) / (C.shrub * 0.2); h *= k; cw *= k; }
          lod = d < C.near * 0.75 ? 0 : 1;
          shrubs++;
        }
        const bt = B[f][lod] || B[f][1] || B[f][0];
        bt.push(I[o], I[o + 1], I[o + 2], h, cw, I[o + 5], I[o + 6], I[o + 7]);
      }
    }
    // Ground cover from the camera job.
    let grass = 0;
    const g = this.ground;
    if (g && g.inst) {
      const I = g.inst;
      for (let i = 0, o = 0; i < g.fam.length; i++, o += 8) {
        const f = g.fam[i], dx = I[o] - c[0], dz = I[o + 2] - c[2], d = Math.hypot(dx, dz);
        let h = I[o + 3], cw = I[o + 4];
        const lim = f === FAMILY.crop ? Math.min(90, C.grass) : C.grass;
        if (d > lim) continue;
        if (d > lim * 0.8) { const k = 1 - (d - lim * 0.8) / (lim * 0.2); h *= k; cw *= k; }
        B[f][0].push(I[o], I[o + 1], I[o + 2], h, cw, I[o + 5], I[o + 6], I[o + 7]);
        grass++;
      }
    }
    let tris = 0;
    const shadowNear = C.shadow >= 1, shadowMid = C.shadow >= 2;
    B.forEach((row, f) => row.forEach((b, l) => { if (!b) return; b.castShadow = f < TREE_FAMILIES && (l === 0 ? shadowNear : l === 1 && shadowMid); b.commit(); tris += b.n * b.tris; }));
    this.trunks = trunks; this.mapped = mapped.sort((a, b) => a.d - b.d).slice(0, 8);
    this.stats.bucketMs = +(0.8 * (this.stats.bucketMs || 0) + 0.2 * (performance.now() - tb0)).toFixed(2);
    Object.assign(this.stats, { tiles: [...this.tiles.values()].filter((t) => t.inst).length, trees, shrubs, grass, mapped: nmap, generated: gen, tris,
      drawn: [0, 1, 2].map((l) => B.reduce((s, row) => s + (row[l] ? row[l].n : 0), 0)) });
  }

  // ── each frame, after the Earth is placed ──
  place(p, quat, s, lightDir, lightCol, night) {
    for (const m of [this.mat, this.groundMat]) { m.uniforms.uLightDir.value.copy(lightDir); m.uniforms.uLightCol.value.copy(lightCol); m.uniforms.uNight.value = night || 0; }
    if (!this.anchor) { this.group.visible = false; return; }
    const A = this.anchor.A;
    this.group.visible = true;
    this.group.position.set(A[0], A[1], A[2]).applyQuaternion(quat).multiplyScalar(s).add(p);
    this.group.quaternion.copy(quat).multiply(this.anchor.q);
    this.group.scale.setScalar(s);
    this.shadowGroup.position.copy(this.group.position); this.shadowGroup.quaternion.copy(this.group.quaternion); this.shadowGroup.scale.copy(this.group.scale);
  }
  // Walking: is a body-local point (metres) inside a tree trunk?
  blocked(pos) {
    if (!this.anchor || !this.trunks.length) return false;
    const a = this.anchor, q = this.toLocal([pos[0] - a.A[0], pos[1] - a.A[1], pos[2] - a.A[2]]), T = this.trunks;
    for (let i = 0; i < T.length; i += 5) {
      if (q[1] < T[i + 1] - 1 || q[1] > T[i + 1] + Math.min(4, T[i + 4] * 0.5)) continue;
      if (Math.hypot(q[0] - T[i], q[2] - T[i + 2]) < T[i + 3] + 0.25) return true;
    }
    return false;
  }
  // The nearest individually mapped OSM tree to a body-local point, within 25 m.
  mappedTreeNear(pos) {
    if (!this.anchor || !this.mapped.length) return null;
    const a = this.anchor, q = this.toLocal([pos[0] - a.A[0], pos[1] - a.A[1], pos[2] - a.A[2]]);
    let best = null, bd = 25;
    for (const m of this.mapped) { const d = Math.hypot(m.x - q[0], m.z - q[2]); if (d < bd) { bd = d; best = m; } }
    return best && { distance: bd, height: best.h, crown: best.cw, family: FAMILY_NAMES[best.f], info: best.strings[best.info] || "" };
  }
  // READY / LOADING / FAILED / NONE for the tiles around a point.
  status(lat, lon) {
    let n = 0, ready = 0, failed = 0;
    // The nine nearest tiles (whatever the altitude and preset).
    const near = [...this.tiles.values()].sort((a, b) => (a.d || 0) - (b.d || 0)).slice(0, 9);
    for (const t of near) { n++; if (t.inst) ready++; else if (t.failed) failed++; }
    if (!n) return this.cam ? "NONE" : "—";
    return failed > n * 0.2 ? "FAILED" : ready >= n * 0.8 ? "READY" : "LOADING";
  }
  summary() {
    const s = this.stats;
    return { ...s, avgJobMs: s.jobs ? +(s.jobMs / s.jobs).toFixed(1) : 0, packs: [...this.packs.entries()].filter(([, p]) => p.ready).map(([id]) => id), quality: this.quality };
  }
  dispose() {
    this.tiles.clear();
    for (const row of this.batches) for (const b of row) if (b) b.dispose();
    for (const g of this.models) for (const m of g) if (m) m.dispose();
    this.mat.dispose(); this.groundMat.dispose(); this.depthMat.dispose();
    this.scene.remove(this.group);
  }
}
export { TILE_DEG };
