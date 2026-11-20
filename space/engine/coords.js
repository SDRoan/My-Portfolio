// Universe coordinates.
//
// A position is an integer sector index plus a float64 offset inside that
// sector. Sectors are 1e13 m (~67 AU) on a side, so the offset never exceeds
// 1e13 and keeps millimetre resolution, while the integer part reaches past
// the observable universe without losing anything (sector indices stay far
// below 2^53).
//
// Nothing is ever rendered at its universe position. Each frame, every object
// is placed relative to the observer in float64 and only then handed to the
// GPU as float32 — the observer is always the render origin (a continuously
// rebased floating origin), so precision lives where the camera is.
//
// Axes are the render frame: X toward the vernal equinox, Y toward ecliptic
// north, Z = X × Y. (J2000 ecliptic (x, y, z) maps to (x, z, −y).)

export const SECTOR = 1e13;
export const KM = 1e3;
export const AU = 1.495978707e11;
export const LY = 9.4607304725808e15;
export const PC = 3.0856775814913673e16;
export const C = 299792458;
export const R_SUN = 6.957e8;
export const DEG = Math.PI / 180;
export const OBLIQ = 23.4392911 * DEG;

export class UPos {
  constructor(sx = 0, sy = 0, sz = 0, x = 0, y = 0, z = 0) {
    this.sx = sx; this.sy = sy; this.sz = sz;
    this.x = x; this.y = y; this.z = z;
    this.norm();
  }
  norm() {
    if (this.x < 0 || this.x >= SECTOR) { const k = Math.floor(this.x / SECTOR); this.sx += k; this.x -= k * SECTOR; }
    if (this.y < 0 || this.y >= SECTOR) { const k = Math.floor(this.y / SECTOR); this.sy += k; this.y -= k * SECTOR; }
    if (this.z < 0 || this.z >= SECTOR) { const k = Math.floor(this.z / SECTOR); this.sz += k; this.z -= k * SECTOR; }
    return this;
  }
  set(o) { this.sx = o.sx; this.sy = o.sy; this.sz = o.sz; this.x = o.x; this.y = o.y; this.z = o.z; return this; }
  clone() { return new UPos(this.sx, this.sy, this.sz, this.x, this.y, this.z); }
  // Move by a float64 vector in metres.
  add(dx, dy, dz) { this.x += dx; this.y += dy; this.z += dz; return this.norm(); }
  addV(v, k = 1) { return this.add(v[0] * k, v[1] * k, v[2] * k); }
  // Position = this + v·k as a new UPos.
  offset(v, k = 1) { return this.clone().addV(v, k); }
  lerpTo(b, t) {
    const d = sub(b, this);
    return this.add(d[0] * t, d[1] * t, d[2] * t);
  }
  static fromMeters(x, y, z) { return new UPos(0, 0, 0, x, y, z); }
  static fromLy(x, y, z) { return fromBig(x * LY, y * LY, z * LY); }
  toLy(out = [0, 0, 0]) {
    out[0] = (this.sx * SECTOR + this.x) / LY;
    out[1] = (this.sy * SECTOR + this.y) / LY;
    out[2] = (this.sz * SECTOR + this.z) / LY;
    return out;
  }
  key() { return this.sx + "," + this.sy + "," + this.sz; }
}

function fromBig(x, y, z) {
  const sx = Math.floor(x / SECTOR), sy = Math.floor(y / SECTOR), sz = Math.floor(z / SECTOR);
  return new UPos(sx, sy, sz, x - sx * SECTOR, y - sy * SECTOR, z - sz * SECTOR);
}

// a − b in metres, float64. Sector differences are exact integers, so nearby
// objects subtract their small offsets directly and stay precise.
export function sub(a, b, out = [0, 0, 0]) {
  out[0] = (a.sx - b.sx) * SECTOR + (a.x - b.x);
  out[1] = (a.sy - b.sy) * SECTOR + (a.y - b.y);
  out[2] = (a.sz - b.sz) * SECTOR + (a.z - b.z);
  return out;
}
export function dist(a, b) {
  const d = sub(a, b, _d);
  return Math.hypot(d[0], d[1], d[2]);
}
const _d = [0, 0, 0];

