// Vegetation placement for one Earth map tile, in a surface worker (no DOM,
// no three.js). Every plant stands on the same ground function as the
// terrain, buildings and collision (surface-core.js).
//
// Order of authority (most exact first):
//   1. OpenStreetMap natural=tree            — the mapped position; mapped height,
//                                               crown, leaf type when tagged
//   2. OpenStreetMap natural=tree_row        — trees spaced along the mapped line
//   3. OpenStreetMap orchards / vineyards    — regular rows inside the mapped field
//   4. Land cover + canopy density           — generated: ESA WorldCover class and
//      (the pack's grid, OSM areas burned in)   NLCD canopy (US) set where and how
//                                               densely trees, shrubs and grass grow
// Generated plants are kept off buildings, roads, paths, rail, runways (with
// a clear zone), lakes, tidal water (ground below sea level), mapped parking,
// aprons and piers, and the launch site; steep ground thins them; snow, ice,
// water and bare rock get none.
//
// Visual families are broad categories chosen per region and elevation band
// (PROFILES); no species is ever implied unless an OSM tag names it.
//
// Placement is deterministic: generated plants are seeded by tile and lattice
// cell, mapped trees by their OSM id — the same forest every visit.

import { decodeTile, tileBounds } from "./tile-format.js";
import { dirFromLatLon } from "../universe/surface-core.js";
import { CLASS, VEG_CELL } from "./veg-format.js";

const D2R = Math.PI / 180;
// Family ids (veg-models.js FAMILY).
const F = { broadleaf: 0, conifer: 1, tall: 2, palm: 3, mangrove: 4, ornamental: 5, street: 6, bushy: 7, shrub: 8, scrub: 9, reeds: 10, vine: 11, grass: 12, tuft: 13, crop: 14 };
// Height range (m), crown width / height, lattice spacing (m) per tree family.
const SIZE = {
  [F.broadleaf]: { h: [9, 22], c: 0.62, s: 7 }, [F.conifer]: { h: [10, 26], c: 0.36, s: 5.5 }, [F.tall]: { h: [22, 48], c: 0.24, s: 6 },
  [F.palm]: { h: [7, 15], c: 0.42, s: 6.5 }, [F.mangrove]: { h: [3, 7], c: 1.1, s: 4.5 }, [F.ornamental]: { h: [4, 9], c: 0.8, s: 5.5 },
  [F.street]: { h: [8, 18], c: 0.6, s: 8 }, [F.bushy]: { h: [2.5, 7], c: 0.9, s: 4.5 }
};
const ROAD_W = [11, 10, 9, 8, 7, 6, 5.5, 4, 5, 5, 2, 2, 1.5, 2, 3, 3.2, 2.6, 45, 23];

