// Procedural 3D vegetation models, built once in code (no external models or
// textures). Every model is a broad visual family, not a species:
//
//   trees   broadleaf · conifer · tall narrow conifer · palm · mangrove ·
//           small ornamental · urban street tree · bushy small tree
//   shrubs  shrub · dry scrub · reeds · vine row
//   ground  grass clump · grass tuft (distant) · crop row
//
// Each comes in up to three levels of detail (near, middle, far). Geometry is
// normalised: height 1 along +Y, crown width 1 across X/Z, base at the origin;
// instances scale it by their height and crown width. Vertex attributes:
// position, normal, color (albedo, linear), sway (0 rigid … 1 free leaf tips),
// ao (0 deep in the crown … 1 outside).
//
// Crowns are clusters of irregular, displaced lobes (broadleaf), stacked,
// jagged, drooping tiers (conifers) or folded fronds (palms) — never a ball
// on a stick.

import * as THREE from "three";

export const FAMILY = { broadleaf: 0, conifer: 1, tallConifer: 2, palm: 3, mangrove: 4, ornamental: 5, street: 6, bushy: 7,
  shrub: 8, scrub: 9, reeds: 10, vine: 11, grass: 12, tuft: 13, crop: 14 };
export const FAMILY_NAMES = ["broadleaf", "conifer", "tall narrow conifer", "palm", "mangrove", "small ornamental tree", "urban street tree", "bushy small tree",
  "shrub", "dry scrub", "reeds", "vine row", "grass clump", "grass tuft", "crop row"];
export const TREE_FAMILIES = 8;

