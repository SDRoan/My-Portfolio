// Chunked terrain for every solid body, used when you descend close. Chunk
// geometry is computed in the surface workers (surface-core.js buildChunk).
//
// A cube-sphere: six faces, each a quadtree. Near the camera nodes split into
// finer chunks; far away they merge back. Every vertex sits at the body's real
// surface radius from universe/surfaces.js — reference ellipsoid + real
// elevation (ETOPO 2022 / LOLA / MOLA) where it exists, procedural relief
// where it doesn't — so the ground you land on is the ground collision uses.
// Chunk vertices are stored relative to the chunk's own centre, so metre-scale
// detail stays precise in float32. Skirts hide cracks between levels.

import * as THREE from "three";
import { planetMaterial } from "./materials.js";
import { CASTER_LAYER } from "./shadows.js";
import { faceDir, buildChunk } from "../universe/surface-core.js";
import { SurfaceWorkers } from "../engine/surface-workers.js";

// One pool of surface workers for every body (created on first use).
let pool = null;
export function surfaceWorkers() { return pool || (pool = new SurfaceWorkers(Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 4) - 2)))); }
export function disposeSurfaceWorkers() { if (pool) pool.dispose(); pool = null; }

export class Terrain {
  // look: the body's shader options; surface: its Surface (shape + elevation).
  constructor(scene, look, surface, quality, key) {
    this.scene = scene;
    this.surface = surface;
    this.key = key || "body";
    this.R = surface.R;
    this.res = quality.chunkRes;
    this.maxDepth = quality.terrainDepth;
    this.chunks = 0; this.triangles = 0;
    this.mat = planetMaterial(Object.assign({}, look, { terrain: true, bump: quality.bump }));
    this.mat.uniforms.uDetail.value = 3;
    this.roots = [0, 1, 2, 3, 4, 5].map((i) => ({ face: i, level: 0, u0: 0, u1: 1, v0: 0, v1: 1, kids: null, mesh: null }));
    this.queue = [];
    this.leaves = [];
    this.version = surface.version;
    this.buildMs = 0; this.built = 0;
  }

  radiusAt(dx, dy, dz, detail = 2) { return this.surface.radiusAt(dx, dy, dz, detail); }

  // camLocal: camera in the planet's own frame (metres). Returns true once
  // the whole sphere is covered, so the caller can hide its plain sphere.
  update(camLocal, budget = 2) {
    const W = surfaceWorkers();
    W.sync(this.key, this.surface);
    // New data (a regional patch, say): every chunk is stale; old ones stay
    // on screen until their replacements arrive.
    if (this.surface.version !== this.version) {
      // New tiles or patches: rebuild only the chunks they touch; anything
      // else (a new grid, exaggeration): every chunk is stale.
      const since = (this.surface.log || []).filter((e) => e.v > this.version);
      if (since.length === this.surface.version - this.version) for (const e of since) this.invalidate(e.b || e.p.b);
      else this.gen = (this.gen || 0) + 1;
      this.version = this.surface.version;
    }
    this.leaves.length = 0;
    for (const r of this.roots) this.visit(r, camLocal);
    // Build the nearest missing (then stale) chunks first, in the workers.
    this.queue.sort((a, b) => (a.stale - b.stale) || (a.d - b.d));
    const cap = Math.max(4, budget);
    while (this.queue.length && W.inflight < cap) {
      const q = this.queue.shift();
      if (q.node.dead || q.node.pending) continue;
      q.node.dist = q.d;
      this.request(q.node);
    }
    this.queue.length = 0;
    this.cullHorizon(camLocal);
    return this.roots.every((r) => this.covered(r));
  }

