// Builds space/data/surfaces/manifest.json: for every Solar System body, what
// kind of surface it has, whether you can land and walk, its atmosphere, its
// gravity, and where its surface data comes from — honestly labelled.
//
//   node scripts/planetary/build-surface-manifest.mjs
//
// Physical values: radius and mass from data/astronomy/solar-system.json
// (JPL); gravity is computed as GM/R². Atmospheric values are standard
// reference figures (NASA planetary fact sheets).

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOLAR = JSON.parse(readFileSync(join(ROOT, "data", "astronomy", "solar-system.json"), "utf8"));
const DIR = join(ROOT, "space", "data", "surfaces");
const G = 6.674e-11;

// [pressure bar | 0 vacuum, mean temperature K | null, breathable, visibility note]
const ATMO = {
  earth: [1.013, 288, true], venus: [92, 737, false, "dense CO₂ and sulphuric-acid cloud; surface visibility a few km"],
  mars: [0.006, 210, false], titan: [1.5, 94, false, "thick nitrogen haze; dim orange daylight"],
  pluto: [0.00001, 44, false], triton: [0.000014, 38, false],
  jupiter: [1, 165, false], saturn: [1, 134, false], uranus: [1, 76, false], neptune: [1, 72, false]
};
const TEMP = { moon: 250, mercury: 440, io: 110, europa: 102, ganymede: 110, callisto: 134, enceladus: 75, ceres: 168, charon: 53, eris: 42, makemake: 40, haumea: 50, vesta: 200 };
// Gas and ice giants: how deep the simulation lets you go below the 1-bar level.
const GIANT_LIMIT_KM = { jupiter: 150, saturn: 150, uranus: 100, neptune: 100 };

const ELEV = { earth: "earth", moon: "moon", mars: "mars", mercury: "mercury", venus: "venus", ceres: "ceres", vesta: "vesta", pluto: "pluto", charon: "charon", enceladus: "enceladus", phobos: "phobos", deimos: "deimos", hyperion: "hyperion" };
// Gazetteer-placed reconstructed features (build-features.mjs).
const FEATURES = existsSync(join(DIR, "features.json")) ? JSON.parse(readFileSync(join(DIR, "features.json"), "utf8")).bodies : {};
// Terrain character where no DEM exists (space/universe/features.js).
const CHARACTER = { europa: "europa", io: "io", titan: "titan", triton: "triton" };
const MAPS = {
  venus: "Solar System Scope (CC BY 4.0), from NASA Magellan radar",
  earth: "NASA Blue Marble (land) + NASA Black Marble 2016 (night)"
};
const GLOBAL_MAPS = { pluto: ["pluto_newhorizons.jpg", "New Horizons global mosaic 300 m (USGS Astrogeology), greyscale, tinted", 1200, 0.5, true],
  charon: ["charon_newhorizons.jpg", "New Horizons global mosaic 300 m (USGS Astrogeology), greyscale, tinted", 600, 0.5, true] };
// Microdetail roughness (amplitude per metre of wavelength) by world.
const ROUGH = { earth: 0.02, mars: 0.06, moon: 0.05, mercury: 0.05, venus: 0.035, ceres: 0.05, vesta: 0.06, io: 0.04, europa: 0.015, enceladus: 0.02,
  titan: 0.02, pluto: 0.035, charon: 0.045, triton: 0.025, ganymede: 0.03, callisto: 0.05 };
// Typical relief (m, peak-to-trough of the procedural field) and crater
// strength for bodies with imagery but no global DEM — from the literature:
// Europa is famously flat (a few hundred m; few craters); Io's plains are
// low with rare tall mountains and almost no impact craters; Titan's relief
// is low (Cassini altimetry: hundreds of m) with few craters; Ganymede and
// Callisto ~1–2 km, cratered; the mid-size Saturnian moons a few km,
// heavily cratered; Triton low relief, young and lightly cratered.
const TYPICAL = { europa: [300, 0.05], io: [900, 0.0], titan: [400, 0.04], ganymede: [1500, 0.35], callisto: [1800, 0.6], enceladus: [1000, 0.3],
  tethys: [3000, 0.55], dione: [2500, 0.5], rhea: [3000, 0.55], iapetus: [4000, 0.5], triton: [600, 0.08], phobos: [800, 0.6] };
const SHAPE_SRC = { haumea: "1161 × 852 × 513 km, Ortiz et al. 2017 (occultation)", mimas: "206.6 × 195.7 × 190.5 km, Tajeddine et al. 2014",
  tethys: "538.4 × 528.3 × 526.3 km, Thomas 2010", dione: "563.4 × 561.3 × 559.6 km, Thomas 2010", rhea: "765.0 × 763.1 × 762.4 km, Thomas 2010",
  iapetus: "747.4 × 712.4 km oblate, Thomas et al. 2007", deimos: "Thomas (1993) shape model, 5° grid (PDS)", hyperion: "Thomas Voyager shape model, 5° grid (PDS)",
  phobos: "Mars Express HRSC global DEM", enceladus: "Cassini ISS shape model (Bland et al. 2019)", earth: "WGS 84" };
