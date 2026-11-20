// Particle structure for nebulae and star clusters. Positions, distances and
// sizes come from the catalogue; the internal structure here is generated —
// a visualisation in the right place at the right scale, not an image of the
// real object. Units: light-years from the object's centre.

import { Rng, hashInts } from "../engine/rng.js";

const H_ALPHA = [1.0, 0.3, 0.38], O_III = [0.3, 0.88, 0.82], S_II = [1.0, 0.55, 0.3];
const BLUE = [0.55, 0.7, 1.0], WHITE = [0.95, 0.95, 1.0], SYNCH = [0.55, 0.65, 1.0];

// Representative integrated luminosity (solar units) by kind, for brightness.
export function deepLuminosity(o) {
  const s = Math.max(0.3, o.sizeLy);
  if (o.kind === "cluster") return o.subtype === "globular" ? 2e5 * Math.pow(s / 100, 2) : 400 * Math.pow(s / 20, 1.5);
  return { emission: 15000 * Math.pow(s / 24, 1.4), reflection: 80 * (s / 20), planetary: 60, snr: 250 * Math.pow(s / 10, 0.8), dark: 0 }[o.subtype] || 100;
}

export function generateDeep(o, budget) {
  const rng = new Rng(hashInts(o.seed, 31));
  const R = Math.max(0.2, o.sizeLy / 2);
  const P = [], C = [], L = [], S = [];
  const D = [], DS = [], DO = [];
  // Gas shares the object's integrated light; stars (s = 0) keep their own.
  const isStar = [];
  const put = (x, y, z, c, l, s) => { P.push(x, y, z); const v = 0.85 + rng.next() * 0.3; C.push(c[0] * v, c[1] * v, c[2] * v); L.push(l); S.push(s); isStar.push(s === 0 && o.kind !== "cluster"); };
  const dust = (x, y, z, s, op) => { D.push(x, y, z); DS.push(s); DO.push(op); };
  const n = budget;

  if (o.kind === "cluster" && o.subtype === "globular") {
    for (let i = 0; i < n; i++) {
      const a = R * 0.18;
      const r = Math.min(R * 1.4, a / Math.sqrt(Math.pow(rng.next() + 1e-6, -2 / 3) - 1 + 1e-6));
      const d = dir(rng);
      const giant = rng.next() < 0.08;
      put(d[0] * r, d[1] * r, d[2] * r, giant ? [1, 0.72, 0.45] : [1, 0.9, 0.78], giant ? 30 : 1, 0);
    }
  } else if (o.kind === "cluster") {
    // Young open cluster: a few bright blue stars over many fainter members.
    for (let i = 0; i < n; i++) {
      const r = Math.abs(rng.gauss()) * R * 0.45;
      const d = dir(rng);
      const bright = rng.next() < 0.04;
      put(d[0] * r, d[1] * r, d[2] * r, bright ? BLUE : rng.next() < 0.5 ? WHITE : [1, 0.85, 0.65], bright ? 200 : rng.logRange(0.05, 8), 0);
    }
    if (o.extra && o.extra.reflection) {
      for (let i = 0; i < n * 0.6; i++) {
        const r = Math.abs(rng.gauss()) * R * 0.35, d = dir(rng);
        put(d[0] * r, d[1] * r * 0.6, d[2] * r, BLUE, 3, R * rng.range(0.05, 0.15));
      }
    }
  } else if (o.subtype === "planetary") {
    const q = rng.range(0.6, 0.9);
    for (let i = 0; i < n; i++) {
      const d = dir(rng);
      const shell = rng.next() < 0.65;
      const r = shell ? R * (0.75 + rng.gauss() * 0.06) : R * Math.pow(rng.next(), 0.5) * 0.7;
      put(d[0] * r, d[1] * r * q, d[2] * r, shell ? (rng.next() < 0.6 ? H_ALPHA : S_II) : O_III, shell ? 1 : 1.4, R * 0.09);
    }
    put(0, 0, 0, WHITE, 40, 0);
  } else if (o.subtype === "snr") {
    const crab = /Crab/.test(o.name);
    for (let i = 0; i < n; i++) {
      const d = dir(rng);
      if (crab && rng.next() < 0.35) {
        const r = R * Math.pow(rng.next(), 0.6) * 0.8;
        put(d[0] * r, d[1] * r * 0.75, d[2] * r, SYNCH, 0.8, R * 0.12);
      } else {
        // Filaments: points pulled onto a lumpy shell along noise ridges.
        const wob = 1 + 0.18 * Math.sin(d[0] * 9 + o.seed % 5) * Math.cos(d[1] * 7);
        const r = R * (crab ? 0.85 : 0.95) * wob * (1 + rng.gauss() * 0.02);
        if (!crab && rng.next() < 0.55 && Math.abs(Math.sin(d[0] * 5 + d[2] * 3)) > 0.35) continue;
        put(d[0] * r, d[1] * r * (crab ? 0.75 : 1), d[2] * r, rng.next() < 0.6 ? H_ALPHA : O_III, 1, R * 0.03);
      }
    }
  } else if (o.subtype === "reflection") {
    for (let i = 0; i < n; i++) {
      const r = Math.abs(rng.gauss()) * R * 0.5, d = dir(rng);
      put(d[0] * r, d[1] * r * 0.5, d[2] * r, BLUE, 1, R * rng.range(0.08, 0.2));
    }
  } else if (o.subtype === "dark") {
    // Lumpy, translucent: dark nebulae are dense knots in a thinner veil.
    const knots = Array.from({ length: rng.int(5, 10) }, () => [rng.gauss() * R * 0.45, rng.gauss() * R * 0.25, rng.gauss() * R * 0.35, R * rng.range(0.12, 0.3)]);
    for (let i = 0; i < n; i++) {
      const k = knots[Math.floor(rng.next() * knots.length)];
      dust(k[0] + rng.gauss() * k[3], k[1] + rng.gauss() * k[3] * 0.6, k[2] + rng.gauss() * k[3], R * rng.range(0.05, 0.14), rng.range(0.06, 0.22));
    }
    // A faint rim of light from the emission behind it.
    for (let i = 0; i < n * 0.4; i++) {
      const d = dir(rng), r = R * rng.range(0.7, 1.1);
      put(d[0] * r, d[1] * r * 0.6, d[2] * r, H_ALPHA, 0.6, R * 0.15);
    }
  } else {
    // Emission: lumpy clouds of ionised gas around a cluster of hot stars,
    // oxygen-teal near the centre, hydrogen-red outside, threaded with dust.
    const clumps = Array.from({ length: rng.int(6, 14) }, () => ({ x: rng.gauss() * R * 0.4, y: rng.gauss() * R * 0.25, z: rng.gauss() * R * 0.4, s: R * rng.range(0.15, 0.4) }));
    const cavity = o.extra && o.extra.cavity ? R * 0.3 : 0;
    for (let i = 0; i < n; i++) {
      const c = clumps[Math.floor(rng.next() * clumps.length)];
      let x = c.x + rng.gauss() * c.s, y = c.y + rng.gauss() * c.s * 0.7, z = c.z + rng.gauss() * c.s;
      const r = Math.hypot(x, y, z);
      if (r < cavity) { const k = cavity / Math.max(r, 1e-3); x *= k; y *= k; z *= k; }
      const inner = r < R * 0.3;
      put(x, y, z, inner && rng.next() < 0.6 ? O_III : rng.next() < 0.85 ? H_ALPHA : S_II, 1, R * rng.range(0.06, 0.16));
    }
    for (let i = 0; i < Math.min(40, n * 0.02); i++) {
      const d = dir(rng), r = Math.abs(rng.gauss()) * R * 0.12;
      put(d[0] * r, d[1] * r, d[2] * r, BLUE, 400, 0);
    }
    for (let i = 0; i < n * 0.25; i++) {
      const c = clumps[Math.floor(rng.next() * clumps.length)];
      dust(c.x + rng.gauss() * c.s * 1.2, c.y + rng.gauss() * c.s * 0.5, c.z + rng.gauss() * c.s * 1.2, R * rng.range(0.05, 0.14), rng.range(0.3, 0.7));
    }
    if (o.extra && o.extra.pillars) {
      // Columns of dense dust, lit along their tips.
      for (let p = 0; p < 3; p++) {
        const bx = (p - 1) * R * 0.18, bz = rng.gauss() * R * 0.05, h = R * rng.range(0.25, 0.5);
        for (let k = 0; k < 220; k++) {
          const t = k / 220;
          const w = R * 0.035 * (1 - t * 0.6);
          dust(bx + rng.gauss() * w, -R * 0.3 + t * h, bz + rng.gauss() * w, w * 1.6, 0.85);
          if (t > 0.85) put(bx + rng.gauss() * w, -R * 0.3 + t * h + w, bz, H_ALPHA, 2, w * 1.2);
        }
      }
    }
  }
  // Normalise light to the object's integrated luminosity.
  let total = 0;
  for (let i = 0; i < L.length; i++) if (!isStar[i]) total += L[i];
  const k = deepLuminosity(o) / (total || 1);
  for (let i = 0; i < L.length; i++) if (!isStar[i]) L[i] *= k; else L[i] *= 50;
  return {
    pos: new Float32Array(P), col: new Float32Array(C), lum: new Float32Array(L), size: new Float32Array(S), count: L.length,
    dpos: new Float32Array(D), dsize: new Float32Array(DS), dop: new Float32Array(DO), dustCount: DO.length
  };
}

function dir(rng) {
  const z = rng.next() * 2 - 1, t = rng.next() * Math.PI * 2, s = Math.sqrt(1 - z * z);
  return [s * Math.cos(t), z, s * Math.sin(t)];
}
