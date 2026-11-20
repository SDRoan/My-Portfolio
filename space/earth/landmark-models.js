// Approximate structural models for a few landmarks that a footprint
// extrusion can't represent, drawn at their real location from published
// dimensions (space/data/earth/landmark-overrides.json → landmarks.json).
// Original, simplified geometry: nothing here is traced from imagery or from
// any proprietary model. Each model says so in the landmark panel
// ("REAL LOCATION + … + APPROXIMATE …").
//
// Runs inside the surface worker with the tile's own ground and frame
// functions (city-core.js), so models sit on the same terrain as everything
// else. Heights: "Asl" values are metres above sea level; others are above
// the local ground.

import earcut from "../vendor/earcut.js";

const D2R = Math.PI / 180;

// Geometry writer around a model anchor: (s along the axis, t across to the
// right, z above sea level) → tile-frame point.
function frame(ctx, m) {
  const la0 = m.anchor.lat, lo0 = m.anchor.lon, br = (m.bearing || 0) * D2R, k = 111320 * Math.cos(la0 * D2R);
  const ll = (s, t) => { const dE = s * Math.sin(br) + t * Math.cos(br), dN = s * Math.cos(br) - t * Math.sin(br); return [la0 + dN / 111320, lo0 + dE / k]; };
  const gcache = new Map();
  const g = (la, lo) => { const key = la.toFixed(7) + "," + lo.toFixed(7); let v = gcache.get(key); if (!v) { v = ctx.ground(la, lo); gcache.set(key, v); } return v; };
  const P = (s, t, z) => { const [la, lo] = ll(s, t); return ctx.at(g(la, lo), z); };
  const groundAt = (s, t) => { const [la, lo] = ll(s, t); return g(la, lo).h; };
  return { ll, P, groundAt, g };
}

// Triangles with a normal; `out` = a point the face should look away from
// (solids), or null for thin surfaces (both sides are written).
function tri(B, a, b, c, col, out) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz);
  if (l < 1e-9) return;
  nx /= l; ny /= l; nz /= l;
  if (out) {
    const mx = (a[0] + b[0] + c[0]) / 3 - out[0], my = (a[1] + b[1] + c[1]) / 3 - out[1], mz = (a[2] + b[2] + c[2]) / 3 - out[2];
    if (nx * mx + ny * my + nz * mz < 0) { [b, c] = [c, b]; nx = -nx; ny = -ny; nz = -nz; }
  }
  const i = B.v(a, [nx, ny, nz], col, -1, -1); B.v(b, [nx, ny, nz], col, -1, -1); B.v(c, [nx, ny, nz], col, -1, -1);
  B.I.push(i, i + 1, i + 2);
  if (!out) { const j = B.v(a, [-nx, -ny, -nz], col, -1, -1); B.v(c, [-nx, -ny, -nz], col, -1, -1); B.v(b, [-nx, -ny, -nz], col, -1, -1); B.I.push(j, j + 1, j + 2); }
}
const quad = (B, a, b, c, d, col, out) => { tri(B, a, b, c, col, out); tri(B, a, c, d, col, out); };
const mid = (...p) => { const r = [0, 0, 0]; for (const q of p) { r[0] += q[0] / p.length; r[1] += q[1] / p.length; r[2] += q[2] / p.length; } return r; };

