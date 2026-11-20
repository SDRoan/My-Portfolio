// Data-constrained relief for worlds without a global DEM (and fine
// structures below a DEM's resolution, like Enceladus's tiger stripes).
//
// FeatureSet: named features at real positions and sizes (the IAU/USGS
// Gazetteer) with reconstructed shapes — craters, Io paterae and mountains,
// Titan's seas, Miranda's coronae and Verona Rupes, Mimas's Herschel,
// Iapetus's equatorial ridge, Enceladus's tiger stripes. Indexed on a 10°
// grid so each height sample only looks at nearby features.
//
// character(): the background texture of a world's terrain where nothing
// is mapped, chosen per world from what is known of it (Europa's ridged ice,
// Io's low volcanic plains, Titan's equatorial dunes, Triton's cantaloupe
// terrain), always within the world's typical relief.

import { fbm, ridged, vnoise } from "../engine/noise.js";

const D2R = Math.PI / 180;
const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const dir = (lat, lon) => [Math.cos(lat * D2R) * Math.cos(lon * D2R), Math.sin(lat * D2R), -Math.cos(lat * D2R) * Math.sin(lon * D2R)];

export class FeatureSet {
  // list: features from features.json; R: body radius (m)
  constructor(list, R) {
    this.R = R;
    this.list = list.map((f) => this.prep(f)).filter(Boolean);
    this.cells = new Map();
    for (let i = 0; i < this.list.length; i++) {
      const f = this.list[i], reach = f.reach / D2R;                 // degrees
      const la0 = Math.max(-90, f.cLat - reach), la1 = Math.min(90, f.cLat + reach);
      const k = 1 / Math.max(0.02, Math.cos(Math.min(89, Math.max(Math.abs(la0), Math.abs(la1))) * D2R));
      const span = Math.min(180, reach * k + (f.lonSpan || 0) / 2);
      for (let la = Math.floor((la0 + 90) / 10); la <= Math.floor((la1 + 90) / 10) && la < 18; la++)
        for (let lo = Math.floor((f.cLon - span + 180) / 10); lo <= Math.floor((f.cLon + span + 180) / 10); lo++) {
          const key = la * 36 + (((lo % 36) + 36) % 36);
          if (!this.cells.has(key)) this.cells.set(key, []);
          const c = this.cells.get(key);
          if (c[c.length - 1] !== i) c.push(i);
        }
    }
  }
  prep(f) {
    const R = this.R;
    if (f.kind === "ridge") {
      const lonSpan = f.lon1 - f.lon0;
      return { ...f, cLat: f.lat, cLon: (f.lon0 + f.lon1) / 2, lonSpan, reach: (f.baseKm * 1000) / R };
    }
    if (f.kind === "scarp") return { ...f, cLat: (f.lat0 + f.lat1) / 2, cLon: f.lon, reach: ((Math.abs(f.lat1 - f.lat0) / 2) * D2R) + (f.widthKm * 4000) / R };
    if (f.kind === "stripe") {
      // Strike: perpendicular to the line through the set's centres, in a
      // south-polar tangent plane (stored by the set via setStripeAxis).
      return { ...f, cLat: f.lat, cLon: f.lon, d: dir(f.lat, f.lon), reach: ((f.lenKm / 2 + 10) * 1000) / R };
    }
    const rad = (f.dKm * 500) / R;                                     // feature radius, radians
    return { ...f, cLat: f.lat, cLon: f.lon, d: dir(f.lat, f.lon), rad, reach: rad * (f.kind === "crater" ? 2.5 : 1.4) };
  }
  // Height (m) at a unit direction.
  height(x, y, z) {
    const lat = Math.asin(Math.max(-1, Math.min(1, y))) / D2R, lon = Math.atan2(-z, x) / D2R;
    const cell = this.cells.get(Math.min(17, Math.floor((lat + 90) / 10)) * 36 + Math.min(35, Math.floor((lon + 180) / 10)));
    if (!cell) return 0;
    let h = 0, crater = null;
    for (const i of cell) {
      const f = this.list[i];
      if (f.kind === "ridge") { h += this.ridge(f, lat, lon); continue; }
      if (f.kind === "scarp") { h += this.scarp(f, lat, lon); continue; }
      if (f.kind === "stripe") { h += this.stripe(f, x, y, z); continue; }
      const dot = x * f.d[0] + y * f.d[1] + z * f.d[2];
      if (dot < Math.cos(f.reach)) continue;
      const r = Math.acos(Math.min(1, dot)) / f.rad;                  // 1 at the rim
      if (f.kind === "crater") {
        // Floor (flat for complex craters), wall, rim crest, ejecta decaying
        // outward, central peak. Overlapping craters: the deepest bowl wins,
        // rims add — later craters cut earlier ones.
        const floor = f.depthM - f.rimM, flat = f.flatFloor || f.dKm > 20 ? 0.55 : 0.0;
        let p;
        if (r < 1) p = -floor + (floor + f.rimM) * Math.pow(ss(flat, 1, r), 1.6) + (f.peakM ? f.peakM * Math.exp(-Math.pow(r / 0.16, 2)) : 0);
        else p = f.rimM * Math.pow(r, -3) * ss(2.5, 1.0, r);
        if (r < 1) crater = crater === null ? p : Math.min(crater, p); else h += p;
      } else if (f.kind === "patera") {
        if (r < 1.15) h -= f.depthM * ss(1.15, 0.9, r);                // steep wall, flat floor
      } else if (f.kind === "mons") {
        if (r < 1.4) h += f.heightM * Math.pow(ss(1.4, 0.2, r), 1.5) * (0.8 + 0.4 * vnoise(x * 60, y * 60, z * 60, 3));
      } else if (f.kind === "sea") {
        if (r < 1.1) h -= f.depthM * ss(1.1, 0.85, r);
      } else if (f.kind === "corona") {
        // Racetrack banding: ridges and troughs parallel to the outline.
        if (r < 1.05) h += f.reliefM * 0.5 * Math.sin(r * Math.PI * 7) * ss(1.05, 0.85, r) * ss(0.15, 0.35, r);
      }
    }
    return h + (crater === null ? 0 : crater);
  }
  ridge(f, lat, lon) {
    const t = (lon - f.lon0) / f.lonSpan;
    if (t < -0.05 || t > 1.05) return 0;
    const along = ss(0, 0.12, t) * ss(1, 0.88, t);                     // tapers at both ends
    const acrossKm = Math.abs(lat - f.lat) * D2R * this.R / 1000;
    const half = f.baseKm / 2, top = f.topKm / 2;
    if (acrossKm > half) return 0;
    const prof = acrossKm < top ? 1 : 1 - ss(top, half, acrossKm);
    // Height varies along the ridge (segments of different relief), ≤ max.
    const vary = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * 19.0 + 1.3) * Math.cos(t * 7.0));
    return f.heightM * prof * along * vary;
  }
  scarp(f, lat, lon) {
    if (lat < f.lat0 - 1 || lat > f.lat1 + 1) return 0;
    const along = ss(f.lat0 - 1, f.lat0 + 2, lat) * ss(f.lat1 + 1, f.lat1 - 2, lat);
    const acrossKm = (lon - f.lon) * D2R * Math.cos(lat * D2R) * this.R / 1000;
    // A step: higher to the east, lower to the west (facing direction not verified).
    return f.heightM * 0.5 * Math.tanh(acrossKm / f.widthKm) * along * ss(40, 5, Math.abs(acrossKm));
  }
  setStripeAxis() {
    const s = this.list.filter((f) => f.kind === "stripe");
    if (s.length < 2) return;
    // South-polar tangent plane (km): x toward lon 0, y toward lon 90° E.
    const P = (lat, lon) => { const r = (90 + lat) * D2R * this.R / 1000; return [r * Math.cos(lon * D2R), r * Math.sin(lon * D2R)]; };
    const c = s.map((f) => P(f.lat, f.lon)), m = c.reduce((a, p) => [a[0] + p[0] / c.length, a[1] + p[1] / c.length], [0, 0]);
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of c) { const dx = p[0] - m[0], dy = p[1] - m[1]; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);                  // principal axis = spacing direction
    const strike = [-Math.sin(ang), Math.cos(ang)];
    for (const f of s) { f.P = P(f.lat, f.lon); f.strike = strike; f.toPlane = P; }
  }
  stripe(f, x, y, z) {
    if (!f.P) return 0;
    const lat = Math.asin(Math.max(-1, Math.min(1, y))) / D2R;
    if (lat > -55) return 0;
    const q = f.toPlane(lat, Math.atan2(-z, x) / D2R);
    const dx = q[0] - f.P[0], dy = q[1] - f.P[1];
    const along = dx * f.strike[0] + dy * f.strike[1], across = -dx * f.strike[1] + dy * f.strike[0];
    const half = f.lenKm / 2;
    if (Math.abs(along) > half + 4) return 0;
    const taper = ss(half + 4, half - 6, Math.abs(along));
    const a = Math.abs(across), w = f.widthKm / 2;
    // Central trough with ridges on both flanks.
    return taper * (-f.depthM * Math.exp(-Math.pow(a / w, 2)) + f.flankM * Math.exp(-Math.pow((a - 2.2 * w) / w, 2)));
  }
}

