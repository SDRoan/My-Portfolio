// The global urban fallback and major lines for one 0.01° map tile, in a
// surface worker (no DOM). Output is an ordinary map tile (tile-format.js),
// so the city builder, collision, shadows and the vegetation mask treat it
// like OpenStreetMap data — but every building in it carries height source 3,
// "procedural (global urban fallback)", and is labelled as such.
//
// Where ESA WorldCover marks land as built-up, blocks of streets and
// buildings are laid out: one street-grid orientation and spacing per 0.05°
// district, lots along each block's edges, sizes and heights by how built-up
// the surroundings are (detached houses at the fringe, continuous mid-rise
// blocks further in). Nothing here is a real building or a real street.
// Natural Earth major roads and rivers are added as roads (rivers as class
// 19, drawn as water).

import { encodeTile, tileBounds } from "./tile-format.js";
import { LINE_KIND } from "./global-format.js";

const D2R = Math.PI / 180;
function hash(a, b, c) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// args: { key, grid: { data (class << 4 | density), W, H, west, north, cell }, lines: [{ kind, width, pts: [lat, lon, …] }] }
export function synthTile(a) {
  const [iy, ix] = a.key.split("_").map(Number), b = tileBounds(iy, ix), G = a.grid, C = G.cell;
  const cls = (lat, lon) => {
    const x = Math.floor((lon - G.west) / C), y = Math.floor((G.north - lat) / C);
    return x < 0 || y < 0 || x >= G.W || y >= G.H ? 0 : G.data[y * G.W + x] >> 4;
  };
  // Share of built-up cells within r cells of a point.
  const built = (lat, lon, r) => {
    const x0 = Math.floor((lon - G.west) / C), y0 = Math.floor((G.north - lat) / C);
    let n = 0, k = 0;
    for (let y = y0 - r; y <= y0 + r; y++) for (let x = x0 - r; x <= x0 + r; x++) {
      if (x < 0 || y < 0 || x >= G.W || y >= G.H) continue;
      k++; if (G.data[y * G.W + x] >> 4 === 5) n++;
    }
    return k ? n / k : 0;
  };
  const roads = [], buildings = [];
  // Natural Earth lines: roads as roads, rivers as class 19 (water).
  const segs = [];
  for (const l of a.lines || []) {
    // Densify to ≤ 40 m and keep the runs within ±1.8 tiles (the tile format's reach).
    const m = 1.8 * (b.north - b.south), inR = (la, lo) => la > b.south - m && la < b.north + m && lo > b.west - m && lo < b.east + m;
    const runs = [];
    let cur = null;
    for (let k = 0; k + 3 < l.pts.length + 2; k += 2) {
      const la0 = l.pts[k], lo0 = l.pts[k + 1], la1 = l.pts[k + 2] ?? la0, lo1 = l.pts[k + 3] ?? lo0;
      const n = Math.max(1, Math.ceil(Math.hypot((la1 - la0) * 111320, (lo1 - lo0) * 111320 * Math.cos(la0 * D2R)) / 40));
      for (let s = 0; s < (k + 3 < l.pts.length ? n : 1); s++) {
        const la = la0 + (la1 - la0) * s / n, lo = lo0 + (lo1 - lo0) * s / n;
        if (inR(la, lo)) { if (!cur) { cur = []; runs.push(cur); } cur.push([la, lo]); } else cur = null;
      }
    }
    for (const pts of runs) {
    if (pts.length < 2) continue;
    let cls_, width;
    if (l.kind >= LINE_KIND.river) { cls_ = 19; width = Math.round((l.width || 60) * 0.7); }      // rank-based width estimate, kept conservative
    else { cls_ = l.kind === LINE_KIND.highway ? 1 : l.kind === LINE_KIND.primary ? 2 : l.kind === LINE_KIND.track ? 14 : 4; width = [0, 16, 12, 9, 4][l.kind] || 9; }
    roads.push({ cls: cls_, flags: 0, width, pts });
    segs.push({ pts, half: width / 2 });
    }
  }
  const kyM = 111320;
  const nearLine = (lat, lon, pad) => {
    const kx = 111320 * Math.cos(lat * D2R);
    for (const s of segs) for (let i = 0; i + 1 < s.pts.length; i++) {
      const ax = (s.pts[i][1] - lon) * kx, ay = (s.pts[i][0] - lat) * kyM, bx = (s.pts[i + 1][1] - lon) * kx, by = (s.pts[i + 1][0] - lat) * kyM;
      const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1e-9)));
      if (Math.hypot(ax + t * dx, ay + t * dy) < s.half + pad) return true;
    }
    return false;
  };

  // Urban blocks, per 0.05° district.
  const anyBuilt = built((b.south + b.north) / 2, (b.west + b.east) / 2, 2) > 0;
  if (anyBuilt) {
    const D = 0.05, dLat = Math.floor(b.south / D), dLon = Math.floor(b.west / D);
    const dla = (dLat + 0.5) * D, dlo = (dLon + 0.5) * D, kx = 111320 * Math.cos(dla * D2R);
    const theta = hash(dLat, dLon, 1) * Math.PI / 2, ct = Math.cos(theta), st = Math.sin(theta);
    const u0 = built(dla, dlo, 4);                                         // the district's urban intensity
    const S = u0 > 0.7 ? 80 : u0 > 0.4 ? 100 : 125;                        // block pitch (m)
    // local metres (e, n) from the district centre ↔ lattice (u along, v across)
    const toLL = (e, n) => [dla + n / kyM, dlo + e / kx];
    const toUV = (e, n) => [e * ct + n * st, -e * st + n * ct];
    const fromUV = (u, v) => [u * ct - v * st, u * st + v * ct];
    const inTile = (lat, lon) => lat >= b.south && lat < b.north && lon >= b.west && lon < b.east;
    const inDistrict = (lat, lon) => Math.floor(lat / D) === dLat && Math.floor(lon / D) === dLon;
    // Lattice range covering the tile.
    const corners = [[b.south, b.west], [b.south, b.east], [b.north, b.west], [b.north, b.east]].map(([la, lo]) => toUV((lo - dlo) * kx, (la - dla) * kyM));
    const umin = Math.floor(Math.min(...corners.map((c) => c[0])) / S) - 1, umax = Math.ceil(Math.max(...corners.map((c) => c[0])) / S) + 1;
    const vmin = Math.floor(Math.min(...corners.map((c) => c[1])) / S) - 1, vmax = Math.ceil(Math.max(...corners.map((c) => c[1])) / S) + 1;
    const ring = (cu, cv, hu, hv, rot) => {
      const out = [];
      for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const lu = su * hu, lv = sv * hv, ru = lu * Math.cos(rot) - lv * Math.sin(rot), rv = lu * Math.sin(rot) + lv * Math.cos(rot);
        const [e, n] = fromUV(cu + ru, cv + rv); out.push(toLL(e, n));
      }
      return out;
    };
    for (let i = umin; i <= umax; i++) for (let j = vmin; j <= vmax; j++) {
      const cu = (i + 0.5) * S, cv = (j + 0.5) * S, [ce, cn] = fromUV(cu, cv), [cla, clo] = toLL(ce, cn);
      if (!inTile(cla, clo) || !inDistrict(cla, clo)) continue;
      const u = built(cla, clo, 1), core = built(cla, clo, 3);
      if (cls(cla, clo) === 8) continue;                                 // never a block in water (harbours, rivers, lakes)
      if (u < 0.3 && cls(cla, clo) !== 5) continue;
      // Streets: this block's west and south edges (each block owns two edges).
      for (const [p0, p1] of [[[i * S, j * S], [i * S, (j + 1) * S]], [[i * S, j * S], [(i + 1) * S, j * S]]]) {
        const a0 = toLL(...fromUV(...p0)), a1 = toLL(...fromUV(...p1));
        if (cls((a0[0] + a1[0]) / 2, (a0[1] + a1[1]) / 2) === 8 || cls(a0[0], a0[1]) === 8 || cls(a1[0], a1[1]) === 8) continue;     // no street across water
        const major = (p0[0] === p1[0] ? i : j) % 4 === 0;
        roads.push({ cls: major ? 4 : 5, flags: 0, width: major ? 11 : 8, pts: [a0, a1] });
      }
      // Lots along the four sides of the block interior.
      const street = 7, inner = S / 2 - street;
      const kind = core > 0.75 && u > 0.7 ? 2 : u > 0.5 ? 1 : 0;            // 0 houses · 1 mid-rise · 2 dense core
      const depth = kind === 0 ? 11 : kind === 1 ? 16 : 24, set = kind === 0 ? 6 : 1;
      const front = kind === 0 ? 16 : kind === 1 ? 18 : 30;
      for (let side = 0; side < 4; side++) {
        const rot = side * Math.PI / 2, len = 2 * inner - (kind === 0 ? 0 : 2 * depth);
        const nLots = Math.max(1, Math.floor(len / front));
        for (let k = 0; k < nLots; k++) {
          const hh = hash(i * 7 + side, j * 13 + k, 3);
          if (hh < (kind === 0 ? 0.35 : 0.1) * (1.4 - u)) continue;        // gaps: yards, lots, small parks
          const along = -len / 2 + (k + 0.5) * (len / nLots), out = inner - set - depth / 2;
          const lu = along, lv = -out;                                     // side 0: the block's south side
          const ru = lu * Math.cos(rot) - lv * Math.sin(rot), rv = lu * Math.sin(rot) + lv * Math.cos(rot);
          const [be, bn] = fromUV(cu + ru, cv + rv), [bla, blo] = toLL(be, bn);
          if (!inDistrict(bla, blo)) continue;
          const c = cls(bla, blo);
          if (c !== 5 && !(c !== 8 && u > 0.6)) continue;                // only on built-up land (never in water)
          if (nearLine(bla, blo, 8)) continue;
          const w = (len / nLots) * (kind === 0 ? 0.6 : 0.92) / 2, d = (kind === 0 ? depth * 0.85 : depth) / 2;
          const hr = hash(i * 31 + side, j * 17 + k, 5);
          let h = kind === 0 ? 4 + 4 * hr : kind === 1 ? 9 + 15 * hr : 15 + 25 * hr;
          if (kind === 2 && hash(i, j, 9) > 0.97) h = 45 + 60 * hr;          // the odd taller building in the densest cores
          buildings.push({ cls: kind === 2 ? 1 : 0, src: 3, h, minH: 0, rings: [ring(cu + ru, cv + rv, w, d, rot)] });
          if (buildings.length > 900) break;
        }
      }
    }
  }
  if (!roads.length && !buildings.length) return null;
  const tile = encodeTile(iy, ix, {
    buildings: buildings.map((x) => ({ ...x, rings: x.rings.map((r) => r.map(([la, lo]) => [la, lo])) })),
    roads, water: []
  });
  return { tile: tile.buffer.slice(tile.byteOffset, tile.byteOffset + tile.byteLength), buildings: buildings.length, roads: roads.length };
}
