// Earth region packs at runtime: higher-resolution elevation, aerial imagery
// and real map data (buildings, roads, water, places) where a pack exists —
// built from open data by scripts/earth/build-region.mjs.
//
// Everything here lives in the Earth's own rotating frame: elevation patches
// join the Earth's surface model (so terrain, collision and walking use
// them), imagery is draped by the terrain shader, and map tiles are meshes
// whose vertices are fixed in Earth-local coordinates, placed each frame with
// the Earth's position and rotation like the terrain chunks.
//
// Map tiles stream around the camera (and ahead of it along its velocity) at
// three levels of detail:
//   near   (≲ 2 km)   every building footprint and street, collision for walking
//   middle (≲ 7 km)   large or tall buildings; tertiary roads and up, rail, runways
//   far    (≲ 22 km)  towers only; primary roads and up, runways
// Above ~22 km nothing is built; the imagery carries the city.

import * as THREE from "three";
import { Patch, latLon } from "../universe/surface-core.js";
import { loadGrid } from "../universe/surfaces.js";
import { surfaceWorkers } from "../render/terrain.js";
import { LOGDEPTH_VERT_PARS, LOGDEPTH_VERT, LOGDEPTH_FRAG_PARS, LOGDEPTH_FRAG } from "../engine/noise-glsl.js";
import { TILE_DEG, tileOf, tileKey } from "./tile-format.js";
import { fetchBundle, gunzip } from "../engine/packs.js";
import { SHADOW_GLSL, shadowUniforms, CASTER_LAYER } from "../render/shadows.js";
import { Vegetation } from "./vegetation.js";
import { GlobalEarth } from "./global.js";
import { bundleKey, tileName } from "./global-format.js";

// Map tiles outside the region packs come from the global base pack
// (global.js): procedural urban blocks in built-up land cover, Natural Earth
// roads and rivers. They stream nearer than pack tiles (no far level).
const GLOBAL_R = { id: "global", synth: true, meta: { exclude: [] } };

const BASE = new URL("../data/earth/regions/", import.meta.url);
const LOD_RANGE = [2000, 7000, 22000];
const D2R = Math.PI / 180;

