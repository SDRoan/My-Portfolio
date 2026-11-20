// Builds the geometry of one Earth map tile in a surface worker: buildings
// extruded from their real footprints, roads draped on the terrain, lakes as
// flat water — all from real latitude/longitude, positioned on the same
// ground function the terrain and collision use (surface-core.js).
//
// Output is batched per tile: one buffer set for all its buildings, one for
// roads, one for water, plus simplified footprint prisms for walking
// collision. Positions are relative to the tile's centre on the ground, in
// the body's own frame, so they turn with the Earth and stay float32-precise.

import earcut from "../vendor/earcut.js";
import { decodeTile } from "./tile-format.js";
import { dirFromLatLon } from "../universe/surface-core.js";
import { addLandmarkModels, deckAt } from "./landmark-models.js";

const D2R = Math.PI / 180;

// Road widths (m) by class when the data gives none; heights above the ground
// (m) keep classes from fighting each other and the terrain.
const ROAD_W = [11, 10, 9, 8, 7, 6, 5.5, 4, 5, 5, 2, 2, 1.5, 2, 3, 3.2, 2.6, 45, 23, 60];
const ROAD_UP = [0.42, 0.42, 0.4, 0.38, 0.36, 0.34, 0.34, 0.3, 0.32, 0.3, 0.26, 0.26, 0.24, 0.26, 0.24, 0.45, 0.44, 0.35, 0.33, 0.2];
// Which features each level of detail keeps.
const LOD = [
  { minArea: 0, minH: 0, maxRoad: 18 },              // near: everything
  { minArea: 900, minH: 30, maxRoad: 4, keep: [15, 17, 19] },   // middle: large/tall buildings, tertiary and up, rail, runways, rivers
  { minArea: Infinity, minH: 90, maxRoad: 2, keep: [17, 19] }   // far: towers only, primary and up, runways, rivers
];

