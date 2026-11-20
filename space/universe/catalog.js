// Loads the preprocessed catalogues (data/astronomy/*.json) and turns them
// into records in the render frame. If a file fails, a small built-in
// fallback keeps the simulator usable rather than empty.

import { eclToRender, raDecToRender } from "../engine/coords.js";
import { hashString } from "../engine/rng.js";
import { teffFromBV, teffFromBpRp, lumFromAbsV, radiusFromLumT, massFromLum, luminosityClass, describeClass, spectralType } from "./stellar.js";
import { morphology } from "./galaxymodel.js";
import { loadManifest } from "./surfaces.js";

const BASE = new URL("../../data/astronomy/", import.meta.url);

async function getJSON(name) {
  const r = await fetch(new URL(name, BASE));
  if (!r.ok) throw new Error(name + ": HTTP " + r.status);
  return r.json();
}

export async function loadCatalogs(onProgress) {
  const names = ["solar-system.json", "stars.json", "exoplanets.json", "galaxies.json", "deep-sky.json"];
  const failures = [];
  const results = await Promise.all(names.map((n) => getJSON(n).then((j) => { onProgress && onProgress(n); return j; })
    .catch((e) => { failures.push(n); console.warn("[space] catalogue unavailable, using fallback:", e.message); return null; })));
  const [solar, stars, exo, galaxies, deep] = results;
  const surfaces = await loadManifest();
  const cat = {
    solar: solar || FALLBACK_SOLAR,
    stars: buildStars(stars || FALLBACK_STARS),
    galaxies: buildGalaxies(galaxies || FALLBACK_GALAXIES),
    deep: buildDeep(deep || { rows: [] }),
    surfaces,
    failures,
    sources: []
  };
  for (const j of results) if (j && j.sources) cat.sources.push(...j.sources);
  if (exo) cat.sources.push({ name: exo.source, url: exo.url });
  cat.exo = buildExoplanets(exo, cat.stars);
  return cat;
}

// ── stars ──
function buildStars(j) {
  const F = j.fields || ["name", "desig", "x", "y", "z", "absmag", "colour", "spect", "src", "hip", "gaia", "distPc"];
  const ix = Object.fromEntries(F.map((f, i) => [f, i]));
  const list = [];
  for (const r of j.rows) {
    const colour = r[ix.colour];
    let teff, teffSrc;
    if (typeof colour === "number") { teff = teffFromBV(colour); teffSrc = "B−V"; }
    else if (typeof colour === "string" && colour[0] === "g") { teff = teffFromBpRp(+colour.slice(1)); teffSrc = "Gaia BP−RP"; }
    else { teff = 5000; teffSrc = null; }
    const spect = r[ix.spect];
    const lc = luminosityClass(spect);
    if (lc === "D" || (spect && spect[0] === "D")) { teff = Math.max(teff, 9000); }
    teff = Math.max(2300, Math.min(45000, teff));
    const absMag = r[ix.absmag];
    const lum = lumFromAbsV(absMag, teff);
    const p = eclToRender([r[ix.x], r[ix.y], r[ix.z]]);
    list.push({
      kind: "star", real: true,
      name: r[ix.name] || null, desig: r[ix.desig], hip: r[ix.hip] || null, gaia: r[ix.gaia] || null,
      posLy: p, distLy: Math.hypot(p[0], p[1], p[2]), absMag, teff, teffSrc, spect: spect || null,
      lumSun: lum, radiusSun: lc === "D" ? 0.012 : radiusFromLumT(lum, teff),
      massSun: lc === "D" ? 0.6 : lc && /I/.test(lc) && lc !== "IV" ? null : massFromLum(lum),
      lumClass: lc, classDesc: describeClass(lc) || (spect ? null : spectralType(teff) + " (from colour)"),
      src: r[ix.src], seed: hashString(r[ix.desig] || r[ix.name] || String(list.length))
    });
  }
  return list;
}