// ── shared materials ──
const LIGHT_PARS = /* glsl */ `uniform vec3 uLightDir, uLightCol; uniform float uNight;` + SHADOW_GLSL;
function buildingMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uLightDir: { value: new THREE.Vector3(1, 0, 0) }, uLightCol: { value: new THREE.Vector3(1, 1, 1) }, uNight: { value: 0 }, ...shadowUniforms },
    vertexShader: LOGDEPTH_VERT_PARS + /* glsl */ `
      varying vec3 vC, vN, vW; varying vec2 vUV;
      void main() { vC = color; vUV = uv; vN = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0); vW = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;` + LOGDEPTH_VERT + "}",
    fragmentShader: LOGDEPTH_FRAG_PARS + LIGHT_PARS + /* glsl */ `
      varying vec3 vC, vN, vW; varying vec2 vUV;
      float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        vec3 N = normalize(vN), L = normalize(uLightDir);
        vec3 base = vC; float glass = 0.0, lit = 0.0;
        if (vUV.x >= 0.0) {
          // Facade rhythm by building type (from the map data): bay width,
          // storey height and window size. Ground floor kept solid.
          float style = floor(vUV.x / 100000.0), u = vUV.x - style * 100000.0;
          vec4 P = style < 0.5 ? vec4(3.2, 3.0, 0.62, 0.5)        // residential
                 : style < 1.5 ? vec4(1.8, 3.6, 0.8, 0.62)        // commercial: near-continuous glazing
                 : style < 2.5 ? vec4(7.0, 7.0, 0.35, 0.18)       // industrial: few, high windows
                 : style < 3.5 ? vec4(3.6, 4.2, 0.5, 0.55)        // civic: tall windows
                 : style < 4.5 ? vec4(3.2, 3.2, 0.55, 0.5)        // other
                 : vec4(1.5, 3.8, 0.9, 0.72);                     // towers: curtain wall
          vec2 cell = vec2(u / P.x, vUV.y / P.y), f = fract(cell);
          float hx = 0.5 * (1.0 - P.z), hy = 0.5 * (1.0 - P.w);
          float win = step(hx, f.x) * step(f.x, 1.0 - hx) * step(hy + 0.08, f.y) * step(f.y, 1.0 - hy + 0.08) * step(1.0, cell.y);
          glass = win * 0.85;
          base = mix(base * (0.92 + 0.12 * h21(floor(cell.yy) + vC.rg * 9.0)), vec3(0.045, 0.06, 0.075), glass);
          lit = win * step(0.62, h21(floor(cell) + floor(vC.rg * 97.0))) * uNight;
        } else {
          base *= 0.9 + 0.1 * h21(floor(vW.xz * 0.5));
        }
        float diff = max(dot(N, L), 0.0) * localShadow(vW, max(dot(N, L), 0.05));
        vec3 c = base * (uLightCol * diff * 1.05 + vec3(0.11, 0.13, 0.16) * (1.0 - 0.8 * uNight) + 0.015);
        // Sky reflection on the glass, a sun glint, and lit windows at night.
        vec3 V = normalize(cameraPosition - vW), H = normalize(L + V);
        c += glass * (vec3(0.05, 0.07, 0.1) * (1.0 - uNight) + uLightCol * pow(max(dot(N, H), 0.0), 80.0) * 0.6);
        c += lit * vec3(1.0, 0.78, 0.48) * 0.55;
        gl_FragColor = vec4(c, 1.0);
      ` + LOGDEPTH_FRAG + "}",
    vertexColors: true
  });
}
function roadMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uLightDir: { value: new THREE.Vector3(1, 0, 0) }, uLightCol: { value: new THREE.Vector3(1, 1, 1) }, uNight: { value: 0 }, ...shadowUniforms },
    vertexShader: LOGDEPTH_VERT_PARS + /* glsl */ `
      flat varying float vCls; varying float vHalf; varying vec3 vN, vW; varying vec2 vUV;
      void main() { vCls = color.x; vHalf = color.y; vUV = uv; vN = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0); vW = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;` + LOGDEPTH_VERT + "}",
    fragmentShader: LOGDEPTH_FRAG_PARS + LIGHT_PARS + /* glsl */ `
      flat varying float vCls; varying float vHalf; varying vec3 vN, vW; varying vec2 vUV;
      void main() {
        float c = vCls, across = vUV.y, along = vUV.x, w = vHalf * 2.0;
        if (c >= 18.5) {                                                   // a river (global base pack): water
          vec3 N = normalize(vN), L = normalize(uLightDir), V = normalize(cameraPosition - vW), H = normalize(L + V);
          float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0), bank = smoothstep(0.0, 0.08, min(across, 1.0 - across));
          vec3 wcol = vec3(0.012, 0.03, 0.04) * (uLightCol * max(dot(N, L), 0.0) + 0.2) + uLightCol * pow(max(dot(N, H), 0.0), 120.0) * 0.6 + vec3(0.1, 0.13, 0.17) * fres * (1.0 - uNight);
          gl_FragColor = vec4(mix(vec3(0.06, 0.055, 0.045) * (uLightCol * 0.6 + 0.1), wcol, bank), 1.0);
      ` + LOGDEPTH_FRAG + `
          return;
        }
        vec3 col = c <= 9.5 ? vec3(0.055, 0.056, 0.06) : c <= 14.5 ? vec3(0.2, 0.18, 0.15) : c <= 16.5 ? vec3(0.1, 0.085, 0.075) : vec3(0.08, 0.08, 0.082);
        float m = 0.0;
        float edgeD = min(across, 1.0 - across) * w;                       // metres from the nearer edge
        if (c <= 4.5) {                                                    // major roads: edge lines, dashed centre
          m = max(step(edgeD, 0.35) * step(0.15, edgeD), step(abs(across - 0.5) * w, 0.08) * step(mod(along, 12.0), 4.0));
        } else if (c >= 16.5) {                                            // runways and taxiways
          m = max(step(edgeD, 1.2) * step(0.3, edgeD), step(abs(across - 0.5) * w, 0.45) * step(mod(along, 60.0), 36.0) * step(17.5, -c + 35.0));
        } else if (c >= 14.5) {                                            // rail: two rails on ballast
          float r = abs(abs(across - 0.5) * w - 0.72);
          col = mix(col, vec3(0.22, 0.22, 0.24), step(r, 0.04));
        }
        col = mix(col, vec3(0.55, 0.55, 0.52), m * 0.8);
        float diff = max(dot(normalize(vN), normalize(uLightDir)), 0.0) * localShadow(vW, 0.8);
        gl_FragColor = vec4(col * (uLightCol * diff + vec3(0.1, 0.12, 0.15) * (1.0 - 0.8 * uNight) + 0.012), 1.0);
      ` + LOGDEPTH_FRAG + "}",
    vertexColors: true,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4
  });
}
function waterMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uLightDir: { value: new THREE.Vector3(1, 0, 0) }, uLightCol: { value: new THREE.Vector3(1, 1, 1) }, uNight: { value: 0 }, ...shadowUniforms },
    vertexShader: LOGDEPTH_VERT_PARS + /* glsl */ `varying vec3 vN, vW;
      void main() { vN = normalize(mat3(modelMatrix) * normal); vec4 wp = modelMatrix * vec4(position, 1.0); vW = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;` + LOGDEPTH_VERT + "}",
    fragmentShader: LOGDEPTH_FRAG_PARS + LIGHT_PARS + /* glsl */ `varying vec3 vN, vW;
      void main() {
        vec3 N = normalize(vN), L = normalize(uLightDir), V = normalize(cameraPosition - vW), H = normalize(L + V);
        float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
        // A translucent surface over the photographed water: darkening, sky
        // reflection at grazing angles and the sun's glint.
        vec3 c = vec3(0.01, 0.03, 0.04) * (uLightCol * max(dot(N, L), 0.0) + 0.2) + uLightCol * pow(max(dot(N, H), 0.0), 120.0) * 0.8 + vec3(0.12, 0.16, 0.2) * fres * (1.0 - uNight);
        gl_FragColor = vec4(c, 0.55 + 0.35 * fres);
      ` + LOGDEPTH_FRAG + "}",
    transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2
  });
}