// Background terrain character for worlds without a DEM, in metres.
// x, y, z: unit direction; seed: body seed; relief: the world's typical
// relief (m); detail: 0…5.
export function character(kind, x, y, z, seed, relief, detail) {
  const oct = 4 + Math.min(3, detail);
  if (kind === "europa") {
    // Low, ridged ice: double ridges along lineae (narrow ridged noise),
    // patches of blocky chaos, almost no broad relief.
    const lin = ridged(x * 9, y * 9, z * 9, seed, oct) - 0.35;
    const lin2 = ridged(x * 23 + 5, y * 23, z * 23, seed + 3, oct) - 0.35;
    const chaos = ss(0.15, 0.35, fbm(x * 3, y * 3, z * 3, seed + 7, 3)) * (fbm(x * 60, y * 60, z * 60, seed + 9, 3));
    return relief * (0.35 * Math.max(0, lin) + 0.25 * Math.max(0, lin2) + 0.5 * chaos + 0.15 * fbm(x * 4, y * 4, z * 4, seed + 1, 3));
  }
  if (kind === "io") {
    // Smooth volcanic plains with flow lobes and a few mesas; no craters
    // (Io's surface is renewed far faster than impacts accumulate).
    const plains = 0.25 * fbm(x * 6, y * 6, z * 6, seed, oct);
    const mesa = ss(0.42, 0.48, fbm(x * 14, y * 14, z * 14, seed + 4, 3)) * 0.35;
    return relief * (plains + mesa);
  }
  if (kind === "titan") {
    // Broad low relief; linear dunes in the equatorial belt (±30°), running
    // west–east, ~3 km apart, ~100 m tall (Cassini RADAR).
    const lat = Math.asin(Math.max(-1, Math.min(1, y)));
    const broad = 0.5 * fbm(x * 3, y * 3, z * 3, seed, oct);
    const belt = ss(0.6, 0.35, Math.abs(lat));
    const lonw = Math.atan2(-z, x);
    const dune = Math.pow(Math.abs(Math.sin(lat * 2574.7 / 3 * 2 * Math.PI / 2 + 2.5 * fbm(x * 40, y * 40, z * 40, seed + 2, 2) + lonw * 0.0)), 6);
    return relief * broad + 100 * belt * dune * ss(0.3, 0.6, fbm(x * 8, y * 8, z * 8, seed + 5, 2) + 0.5);
  }
  if (kind === "triton") {
    // "Cantaloupe" terrain — closely packed ~30 km dimples — on the western
    // part of the imaged hemisphere (around Bubembe Regio), smooth frost
    // plains elsewhere.
    const lat = Math.asin(Math.max(-1, Math.min(1, y))) / D2R, lon = Math.atan2(-z, x) / D2R;
    const inRegion = ss(70, 40, Math.hypot(lat - 15, ((lon + 25 + 540) % 360) - 180));
    const cells = 1 - Math.abs(vnoise(x * 70, y * 70, z * 70, seed) * 2 - 1);
    return relief * (0.25 * fbm(x * 4, y * 4, z * 4, seed + 1, oct) + 0.45 * inRegion * cells);
  }
  return 0;
}
