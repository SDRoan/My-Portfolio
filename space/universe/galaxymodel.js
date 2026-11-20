// Galaxy structure, shared by the particle-cloud generator (what a galaxy
// looks like from outside) and the stellar density field (how many stars a
// sector inside it holds). Pure functions only — this runs in workers too.
//
// Galaxy-local frame: light-years, centre at the origin, disc in the XZ plane,
// +Y the disc normal. Angles θ run from +X toward −Z (counter-clockwise seen
// from +Y), and position = (r cos θ, y, −r sin θ).

import { Rng, hashInts } from "../engine/rng.js";

// Catalogue morphology → generator parameters.
export function morphology(g) {
  const tt = g.ttype, dc = g.dwarfClass || "";
  if (g.special === "ring") return "ring";
  if (/Sph|dE|dS0/.test(dc)) return tt !== null && tt <= -3 && /Sph/.test(dc) ? "dsph" : "elliptical";
  if (tt === null || tt === undefined) return /Ir|Im|BCD|Sm/.test(dc) ? "irregular" : "dsph";
  if (tt <= -4) return "elliptical";
  if (tt <= -1) return "lenticular";
  if (tt >= 9) return "irregular";
  if (tt >= 8 && (g.diamKly || 0) < 30) return "irregular";
  return g.barred ? "barred" : "spiral";
}

export function describeMorphology(type, ttype, barred) {
  if (type === "elliptical") return "Elliptical";
  if (type === "lenticular") return "Lenticular (S0)";
  if (type === "irregular") return "Irregular";
  if (type === "dsph") return "Dwarf spheroidal";
  if (type === "ring") return "Ring galaxy";
  const sub = ttype === null || ttype === undefined ? "" : ttype <= 1 ? "a" : ttype <= 3 ? "b" : ttype <= 5 ? "c" : "d";
  return (barred ? "Barred spiral SB" : "Spiral S") + sub;
}

// Everything the generator and the density field need, deterministic in seed.
export function galaxyParams(g) {
  const type = g.type || morphology(g);
  const R = Math.max(800, (g.diamKly || 20) * 500);           // radius, ly
  const rng = new Rng(g.seed >>> 0);
  const tt = g.ttype === null || g.ttype === undefined ? 4 : g.ttype;
  const p = {
    type, R, seed: g.seed >>> 0,
    bulge: type === "spiral" || type === "barred" ? Math.max(0.04, 0.3 - Math.max(0, tt) * 0.035) : 0,
    arms: [],
    pitch: (10 + Math.max(0, tt) * 2.2 + rng.range(-2, 2)) * Math.PI / 180,
    bar: type === "barred" ? { len: R * rng.range(0.28, 0.4), angle: rng.range(0, Math.PI) } : null,
    flatten: g.axisRatio && (type === "elliptical" || type === "dsph") ? Math.max(0.35, g.axisRatio) : 0.75,
    lum: g.lumSun || 2e10 * Math.pow(R / 50000, 2),
    young: type === "irregular" ? 0.35 : type === "spiral" || type === "barred" ? 0.3 - (tt <= 1 ? 0.12 : 0) : type === "ring" ? 0.5 : 0.02,
    dust: type === "spiral" || type === "barred" ? 0.22 : type === "irregular" ? 0.1 : type === "lenticular" ? 0.04 : 0,
    clumps: [],
    special: g.special || null
  };
  if (type === "spiral" || type === "barred") {
    const m = type === "barred" || rng.chance(0.55) ? 2 : rng.chance(0.6) ? 4 : 3;
    const rot = rng.range(0, Math.PI * 2);
    for (let k = 0; k < m; k++) p.arms.push({ phase: rot + (k * Math.PI * 2) / m, weight: 1, from: -10, to: 10 });
  }
  if (type === "irregular") {
    const n = rng.int(5, 12);
    for (let k = 0; k < n; k++) {
      p.clumps.push({ x: rng.gauss() * R * 0.35, y: rng.gauss() * R * 0.08, z: rng.gauss() * R * 0.25, s: R * rng.range(0.08, 0.22), w: rng.range(0.4, 1.4) });
    }
  }
  if (g.milkyWay) { milkyWayOverrides(p); p.milkyWay = true; }
  return p;
}