// A closed prism between two points in (s, t, z), with a w × h section.
function beam(B, F, a, b, w, h, col) {
  const ds = b[0] - a[0], dt = b[1] - a[1], dz = b[2] - a[2], L = Math.hypot(ds, dt, dz);
  if (L < 0.01) return;
  // side: horizontal and perpendicular to the beam (d × z); up: side × d.
  const d = [ds / L, dt / L, dz / L];
  let side = [d[1], -d[0], 0];
  const sl = Math.hypot(side[0], side[1]);
  side = sl < 1e-6 ? [0, 1, 0] : [side[0] / sl, side[1] / sl, 0];
  const upv = [side[1] * d[2] - side[2] * d[1], side[2] * d[0] - side[0] * d[2], side[0] * d[1] - side[1] * d[0]];
  const corner = (p, i) => { const sx = (i & 1 ? 0.5 : -0.5) * w, sy = (i & 2 ? 0.5 : -0.5) * h; return F.P(p[0] + side[0] * sx + upv[0] * sy, p[1] + side[1] * sx + upv[1] * sy, p[2] + upv[2] * sy); };
  const A = [0, 1, 3, 2].map((i) => corner(a, i)), Bq = [0, 1, 3, 2].map((i) => corner(b, i));
  const c = mid(...A, ...Bq);
  for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; quad(B, A[i], A[j], Bq[j], Bq[i], col, c); }
  quad(B, A[0], A[1], A[2], A[3], col, c); quad(B, Bq[0], Bq[1], Bq[2], Bq[3], col, c);
}
// An axis-aligned box in (s, t): centre, size along/across, z from–to.
function box(B, F, s, t, ls, lt, z0, z1, col) {
  const p = [[s - ls / 2, t - lt / 2], [s + ls / 2, t - lt / 2], [s + ls / 2, t + lt / 2], [s - ls / 2, t + lt / 2]];
  const lo = p.map(([a, b]) => F.P(a, b, z0)), hi = p.map(([a, b]) => F.P(a, b, z1)), c = F.P(s, t, (z0 + z1) / 2);
  for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; quad(B, lo[i], lo[j], hi[j], hi[i], col, c); }
  quad(B, hi[0], hi[1], hi[2], hi[3], col, c); quad(B, lo[0], lo[1], lo[2], lo[3], col, c);
}
// A collision prism for the walker (local east/north metres, flat top).
function footBox(ctx, F, s, t, ls, lt, top) {
  if (!ctx.foot) return;
  const pts = [[s - ls / 2, t - lt / 2], [s + ls / 2, t - lt / 2], [s + ls / 2, t + lt / 2], [s - ls / 2, t + lt / 2]].map(([a, b]) => ctx.en(F.P(a, b, 0)));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { ctx.foot.pts.push(x, y); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  ctx.foot.offs.push(ctx.foot.pts.length / 2); ctx.foot.top.push(top); ctx.foot.bbox.push(x0, y0, x1, y1);
}

// ── models ──

// Ahsan Manzil: octagonal drum and lotus-bud ("kumud kali") dome.
function dome(ctx, m) {
  const F = frame(ctx, m), B = ctx.B, g0 = F.groundAt(0, 0), col = m.colour || [0.6, 0.35, 0.36];
  const r = m.drumM / 2, n = 8, z0 = g0 + m.baseM - 0.5, z1 = g0 + m.drumTopM, top = g0 + m.topM;
  const ring = (rad, z) => Array.from({ length: n }, (_, i) => { const a = (i + 0.5) / n * 2 * Math.PI; return F.P(rad * Math.cos(a), rad * Math.sin(a), z); });
  const c = F.P(0, 0, (z0 + top) / 2);
  const lo = ring(r, z0), hi = ring(r, z1);
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; quad(B, lo[i], lo[j], hi[j], hi[i], col, c); }
  // Bud: swells slightly above the drum, then draws in to a point.
  let prev = ring(r * 0.96, z1);
  const steps = 7;
  for (let k = 1; k <= steps; k++) {
    const f = k / steps, rad = r * 0.96 * (1 + 0.12 * Math.sin(Math.PI * Math.min(1, f * 1.6))) * Math.cos(f * Math.PI / 2) ** 0.8, z = z1 + (top - 1.2 - z1) * f;
    const cur = k === steps ? Array(n).fill(F.P(0, 0, top - 1.2)) : ring(rad, z);
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; if (k === steps) tri(B, prev[i], prev[j], cur[0], col, c); else quad(B, prev[i], prev[j], cur[j], cur[i], col, c); }
    prev = cur;
  }
  beam(B, F, [0, 0, top - 1.4], [0, 0, top], 0.35, 0.35, [0.5, 0.42, 0.2]);                     // finial
}

