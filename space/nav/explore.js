// Helpers for being on or near a body: the local horizon, air density, a
// daylight start time for the launch, and the readouts for the HUD.

import * as THREE from "three";
import { sub, fmtDistance, fmtSpeed } from "../engine/coords.js";
import { latLon, fmtLatLon, dirFromLatLon } from "../universe/surfaces.js";

const _f = new THREE.Vector3(), _u = new THREE.Vector3(), _r = new THREE.Vector3(), _n = new THREE.Vector3(), _e = new THREE.Vector3(), _b = new THREE.Vector3();
const D2R = Math.PI / 180;

// Heading, pitch and roll of an orientation relative to a body's horizon.
// north: the body's pole (world). Returns degrees; heading 0 = north, 90 = east.
export function horizonAngles(quat, upArr, poleWorld, bankQuat) {
  const f = _f.set(0, 0, -1).applyQuaternion(quat);
  const ub = _b.set(0, 1, 0);
  if (bankQuat) ub.applyQuaternion(bankQuat);
  ub.applyQuaternion(quat);
  const U = _u.set(upArr[0], upArr[1], upArr[2]);
  const pitch = Math.asin(Math.max(-1, Math.min(1, f.dot(U)))) * 180 / Math.PI;
  const right = _r.crossVectors(f, U);
  if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
  right.normalize();
  const roll = Math.atan2(-ub.dot(right), ub.dot(U)) * 180 / Math.PI;
  const N = _n.copy(poleWorld).addScaledVector(U, -poleWorld.dot(U));
  let heading = null;
  if (N.lengthSq() > 1e-8) {
    N.normalize();
    const E = _e.crossVectors(N, U).normalize();
    heading = (Math.atan2(f.dot(E), f.dot(N)) * 180 / Math.PI + 360) % 360;
  }
  return { pitch, roll, heading };
}

// 0 in vacuum … 1 in thick air: how much aerodynamics matters at this height.
export function airFactor(body, alt) {
  const e = body && body.def.surfaceEntry;
  if (!e || !e.atmosphere || !body.atmoRa) return 0;
  const p = e.atmosphere.pressureBar || 0;
  if (p < 0.001) return 0;
  const hA = (body.atmoRa - 1) * body.radius;
  if (alt > hA) return 0;
  const thick = Math.min(1, p / 0.5);
  return thick * Math.pow(Math.max(0, 1 - alt / hA), 2);
}

// A daylight start: the most recent moment (within the last `span` days — one
// solar day of the body) when the Sun stands ~35° high in the morning sky
// over the site.
export function daylightJD(universe, earthId, site, nowJd, span = 1) {
  let best = nowJd, bestErr = Infinity;
  for (let k = 0; k <= 96; k++) {
    const jd = nowJd - (k / 96) * span;
    universe.updateSolar(jd);
    const e = universe.solar.get(earthId).body, sun = universe.sun.def.pos;
    const d = dirFromLatLon(site.lat, site.lon);
    const up = new THREE.Vector3(...d).applyQuaternion(e.quat);
    const s = sub(sun, e.pos), sl = Math.hypot(s[0], s[1], s[2]);
    const elev = Math.asin((up.x * s[0] + up.y * s[1] + up.z * s[2]) / sl) * 180 / Math.PI;
    // Morning: the Sun is higher a little later.
    universe.updateSolar(jd + 0.01 * span);
    const s2 = sub(universe.sun.def.pos, e.pos), up2 = new THREE.Vector3(...d).applyQuaternion(e.quat);
    const rising = (up2.x * s2[0] + up2.y * s2[1] + up2.z * s2[2]) / Math.hypot(s2[0], s2[1], s2[2]) > Math.sin(elev * Math.PI / 180);
    const err = Math.abs(elev - 35) + (rising ? 0 : 40);
    if (err < bestErr) { bestErr = err; best = jd; }
  }
  universe.updateSolar(best);
  return best;
}

