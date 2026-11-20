// The player's spacecraft: an original interceptor, built entirely here from
// lofted custom geometry — no external model.
//
//   root                    placed every frame (camera-relative, metres)
//   ├─ visual               banks with turns; holds the merged hull meshes
//   │   ├─ hull meshes      one merged mesh per material
//   │   ├─ engine cores     recessed white-blue discs (additive shader)
//   │   ├─ plumes           short cyan plasma plumes (additive shader)
//   │   └─ nav lights       port red, starboard green, tail white
//   ├─ cockpitAnchor        pilot's eye, inside the canopy
//   ├─ chaseAnchor          reference for the chase camera
//   └─ debug                F5: bounds, forward vector, anchors
//
// Coordinates: forward is −Z (the flight controller's forward), +Y up, +X
// starboard. About 32 m long, 23 m across the wings, 5.5 m tall. Every side
// part is built for starboard and mirrored, so the craft is exactly symmetric.

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { Cockpit, EYE } from "./cockpit.js";

export const LENGTH = 32;

// ── geometry helpers ──

// Loft: connect rings of points (same count each) into a solid, with optional
// fan caps. Winding is fixed by the sign of the volume, so faces point outward.
function loft(rings, { capStart = true, capEnd = true } = {}) {
  const n = rings[0].length, pos = [];
  rings.forEach((r) => r.forEach((p) => pos.push(p[0], p[1], p[2])));
  const idx = [];
  for (let s = 0; s < rings.length - 1; s++) {
    for (let i = 0; i < n; i++) {
      const a = s * n + i, b = s * n + ((i + 1) % n), c = (s + 1) * n + i, d = (s + 1) * n + ((i + 1) % n);
      idx.push(a, c, b, b, c, d);
    }
  }
  const cap = (ring, base, flip) => {
    const cx = ring.reduce((t, p) => t + p[0], 0) / n, cy = ring.reduce((t, p) => t + p[1], 0) / n, cz = ring.reduce((t, p) => t + p[2], 0) / n;
    const ci = pos.length / 3;
    pos.push(cx, cy, cz);
    for (let i = 0; i < n; i++) {
      const a = base + i, b = base + ((i + 1) % n);
      if (flip) idx.push(ci, b, a); else idx.push(ci, a, b);
    }
  };
  if (capStart) cap(rings[0], 0, false);
  if (capEnd) cap(rings[rings.length - 1], (rings.length - 1) * n, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  // Open tubes have no meaningful volume; orient them by the outward test instead.
  const closed = capStart && capEnd;
  if (closed ? signedVolume(g) < 0 : inwardTube(g, rings)) flipWinding(g);
  return g.toNonIndexed();                    // flat facets: crisp hard-surface edges
}
function signedVolume(g) {
  const p = g.attributes.position.array, ix = g.index.array;
  let v = 0;
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i] * 3, b = ix[i + 1] * 3, c = ix[i + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v;
}
// For an open tube: does the first face's normal point toward the ring's axis?
function inwardTube(g, rings) {
  const p = g.attributes.position.array, ix = g.index.array;
  const A = new THREE.Vector3(p[ix[0] * 3], p[ix[0] * 3 + 1], p[ix[0] * 3 + 2]);
  const B = new THREE.Vector3(p[ix[1] * 3], p[ix[1] * 3 + 1], p[ix[1] * 3 + 2]);
  const C = new THREE.Vector3(p[ix[2] * 3], p[ix[2] * 3 + 1], p[ix[2] * 3 + 2]);
  const nrm = new THREE.Vector3().crossVectors(B.clone().sub(A), C.clone().sub(A));
  const r = rings[0], cen = new THREE.Vector3();
  r.forEach((q) => cen.add(new THREE.Vector3(q[0], q[1], q[2])));
  cen.divideScalar(r.length);
  return nrm.dot(A.clone().sub(cen)) < 0;
}
function flipWinding(g) {
  const ix = g.index.array;
  for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; }
}
// Mirror a starboard part to port (x → −x), keeping faces outward.
function mirrored(g) {
  const m = g.clone();
  m.scale(-1, 1, 1);
  const p = m.attributes.position.array;
  for (let i = 0; i < p.length; i += 9) {                // non-indexed: swap 2nd and 3rd vertex
    for (let k = 0; k < 3; k++) { const t = p[i + 3 + k]; p[i + 3 + k] = p[i + 6 + k]; p[i + 6 + k] = t; }
  }
  return m;
}
const both = (g) => [g, mirrored(g)];

