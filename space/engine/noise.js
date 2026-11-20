// Planet noise, written twice: here in JS for terrain geometry, and in
// noise-glsl.js for per-pixel shading. Both use the same integer lattice hash
// and the same fbm/ridge/crater recipes, so a continent seen from orbit (GLSL)
// is the same continent the terrain chunks raise when you descend (JS).
// Keep the two files in lockstep.

// pcg3d (Jarzynski & Olano 2020) on uint32 lanes.
function pcg3(x, y, z) {
  x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
  y = (Math.imul(y, 1664525) + 1013904223) >>> 0;
  z = (Math.imul(z, 1664525) + 1013904223) >>> 0;
  x = (x + Math.imul(y, z)) >>> 0; y = (y + Math.imul(z, x)) >>> 0; z = (z + Math.imul(x, y)) >>> 0;
  x ^= x >>> 16; y ^= y >>> 16; z ^= z >>> 16;
  x = (x + Math.imul(y, z)) >>> 0; y = (y + Math.imul(z, x)) >>> 0; z = (z + Math.imul(x, y)) >>> 0;
  return (x ^ y ^ z) >>> 0;
}

const INV = 1 / 4294967296;
function lattice(ix, iy, iz, seed) {
  return pcg3((ix + seed) >>> 0, (iy + Math.imul(seed, 3)) >>> 0, iz >>> 0) * INV;
}

// Value noise in [-1, 1].
export function vnoise(x, y, z, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = lattice(ix, iy, iz, seed), b = lattice(ix + 1, iy, iz, seed);
  const c = lattice(ix, iy + 1, iz, seed), d = lattice(ix + 1, iy + 1, iz, seed);
  const e = lattice(ix, iy, iz + 1, seed), f = lattice(ix + 1, iy, iz + 1, seed);
  const g = lattice(ix, iy + 1, iz + 1, seed), h = lattice(ix + 1, iy + 1, iz + 1, seed);
  const x1 = a + (b - a) * ux, x2 = c + (d - c) * ux, x3 = e + (f - e) * ux, x4 = g + (h - g) * ux;
  const y1 = x1 + (x2 - x1) * uy, y2 = x3 + (x4 - x3) * uy;
  return (y1 + (y2 - y1) * uz) * 2 - 1;
}

export function fbm(x, y, z, seed, oct) {
  let sum = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise(x * f + i * 17.13, y * f + i * 9.71, z * f + i * 3.37, seed + i);
    f *= 2.03; amp *= 0.5;
  }
  return sum;
}

export function ridged(x, y, z, seed, oct) {
  let sum = 0, amp = 0.5, f = 1, w = 1;
  for (let i = 0; i < oct; i++) {
    let n = 1 - Math.abs(vnoise(x * f + i * 5.17, y * f + i * 11.3, z * f + i * 7.91, seed + 31 + i));
    n *= n * w;
    w = Math.min(1, n * 2);
    sum += amp * n;
    f *= 2.07; amp *= 0.5;
  }
  return sum;
}

// Craters: one candidate per lattice cell, bowl with a raised rim. Returns a
// height offset (negative in the bowl).
export function craters(x, y, z, seed, freq) {
  x *= freq; y *= freq; z *= freq;
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let h = 0;
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const cx = ix + dx, cy = iy + dy, cz = iz + dz;
    const r0 = lattice(cx, cy, cz, seed + 101);
    if (r0 > 0.45) continue;                                  // not every cell has one
    const px = cx + lattice(cx, cy, cz, seed + 102), py = cy + lattice(cx, cy, cz, seed + 103), pz = cz + lattice(cx, cy, cz, seed + 104);
    const rad = 0.15 + 0.35 * lattice(cx, cy, cz, seed + 105);
    const d = Math.hypot(x - px, y - py, z - pz) / rad;
    if (d < 1) h += (d * d - 1) * 0.6;                        // bowl
    else if (d < 1.6) { const t = (d - 1) / 0.6; h += 0.25 * (1 - t) * (1 - t); }   // rim
  }
  return h;
}

// The shared terrain recipe. p is a unit vector; returns roughly [-1, 1].
// params: { seed, cont, mount, crater, craterFreq, warp }; detail adds octaves
// for terrain seen up close.
export function terrainHeight(px, py, pz, P, detail = 0) {
  const s = P.seed;
  const wf = P.cont;
  const wx = fbm(px * wf + 3.1, py * wf, pz * wf, s + 7, 3) * P.warp;
  const qx = px + wx, qy = py + wx * 0.7, qz = pz - wx * 0.4;
  const c = fbm(qx * P.cont, qy * P.cont, qz * P.cont, s, 7 + detail);
  const m = ridged(qx * P.cont * 3.1, qy * P.cont * 3.1, qz * P.cont * 3.1, s, 6 + detail);
  let h = c * 1.4 + m * P.mount * Math.min(1, Math.max(0, (c + 0.05) * 3));
  if (P.crater > 0) {
    h += P.crater * (craters(px, py, pz, s, P.craterFreq) + 0.5 * craters(px, py, pz, s + 9, P.craterFreq * 3.3)
      + (detail > 0 ? 0.22 * craters(px, py, pz, s + 17, P.craterFreq * 11.7) : 0));
  }
  return h;
}