  // Hide chunks that lie wholly beyond the horizon. The occluder is a sphere
  // inside the lowest possible ground; a chunk is hidden only when nine
  // points over it (corners, edge midpoints, centre), lifted to the highest
  // possible ground, are all behind that sphere as seen from the camera.
  cullHorizon(cam) {
    const [lo, hi] = this.surface.heightRange(), a = this.surface.axes;
    const r0 = this.R * Math.min(a[0], a[1], a[2]) + lo, rTop = this.R * Math.max(a[0], a[1], a[2]) + hi;
    if (!(r0 > 0)) return;
    const vx = cam[0] / r0, vy = cam[1] / r0, vz = cam[2] / r0;
    const vc2 = vx * vx + vy * vy + vz * vz - 1;
    if (vc2 <= 0) return;
    const k = rTop / r0;
    let culled = 0;
    for (const n of this.leaves) {
      if (!n.mesh || !n.mesh.visible) continue;
      const pts = n.hpts || (n.hpts = [0, 0.5, 1].flatMap((fu) => [0, 0.5, 1].map((fv) => this.dirAt(n.face, n.u0 + (n.u1 - n.u0) * fu, n.v0 + (n.v1 - n.v0) * fv))));
      let hidden = true;
      for (const d of pts) {
        const tx = d[0] * k - vx, ty = d[1] * k - vy, tz = d[2] * k - vz;
        const t = -(tx * vx + ty * vy + tz * vz);
        if (!(t > vc2 && (t * t) / (tx * tx + ty * ty + tz * tz) > vc2)) { hidden = false; break; }
      }
      if (hidden) { n.mesh.visible = false; culled++; }
    }
    this.culled = culled;
  }

  // Mark chunks overlapping a lat/lon box (degrees) for rebuilding.
  invalidate(b) {
    const walk = (n) => {
      if (n.level >= 2) {
        const bb = n.llb || (n.llb = this.llBox(n));
        if (bb && (bb.n < b.south || bb.s > b.north || (!bb.wrap && (bb.e < b.west || bb.w > b.east)))) return;
      }
      if (n.mesh) n.dirty = true;
      if (n.kids) n.kids.forEach(walk);
    };
    this.roots.forEach(walk);
  }
  // Latitude/longitude extent of a chunk from nine points over it (with a
  // little slack); wrap = it straddles ±180° or a pole.
  llBox(n) {
    let s = 90, no = -90, w = 180, e = -180;
    for (const fu of [0, 0.5, 1]) for (const fv of [0, 0.5, 1]) {
      const d = this.dirAt(n.face, n.u0 + (n.u1 - n.u0) * fu, n.v0 + (n.v1 - n.v0) * fv);
      const la = Math.asin(Math.max(-1, Math.min(1, d[1]))) * 180 / Math.PI, lo = Math.atan2(-d[2], d[0]) * 180 / Math.PI;
      s = Math.min(s, la); no = Math.max(no, la); w = Math.min(w, lo); e = Math.max(e, lo);
    }
    const pad = (no - s) * 0.25 + 0.05;
    return { s: s - pad, n: no + pad, w: w - pad, e: e + pad, wrap: e - w > 180 || no > 85 || s < -85 };
  }

  covered(n) { return n.kids ? n.kids.every((k) => this.covered(k)) || !!n.mesh : !!n.mesh; }

  visit(n, cam) {
    const c = this.nodeCenter(n);
    const size = this.R * 1.6 / (1 << n.level);
    const d = Math.hypot(cam[0] - c[0], cam[1] - c[1], cam[2] - c[2]);
    const wantSplit = n.level < this.maxDepth && d < size * 1.8;
    if (wantSplit) {
      if (!n.kids) {
        const um = (n.u0 + n.u1) / 2, vm = (n.v0 + n.v1) / 2;
        n.kids = [[n.u0, um, n.v0, vm], [um, n.u1, n.v0, vm], [n.u0, um, vm, n.v1], [um, n.u1, vm, n.v1]]
          .map(([u0, u1, v0, v1]) => ({ face: n.face, level: n.level + 1, u0, u1, v0, v1, kids: null, mesh: null }));
      }
      const ready = n.kids.every((k) => this.covered(k));
      for (const k of n.kids) this.visit(k, cam);
      // Keep the parent on screen until every child can replace it, and keep
      // half-built children hidden meanwhile so the two never overlap.
      if (n.mesh) n.mesh.visible = !ready || !n.kids.every((k) => this.covered(k));
      if (n.mesh && n.mesh.visible) n.kids.forEach((k) => this.hide(k));
      if (!ready) { if (!n.mesh) this.queue.push({ node: n, d, stale: 0 }); else { this.leaves.push(n); if (n.gen !== this.gen || n.dirty) this.queue.push({ node: n, d, stale: 1 }); } }
    } else {
      if (n.kids) { n.kids.forEach((k) => this.drop(k)); n.kids = null; }
      if (!n.mesh) this.queue.push({ node: n, d, stale: 0 });
      else { n.mesh.visible = true; this.leaves.push(n); if (n.gen !== this.gen || n.dirty) this.queue.push({ node: n, d, stale: 1 }); }
    }
  }