// Fuselage cross-section at station z: chined, flat-bottomed, ridged top.
function hullRing(z, w, top, bot, dy = 0) {
  const yc = -0.06 * (top + bot) + dy;
  return [
    [0, top + dy, z], [w * 0.42, top * 0.92 + dy, z], [w * 0.82, top * 0.55 + dy, z], [w, yc, z],
    [w * 0.8, -bot * 0.7 + dy, z], [w * 0.36, -bot + dy, z], [0, -bot * 1.04 + dy, z],
    [-w * 0.36, -bot + dy, z], [-w * 0.8, -bot * 0.7 + dy, z], [-w, yc, z],
    [-w * 0.82, top * 0.55 + dy, z], [-w * 0.42, top * 0.92 + dy, z]
  ];
}
// Diamond-section foil for wings and fins. `at(u, v)`: chord position u
// (0 leading edge → 1 trailing edge) and thickness offset v → point.
function foil(at, t) {
  return [at(0, 0), at(0.28, t * 0.5), at(0.72, t * 0.34), at(1, 0), at(0.72, -t * 0.3), at(0.28, -t * 0.42)];
}
// Octagonal ring for nacelles and nozzles.
function octRing(x, y, z, rx, ry = rx) {
  const r = [];
  for (let i = 0; i < 8; i++) { const a = (i + 0.5) * Math.PI / 4; r.push([x + Math.cos(a) * rx, y + Math.sin(a) * ry, z]); }
  return r;
}
// Canopy-style arch ring (upper half-ellipse closed by a flat base).
function archRing(z, w, base, h) {
  const r = [];
  for (let i = 0; i <= 8; i++) { const a = (i / 8) * Math.PI; r.push([Math.cos(a) * w, base + Math.sin(a) * h, z]); }
  r.push([-w * 0.8, base - 0.12, z], [w * 0.8, base - 0.12, z]);
  return r;
}

// Canopy stations [z, half-width, height above its base] and base height.
export const CANOPY = [[-9.6, 0.05, 0.02], [-8.6, 0.45, 0.42], [-7.0, 0.76, 0.78], [-5.0, 0.86, 0.92], [-3.4, 0.74, 0.7], [-2.3, 0.36, 0.25]];
export function canopyBase(z) { return z < -6 ? 0.64 + (z + 9.6) * 0.06 : 0.86; }
// The glass cross-section at station z: half-width, base height, rise.
export function canopyAt(z) {
  let i = 0;
  while (i < CANOPY.length - 2 && CANOPY[i + 1][0] < z) i++;
  const [z0, w0, h0] = CANOPY[i], [z1, w1, h1] = CANOPY[i + 1], t = (z - z0) / (z1 - z0);
  return { w: w0 + (w1 - w0) * t, base: canopyBase(z), h: h0 + (h1 - h0) * t };
}

// ── the airframe ──
export const NACELLE = { x: 3.45, y: -0.18, z: 13.4 };

