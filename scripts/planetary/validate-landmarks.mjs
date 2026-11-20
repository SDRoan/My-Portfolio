// Validates every landmark against the terrain the simulator actually uses
// (whole-body grid + global tiles + landmark patches + reconstructed
// features, through surface-core.js — the same code as the workers):
//
//   node scripts/planetary/validate-landmarks.mjs [--vesta]
//
// For each landmark: height at its coordinates, and — for craters, basins,
// plains and seas — whether the centre lies below a ring around it, or for
// mountains and volcanoes above it (a test that fails if coordinates and
// terrain disagree, e.g. a longitude convention error). Where a published
// height exists it is compared too, with a tolerance that grows with the
// data's cell size (a 2 km grid can't hold a narrow summit).
//
// --vesta: decides Vesta's longitude convention from the data — every
// Gazetteer crater ≥ 20 km is tested for being a depression in the Dawn
// DTM, at each candidate longitude offset and direction.
//
// Writes space/data/surfaces/landmark-report.txt.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Surface, HeightField, Patch, dirFromLatLon } from "../../space/universe/surface-core.js";
import { decodeGrid, readBundle } from "../../space/engine/packs.js";
import { LANDMARKS } from "../../space/nav/landmarks.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const S = join(ROOT, "space", "data", "surfaces");
const M = JSON.parse(readFileSync(join(S, "manifest.json"), "utf8")).bodies;
const FEAT = existsSync(join(S, "features.json")) ? JSON.parse(readFileSync(join(S, "features.json"), "utf8")).bodies : {};
const grid = (file, W, H) => decodeGrid(gunzipSync(readFileSync(join(S, file))), W, H);

// Approximate published values: diameter (km) for the ring test, and height
// (m, relative to the body's datum) where a reliable figure exists.
const REF = {
  "Mount Everest": { d: 20, h: 8849, summit: true }, "Mauna Kea": { d: 40, h: 4207, summit: true }, "Dead Sea": { h: -430, dataset: true }, "Challenger Deep": { h: -10935, dataset: true },
  "Rheasilvia": { d: 450 }, "Veneneia": { d: 400 }, "Marcia": { d: 68 },
  "Kennedy Space Center LC-39A": { h: 3 }, "Tycho": { d: 85 }, "Copernicus": { d: 96 }, "Shackleton": { d: 21 },
  // Volcano heights: published summit elevations above the datum; the
  // Gazetteer gives each edifice's centre, so the test uses the highest
  // point within a quarter-diameter.
  "Olympus Mons": { d: 600, h: 21229, summit: true }, "Elysium Mons": { d: 400, h: 14100, summit: true }, "Arsia Mons": { d: 470, h: 17761, summit: true },
  // Gale has a central mound (Aeolis Mons): its moat, not its centre, lies below the rim.
  "Gale crater": { d: 154, moat: true }, "Jezero crater": { d: 47 }, "Hellas Planitia": { d: 2300 },
  "Caloris Planitia": { d: 1550 }, "Rembrandt": { d: 716 }, "Rachmaninoff": { d: 305 },
  "Maxwell Montes": { d: 800, h: 10800, summit: true }, "Atalanta Planitia": { below: 0 },
  "Occator": { d: 92 }, "Ahuna Mons": { d: 20 }, "Kerwan": { d: 280 },
  "Sputnik Planitia": { d: 1000 }, "Herschel": { d: 139 }, "Turgis": { d: 580 }, "Engelier": { d: 504 }, "Pwyll": { d: 45 },
  "Loki Patera": { d: 226 }, "Boosaule Montes": { d: 540 }, "Kraken Mare": { d: 1170 }, "Ligeia Mare": { d: 500 }, "Selk": { d: 80 },
  "Argo Chasma": {}, "Valles Marineris": {}, "Noctis Labyrinthus": {}
};
const DEPRESSION = /crater|basin|planitia|patera|mare|sea|trench|lowest/i, HIGH = /mons|montes|summit|volcano|cryovolcano|mountain/i;