// Sydney Opera House: podium on the real outline, and sail shells.
function operaShells(ctx, m) {
  const F = frame(ctx, m), B = ctx.B;
  const L = m.lengthM, W = m.widthM, gz = F.groundAt(0, 0), zP = gz + m.podiumM;
  // Podium: the real outline (lat/lon ring), extruded.
  const ring = m.ring, n = ring.length / 2;
  const gs = []; for (let i = 0; i < n; i++) gs.push(F.g(ring[i * 2], ring[i * 2 + 1]));
  const pc = ctx.at(F.g(m.anchor.lat, m.anchor.lon), zP - m.podiumM / 2);
  const stone = [0.42, 0.34, 0.29], white = m.colour || [0.63, 0.62, 0.58], glass = [0.05, 0.06, 0.075];
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; quad(B, ctx.at(gs[i], gz - 2), ctx.at(gs[j], gz - 2), ctx.at(gs[j], zP), ctx.at(gs[i], zP), stone, pc); }
  const flat = []; for (const gi of gs) { const q = ctx.en(ctx.at(gi, zP)); flat.push(q[0], q[1]); }
  const tr = earcut(flat), U = ctx.U, base = B.n;
  for (const gi of gs) B.v(ctx.at(gi, zP), U, stone, -1, -1);
  for (let k = 0; k < tr.length; k += 3) {
    const a = tr[k], b = tr[k + 1], c = tr[k + 2];
    const cr = (flat[b * 2] - flat[a * 2]) * (flat[c * 2 + 1] - flat[a * 2 + 1]) - (flat[b * 2 + 1] - flat[a * 2 + 1]) * (flat[c * 2] - flat[a * 2]);
    if (cr >= 0) B.I.push(base + a, base + b, base + c); else B.I.push(base + a, base + c, base + b);
  }
  if (ctx.foot) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < flat.length; i += 2) { ctx.foot.pts.push(flat[i], flat[i + 1]); x0 = Math.min(x0, flat[i]); x1 = Math.max(x1, flat[i]); y0 = Math.min(y0, flat[i + 1]); y1 = Math.max(y1, flat[i + 1]); }
    ctx.foot.offs.push(ctx.foot.pts.length / 2); ctx.foot.top.push(zP); ctx.foot.bbox.push(x0, y0, x1, y1);
  }
  // A shell: a mouth (pointed arch) at s = sF facing `face` (±1 along the
  // axis), its back running down to the podium a depth D behind; two curved
  // halves meeting at the ridge.
  const H = m.topAslM - zP;
  const shell = (tc, sF, face, D, h, hw) => {
    const zt = zP + h, back = [sF - face * D, tc, zP];
    const M = (a, sg) => [sF + face * 0.04 * D * a, tc + sg * hw * Math.cos(a * Math.PI / 2), zP + h * Math.sin(a * Math.PI / 2)];
    const N = 8;
    for (const sg of [-1, 1]) {
      const S = (a, b) => { const m0 = M(a, sg); const bu = Math.sin(Math.PI * b) * 0.1 * D * (1 - 0.6 * a); return [back[0] + (m0[0] - back[0]) * b, back[1] + (m0[1] - back[1]) * b + sg * bu * 0.8, back[2] + (m0[2] - back[2]) * b + bu * 0.6]; };
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
        const p = (a, b) => { const q = S(a, b); return F.P(q[0], q[1], q[2]); };
        quad(B, p(i / N, j / N), p((i + 1) / N, j / N), p((i + 1) / N, (j + 1) / N), p(i / N, (j + 1) / N), white, null);
      }
    }
    // Glass wall in the mouth, set back a little.
    const sb = sF - face * 2.5, cen = F.P(sb, tc, zP);
    for (let i = 0; i < 2 * N; i++) {
      const a0 = i / (2 * N), a1 = (i + 1) / (2 * N);
      const q = (a) => { const sg = a < 0.5 ? -1 : 1, aa = a < 0.5 ? a * 2 : (1 - a) * 2, p = M(aa, sg); return F.P(sb, p[1], p[2] - 0.5); };
      tri(B, cen, q(a0), q(a1), glass, null);
    }
  };
  // Two halls side by side (the Concert Hall to the west, the Joan Sutherland
  // Theatre to the east); shells nested along each hall, the tallest over the
  // auditorium; the restaurant pair at the southern end.
  const halls = [[-0.19 * W, 1.0], [0.19 * W, 0.88]];
  for (const [tc, k] of halls) {
    shell(tc, -0.16 * L, -1, 0.12 * L, H * 0.55 * k, 0.14 * W);
    shell(tc, 0.12 * L, 1, 0.27 * L, H * 1.0 * k, 0.17 * W);
    shell(tc, 0.27 * L, 1, 0.19 * L, H * 0.78 * k, 0.15 * W);
    shell(tc, 0.40 * L, 1, 0.14 * L, H * 0.52 * k, 0.12 * W);
  }
  shell(-0.24 * W, -0.36 * L, -1, 0.08 * L, H * 0.3, 0.07 * W);
  shell(-0.24 * W, -0.27 * L, 1, 0.07 * L, H * 0.24, 0.06 * W);
}

