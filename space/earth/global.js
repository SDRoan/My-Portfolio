// The global Earth base layer: what every place on Earth has, with or without
// a detailed region pack (scripts/earth/build-global.mjs).
//
//   land cover   ESA WorldCover 2021 classes and water share per 1/120°
//                cell (≈ 925 m): colours and textures the ground near the
//                camera (terrain shader), draws shorelines, lakes and wide
//                rivers, and drives the global vegetation (vegetation.js)
//   lines        Natural Earth major roads and rivers
//   urban        in built-up land cover, procedural low-detail blocks and
//                streets (global-core.js) — labelled as such, never as mapped
//
// Detailed region packs override all of it inside their boxes.
// Bundles are 15° × 15° (one request each), cached; tiles decode on demand.

import * as THREE from "three";
import { fetchBundle, gunzip } from "../engine/packs.js";
import { surfaceWorkers } from "../render/terrain.js";
import { GLOBAL_CELL, GLOBAL_TILE, GLOBAL_BUNDLE, tileName, bundleKey, decodeLines } from "./global-format.js";
import { TILE_DEG, tileBounds, tileKey } from "./tile-format.js";

const BASE = new URL("../data/earth/global/", import.meta.url);
const N = Math.round(GLOBAL_TILE / GLOBAL_CELL);          // 360
const OCEAN = (8 << 4) | (3 << 2), ICE = 7 << 4;

async function decodeWebpByte(bytes) {
  const bmp = await createImageBitmap(new Blob([bytes], { type: "image/webp" }), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const cv = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(bmp.width, bmp.height) : Object.assign(document.createElement("canvas"), { width: bmp.width, height: bmp.height });
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data, out = new Uint8Array(bmp.width * bmp.height);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4];
  bmp.close && bmp.close();
  return out;
}

export class GlobalEarth {
  constructor() {
    this.index = null; this.failed = null;
    this.bundles = new Map();          // key → { status, entries, lines, grid index }
    this.grids = new Map();            // tile name → Uint8Array 360² | promise
    this.synth = new Map();            // map tile key → Promise<ArrayBuffer|null>
    this.tex = null; this.texAt = null; this.texPending = false;
    this.stats = { bundles: 0, tiles: 0, synth: 0, synthBuildings: 0, failed: 0 };
  }
  async init() {
    try { this.index = await (await fetch(new URL("index.json", BASE))).json(); }
    catch (e) { this.failed = e.message; console.warn("[space] no global Earth pack", e.message); this.index = { bundles: {} }; }
    return this.index;
  }
  // ── bundles and tiles ──
  bundle(key) {
    let B = this.bundles.get(key);
    if (B) return B;
    B = { status: "none", key };
    this.bundles.set(key, B);
    if (!this.index || !this.index.bundles[key]) return B;              // open ocean (or no data)
    B.status = "loading";
    B.ready = fetchBundle(new URL("b" + key + ".bin", BASE)).then(async (map) => {
      B.map = map;
      const v = map.get("vec");
      B.lines = v ? decodeLines(new Uint8Array(await gunzip(v))) : [];
      // Lines by 0.05° cell, for quick lookup per map tile.
      B.lineIx = new Map();
      B.lines.forEach((l, li) => {
        const seen = new Set();
        for (let k = 0; k < l.pts.length; k += 2) {
          const c = Math.floor(l.pts[k] / 0.05) + ":" + Math.floor(l.pts[k + 1] / 0.05);
          if (!seen.has(c)) { seen.add(c); if (!B.lineIx.has(c)) B.lineIx.set(c, []); B.lineIx.get(c).push(li); }
        }
      });
      B.status = "ready"; this.stats.bundles++;
      return B;
    }).catch((e) => {
      B.status = "failed"; B.error = e.message; this.stats.failed++;
      console.warn("[space] global bundle " + key + " failed", e.message);
      // Try again later (a dropped connection shouldn't blank a region for the session).
      const tries = (this.tries = this.tries || new Map()).get(key) || 0;
      if (tries < 3) setTimeout(() => {
        this.tries.set(key, tries + 1);
        if (this.bundles.get(key) === B) this.bundles.delete(key);
        for (const [n, g] of this.grids) if (!(g instanceof Uint8Array)) this.grids.delete(n);
        this.texAt = null;
      }, 3000 * (tries + 1));
      return B;
    });
    return B;
  }
  // The 360² grid of a 3° tile: Uint8Array, OCEAN/ICE fill where WorldCover has no tile, or null while loading.
  grid(name) {
    const g = this.grids.get(name);
    if (g instanceof Uint8Array) return g;
    if (g) return null;
    const la = (name[0] === "N" ? 1 : -1) * +name.slice(1, 3), lo = (name[3] === "E" ? 1 : -1) * +name.slice(4, 7);
    const B = this.bundle(bundleKey(la + 0.5, lo + 0.5));
    if (B.status === "none") { const f = new Uint8Array(N * N).fill(la < -60 ? ICE : OCEAN); this.grids.set(name, f); return f; }
    this.grids.set(name, (B.ready || Promise.resolve()).then(async () => {
      let out;
      const e = B.map && B.map.get("lc/" + name);
      if (!e) out = new Uint8Array(N * N).fill(la < -60 ? ICE : OCEAN);
      else if (e[0] === 87) out = await decodeWebpByte(e.subarray(1));          // "W"
      else out = new Uint8Array(await gunzip(e.subarray(1)));                    // "G"
      this.grids.set(name, out); this.stats.tiles++;
      return out;
    }).catch((err) => { this.grids.delete(name); throw err; }));
    return null;
  }
  async gridAsync(name) { const g = this.grid(name); return g || this.grids.get(name); }
  // Byte at a point (degrees), or -1 if not loaded.
  sample(lat, lon) {
    const g = this.grid(tileName(lat, lon));
    if (!g) return -1;
    const la0 = Math.floor(lat / GLOBAL_TILE) * GLOBAL_TILE, lo0 = Math.floor(lon / GLOBAL_TILE) * GLOBAL_TILE;
    const x = Math.min(N - 1, Math.floor((lon - lo0) / GLOBAL_CELL)), y = Math.min(N - 1, Math.floor((la0 + GLOBAL_TILE - lat) / GLOBAL_CELL));
    return g[y * N + x];
  }
  // Readiness of the base layer around a point.
  status(lat, lon) {
    if (this.failed) return "FAILED";
    const B = this.bundle(bundleKey(lat, lon));
    if (B.status === "failed") return "FAILED";
    if (B.status === "loading") return "LOADING";
    return this.grid(tileName(lat, lon)) ? "READY" : "LOADING";
  }

