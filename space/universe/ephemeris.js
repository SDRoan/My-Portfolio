// Positions and orientations of Solar System bodies at a Julian Date.
// Heliocentric, render frame (see coords.js), metres.

import { AU, DEG, KM, eclToRender, eqToRender } from "../engine/coords.js";
import { hashString } from "../engine/rng.js";

const TWO_PI = Math.PI * 2;

function solveKepler(M, e) {
  let E = e < 0.8 ? M : Math.PI;
  for (let i = 0; i < 30; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-12) break;
  }
  return E;
}

// Orbit in its own plane → ecliptic, for argument of perihelion w, node N, inclination I (radians).
function orbitToEcl(xv, yv, w, N, I) {
  const cw = Math.cos(w), sw = Math.sin(w), cn = Math.cos(N), sn = Math.sin(N), ci = Math.cos(I), si = Math.sin(I);
  return [
    (cw * cn - sw * sn * ci) * xv + (-sw * cn - cw * sn * ci) * yv,
    (cw * sn + sw * cn * ci) * xv + (-sw * sn + cw * cn * ci) * yv,
    (sw * si) * xv + (cw * si) * yv
  ];
}

// Standish mean elements (a AU, e, I, L, ϖ, Ω + rates per century).
export function standish(el, T) {
  const a = el[0] + el[6] * T, e = el[1] + el[7] * T, I = (el[2] + el[8] * T) * DEG;
  const L = (el[3] + el[9] * T) * DEG, peri = (el[4] + el[10] * T) * DEG, node = (el[5] + el[11] * T) * DEG;
  let M = (L - peri) % TWO_PI;
  if (M > Math.PI) M -= TWO_PI; if (M < -Math.PI) M += TWO_PI;
  const E = solveKepler(M, e);
  const xv = a * (Math.cos(E) - e), yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
  return orbitToEcl(xv, yv, peri - node, node, I).map((v) => v * AU);
}

// Osculating elements [a AU, e, i°, Ω°, ω°, M° at epoch, epoch JD].
export function osculating(el, jd) {
  const [a, e, i, N, w, M0, ep] = el;
  const n = 0.9856076686 / Math.pow(a, 1.5);
  const M = ((M0 + n * (jd - ep)) % 360) * DEG;
  const E = solveKepler(M, e);
  const xv = a * (Math.cos(E) - e), yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
  return orbitToEcl(xv, yv, w * DEG, N * DEG, i * DEG).map((v) => v * AU);
}

// Comet form [q AU, e, i°, Ω°, ω°, perihelion JD].
export function perihelionForm(el, jd) {
  const [q, e, i, N, w, Tp] = el;
  const a = q / (1 - e);
  const n = 0.9856076686 / Math.pow(a, 1.5);
  let M = ((n * (jd - Tp)) % 360) * DEG;
  if (M > Math.PI) M -= TWO_PI; if (M < -Math.PI) M += TWO_PI;
  const E = solveKepler(M, e);
  const xv = a * (Math.cos(E) - e), yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
  return orbitToEcl(xv, yv, w * DEG, N * DEG, i * DEG).map((v) => v * AU);
}

// Sample a full orbit as ecliptic points (AU) for orbit lines.
export function orbitPolyline(kind, el, n = 256) {
  let a, e, I, N, w;
  if (kind === "standish") { a = el[0]; e = el[1]; I = el[2]; N = el[5]; w = el[4] - el[5]; }
  else if (kind === "osculating") { [a, e, I, N, w] = el; }
  else { const q = el[0]; e = el[1]; a = q / (1 - e); I = el[2]; N = el[3]; w = el[4]; }
  const pts = [];
  for (let k = 0; k <= n; k++) {
    // Sample in eccentric anomaly so perihelion passages stay smooth.
    const E = (k / n) * TWO_PI;
    const xv = a * (Math.cos(E) - e), yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
    pts.push(orbitToEcl(xv, yv, w * DEG, N * DEG, I * DEG));
  }
  return pts;
}