function geometry(r) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(r.P, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(r.N, 3));
  g.setAttribute("color", new THREE.BufferAttribute(r.C, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(r.U, 2));
  g.setIndex(new THREE.BufferAttribute(r.index, 1));
  g.computeBoundingSphere();
  return g;
}

export class EarthRegions {
  constructor(body, scene) {
    this.body = body; this.scene = scene;
    this.regions = new Map();          // id → { meta, dir, state, layers }
    this.tiles = new Map();            // key → { region, lod, want, group, data, foot, pending }
    this.index = null;
    this.mats = { b: buildingMaterial(), r: roadMaterial(), w: waterMaterial() };
    this.group = new THREE.Group();
    scene.add(this.group);
    this.fetching = 0;
    this.stats = { tiles: 0, buildings: 0, roads: 0, triangles: 0, buildMs: 0, built: 0 };
    this.places = [];
    this.global = new GlobalEarth();                  // land cover, roads, rivers, urban fallback everywhere
    this.veg = new Vegetation(this, scene);          // trees, shrubs, grass (vegetation.js)
    this.content = new Map();                         // global map tile key → has content (true/false)
  }
  async init() {
    try { this.index = await (await fetch(new URL("index.json", BASE))).json(); }
    catch (e) { console.warn("[space] no Earth region packs", e.message); this.index = { regions: [] }; }
    await this.global.init();
    return this.index;
  }
  // Is a point inside a region pack's box (loaded or not)?
  inPack(lat, lon, margin = 0) { return this.regionAt(lat, lon, margin).length > 0; }
  tileInPack(iy, ix) {
    const s = iy * TILE_DEG - 90, w = ix * TILE_DEG - 180;
    return (this.index ? this.index.regions : []).some((r) => s + TILE_DEG > r.bbox.south && s < r.bbox.north && w + TILE_DEG > r.bbox.west && w < r.bbox.east);
  }
  // Landmark models (from landmarks.json, built from landmark-overrides.json):
  // handed to the tile builder of the region that holds them.
  setLandmarkModels(list) {
    this.models = (list || []).filter((l) => l.model && l.model.anchor).map((l) => ({ ...l.model, qid: l.qid }));
    // Tiles already built without them are rebuilt.
    for (const t of this.tiles.values()) if (t.R && t.R.meta && this.modelsFor(t.R)) t.lod = -1;
  }
  modelsFor(R) {
    const b = R && R.meta && R.meta.bbox;
    if (!b || !this.models) return null;
    const m = this.models.filter((x) => x.anchor.lat > b.south - 0.01 && x.anchor.lat < b.north + 0.01 && x.anchor.lon > b.west - 0.01 && x.anchor.lon < b.east + 0.01);
    return m.length ? m : null;
  }
  regionAt(lat, lon, margin = 0) {
    return (this.index ? this.index.regions : []).filter((r) => lat > r.bbox.south - margin && lat < r.bbox.north + margin && lon > r.bbox.west - margin && lon < r.bbox.east + margin);
  }