export function surfaceRows(body, g, opts) {
  const e = body.def.surfaceEntry || {};
  const ll = g.dir ? latLon(g.dir) : null;
  const rows = [];
  if (ll) rows.push(["Location", fmtLatLon(ll.lat, ll.lon)]);
  rows.push(["Altitude", fmtDistance(Math.max(0, opts.alt))]);
  if (opts.vs !== undefined) rows.push(["Vertical speed", (opts.vs >= 0 ? "+" : "") + opts.vs.toFixed(1) + " m/s"]);
  if (opts.hs !== undefined) rows.push(["Surface speed", fmtSpeed(opts.hs), "", "minor"]);
  if (e.gravity) rows.push(["Gravity", e.gravity.toPrecision(3) + " m/s² · " + (e.gravity / 9.80665).toFixed(e.gravity < 0.5 ? 4 : 2) + " g" + (e.gravityEstimated ? " (est.)" : "")]);
  const a = e.atmosphere;
  rows.push(["Atmosphere", a && a.pressureBar ? a.pressureBar + " bar" + (a.breathable ? " · breathable" : "") : "None (vacuum)"]);
  if (e.temperatureK) rows.push(["Mean temperature", e.temperatureK + " K", "", "minor"]);
  if (opts.landing) rows.push(["Landing", opts.landing, opts.landingOk ? "ok" : "warn"]);
  // What is real here, and how fine. ("minor" rows are hidden on phones.)
  const S = body.getSurface ? body.getSurface() : null, f = S && S.field;
  const la = g.dir ? Math.asin(Math.max(-1, Math.min(1, g.dir.y))) : 0, lo = g.dir ? Math.atan2(-g.dir.z, g.dir.x) : 0;
  const t = e.terrain || {};
  if (f && g.dir) {
    const local = f.sourceAt(la, lo) || (t.source || "").replace(/\(.*\)/, "").trim();
    rows.push(["Surface geometry", local + " — real DEM"]);
    const cellM = f.cellAt(la, lo) * S.R;
    rows.push(["Data resolution", "~" + (cellM >= 1000 ? (cellM / 1000).toFixed(1) + " km" : Math.round(cellM) + " m") + " per cell"]);
    if (f.coverage) {
      const c = f.coverage.sample(la, lo);
      rows.push(["This location", c >= 0.5 ? "REAL DEM — mapped" : "PROCEDURAL FILL — not directly mapped", c >= 0.5 ? "ok" : "warn"]);
    }
    rows.push(["Local detail", "procedural, below the data resolution (≤ " + S.microMax().toFixed(1) + " m)", "", "minor"]);
  } else if (S && t.proceduralReliefM) {
    rows.push(["Surface geometry", "real size & shape; relief PROCEDURAL — no published DEM", "warn"]);
    rows.push(["Imagery", (e.imagerySource || "").replace(/\(.*?\)/g, "").trim() + " — real", "", "minor"]);
    rows.push(["Local detail", "procedural, held to typical relief (±" + t.proceduralReliefM + " m)", "", "minor"]);
  } else rows.push(["Surface data", t.label || "Unknown"]);
  // Reconstructed features (features.json): which one, if any, is underfoot.
  if (S && S.featureList && S.featureList.length && g.dir) {
    const f = featureHere(S.featureList, la / D2R, lo / D2R, S.R);
    rows.push(["Features", f ? f.name + " — DATA-CONSTRAINED RECONSTRUCTION" : S.featureList.length + " reconstructed at IAU positions", "warn"]);
    if (f && f.measured) rows.push(["Measured", f.measured, "", "minor"]);
    rows.push(["Estimated", f && f.estimated ? f.estimated : "depths and profiles from published scaling, not a DEM", "", "minor"]);
  }
  if (e.sourceClassification) rows.push(["Data class", e.sourceClassification + " · " + ({ A: "real global DEM + global imagery", B: "real partial DEM", C: "real shape + imagery", D: "real size/shape, procedural surface" })[e.sourceClassification], "", "minor"]);
  return rows;
}

// The named reconstructed feature at a point (degrees), or null.
function featureHere(list, lat, lon, R) {
  const km = (la, lo) => {
    const dl = (lo - lon) * D2R, a = Math.sin((la - lat) * D2R / 2) ** 2 + Math.cos(la * D2R) * Math.cos(lat * D2R) * Math.sin(dl / 2) ** 2;
    return 2 * Math.asin(Math.min(1, Math.sqrt(a))) * R / 1000;
  };
  let best = null, bd = Infinity;
  for (const f of list) {
    let d, reach;
    if (f.kind === "ridge") { d = lon >= Math.min(f.lon0, f.lon1) && lon <= Math.max(f.lon0, f.lon1) ? km(f.lat, lon) : Infinity; reach = f.baseKm; }
    else if (f.kind === "scarp") { d = lat >= Math.min(f.lat0, f.lat1) && lat <= Math.max(f.lat0, f.lat1) ? km(lat, f.lon) : Infinity; reach = f.widthKm * 2; }
    else if (f.lat !== undefined) { d = km(f.lat, f.lon); reach = (f.dKm || f.lenKm || 0) * 0.6; }
    else continue;
    if (d < reach && d / reach < bd) { bd = d / reach; best = f; }
  }
  return best;
}