function buildAirframe() {
  const P = { hull: [], armor: [], accent: [], dark: [], metal: [], glass: [], trim: [] };

  // Fuselage: long drooped nose → raised cockpit section → broad wing root →
  // taper around the engines. [z, half-width, top, bottom, nose droop]
  const stations = [
    [-16.0, 0.05, 0.05, 0.04, -0.32], [-15.0, 0.32, 0.22, 0.18, -0.26], [-13.0, 0.66, 0.42, 0.34, -0.17],
    [-10.5, 1.0, 0.62, 0.48, -0.08], [-8.0, 1.3, 0.8, 0.58, -0.02], [-4.5, 1.62, 0.95, 0.66, 0],
    [-0.5, 2.05, 1.02, 0.72, 0], [4.0, 2.3, 0.98, 0.76, 0], [9.0, 2.1, 0.9, 0.72, 0],
    [12.8, 1.62, 0.78, 0.64, 0], [14.8, 1.3, 0.66, 0.56, 0]
  ];
  P.hull.push(loft(stations.map(([z, w, t, b, dy]) => hullRing(z, w, t, b, dy))));

  // Armour plate over the upper fuselage, from the canopy back to the wing root.
  P.armor.push(loft([[-8.2, 0.9, 0.82], [-4.2, 1.28, 0.98], [-0.4, 1.62, 1.06], [3.0, 1.75, 1.04]].map(([z, w, t]) =>
    [[0, t + 0.1, z], [w * 0.5, t * 0.93, z], [w * 0.62, t * 0.8, z], [w * 0.4, t * 0.84, z], [0, t + 0.02, z], [-w * 0.4, t * 0.84, z], [-w * 0.62, t * 0.8, z], [-w * 0.5, t * 0.93, z]])));
  // Dorsal spine: a narrow raised ridge from behind the canopy to the tail.
  P.accent.push(loft([[-1.6, 0.04], [1.0, 0.32], [8.0, 0.36], [13.6, 0.2]].map(([z, h]) => {
    const y = 0.98 + (z > 9 ? -0.08 : 0);
    return [[0, y + h, z], [0.3, y + h * 0.6, z], [0.38, y - 0.05, z], [-0.38, y - 0.05, z], [-0.3, y + h * 0.6, z]];
  })));
  // Sensor blister under the nose.
  P.accent.push(loft([[-12.2, 0.05], [-11.2, 0.26], [-9.4, 0.32], [-8.0, 0.08]].map(([z, r]) => octRing(0, -0.42 - r * 0.6, z, r * 1.4, r))));

  // Canopy: a teardrop bubble on the raised cockpit section, with a frame hoop.
  // A full bubble canopy, tall enough for a seated pilot (see cockpit.js).
  P.glass.push(loft(CANOPY.map(([z, w, h]) => archRing(z, w, canopyBase(z), h))));
  P.metal.push(loft([archRing(-5.7, 0.875, 0.85, 0.91), archRing(-5.4, 0.87, 0.86, 0.9)]));

  // Wings (starboard, mirrored). Low-mounted, swept, kinked leading edge,
  // thick at the root and thin at the tip.
  const wingAt = (x, zLE, zTE, y, t) => foil((u, v) => [x, y + v, zLE + (zTE - zLE) * u], t);
  P.hull.push(...both(loft([wingAt(1.6, -3.4, 10.2, -0.24, 0.6), wingAt(4.6, -0.6, 10.6, -0.3, 0.42), wingAt(8.0, 4.0, 10.9, -0.42, 0.24), wingAt(11.2, 7.3, 11.0, -0.55, 0.12)])));
  // Layered armour on the wing's upper surface, and a reinforced leading edge.
  const plateAt = (x, zLE, zTE, y) => [[x, y, zLE], [x, y + 0.11, zLE + 0.3], [x, y + 0.11, zTE - 0.3], [x, y, zTE], [x, y - 0.05, (zLE + zTE) / 2]];
  P.armor.push(...both(loft([plateAt(2.1, -1.6, 8.6, 0.0), plateAt(4.8, 0.6, 9.0, -0.07), plateAt(7.2, 3.6, 9.4, -0.2)])));
  const leAt = (x, zLE, y, t) => [[x, y, zLE - 0.12], [x, y + t * 0.55, zLE + 0.5], [x, y - t * 0.45, zLE + 0.5]];
  P.accent.push(...both(loft([leAt(4.6, -0.6, -0.3, 0.42), leAt(8.0, 4.0, -0.42, 0.24), leAt(11.1, 7.2, -0.55, 0.13)])));
  // Wingtip stabilisers, canted outward.
  const finAt = (x, y, zLE, zTE, t) => foil((u, v) => [x + v, y, zLE + (zTE - zLE) * u], t);
  P.armor.push(...both(loft([finAt(11.05, -0.62, 6.9, 11.2, 0.16), finAt(11.5, 0.5, 8.2, 11.3, 0.11), finAt(11.85, 1.25, 9.5, 11.3, 0.06)])));
  // Twin canted tail fins on the rear fuselage.
  P.hull.push(...both(loft([finAt(1.05, 0.7, 6.5, 14.0, 0.26), finAt(1.7, 2.6, 10.0, 14.4, 0.16), finAt(2.15, 3.9, 12.4, 14.6, 0.07)])));
  // Ventral strakes.
  P.armor.push(...both(loft([finAt(1.35, -0.72, 7.5, 13.8, 0.18), finAt(1.6, -1.55, 10.2, 13.9, 0.08)])));

  // Engine nacelles at the wing roots: octagonal, faired forward into the
  // wing, open at the back for the nozzle.
  const { x: NX, y: NY, z: NZ1 } = NACELLE;
  P.hull.push(...both(loft([[1.0, 0.42], [3.0, 0.92], [6.0, 1.08], [10.5, 1.12], [NZ1, 1.04]].map(([z, r]) => octRing(NX, NY, z, r, r * 0.86)), { capEnd: false })));
  // Armour band on each nacelle.
  P.armor.push(...both(loft([[5.2, 1.13], [7.6, 1.15]].map(([z, r]) => octRing(NX, NY, z, r, r * 0.86)))));
  // Cheek intakes beside the cockpit: dark recesses.
  P.dark.push(...both(loft([[-5.4, 0.04], [-4.6, 0.26], [-2.4, 0.3], [-1.0, 0.18]].map(([z, h]) =>
    [[1.6, -0.06 + h, z], [1.98, -0.06 + h * 0.4, z], [1.92, -0.16, z], [1.54, -0.18, z]]))));
  // Vents: shallow dark slats on the rear upper fuselage.
  for (const z of [9.6, 10.6, 11.6]) {
    const slat = (zz) => [[0.62, 0.9, zz], [1.36, 0.8, zz], [1.36, 0.74, zz], [0.62, 0.84, zz]];
    P.dark.push(...both(loft([slat(z), slat(z + 0.55)])));
  }
  // Cyan chine strips: the only lit trim on the hull.
  P.trim.push(...both(loft([[-7.0, 1.3], [-0.5, 2.08], [4.0, 2.33]].map(([z, w]) => [[w, -0.1, z], [w, -0.02, z], [w - 0.08, -0.06, z]]))));

  // Nozzles: housing lip, metal ring, recessed dark chamber — two nacelle
  // engines and a smaller centre engine in the tail.
  const engines = [{ x: NX, y: NY, z: NZ1, r: 0.98 }, { x: -NX, y: NY, z: NZ1, r: 0.98 }, { x: 0, y: -0.02, z: 15.9, r: 0.62 }];
  P.hull.push(loft([[14.2, 0.78], [15.2, 0.74], [15.9, 0.68]].map(([z, r]) => octRing(0, -0.02, z, r, r * 0.9)), { capStart: false, capEnd: false }));
  for (const e of engines) {
    const lip = e.r, ring = e.r * 0.86, inner = e.r * 0.62, depth = e.r * 0.9;
    P.armor.push(loft([octRing(e.x, e.y, e.z, lip * 1.04, lip * 0.88), octRing(e.x, e.y, e.z + 0.2, lip * 0.98, lip * 0.84),
      octRing(e.x, e.y, e.z + 0.2, ring, ring * 0.9), octRing(e.x, e.y, e.z - 0.05, ring, ring * 0.9)], { capStart: false, capEnd: false }));
    P.metal.push(loft([octRing(e.x, e.y, e.z - 0.05, ring, ring * 0.9), octRing(e.x, e.y, e.z - depth * 0.35, inner * 1.12, inner),
      octRing(e.x, e.y, e.z - depth * 0.38, inner, inner * 0.92)], { capStart: false, capEnd: false }));
    P.dark.push(loft([octRing(e.x, e.y, e.z - depth * 0.38, inner, inner * 0.92), octRing(e.x, e.y, e.z - depth, inner * 0.9, inner * 0.84)], { capStart: false, capEnd: true }));
  }
  return { P, engines };
}