function rnd(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function hash3(x, y, z, s) {
  let h = Math.imul(Math.round(x * 1000) | 0, 0x27d4eb2d) ^ Math.imul(Math.round(y * 1000) | 0, 0x165667b1) ^ Math.imul(Math.round(z * 1000) | 0, 0x9e3779b9) ^ s;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

class Builder {
  constructor() { this.P = []; this.N = []; this.C = []; this.S = []; this.A = []; }
  tri(a, b, c, col, sway, ao, nrm) {
    const n = nrm || faceNormal(a, b, c);
    for (const [p, i] of [[a, 0], [b, 1], [c, 2]]) {
      this.P.push(p[0], p[1], p[2]);
      const nn = Array.isArray(n[0]) ? n[i] : n;
      this.N.push(nn[0], nn[1], nn[2]);
      const cc = Array.isArray(col[0]) ? col[i] : col;
      this.C.push(cc[0], cc[1], cc[2]);
      this.S.push(Array.isArray(sway) ? sway[i] : sway); this.A.push(Array.isArray(ao) ? ao[i] : ao);
    }
  }
  quad(a, b, c, d, col, sway, ao) { this.tri(a, b, c, col, sway, ao); this.tri(a, c, d, col, sway, ao); }
  // Tapered cylinder (bark) from p0 to p1, radii r0 → r1, with a slight bend.
  limb(p0, p1, r0, r1, sides, segs, col, bend = [0, 0, 0], swayBase = 0, swayTop = 0.05) {
    const ring = (t) => {
      const c = [p0[0] + (p1[0] - p0[0]) * t + bend[0] * Math.sin(Math.PI * t), p0[1] + (p1[1] - p0[1]) * t + bend[1] * Math.sin(Math.PI * t), p0[2] + (p1[2] - p0[2]) * t + bend[2] * Math.sin(Math.PI * t)];
      const d = norm([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]);
      const u = norm(Math.abs(d[1]) < 0.9 ? cross(d, [0, 1, 0]) : cross(d, [1, 0, 0])), v = cross(d, u);
      const r = r0 + (r1 - r0) * t, pts = [];
      for (let k = 0; k < sides; k++) { const a = (k / sides) * Math.PI * 2; pts.push([c[0] + (u[0] * Math.cos(a) + v[0] * Math.sin(a)) * r, c[1] + (u[1] * Math.cos(a) + v[1] * Math.sin(a)) * r, c[2] + (u[2] * Math.cos(a) + v[2] * Math.sin(a)) * r, u[0] * Math.cos(a) + v[0] * Math.sin(a), u[1] * Math.cos(a) + v[1] * Math.sin(a), u[2] * Math.cos(a) + v[2] * Math.sin(a)]); }
      return pts;
    };
    let prev = ring(0);
    for (let s = 1; s <= segs; s++) {
      const t = s / segs, cur = ring(t), sw0 = swayBase + (swayTop - swayBase) * ((s - 1) / segs), sw1 = swayBase + (swayTop - swayBase) * t;
      for (let k = 0; k < sides; k++) {
        const a = prev[k], b = prev[(k + 1) % sides], c = cur[(k + 1) % sides], d = cur[k];
        const shade = 0.85 + 0.15 * ((k * 7) % 5) / 4;
        const cc = [col[0] * shade, col[1] * shade, col[2] * shade];
        this.tri(a, b, c, cc, [sw0, sw0, sw1], 0.8, [a.slice(3), b.slice(3), c.slice(3)]);
        this.tri(a, c, d, cc, [sw0, sw1, sw1], 0.8, [a.slice(3), c.slice(3), d.slice(3)]);
      }
      prev = cur;
    }
  }
  // An irregular foliage lobe: a displaced icosphere; normals blend the face
  // normal with the direction from the crown centre (soft, bumpy crowns).
  lobe(c, rx, ry, rz, detail, col, seed, crownC, sway = 1, jag = 0.28) {
    const g = new THREE.IcosahedronGeometry(1, detail).toNonIndexed(), p = g.attributes.position;
    const verts = [];
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const k = 1 + jag * (hash3(x, y, z, seed) - 0.5) * 2;
      verts.push([c[0] + x * rx * k, c[1] + y * ry * k, c[2] + z * rz * k]);
    }
    for (let i = 0; i < verts.length; i += 3) {
      const a = verts[i], b = verts[i + 1], d = verts[i + 2], fn = faceNormal(a, b, d);
      const ns = [a, b, d].map((v) => { const r = norm([v[0] - crownC[0], (v[1] - crownC[1]) * 1.4, v[2] - crownC[2]]); return norm([r[0] * 0.65 + fn[0] * 0.35, r[1] * 0.65 + fn[1] * 0.35, r[2] * 0.65 + fn[2] * 0.35]); });
      const ao = [a, b, d].map((v) => Math.min(1, Math.max(0.25, 0.45 + 0.6 * ((v[1] - crownC[1]) / (ry * 2.5) + 0.5) * 0.7 + 0.3 * Math.hypot(v[0] - crownC[0], v[2] - crownC[2]) / Math.max(rx, rz, 1e-3))));
      const tint = 0.88 + 0.24 * hash3(a[0] + b[0], a[1], d[2], seed + 7);
      this.tri(a, b, d, [col[0] * tint, col[1] * tint, col[2] * tint], [sway, sway, sway], ao, ns);
    }
    g.dispose();
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.C, 3));
    g.setAttribute("sway", new THREE.Float32BufferAttribute(this.S, 1));
    g.setAttribute("ao", new THREE.Float32BufferAttribute(this.A, 1));
    g.computeBoundingSphere();
    return g;
  }
}
function norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function faceNormal(a, b, c) { return norm(cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]])); }

// Albedo (linear): bark and foliage, kept dark like real vegetation (~0.05–0.15).
const BARK = [0.075, 0.055, 0.04], BARK_GREY = [0.11, 0.1, 0.09], BARK_RED = [0.1, 0.05, 0.03], PALM_TRUNK = [0.13, 0.11, 0.085];
const LEAF = [0.04, 0.072, 0.028], LEAF_DARK = [0.025, 0.055, 0.025], NEEDLE = [0.022, 0.05, 0.03], NEEDLE_BLUE = [0.025, 0.05, 0.04];
const PALM_LEAF = [0.05, 0.085, 0.03], MANGROVE_LEAF = [0.03, 0.065, 0.025], JUNIPER = [0.035, 0.055, 0.035], SCRUB = [0.07, 0.08, 0.05];