// The Milky Way, placed from the literature rather than seeded: log-spiral
// arms with a 12° pitch passing the Sun's galactocentric radius where they
// are mapped (Perseus outside, Sagittarius–Carina and Scutum–Centaurus inside,
// Norma innermost), the Orion Spur through the Sun, and a bar 27° from the
// Sun–centre line. Close in shape, not a survey reconstruction.
export const SUN_R = 26670;
function milkyWayOverrides(p) {
  p.R = 50000;
  p.pitch = 12 * Math.PI / 180;
  p.bulge = 0.12;
  p.lum = 2.5e10;
  p.young = 0.3;
  const tp = Math.tan(p.pitch), Rref = p.R * 0.5;
  const at = (rk) => -Math.log(rk / Rref) / tp;
  p.arms = [
    { name: "Perseus Arm", phase: at(33000), weight: 1, from: -10, to: 10 },
    { name: "Sagittarius–Carina Arm", phase: at(23600), weight: 0.7, from: -10, to: 10 },
    { name: "Scutum–Centaurus Arm", phase: at(16900), weight: 1, from: -10, to: 10 },
    { name: "Norma Arm", phase: at(12100), weight: 0.7, from: -10, to: 10 },
    { name: "Orion Spur", phase: at(SUN_R), weight: 0.45, from: -0.55, to: 0.65 }
  ];
  p.bar = { len: 16000, angle: -27 * Math.PI / 180 };
}

function armTheta(p, arm, r) { return arm.phase + Math.log(r / (p.R * 0.5)) / Math.tan(p.pitch); }

// Angular distance (radians) to the nearest arm at (r, θ), and that arm.
export function nearestArm(p, r, theta) {
  let best = 1e9, which = null;
  for (const arm of p.arms) {
    let d = theta - armTheta(p, arm, Math.max(r, 1));
    d = Math.atan2(Math.sin(d), Math.cos(d));
    if (theta < arm.from || theta > arm.to) {
      if (arm.from > -9) { d = Math.max(Math.abs(d), Math.min(Math.abs(theta - arm.from), Math.abs(theta - arm.to)) * 2); }
    }
    if (Math.abs(d) < best) { best = Math.abs(d); which = arm; }
  }
  return { d: best, arm: which };
}

// ── stellar density, relative to the solar neighbourhood (1.0) ──
// young=true weights toward the arms and a thin layer, like OB stars.
export function density(p, x, y, z, young) {
  const r = Math.hypot(x, z);
  const rs = Math.hypot(r, y);
  if (p.type === "elliptical" || p.type === "dsph" || p.type === "lenticular") {
    const a = p.R * (p.type === "dsph" ? 0.35 : 0.15);
    const q = Math.hypot(x, y / p.flatten, z) / a;
    let n = (p.type === "dsph" ? 0.02 : 6) / (q * Math.pow(1 + q, 3) + 0.05);
    if (p.type === "lenticular") n += 1.2 * Math.exp(-(r - p.R * 0.3) / (p.R * 0.25)) * Math.exp(-Math.abs(y) / 600);
    return young ? n * 0.01 : n;
  }
  if (p.type === "irregular") {
    let n = 0;
    for (const c of p.clumps) {
      const d2 = ((x - c.x) ** 2 + (y - c.y) ** 2 + (z - c.z) ** 2) / (c.s * c.s);
      n += c.w * Math.exp(-d2 * 0.5);
    }
    return n * (young ? 1.5 : 0.6);
  }
  if (p.type === "ring") {
    const ring = Math.exp(-(((r - p.R * 0.85) / (p.R * 0.06)) ** 2));
    return (ring * 2 + 0.5 * Math.exp(-rs / (p.R * 0.05))) * Math.exp(-Math.abs(y) / 500);
  }
  // spiral / barred
  const Rd = p.R / 3.5;
  const h = young ? 160 : 1000;
  let n = Math.exp(-(r - SUN_R * (p.R / 50000)) / Rd) * Math.exp(-Math.abs(y) / h);
  const theta = Math.atan2(-z, x);
  const { d, arm } = nearestArm(p, r, theta);
  const w = arm ? arm.weight : 0;
  const armBoost = Math.exp(-(d * d) / (2 * 0.12 * 0.12)) * w;
  n *= young ? 0.15 + 4 * armBoost : 0.7 + 0.8 * armBoost;
  const bulgeA = p.R * 0.06;
  if (!young) n += p.bulge * 40 * Math.exp(-rs / bulgeA);
  if (p.bar) {
    const ca = Math.cos(p.bar.angle), sa = Math.sin(p.bar.angle);
    const bx = x * ca - z * sa, bz = x * sa + z * ca;
    n += (young ? 0.2 : 3) * Math.exp(-((bx / (p.bar.len * 0.5)) ** 2) - ((bz / (p.bar.len * 0.15)) ** 2) - ((y / 800) ** 2));
  }
  if (r > p.R * 1.4) n *= Math.exp(-(r - p.R * 1.4) / 3000);
  return n;
}