// ── engine shaders: white core → cyan → deep blue, additive ──
const LD_VS_PARS = "#include <common>\n#include <logdepthbuf_pars_vertex>\n";
const CORE_VS = LD_VS_PARS + "varying vec2 vR;\nvoid main(){ vR = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);\n#include <logdepthbuf_vertex>\n}";
const CORE_FS = "#include <logdepthbuf_pars_fragment>\nuniform float uI; varying vec2 vR;\nvoid main(){\n#include <logdepthbuf_fragment>\n" +
  "  float r = length(vR); if (r > 1.0) discard;\n" +
  "  vec3 c = mix(vec3(1.0), vec3(0.45, 0.9, 1.0), smoothstep(0.0, 0.55, r));\n" +
  "  c = mix(c, vec3(0.1, 0.35, 1.0), smoothstep(0.55, 1.0, r));\n" +
  "  float a = (1.0 - smoothstep(0.75, 1.0, r)) * (0.35 + 0.65 * (1.0 - r * r));\n" +
  "  gl_FragColor = vec4(c * a * uI, 1.0); }";
const PLUME_VS = LD_VS_PARS + "attribute float aT; uniform float uLen; varying float vT; varying vec2 vUv;\n" +
  "void main(){ vT = aT; vUv = uv; vec3 p = position; p.z += aT * uLen; gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);\n#include <logdepthbuf_vertex>\n}";