// ── broadleaf (and its smaller relatives): trunk, a few limbs, lobed crown ──
function broadleaf(lod, o = {}) {
  const B = new Builder(), r = rnd(o.seed || 11);
  const clear = o.clear ?? 0.35, crownTop = 1, crownBottom = clear, cy = (crownTop + crownBottom) / 2, ch = crownTop - crownBottom;
  const trunkR = o.trunkR ?? 0.045, leaf = o.leaf || LEAF, bark = o.bark || BARK;
  if (lod === 0) {
    B.limb([0, -0.02, 0], [0.02, cy, 0.01], trunkR, trunkR * 0.55, 7, 3, bark, [0.015, 0, 0.01], 0, 0.08);
    const limbs = o.limbs ?? 4;
    for (let i = 0; i < limbs; i++) {
      const a = (i / limbs) * Math.PI * 2 + r() * 0.6, h0 = crownBottom + ch * (0.05 + 0.25 * r());
      B.limb([0.02, h0, 0.01], [Math.cos(a) * 0.3, h0 + ch * (0.3 + 0.2 * r()), Math.sin(a) * 0.3], trunkR * 0.45, trunkR * 0.18, 5, 2, bark, [0, 0.03, 0], 0.08, 0.35);
    }
  } else B.limb([0, -0.02, 0], [0, cy, 0], trunkR * 1.2, trunkR * 0.7, lod === 1 ? 5 : 3, 1, bark, [0, 0, 0], 0, 0.1);
  // Far: one rounded, slightly irregular crown (detail 1, so it reads as a
  // broadleaf canopy, not a spike); middle: five small lobes; near: the full cluster.
  // Near: the larger lobes smooth (detail 1), the smaller ones low-poly (detail 0).
  const lobes = lod === 0 ? (o.lobes ?? 9) : lod === 1 ? 5 : 1;
  const C = [0, cy + ch * 0.05, 0];
  for (let i = 0; i < lobes; i++) {
    let x, y, z, s;
    if (lod === 2) { x = 0; z = 0; y = cy + 0.05 * ch; s = 0.5; }
    else {
      const a = (i / lobes) * Math.PI * 2 + r() * 0.9, rr = i === 0 ? 0 : (lod === 1 ? 0.2 : 0.18) + 0.2 * r();
      x = Math.cos(a) * rr; z = Math.sin(a) * rr; y = cy + (r() - 0.35) * ch * 0.55; s = i === 0 ? 0.42 : (lod === 1 ? 0.3 : 0.24) + 0.14 * r();
    }
    const tall = lod === 2 ? Math.min(1.1, o.tall ?? 1.25) * 1.7 : o.tall ?? 1.25;
    const det = lod === 1 ? 0 : lod === 2 ? 1 : i < 4 ? 1 : 0;
    B.lobe([x, y, z], s * (o.wide ?? 1), s * ch * tall, s * (o.wide ?? 1), det, leaf, (o.seed || 11) * 31 + i, C, 1, lod === 2 ? 0.22 : lod === 1 ? 0.2 : 0.3);
  }
  return B.geometry();
}