// Inside the galaxy's stellar body (where sector streaming takes over)?
export function inside(p, x, y, z) {
  const r = Math.hypot(x, z);
  if (p.type === "spiral" || p.type === "barred" || p.type === "lenticular" || p.type === "ring")
    return r < p.R * 1.25 && Math.abs(y) < Math.max(3000, p.R * 0.08);
  return Math.hypot(x, y, z) < p.R * 0.9;
}

// ── particle cloud ──
// Each particle stands for a crowd of stars (or a dust patch): position,
// colour, share of the galaxy's light, and physical radius.
const C_BULGE = [1.0, 0.76, 0.52], C_DISK = [1.0, 0.86, 0.7], C_YOUNG = [0.6, 0.73, 1.0];
const C_HII = [1.0, 0.52, 0.58], C_HALO = [1.0, 0.82, 0.66];

export function generateCloud(p, count) {
  const rng = new Rng(hashInts(p.seed, 77));
  const pos = new Float32Array(count * 3), col = new Float32Array(count * 3);
  const lum = new Float32Array(count), size = new Float32Array(count);
  const nd = Math.floor(count * p.dust);
  const dpos = new Float32Array(nd * 3), dsize = new Float32Array(nd), dop = new Float32Array(nd);
  const R = p.R;
  const typeIsDisk = p.type === "spiral" || p.type === "barred";
  let i = 0;
  const put = (x, y, z, c, l, s) => {
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    const v = 0.9 + rng.next() * 0.2;
    col[i * 3] = c[0] * v; col[i * 3 + 1] = c[1] * v; col[i * 3 + 2] = c[2] * v;
    lum[i] = l; size[i] = s; i++;
  };
  const lap = (h) => (rng.next() < 0.5 ? -1 : 1) * -Math.log(1 - rng.next() * 0.999) * h;
  // The Milky Way is mostly seen from inside, where particles must overlap into
  // a smooth band; other galaxies are seen from outside, where finer grain reads
  // better up close.
  const baseS = R * (p.milkyWay ? 2.4 : 1.5) / Math.sqrt(count);
  const armPoint = (rMin, rMax) => {
    const arm = pickArm(p, rng);
    let r = -R / 3 * Math.log(rng.next() * rng.next() + 1e-9);
    r = Math.max(rMin, Math.min(rMax, r));
    let th = armTheta(p, arm, r) + rng.gauss() * 0.2;
    if (arm.from > -9) th = Math.max(arm.from, Math.min(arm.to, th));
    return [r, th];
  };

  while (i < count) {
    const u = rng.next();
    if (typeIsDisk) {
      if (u < p.bulge) {                                       // bulge
        const s = Math.sqrt(rng.next());
        const r = Math.min(R * 0.5, R * 0.06 * s / (1 - s + 1e-3));
        const d = randDir(rng);
        put(d[0] * r, d[1] * r * 0.6, d[2] * r, C_BULGE, 1, baseS * (0.35 + r / R));
      } else if (p.bar && u < p.bulge + 0.08) {                // bar
        const bx = rng.gauss() * p.bar.len * 0.32, bz = rng.gauss() * p.bar.len * 0.09, by = rng.gauss() * 250;
        const ca = Math.cos(p.bar.angle), sa = Math.sin(p.bar.angle);
        put(bx * ca + bz * sa, by, -bx * sa + bz * ca, C_BULGE, 1, baseS * 0.6);
      } else if (u < p.bulge + 0.08 + 0.4) {                   // smooth disc
        const r = Math.min(R * 1.3, -R / 3.5 * Math.log(rng.next() * rng.next() + 1e-9));
        const th = rng.next() * Math.PI * 2;
        put(r * Math.cos(th), lap(R * 0.012), -r * Math.sin(th), C_DISK, 1, baseS);
      } else if (u < 0.93) {                                   // arms
        const [r, th] = armPoint(R * 0.12, R * 1.15);
        const c = rng.next() < p.young * 2 ? C_YOUNG : C_DISK;
        put(r * Math.cos(th), lap(R * 0.007), -r * Math.sin(th), c, 1.5, baseS * 0.8);
      } else if (u < 0.955) {                                  // star-forming knots
        const [r, th] = armPoint(R * 0.2, R * 1.0);
        const cx = r * Math.cos(th), cz = -r * Math.sin(th);
        const n = Math.min(count - i, 4 + Math.floor(rng.next() * 8));
        for (let k = 0; k < n; k++)
          put(cx + rng.gauss() * R * 0.008, rng.gauss() * 60, cz + rng.gauss() * R * 0.008, rng.next() < 0.5 ? C_HII : C_YOUNG, 1.6, baseS * 0.35);
      } else {                                                 // halo
        const r = Math.min(R * 2, R * 0.4 / Math.sqrt(Math.pow(rng.next() + 1e-6, -2 / 3) - 1 + 1e-6));
        const d = randDir(rng);
        put(d[0] * r, d[1] * r, d[2] * r, C_HALO, 0.5, baseS * 0.6);
      }
    } else if (p.type === "elliptical" || p.type === "dsph" || p.type === "lenticular") {
      const a = R * (p.type === "dsph" ? 0.35 : p.type === "lenticular" ? 0.1 : 0.15);
      if (p.type === "lenticular" && u < 0.5) {
        const r = Math.min(R * 1.2, -R / 3.5 * Math.log(rng.next() * rng.next() + 1e-9));
        const th = rng.next() * Math.PI * 2;
        put(r * Math.cos(th), lap(R * 0.015), -r * Math.sin(th), C_DISK, 1, baseS);
        continue;
      }
      let r;
      if (p.type === "dsph") r = Math.min(R * 1.5, a / Math.sqrt(Math.pow(rng.next() + 1e-6, -2 / 3) - 1 + 1e-6));
      else { const s = Math.sqrt(rng.next()); r = Math.min(R * 1.4, a * s / (1 - s + 1e-3)); }
      const d = randDir(rng);
      put(d[0] * r, d[1] * r * p.flatten, d[2] * r * (0.85 + 0.15 * p.flatten), p.type === "dsph" ? C_HALO : C_BULGE, 1, baseS * (0.4 + 1.2 * r / R));
    } else if (p.type === "irregular") {
      const c = p.clumps[Math.floor(rng.next() * p.clumps.length)];
      const young = rng.next() < p.young;
      put(c.x + rng.gauss() * c.s, c.y + rng.gauss() * c.s * 0.4, c.z + rng.gauss() * c.s,
        young ? (rng.next() < 0.4 ? C_HII : C_YOUNG) : C_DISK, young ? 1.6 : 1, baseS * (young ? 0.5 : 1));
    } else if (p.type === "ring") {
      if (u < 0.55) {
        const th = rng.next() * Math.PI * 2, r = R * 0.85 + rng.gauss() * R * 0.04;
        put(r * Math.cos(th), rng.gauss() * 150, -r * Math.sin(th), rng.next() < 0.45 ? C_HII : C_YOUNG, 2, baseS * 0.5);
      } else if (u < 0.75) {
        const d = randDir(rng), r = Math.abs(rng.gauss()) * R * 0.06;
        put(d[0] * r, d[1] * r * 0.6, d[2] * r, C_BULGE, 1.2, baseS * 0.5);
      } else if (u < 0.85) {
        const th = rng.next() * Math.PI * 2, r = R * 0.25 + rng.gauss() * R * 0.02;
        put(r * Math.cos(th), rng.gauss() * 100, -r * Math.sin(th), C_DISK, 1, baseS * 0.6);
      } else {
        const spoke = Math.floor(rng.next() * 8), th = spoke * Math.PI / 4 + rng.gauss() * 0.04, r = R * rng.range(0.25, 0.85);
        put(r * Math.cos(th), rng.gauss() * 100, -r * Math.sin(th), C_DISK, 0.6, baseS * 0.7);
      }
    }
  }
  // Share the galaxy's light across particles by their weights.
  let total = 0;
  for (let k = 0; k < count; k++) total += lum[k];
  const scale = p.lum / total;
  for (let k = 0; k < count; k++) lum[k] *= scale;
  shuffle(rng, count, pos, col, lum, size);

  // Dust: lanes on the inner edge of the arms, plus a thin diffuse layer.
  for (let k = 0; k < nd; k++) {
    let x, y, z;
    if (p.arms.length && rng.next() < 0.75) {
      const [r, th] = armPoint(R * 0.12, R * 1.0);
      const rr = r * 0.95, tt = th - 0.06;
      x = rr * Math.cos(tt) + rng.gauss() * R * 0.01; z = -rr * Math.sin(tt) + rng.gauss() * R * 0.01; y = rng.gauss() * R * 0.003;
    } else if (p.clumps.length) {
      const c = p.clumps[Math.floor(rng.next() * p.clumps.length)];
      x = c.x + rng.gauss() * c.s * 0.8; y = c.y + rng.gauss() * c.s * 0.2; z = c.z + rng.gauss() * c.s * 0.8;
    } else {
      const r = Math.min(R, -R / 4 * Math.log(rng.next() * rng.next() + 1e-9)), th = rng.next() * Math.PI * 2;
      x = r * Math.cos(th); y = rng.gauss() * R * 0.004; z = -r * Math.sin(th);
    }
    dpos[k * 3] = x; dpos[k * 3 + 1] = y; dpos[k * 3 + 2] = z;
    dsize[k] = baseS * rng.range(0.8, 1.8);
    dop[k] = rng.range(0.25, 0.6);
  }
  shuffle(rng, nd, dpos, null, dop, dsize);
  return { pos, col, lum, size, count, dpos, dsize, dop, dustCount: nd };
}

