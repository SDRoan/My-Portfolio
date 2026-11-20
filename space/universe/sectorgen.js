// Procedural stars for one sector cell. Pure, deterministic, worker-safe.
//
// A galaxy is never stored star by star. Space is cut into cubic cells on
// three levels, each holding a disjoint slice of the stellar population:
//   level 0 — 20 ly cells:   dwarfs (M, K, G, F) and white dwarfs
//   level 1 — 250 ly cells:  A and late-B stars, red giants
//   level 2 — 1500 ly cells: O and early-B stars, supergiants
// Faint stars are only ever needed close by, so they live in small cells near
// the observer; luminous ones are visible far away, so their cells are large.
// Counts come from the galaxy's density field (galaxymodel.js) and the
// solar-neighbourhood luminosity function; the same cell always produces the
// same stars, because everything is seeded from (galaxy, level, cell).

import { Rng, hashInts } from "../engine/rng.js";
import { density } from "./galaxymodel.js";

export const LEVEL_SIZE = [20, 250, 1500];
export const N_LOCAL = 0.004;            // stars per ly³ near the Sun

// [code, label, fraction, absV range, Teff range, level, young]
export const CLASSES = [
  [0, "M dwarf", 0.73, [9, 16], [2400, 3800], 0, false],
  [1, "K dwarf", 0.12, [5.9, 8.8], [3900, 5200], 0, false],
  [2, "G dwarf", 0.075, [4.4, 5.9], [5300, 6000], 0, false],
  [3, "F dwarf", 0.03, [2.5, 4.4], [6000, 7400], 0, false],
  [4, "white dwarf", 0.06, [10, 15], [5000, 30000], 0, false],
  [5, "A star", 0.006, [0.6, 2.5], [7500, 10000], 1, false],
  [6, "late B star", 0.0011, [-1.2, 0.6], [10500, 15000], 1, true],
  [7, "red giant", 0.004, [-1.5, 1.2], [3600, 5000], 1, false],
  [8, "early B star", 0.00009, [-4.5, -1.2], [15000, 30000], 2, true],
  [9, "O star", 0.0000025, [-6.5, -4.5], [30000, 45000], 2, true],
  [10, "red supergiant", 0.000003, [-7.5, -5], [3400, 4100], 2, true],
  [11, "blue supergiant", 0.0000015, [-8.5, -6], [12000, 30000], 2, true]
];

// opts: { galaxyParams, level, cx, cy, cz, galaxyId, excludeSol: [x,y,z] | null,
//         solCatalogLimit: true, maxPerCell }
export function generateCell(opts) {
  const { level, cx, cy, cz } = opts;
  const p = opts.galaxyParams;
  const L = LEVEL_SIZE[level];
  const ox = cx * L, oy = cy * L, oz = cz * L;
  const mx = ox + L / 2, my = oy + L / 2, mz = oz + L / 2;
  const rng = new Rng(hashInts(opts.galaxyId, level * 7919 + cx, cy, cz));
  const vol = L * L * L;
  const nOld = density(p, mx, my, mz, false);
  const nYoung = density(p, mx, my, mz, true);

  const out = { pos: [], absMag: [], teff: [], cls: [], seed: [] };
  const cap = opts.maxPerCell || 4000;
  for (const c of CLASSES) {
    if (c[5] !== level) continue;
    const mean = N_LOCAL * c[2] * vol * (c[6] ? nYoung : nOld);
    const n = Math.min(cap, rng.poisson(mean));
    for (let k = 0; k < n; k++) {
      // Lean positions toward the denser side of the cell, so the cell grid
      // never shows as steps in the star field.
      let x = 0, y = 0, z = 0, tries = 0;
      do {
        x = ox + rng.next() * L; y = oy + rng.next() * L; z = oz + rng.next() * L;
        tries++;
      } while (tries < 4 && rng.next() * 1.3 > density(p, x, y, z, c[6]) / Math.max(1e-6, c[6] ? nYoung : nOld));
      const absV = rng.range(c[3][0], c[3][1]);
      const t = rng.range(c[4][0], c[4][1]);
      // Leave out what the real catalogues already hold around the Sun.
      if (opts.excludeSol) {
        const d = Math.hypot(x - opts.excludeSol[0], y - opts.excludeSol[1], z - opts.excludeSol[2]);
        if (level === 0 && d < 65) continue;
        const dpc = d / 3.2616;
        if (absV + 5 * Math.log10(Math.max(dpc, 0.1)) - 5 < 6.5) continue;
      }
      out.pos.push(x - ox, y - oy, z - oz);
      out.absMag.push(absV);
      out.teff.push(t);
      out.cls.push(c[0]);
      out.seed.push(hashInts(opts.galaxyId, level, hashInts(cx, cy, cz), out.seed.length));
    }
  }
  return {
    key: level + ":" + cx + "," + cy + "," + cz,
    level, cx, cy, cz, origin: [ox, oy, oz],
    pos: new Float32Array(out.pos), absMag: new Float32Array(out.absMag),
    teff: new Float32Array(out.teff), cls: new Uint8Array(out.cls), seed: new Uint32Array(out.seed)
  };
}
