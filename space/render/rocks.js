// Rocks around you on a solid world. Placement runs in the surface workers
// (rock-core.js, on the body's real ground); this module draws them.
//
// Per world a different rock: angular basalt on Mars, sharp impact fragments
// on the Moon and Mercury, volcanic slabs on Venus, ice shards on Europa,
// rounded icy cobbles on Titan, angular ice on Pluto and its neighbours, a
// rock–ice mix on Ceres. Two levels of detail: faceted shapes within ~35 m,
// cheap ones to ~120 m, none beyond. Rocks cast and receive the local sun
// shadows. Larger nearby rocks block walking.
//
// Procedural: no individual rock is mapped at this scale.

import * as THREE from "three";
import { surfaceWorkers } from "./terrain.js";
import { placeRocks, ROCK_RADIUS } from "./rock-core.js";
import { receiveShadows, CASTER_LAYER } from "./shadows.js";

// colour, second colour (tone mix), roughness, faceting, flatness, elongation, max size (m), density
const KINDS = {
  basalt: { c: 0x4a3027, c2: 0x6b4a3a, rough: 0.92, jag: 0.38, flat: 0.75, elong: 1.15, max: 2.2, density: 0.2 },
  lunar: { c: 0x6f6f72, c2: 0x8c8c8e, rough: 0.96, jag: 0.42, flat: 0.68, elong: 1.25, max: 2.6, density: 0.14 },
  mercury: { c: 0x6c655e, c2: 0x857c72, rough: 0.95, jag: 0.4, flat: 0.7, elong: 1.2, max: 2.4, density: 0.14 },
  slab: { c: 0x55504a, c2: 0x6e665c, rough: 0.9, jag: 0.25, flat: 0.32, elong: 1.6, max: 2.8, density: 0.12 },
  shard: { c: 0xc9d6e2, c2: 0xe7eef5, rough: 0.35, jag: 0.5, flat: 0.55, elong: 2.0, max: 1.6, density: 0.06 },
  cobble: { c: 0x6a5845, c2: 0x857055, rough: 0.6, jag: 0.06, flat: 0.8, elong: 1.1, max: 0.5, density: 0.1 },
  ice: { c: 0xd5cec4, c2: 0xece6dc, rough: 0.55, jag: 0.35, flat: 0.7, elong: 1.3, max: 1.8, density: 0.07 },
  mix: { c: 0x4f4f50, c2: 0xa9a9a6, rough: 0.9, jag: 0.33, flat: 0.72, elong: 1.2, max: 2.0, density: 0.12 },
  sulfur: { c: 0x8f7f4a, c2: 0xa8955a, rough: 0.9, jag: 0.3, flat: 0.6, elong: 1.3, max: 1.6, density: 0.08 }
};
const BODY_KIND = { mars: "basalt", venus: "slab", moon: "lunar", mercury: "mercury", ceres: "mix", vesta: "lunar",
  titan: "cobble", io: "sulfur", pluto: "ice", charon: "ice", triton: "ice", europa: "shard", enceladus: "shard", ganymede: "ice",
  callisto: "lunar", mimas: "ice", tethys: "ice", dione: "ice", rhea: "ice", iapetus: "lunar", phobos: "lunar", deimos: "lunar" };
const N_SHAPES = 3, NEAR = 35;
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();

function hash(a) { let h = Math.imul(a | 0, 0x9e3779b9); h ^= h >>> 15; return (h >>> 0) / 4294967296; }