function pickArm(p, rng) {
  let tot = 0;
  for (const a of p.arms) tot += a.weight * (a.from > -9 ? 0.4 : 1);
  let u = rng.next() * tot;
  for (const a of p.arms) { u -= a.weight * (a.from > -9 ? 0.4 : 1); if (u <= 0) return a; }
  return p.arms[0];
}
function randDir(rng) {
  const z = rng.next() * 2 - 1, t = rng.next() * Math.PI * 2, s = Math.sqrt(1 - z * z);
  return [s * Math.cos(t), z, s * Math.sin(t)];
}
// Shuffle so any prefix of the arrays is a fair sample — LOD draws a prefix.
function shuffle(rng, n, pos, col, a, b) {
  for (let k = n - 1; k > 0; k--) {
    const j = Math.floor(rng.next() * (k + 1));
    for (let c = 0; c < 3; c++) {
      let t = pos[k * 3 + c]; pos[k * 3 + c] = pos[j * 3 + c]; pos[j * 3 + c] = t;
      if (col) { t = col[k * 3 + c]; col[k * 3 + c] = col[j * 3 + c]; col[j * 3 + c] = t; }
    }
    let t = a[k]; a[k] = a[j]; a[j] = t;
    t = b[k]; b[k] = b[j]; b[j] = t;
  }
}