// ── conifers: straight trunk, stacked drooping jagged tiers ──
function conifer(lod, o = {}) {
  const B = new Builder(), r = rnd(o.seed || 23);
  const tiers = lod === 0 ? (o.tiers ?? 8) : lod === 1 ? 4 : 1, sides = lod === 0 ? 12 : lod === 1 ? 8 : 6;
  const base = o.clear ?? 0.12, col = o.leaf || NEEDLE, width = o.width ?? 1;
  if (lod < 2) B.limb([0, -0.02, 0], [0, 0.98, 0], o.trunkR ?? 0.03, 0.006, lod === 0 ? 6 : 4, lod === 0 ? 2 : 1, o.bark || BARK_RED, [0, 0, 0], 0, 0.15);
  for (let t = 0; t < tiers; t++) {
    const f = tiers === 1 ? 0 : t / (tiers - 1);
    const y0 = base + (1 - base) * (tiers === 1 ? 0 : f * 0.86), y1 = Math.min(1, y0 + (1 - base) * (tiers === 1 ? 1 : 0.26));
    const rad = 0.5 * width * (1 - 0.82 * f) * (0.9 + 0.2 * r());
    const droop = (y1 - y0) * 0.18, apex = [0, y1, 0];
    const rim = [];
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2 + t * 0.7, jag = lod === 2 ? 1 : k % 2 ? 0.72 : 1.08 + 0.12 * r();
      rim.push([Math.cos(a) * rad * jag, y0 - (k % 2 ? 0 : droop), Math.sin(a) * rad * jag]);
    }
    const inner = [0, y0 + (y1 - y0) * 0.22, 0];
    for (let k = 0; k < sides; k++) {
      const a = rim[k], b = rim[(k + 1) % sides];
      const tint = 0.85 + 0.3 * ((k * 5 + t * 3) % 7) / 6;
      const c = [col[0] * tint, col[1] * tint, col[2] * tint];
      const na = norm([a[0], rad * 0.9, a[2]]), nb = norm([b[0], rad * 0.9, b[2]]);
      B.tri(apex, b, a, c, [0.5, 1, 1], [1, 0.75, 0.75], [[0, 1, 0], nb, na]);
      B.tri(inner, a, b, [c[0] * 0.7, c[1] * 0.7, c[2] * 0.7], [0.3, 1, 1], 0.35, [[0, -1, 0], [na[0], -0.4, na[2]], [nb[0], -0.4, nb[2]]]);
    }
  }
  return B.geometry();
}

// ── palm: curved ringed trunk, crown of folded fronds, a skirt of old fronds ──
function palm(lod, o = {}) {
  const B = new Builder(), r = rnd(o.seed || 37);
  const top = [0.06, 0.86, 0.02];
  B.limb([0, -0.02, 0], top, 0.04, 0.032, lod === 0 ? 7 : lod === 1 ? 5 : 4, lod === 0 ? 6 : lod === 1 ? 3 : 1, PALM_TRUNK, [0.05, 0, 0.02], 0, 0.25);
  const fronds = lod === 0 ? 14 : lod === 1 ? 7 : 5, segs = lod === 0 ? 6 : lod === 1 ? 3 : 2;
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + r() * 0.4, up = 0.55 - 0.9 * r() * (f % 3 === 0 ? 1 : 0.6), len = 0.48 + 0.12 * r();
    const dir = [Math.cos(a), 0, Math.sin(a)], side = [-Math.sin(a), 0, Math.cos(a)];
    let prevL = null, prevC = null, prevR = null;
    for (let s = 0; s <= segs; s++) {
      const t = s / segs, along = len * t, droop = up * t - 0.9 * t * t * len;
      const c = [top[0] + dir[0] * along, top[1] + 0.04 + droop * 0.6, top[2] + dir[2] * along];
      const w = 0.09 * Math.sin(Math.PI * Math.min(1, t * 1.15 + 0.05)) * (lod === 0 && s % 2 ? 0.7 : 1), fold = w * 0.45;
      const L = [c[0] + side[0] * w, c[1] - fold, c[2] + side[2] * w], R = [c[0] - side[0] * w, c[1] - fold, c[2] - side[2] * w];
      if (prevC) {
        const sw = [0.4 + 0.6 * (t - 1 / segs), 0.4 + 0.6 * t];
        const g = 0.85 + 0.25 * r(), col = [PALM_LEAF[0] * g, PALM_LEAF[1] * g, PALM_LEAF[2] * g];
        B.quad(prevC, c, L, prevL, col, [sw[0], sw[1], sw[1], sw[0]].slice(0, 3), 0.95);
        B.quad(prevC, prevR, R, c, col, [sw[0], sw[0], sw[1]], 0.95);
      }
      prevL = L; prevC = c; prevR = R;
    }
  }
  if (lod === 0) for (let f = 0; f < 6; f++) {             // dead fronds hanging against the trunk
    const a = (f / 6) * Math.PI * 2, d = [Math.cos(a), 0, Math.sin(a)];
    const p0 = [top[0] + d[0] * 0.03, top[1] - 0.02, top[2] + d[2] * 0.03], p1 = [top[0] + d[0] * 0.09, top[1] - 0.22, top[2] + d[2] * 0.09];
    const s = [-d[2] * 0.04, 0, d[0] * 0.04];
    B.quad([p0[0] - s[0], p0[1], p0[2] - s[2]], [p0[0] + s[0], p0[1], p0[2] + s[2]], [p1[0] + s[0], p1[1], p1[2] + s[2]], [p1[0] - s[0], p1[1], p1[2] - s[2]], [0.12, 0.095, 0.06], 0.15, 0.6);
  }
  return B.geometry();
}