// Regional profiles: which visual families generated trees and shrubs use.
// Elevation bands follow each region's documented vegetation zones (broad
// categories only): e.g. Grand Canyon pinyon–juniper woodland below the rim
// forest, Mount Rainier's montane → subalpine forest, the Khumbu's lower
// forest → shrub zone. Land cover still decides whether anything grows.
const PROFILES = {
  kennedy: { trees: () => [[F.conifer, 0.4], [F.broadleaf, 0.35], [F.palm, 0.25]], urban: [[F.palm, 0.45], [F.street, 0.55]], shrub: [[F.shrub, 0.55], [F.scrub, 0.45]], mapped: F.broadleaf, arid: false, hScale: 0.8 },
  nyc: { trees: () => [[F.broadleaf, 0.82], [F.ornamental, 0.12], [F.conifer, 0.06]], urban: [[F.street, 1]], shrub: [[F.shrub, 1]], mapped: F.street, arid: false, hScale: 1 },
  "grand-canyon": { trees: (e) => (e > 2150 ? [[F.conifer, 0.85], [F.broadleaf, 0.15]] : e > 1750 ? [[F.bushy, 0.8], [F.conifer, 0.2]] : [[F.bushy, 1]]),
    urban: [[F.conifer, 0.6], [F.bushy, 0.4]], shrub: [[F.scrub, 0.8], [F.shrub, 0.2]], mapped: F.conifer, arid: true, hScale: (e) => (e > 2150 ? 1 : 0.8) },
  rainier: { trees: (e) => (e < 1300 ? [[F.tall, 0.55], [F.conifer, 0.33], [F.broadleaf, 0.12]] : e < 1750 ? [[F.conifer, 0.6], [F.tall, 0.4]] : [[F.conifer, 1]]),
    urban: [[F.conifer, 0.7], [F.broadleaf, 0.3]], shrub: [[F.shrub, 1]], mapped: F.conifer, arid: false, hScale: (e) => (e < 1300 ? 1 : e < 1750 ? 0.7 : Math.max(0.2, 0.55 - (e - 1750) / 1500)) },
  everest: { trees: (e) => (e < 3700 ? [[F.conifer, 0.5], [F.broadleaf, 0.25], [F.bushy, 0.25]] : e < 4200 ? [[F.bushy, 0.7], [F.conifer, 0.3]] : [[F.bushy, 1]]),
    urban: [[F.conifer, 0.5], [F.bushy, 0.5]], shrub: [[F.shrub, 0.6], [F.scrub, 0.4]], mapped: F.conifer, arid: false, hScale: (e) => (e < 3700 ? 1 : e < 4200 ? 0.6 : 0.3) }
};
// Outside the packs: broad families by climate zone (latitude) and how dry
// the surrounding land cover is (share of shrub and bare cells). Categories only.
function climateProfile(lat, G) {
  let dry = 0, n = 0;
  for (let i = 0; i < G.data.length; i++) { const c = G.data[i] >> 4; if (c === 8) continue; n++; if (c === 2 || c === 6) dry++; }
  const arid = n > 0 && dry / n > 0.35, L = Math.abs(lat);
  const trees = L < 23.5 ? (arid ? [[F.bushy, 0.6], [F.broadleaf, 0.3], [F.palm, 0.1]] : [[F.broadleaf, 0.72], [F.palm, 0.18], [F.bushy, 0.1]])
    : L < 40 ? (arid ? [[F.bushy, 0.6], [F.conifer, 0.25], [F.broadleaf, 0.15]] : [[F.broadleaf, 0.55], [F.conifer, 0.3], [F.bushy, 0.15]])
    : L < 55 ? [[F.broadleaf, 0.55], [F.conifer, 0.4], [F.tall, 0.05]] : [[F.conifer, 0.75], [F.tall, 0.1], [F.broadleaf, 0.15]];
  return { trees: (e) => (e > 2600 ? [[F.conifer, 0.8], [F.bushy, 0.2]] : trees), urban: L < 30 ? [[F.street, 0.7], [F.palm, 0.3]] : [[F.street, 1]],
    shrub: arid ? [[F.scrub, 0.7], [F.shrub, 0.3]] : [[F.shrub, 1]], mapped: F.broadleaf, arid, hScale: (e) => (e > 3200 ? 0.5 : e > 2600 ? 0.75 : 1) };
}