  // Load a region: its elevation joins the Earth's surface; imagery is
  // fetched for the terrain shader; tiles stream later.
  async load(id) {
    if (this.regions.has(id)) return this.regions.get(id).ready;
    const dir = new URL(id + "/", BASE);
    const R = { id, dir, meta: null, layers: [] };
    R.ready = (async () => {
      R.meta = await (await fetch(new URL("meta.json", dir))).json();
      const surf = this.body.getSurface();
      for (const d of R.meta.dem) {
        const h = await loadGrid(d, dir);
        const patch = new Patch(h, d.width, d.height, d.scale, d.bounds);
        patch.source = d.source + " · " + Math.round(d.arcsec * 30.87) + " m";
        surf.addPatch(patch);
      }
      // Imagery: coarse first, finest last (the shader draws in that order).
      R.layers = R.meta.imagery.map((im) => {
        const b = im.bounds;
        return { url: new URL(im.file, dir).href, tex: null, bounds: new THREE.Vector4(b.south * D2R, b.west * D2R, b.north * D2R, b.east * D2R), area: (b.north - b.south) * (b.east - b.west) };
      }).sort((a, b) => b.area - a.area);
      this.texturesIn(R);
      for (const p of R.meta.places) this.places.push({ ...p, region: R.meta.name });
      // Only now is the region's elevation part of the surface: tiles built
      // earlier would sit on the coarse global ground.
      R.loaded = true;
      return R;
    })();
    this.regions.set(id, R);
    try { await R.ready; } catch (e) { console.warn("[space] region " + id + " unavailable", e.message); this.regions.delete(id); throw e; }
    return R;
  }

  // Imagery textures are held only near the region: they are the largest GPU
  // allocations here (up to 3072² with mipmaps, ~50 MB each), and visiting
  // many cities in one session must not keep them all.
  texturesIn(R) {
    const loader = new THREE.TextureLoader();
    for (const l of R.layers) if (!l.tex) {
      const t = loader.load(l.url);
      // Anisotropic filtering for low-angle views (three.js clamps it to the GPU's maximum).
      t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      l.tex = t;
    }
  }
  texturesOut(R) { for (const l of R.layers) if (l.tex) { l.tex.dispose(); l.tex = null; } }