// Sydney Harbour Bridge: two arch trusses, hangers, deck, four pylons.
function archBridge(ctx, m) {
  const F = frame(ctx, m), B = ctx.B, col = m.colour || [0.2, 0.21, 0.22], granite = [0.45, 0.4, 0.33];
  const S = m.spanM / 2, top = m.archTopAslM, deck = m.deckAslM, rib = 15;
  const zU = (s) => top - (top - (deck + 14)) * (s / S) ** 2;                 // upper chord
  const zL = (s) => (top - 18) - ((top - 18) - 4) * (s / S) ** 2;            // lower chord, springing near the water
  const N = 24;
  for (const t of [-rib, rib]) {
    for (let i = 0; i < N; i++) {
      const s0 = -S + 2 * S * i / N, s1 = -S + 2 * S * (i + 1) / N;
      beam(B, F, [s0, t, zU(s0)], [s1, t, zU(s1)], 2.6, 3.2, col);
      beam(B, F, [s0, t, zL(s0)], [s1, t, zL(s1)], 2.8, 4, col);
      beam(B, F, [s0, t, zL(s0)], [s0, t, zU(s0)], 1.4, 1.4, col);
      beam(B, F, [s0, t, zL(s0)], [s1, t, zU(s1)], 1.1, 1.1, col);           // diagonal
      if (zL(s0) > deck + 3) beam(B, F, [s0, t, deck + 1], [s0, t, zL(s0)], 0.8, 0.8, col);   // hanger
    }
    beam(B, F, [S, t, zL(S)], [S, t, zU(S)], 1.4, 1.4, col);
  }
  for (let i = 1; i < N; i += 2) { const s = -S + 2 * S * i / N; beam(B, F, [s, -rib, zU(s)], [s, rib, zU(s)], 1, 1, col); }   // top bracing
  // Deck (the real roads are lifted onto it: deckAt below), and the pylons.
  box(B, F, 0, 0, 2 * S + 40, m.widthM, deck - 3, deck - 0.3, col);
  for (const sgn of [-1, 1]) for (const t of [-1, 1]) {
    const s = sgn * (S + 16), gz = F.groundAt(s, t * 31);
    box(B, F, s, t * 31, 26, 15, Math.min(gz, 0) - 2, m.pylonM, granite);
    footBox(ctx, F, s, t * 31, 26, 15, m.pylonM);
  }
}

// Brooklyn Bridge: two masonry towers, deck, four main cables, suspenders.
function suspension(ctx, m) {
  const F = frame(ctx, m), B = ctx.B, stone = m.colour || [0.52, 0.47, 0.4], steel = [0.32, 0.3, 0.28];
  const S = m.mainSpanM / 2, A = S + m.sideSpanM, deck = m.deckAslM, T = m.towerAslM;
  const deckZ = (s) => Math.abs(s) <= S ? deck + 2 * (1 - (s / S) ** 2) : deck - (deck * 0.45) * ((Math.abs(s) - S) / m.sideSpanM);
  // Towers with two pointed arches (an opening for each roadway).
  for (const sgn of [-1, 1]) {
    const s = sgn * S, w = m.towerW, d = m.towerD;
    box(B, F, s, 0, d, w, -6, deck - 4, stone);                                 // pier
    for (const t of [-w / 2 + 4.5, 0, w / 2 - 4.5]) box(B, F, s, t, d, t === 0 ? 7 : 9, deck - 4, T - 12, stone);
    box(B, F, s, 0, d, w, T - 12, T, stone);                                    // above the arches
    footBox(ctx, F, s, 0, d, w, T);
    box(B, F, sgn * A, 0, 40, 36, -2, 26, stone);                               // anchorage
  }
  // Deck in pieces, following the profile.
  const N = 48;
  for (let i = 0; i < N; i++) { const s0 = -A + 2 * A * i / N, s1 = -A + 2 * A * (i + 1) / N; beam(B, F, [s0, 0, deckZ(s0) - 1.5], [s1, 0, deckZ(s1) - 1.5], m.widthM, 3, steel); }
  // Cables: main span a parabola tower top → deck; side spans to the anchorages.
  const cz = (s) => Math.abs(s) <= S ? (T - 6) - ((T - 6) - (deck + 3)) * (1 - (s / S) ** 2) : (T - 6) - ((T - 6) - 22) * ((Math.abs(s) - S) / m.sideSpanM);
  for (const t of [-m.widthM / 2 + 0.6, -3.5, 3.5, m.widthM / 2 - 0.6]) {
    for (let i = 0; i < N; i++) { const s0 = -A + 2 * A * i / N, s1 = -A + 2 * A * (i + 1) / N; beam(B, F, [s0, t, cz(s0)], [s1, t, cz(s1)], 0.6, 0.6, steel); }
    for (let s = -S + 15; s < S; s += 15) beam(B, F, [s, t, deckZ(s)], [s, t, cz(s)], 0.15, 0.15, steel);
  }
}