// J2000 ecliptic vector → render frame, and back.
export function eclToRender(v) { return [v[0], v[2], -v[1]]; }
export function renderToEcl(v) { return [v[0], -v[2], v[1]]; }

// Equatorial unit vector → render frame.
export function eqToRender(x, y, z) {
  return eclToRender([x, y * Math.cos(OBLIQ) + z * Math.sin(OBLIQ), -y * Math.sin(OBLIQ) + z * Math.cos(OBLIQ)]);
}
export function raDecToRender(raDeg, decDeg) {
  const a = raDeg * DEG, d = decDeg * DEG;
  return eqToRender(Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d));
}
export function renderToRaDec(v) {
  const e = renderToEcl(v);
  const x = e[0];
  const y = e[1] * Math.cos(OBLIQ) - e[2] * Math.sin(OBLIQ);
  const z = e[1] * Math.sin(OBLIQ) + e[2] * Math.cos(OBLIQ);
  const r = Math.hypot(x, y, z) || 1;
  let ra = Math.atan2(y, x) / DEG;
  if (ra < 0) ra += 360;
  return { ra, dec: Math.asin(z / r) / DEG };
}

// Depth compression for the near pass. Up to D0 metres objects sit where they
// are; beyond, distance grows logarithmically while size shrinks by the same
// factor, so every object keeps its exact angular size and direction (and
// draw order is preserved — the map is monotonic) while all coordinates stay
// within comfortable float32 range for the GPU.
export const D0 = 2e7;
export function compress(D) {
  return D <= D0 ? 1 : (D0 * (1 + Math.log(D / D0))) / D;
}

// ── formatting ──
export function fmtDistance(m) {
  const a = Math.abs(m);
  if (a < 1e3) return a.toFixed(a < 10 ? 1 : 0) + " m";
  if (a < 1e9) return (a / 1e3).toFixed(a < 1e4 ? 2 : a < 1e5 ? 1 : 0).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + " km";
  if (a < 0.1 * AU) return (a / 1e3 / 1e6).toFixed(2) + " million km";
  if (a < 0.05 * LY) return (a / AU).toFixed(a < 10 * AU ? 3 : 1) + " AU";
  if (a < 1e3 * LY) return (a / LY).toFixed(a < 10 * LY ? 3 : 1) + " ly";
  if (a < 1e6 * LY) return (a / LY / 1e3).toFixed(2) + " kly";
  if (a < 1e9 * LY) return (a / LY / 1e6).toFixed(2) + " Mly";
  return (a / LY / 1e9).toFixed(2) + " Gly";
}
export function fmtSpeed(mps) {
  const a = Math.abs(mps);
  if (a < 1e3) return a.toFixed(a < 10 ? 1 : 0) + " m/s";
  if (a < 1e6) return (a / 1e3).toFixed(a < 1e4 ? 2 : 1) + " km/s";
  if (a < 0.01 * C) return (a / 1e3).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + " km/s";
  if (a < 50 * C) return (a / C).toFixed(a < C ? 3 : 2) + " c";
  if (a < 0.1 * LY) return (a / AU).toFixed(2) + " AU/s";
  if (a < 1e3 * LY) return (a / LY).toFixed(2) + " ly/s";
  if (a < 1e6 * LY) return (a / LY / 1e3).toFixed(2) + " kly/s";
  return (a / LY / 1e6).toFixed(2) + " Mly/s";
}
export function fmtNum(v, digits = 3) {
  if (v === null || v === undefined || Number.isNaN(v)) return "Unknown";
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return v.toExponential(2).replace("e+", "e");
  return (+v.toPrecision(digits)).toLocaleString("en-US");
}