// ── mangrove: arching prop roots, short stems, a low, wide, flat crown ──
function mangrove(lod) {
  const B = new Builder(), r = rnd(53);
  const roots = lod === 0 ? 7 : lod === 1 ? 3 : 0;
  for (let i = 0; i < roots; i++) {
    const a = (i / Math.max(1, roots)) * Math.PI * 2 + r() * 0.5;
    B.limb([Math.cos(a) * 0.32, -0.03, Math.sin(a) * 0.32], [Math.cos(a) * 0.04, 0.3, Math.sin(a) * 0.04], 0.012, 0.016, 4, lod === 0 ? 3 : 1, BARK_GREY, [Math.cos(a) * 0.05, 0.1, Math.sin(a) * 0.05], 0, 0.02);
  }
  if (lod < 2) B.limb([0, 0.25, 0], [0.03, 0.62, 0], 0.03, 0.018, 5, 1, BARK_GREY, [0, 0, 0], 0, 0.1);
  const lobes = lod === 0 ? 7 : lod === 1 ? 3 : 1, C = [0, 0.75, 0];
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * Math.PI * 2 + r(), rr = lobes === 1 ? 0 : 0.18 + 0.12 * r();
    B.lobe([Math.cos(a) * rr, 0.72 + 0.12 * r(), Math.sin(a) * rr], lobes === 1 ? 0.5 : 0.28, 0.15, lobes === 1 ? 0.5 : 0.28, lod === 0 ? 1 : 0, MANGROVE_LEAF, 900 + i, C, 1);
  }
  return B.geometry();
}

// ── bushy small tree: several low stems, dense irregular crown from near the ground ──
function bushy(lod) {
  const B = new Builder(), r = rnd(61);
  if (lod < 2) for (let i = 0; i < (lod === 0 ? 3 : 1); i++) {
    const a = i * 2.1;
    B.limb([Math.cos(a) * 0.04, -0.02, Math.sin(a) * 0.04], [Math.cos(a) * 0.14, 0.45, Math.sin(a) * 0.14], 0.035, 0.015, 5, 2, BARK_GREY, [0.04, 0, 0], 0, 0.15);
  }
  const lobes = lod === 0 ? 8 : lod === 1 ? 4 : 2, C = [0, 0.55, 0];
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * Math.PI * 2 + r(), rr = i === 0 ? 0 : 0.15 + 0.17 * r();
    B.lobe([Math.cos(a) * rr, 0.35 + 0.45 * r(), Math.sin(a) * rr], 0.24 + 0.1 * r(), 0.26 + 0.1 * r(), 0.24 + 0.1 * r(), lod === 0 ? 1 : 0, JUNIPER, 700 + i, C, 0.8, 0.38);
  }
  return B.geometry();
}