  // Hand the region imagery around the camera to the terrain material.
  applyImagery(mat, lat, lon) {
    this.global.applyTexture(mat);
    const u = mat.uniforms;
    if (!u.uImg0) return;
    let best = null, bd = Infinity;
    for (const R of this.regions.values()) {
      if (!R.meta || !R.layers.length) continue;
      const b = R.meta.bbox, d = Math.hypot(Math.max(0, b.south - lat, lat - b.north), Math.max(0, b.west - lon, lon - b.east));
      if (d < bd) { bd = d; best = R; }
    }
    if (u.uPackB) {
      // The pack whose box holds this point (any pack, imagery or not).
      let b = null;
      for (const R of this.regions.values()) { const x = R.loaded && R.meta && R.meta.bbox; if (x && lat > x.south && lat < x.north && lon > x.west && lon < x.east) { b = x; break; } }
      u.uPackOn.value = b ? 1 : 0;
      if (b) u.uPackB.value.set(b.south * D2R, b.west * D2R, b.north * D2R, b.east * D2R);
    }
    // Release imagery of regions far away; bring back the nearest's.
    for (const R of this.regions.values()) {
      if (!R.meta || !R.layers.length) continue;
      const b = R.meta.bbox, d = Math.hypot(Math.max(0, b.south - lat, lat - b.north), Math.max(0, b.west - lon, lon - b.east));
      if (d > 5) this.texturesOut(R);
    }
    if (best && bd < 3) this.texturesIn(best);
    // Two slots, coarse then fine: the two finest layers of the nearest region.
    const L = best && bd < 3 ? best.layers.slice(-2) : [];
    for (let k = 0; k < 2; k++) {
      const l = L[k] || null;
      u["uImg" + k].value = l ? l.tex : null;
      u["uImg" + k + "On"].value = l && l.tex && l.tex.image ? 1 : 0;
      if (l) u["uImg" + k + "B"].value.copy(l.bounds);
    }
  }