// ── exoplanets: hosts joined to catalogue stars by Hipparcos number ──
function buildExoplanets(j, stars) {
  if (!j) return { hosts: [], planets: [] };
  const HF = j.hostFields, PF = j.planetFields;
  const hi = Object.fromEntries(HF.map((f, i) => [f, i])), pi = Object.fromEntries(PF.map((f, i) => [f, i]));
  const planets = j.planets.map((r) => {
    const o = {};
    PF.forEach((f) => (o[f] = r[pi[f]]));
    o.massIsMin = !!o.massIsMin;
    return o;
  });
  const byHip = new Map();
  stars.forEach((s, i) => { if (s.hip) byHip.set(s.hip, i); });
  const hosts = j.hosts.map((r) => {
    const h = {};
    HF.forEach((f) => (h[f] = r[hi[f]]));
    h.planetList = h.planets.map((k) => planets[k]);
    if (h.hip && byHip.has(h.hip)) {
      h.star = stars[byHip.get(h.hip)];
      h.star.exoHost = h;
    } else if (h.distPc) {
      // Not in the star catalogue: place it from the archive's own coordinates.
      const d = raDecToRender(h.ra, h.dec);
      const ly = h.distPc * 3.261563777;
      const teff = h.teff || 5000;
      const lum = h.logLum !== null ? Math.pow(10, h.logLum) : null;
      const star = {
        kind: "star", real: true, name: h.name, desig: h.name, posLy: [d[0] * ly, d[1] * ly, d[2] * ly], distLy: ly,
        teff, teffSrc: h.teff ? "NASA Exoplanet Archive" : null,
        lumSun: lum, radiusSun: h.radSun, massSun: h.massSun, spect: h.spec, lumClass: luminosityClass(h.spec),
        absMag: lum !== null ? 4.83 - 2.5 * Math.log10(lum) : 5, src: "NASA Exoplanet Archive", seed: hashString(h.name),
        exoHost: h
      };
      if (star.radiusSun === null && lum !== null) star.radiusSun = radiusFromLumT(lum, teff);
      stars.push(star);
      h.star = star;
    }
    return h;
  });
  planets.forEach((p) => (p.hostRec = hosts[p.host]));
  return { hosts, planets };
}

// ── galaxies ──
function buildGalaxies(j) {
  const F = j.fields;
  const ix = Object.fromEntries(F.map((f, i) => [f, i]));
  const out = [];
  for (const r of j.rows) {
    // Our own galaxy is modelled separately, never as a catalogue entry.
    if (/^milky\s*way$/i.test(r[ix.name]) || r[ix.distMly] < 0.04) continue;
    const p = r[ix.pos];
    const g = {
      kind: "galaxy", real: true,
      name: r[ix.name], common: r[ix.common], raDeg: r[ix.raDeg], decDeg: r[ix.decDeg],
      distLy: r[ix.distMly] * 1e6, posLy: eclToRender([p[0] * 1e6, p[1] * 1e6, p[2] * 1e6]),
      diamKly: r[ix.diamKly], diamEstimated: false, ttype: r[ix.ttype], dwarfClass: r[ix.dwarfClass], barred: !!r[ix.barred],
      axisRatio: r[ix.axisRatio], inclDeg: r[ix.inclDeg], absBmag: r[ix.absBmag], logMass: r[ix.logMass],
      group: r[ix.group], src: r[ix.src], seed: hashString(r[ix.name]), paDeg: ix.paDeg !== undefined ? r[ix.paDeg] : null
    };
    if (g.diamKly === null) { g.diamKly = g.absBmag !== null ? Math.max(1, 30 * Math.pow(10, -0.2 * (g.absBmag + 20))) : 5; g.diamEstimated = true; }
    if (g.name === "ESO 350-040") g.special = "ring";
    g.type = morphology(g);
    g.lumSun = g.absBmag !== null ? Math.pow(10, -0.4 * (g.absBmag - 5.44))
      : g.logMass !== null ? Math.pow(10, g.logMass) / 3 : 2e10 * Math.pow(g.diamKly / 100, 2);
    g.lumEstimated = g.absBmag === null;
    out.push(g);
  }
  return out;
}

// ── HyperLEDA layer: loaded in the background once the simulator is running ──
export async function loadFarGalaxies() {
  const j = await getJSON("galaxies-far.json");
  const F = Object.fromEntries(j.fields.map((f, i) => [f, i]));
  return j.rows.map((r) => {
    const dLy = r[F.distMly] * 1e6;
    const d = raDecToRender(r[F.raDeg], r[F.decDeg]);
    const absB = r[F.absBmag];
    const g = {
      kind: "galaxy", real: true, far: true, name: r[F.name], common: null, raDeg: r[F.raDeg], decDeg: r[F.decDeg],
      distLy: dLy, posLy: [d[0] * dLy, d[1] * dLy, d[2] * dLy],
      diamKly: r[F.diamKly], diamEstimated: r[F.diamKly] === null, ttype: r[F.ttype], dwarfClass: null, barred: false,
      axisRatio: r[F.axisRatio], inclDeg: null, absBmag: absB, logMass: null, group: null, paDeg: r[F.paDeg],
      src: r[F.redshiftDistance] ? "HyperLEDA (distance from redshift)" : "HyperLEDA", seed: hashString(r[F.name]),
      lumSun: Math.pow(10, -0.4 * (absB - 5.44)), lumEstimated: false
    };
    if (g.diamKly === null) g.diamKly = Math.max(1, 30 * Math.pow(10, -0.2 * (absB + 20)));
    g.type = morphology(g);
    return g;
  });
}