  hide(n) { if (n.mesh) n.mesh.visible = false; if (n.kids) n.kids.forEach((k) => this.hide(k)); }

  drop(n) {
    n.dead = true;
    if (n.kids) n.kids.forEach((k) => this.drop(k));
    if (n.mesh) { this.chunks--; this.triangles -= n.mesh.geometry.index.count / 3; n.mesh.geometry.dispose(); this.scene.remove(n.mesh); n.mesh = null; }
  }

  dirAt(face, u, v) { return faceDir(face, u, v); }
  nodeCenter(n) {
    const d = this.dirAt(n.face, (n.u0 + n.u1) / 2, (n.v0 + n.v1) / 2);
    const r = this.radiusAt(d[0], d[1], d[2], 0);
    return [d[0] * r, d[1] * r, d[2] * r];
  }

  // Ask a worker for this node's geometry; swap it in when it arrives.
  request(n) {
    n.pending = true;
    n.dirty = false;                                // a change arriving while this builds marks it again
    const gen = this.gen, t0 = performance.now();
    const node = { face: n.face, level: n.level, u0: n.u0, u1: n.u1, v0: n.v0, v1: n.v1 };
    // Nearest chunks first; dropped unbuilt if merged away before its turn.
    const pr = 1 + Math.min(3, (n.dist || 0) / 50000);
    surfaceWorkers().run("chunk", { key: this.key, node, res: this.res, priority: pr, stale: () => n.dead || this.disposed }).then((r) => {
      n.pending = false;
      if (n.dead || this.disposed) return;
      this.buildMs += performance.now() - t0; this.built++;
      this.install(n, r, gen);
    }, (e) => { n.pending = false; if (e.message !== "stale") console.warn("[space] terrain chunk failed", e.message); });
  }
  // Synchronous build (tests, or no workers).
  build(n) { this.install(n, buildChunk(this.surface, n, this.res), this.gen); }
  install(n, r, gen) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(r.P, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(r.N, 3));
    geo.setAttribute("aDir", new THREE.BufferAttribute(r.D, 3));
    geo.setAttribute("aElev", new THREE.BufferAttribute(r.E, 1));
    geo.setAttribute("aBase", new THREE.BufferAttribute(r.B, 3));
    geo.setIndex(new THREE.BufferAttribute(r.index, 1));
    geo.computeBoundingSphere();
    if (n.mesh) {                                   // a stale chunk: replace its geometry in place
      this.triangles -= n.mesh.geometry.index.count / 3;
      n.mesh.geometry.dispose();
      n.mesh.geometry = geo;
    } else {
      n.mesh = new THREE.Mesh(geo, this.mat);
      n.mesh.layers.enable(CASTER_LAYER);           // terrain shadows terrain (local cascades only)
      n.mesh.visible = false;                       // visit() decides next frame
      this.chunks++;
      this.scene.add(n.mesh);
    }
    // Chunk-relative vertices with a computed bounding sphere: culls correctly.
    n.mesh.userData.origin = r.origin;
    n.gen = gen;
    this.triangles += r.index.length / 3;
  }

  // Place every live chunk for this frame: planet at render position p (already
  // depth-compressed by s), oriented by quat.
  place(p, quat, s, lightDir, lightCol, timeSec, debugTint) {
    const u = this.mat.uniforms;
    if (u.uDebug) u.uDebug.value.set(...(debugTint || [1, 1, 1]));
    u.uLightDir.value.copy(lightDir);
    u.uLightCol.value.copy(lightCol);
    u.uTime.value = timeSec;
    const all = (n) => {
      if (n.mesh) {
        const o = n.mesh.userData.origin;
        _v.set(o[0], o[1], o[2]).applyQuaternion(quat).multiplyScalar(s).add(p);
        n.mesh.position.copy(_v);
        n.mesh.quaternion.copy(quat);
        n.mesh.scale.setScalar(s);
      }
      if (n.kids) n.kids.forEach(all);
    };
    this.roots.forEach(all);
  }
  setVisible(v) { const all = (n) => { if (n.mesh && !v) n.mesh.visible = false; if (n.kids) n.kids.forEach(all); }; this.roots.forEach(all); }
  dispose() { this.disposed = true; this.roots.forEach((r) => this.drop(r)); this.mat.dispose(); }
}
const _v = new THREE.Vector3();