function hash(a, b, c, d) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b9) ^ Math.imul(d | 0, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const pick = (list, u) => { let s = 0; for (const [f, w] of list) { s += w; if (u <= s) return f; } return list[list.length - 1][0]; };
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Mask bits.
const M_BUILDING = 1, M_ROAD = 2, M_WATER = 4, M_PATH = 8, M_CLEAR = 16, M_NEAR_ROAD = 32, M_NEAR_BUILDING = 64;

// args: { key, lod, pMax, density, region, grid: { data, W, H, south, west, north, east }, box (region bbox),
//         osm: [ArrayBuffer…] (this tile and its neighbours), trees, rows, fields, exclude, strings }
export function buildVegTile(surface, a) {
  const [iy, ix] = a.key.split("_").map(Number), b = tileBounds(iy, ix);
  const latC = (b.south + b.north) / 2, lonC = (b.west + b.east) / 2;
  const U = dirFromLatLon(latC, lonC), E = [-Math.sin(lonC * D2R), 0, -Math.cos(lonC * D2R)];
  const Nn = [U[1] * E[2] - U[2] * E[1], U[2] * E[0] - U[0] * E[2], U[0] * E[1] - U[1] * E[0]];
  const rC = surface.radiusAt(U[0], U[1], U[2], 5), O = [U[0] * rC, U[1] * rC, U[2] * rC];
  const prof = PROFILES[a.region] || climateProfile(latC, a.grid);       // other packs and the global base: by climate zone
  const lod = a.lod, res = lod === 0 ? 2 : lod === 1 ? 6 : 12, margin = 30;
  const ky = 111320, kx = 111320 * Math.cos(latC * D2R);
  const tw = (b.east - b.west) * kx, th = (b.north - b.south) * ky;
  const nx = Math.ceil((tw + 2 * margin) / res), ny = Math.ceil((th + 2 * margin) / res);
  const mask = new Uint8Array(nx * ny);
  const X = (lon) => (lon - b.west) * kx + margin, Y = (lat) => (b.north - lat) * ky + margin;     // metres, y down (south)
  const stats = { mapped: 0, mappedInBuilding: 0, rowTrees: 0, fieldPlants: 0, generatedTrees: 0, shrubs: 0, rejected: { building: 0, road: 0, water: 0, slope: 0, clear: 0 } };

  // ── the mask: buildings, roads, water from this tile's map data and its neighbours' ──
  const fillPoly = (rings, bit, dilate) => {
    let y0 = Infinity, y1 = -Infinity;
    const R = rings.map((r) => { const o = []; for (let i = 0; i < r.length; i += 2) { const p = [X(r[i + 1]), Y(r[i])]; o.push(p); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); } return o; });
    const ya = Math.max(0, Math.floor(y0 / res) - dilate - 1), yb = Math.min(ny - 1, Math.ceil(y1 / res) + dilate + 1);
    // Each row takes the union of the spans of the scanlines through its
    // neighbours (±dilate cells) and its own edges, so dilation works across
    // edges in both directions and no inside point is missed at a boundary.
    for (let gy = ya; gy <= yb; gy++) {
      for (let k = -dilate; k <= dilate; k++) for (const f of [0.02, 0.5, 0.98]) {
        const yy = (gy + k + f) * res, xs = [];
        for (const r of R) for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const p = r[i], q = r[j]; if ((p[1] > yy) !== (q[1] > yy)) xs.push(p[0] + (yy - p[1]) / (q[1] - p[1]) * (q[0] - p[0])); }
        xs.sort((u, v) => u - v);
        for (let m = 0; m + 1 < xs.length; m += 2) {
          const xa = Math.max(0, Math.floor(xs[m] / res) - dilate), xb = Math.min(nx - 1, Math.floor(xs[m + 1] / res) + dilate);
          for (let gx = xa; gx <= xb; gx++) mask[gy * nx + gx] |= bit;
        }
      }
    }
  };
  // A thick line; widened by the cell's half-diagonal so every point of a
  // marked cell, not just its centre, is within the distance.
  const line = (pts, half0, bit) => {
    const half = half0 + res * 0.71;
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const x0 = X(pts[i + 1]), y0 = Y(pts[i]), x1 = X(pts[i + 3]), y1 = Y(pts[i + 2]);
      const gx0 = Math.max(0, Math.floor((Math.min(x0, x1) - half) / res)), gx1 = Math.min(nx - 1, Math.floor((Math.max(x0, x1) + half) / res));
      const gy0 = Math.max(0, Math.floor((Math.min(y0, y1) - half) / res)), gy1 = Math.min(ny - 1, Math.floor((Math.max(y0, y1) + half) / res));
      const dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy || 1e-9, hh = half * half;
      for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
        const px = (gx + 0.5) * res - x0, py = (gy + 0.5) * res - y0, t = Math.max(0, Math.min(1, (px * dx + py * dy) / L2));
        const ex = px - t * dx, ey = py - t * dy;
        if (ex * ex + ey * ey <= hh) mask[gy * nx + gx] |= bit;
      }
    }
  };
  for (const buf of a.osm || []) {
    const t = decodeTile(new Uint8Array(buf));
    if (t.bounds.east < b.west - 0.002 || t.bounds.west > b.east + 0.002 || t.bounds.north < b.south - 0.002 || t.bounds.south > b.north + 0.002) continue;
    for (const bd of t.buildings) { fillPoly(bd.rings, M_BUILDING, 1); if (lod === 0) fillPoly([bd.rings[0]], M_NEAR_BUILDING, Math.ceil(6 / res)); }
    for (const rd of t.roads) {
      const half = (rd.width || ROAD_W[rd.cls] || 5) / 2;
      if (rd.cls === 17) line(rd.pts, half + 30, M_CLEAR);                 // runways: a clear zone
      else if (rd.cls === 18) line(rd.pts, half + 8, M_CLEAR);             // taxiways
      else if (rd.cls >= 10 && rd.cls <= 14) line(rd.pts, half + 0.4, M_PATH);
      else { line(rd.pts, half + 0.9, M_ROAD); if (lod === 0 && rd.cls <= 9) line(rd.pts, half + 7, M_NEAR_ROAD); }
    }
    for (const w of t.water) if (w.kind === 1) fillPoly(w.rings, M_WATER, 1);
  }
  for (const ex of a.exclude || []) {
    const cx = X(ex.lon), cy = Y(ex.lat), r = ex.r;
    for (let gy = Math.max(0, Math.floor((cy - r) / res)); gy <= Math.min(ny - 1, Math.floor((cy + r) / res)); gy++)
      for (let gx = Math.max(0, Math.floor((cx - r) / res)); gx <= Math.min(nx - 1, Math.floor((cx + r) / res)); gx++)
        if (Math.hypot((gx + 0.5) * res - cx, (gy + 0.5) * res - cy) < r) mask[gy * nx + gx] |= M_CLEAR;
  }
  const maskAt = (lat, lon) => { const gx = Math.floor(X(lon) / res), gy = Math.floor(Y(lat) / res); return gx < 0 || gy < 0 || gx >= nx || gy >= ny ? 0 : mask[gy * nx + gx]; };

  // ── the land-cover grid: class (edges dithered) and smooth density ──
  const G = a.grid;
  const CELL = G.cell || VEG_CELL;                                    // packs: 0.0002°; global base pack: 1/120°
  const cellOf = (lat, lon) => { const gx = Math.floor((lon - G.west) / CELL), gy = Math.floor((G.north - lat) / CELL); return gx < 0 || gy < 0 || gx >= G.W || gy >= G.H ? -1 : gy * G.W + gx; };
  // Dithered across cell edges (no 22 m squares), but never into a cell that
  // is itself snow, water or cleared.
  const classAt = (lat, lon, u, v) => {
    const i0 = cellOf(lat, lon);
    if (i0 < 0) return -1;
    const c0 = G.data[i0] >> 4;
    if (c0 === CLASS.snow || c0 === CLASS.water || c0 === CLASS.none) return c0;
    const i = cellOf(lat + (u - 0.5) * CELL * 0.9, lon + (v - 0.5) * CELL * 0.9);
    return i < 0 ? c0 : G.data[i] >> 4;
  };
  const densAt = (lat, lon) => {
    const fx = (lon - G.west) / CELL - 0.5, fy = (G.north - lat) / CELL - 0.5;
    const x0 = Math.max(0, Math.min(G.W - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(G.H - 2, Math.floor(fy))), tx = Math.min(1, Math.max(0, fx - x0)), ty = Math.min(1, Math.max(0, fy - y0));
    const d = (i, j) => (G.data[j * G.W + i] & 15) / 15;
    return (d(x0, y0) * (1 - tx) + d(x0 + 1, y0) * tx) * (1 - ty) + (d(x0, y0 + 1) * (1 - tx) + d(x0 + 1, y0 + 1) * tx) * ty;
  };
  const box = a.box;
  const edgeFade = (lat, lon) => sstep(0, 300, Math.min((lat - box.south) * ky, (box.north - lat) * ky, (lon - box.west) * kx, (box.east - lon) * kx));

  // ── output ──
  const inst = [], fam = [], src = [], info = [];
  const place = (lat, lon, h, crown, yaw, hsh, tone, f, s, inf) => {
    const d = dirFromLatLon(lat, lon), r = surface.radiusAt(d[0], d[1], d[2], 5) - Math.min(0.4, h * 0.02);
    inst.push(d[0] * r - O[0], d[1] * r - O[1], d[2] * r - O[2], h, crown, yaw, hsh, tone);
    fam.push(f); src.push(s); info.push(inf || 0);
  };
  const groundH = (lat, lon) => { const d = dirFromLatLon(lat, lon); return surface.heightAt(d[0], d[1], d[2], 5); };
  const slopeAt = (lat, lon, h0) => Math.hypot(groundH(lat, lon + 3 / kx) - h0, groundH(lat + 3 / ky, lon) - h0) / 3;
  const elevScale = (e) => (typeof prof.hScale === "function" ? prof.hScale(e) : prof.hScale);
  const sizeOf = (f, u, e) => { const S = SIZE[f], h = (S.h[0] + (S.h[1] - S.h[0]) * Math.pow(u, 0.8)) * elevScale(e); return [h, h * S.c]; };

  // 1. Mapped trees: exact positions.
  for (const t of a.trees || []) {
    if (t.lat < b.south || t.lat >= b.north || t.lon < b.west || t.lon >= b.east) continue;
    const m = maskAt(t.lat, t.lon);
    if (m & M_BUILDING) { stats.mappedInBuilding++; continue; }
    const e = groundH(t.lat, t.lon);
    // Leaf type / genus from the tags decide the family; untagged trees get the
    // region's broad category (street tree beside a road).
    const u = hash(t.id, 7, 1, 3);
    const f = t.hint === 2 ? (t.h > 28 ? F.tall : F.conifer) : t.hint === 3 ? F.palm : t.hint === 4 ? F.mangrove : t.hint === 1 ? (m & M_NEAR_ROAD ? F.street : F.broadleaf)
      : m & M_NEAR_ROAD ? pick(prof.urban, u) : prof.mapped;
    let [h, c] = sizeOf(f, 0.3 + 0.4 * u, e);           // untagged: a conservative mid-range size
    if (t.h > 0) { h = t.h; c = t.crown > 0 ? t.crown : h * SIZE[f].c; } else if (t.crown > 0) { c = t.crown; h = Math.max(2, c / SIZE[f].c); }
    place(t.lat, t.lon, h, c, hash(t.id, 1, 2, 3) * 6.283, hash(t.id, 5, 5, 5), hash(t.id, 9, 9, 9), f, 1, t.info);
    stats.mapped++;
  }
  // 2. Mapped tree rows: individual trees along the real line.
  for (const r of a.rows || []) {
    const sp = r.crown > 0 ? Math.max(3, r.crown) : r.h > 0 ? Math.max(4, r.h * 0.5) : 7;
    let carry = sp / 2, k = 0;
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const [la0, lo0] = r.pts[i], [la1, lo1] = r.pts[i + 1];
      const seg = Math.hypot((la1 - la0) * ky, (lo1 - lo0) * kx);
      for (let s = carry; s < seg; s += sp, k++) {
        const t = s / seg, lat = la0 + (la1 - la0) * t, lon = lo0 + (lo1 - lo0) * t;
        if (lat < b.south || lat >= b.north || lon < b.west || lon >= b.east) continue;
        if (maskAt(lat, lon) & M_BUILDING) continue;
        const e = groundH(lat, lon), f = r.hint === 2 ? F.conifer : r.hint === 3 ? F.palm : prof.mapped === F.street ? F.street : prof.mapped;
        let [h, c] = sizeOf(f, 0.4 + 0.3 * hash(r.id, k, 1, 1), e);
        if (r.h > 0) { h = r.h * (0.92 + 0.16 * hash(r.id, k, 2, 2)); c = r.crown > 0 ? r.crown : h * SIZE[f].c; }
        place(lat, lon, h, c, hash(r.id, k, 3, 3) * 6.283, hash(r.id, k, 4, 4), hash(r.id, k, 5, 5), f, 2, r.info);
        stats.rowTrees++;
      }
      carry = ((carry - seg) % sp + sp) % sp;
    }
  }
  // 3. Orchards and vineyards: regular rows inside the mapped field, along its long side.
  const inField = (lat, lon, rings) => { let inside = false; for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [yi, xi] = ring[i], [yj, xj] = ring[j]; if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside; } return inside; };
  if (lod === 0) for (const fl of a.fields || []) {
    const vine = fl.kind === "vineyard", along = vine ? 4 : 5, across = vine ? 2.6 : 6.5;
    const ca = Math.cos(fl.angle), sa = Math.sin(fl.angle);
    // Field-aligned lattice over the tile: (u along the rows, v across).
    const ext = Math.hypot(tw, th) / 2 + 50, cx = tw / 2, cy = th / 2;
    for (let v = -ext; v < ext; v += across) for (let u = -ext; u < ext; u += along) {
      const ex = cx + u * sa + v * ca, ny_ = cy + u * ca - v * sa;          // east, north metres from SW
      if (ex < 0 || ex >= tw || ny_ < 0 || ny_ >= th) continue;
      const lat = b.south + ny_ / ky, lon = b.west + ex / kx;
      if (!inField(lat, lon, fl.rings)) continue;
      if (maskAt(lat, lon) & (M_BUILDING | M_ROAD | M_PATH | M_WATER | M_CLEAR)) continue;
      const k = Math.round(u * 7 + v * 131);
      if (vine) place(lat, lon, 1.6, along, fl.angle, hash(fl.id, k, 1, 1), hash(fl.id, k, 2, 2), F.vine, 3, fl.info);
      else { const h = 3.5 + 1.5 * hash(fl.id, k, 3, 3); place(lat, lon, h, h * 0.85, hash(fl.id, k, 4, 4) * 6.283, hash(fl.id, k, 5, 5), hash(fl.id, k, 6, 6), F.ornamental, 3, fl.info); }
      stats.fieldPlants++;
    }
  }

  // 4. Generated from land cover and canopy density: a jittered lattice with a
  // minimum distance between neighbours (blue noise, no visible grid).
  const S = 5, nI = Math.ceil(tw / S), nJ = Math.ceil(th / S);
  const taken = new Float32Array(nI * nJ * 3).fill(NaN);              // accepted tree: x, y, radius
  const dens0 = a.density ?? 1;
  for (let j = 0; j < nJ; j++) for (let i = 0; i < nI; i++) {
    const hsh = hash(iy, ix, i * 7919 + j, 1);
    if (hsh > a.pMax) continue;                                       // distant tiles: the thinned subset only
    const px = (i + hash(iy, ix, i * 7919 + j, 2)) * S, py = (j + hash(iy, ix, i * 7919 + j, 3)) * S;
    if (px >= tw || py >= th) continue;
    const lat = b.south + py / ky, lon = b.west + px / kx;
    const c = classAt(lat, lon, hash(iy, ix, i, j * 3 + 11), hash(iy, ix, i, j * 3 + 12));
    if (c < 0) continue;
    const canopy = densAt(lat, lon);
    const m = maskAt(lat, lon);
    let p, list;
    switch (c) {
      case CLASS.tree: p = Math.max(canopy, 0.3); list = null; break;
      case CLASS.forest: p = Math.max(canopy, 0.15); list = null; break;       // the build floors confirmed woods at 0.3
      case CLASS.mangrove: p = Math.max(canopy, 0.5); list = [[F.mangrove, 1]]; break;
      case CLASS.park: case CLASS.lawn: case CLASS.grass: case CLASS.moss: p = canopy * 0.9; list = c === CLASS.park || c === CLASS.lawn ? (m & M_NEAR_ROAD ? prof.urban : null) : null; break;
      case CLASS.shrub: case CLASS.scrub: p = canopy * 0.9; list = null; break;
      case CLASS.wetland: p = canopy * 0.7; list = null; break;
      case CLASS.crop: p = canopy * 0.4; list = null; break;
      case CLASS.built: p = canopy * 1.1; list = m & M_NEAR_ROAD ? prof.urban : null; break;
      default: p = 0;                                                  // bare, snow and ice, water, cleared
    }
    if (!(p > 0.01)) continue;
    p *= edgeFade(lat, lon) * dens0;
    if (m & (M_BUILDING | M_ROAD | M_PATH | M_WATER | M_CLEAR)) {
      const why = m & M_BUILDING ? "building" : m & M_WATER ? "water" : m & M_CLEAR ? "clear" : "road";
      if (hash(iy, ix, i, j) < p) stats.rejected[why]++;
      continue;
    }
    const e = groundH(lat, lon);
    // Tidal water burned into a pack's DEM; outside the packs the land-cover
    // class already says where water is (a 10′ cell can average below sea level on land).
    if (e < -0.5 && a.region !== "global") { stats.rejected.water++; continue; }
    const f = pick(list || prof.trees(e), hash(iy, ix, i * 7919 + j, 5));
    const sp = SIZE[f].s;
    if (hash(iy, ix, i * 7919 + j, 4) > p * (S * S) / (sp * sp)) continue;
    const sl = slopeAt(lat, lon, e);
    if (sl > 1.2 || (sl > 0.7 && hash(iy, ix, i, j * 5 + 1) > 0.25)) { stats.rejected.slope++; continue; }     // cliffs and canyon walls
    let [h, cw] = sizeOf(f, hash(iy, ix, i * 7919 + j, 6), e);
    if (h < 1) continue;
    // Minimum distance to accepted neighbours.
    let ok = true;
    for (let dj = -1; dj <= 1 && ok; dj++) for (let di = -1; di <= 1; di++) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= nI || jj >= nJ || (!di && !dj)) continue;
      const q = (jj * nI + ii) * 3;
      if (taken[q] === taken[q] && Math.hypot(taken[q] - px, taken[q + 1] - py) < 0.55 * Math.max(taken[q + 2], cw * 0.5)) { ok = false; break; }
    }
    if (!ok) continue;
    const q = (j * nI + i) * 3; taken[q] = px; taken[q + 1] = py; taken[q + 2] = cw * 0.5;
    place(lat, lon, h, cw, hash(iy, ix, i * 7919 + j, 7) * 6.283, hsh, hash(iy, ix, i * 7919 + j, 8), f, 0, 0);
    stats.generatedTrees++;
  }

  const nTrees = fam.length;                                          // trees (and field plants) come first, shrubs after
  // 5. Shrubs (nearby tiles only).
  if (lod === 0) {
    const S2 = 3, mI = Math.ceil(tw / S2), mJ = Math.ceil(th / S2);
    for (let j = 0; j < mJ; j++) for (let i = 0; i < mI; i++) {
      const px = (i + hash(iy, ix, i * 104729 + j, 21)) * S2, py = (j + hash(iy, ix, i * 104729 + j, 22)) * S2;
      if (px >= tw || py >= th) continue;
      const lat = b.south + py / ky, lon = b.west + px / kx;
      const c = classAt(lat, lon, hash(iy, ix, i, j * 3 + 23), hash(iy, ix, i, j * 3 + 24));
      const p = c === CLASS.shrub || c === CLASS.scrub ? 0.45 : c === CLASS.wetland ? 0.35 : c === CLASS.tree || c === CLASS.forest ? 0.07 : c === CLASS.grass || c === CLASS.moss ? (prof.arid ? 0.08 : 0.03)
        : c === CLASS.park ? 0.04 : c === CLASS.bare && prof.arid ? 0.025 : c === CLASS.built ? 0.01 : 0;
      if (!(hash(iy, ix, i * 104729 + j, 25) < p * edgeFade(lat, lon) * dens0)) continue;
      const m = maskAt(lat, lon);
      if (m & (M_BUILDING | M_ROAD | M_PATH | M_WATER | M_CLEAR)) continue;
      if (c === CLASS.built && !(m & M_NEAR_BUILDING)) continue;      // built-up: landscaping beside buildings only
      const e = groundH(lat, lon);
      if (e < -0.3 && a.region !== "global") continue;
      if (slopeAt(lat, lon, e) > 1.4) continue;
      const f = c === CLASS.wetland ? F.reeds : pick(prof.shrub, hash(iy, ix, i * 104729 + j, 26));
      const u = hash(iy, ix, i * 104729 + j, 27), h = f === F.reeds ? 1.2 + 1.0 * u : (0.6 + 1.4 * u) * (e > 4200 ? 0.6 : 1), w = f === F.reeds ? 1.0 + 0.6 * u : h * (1.2 + 0.6 * hash(iy, ix, i, j * 7 + 28));
      place(lat, lon, h, w, hash(iy, ix, i * 104729 + j, 29) * 6.283, hash(iy, ix, i * 104729 + j, 30), hash(iy, ix, i * 104729 + j, 31), f, 0, 0);
      stats.shrubs++;
    }
  }

  // 6. Ground cover (nearby tiles): grass type and density on a 2 m raster, for
  // the grass and crops drawn around the camera. Types: 1 lawn, 2 meadow,
  // 3 dry grass, 4 reeds, 5 crop rows, 6 forest floor, 7 scrub floor.
  let cover = null;
  if (lod === 0) {
    const cr = 2, cw = Math.ceil(tw / cr), ch = Math.ceil(th / cr);
    const data = new Uint8Array(cw * ch);
    for (let gy = 0; gy < ch; gy++) for (let gx = 0; gx < cw; gx++) {
      const px = (gx + 0.5) * cr, py = (gy + 0.5) * cr, lat = b.north - py / ky, lon = b.west + px / kx;
      const m = maskAt(lat, lon);
      if (m & (M_BUILDING | M_ROAD | M_PATH | M_WATER | M_CLEAR)) continue;
      const c = classAt(lat, lon, hash(gx, gy, iy, 41), hash(gx, gy, ix, 42));
      let t = 0, d = 0;
      switch (c) {
        case CLASS.lawn: case CLASS.park: t = 1; d = 13; break;
        case CLASS.grass: t = prof.arid ? 3 : 2; d = prof.arid ? 7 : 11; break;
        case CLASS.moss: t = 2; d = 5; break;
        case CLASS.shrub: case CLASS.scrub: t = prof.arid ? 3 : 7; d = prof.arid ? 5 : 7; break;
        case CLASS.tree: case CLASS.forest: t = 6; d = 4; break;
        case CLASS.crop: t = 5; d = 15; break;
        case CLASS.wetland: t = 4; d = 10; break;
        case CLASS.bare: if (prof.arid) { t = 3; d = 1; } break;
        default: break;
      }
      data[gy * cw + gx] = (t << 4) | d;
    }
    cover = { data, W: cw, H: ch, res: cr, south: b.south, west: b.west, north: b.north, east: b.east, kx, ky };
  }

  const n = fam.length;
  const res_ = { key: a.key, lod, origin: O, frame: { U, E, N: Nn }, inst: new Float32Array(inst), fam: new Uint8Array(fam), src: new Uint8Array(src), info: new Uint16Array(info), cover, stats, n, nTrees };
  res_.transfer = [res_.inst.buffer, res_.fam.buffer, res_.src.buffer, res_.info.buffer];
  if (cover) res_.transfer.push(cover.data.buffer);
  return res_;
}