  // Each frame (cheap): camera lat/lon/alt in Earth's frame, and where it will
  // be in a few seconds. Starts region loads and tile builds.
  update(cam) {
    if (!this.index) return;
    // Regions within ~1.5° start loading.
    for (const r of this.regionAt(cam.lat, cam.lon, 1.5)) if (!this.regions.has(r.id)) this.load(r.id).catch(() => {});
    if (cam.alt < 3e5) this.global.update(cam.lat, cam.lon);
    this.veg.update(cam.pos ? cam : null, this.body.getSurface(), performance.now() / 1000);
    const LR = LOD_RANGE.map((v) => v * (this.reach || 1));          // quality preset (cityReach)
    if (cam.alt > LR[2]) { this.trim(new Map()); return; }
    const want = new Map();
    const consider = (lat, lon, alt) => {
      // Near the poles cos(lat) → 0: the east–west scale is clamped so the tile span stays bounded.
      const kx = 111320 * Math.max(0.05, Math.cos(lat * D2R)), reach = Math.sqrt(Math.max(0, LR[2] ** 2 - alt * alt));
      const dLat = reach / 111320, dLon = Math.min(reach / kx, 0.4);
      const [iy0, ix0] = tileOf(lat - dLat, lon - dLon), [iy1, ix1] = tileOf(lat + dLat, lon + dLon);
      for (const R of this.regions.values()) {
        if (!R.loaded) continue;
        for (let iy = iy0; iy <= iy1; iy++) for (let ix = ix0; ix <= ix1; ix++) {
          const key = tileKey(iy, ix);
          if (!R.meta.tiles[key]) continue;
          const cLat = (iy + 0.5) * TILE_DEG - 90, cLon = (ix + 0.5) * TILE_DEG - 180;
          const d = Math.hypot((cLat - lat) * 111320, (cLon - lon) * kx, alt) - 600;     // to the tile, roughly
          const lod = d < LR[0] ? 0 : d < LR[1] ? 1 : d < LR[2] ? 2 : -1;
          if (lod < 0) continue;
          const prev = want.get(key);
          if (!prev || lod < prev.lod) want.set(key, { R, lod, d });
        }
      }
      // Everywhere else: the global base pack (near and middle levels only).
      const gReach = Math.sqrt(Math.max(0, LR[1] ** 2 - alt * alt));
      if (gReach > 0) {
        const gLat = gReach / 111320, gLon = Math.min(gReach / kx, 0.4);
        const [gy0, gx0] = tileOf(lat - gLat, lon - gLon), [gy1, gx1] = tileOf(lat + gLat, lon + gLon);
        for (let iy = gy0; iy <= gy1; iy++) for (let ix = gx0; ix <= gx1; ix++) {
          if (this.tileInPack(iy, ix)) continue;
          const key = tileKey(iy, ix);
          let has = this.content.get(key);
          if (has === undefined) { has = this.global.hasContent(iy, ix); if (has !== null) this.content.set(key, has); if (this.content.size > 20000) this.content.clear(); }
          if (!has) continue;
          const cLat = (iy + 0.5) * TILE_DEG - 90, cLon = (ix + 0.5) * TILE_DEG - 180;
          const d = Math.hypot((cLat - lat) * 111320, (cLon - lon) * kx, alt) - 600;
          const lod = d < LR[0] ? 0 : d < LR[1] ? 1 : -1;
          if (lod < 0) continue;
          const prev = want.get(key);
          if (!prev || lod < prev.lod) want.set(key, { R: GLOBAL_R, lod, d });
        }
      }
    };
    consider(cam.lat, cam.lon, cam.alt);
    if (cam.ahead) consider(cam.ahead.lat, cam.ahead.lon, cam.ahead.alt);
    this.trim(want);
    // Nearest first; a few fetches and worker jobs at a time.
    const list = [...want.entries()].sort((a, b) => a[1].d - b[1].d);
    for (const [key, w] of list) {
      let t = this.tiles.get(key);
      if (!t) { t = { key, R: w.R, lod: -1, want: w.lod, group: null, foot: null, pending: false, data: null }; this.tiles.set(key, t); }
      t.want = w.lod; t.d = w.d;
      if (t.pending || t.lod === t.want) continue;
      if (t.retryAt && performance.now() < t.retryAt) continue;        // a failed load waits, then tries again
      if (surfaceWorkers().inflight > 6 || this.fetching > 4) break;
      this.buildTile(t);
    }
  }
  trim(want) {
    for (const [key, t] of this.tiles) {
      if (want.has(key) || t.pending) continue;
      this.dropTile(t);
      this.tiles.delete(key);
    }
  }
  dropTile(t) {
    if (t.group) { t.group.traverse((o) => o.geometry && o.geometry.dispose()); this.group.remove(t.group); t.group = null; }
    this.stats.tiles = this.tiles.size;
  }
  async buildTile(t) {
    t.pending = true;
    const lod = t.want;
    try {
      if (!t.data && t.R.synth) {
        // Global base pack: a synthetic tile (urban fallback, roads, rivers), or nothing.
        this.fetching++;
        try { t.data = await this.global.synthTile(t.key); } finally { this.fetching--; }
        if (!t.data) { t.lod = lod; t.empty = true; return; }
      }
      if (!t.data) {
        this.fetching++;
        try {
          const M = t.R.meta;
          if (M.bundles) {
            // Packed: 5 × 5 tiles per bundle, one request each.
            const [iy, ix] = t.key.split("_").map(Number), sp = M.bundleSpan;
            const b = await fetchBundle(new URL("t/" + Math.floor(iy / sp) + "_" + Math.floor(ix / sp) + ".bin", t.R.dir));
            const g = b.get(t.key);
            if (!g) throw new Error("tile missing from bundle");
            t.data = await gunzip(g);
          } else {
            const r = await fetch(new URL("t/" + t.key + ".bin.gz", t.R.dir));
            if (!r.ok) throw new Error("HTTP " + r.status);
            t.data = await new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
          }
        } finally { this.fetching--; }
      }
      const W = surfaceWorkers();
      W.sync("earth", this.body.getSurface());
      const t0 = performance.now();
      const res = await W.run("city", { key: "earth", tile: t.data.slice(0), opts: { lod, exclude: t.R.meta.exclude, models: this.modelsFor(t.R) },
        priority: 4 + Math.min(3, (t.d || 0) / 7000), stale: () => !this.tiles.has(t.key) || this.tiles.get(t.key).want !== lod });
      this.stats.buildMs += performance.now() - t0; this.stats.built++;
      if (!this.tiles.has(t.key)) return;
      this.install(t, res, lod);
    } catch (e) {
      if (e.message === "stale") return;
      // Retry with backoff (a stalled request or busy server), giving up after a few tries.
      t.fails = (t.fails || 0) + 1;
      console.warn("[space] map tile " + t.key + " failed (" + t.fails + ")", e.message);
      if (t.fails >= 4) { t.lod = t.want; t.failed = true; } else t.retryAt = performance.now() + 2000 * t.fails;
      this.stats.failed = (this.stats.failed || 0) + 1;
    } finally { t.pending = false; }
  }
  install(t, r, lod) {
    const g = new THREE.Group();
    g.userData.origin = r.origin;
    let tris = 0;
    for (const [k, m] of [["buildings", this.mats.b], ["roads", this.mats.r], ["water", this.mats.w]]) {
      if (!r[k]) continue;
      const mesh = new THREE.Mesh(geometry(r[k]), m);
      mesh.renderOrder = k === "roads" ? 1 : 0;
      if (k === "buildings" && lod === 0) mesh.layers.enable(CASTER_LAYER);       // nearby buildings cast shadows
      tris += r[k].index.length / 3;
      g.add(mesh);
    }
    if (t.group) this.dropTile(t);
    t.group = g; t.lod = lod; t.tris = tris;
    t.foot = lod === 0 ? r.foot : null; t.frame = r.frame; t.origin = r.origin; t.statsB = r.stats.buildings; t.statsR = r.stats.roads; t.heightSources = r.stats.heightSources;
    this.group.add(g);
    this.stats.tiles = this.tiles.size;
  }