  // A window of cells (padding pad cells) around a 0.01° map tile, as a
  // vegetation grid: class << 4 | canopy density (0–15).
  vegGrid(iy, ix, pad = 3) {
    const b = tileBounds(iy, ix), C = GLOBAL_CELL;
    const west = Math.floor(b.west / C) * C - pad * C, north = Math.ceil(b.north / C) * C + pad * C;
    const W = Math.round((Math.ceil(b.east / C) * C + pad * C - west) / C), H = Math.round((north - (Math.floor(b.south / C) * C - pad * C)) / C);
    const data = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const v = this.sample(north - (y + 0.5) * C, west + (x + 0.5) * C);
      if (v < 0) return null;
      // Canopy density by class (the global pack has no canopy layer): closed
      // canopy where WorldCover says tree cover, scattered trees in open land.
      const cls = v >> 4;
      data[y * W + x] = (cls << 4) | ([0, 11, 3, 2, 1, 2, 0, 0, 0, 2, 12, 1][cls] || 0);
    }
    return { data, W, H, west, north, south: north - H * C, east: west + W * C, cell: C };
  }
  // Roads and rivers near a map tile (from the bundle's line index).
  linesNear(iy, ix) {
    const b = tileBounds(iy, ix), B = this.bundle(bundleKey((b.south + b.north) / 2, (b.west + b.east) / 2));
    if (B.status !== "ready") return B.status === "none" ? [] : null;
    const ids = new Set();
    for (let la = Math.floor((b.south - 0.02) / 0.05); la <= Math.floor((b.north + 0.02) / 0.05); la++)
      for (let lo = Math.floor((b.west - 0.02) / 0.05); lo <= Math.floor((b.east + 0.02) / 0.05); lo++)
        for (const i of B.lineIx.get(la + ":" + lo) || []) ids.add(i);
    // Only the points near this tile (the tile format reaches ±2 tiles).
    const m = 1.5 * TILE_DEG, out = [];
    for (const i of ids) {
      const l = B.lines[i], p = l.pts;
      let cur = null;
      for (let k = 0; k < p.length; k += 2) {
        const inside = p[k] > b.south - m && p[k] < b.north + m && p[k + 1] > b.west - m && p[k + 1] < b.east + m;
        if (inside) { if (!cur) { cur = []; if (k) cur.push(p[k - 2], p[k - 1]); } cur.push(p[k], p[k + 1]); }
        else if (cur) { cur.push(p[k], p[k + 1]); out.push({ kind: l.kind, width: l.width, pts: cur }); cur = null; }
      }
      if (cur && cur.length > 2) out.push({ kind: l.kind, width: l.width, pts: cur });
    }
    return out;
  }
  // Is there anything to build in a map tile (built-up cells nearby, or a road or river)?
  hasContent(iy, ix) {
    const g = this.vegGrid(iy, ix, 1);
    if (!g) return null;
    for (const v of g.data) if (v >> 4 === 5) return true;
    const L = this.linesNear(iy, ix);
    return L === null ? null : L.length > 0;
  }
  // The synthetic map tile (OSM1 format: procedural urban blocks, Natural Earth
  // roads and rivers) for a map tile, built in a worker; null if empty.
  synthTile(key) {
    if (this.synth.has(key)) return this.synth.get(key);
    const [iy, ix] = key.split("_").map(Number);
    const p = (async () => {
      const b = tileBounds(iy, ix);
      await this.gridAsync(tileName(b.south, b.west)); await this.gridAsync(tileName(b.north - 1e-9, b.east - 1e-9));
      await this.gridAsync(tileName(b.south - 0.03, b.west - 0.03)); await this.gridAsync(tileName(b.north + 0.03, b.east + 0.03));
      const B = this.bundle(bundleKey((b.south + b.north) / 2, (b.west + b.east) / 2)); if (B.ready) await B.ready;
      const grid = this.vegGrid(iy, ix, 4), lines = this.linesNear(iy, ix) || [];
      if (!grid) return null;
      const r = await surfaceWorkers().run("synth", { key: "earth", args: { key, grid, lines }, priority: 3 });
      this.stats.synth++;
      if (r) this.stats.synthBuildings += r.buildings;
      return r ? r.tile : null;
    })().catch((e) => { this.synth.delete(key); throw e; });
    this.synth.set(key, p);
    if (this.synth.size > 600) this.synth.delete(this.synth.keys().next().value);
    return p;
  }

  // ── the land-cover texture around the camera (3 × 3 tiles, 1080²) ──
  update(lat, lon) {
    const la0 = Math.floor(lat / GLOBAL_TILE) * GLOBAL_TILE, lo0 = Math.floor(lon / GLOBAL_TILE) * GLOBAL_TILE;
    // Re-centre when the camera is within 0.5° of the window's edge.
    if (this.texAt && Math.abs(lat - (this.texAt.la0 + 4.5)) < 2.5 && Math.abs(lon - (this.texAt.lo0 + 4.5)) < 2.5 && this.texAt.ok) return;
    if (this.texPending) return;
    const names = [];
    for (let j = 1; j >= -1; j--) for (let i = -1; i <= 1; i++) names.push(tileName(la0 + j * GLOBAL_TILE + 0.5, lo0 + i * GLOBAL_TILE + 0.5));
    this.texPending = true;
    Promise.all(names.map((n) => this.gridAsync(n))).then((gs) => {
      const S = 3 * N;
      if (!this.tex) {
        this.tex = new THREE.DataTexture(new Uint8Array(S * S), S, S, THREE.RedFormat, THREE.UnsignedByteType);
        this.tex.magFilter = this.tex.minFilter = THREE.NearestFilter; this.tex.generateMipmaps = false; this.tex.unpackAlignment = 1;
      }
      const d = this.tex.image.data;
      gs.forEach((g, k) => {
        const tx = k % 3, ty = Math.floor(k / 3);
        for (let y = 0; y < N; y++) d.set(g.subarray(y * N, y * N + N), (ty * N + y) * S + tx * N);
      });
      this.tex.needsUpdate = true;
      this.texAt = { la0: la0 - GLOBAL_TILE, lo0: lo0 - GLOBAL_TILE, ok: true };
    }).catch((e) => { console.warn("[space] global land cover unavailable here", e.message); this.texAt = { la0: la0 - GLOBAL_TILE, lo0: lo0 - GLOBAL_TILE, ok: false }; })
      .finally(() => { this.texPending = false; });
  }
  applyTexture(mat) {
    const u = mat.uniforms;
    if (!u.uLc) return;
    const on = !!(this.tex && this.texAt && this.texAt.ok);
    u.uLcOn.value = on ? 1 : 0;
    if (!on) return;
    const D = Math.PI / 180, a = this.texAt;
    u.uLc.value = this.tex;
    u.uLcB.value.set(a.la0 * D, a.lo0 * D, (a.la0 + 3 * GLOBAL_TILE) * D, (a.lo0 + 3 * GLOBAL_TILE) * D);
    u.uLcSize.value.set(3 * N, 3 * N);
  }
  dispose() { if (this.tex) this.tex.dispose(); }
}
export { tileKey };