function hash(a, b) { let h = Math.imul(Math.round(a * 1e6) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.round(b * 1e6); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }

// Facade albedo (linear): residential brick/stucco, commercial concrete/glass,
// industrial metal, civic stone; tall buildings lean to glass and steel.
function buildingColor(cls, h, r) {
  const pick = (list) => list[Math.floor(r * list.length) % list.length];
  let c;
  if (h > 60) c = pick([[0.16, 0.2, 0.24], [0.22, 0.24, 0.26], [0.13, 0.16, 0.2], [0.3, 0.3, 0.29]]);
  else if (cls === 0) c = pick([[0.36, 0.18, 0.12], [0.45, 0.38, 0.3], [0.5, 0.46, 0.4], [0.3, 0.2, 0.15], [0.55, 0.52, 0.47]]);
  else if (cls === 1) c = pick([[0.4, 0.4, 0.4], [0.3, 0.32, 0.34], [0.48, 0.45, 0.4], [0.24, 0.27, 0.3]]);
  else if (cls === 2) c = pick([[0.5, 0.5, 0.48], [0.42, 0.43, 0.44], [0.55, 0.53, 0.5]]);
  else if (cls === 3) c = pick([[0.52, 0.45, 0.36], [0.45, 0.42, 0.38], [0.4, 0.3, 0.24]]);
  else c = pick([[0.42, 0.41, 0.4], [0.36, 0.35, 0.34]]);
  const k = (0.9 + 0.2 * hash(r, h)) * 0.65;              // facade albedo ≈ 0.1–0.35
  return [c[0] * k, c[1] * k, c[2] * k];
}

// Triangles facing up: counter-clockwise in (east, north), which with "up"
// makes a right-handed frame (earcut doesn't promise a winding).
function pushUp(I, base, tri, xy) {
  for (let k = 0; k < tri.length; k += 3) {
    const a = tri[k], b = tri[k + 1], c = tri[k + 2];
    const cr = (xy[b * 2] - xy[a * 2]) * (xy[c * 2 + 1] - xy[a * 2 + 1]) - (xy[b * 2 + 1] - xy[a * 2 + 1]) * (xy[c * 2] - xy[a * 2]);
    if (cr >= 0) I.push(base + a, base + b, base + c); else I.push(base + a, base + c, base + b);
  }
}

// Footprint area helper for the roof height estimate (lat/lon ring, degrees → m²).
function rings0(bd) { const r = bd.rings[0], out = []; const c = Math.cos(r[0] * D2R); for (let i = 0; i < r.length; i += 2) out.push(r[i + 1] * 111320 * c, r[i] * 111320); return out; }
function areaOf(xy) { let a = 0; for (let i = 0, n = xy.length / 2; i < n; i++) { const j = (i + 1) % n; a += xy[i * 2] * xy[j * 2 + 1] - xy[j * 2] * xy[i * 2 + 1]; } return a / 2; }

// Roofs from the data's roof shape (tile-format.js ROOF_SHAPE). P: the wall-top
// ring (3D, tile frame), xy: the same ring in local metres, U: up.
//   gabled / gambrel / saltbox / half-hipped (4-sided footprints): a ridge along the long side
//   skillion (4-sided): one slope
//   hipped / mansard, and the above on other footprints: slopes to a shrunken flat top
//   pyramidal: slopes to an apex · dome / onion / round: a curved cap
function addRoof(B, P, xy, U, shape, h, col) {
  const n = P.length;
  if (n > 2 && Math.abs(P[0][0] - P[n - 1][0]) + Math.abs(P[0][1] - P[n - 1][1]) + Math.abs(P[0][2] - P[n - 1][2]) < 0.01) { P = P.slice(0, -1); }
  const m = P.length;
  const C = [0, 0, 0]; for (const p of P) { C[0] += p[0] / m; C[1] += p[1] / m; C[2] += p[2] / m; }
  const up = (p, k) => [p[0] + U[0] * k, p[1] + U[1] * k, p[2] + U[2] * k];
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const inner = up(C, h * 0.3);
  const tri = (a, b, c) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const mx = (a[0] + b[0] + c[0]) / 3 - inner[0], my = (a[1] + b[1] + c[1]) / 3 - inner[1], mz = (a[2] + b[2] + c[2]) / 3 - inner[2];
    if (nx * mx + ny * my + nz * mz < 0) { [b, c] = [c, b]; nx = -nx; ny = -ny; nz = -nz; }
    const i0 = B.v(a, [nx, ny, nz], col, -1, -1); B.v(b, [nx, ny, nz], col, -1, -1); B.v(c, [nx, ny, nz], col, -1, -1);
    B.I.push(i0, i0 + 1, i0 + 2);
  };
  const quad = m === 4;
  if (quad && (shape === 1 || shape === 8 || shape === 10 || shape === 11 || shape === 6)) {
    // The long side: AB (and CD) if |AB| ≥ |BC|.
    const L = (i) => Math.hypot(xy[((i + 1) % 4) * 2] - xy[i * 2], xy[((i + 1) % 4) * 2 + 1] - xy[i * 2 + 1]);
    const s = L(0) >= L(1) ? 0 : 1;
    const A = P[s], Bq = P[(s + 1) % 4], Cq = P[(s + 2) % 4], D = P[(s + 3) % 4];
    if (shape === 6) {                                                    // skillion: CD raised
      const C2 = up(Cq, h), D2 = up(D, h);
      tri(A, Bq, C2); tri(A, C2, D2); tri(Bq, Cq, C2); tri(A, D2, D); tri(Cq, D, D2); tri(Cq, D2, C2);
      return;
    }
    const R1 = up(lerp(D, A, 0.5), h), R2 = up(lerp(Bq, Cq, 0.5), h);
    tri(A, Bq, R2); tri(A, R2, R1); tri(Cq, D, R1); tri(Cq, R1, R2);       // the two slopes
    tri(Bq, Cq, R2); tri(D, A, R1);                                       // gable ends
    return;
  }
  if (shape === 3) { const apex = up(C, h); for (let i = 0; i < m; i++) tri(P[i], P[(i + 1) % m], apex); return; }
  if (shape === 4 || shape === 5 || shape === 7) {
    // A cap of rings toward the centre (onion: bulging out first).
    const steps = 5;
    let prev = P;
    for (let k = 1; k <= steps; k++) {
      const t = k / steps, a = Math.PI / 2 * t;
      const scale = shape === 5 ? Math.max(0, Math.cos(a) * (1 + 0.25 * Math.sin(a * 2))) : Math.cos(a), z = h * Math.sin(a);
      const ring = P.map((p) => up(lerp(C, p, scale), z));
      for (let i = 0; i < m; i++) { const j = (i + 1) % m; tri(prev[i], prev[j], ring[j]); if (k < steps) tri(prev[i], ring[j], ring[i]); }
      prev = ring;
    }
    return;
  }
  // Hipped (and fallbacks): slopes up to the footprint shrunk by half, then a flat top.
  const top = P.map((p) => up(lerp(C, p, 0.5), h));
  for (let i = 0; i < m; i++) { const j = (i + 1) % m; tri(P[i], P[j], top[j]); tri(P[i], top[j], top[i]); }
  const flat = []; for (let i = 0; i < m; i++) flat.push(xy[i * 2], xy[i * 2 + 1]);
  const t2 = earcut(flat);
  for (let k = 0; k < t2.length; k += 3) tri(top[t2[k]], top[t2[k + 1]], top[t2[k + 2]]);
}