  // Each frame, after the Earth is placed: same transform as its terrain.
  place(p, quat, s, lightDir, lightCol) {
    this.veg.place(p, quat, s, lightDir, lightCol, this.night || 0);
    for (const m of Object.values(this.mats)) { m.uniforms.uLightDir.value.copy(lightDir); m.uniforms.uLightCol.value.copy(lightCol); m.uniforms.uNight.value = this.night || 0; }
    for (const t of this.tiles.values()) {
      if (!t.group) continue;
      const o = t.origin;
      t.group.position.set(o[0], o[1], o[2]).applyQuaternion(quat).multiplyScalar(s).add(p);
      t.group.quaternion.copy(quat);
      t.group.scale.setScalar(s);
    }
  }
  // 0 by day … 1 at night, from the Sun's height over the camera (windows light up).
  setNight(n) { this.night = n; }
  // Readiness of the local Earth layers around a point (the debug overlay and
  // the landing gate): READY / LOADING / FAILED / NONE per layer.
  status(lat, lon, alt = 0) {
    const packs = this.regionAt(lat, lon);
    const R = packs.length ? this.regions.get(packs[0].id) : null;
    const st = (ok, loading, failed) => (failed ? "FAILED" : ok ? "READY" : loading ? "LOADING" : "NONE");
    let near = 0, nearBuilt = 0, nearPending = 0, nearFailed = 0, buildings = 0, roads = 0, water = 0;
    for (const t of this.tiles.values()) {
      if (t.group || t.empty) { buildings += t.statsB || 0; roads += t.statsR || 0; water += t.group && t.group.children.some((m) => m.material === this.mats.w) ? 1 : 0; }
      if ((t.d || 0) < 1500) { near++; if (t.group || t.empty) nearBuilt++; else if (t.failed) nearFailed++; else nearPending++; }
    }
    const g = this.global.status(lat, lon);
    const v = this.veg.status(lat, lon);
    const mapOk = near > 0 ? nearBuilt >= near * 0.8 : true;
    return {
      lat, lon, region: packs.length ? packs[0].id : "global base", packLoaded: packs.length ? (R && R.loaded ? "YES" : "NO") : "—",
      terrain: R ? st(R.loaded, true, false) : g === "FAILED" ? "FAILED" : "READY",
      imagery: R ? st(R.loaded && R.layers.every((l) => l.tex && l.tex.image), true, false) : g,
      landCover: g,
      water: R ? st(R.loaded, true, false) : g,
      roads: alt > 30000 ? "—" : st(mapOk, nearPending > 0, nearFailed > near * 0.2 && near > 0),
      buildings: alt > 30000 ? "—" : st(mapOk, nearPending > 0, nearFailed > near * 0.2 && near > 0),
      vegetation: v,
      counts: { buildings, roads, waterTiles: water, trees: this.veg.stats.trees || 0, mapTiles: [...this.tiles.values()].filter((t) => t.group).length, globalTiles: [...this.tiles.values()].filter((t) => t.R === GLOBAL_R && t.group).length }
    };
  }
  summary() {
    let b = 0, r = 0, tri = 0, src = [0, 0, 0, 0, 0], lod = [0, 0, 0];
    for (const t of this.tiles.values()) if (t.group) { b += t.statsB || 0; r += t.statsR || 0; tri += t.tris || 0; lod[t.lod]++; (t.heightSources || []).forEach((v, i) => (src[i] += v)); }
    return { tiles: [...this.tiles.values()].filter((t) => t.group).length, lod, buildings: b, roads: r, triangles: tri, heightSources: src,
      regions: [...this.regions.keys()], avgBuildMs: this.stats.built ? +(this.stats.buildMs / this.stats.built).toFixed(1) : 0 };
  }