const PLUME_FS = "#include <logdepthbuf_pars_fragment>\nuniform float uI; varying float vT; varying vec2 vUv;\nvoid main(){\n#include <logdepthbuf_fragment>\n" +
  "  float ribs = 0.7 + 0.3 * sin(vT * 40.0);\n" +
  "  vec3 c = mix(vec3(0.85, 0.97, 1.0), vec3(0.25, 0.8, 1.0), smoothstep(0.0, 0.3, vT));\n" +
  "  c = mix(c, vec3(0.08, 0.25, 0.9), smoothstep(0.3, 1.0, vT));\n" +
  "  float a = pow(1.0 - vT, 1.8) * ribs;\n" +
  "  gl_FragColor = vec4(c * a * uI, 1.0); }";

export class Spacecraft {
  constructor(scene) {
    this.scene = scene;
    this.owned = [];
    this.root = new THREE.Group();
    this.visual = new THREE.Group();
    this.root.add(this.visual);
    this.cockpitAnchor = new THREE.Object3D();
    this.chaseAnchor = new THREE.Object3D();
    this.root.add(this.cockpitAnchor, this.chaseAnchor);
    this.root.visible = false;
    scene.add(this.root);

    // The Sun's direction drives the key light (celestial lighting still
    // applies); a soft fill and a cool rim keep the silhouette readable
    // against black space without self-lighting the hull.
    this.sun = new THREE.DirectionalLight(0xffffff, 3.0);
    this.fill = new THREE.HemisphereLight(0x8fa6c4, 0x7a889c, 2.2);
    this.rim = new THREE.DirectionalLight(0x9fd8ff, 0.9);
    scene.add(this.sun, this.sun.target, this.fill, this.rim, this.rim.target);

    this.build();
    this.status = "built";
    this.bank = 0;
    this.prevQuat = null;
  }