export class RockField {
  constructor(scene, body, kindName, quality) {
    const K = this.K = KINDS[kindName] || KINDS.lunar;
    this.body = body; this.scene = scene;
    this.density = K.density * ((quality && quality.rockDensity) || 1);
    this.group = new THREE.Group();
    this.mat = receiveShadows(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: K.rough, metalness: 0, flatShading: K.jag > 0.15 }));
    this.sets = [];
    const c1 = new THREE.Color(K.c), c2 = new THREE.Color(K.c2);
    this.c1 = c1; this.c2 = c2;
    for (const detail of [K.jag > 0.15 ? 1 : 2, 0]) {
      const meshes = [];
      for (let s = 0; s < N_SHAPES; s++) {
        const g = new THREE.IcosahedronGeometry(1, detail);
        const p = g.attributes.position;
        for (let i = 0; i < p.count; i++) {
          const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
          const k = 1 + K.jag * (hash(Math.round(x * 97) * 131 + Math.round(y * 89) * 7 + Math.round(z * 83) + s * 9973) - 0.5) * 2;
          p.setXYZ(i, x * k * K.elong * (1 + 0.2 * (s - 1)), y * k * K.flat, z * k);
        }
        g.computeVertexNormals();
        const m = new THREE.InstancedMesh(g, this.mat, 900);
        m.count = 0; m.frustumCulled = false;
        m.layers.enable(CASTER_LAYER);
        this.group.add(m); meshes.push(m);
      }
      this.sets.push(meshes);
    }
    this.group.visible = false;
    scene.add(this.group);
    this.anchor = null; this.pending = false; this.blockers = [];
  }
  // camDir: body-local unit direction of the camera; alt: height above ground.
  update(surf, camDir, alt) {
    const show = alt < 400;
    this.group.visible = show && !!this.anchor;
    if (!show) return;
    const lat = Math.asin(Math.max(-1, Math.min(1, camDir[1]))), lon = Math.atan2(-camDir[2], camDir[0]);
    this.cam = camDir;
    if (this.pending) return;
    if (this.anchor && Math.hypot(lat - this.anchor.lat, (lon - this.anchor.lon) * Math.cos(lat)) * surf.R < 15) { this.relod(); return; }
    this.pending = true;
    const style = { density: this.density, max: this.K.max, flat: this.K.flat };
    const W = surfaceWorkers();
    W.sync(this.body.def.id, surf);
    W.run("rocks", { key: this.body.def.id, lat, lon, style, priority: 0 }).then((r) => {
      this.pending = false;
      if (this.disposed) return;
      this.anchor = { lat, lon, origin: r.origin }; this.rocks = r.rocks;
      this.group.visible = true;
      this.relod(true);
    }, () => { this.pending = false; });
  }
  // Split rocks into the near (faceted) and far (cheap) sets by distance to
  // the camera; rebuild the collision list of larger nearby rocks.
  relod(force) {
    if (!this.rocks || !this.cam) return;
    // The camera on the ground's own radius, not the reference sphere: in a
    // deep basin (Gale, −4.5 km) the two differ by more than ROCK_RADIUS.
    const o = this.anchor.origin, R = Math.hypot(o[0], o[1], o[2]);
    const cx = this.cam[0] * R - o[0], cy = this.cam[1] * R - o[1], cz = this.cam[2] * R - o[2];
    if (!force && this.lastCam && Math.hypot(cx - this.lastCam[0], cy - this.lastCam[1], cz - this.lastCam[2]) < 4) return;
    this.lastCam = [cx, cy, cz];
    const counts = [[0, 0, 0], [0, 0, 0]], m4 = _m, rr = this.rocks;
    this.blockers.length = 0;
    for (let k = 0; k < rr.length; k += 10) {
      const x = rr[k], y = rr[k + 1], z = rr[k + 2], size = rr[k + 3], s = rr[k + 9 - 1] | 0, tone = rr[k + 9];
      const d = Math.hypot(x - cx, y - cy, z - cz);
      if (d > ROCK_RADIUS) continue;
      const set = d < NEAR ? 0 : 1, mesh = this.sets[set][s];
      if (counts[set][s] >= 900) continue;
      _q.set(rr[k + 4], rr[k + 5], rr[k + 6], rr[k + 7]);
      mesh.setMatrixAt(counts[set][s], m4.compose(_p.set(x, y, z), _q, _s.setScalar(size)));
      mesh.setColorAt(counts[set][s], _c.copy(this.c1).lerp(this.c2, tone));
      counts[set][s]++;
      if (size > 0.45 && d < 40) this.blockers.push([x, y, z, size * this.K.elong * 0.8, size * this.K.flat]);
    }
    this.sets.forEach((meshes, set) => meshes.forEach((m, s) => { m.count = counts[set][s]; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }));
  }
  // Walking: is a body-frame point inside a larger rock (below its top)?
  blocked(p) {
    if (!this.anchor) return false;
    const o = this.anchor.origin;
    for (const [x, y, z, r, h] of this.blockers) {
      const dx = p[0] - o[0] - x, dy = p[1] - o[1] - y, dz = p[2] - o[2] - z;
      if (Math.hypot(dx, dy, dz) < r + 0.2) return true;     // the walker's ~0.2 m body radius
    }
    return false;
  }
  // Same transform as the terrain chunks: body-local origin → render space.
  place(p, quat, s) {
    if (!this.group.visible || !this.anchor) return;
    const o = this.anchor.origin;
    this.group.position.set(o[0], o[1], o[2]).applyQuaternion(quat).multiplyScalar(s).add(p);
    this.group.quaternion.copy(quat);
    this.group.scale.setScalar(s);
  }
  dispose() { this.disposed = true; this.sets.flat().forEach((m) => m.geometry.dispose()); this.mat.dispose(); this.scene.remove(this.group); }
}
export function rockKind(id) { return BODY_KIND[id] || null; }
export { placeRocks };
