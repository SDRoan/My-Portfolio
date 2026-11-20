// Star systems: fully procedural ones for generated stars, and the visual
// interpretation of real exoplanets (whose catalogue values are kept apart
// from anything derived for drawing).
//
// Relationships kept physically sensible: planet temperatures follow stellar
// luminosity and distance; giants form beyond the snow line unless they are
// classified hot Jupiters; orbits are spaced in increasing order with no
// crossings; moons sit between the Roche limit and a fraction of the Hill
// sphere; rings sit inside the Roche limit.

import { Rng, hashInts, hashString, designation } from "../engine/rng.js";
import { lumFromAbsV, radiusFromLumT, massFromLum, spectralType, equilibriumTemp, habitableZone } from "./stellar.js";

const R_EARTH_KM = 6371;
const M_SUN_EARTH = 332946;

// ── star properties for a sector star ──
const COMPACT = { 4: "wd" };
export function proceduralStar(rec) {
  const rng = new Rng(rec.seed);
  const T = rec.teff;
  let L = lumFromAbsV(rec.absMag, T);
  let R = radiusFromLumT(L, T);
  let M;
  if (rec.cls === 4) { M = rng.range(0.5, 1.1); R = 0.012 * Math.pow(M, -1 / 3) * rng.range(0.8, 1.1); L = R * R * Math.pow(T / 5772, 4); }
  else if (rec.cls === 7) M = rng.range(0.9, 3);
  else if (rec.cls === 10) M = rng.range(10, 25);
  else if (rec.cls === 11) M = rng.range(15, 40);
  else M = massFromLum(L);
  const label = { 0: "M-type main sequence", 1: "K-type main sequence", 2: "G-type main sequence", 3: "F-type main sequence",
    4: "White dwarf", 5: "A-type main sequence", 6: "B-type main sequence", 7: "Red giant", 8: "B-type main sequence",
    9: "O-type main sequence", 10: "Red supergiant", 11: "Blue supergiant" }[rec.cls];
  const lc = rec.cls === 4 ? "D" : rec.cls === 7 ? "III" : rec.cls >= 10 ? "Ia" : "V";
  return {
    name: rec.name, seed: rec.seed, teff: T, lumSun: L, radiusSun: R, massSun: M, absMag: rec.absMag,
    spectType: rec.cls === 4 ? "DA" : spectralType(T) + " " + lc, description: label,
    compact: COMPACT[rec.cls] || null, ageGyr: rec.cls >= 8 ? rng.range(0.003, 0.05) : rec.cls === 4 ? rng.range(1, 10) : rng.range(0.3, 11)
  };
}