// Grass, reeds and crop rows around the camera, from the ground-cover rasters
// of the nearby tiles. Lattice anchored to latitude/longitude, so the same
// tuft is always in the same place.
// args: { lat, lon (degrees), radius, nearR, density, covers: [cover…], arid }
export function buildGroundCover(surface, a) {
  const R = surface.R, latR = a.lat * D2R, lonR = a.lon * D2R;
  const o = dirFromLatLon(a.lat, a.lon), oR = surface.radiusAt(o[0], o[1], o[2], 5), origin = [o[0] * oR, o[1] * oR, o[2] * oR];
  const out = [], fam = [];
  const coverAt = (lat, lon) => {
    for (const c of a.covers) {
      if (lat < c.south || lat >= c.north || lon < c.west || lon >= c.east) continue;
      const gx = Math.floor((lon - c.west) * c.kx / c.res), gy = Math.floor((c.north - lat) * c.ky / c.res);
      if (gx < 0 || gy < 0 || gx >= c.W || gy >= c.H) return 0;
      return c.data[gy * c.W + gx];
    }
    return 0;
  };
  const pass = (S, r0, r1, near) => {
    const dLat = S / R, n = Math.ceil(r1 / S), i0 = Math.round(latR / dLat);
    for (let i = i0 - n; i <= i0 + n; i++) {
      const la = i * dLat, dLon = S / (R * Math.max(0.05, Math.cos(la))), j0 = Math.round(lonR / dLon);
      for (let j = j0 - n; j <= j0 + n; j++) {
        const u = hash(i, j, 61, 1), v = hash(i, j, 62, 1);
        const lat = (la + (u - 0.5) * dLat) / D2R, lon = (j * dLon + (v - 0.5) * dLon) / D2R;
        const dist = Math.hypot((lat - a.lat) * 111320, (lon - a.lon) * 111320 * Math.cos(latR));
        if (dist < r0 || dist > r1) continue;
        const cv = coverAt(lat, lon), t = cv >> 4, d = (cv & 15) / 15;
        if (!t || t === 5) continue;
        if (hash(i, j, 63, 1) > d * (a.density ?? 1)) continue;
        const dd = dirFromLatLon(lat, lon), h0 = surface.heightAt(dd[0], dd[1], dd[2], 5);
        if (h0 < -0.3 && !a.global) continue;
        const r = surface.baseRadius(dd[0], dd[1], dd[2]) + h0 - 0.03;
        const w = hash(i, j, 64, 1);
        const H = t === 1 ? 0.12 + 0.08 * w : t === 2 ? 0.35 + 0.35 * w : t === 3 ? 0.25 + 0.3 * w : t === 4 ? 1.0 + 0.8 * w : t === 6 ? 0.2 + 0.2 * w : 0.3 + 0.3 * w;
        const f = t === 4 ? (near ? F.reeds : F.tuft) : near ? F.grass : F.tuft;
        const width = near ? (t === 4 ? 0.7 : 0.55) : S;                 // distant tufts fill their lattice cell
        // Last slot: the ground type for grass (its shader colours by type), a tone for reeds.
        out.push(dd[0] * r - origin[0], dd[1] * r - origin[1], dd[2] * r - origin[2], H * (near ? 1 : 1.3), width, hash(i, j, 65, 1) * 6.283, w, f === F.reeds ? w : t);
        fam.push(f);
      }
    }
  };
  pass(0.75, 0, a.nearR, true);
  if (a.radius > a.nearR) pass(1.6, a.nearR, a.radius, false);
  // Crop rows: rows 1.6 m apart in 6 m segments on a global metric lattice,
  // north–south or east–west per 0.002° block of land (fields here follow the
  // survey grid).
  const S = 1.6, cr = Math.min(a.radius, 90), nI = Math.ceil(cr / S), nJ = Math.ceil(cr / 6);
  const ang = hash(Math.floor(a.lat / 0.002), Math.floor(a.lon / 0.002), 71, 1) < 0.5 ? 0 : Math.PI / 2, ca = Math.cos(ang), sa = Math.sin(ang);
  const kxm = 111320 * Math.cos(latR), e0 = a.lon * kxm, n0 = a.lat * 111320;
  const u0 = Math.round((e0 * ca - n0 * sa) / S), v0 = Math.round((e0 * sa + n0 * ca) / 6);
  for (let i = u0 - nI; i <= u0 + nI; i++) for (let j = v0 - nJ; j <= v0 + nJ; j++) {
    const across = i * S, along = j * 6;
    const e = across * ca + along * sa, nn = -across * sa + along * ca;
    const lat = nn / 111320, lon = e / kxm;
    if (Math.hypot((lat - a.lat) * 111320, (lon - a.lon) * kxm) > cr) continue;
    if ((coverAt(lat, lon) >> 4) !== 5) continue;
    const dd = dirFromLatLon(lat, lon), h0 = surface.heightAt(dd[0], dd[1], dd[2], 5);
    if (h0 < -0.3 && !a.global) continue;
    const r = surface.baseRadius(dd[0], dd[1], dd[2]) + h0 - 0.03;
    out.push(dd[0] * r - origin[0], dd[1] * r - origin[1], dd[2] * r - origin[2], 0.7, 6, ang + Math.PI / 2, hash(i, j, 72, 1), 5);
    fam.push(F.crop);
  }
  const res = { origin, inst: new Float32Array(out), fam: new Uint8Array(fam) };
  res.transfer = [res.inst.buffer, res.fam.buffer];
  return res;
}
