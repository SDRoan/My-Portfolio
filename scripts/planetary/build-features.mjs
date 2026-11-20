// Data-constrained surface features for worlds without a global DEM:
//
//   node scripts/planetary/build-features.mjs
//
// Positions and sizes are real: the IAU/USGS Gazetteer of Planetary
// Nomenclature data files (asc-planetarynames-data, *_nomenclature_center_pts,
// planetocentric, east-positive). Shapes are reconstructions — crater depth,
// rim and central peak from published scaling relations, or published values
// for a few named features (Herschel, Iapetus's ridge). Every feature records
// which parts are measured and which are estimated.
//
// Writes space/data/surfaces/features.json — merged into the surface manifest.

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE = join(tmpdir(), "open-planet-cache", "gazetteer");
mkdirSync(CACHE, { recursive: true });
const RADIUS_KM = Object.fromEntries(JSON.parse(readFileSync(join(ROOT, "data", "astronomy", "solar-system.json"), "utf8")).bodies.map((b) => [b.id, b.radiusKm]));
const GAZ = "IAU/USGS Gazetteer of Planetary Nomenclature";

async function gazetteer(body) {
  const kmz = join(CACHE, body + ".kmz"), dir = join(CACHE, body);
  if (!existsSync(kmz)) {
    const r = await fetch("https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/" + body.toUpperCase() + "_nomenclature_center_pts.kmz");
    if (!r.ok) throw new Error(body + ": HTTP " + r.status);
    writeFileSync(kmz, Buffer.from(await r.arrayBuffer()));
  }
  mkdirSync(dir, { recursive: true });
  const kml = execFileSync("unzip", ["-p", kmz, "*.kml"], { maxBuffer: 1 << 28 }).toString("utf8");
  return [...kml.matchAll(/<Placemark[^>]*>([\s\S]*?)<\/Placemark>/g)].map((m) => {
    const f = Object.fromEntries([...m[1].matchAll(/<SimpleData name="(\w+)">([\s\S]*?)<\/SimpleData>/g)].map((x) => [x[1], x[2]]));
    return { name: f.clean_name, type: f.type || "", lat: +f.center_lat, lon: ((+f.center_lon + 180) % 360 + 360) % 360 - 180, d: +f.diameter || 0 };
  }).filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lon));
}

// Crater morphology on icy and rocky satellites (approximate scaling):
//   simple below the transition diameter Dt: depth ≈ 0.2 D, rim ≈ 0.04 D
//   complex: depth ≈ 0.2 Dt (D/Dt)^0.4, rim ≈ 0.012 D^0.9 (km), central peak
//   above 2 Dt; very large basins (D > 0.6 R) relaxed to a third of that.
// Dt scales inversely with gravity (≈ 15 km at 1.3 m/s² for icy moons).
function crater(f, g, R, icy) {
  const D = f.d, Dt = Math.min(40, (icy ? 15 : 20) * 1.3 / Math.max(0.05, g));
  let depth = D < Dt ? 0.2 * D : 0.2 * Dt * Math.pow(D / Dt, 0.4);
  let rim = D < Dt ? 0.04 * D : 0.012 * Math.pow(D, 0.9);
  let peak = D > 2 * Dt ? 0.35 * depth : 0;
  if (D > 0.6 * R) { depth /= 3; rim /= 3; peak /= 3; }
  return { kind: "crater", name: f.name, lat: f.lat, lon: f.lon, dKm: D, depthM: Math.round(depth * 1000), rimM: Math.round(rim * 1000), peakM: Math.round(peak * 1000) };
}

const GRAV = { mimas: 0.064, tethys: 0.145, dione: 0.232, rhea: 0.264, iapetus: 0.223, ganymede: 1.428, callisto: 1.235, europa: 1.315, io: 1.796, titan: 1.354,
  miranda: 0.079, ariel: 0.269, umbriel: 0.2, titania: 0.367, oberon: 0.346, triton: 0.779 };