const json = (f) => (existsSync(join(DIR, f)) ? JSON.parse(readFileSync(join(DIR, f), "utf8")) : null);

const out = { generated: new Date().toISOString().slice(0, 10), classes: {
  A: "Real global DEM + real global imagery", B: "Real partial DEM + real/partial imagery", C: "Real shape + real imagery, no detailed DEM", D: "Real size/shape only + procedural surface" }, bodies: {} };
for (const b of SOLAR.bodies) {
  if (b.kind === "star") continue;
  const R = (b.eqRadiusKm || b.radiusKm) * 1000;
  const gravity = b.massKg ? (G * b.massKg) / Math.pow(b.radiusKm * 1000, 2) : null;
  const giant = ["jupiter", "saturn", "uranus", "neptune"].includes(b.id);
  const a = ATMO[b.id];
  const elev = ELEV[b.id] ? json(ELEV[b.id] + "-elevation.json") : null;
  const tiles = json(b.id + "-tiles.json"), img = json(b.id + "-imagery.json");
  const sssMap = typeof b.look === "string" && (b.look.startsWith("map:") || b.look === "earth");
  // Imagery: a USGS mosaic built by build-terrain.mjs, the New Horizons maps,
  // or the original Solar System Scope / NASA maps.
  let imagery = null;
  if (img) imagery = { file: img.file, source: img.source, resolutionM: img.resolutionM, grey: img.grey, fill: !!img.fill, coverage: "global", surfaceOnly: !!img.surfaceOnly };
  else if (GLOBAL_MAPS[b.id]) { const g = GLOBAL_MAPS[b.id]; imagery = { file: g[0], source: g[1], resolutionM: g[2], grey: true, fill: true, coverage: "encounter hemisphere (" + Math.round(g[3] * 100) + "%)" }; }
  else if (sssMap && !giant) imagery = { file: null, source: MAPS[b.id] || "Solar System Scope (CC BY 4.0), from NASA imagery", resolutionM: Math.round(2 * Math.PI * R / 2048), coverage: "global" };
  let terrain;
  if (giant) terrain = { mode: "none", label: "No solid surface — gas/ice giant" };
  else if (elev) {
    const mapped = elev.mappedFraction ?? 1;
    terrain = { mode: "real-base-procedural-microdetail",
      label: elev.shapeFromData && elev.width <= 360 ? "REAL SHAPE MODEL (5° grid) + PROCEDURAL SURFACE DETAIL — no DEM finer than the shape"
        : mapped < 0.999 ? "REAL DEM (" + Math.round(mapped * 100) + "% mapped) + PROCEDURAL FILL elsewhere" : "REAL GLOBAL DEM + PROCEDURAL MICRODETAIL",
      file: elev.file, width: elev.width, height: elev.height, coverage: elev.coverage || null, mappedFraction: mapped,
      scale: elev.scale, encoding: elev.encoding, source: elev.source, url: elev.url, license: elev.license, reference: elev.reference,
      shapeFromData: !!elev.shapeFromData };
    // Lazily streamed finer data: global tiles and landmark windows.
    if (tiles) terrain.tileSet = b.id + "-tiles.json";
    const patches = readdirSync(DIR).filter((f) => f.startsWith(ELEV[b.id] + "-") && f.endsWith("-elevation.json") && f !== ELEV[b.id] + "-elevation.json")
      .map((f) => JSON.parse(readFileSync(join(DIR, f), "utf8"))).filter((p) => p.bounds)
      .map((p) => ({ file: p.file, width: p.width, height: p.height, scale: p.scale, bounds: p.bounds, source: p.source, bytes: p.bytes, lazy: !!p.lazy, resolutionM: p.resolutionM || null }));
    if (patches.length) terrain.patches = patches;
  } else if (imagery) {
    // No published global DEM: procedural relief, held to the body's known
    // typical relief and crater character (literature values, see TYPICAL).
    const ty = TYPICAL[b.id] || [800, 0.3];
    const nf = (FEATURES[b.id] || []).length;
    terrain = { mode: "real-imagery-procedural-relief",
      label: "REAL SHAPE + REAL IMAGERY + " + (nf ? "RECONSTRUCTED FEATURES (" + nf + " at IAU positions) + " : "") + "PROCEDURAL RELIEF (not measured; typical ±" + ty[0] + " m)",
      proceduralReliefM: ty[0], craters: nf ? Math.min(ty[1], 0.12) : ty[1], character: CHARACTER[b.id] || null };
  }
  else {
    const nf = (FEATURES[b.id] || []).length;
    terrain = { mode: "procedural", label: nf ? "RECONSTRUCTED FEATURES (" + nf + " at IAU positions) + PROCEDURAL RELIEF — no DEM or global map" : "PROCEDURAL INTERPRETATION based on known size, shape and properties",
      craters: nf ? 0.12 : undefined };
  }
  if (FEATURES[b.id] && FEATURES[b.id].length && !giant) terrain.features = FEATURES[b.id].length;
  const l0Res = elev ? Math.round(2 * Math.PI * R / elev.width) : null;
  const bestRes = Math.min(...[l0Res, tiles && tiles.resolutionM, ...((terrain.patches || []).map((p) => p.resolutionM))].filter(Boolean));
  const mapped = elev ? (elev.mappedFraction ?? 1) : 0;
  const klass = giant ? null : elev && mapped >= 0.999 && imagery && imagery.coverage === "global" && !/Solar System Scope/.test(imagery.source) ? "A" : elev ? "B" : imagery && imagery.file ? "C" : "D";
  const rough = ROUGH[b.id] || 0.045;
  out.bodies[b.id] = {
    id: b.id, name: b.name, kind: b.kind,
    radiusMeters: R, referenceRadius: R, meanRadiusMeters: b.radiusKm * 1000, flattening: b.flattening || 0,
    shapeType: giant ? "oblate spheroid (1-bar level)" : elev && elev.shapeFromData ? "irregular shape model" : b.triaxial ? "triaxial ellipsoid" : b.flattening ? "oblate spheroid" : "sphere",
    shapeSource: SHAPE_SRC[b.id] || (elev && elev.shapeFromData ? elev.source : b.triaxial || b.flattening ? "catalogue axes" : "mean radius"),
    axes: b.triaxial || [1, 1 - (b.flattening || 0), 1],
    gravity: gravity !== null ? +gravity.toPrecision(4) : null, gravityEstimated: !!b.massEstimated,
    surfaceType: giant ? (["uranus", "neptune"].includes(b.id) ? "ice-giant" : "gas-giant") : "solid",
    landable: !giant, walkable: !giant,
    explorationMode: giant ? "atmospheric-flight" : "surface",
    depthLimitMeters: giant ? GIANT_LIMIT_KM[b.id] * 1000 : null,
    atmosphere: a ? { pressureBar: a[0], breathable: !!a[2], note: a[3] || null } : { pressureBar: 0, breathable: false, note: null },
    temperatureK: a ? a[1] : TEMP[b.id] || null,
    terrain,
    elevationSource: elev ? [elev.source, tiles && tiles.source].filter(Boolean).join(" + ") : null,
    elevationResolution: elev ? { globalM: l0Res, tilesM: tiles ? tiles.resolutionM : null, bestM: bestRes } : null,
    elevationCoverage: elev ? (mapped < 0.999 ? Math.round(mapped * 100) + "% (observed areas)" : "global") : "none",
    imagerySource: imagery ? imagery.source : "procedural colour",
    imageryResolution: imagery ? imagery.resolutionM : null,
    imageryCoverage: imagery ? imagery.coverage : "none",
    proceduralFill: giant ? null : elev ? (mapped < 0.999 ? "unmapped areas: inpainted from mapped edges + procedural relief (labelled)" : "below the data resolution only") : imagery && imagery.file ? "all relief (no DEM exists), held to the body's typical relief" : "all terrain",
    microdetail: { roughness: rough, maxAmplitude: +(rough * 24 * 1.6).toFixed(2) },
    microdetailMaxAmplitude: +(rough * 24 * 1.6).toFixed(2),
    sourceClassification: klass,
    // Venus: a map of the ground for close up (from orbit you see its clouds).
    surfaceMap: imagery && imagery.surfaceOnly ? imagery.file : b.id === "venus" ? "venus_surface.jpg" : null,
    // No map needs shifting: every source is rotated to −180° at build time
    // from its own central meridian (see validation.txt).
    mapLonShift: 0,
    globalMap: imagery && imagery.file && !imagery.surfaceOnly ? imagery.file : null, globalMapGrey: !!(imagery && imagery.grey), globalMapFill: !!(imagery && imagery.fill),
    imagery: imagery ? imagery.source : "Procedural (no global map bundled)",
    maxTerrainLod: giant ? 0 : 17
  };
}
writeFileSync(join(DIR, "manifest.json"), JSON.stringify(out, null, 1));
console.log("surface manifest:", Object.keys(out.bodies).length, "bodies");
const counts = {};
for (const b of Object.values(out.bodies)) counts[b.sourceClassification || "giant"] = (counts[b.sourceClassification || "giant"] || 0) + 1;
console.log(counts);