// ── nebulae, clusters, black holes, neutron stars ──
function buildDeep(j) {
  const F = j.fields || ["kind", "subtype", "name", "aliases", "raDeg", "decDeg", "distLy", "pos", "sizeLy", "extra", "ref"];
  const ix = Object.fromEntries(F.map((f, i) => [f, i]));
  return j.rows.map((r) => ({
    kind: r[ix.kind], subtype: r[ix.subtype], real: true, name: r[ix.name], aliases: r[ix.aliases] || [],
    raDeg: r[ix.raDeg], decDeg: r[ix.decDeg], distLy: r[ix.distLy], posLy: eclToRender(r[ix.pos]),
    sizeLy: r[ix.sizeLy], extra: r[ix.extra] || {}, ref: r[ix.ref], seed: hashString(r[ix.name])
  }));
}

// ── fallbacks (used only if a data file can't be fetched) ──
const FALLBACK_STARS = {
  fields: ["name", "desig", "x", "y", "z", "absmag", "colour", "spect", "src", "hip", "gaia", "distPc"],
  rows: [
    ["Sirius", "Alp CMa", -1.6, -8.03, -3.47, 1.45, 0.009, "A0m...", "fallback", 32349, null, 2.64],
    ["Rigil Kentaurus", "Alp1 Cen", -1.64, -2.63, -3.55, 4.38, 0.71, "G2V", "fallback", 71683, null, 1.35],
    ["Proxima Centauri", "Proxima", -1.55, -2.72, -3.29, 15.45, 1.81, "M5Ve", "fallback", 70890, null, 1.30],
    ["Vega", "Alp Lyr", 3.15, 24.7, 7.9, 0.58, 0.0, "A0V", "fallback", 91262, null, 7.68],
    ["Betelgeuse", "Alp Ori", 14.6, -0.5, 547, -5.85, 1.85, "M1-2Ia-Iab", "fallback", 27989, null, 152]
  ]
};
const FALLBACK_GALAXIES = {
  fields: ["name", "common", "raDeg", "decDeg", "distMly", "pos", "diamKly", "ttype", "dwarfClass", "barred", "axisRatio", "inclDeg", "absBmag", "logMass", "group", "src"],
  rows: [
    ["M31", "Andromeda Galaxy", 10.6847, 41.2687, 2.5114, [1.85, 1.39, 1.07], 141.7, 3, null, 0, 0.32, 78, -21.0, 11.5, "Local Group", "fallback"],
    ["LMC", "Large Magellanic Cloud", 80.89, -69.76, 0.1631, [0.011, 0.025, -0.16], 32.8, 9, null, 1, 0.9, 35, -17.9, 10, "Local Group", "fallback"]
  ]
};
const FALLBACK_SOLAR = { bodies: [
  { id: "sun", name: "Sun", kind: "star", radiusKm: 695700, massKg: 1.98847e30, teffK: 5772, spect: "G2V", lumSun: 1, spin: [286.13, 0, 63.87, 0, 84.176, 14.1844], look: "map:sun.jpg" },
  { id: "earth", name: "Earth", kind: "planet", parent: "sun", radiusKm: 6371, massKg: 5.97237e24,
    elements: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0, 0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0],
    spin: [0, -0.641, 90, -0.557, 190.147, 360.9856235], look: "earth", albedo: 0.306,
    atmosphere: { color: [0.3, 0.55, 1.0], density: 1, heightKm: 100, note: "78% N₂, 21% O₂, 1 bar" } },
  { id: "moon", name: "Moon", kind: "moon", parent: "earth", radiusKm: 1737.4, massKg: 7.342e22, moon: [384400, 27.321661, 5.145, 0.0549], lunarTheory: true, look: "map:moon.jpg", tidallyLocked: true }
], sources: [] };