async function build() {
  const out = {};
  const add = (id, f) => (out[id] = out[id] || []).push(f);
  for (const id of Object.keys(GRAV)) {
    let list;
    try { list = await gazetteer(id); } catch (e) { console.warn("no gazetteer for", id, e.message); continue; }
    const R = RADIUS_KM[id], g = GRAV[id], icy = id !== "io";
    let n = 0;
    for (const f of list) {
      const t = f.type.toLowerCase();
      if (t.startsWith("crater") && f.d >= 3 && !(id === "mimas" && f.name === "Herschel")) { add(id, crater(f, g, R, icy)); n++; }
      else if (t.startsWith("patera") && f.d > 0) {           // Io: volcanic depressions, steep walls, flat floors
        add(id, { kind: "patera", name: f.name, lat: f.lat, lon: f.lon, dKm: f.d, depthM: Math.round(Math.min(1500, 200 + 8 * f.d)) }); n++;
      } else if (t.startsWith("mons") && f.d > 0 && id === "io") {
        add(id, { kind: "mons", name: f.name, lat: f.lat, lon: f.lon, dKm: Math.min(f.d, 600), heightM: Math.round(Math.min(8000, 25 * f.d)) }); n++;
      } else if ((t.startsWith("mare") || t.startsWith("lacus")) && id === "titan" && f.d > 0) {
        add(id, { kind: "sea", name: f.name, lat: f.lat, lon: f.lon, dKm: f.d, depthM: 300 }); n++;
      } else if (t.startsWith("corona") && f.d > 0) {           // Miranda
        add(id, { kind: "corona", name: f.name, lat: f.lat, lon: f.lon, dKm: f.d, reliefM: 1500 }); n++;
      }
    }
    console.log(id.padEnd(9), list.length, "named features,", n, "used");
  }
  // Named features with published dimensions.
  // Herschel: D 139 km (Gazetteer, centre 1.38° S, 111.76° W); floor up to
  // ~10 km below the rim, central peak ~6 km above the floor, walls ~5 km
  // (Moore et al. 2004).
  add("mimas", { kind: "crater", name: "Herschel", lat: -1.38, lon: -111.76, dKm: 139, depthM: 10000, rimM: 2500, peakM: 6000, flatFloor: true,
    measured: "position, diameter (" + GAZ + "); depth ~10 km, central peak ~6 km (Moore et al. 2004)", estimated: "exact profile" });
  // Iapetus's equatorial ridge along the IAU-mapped Toledo Montes
  // (equator, 180.7° E – 267.3° E): up to ~13 km high, base 60–70 km,
  // trapezoidal with a flat top (Giese et al. 2008).
  add("iapetus", { kind: "ridge", name: "Toledo Montes (equatorial ridge)", lat: 0, lon0: -179.3, lon1: -92.7, heightM: 13000, baseKm: 65, topKm: 20,
    measured: "location and extent (" + GAZ + ": Toledo Montes); max height ~13 km, base width 60–70 km (Giese et al. 2008)", estimated: "height variation along the ridge, profile details" });
  // Enceladus's tiger stripes (south polar terrain): centres and lengths from
  // the Gazetteer; strike perpendicular to the line through their centres
  // (they are parallel, ~35 km apart). Troughs ~500 m deep, ~2 km wide,
  // flanked by ridges ~100 m high (Porco et al. 2006).
  for (const [name, lat, lon, len] of [["Alexandria Sulcus", -75.63, -137.56, 111], ["Cairo Sulcus", -81.62, -154.48, 165], ["Baghdad Sulcus", -86.91, 129.46, 176], ["Damascus Sulcus", -80.59, 74.13, 125]])
    add("enceladus", { kind: "stripe", name, lat, lon, lenKm: len, depthM: 500, widthKm: 2, flankM: 100,
      measured: "centre and length (" + GAZ + "); trough depth/width (Porco et al. 2006)", estimated: "exact trace (straight segment, strike from the stripe set)" });
  // Miranda: Verona Rupes, the tallest known cliff in the Solar System
  // (~5–10 km; 5 km used), running N–S at ~12° W from 31° S to 5° S.
  add("miranda", { kind: "scarp", name: "Verona Rupes", lat0: -31.1, lat1: -5.5, lon: -12.2, heightM: 5000, widthKm: 3,
    measured: "position and extent (" + GAZ + "); height 5–10 km (Voyager 2)", estimated: "facing direction and exact trace" });
  const total = Object.values(out).reduce((s, l) => s + l.length, 0);
  // Provenance per kind (named features carry their own).
  const legend = {
    crater: { measured: "position and diameter (" + GAZ + ")", estimated: "depth, rim and central peak from crater scaling" },
    patera: { measured: "position and diameter (" + GAZ + ")", estimated: "depth (Io paterae: hundreds of metres to ~1.5 km)" },
    mons: { measured: "position and extent (" + GAZ + ")", estimated: "height (Io mountains average ~6 km; capped at 8 km)" },
    sea: { measured: "position and extent (" + GAZ + ")", estimated: "basin shape (flat liquid surface ~300 m below its surroundings)" },
    corona: { measured: "position and size (" + GAZ + ")", estimated: "concentric ridge-and-trough banding, ±1.5 km" }
  };
  writeFileSync(join(ROOT, "space", "data", "surfaces", "features.json"), JSON.stringify({ legend, bodies: out }));
  console.log("features:", total, "for", Object.keys(out).length, "bodies");
}
await build();