function loadSurface(id) {
  const e = M[id];
  if (!e) return null;
  const def = { radius: e.radiusMeters, flattening: e.flattening, triaxial: e.axes && e.shapeType === "triaxial ellipsoid" ? e.axes : null };
  const s = new Surface(def, e, {});
  const t = e.terrain || {};
  if (t.file) {
    const f = new HeightField(grid(t.file, t.width, t.height), t.width, t.height, t.scale || 1, id);
    if (t.coverage) f.coverage = new HeightField(grid(t.coverage.file, t.coverage.width, t.coverage.height), t.coverage.width, t.coverage.height, t.coverage.scale, id);
    for (const p of t.patches || []) { const q = new Patch(grid(p.file, p.width, p.height), p.width, p.height, p.scale || 1, p.bounds); q.source = p.source; f.addPatch(q); }
    if (t.tileSet) {
      const ix = JSON.parse(readFileSync(join(S, t.tileSet), "utf8")), n = ix.cells + 2 * ix.margin, T = ix.tileDeg, c = ix.cellDeg, m = ix.margin;
      f.tileDeg = T;
      for (const b of Object.keys(ix.bundles || {})) {
        const raw = readFileSync(join(S, "tiles", id, b + ".bin"));
        for (const [key, gz] of readBundle(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))) {
          const [ty, tx] = key.split("_").map(Number);
          const bounds = { north: 90 - ty * T + m * c, south: 90 - (ty + 1) * T - m * c, west: -180 + tx * T - m * c, east: -180 + (tx + 1) * T + m * c };
          const p = new Patch(decodeGrid(gunzipSync(gz), n, n), n, n, ix.scale, bounds, 0); p.source = ix.source;
          f.addTile(key, p);
        }
      }
    }
    s.field = f;
  }
  if (FEAT[id]) s.setFeatures(FEAT[id]);
  // Earth region packs (3DEP, Copernicus) join the surface as in the simulator.
  const RG = join(ROOT, "space", "data", "earth", "regions");
  if (id === "earth" && existsSync(join(RG, "index.json"))) {
    for (const r of JSON.parse(readFileSync(join(RG, "index.json"), "utf8")).regions) {
      const m = JSON.parse(readFileSync(join(RG, r.id, "meta.json"), "utf8"));
      for (const d of m.dem) { const p = new Patch(decodeGrid(gunzipSync(readFileSync(join(RG, r.id, d.file))), d.width, d.height), d.width, d.height, d.scale, d.bounds); p.source = d.source; s.field.addPatch(p); }
    }
  }
  return s;
}

const h = (s, lat, lon) => { const d = dirFromLatLon(lat, lon); return s.heightAt(d[0], d[1], d[2], 0); };
function ringMean(s, lat, lon, rKm) {
  const R = s.R / 1000, a = rKm / R;                         // angular radius (rad)
  let sum = 0, n = 0;
  for (let k = 0; k < 24; k++) {
    const t = (k / 24) * 2 * Math.PI, la = lat + (a * Math.cos(t)) * 180 / Math.PI, lo = lon + (a * Math.sin(t)) * 180 / Math.PI / Math.max(0.05, Math.cos(lat * Math.PI / 180));
    if (Math.abs(la) > 89.5) continue;
    sum += h(s, la, lo); n++;
  }
  return sum / Math.max(1, n);
}

const rows = [], cache = new Map();
const surf = (id) => { if (!cache.has(id)) cache.set(id, loadSurface(id)); return cache.get(id); };
for (const L of LANDMARKS) {
  const s = surf(L.body);
  if (!s) { rows.push([L.body, L.name, L.lat, L.lon, "—", "—", "WARN", "no surface"]); continue; }
  const ref = REF[L.name] || {};
  // Ocean and lake floors: the dataset, not the (sea-level) walking surface.
  const here = ref.dataset ? s.elevation(...dirFromLatLon(L.lat, L.lon)) : h(s, L.lat, L.lon);
  const lat = L.lat * Math.PI / 180, cellM = s.field ? s.field.cellAt(lat, L.lon * Math.PI / 180) * s.R : Infinity;
  let status = "PASS", notes = [];
  // Relative test (shape of the landform at the coordinates).
  const isLow = DEPRESSION.test(L.kind + " " + L.name), isHigh = HIGH.test(L.kind + " " + L.name);
  if (ref.d && (isLow || isHigh)) {
    const resolved = ref.d * 1000 > 3 * cellM || !s.field;
    const ring = ringMean(s, L.lat, L.lon, ref.d * 0.85), diff = (ref.moat ? ringMean(s, L.lat, L.lon, ref.d * 0.3) : here) - ring;
    const ok = isLow ? diff < 0 : diff > 0;
    notes.push((isLow ? "centre vs rim " : "summit vs base ") + (diff >= 0 ? "+" : "") + Math.round(diff) + " m");
    if (!ok) { status = resolved ? "FAIL" : "WARN"; notes.push(resolved ? "landform not where expected" : "below data resolution"); }
  }
  // Absolute test against a published height.
  if (ref.below !== undefined) { notes.push("below datum: " + Math.round(here) + " m"); if (!(here < ref.below)) status = "FAIL"; }
  let peak = here;
  if (ref.summit) {
    // Highest point within a quarter-diameter (at most 150 km) of the centre.
    const rKm = Math.min(150, ref.d / 4), R = s.R / 1000;
    for (let k = 0; k < 2000; k++) {
      const r = Math.sqrt(k / 2000) * rKm, t = k * 2.39996;
      const la = L.lat + (r / R) * Math.cos(t) * 180 / Math.PI, lo = L.lon + (r / R) * Math.sin(t) * 180 / Math.PI / Math.cos(L.lat * Math.PI / 180);
      peak = Math.max(peak, h(s, la, lo));
    }
    notes.push("summit within " + Math.round(rKm) + " km: " + Math.round(peak) + " m");
  }
  if (ref.h !== undefined) {
    const here0 = here; { const here = ref.summit ? peak : here0;
    const tol = Math.max(150, 0.06 * Math.abs(ref.h), (isHigh ? 0.25 : 0.02) * Math.abs(ref.h) * Math.min(1, cellM / 2000));
    const err = here - ref.h;
    notes.push("expected ~" + ref.h + " m, Δ " + (err >= 0 ? "+" : "") + Math.round(err));
    if (Math.abs(err) > tol) { if (status === "PASS") status = Math.abs(err) > 3 * tol ? "FAIL" : "WARN"; notes.push("tolerance ±" + Math.round(tol) + " m at " + Math.round(cellM) + " m cells"); }
  } }
  if (!ref.d && ref.h === undefined && ref.below === undefined) notes.push("no reference value");
  rows.push([L.body, L.name, L.lat.toFixed(3), L.lon.toFixed(3), Math.round(here), ref.h ?? "—", status, notes.join("; ")]);
}