// Geocentric Moon from a truncated lunar theory (Meeus ch. 47, main terms):
// good to a few arcminutes and ~1000 km.
export function moonGeocentric(T) {
  const D = (297.8501921 + 445267.1114034 * T) * DEG;
  const M = (357.5291092 + 35999.0502909 * T) * DEG;
  const Mp = (134.9633964 + 477198.8675055 * T) * DEG;
  const F = (93.2720950 + 483202.0175233 * T) * DEG;
  const lon = (218.3164477 + 481267.88123421 * T
    + 6.289 * Math.sin(Mp) - 1.274 * Math.sin(Mp - 2 * D) + 0.658 * Math.sin(2 * D)
    + 0.214 * Math.sin(2 * Mp) - 0.186 * Math.sin(M) - 0.114 * Math.sin(2 * F)) * DEG;
  const lat = (5.128 * Math.sin(F) + 0.281 * Math.sin(Mp + F)
    - 0.278 * Math.sin(F - Mp) - 0.173 * Math.sin(F - 2 * D)) * DEG;
  const par = (0.9508 + 0.0518 * Math.cos(Mp) + 0.0095 * Math.cos(Mp - 2 * D)
    + 0.0078 * Math.cos(2 * D) + 0.0028 * Math.cos(2 * Mp)) * DEG;
  const r = 6378.14 / Math.sin(par) * KM;
  return [Math.cos(lat) * Math.cos(lon) * r, Math.cos(lat) * Math.sin(lon) * r, Math.sin(lat) * r];
}

// IAU rotation → { pole: render-frame unit vector, meridian: unit vector }.
// spin = [α0, α̇ per century, δ0, δ̇, W0, Ẇ per day].
export function spinAxes(spin, T, d) {
  const a = (spin[0] + spin[1] * T) * DEG, dd = (spin[2] + spin[3] * T) * DEG;
  const W = ((spin[4] + spin[5] * d) % 360) * DEG;
  const P = [Math.cos(dd) * Math.cos(a), Math.cos(dd) * Math.sin(a), Math.sin(dd)];
  const Nn = [-Math.sin(a), Math.cos(a), 0];
  const Q = [P[1] * Nn[2] - P[2] * Nn[1], P[2] * Nn[0] - P[0] * Nn[2], P[0] * Nn[1] - P[1] * Nn[0]];
  const cw = Math.cos(W), sw = Math.sin(W);
  return {
    pole: eqToRender(P[0], P[1], P[2]),
    meridian: eqToRender(cw * Nn[0] + sw * Q[0], cw * Nn[1] + sw * Q[1], cw * Nn[2] + sw * Q[2])
  };
}

// Pole only (no prime meridian), for moon orbit planes.
export function poleOf(spin, T) {
  const a = (spin[0] + spin[1] * T) * DEG, dd = (spin[2] + spin[3] * T) * DEG;
  return eqToRender(Math.cos(dd) * Math.cos(a), Math.cos(dd) * Math.sin(a), Math.sin(dd));
}

function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

// A moon on a mean orbit in its parent's equatorial plane (tilted by its
// inclination about a fixed node). Phase is not tabulated here, so it is seeded
// per moon — the info panel calls the position approximate.
export function moonOffset(body, parentPole, jd) {
  const [aKm, pDays, incDeg, e] = body.moon;
  const seed = hashString(body.id);
  const phase0 = (seed % 3600) / 10 * DEG;
  const node = ((seed >>> 12) % 3600) / 10 * DEG;
  let u = norm(cross(parentPole, Math.abs(parentPole[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
  let v = cross(parentPole, u);
  // rotate (u, v) by node, then tilt by inclination about the node line
  const cu = Math.cos(node), su = Math.sin(node);
  const n1 = [u[0] * cu + v[0] * su, u[1] * cu + v[1] * su, u[2] * cu + v[2] * su];
  const n2 = cross(parentPole, n1);
  const ci = Math.cos(incDeg * DEG), si = Math.sin(incDeg * DEG);
  const w2 = [n2[0] * ci + parentPole[0] * si, n2[1] * ci + parentPole[1] * si, n2[2] * ci + parentPole[2] * si];
  const M = phase0 + TWO_PI * (jd - 2451545.0) / pDays;
  const E = solveKepler(((M % TWO_PI) + TWO_PI) % TWO_PI, e || 0);
  const r = aKm * KM;
  const x = r * (Math.cos(E) - (e || 0)), y = r * Math.sqrt(1 - (e || 0) ** 2) * Math.sin(E);
  return {
    pos: [n1[0] * x + w2[0] * y, n1[1] * x + w2[1] * y, n1[2] * x + w2[2] * y],
    normal: norm(cross(n1, w2)),
    basis: [n1, w2]
  };
}

// Heliocentric position (render frame, metres) of any body at jd. Moons need
// their parent's position, which the caller supplies.
export function heliocentric(body, jd, T) {
  if (body.elements) return eclToRender(standish(body.elements, T));
  if (body.osculating) return eclToRender(osculating(body.osculating, jd));
  if (body.perihelion) return eclToRender(perihelionForm(body.perihelion, jd));
  return [0, 0, 0];
}