// ── shrubs and ground cover ──
function shrub(lod, col = LEAF_DARK, seed = 81) {
  const B = new Builder(), r = rnd(seed), lobes = lod === 0 ? 5 : 2, C = [0, 0.4, 0];
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * Math.PI * 2 + r(), rr = i === 0 ? 0 : 0.2 + 0.12 * r();
    B.lobe([Math.cos(a) * rr, 0.35 + 0.15 * r(), Math.sin(a) * rr], 0.3 + 0.08 * r(), 0.42, 0.3 + 0.08 * r(), lod === 0 ? 1 : 0, col, seed * 13 + i, C, 0.7, 0.35);
  }
  return B.geometry();
}
function blades(n, opts) {
  const B = new Builder(), r = rnd(opts.seed || 97);
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2, rr = Math.sqrt(r()) * 0.5, h = 0.6 + 0.4 * r(), lean = (r() - 0.3) * (opts.lean ?? 0.35), w = opts.width * (0.7 + 0.6 * r());
    const yaw = r() * Math.PI, d = [Math.cos(yaw), 0, Math.sin(yaw)], lx = Math.cos(a) * rr, lz = Math.sin(a) * rr;
    const segs = opts.segs || 3;
    let pl = null, pr = null;
    for (let s = 0; s <= segs; s++) {
      const t = s / segs, ww = w * (1 - t * 0.92), y = h * t, off = lean * t * t;
      const c = [lx + Math.cos(a) * off, y, lz + Math.sin(a) * off];
      const L = [c[0] - d[0] * ww, c[1], c[2] - d[2] * ww], R = [c[0] + d[0] * ww, c[1], c[2] + d[2] * ww];
      if (pl) {
        const k0 = (s - 1) / segs, col0 = opts.col.map((v, j) => v * (0.55 + 0.6 * k0) + opts.tip[j] * k0 * 0.4), col1 = opts.col.map((v, j) => v * (0.55 + 0.6 * t) + opts.tip[j] * t * 0.4);
        B.tri(pl, pr, R, [col0, col0, col1], [k0 * k0, k0 * k0, t * t], [0.5 + 0.5 * k0, 0.5 + 0.5 * k0, 0.5 + 0.5 * t], [norm([d[2], 0.6, -d[0]]), norm([d[2], 0.6, -d[0]]), norm([d[2], 0.6, -d[0]])]);
        B.tri(pl, R, L, [col0, col1, col1], [k0 * k0, t * t, t * t], [0.5 + 0.5 * k0, 0.5 + 0.5 * t, 0.5 + 0.5 * t], [norm([d[2], 0.6, -d[0]]), norm([d[2], 0.6, -d[0]]), norm([d[2], 0.6, -d[0]])]);
      }
      pl = L; pr = R;
    }
  }
  return B.geometry();
}
function scrub(lod) {
  // Dry scrub: a low mound of small lobes with stiff, pale twigs sticking out.
  const B = new Builder(), r = rnd(103), C = [0, 0.35, 0];
  const lobes = lod === 0 ? 4 : 2;
  for (let i = 0; i < lobes; i++) { const a = r() * 6.28, rr = 0.15 * r(); B.lobe([Math.cos(a) * rr, 0.3 + 0.1 * r(), Math.sin(a) * rr], 0.32, 0.3, 0.32, 0, SCRUB, 300 + i, C, 0.5, 0.45); }
  if (lod === 0) for (let i = 0; i < 9; i++) {
    const a = r() * 6.28, e = 0.3 + 0.9 * r();
    B.limb([0, 0.1, 0], [Math.cos(a) * 0.55 * Math.cos(e), 0.1 + 0.6 * Math.sin(e), Math.sin(a) * 0.55 * Math.cos(e)], 0.012, 0.003, 3, 1, [0.13, 0.12, 0.1], [0, 0, 0], 0.1, 0.5);
  }
  return B.geometry();
}
function vineRow(lod) {
  // A 4 m stretch of trellised vines: a hedge of foliage on a wire, two posts.
  const B = new Builder(), r = rnd(131);
  if (lod === 0) for (const x of [-0.5, 0.5]) B.limb([x, -0.05, 0], [x, 1, 0], 0.012, 0.012, 4, 1, [0.12, 0.1, 0.08], [0, 0, 0], 0, 0);
  const n = lod === 0 ? 6 : 2;
  for (let i = 0; i < n; i++) B.lobe([-0.42 + 0.84 * (i + 0.5) / n, 0.65 + 0.08 * r(), 0], 0.55 / n + 0.05, 0.25, 0.12, 0, [0.05, 0.08, 0.03], 500 + i, [0, 0.6, 0], 0.6, 0.3);
  return B.geometry();
}
function cropRow() {
  // Two parallel planted rows, 6 m long (instances scale length by crown), low and lumpy.
  const B = new Builder();
  for (const z of [-0.25, 0.25]) for (let i = 0; i < 6; i++) B.lobe([-0.5 + (i + 0.5) / 6, 0.45, z], 0.1, 0.5, 0.12, 0, [0.07, 0.09, 0.035], 600 + i + (z > 0 ? 9 : 0), [0, 0.3, z], 0.6, 0.25);
  return B.geometry();
}