// ── planet types → how they are drawn ──
// Each look is a parameter set for the planet shader (see render/bodies.js).
const rgb = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
function rockyLook(rng, type, T) {
  const L = { seed: rng.int(1, 16777215), kind: "rocky", cont: rng.range(1.2, 2.6), mount: rng.range(0.2, 0.9), warp: rng.range(0.2, 0.6),
    crater: 0, craterFreq: rng.range(4, 9), sea: -9, ice: 2, lava: 0, clouds: 0, reliefKm: rng.range(4, 14) };
  const pal = {
    barren: [0x6d6560, 0x9a8f84, 0xc9bfb2], cratered: [0x5c5a58, 0x8a8783, 0xb5b1ab], desert: [0x9a6a3e, 0xc79a62, 0xe6c79a],
    volcanic: [0x2b2522, 0x4d4038, 0x7a6a5e], iron: [0x4a3f3a, 0x6e5e55, 0x938378], carbon: [0x1c1b1d, 0x302d2e, 0x4a4446],
    icy: [0x9fb2c2, 0xc9d6e0, 0xf2f6fa], frozen: [0x8e9aa6, 0xbcc8d2, 0xe8eef3], terrestrial: [0x5e5244, 0x8a7a64, 0xb8ab98],
    ocean: [0x4f4a40, 0x7a7262, 0xa59a86], partialOcean: [0x6a5a46, 0x93836a, 0xc2b49c], iceOcean: [0xa8b9c8, 0xd0dce6, 0xf5f8fb],
    lava: [0x1a1412, 0x2e2420, 0x4a3a32], superEarth: [0x6b5d4f, 0x958470, 0xc2b29e], subEarth: [0x6a625c, 0x958b82, 0xc0b6aa]
  }[type] || [0x6d6560, 0x9a8f84, 0xc9bfb2];
  L.c0 = rgb(pal[0]); L.c1 = rgb(pal[1]); L.c2 = rgb(pal[2]);
  L.ocean = rgb(0x0f2a4a);
  L.iceCol = rgb(0xf2f6fa);
  if (type === "cratered" || type === "barren" || type === "subEarth") { L.crater = rng.range(0.2, 0.5); L.mount *= 0.5; }
  if (type === "icy" || type === "frozen") { L.crater = rng.range(0.05, 0.3); L.ice = 0; }
  if (type === "ocean") { L.sea = 0.35; L.clouds = rng.range(0.3, 0.6); L.ice = 0.8; }
  if (type === "partialOcean" || type === "terrestrial") { L.sea = rng.range(-0.05, 0.15); L.clouds = rng.range(0.2, 0.5); L.ice = rng.range(0.75, 0.92); }
  if (type === "iceOcean") { L.sea = 0.2; L.ocean = rgb(0xdbe6ee); L.ice = 0; L.crater = 0.05; }
  if (type === "lava") { L.lava = rng.range(0.6, 1); L.sea = rng.range(-0.1, 0.05); L.ocean = [1.0, 0.35, 0.05]; }
  if (type === "volcanic") { L.lava = rng.range(0.15, 0.35); }
  if (type === "desert") { L.ice = rng.range(0.9, 0.97); L.mount *= 0.7; }
  if (type === "terrestrial" || type === "partialOcean") {
    // Land tinted by temperature, not by an assumption of plant life.
    const warm = Math.max(0, Math.min(1, (T - 250) / 80));
    L.c0 = mixc(L.c0, rgb(0x7a5a3a), warm * 0.4);
  }
  return L;
}
function gasLook(rng, type, T) {
  const L = { seed: rng.int(1, 16777215), kind: "gas", bands: rng.range(6, 16), turb: rng.range(0.3, 1.2), storm: rng.chance(0.4) ? rng.range(0.4, 1) : 0 };
  let pal;
  if (type === "hotJupiter") pal = T > 1800 ? [0x2a0f0a, 0x5a2414, 0x8c4a2a] : [0x3a2a26, 0x6a4a3a, 0x9a7a62];
  else if (type === "iceGiant" || type === "miniNeptune") pal = rng.chance(0.5) ? [0x2f5d8a, 0x4f86b8, 0x8fbce0] : [0x5e9bb0, 0x86bfd0, 0xbfe2ea];
  else if (T < 120) pal = [0x9c8a6a, 0xc8b894, 0xe8dcc0];
  else pal = [0x8a5a3a, 0xc39a6e, 0xeedcc0];
  L.c0 = rgb(pal[0]); L.c1 = rgb(pal[1]); L.c2 = rgb(pal[2]);
  if (type === "iceGiant" || type === "miniNeptune") { L.bands *= 0.4; L.turb *= 0.4; }
  L.glow = type === "hotJupiter" && T > 1500 ? Math.min(1, (T - 1500) / 1200) : 0;
  return L;
}
function mixc(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

const TYPE_LABEL = {
  terrestrial: "Terrestrial world", desert: "Desert world", barren: "Barren rocky world", volcanic: "Volcanic world",
  iron: "Iron-rich world", carbon: "Carbon-rich world", icy: "Icy world", cratered: "Cratered world",
  superEarth: "Super-Earth", subEarth: "Sub-Earth", ocean: "Ocean world", partialOcean: "Partial ocean world",
  iceOcean: "Ice-covered ocean world", lava: "Lava world", frozen: "Frozen world",
  gasGiant: "Gas giant", hotJupiter: "Hot Jupiter", coldJupiter: "Cold Jupiter", superJupiter: "Super-Jupiter",
  iceGiant: "Neptune-like ice giant", miniNeptune: "Mini-Neptune"
};
export function typeLabel(t) { return TYPE_LABEL[t] || t; }

// Rough mass–radius relations (Chen & Kipping 2017, simplified). Earth units.
export function massFromRadius(R) {
  if (R < 1.23) return Math.pow(R, 1 / 0.279);
  if (R < 11) return Math.pow(R / 1.008, 1 / 0.589);
  return 300 * Math.pow(R / 11, 0.5);
}
export function radiusFromMass(M) {
  if (M < 2) return Math.pow(M, 0.279);
  if (M < 130) return 1.008 * Math.pow(M, 0.589);
  return Math.min(13, 11 + (M - 130) * 0.002);
}

// Rocky type from temperature, mass and a dice roll for water.
function rockyType(rng, T, M) {
  if (T > 1100) return "lava";
  if (T > 650) return rng.chance(0.5) ? "volcanic" : rng.chance(0.5) ? "barren" : rng.pick(["iron", "carbon"]);
  if (T > 330) return rng.chance(0.6) ? "desert" : rng.pick(["barren", "volcanic", "cratered"]);
  if (T > 230) {
    if (M > 0.3 && M < 6 && rng.chance(0.55)) return rng.pick(["ocean", "partialOcean", "terrestrial", "terrestrial"]);
    return rng.pick(["desert", "barren", "cratered"]);
  }
  if (T > 150) return rng.chance(0.4) ? "iceOcean" : "frozen";
  return rng.chance(0.5) ? "icy" : "cratered";
}

function atmosphereFor(rng, type, M, T, gas) {
  if (gas) return { density: 0.06, color: type === "iceGiant" || type === "miniNeptune" ? [0.45, 0.65, 1] : [0.9, 0.8, 0.65], kind: "H₂/He envelope" };
  if (M < 0.2 || type === "cratered" || type === "iron" || type === "carbon") return rng.chance(0.15) ? { density: 0.05, color: [0.7, 0.7, 0.75], kind: "Trace exosphere" } : null;
  if (type === "lava") return { density: 0.6, color: [1, 0.55, 0.3], kind: "Rock-vapour atmosphere" };
  if (type === "volcanic") return { density: rng.range(0.5, 2), color: [0.95, 0.8, 0.5], kind: "CO₂/SO₂-rich" };
  if (type === "desert" && rng.chance(0.5)) return { density: rng.range(0.1, 0.6), color: [0.9, 0.7, 0.5], kind: "Thin CO₂" };
  if (type === "ocean" || type === "partialOcean" || type === "terrestrial") return { density: rng.range(0.6, 1.6), color: [0.3, 0.55, 1], kind: "N₂-dominated (assumed)" };
  if (type === "frozen" || type === "iceOcean") return rng.chance(0.4) ? { density: rng.range(0.05, 0.5), color: [0.6, 0.75, 1], kind: "Thin N₂/CH₄" } : null;
  return rng.chance(0.3) ? { density: rng.range(0.05, 0.4), color: [0.75, 0.75, 0.8], kind: "Thin" } : null;
}

function moonsFor(rng, planet, star, name) {
  const moons = [];
  const RpKm = planet.radiusKm;
  const hillKm = planet.aAU * 1.496e8 * Math.cbrt(planet.massEarth / (3 * star.massSun * M_SUN_EARTH));
  let n = planet.gas ? rng.poisson(planet.massEarth > 100 ? 4 : 2.5) : rng.chance(0.25) ? rng.int(1, 2) : 0;
  n = Math.min(n, 9);
  let a = RpKm * rng.range(3, 6);
  const maxA = hillKm * 0.35;
  for (let k = 0; k < n && a < maxA; k++) {
    const T = planet.teqK * rng.range(0.85, 1.0);
    const big = planet.gas && rng.chance(0.4);
    const rKm = big ? rng.logRange(300, 2600) : rng.logRange(10, 600);
    const mE = Math.pow(rKm / R_EARTH_KM, 3) * (T < 200 ? 0.35 : 0.6);
    const type = rKm < 120 ? "cratered" : T < 200 ? rng.pick(["icy", "icy", "cratered", "frozen"]) : rng.pick(["barren", "cratered", "volcanic"]);
    const mrng = new Rng(hashInts(planet.seed, 900 + k));
    moons.push({
      name: name + " " + ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX"][k], seed: hashInts(planet.seed, 900 + k),
      kind: "moon", aKm: a, periodDays: 2 * Math.PI * Math.sqrt(Math.pow(a * 1e3, 3) / (6.674e-11 * planet.massEarth * 5.972e24)) / 86400,
      radiusKm: rKm, massEarth: mE, type, teqK: Math.round(T), incDeg: mrng.gauss() * 2, phase: mrng.next() * Math.PI * 2,
      nodeDeg: mrng.next() * 360, ecc: Math.abs(mrng.gauss()) * 0.01, atmosphere: rKm > 1500 && T < 150 && mrng.chance(0.3) ? { density: mrng.range(0.3, 1.5), color: [0.95, 0.7, 0.4], kind: "Hazy N₂/CH₄" } : null,
      look: rockyLook(mrng, type, T), tidallyLocked: true
    });
    a *= rng.range(1.5, 2.4);
  }
  return moons;
}

// ── full procedural system ──
export function generateSystem(starRec) {
  const star = starRec.props || proceduralStar(starRec);
  const rng = new Rng(hashInts(star.seed, 4242));
  const name = star.name;
  const sys = { star, companions: [], planets: [], belts: [], procedural: true };

  // Companion stars: more common around massive stars.
  const pBin = star.massSun > 8 ? 0.7 : star.massSun > 1.5 ? 0.55 : star.massSun > 0.8 ? 0.45 : 0.27;
  if (!star.compact && rng.chance(pBin)) {
    const q = rng.range(0.1, 1);
    const mC = star.massSun * q;
    const Lc = mC < 0.43 ? 0.23 * Math.pow(mC, 2.3) : Math.pow(mC, 4);
    const Tc = 5772 * Math.pow(Lc, 0.12) * Math.pow(mC, 0.25) * 0.98;
    const aAU = rng.logRange(0.05, 3000);
    sys.companions.push({
      name: name + " B", seed: hashInts(star.seed, 5), teff: Math.max(2600, Math.min(40000, Tc)), lumSun: Lc,
      radiusSun: Math.pow(mC, 0.8), massSun: mC, aAU, ecc: Math.min(0.8, Math.abs(rng.gauss()) * 0.3),
      periodDays: 365.25 * Math.sqrt(Math.pow(aAU, 3) / (star.massSun + mC)), phase: rng.next() * Math.PI * 2,
      spectType: spectralType(Math.max(2600, Math.min(40000, Tc))) + " V", description: "Companion star"
    });
  }
  const comp = sys.companions[0];

  // Planets.
  let nPl;
  if (star.compact === "wd") nPl = rng.chance(0.2) ? rng.int(1, 2) : 0;
  else if (star.massSun > 8) nPl = rng.chance(0.15) ? 1 : 0;
  else if (star.lumSun > 50) nPl = rng.chance(0.35) ? rng.int(1, 3) : 0;
  else nPl = rng.chance(0.2) ? 0 : Math.min(9, 1 + rng.poisson(star.massSun < 0.5 ? 2 : 3.2));

  const snow = 2.7 * Math.sqrt(star.lumSun);
  const innerEdge = Math.max(0.012, star.radiusSun * 0.00465 * 3);
  let a = Math.max(innerEdge, rng.logRange(0.025, 0.35) * Math.cbrt(star.massSun));
  // An S-type companion clips the planet region at about a third of its orbit.
  const outerLimit = comp && comp.aAU < 50 ? (comp.aAU < 1 ? 1e9 : comp.aAU * 0.3) : 1e9;
  const innerLimit = comp && comp.aAU < 1 ? comp.aAU * 3.5 : 0;
  if (a < innerLimit) a = innerLimit;
  const hz = habitableZone(star.lumSun);
  let lastRocky = 0;
  for (let k = 0; k < nPl && a < outerLimit; k++) {
    const prng = new Rng(hashInts(star.seed, 100 + k));
    const pname = name + " " + "bcdefghijk"[k];
    const albedo = prng.range(0.1, 0.45);
    const Tq = equilibriumTemp(star.lumSun + (comp ? comp.lumSun * (comp.aAU < 1 ? 1 : 0) : 0), a, albedo);
    let type, Rp, Mp, gas = false;
    const hotJ = a < 0.1 && star.massSun > 0.7 && star.massSun < 1.6 && prng.chance(0.06);
    if (hotJ) { type = "hotJupiter"; Mp = prng.range(100, 1200); Rp = prng.range(11, 19); gas = true; }
    else if (a < snow) {
      if (prng.chance(0.3)) { type = "miniNeptune"; Rp = prng.range(1.8, 3.8); Mp = massFromRadius(Rp); gas = true; }
      else {
        Rp = prng.logRange(0.35, 1.8); Mp = massFromRadius(Rp);
        type = rockyType(prng, Tq, Mp);
        if (Rp > 1.35 && (type === "barren" || type === "desert")) type = "superEarth";
        if (Rp < 0.6 && type === "barren") type = "subEarth";
      }
    } else {
      const u = prng.next();
      if (u < 0.4) { Mp = prng.logRange(40, 4000); Rp = radiusFromMass(Mp); gas = true; type = Mp > 1000 ? "superJupiter" : Tq < 140 ? "coldJupiter" : "gasGiant"; }
      else if (u < 0.75) { type = "iceGiant"; Rp = prng.range(3.2, 5.5); Mp = prng.range(10, 25); gas = true; }
      else { Rp = prng.logRange(0.2, 1.2); Mp = massFromRadius(Rp) * 0.6; type = rockyType(prng, Tq, Mp); }
    }
    const planet = {
      name: pname, seed: hashInts(star.seed, 100 + k), kind: "planet", type, gas,
      aAU: a, ecc: gas ? Math.min(0.35, Math.abs(prng.gauss()) * 0.08) : Math.min(0.2, Math.abs(prng.gauss()) * 0.04),
      incDeg: prng.gauss() * 1.5, nodeDeg: prng.next() * 360, argPeriDeg: prng.next() * 360, phase: prng.next() * Math.PI * 2,
      periodDays: 365.25 * Math.sqrt(Math.pow(a, 3) / star.massSun),
      radiusKm: Rp * R_EARTH_KM, massEarth: Mp, gravityG: Mp / (Rp * Rp), teqK: Math.round(Tq), albedo,
      inHZ: a >= hz[0] && a <= hz[1],
      tidallyLocked: a < 0.1 * Math.cbrt(star.massSun) || (star.massSun < 0.6 && a < 0.25),
      tiltDeg: Math.abs(prng.gauss()) * 18, dayHours: gas ? prng.range(8, 20) : prng.range(14, 80)
    };
    planet.atmosphere = atmosphereFor(prng, type, Mp, Tq, gas);
    planet.look = gas ? gasLook(prng, type, Tq) : rockyLook(prng, type, Tq);
    if (planet.look.clouds && !planet.atmosphere) planet.look.clouds = 0;
    planet.rings = (gas && prng.chance(type === "iceGiant" ? 0.45 : 0.3)) || (!gas && prng.chance(0.02))
      ? { innerR: prng.range(1.25, 1.6), outerR: prng.range(1.85, 2.45), seed: prng.int(1, 16777215), tint: gas ? [0.9, 0.85, 0.75] : [0.7, 0.68, 0.65], opacity: prng.range(0.35, 0.9) }
      : null;
    planet.moons = moonsFor(prng, planet, star, pname);
    if (!gas) lastRocky = a;
    sys.planets.push(planet);
    // Next orbit: mutual spacing grows with mass, like dynamically packed systems.
    a *= gas ? prng.range(1.6, 2.6) : prng.range(1.35, 2.0);
    if (!gas && a > snow && lastRocky && prng.chance(0.5)) {
      sys.belts.push({ innerAU: lastRocky * 1.25, outerAU: Math.min(a * 0.85, lastRocky * 2.2), seed: prng.int(1, 16777215) });
      a *= 1.3;
    }
  }
  if (star.compact === "wd" && rng.chance(0.3)) sys.belts.push({ innerAU: 0.005, outerAU: 0.012, seed: rng.int(1, 16777215), debris: true });
  return sys;
}

// ── a real exoplanet host's planets, drawn honestly ──
// Catalogue values go in `catalog`, untouched (null = unknown). Anything the
// renderer needs but the catalogue lacks is derived and flagged in `visual`.
export function interpretExoSystem(host, planets) {
  const seed = hashString(host.name);
  const rng = new Rng(seed);
  const massSun = host.massSun || 1;
  const lumSun = host.logLum !== null && host.logLum !== undefined ? Math.pow(10, host.logLum) : null;
  const sysPlanets = planets.map((pl, k) => {
    const prng = new Rng(hashString(pl.name));
    let aAU = pl.aAU, aEst = false;
    if (aAU === null && pl.periodDays !== null) { aAU = Math.cbrt(Math.pow(pl.periodDays / 365.25, 2) * massSun); aEst = true; }
    if (aAU === null) { aAU = 0.05 * (k + 1); aEst = true; }
    let R = pl.radEarth, rEst = false;
    if (R === null && pl.massEarth !== null) { R = radiusFromMass(pl.massEarth); rEst = true; }
    if (R === null) { R = 1; rEst = true; }
    const M = pl.massEarth !== null ? pl.massEarth : massFromRadius(R);
    const T = pl.teqK !== null ? pl.teqK : lumSun !== null ? equilibriumTemp(lumSun, aAU, 0.3) : 400;
    let type, gas = false;
    if (R > 6) { gas = true; type = T > 900 && aAU < 0.15 ? "hotJupiter" : M > 1000 ? "superJupiter" : T < 140 ? "coldJupiter" : "gasGiant"; }
    else if (R > 2.0) { gas = true; type = R > 3.5 ? "iceGiant" : "miniNeptune"; }
    else { type = rockyType(prng, T, M); if (R > 1.35 && (type === "barren" || type === "desert")) type = "superEarth"; }
    const p = {
      name: pl.name, seed: hashString(pl.name), kind: "planet", type, gas, real: true,
      catalog: pl,
      aAU, ecc: pl.ecc !== null ? pl.ecc : 0, incDeg: prng.gauss() * 1.0, nodeDeg: prng.next() * 360,
      argPeriDeg: prng.next() * 360, phase: prng.next() * Math.PI * 2,
      periodDays: pl.periodDays !== null ? pl.periodDays : 365.25 * Math.sqrt(Math.pow(aAU, 3) / massSun),
      radiusKm: R * R_EARTH_KM, massEarth: M, teqK: Math.round(T),
      tidallyLocked: aAU < 0.1 * Math.cbrt(massSun),
      visual: { aEstimated: aEst, radiusEstimated: rEst, orientationAssumed: true, phaseAssumed: true },
      moons: [], rings: null
    };
    p.atmosphere = atmosphereFor(prng, type, M, T, gas);
    p.look = gas ? gasLook(prng, type, T) : rockyLook(prng, type, T);
    if (p.look.clouds && !p.atmosphere) p.look.clouds = 0;
    return p;
  }).sort((a, b) => a.aAU - b.aAU);
  // A shared orbital plane for the system, tilted to the catalogue inclination
  // when one is known (node unknown, so the tilt direction is assumed).
  const incl = planets.find((p) => p.inclDeg !== null);
  return { planets: sysPlanets, belts: [], companions: [], procedural: false,
    planeTiltDeg: incl ? 90 - incl.inclDeg : rng.range(0, 30), planeNodeDeg: rng.range(0, 360) };
}

export function designate(prefix, seed) { return designation(prefix, seed); }
