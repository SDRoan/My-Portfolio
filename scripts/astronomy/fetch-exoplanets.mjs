// Confirmed exoplanets from the NASA Exoplanet Archive (Planetary Systems
// Composite Parameters table, via TAP), reduced to what the simulator shows.
//
//   node scripts/astronomy/fetch-exoplanets.mjs
//
// Writes data/astronomy/exoplanets.json. Missing values stay null — the
// simulator shows them as Unknown rather than filling anything in.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "data", "astronomy", "exoplanets.json");

const COLS = [
  "pl_name", "hostname", "hd_name", "hip_name", "ra", "dec", "sy_dist", "sy_pnum", "sy_snum",
  "pl_orbper", "pl_orbsmax", "pl_rade", "pl_masse", "pl_bmasse", "pl_eqt", "pl_orbeccen", "pl_orbincl",
  "discoverymethod", "disc_year", "st_spectype", "st_teff", "st_rad", "st_mass", "st_lum"
];

const url = "https://exoplanetarchive.ipac.caltech.edu/TAP/sync?format=json&query=" +
  encodeURIComponent("select " + COLS.join(",") + " from pscomppars");

const res = await fetch(url);
if (!res.ok) throw new Error("NASA Exoplanet Archive: HTTP " + res.status);
const rows = await res.json();

const num = (v) => (v === null || v === undefined || v === "" || Number.isNaN(+v) ? null : +v);
const round = (v, d) => (v === null ? null : +v.toFixed(d));

// Hosts carry the star; planets point at their host by index.
const hosts = new Map();
const planets = [];
for (const r of rows) {
  if (num(r.ra) === null || num(r.dec) === null) continue;
  let h = hosts.get(r.hostname);
  if (!h) {
    h = {
      name: r.hostname,
      hd: r.hd_name || null,
      hip: r.hip_name ? +String(r.hip_name).replace(/\D/g, "") || null : null,
      ra: round(num(r.ra), 5), dec: round(num(r.dec), 5),
      distPc: round(num(r.sy_dist), 4),
      spec: r.st_spectype || null,
      teff: round(num(r.st_teff), 0),
      radSun: round(num(r.st_rad), 3),
      massSun: round(num(r.st_mass), 3),
      logLum: round(num(r.st_lum), 3),
      nStars: num(r.sy_snum),
      planets: []
    };
    hosts.set(r.hostname, h);
  }
  // pl_masse is the true mass; pl_bmasse may be M·sin(i). Keep which one we have.
  const mTrue = num(r.pl_masse), mBest = num(r.pl_bmasse);
  h.planets.push(planets.length);
  planets.push({
    name: r.pl_name,
    periodDays: round(num(r.pl_orbper), 5),
    aAU: round(num(r.pl_orbsmax), 5),
    radEarth: round(num(r.pl_rade), 3),
    massEarth: round(mTrue !== null ? mTrue : mBest, 3),
    massIsMin: mTrue === null && mBest !== null ? true : undefined,
    teqK: round(num(r.pl_eqt), 0),
    ecc: round(num(r.pl_orbeccen), 4),
    inclDeg: round(num(r.pl_orbincl), 2),
    method: r.discoverymethod || null,
    year: num(r.disc_year)
  });
}

const hostList = [...hosts.values()];
hostList.forEach((h, i) => h.planets.forEach((p) => (planets[p].host = i)));

// Positional rows keep the file small; the field lists say what each slot is.
const HOST_FIELDS = ["name", "hd", "hip", "ra", "dec", "distPc", "spec", "teff", "radSun", "massSun", "logLum", "nStars", "planets"];
const PLANET_FIELDS = ["name", "host", "periodDays", "aAU", "radEarth", "massEarth", "massIsMin", "teqK", "ecc", "inclDeg", "method", "year"];
const out = {
  source: "NASA Exoplanet Archive, Planetary Systems Composite Parameters (pscomppars)",
  url: "https://exoplanetarchive.ipac.caltech.edu/",
  retrieved: new Date().toISOString().slice(0, 10),
  hostFields: HOST_FIELDS,
  planetFields: PLANET_FIELDS,
  hosts: hostList.map((h) => HOST_FIELDS.map((f) => (h[f] === undefined ? null : h[f]))),
  planets: planets.map((p) => PLANET_FIELDS.map((f) => (f === "massIsMin" ? (p[f] ? 1 : 0) : p[f] === undefined ? null : p[f])))
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
console.log("exoplanets:", planets.length, "planets around", hostList.length, "hosts →", OUT);