class Buf {
  constructor() { this.P = []; this.N = []; this.C = []; this.U = []; this.I = []; this.n = 0; }
  v(p, nrm, c, u, vv) { this.P.push(p[0], p[1], p[2]); this.N.push(nrm[0], nrm[1], nrm[2]); this.C.push(c[0], c[1], c[2]); this.U.push(u, vv); return this.n++; }
  out(transfer) {
    const r = { P: new Float32Array(this.P), N: new Float32Array(this.N), C: new Float32Array(this.C), U: new Float32Array(this.U), index: new Uint32Array(this.I) };
    transfer.push(r.P.buffer, r.N.buffer, r.C.buffer, r.U.buffer, r.index.buffer);
    return r;
  }
}

// tileBuf: the tile file (decompressed); opts: { lod, exclude: [{lat, lon, r}],
// models: the region's landmark models (landmark-models.js; drawn by the tile
// that holds their anchor, and lifting bridge roads onto modelled decks) }
export function buildCityTile(surface, tileBuf, opts = {}) {
  const t = decodeTile(new Uint8Array(tileBuf));
  const L = LOD[opts.lod || 0];
  const b = t.bounds, latC = (b.south + b.north) / 2, lonC = (b.west + b.east) / 2;
  // Tile frame: origin on the ground at the tile centre; up, east, north.
  const U = dirFromLatLon(latC, lonC);
  const E = [-Math.sin(lonC * D2R), 0, -Math.cos(lonC * D2R)];
  const Nn = [U[1] * E[2] - U[2] * E[1], U[2] * E[0] - U[0] * E[2], U[0] * E[1] - U[1] * E[0]];
  const rC = surface.radiusAt(U[0], U[1], U[2], 5);
  const O = [U[0] * rC, U[1] * rC, U[2] * rC];
  const ground = (lat, lon) => { const d = dirFromLatLon(lat, lon); return { d, r0: surface.baseRadius(d[0], d[1], d[2]), h: surface.heightAt(d[0], d[1], d[2], 5) }; };
  const at = (g, h) => { const r = g.r0 + h; return [g.d[0] * r - O[0], g.d[1] * r - O[1], g.d[2] * r - O[2]]; };
  const en = (p) => [p[0] * E[0] + p[1] * E[1] + p[2] * E[2], p[0] * Nn[0] + p[1] * Nn[1] + p[2] * Nn[2]];
  const excluded = (lat, lon) => (opts.exclude || []).some((x) => Math.hypot((lat - x.lat) * 111320, (lon - x.lon) * 111320 * Math.cos(lat * D2R)) < x.r);

  const B = new Buf(), R = new Buf(), Wt = new Buf();
  const foot = { pts: [], offs: [0], top: [], bbox: [] };
  const counts = [0, 0, 0, 0, 0];
  let nB = 0;

  for (const bd of t.buildings) {
    const outer = bd.rings[0];
    const n0 = outer.length / 2;
    if (n0 < 3) continue;
    let cla = 0, clo = 0;
    for (let i = 0; i < n0; i++) { cla += outer[i * 2]; clo += outer[i * 2 + 1]; }
    cla /= n0; clo /= n0;
    if (excluded(cla, clo)) continue;
    // Footprint in local metres (for area, orientation and the roof).
    const rings = bd.rings.map((ring) => {
      const m = ring.length / 2, g = [], xy = [];
      for (let i = 0; i < m; i++) { const gi = ground(ring[i * 2], ring[i * 2 + 1]); g.push(gi); const p = at(gi, 0); const q = en(p); xy.push(q[0], q[1]); }
      // Drop a closing point that repeats the first.
      if (m > 3 && Math.abs(xy[0] - xy[(m - 1) * 2]) < 0.01 && Math.abs(xy[1] - xy[(m - 1) * 2 + 1]) < 0.01) { g.pop(); xy.length -= 2; }
      return { g, xy };
    });
    const area = (xy) => { let a = 0; for (let i = 0, n = xy.length / 2; i < n; i++) { const j = (i + 1) % n; a += xy[i * 2] * xy[j * 2 + 1] - xy[j * 2] * xy[i * 2 + 1]; } return a / 2; };
    const A = Math.abs(area(rings[0].xy));
    if (A < 4 && !((bd.src === 0 || bd.src === 4) && bd.h > 30)) continue;      // a mapped spire or mast stays

    if (!(A >= L.minArea || bd.h >= L.minH)) continue;
    let gmin = Infinity;
    for (const gi of rings[0].g) gmin = Math.min(gmin, gi.h);
    const bottom = bd.minH > 0 ? gmin + bd.minH : gmin - 1.5;      // sink a little into sloping ground
    const top = gmin + Math.max(bd.h, bd.minH + 1);
    // A shaped roof (tile format v2) takes its height from the top of the
    // walls; without a mapped roof height, a conservative share of the width.
    const shape = bd.roof || 0;
    let roofH = 0;
    if (shape) {
      const A = Math.abs(areaOf(rings0(bd)));
      // A large footprint with a pyramidal roof and no roof height is a
      // pyramid (Giza) or a tapering tower: the roof is the whole building.
      if (shape === 3 && !(bd.roofH > 0) && A > 2000) roofH = (top - bottom) - 1;
      else if (bd.roofH > 0) roofH = Math.min(bd.roofH, (top - bottom) - 1);                  // mapped roof height, as given
      else roofH = Math.min(0.35 * (top - bottom), 0.3 * Math.sqrt(A), 0.6 * (top - bottom));   // estimated: conservative
    }
    const wallTop = top - roofH;
    const col = buildingColor(bd.cls, bd.h, hash(cla, clo));
    const style = bd.h > 60 ? 5 : bd.cls;
    const roofCol = [col[0] * 0.55, col[1] * 0.55, col[2] * 0.56];
    // Walls: outer ring counter-clockwise, holes clockwise, so normals face out.
    rings.forEach((ring, ri) => {
      const m = ring.xy.length / 2;
      const ccw = area(ring.xy) > 0;
      const flip = ri === 0 ? !ccw : ccw;
      let along = 0;
      for (let k = 0; k < m; k++) {
        const i = flip ? (m - k) % m : k, j = flip ? (m - k - 1 + m) % m : (k + 1) % m;
        const dx = ring.xy[j * 2] - ring.xy[i * 2], dy = ring.xy[j * 2 + 1] - ring.xy[i * 2 + 1];
        const len = Math.hypot(dx, dy);
        if (len < 0.05) continue;
        const nx = dy / len, ny = -dx / len;
        const nrm = [E[0] * nx + Nn[0] * ny, E[1] * nx + Nn[1] * ny, E[2] * nx + Nn[2] * ny];
        const gi = ring.g[i], gj = ring.g[j];
        // u carries the facade style (building class, or 5 for towers) in its
        // hundred-thousands; the shader splits it back out.
        const u0 = style * 100000 + along, u1 = u0 + len;
        const a = B.v(at(gi, bottom), nrm, col, u0, 0), c = B.v(at(gj, bottom), nrm, col, u1, 0);
        const d = B.v(at(gj, wallTop), nrm, col, u1, wallTop - bottom), e = B.v(at(gi, wallTop), nrm, col, u0, wallTop - bottom);
        B.I.push(a, c, d, a, d, e);
        along += len;
      }
    });
    if (shape && rings.length === 1 && roofH > 0.3) {
      addRoof(B, rings[0].g.map((gi) => at(gi, wallTop)), rings[0].xy, U, shape, roofH, roofCol);
      counts[bd.src]++; nB++;
      if ((opts.lod || 0) === 0 && bd.h >= 2) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let i = 0; i < rings[0].xy.length; i += 2) { const x = rings[0].xy[i], y = rings[0].xy[i + 1]; foot.pts.push(x, y); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        foot.offs.push(foot.pts.length / 2); foot.top.push(top); foot.bbox.push(x0, y0, x1, y1);
      }
      continue;
    }
    // Roof: the real footprint, triangulated with its holes.
    const flat = [], holes = [];
    rings.forEach((ring, ri) => { if (ri) holes.push(flat.length / 2); flat.push(...ring.xy); });
    const tri = earcut(flat, holes.length ? holes : null);
    const up = U;
    const all = rings.flatMap((ring) => ring.g);
    const base = B.n;
    for (const gi of all) B.v(at(gi, top), up, roofCol, -1, -1);
    pushUp(B.I, base, tri, flat);
    counts[bd.src]++; nB++;
    // Collision prism (outer ring, local metres) for the walker.
    if ((opts.lod || 0) === 0 && bd.h >= 2) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < rings[0].xy.length; i += 2) { const x = rings[0].xy[i], y = rings[0].xy[i + 1]; foot.pts.push(x, y); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      foot.offs.push(foot.pts.length / 2); foot.top.push(top); foot.bbox.push(x0, y0, x1, y1);
    }
  }

  // Landmark models anchored in this tile (all levels of detail).
  const here = (opts.models || []).filter((m) => m.anchor.lat >= b.south && m.anchor.lat < b.north && m.anchor.lon >= b.west && m.anchor.lon < b.east);
  if (here.length) nB += addLandmarkModels({ B, ground, at, en, U, foot: (opts.lod || 0) === 0 ? foot : null }, here);

  // Roads: ribbons on the ground, subdivided so they follow the terrain.
  let nR = 0;
  for (const rd of t.roads) {
    if (!(rd.cls <= L.maxRoad || (L.keep && L.keep.includes(rd.cls)))) continue;
    const pts = rd.pts, n = pts.length / 2;
    if (n < 2) continue;
    const half = (rd.width || ROAD_W[rd.cls] || 5) / 2, lift = ROAD_UP[rd.cls] || 0.3;
    const bridge = rd.flags & 1;
    // Dense polyline (≤ 12 m steps) with ground heights.
    const line = [];
    for (let i = 0; i < n - 1; i++) {
      const la0 = pts[i * 2], lo0 = pts[i * 2 + 1], la1 = pts[i * 2 + 2], lo1 = pts[i * 2 + 3];
      const dist = Math.hypot((la1 - la0) * 111320, (lo1 - lo0) * 111320 * Math.cos(la0 * D2R));
      const steps = Math.max(1, Math.ceil(dist / 12));
      for (let s = 0; s < steps; s++) { const f = s / steps; line.push([la0 + (la1 - la0) * f, lo0 + (lo1 - lo0) * f]); }
    }
    line.push([pts[(n - 1) * 2], pts[(n - 1) * 2 + 1]]);
    const gs = line.map(([la, lo]) => ground(la, lo));
    // A bridge spans between its ends instead of dipping into the river.
    if (bridge) {
      const h0 = gs[0].h, h1 = gs[gs.length - 1].h;
      gs.forEach((g, i) => { g.h = Math.max(g.h, h0 + (h1 - h0) * (i / (gs.length - 1))) + 0.3; });
      // On a modelled bridge (Sydney Harbour, Brooklyn): the road rides the deck.
      if (opts.models) gs.forEach((g, i) => {
        const z = deckAt(opts.models, line[i][0], line[i][1]);
        if (z === null) return;
        g.h = Math.max(g.h, typeof z === "number" ? z - lift + 0.1 : z.z * (1 - z.blend) + g.h * z.blend);
      });
    }
    const P = gs.map((g) => at(g, g.h + lift));
    let along = 0, prev = -1;
    for (let i = 0; i < P.length; i++) {
      const a = P[Math.max(0, i - 1)], c = P[Math.min(P.length - 1, i + 1)];
      const dx = c[0] - a[0], dy = c[1] - a[1], dz = c[2] - a[2];
      const g = gs[i].d;
      // side = segment direction × up
      let sx = dy * g[2] - dz * g[1], sy = dz * g[0] - dx * g[2], sz = dx * g[1] - dy * g[0];
      const sl = Math.hypot(sx, sy, sz) || 1; sx /= sl; sy /= sl; sz /= sl;
      if (i) along += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1], P[i][2] - P[i - 1][2]);
      // Colour slot carries (class, half-width, 0); v runs 0 → 1 across the road.
      const l = R.v([P[i][0] - sx * half, P[i][1] - sy * half, P[i][2] - sz * half], g, [rd.cls, half, 0], along, 0);
      R.v([P[i][0] + sx * half, P[i][1] + sy * half, P[i][2] + sz * half], g, [rd.cls, half, 0], along, 1);
      if (prev >= 0) R.I.push(prev, prev + 1, l, l, prev + 1, l + 1);
      prev = l;
    }
    nR++;
  }

  // Lakes and reservoirs as flat water (tidal water is in the elevation grid).
  for (const w of t.water) {
    if (w.kind === 2 || w.kind === 3) {
      // Airport aprons / runway areas (paved, at the ground) and piers, docks,
      // breakwaters (a deck above the water): flat surfaces in the building batch.
      const deck = w.kind === 3;
      let hmax = -Infinity;
      const gr = w.rings.map((ring) => { const out = []; for (let i = 0; i < ring.length; i += 2) { const g = ground(ring[i], ring[i + 1]); hmax = Math.max(hmax, g.h); out.push(g); } return out; });
      const flat = [], holes = [];
      gr.forEach((ring, ri) => { if (ri) holes.push(flat.length / 2); for (const g of ring) { const q = en(at(g, 0)); flat.push(q[0], q[1]); } });
      const tri = earcut(flat, holes.length ? holes : null);
      const base = B.n, c = deck ? [0.16, 0.14, 0.12] : [0.11, 0.11, 0.115];
      for (const g of gr.flat()) B.v(at(g, deck ? Math.max(hmax, 0) + 1.2 : g.h + 0.12), U, c, -1, -1);
      pushUp(B.I, base, tri, flat);
      continue;
    }
    if (w.kind !== 1) continue;
    let hmin = Infinity;
    const gr = w.rings.map((ring) => { const out = []; for (let i = 0; i < ring.length; i += 2) { const g = ground(ring[i], ring[i + 1]); hmin = Math.min(hmin, g.h); out.push(g); } return out; });
    const flat = [], holes = [];
    gr.forEach((ring, ri) => { if (ri) holes.push(flat.length / 2); for (const g of ring) { const q = en(at(g, 0)); flat.push(q[0], q[1]); } });
    const tri = earcut(flat, holes.length ? holes : null);
    const base = Wt.n;
    for (const g of gr.flat()) Wt.v(at(g, hmin + 0.08), g.d, [0.02, 0.05, 0.07], 0, 0);
    pushUp(Wt.I, base, tri, flat);
  }

  const transfer = [];
  const res = {
    key: t.iy + "_" + t.ix, origin: O, frame: { U, E, N: Nn }, latC, lonC,
    buildings: B.n ? B.out(transfer) : null, roads: R.n ? R.out(transfer) : null, water: Wt.n ? Wt.out(transfer) : null,
    foot: { pts: new Float32Array(foot.pts), offs: new Uint32Array(foot.offs), top: new Float32Array(foot.top), bbox: new Float32Array(foot.bbox) },
    stats: { buildings: nB, roads: nR, heightSources: counts }, transfer
  };
  transfer.push(res.foot.pts.buffer, res.foot.offs.buffer, res.foot.top.buffer, res.foot.bbox.buffer);
  return res;
}