// Tower Bridge: the two high-level walkways between the real towers.
function walkways(ctx, m) {
  const F = frame(ctx, m), B = ctx.B, col = m.colour || [0.3, 0.38, 0.45];
  const L = m.lengthM / 2, z = m.walkwayAslM;
  for (const t of [-6.5, 6.5]) box(B, F, 0, t, 2 * L, m.widthM, z, z + m.walkwayH, col);
}

// Christ the Redeemer: the pedestal on its real outline (OpenStreetMap's
// chamfered square of the chapel inside the base), then an original simplified
// figure to the published dimensions: robe, shoulders, outstretched arms with
// the hanging sleeves, hands, slightly bowed head. s runs along the facing
// direction, t along the arms.
function statue(ctx, m) {
  const F = frame(ctx, m), B = ctx.B, col = m.colour || [0.62, 0.62, 0.58], stone = [0.5, 0.48, 0.44];
  const gz = F.groundAt(0, 0), z0 = gz + m.pedestalM, H = m.statueM, top = z0 + H;
  const c = F.P(0, 0, (gz + top) / 2);
  // Pedestal: the mapped outline if there is one, else an 8.5 m square; a low plinth around it.
  const ring = m.ring && m.ring.length >= 6 ? m.ring : null;
  const footprint = ring ? Array.from({ length: ring.length / 2 }, (_, i) => F.g(ring[i * 2], ring[i * 2 + 1])) : null;
  const prism = (pts, za, zb, colr, grow) => {
    const n = pts.length, lo = [], hi = [];
    for (const g of pts) { lo.push(ctx.at(g, za)); hi.push(ctx.at(g, zb)); }
    // A wider plinth: each ring scaled about its own centre.
    if (grow) for (const A of [lo, hi]) { const cc = mid(...A); for (const q of A) for (let k = 0; k < 3; k++) q[k] = cc[k] + (q[k] - cc[k]) * grow; }
    const cc = mid(...lo, ...hi);
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; quad(B, lo[i], lo[j], hi[j], hi[i], colr, cc); }
    const ct = mid(...hi); for (let i = 0; i < n; i++) tri(B, hi[i], hi[(i + 1) % n], ct, colr, cc);
  };
  if (footprint) { prism(footprint, gz - 2, gz + 0.8, stone, 1.45); prism(footprint, gz + 0.8, z0, stone, 1.0); }
  else { box(B, F, 0, 0, 12, 12, gz - 2, gz + 0.8, stone); box(B, F, 0, 0, 8.5, 8.5, gz + 0.8, z0, stone); }
  footBox(ctx, F, 0, 0, 8.5, 8.5, z0);
  // A lathe through elliptical rings: [height fraction, half-width along the arms, half-depth, forward offset].
  const lathe = (rings, n, colr) => {
    let prev = null;
    for (const [f, ht, hs, so] of rings) {
      const z = z0 + H * f, cur = [];
      for (let i = 0; i < n; i++) { const a = (i / n) * 2 * Math.PI; cur.push(F.P(so + hs * Math.cos(a), ht * Math.sin(a), z)); }
      if (prev) for (let i = 0; i < n; i++) { const j = (i + 1) % n; quad(B, prev[i], prev[j], cur[j], cur[i], colr, c); }
      prev = cur;
    }
    const last = rings[rings.length - 1], apex = F.P(last[3], 0, z0 + H * last[0] + 0.05);
    for (let i = 0; i < n; i++) tri(B, prev[i], prev[(i + 1) % n], apex, colr, c);
  };
  // Robe from the hem to the shoulders, the neck and the head (bowed slightly forward).
  lathe([[0, 2.3, 2.0, 0], [0.08, 2.45, 2.05, 0], [0.3, 2.3, 1.85, 0.05], [0.5, 2.2, 1.7, 0.1], [0.66, 2.55, 1.75, 0.1], [0.74, 3.0, 1.8, 0.05],
         [0.79, 2.9, 1.7, 0], [0.81, 0.95, 0.95, 0.15]], 20, col);
  lathe([[0.81, 0.9, 0.9, 0.2], [0.84, 1.25, 1.35, 0.35], [0.9, 1.35, 1.45, 0.5], [0.95, 1.15, 1.25, 0.55], [0.985, 0.6, 0.65, 0.5]], 14, col);
  // Arms: tapering beams from the shoulders out to 14 m either side, nearly horizontal.
  const zs = z0 + H * 0.765, half = m.armSpanM / 2;
  for (const sg of [-1, 1]) {
    const seg = [[2.2, 2.3, 2.2], [6, 1.9, 1.95], [10, 1.6, 1.7], [half - 1.2, 1.3, 1.45]];
    for (let k = 0; k < seg.length - 1; k++) {
      const [ta, wa, ha] = seg[k], [tb, wb, hb] = seg[k + 1];
      beam(B, F, [0.15, sg * ta, zs - 0.02 * ta], [0.15, sg * tb, zs - 0.02 * tb], (wa + wb) / 2, (ha + hb) / 2, col);
    }
    // Hands, turned slightly forward.
    beam(B, F, [0.2, sg * (half - 1.3), zs - 0.3], [0.45, sg * half, zs - 0.6], 0.9, 1.6, col);
    // The sleeve: cloth hanging from the forearm, a thin tapered sheet.
    const S1 = F.P(0.15, sg * 3.0, zs - 1.0), S2 = F.P(0.15, sg * (half - 2.0), zs - 1.0), S3 = F.P(0.15, sg * (half - 3.5), zs - 4.2), S4 = F.P(0.15, sg * 3.0, zs - 6.5);
    quad(B, S1, S2, S3, S4, col, null);
  }
}