// [near, middle, far] per family (null where a level isn't used).
export function buildModels() {
  const L = (fn) => [fn(0), fn(1), fn(2)];
  const m = [];
  m[FAMILY.broadleaf] = L((l) => broadleaf(l, { seed: 11 }));
  m[FAMILY.conifer] = L((l) => conifer(l, { seed: 23, width: 0.95, leaf: NEEDLE }));
  m[FAMILY.tallConifer] = L((l) => conifer(l, { seed: 29, width: 0.6, tiers: 11, clear: 0.22, leaf: NEEDLE_BLUE, trunkR: 0.022 }));
  m[FAMILY.palm] = L((l) => palm(l));
  m[FAMILY.mangrove] = L((l) => mangrove(l));
  m[FAMILY.ornamental] = L((l) => broadleaf(l, { seed: 41, clear: 0.3, lobes: 7, limbs: 3, tall: 1.05, leaf: [0.05, 0.09, 0.032], trunkR: 0.05 }));
  m[FAMILY.street] = L((l) => broadleaf(l, { seed: 47, clear: 0.42, lobes: 8, limbs: 4, tall: 1.4, wide: 0.95, bark: BARK_GREY, trunkR: 0.04 }));
  m[FAMILY.bushy] = L((l) => bushy(l));
  m[FAMILY.shrub] = [shrub(0), shrub(1), null];
  m[FAMILY.scrub] = [scrub(0), scrub(1), null];
  m[FAMILY.reeds] = [blades(16, { width: 0.025, col: [0.06, 0.075, 0.03], tip: [0.12, 0.11, 0.06], seed: 151, lean: 0.15, segs: 3 }), blades(6, { width: 0.05, col: [0.06, 0.075, 0.03], tip: [0.12, 0.11, 0.06], seed: 157, segs: 1 }), null];
  m[FAMILY.vine] = [vineRow(0), vineRow(1), null];
  m[FAMILY.grass] = [blades(9, { width: 0.06, col: [0.04, 0.075, 0.022], tip: [0.09, 0.12, 0.04], seed: 171, segs: 3 }), blades(4, { width: 0.16, col: [0.04, 0.075, 0.022], tip: [0.09, 0.12, 0.04], seed: 173, segs: 1, lean: 0.2 }), null];
  m[FAMILY.tuft] = [blades(5, { width: 0.12, col: [0.05, 0.075, 0.025], tip: [0.1, 0.11, 0.05], seed: 181, segs: 2 }), null, null];
  m[FAMILY.crop] = [cropRow(), null, null];
  return m;
}
export function triangleCounts(models) {
  return models.map((lods, f) => ({ family: FAMILY_NAMES[f], lods: lods.map((g) => (g ? g.attributes.position.count / 3 : 0)) }));
}