  // Walking: is this Earth-local point inside a building (below its roof)?
  // local: body-local unit direction {x,y,z} and r (distance from centre).
  blocked(dir, r, refR) {
    const ll = latLon(dir);
    const [iy, ix] = tileOf(ll.lat, ll.lon);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const t = this.tiles.get(tileKey(iy + dy, ix + dx));
      if (!t || !t.foot || !t.foot.top.length) continue;
      const O = t.origin, F = t.frame;
      const px = dir.x * r - O[0], py = dir.y * r - O[1], pz = dir.z * r - O[2];
      const x = px * F.E[0] + py * F.E[1] + pz * F.E[2], y = px * F.N[0] + py * F.N[1] + pz * F.N[2];
      const h = r - refR;
      const f = t.foot;
      for (let i = 0; i < f.top.length; i++) {
        const bb = i * 4;
        if (x < f.bbox[bb] - 0.3 || x > f.bbox[bb + 2] + 0.3 || y < f.bbox[bb + 1] - 0.3 || y > f.bbox[bb + 3] + 0.3) continue;
        if (h > f.top[i]) continue;
        let inside = false;
        for (let a = f.offs[i], b = f.offs[i + 1] - 1, k = a; k < f.offs[i + 1]; b = k++) {
          const xi = f.pts[k * 2], yi = f.pts[k * 2 + 1], xj = f.pts[b * 2], yj = f.pts[b * 2 + 1];
          if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
        if (inside) return true;
      }
    }
    return false;
  }
  // Named places near a point (labels), nearest first.
  nearbyPlaces(lat, lon, maxM, n = 12) {
    const kx = 111320 * Math.cos(lat * D2R);
    return this.places.map((p) => ({ p, d: Math.hypot((p.lat - lat) * 111320, (p.lon - lon) * kx) })).filter((x) => x.d < maxM).sort((a, b) => a.d - b.d).slice(0, n);
  }
  // Start loading what a trip will need before arriving.
  preload(lat, lon) {
    for (const r of this.regionAt(lat, lon, 0.2)) this.load(r.id).then(() => this.update({ lat, lon, alt: 1500 })).catch(() => {});
    // Global base: the bundle, the ground texture, and the map tiles and plants
    // around the destination, so they're in before the craft gets there.
    this.global.update(lat, lon);
    const B = this.global.bundle(bundleKey(lat, lon));
    (B.ready || Promise.resolve()).then(() => this.global.gridAsync(tileName(lat, lon))).then(() => {
      if (!this.inPack(lat, lon)) this.update({ lat, lon, alt: 1500 });
      this.veg.prewarm(lat, lon, this.body.getSurface());
    }).catch(() => {});
  }
  dispose() {
    for (const t of this.tiles.values()) this.dropTile(t);
    this.tiles.clear();
    for (const m of Object.values(this.mats)) m.dispose();
    this.veg.dispose();
    this.global.dispose();
    for (const R of this.regions.values()) for (const l of R.layers || []) if (l.tex) l.tex.dispose();
    this.scene.remove(this.group);
  }
}