const BUILDERS = { dome, "opera-shells": operaShells, "arch-bridge": archBridge, "suspension-bridge": suspension, walkways, statue };

// ctx: { B, ground, at, en, U, foot }
export function addLandmarkModels(ctx, models) {
  let n = 0;
  for (const m of models || []) { const f = BUILDERS[m.type]; if (f) { f(ctx, m); n++; } }
  return n;
}

// The deck height (m above sea level) a modelled bridge gives a bridge-flagged
// road at (lat, lon), or null: the real road geometry is lifted onto the deck.
export function deckAt(models, lat, lon) {
  for (const m of models || []) {
    if (m.type !== "arch-bridge" && m.type !== "suspension-bridge") continue;
    const br = m.bearing * D2R, k = 111320 * Math.cos(m.anchor.lat * D2R);
    const dE = (lon - m.anchor.lon) * k, dN = (lat - m.anchor.lat) * 111320;
    const s = dE * Math.sin(br) + dN * Math.cos(br), t = dE * Math.cos(br) - dN * Math.sin(br);
    if (Math.abs(t) > m.widthM / 2 + 6) continue;
    if (m.type === "arch-bridge") {
      const S = m.spanM / 2 + 20;
      if (Math.abs(s) <= S) return m.deckAslM;
      if (Math.abs(s) <= S + 400) return { blend: (Math.abs(s) - S) / 400, z: m.deckAslM };
    } else {
      const S = m.mainSpanM / 2, A = S + m.sideSpanM;
      if (Math.abs(s) <= S) return m.deckAslM + 2 * (1 - (s / S) ** 2);
      if (Math.abs(s) <= A) return m.deckAslM - m.deckAslM * 0.45 * ((Math.abs(s) - S) / m.sideSpanM);
      if (Math.abs(s) <= A + 250) return { blend: (Math.abs(s) - A) / 250, z: m.deckAslM * 0.55 };
    }
  }
  return null;
}