let out = "Landmark validation — terrain as the simulator builds it (grids + tiles + patches + features)\n\n";
out += ["BODY", "NAME", "LAT", "LON", "DEM HEIGHT m", "EXPECTED m", "RESULT", "NOTES"].join(" | ") + "\n";
for (const r of rows) out += r.join(" | ") + "\n";
const tally = rows.reduce((a, r) => ((a[r[6]] = (a[r[6]] || 0) + 1), a), {});
out += "\n" + JSON.stringify(tally) + "\n";

// ── Vesta: which longitude convention does the Dawn DTM use? ──
if (process.argv.includes("--vesta")) {
  const s = surf("vesta");
  const kmz = join(tmpdir(), "open-planet-cache", "gazetteer", "vesta.kmz");
  mkdirSync(dirname(kmz), { recursive: true });
  if (!existsSync(kmz)) writeFileSync(kmz, Buffer.from(await (await fetch("https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/VESTA_nomenclature_center_pts.kmz")).arrayBuffer()));
  const kml = execFileSync("unzip", ["-p", kmz, "*.kml"], { maxBuffer: 1 << 28 }).toString("utf8");
  const craters = [...kml.matchAll(/<Placemark[^>]*>([\s\S]*?)<\/Placemark>/g)].map((m) => Object.fromEntries([...m[1].matchAll(/<SimpleData name="(\w+)">([\s\S]*?)<\/SimpleData>/g)].map((x) => [x[1], x[2]])))
    .filter((f) => /^Crater/.test(f.type) && +f.diameter >= 20).map((f) => ({ name: f.clean_name, lat: +f.center_lat, lon: +f.center_lon, d: +f.diameter }));
  const score = (sign, off) => {
    let hit = 0;
    for (const c of craters) { const lon = sign * c.lon + off; if (h(s, c.lat, lon) < ringMean(s, c.lat, lon, c.d * 0.8)) hit++; }
    return hit / craters.length;
  };
  const res = [];
  for (const sign of [1, -1]) for (let off = 0; off < 360; off += 5) res.push({ sign, off, f: score(sign, off) });
  res.sort((a, b) => b.f - a.f);
  out += "\nVesta longitude convention test: " + craters.length + " Gazetteer craters ≥ 20 km, fraction that are depressions in the Dawn DTM\n";
  out += "  best: " + (res[0].sign > 0 ? "east" : "west") + " + " + res[0].off + "° → " + (res[0].f * 100).toFixed(0) + "%   (as-is east+0°: " + (res.find((r) => r.sign > 0 && r.off === 0).f * 100).toFixed(0) + "%, median of all offsets " + (res[res.length >> 1].f * 100).toFixed(0) + "%)\n";
  out += "  next: " + res.slice(1, 5).map((r) => (r.sign > 0 ? "E" : "W") + "+" + r.off + "° " + (r.f * 100).toFixed(0) + "%").join(", ") + "\n";
}
writeFileSync(join(S, "landmark-report.txt"), out);
console.log(out);