  build() {
    const { P, engines } = buildAirframe();
    const mats = {
      hull: new THREE.MeshStandardMaterial({ color: 0x3a4049, metalness: 0.35, roughness: 0.5, flatShading: true }),
      armor: new THREE.MeshStandardMaterial({ color: 0x5c6470, metalness: 0.45, roughness: 0.36, flatShading: true }),
      accent: new THREE.MeshStandardMaterial({ color: 0x7d8899, metalness: 0.3, roughness: 0.55, flatShading: true }),
      dark: new THREE.MeshStandardMaterial({ color: 0x0b0d10, metalness: 0.2, roughness: 0.85, flatShading: true }),
      metal: new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.9, roughness: 0.22, flatShading: true }),
      glass: new THREE.MeshPhysicalMaterial({ color: 0x07121c, metalness: 0.1, roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.05,
        emissive: 0x0b4a5c, emissiveIntensity: 0.55, transparent: true, opacity: 0.9 }),
      trim: new THREE.MeshBasicMaterial({ color: new THREE.Color(0x3fd4ff).multiplyScalar(1.4) })
    };
    let verts = 0;
    let glassGeo = null;
    for (const k in P) {
      const geo = mergeGeometries(P[k], false);
      P[k].forEach((g) => g.dispose());
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, mats[k]);
      mesh.renderOrder = k === "glass" ? 2 : 0;
      if (k === "glass") glassGeo = geo;
      this.visual.add(mesh);
      this.owned.push(geo, mats[k]);
      verts += geo.attributes.position.count;
    }

    // Engine cores (recessed discs) and plumes, each merged into one mesh.
    const cores = [], plumes = [];
    for (const e of engines) {
      const inner = e.r * 0.62, depth = e.r * 0.9;
      const disc = new THREE.CircleGeometry(inner * 0.95, 24);
      disc.translate(e.x, e.y, e.z - depth + 0.03);
      cores.push(disc);
      // Plume: an open cone, unit length here, stretched by the shader.
      const cone = new THREE.CylinderGeometry(inner * 0.2, inner * 0.92, 1, 20, 8, true);
      cone.rotateX(Math.PI / 2);                 // axis along Z; wide end at −Z (the nozzle)
      cone.translate(0, 0, 0.5);
      const pp = cone.attributes.position, aT = new Float32Array(pp.count);
      for (let i = 0; i < pp.count; i++) { aT[i] = pp.getZ(i); pp.setZ(i, 0); }
      cone.setAttribute("aT", new THREE.BufferAttribute(aT, 1));
      cone.translate(e.x, e.y, e.z - depth * 0.3);
      plumes.push(cone);
    }
    this.engines = engines;
    const coreGeo = mergeGeometries(cores), plumeGeo = mergeGeometries(plumes);
    cores.forEach((g) => g.dispose()); plumes.forEach((g) => g.dispose());
    this.coreMat = new THREE.ShaderMaterial({ uniforms: { uI: { value: 1 } }, vertexShader: CORE_VS, fragmentShader: CORE_FS,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.plumeMat = new THREE.ShaderMaterial({ uniforms: { uI: { value: 1 }, uLen: { value: 1 } }, vertexShader: PLUME_VS, fragmentShader: PLUME_FS,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    this.cores = new THREE.Mesh(coreGeo, this.coreMat);
    this.plumes = new THREE.Mesh(plumeGeo, this.plumeMat);
    this.cores.renderOrder = 3; this.plumes.renderOrder = 4;
    this.plumes.frustumCulled = false;                 // stretched in the vertex shader
    this.visual.add(this.cores, this.plumes);
    this.owned.push(coreGeo, plumeGeo, this.coreMat, this.plumeMat);
    verts += coreGeo.attributes.position.count + plumeGeo.attributes.position.count;

    // Navigation lights: port red and starboard green at the wingtips, white tail.
    const navGeo = new THREE.SphereGeometry(0.16, 10, 6);
    this.owned.push(navGeo);
    this.lights = [[-11.3, -0.55, 9.6, 0xff2a2a], [11.3, -0.55, 9.6, 0x2aff6a], [0, 4.0, 13.6, 0xffffff]].map(([x, y, z, c]) => {
      const m = new THREE.MeshBasicMaterial({ color: c });
      this.owned.push(m);
      const s = new THREE.Mesh(navGeo, m);
      s.position.set(x, y, z);
      s.userData.color = c;
      this.visual.add(s);
      return s;
    });
    verts += navGeo.attributes.position.count * 3;

    const box = new THREE.Box3();
    for (const m of this.visual.children) if (m !== this.plumes && m !== this.cores) box.expandByObject(m);

    // Landing gear: a nose leg and two main legs, each a strut, a pad and a
    // bay door. Built extended; `gear` (0 stowed … 1 down) animates them.
    const gearMat = new THREE.MeshStandardMaterial({ color: 0x8d949c, metalness: 0.8, roughness: 0.3 });
    this.owned.push(gearMat);
    this.gearBottom = box.min.y - 1.05;
    const topY = -0.62;
    this.gearLegs = [[0, -9.2], [-2.6, 5.4], [2.6, 5.4]].map(([x, z]) => {
      const leg = new THREE.Group();
      const len = topY - this.gearBottom;
      const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, len, 10), gearMat);
      strut.position.y = -len / 2;
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.48, 0.12, 14), gearMat);
      pad.position.y = -len + 0.06;
      this.owned.push(strut.geometry, pad.geometry);
      leg.add(strut, pad);
      leg.position.set(x, topY, z);
      this.visual.add(leg);
      return leg;
    });
    this.setGear(0);
    const size = box.getSize(new THREE.Vector3());
    this.bounds = { W: size.x, H: size.y, L: size.z, box };
    this.cockpitAnchor.position.copy(EYE);                       // pilot's eye, inside the canopy
    this.cockpit = new Cockpit(this.visual, glassGeo, canopyAt);
    this.chaseAnchor.position.set(0, size.z * 0.28, size.z * 1.2);
    // The hull, wings and gear cast local shadows (render/shadows.js); the
    // glass and engine glows don't.
    this.visual.traverse((m) => { if (m.isMesh && m.material && !m.material.transparent && m.material.blending !== THREE.AdditiveBlending) m.layers.enable(3); });
    let triangles = 0, meshes = 0, vtx = 0;
    const matSet = new Set();
    this.visual.traverse((m) => {
      if (!m.isMesh) return;
      meshes++; matSet.add(m.material);
      vtx += m.geometry.attributes.position.count;
      triangles += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
    });
    this.stats = { vertices: vtx, triangles: Math.round(triangles), drawCalls: meshes, materials: matSet.size };
  }

  // ── developer view (F5): bounds, forward vector, anchors ──
  setDebug(on) {
    if (on && !this.debug) {
      const g = new THREE.Group();
      g.add(new THREE.Box3Helper(this.bounds.box, 0x8fe3b0));
      g.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, -this.bounds.L / 2), 10, 0xff4d4d));
      const dot = (p, c) => { const m = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), new THREE.MeshBasicMaterial({ color: c, depthTest: false })); m.position.copy(p); m.renderOrder = 9; g.add(m); };
      dot(this.cockpitAnchor.position, 0xffd84d);
      dot(this.chaseAnchor.position, 0x4dd2ff);
      for (const e of this.engines) dot(new THREE.Vector3(e.x, e.y, e.z), 0xff4dff);
      this.debug = g;
      this.root.add(g);
    } else if (!on && this.debug) {
      this.debug.traverse((m) => { if (m.geometry) m.geometry.dispose(); if (m.material) m.material.dispose(); });
      this.root.remove(this.debug);
      this.debug = null;
    }
  }

  // position: camera-relative render position (metres); quat: orientation;
  // thrust 0..1; boost; t: seconds; dt: frame time.
  update(position, quat, sunDir, thrust, boost, t, visible, dt = 0.016) {
    this.root.visible = visible;
    this.sun.visible = this.fill.visible = this.rim.visible = visible;
    if (!visible) { this.prevQuat = null; return; }
    this.root.position.copy(position);
    this.root.quaternion.copy(quat);
    this.sun.position.copy(position).addScaledVector(sunDir, 200);
    this.sun.target.position.copy(position);
    this.rim.position.copy(position).add(_v.set(0, 60, 120).applyQuaternion(quat));
    this.rim.target.position.copy(position);

    // Automatic bank: the turn rate (measured from the actual change in
    // orientation, so keys, mouse and auto-travel all count) leans the craft
    // into the turn — left turn, left wing down — up to 40°, on a critically
    // damped spring so it settles without overshoot and levels when the turn
    // ends. Manual roll (Z/X) and atmospheric flight, where the roll is real,
    // take over from it.
    let yawRate = 0;
    if (this.prevQuat && dt > 0) {
      _q.copy(this.prevQuat).invert().multiply(quat);
      yawRate = ((2 * _q.y) / dt) * (_q.w < 0 ? -1 : 1);
    }
    this.prevQuat = (this.prevQuat || new THREE.Quaternion()).copy(quat);
    const suppressed = this.manualRoll || this.realBank;
    const want = suppressed ? 0 : Math.max(-0.7, Math.min(0.7, yawRate * 0.9));
    const w0 = 5.5;
    this.bankVel = (this.bankVel || 0) + (w0 * w0 * (want - this.bank) - 2 * w0 * (this.bankVel || 0)) * Math.min(dt, 0.05);
    this.bank += this.bankVel * Math.min(dt, 0.05);
    this.visual.rotation.z = this.bank;

    // Engines: faint idle glow → blue thrust → white-hot boost.
    const th = Math.min(1, Math.max(0, thrust));
    const flick = 0.95 + 0.05 * Math.sin(t * 41) * Math.sin(t * 27);
    this.thrustLevel = th; this.boosting = !!boost;
    this.coreMat.uniforms.uI.value = (0.35 + 1.6 * th + (boost ? 1.6 : 0)) * flick;
    this.plumeMat.uniforms.uI.value = (0.1 + 0.9 * th + (boost ? 0.9 : 0)) * flick;
    this.plumeMat.uniforms.uLen.value = 0.5 + 4.5 * th + (boost ? 3.5 : 0);
    const blink = Math.sin(t * 3) > 0.6 ? 2 : 0.25;
    for (const l of this.lights) l.material.color.setHex(l.userData.color).multiplyScalar(blink);
  }

  setGear(v) {
    this.gear = v;
    for (const leg of this.gearLegs) { leg.visible = v > 0.02; leg.scale.set(1, Math.max(0.02, v), 1); }
  }
  // Ship-frame quaternion of the visual bank (the cockpit view rolls with it).
  bankQuat(out = new THREE.Quaternion()) { return out.setFromAxisAngle(_z, this.bank); }

  anchorOffset(anchor, quat, out = new THREE.Vector3()) {
    return out.copy(anchor.position).applyQuaternion(quat);
  }

  dispose() {
    this.setDebug(false);
    if (this.cockpit) this.cockpit.dispose();
    // Every geometry and material here belongs to this craft alone.
    this.owned.forEach((o) => o.dispose && o.dispose());
    this.scene.remove(this.root, this.sun, this.sun.target, this.fill, this.rim, this.rim.target);
  }
}
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _z = new THREE.Vector3(0, 0, 1);
