// Sanity checks on the processed catalogues before they ship.
//
//   node scripts/astronomy/validate-catalogs.mjs
//
// Fails (exit 1) on structural problems; prints counts and spot checks of
// well-known objects so a bad rebuild is obvious at a glance.

import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "astronomy");
let failed = 0;
const fail = (m) => { console.error("FAIL", m); failed++; };
const ok = (m) => console.log("ok  ", m);
const load = (f) => { const p = join(DIR, f); const j = JSON.parse(readFileSync(p, "utf8")); ok(f + " (" + (statSync(p).size / 1024).toFixed(0) + " KB)"); return j; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// Stars
const stars = load("stars.json");
const si = Object.fromEntries(stars.fields.map((f, i) => [f, i]));
if (stars.rows.length < 5000) fail("too few stars: " + stars.rows.length);
const byName = (n) => stars.rows.find((r) => r[si.name] === n);
const sirius = byName("Sirius");
if (!sirius) fail("Sirius missing"); else {
  const d = Math.hypot(sirius[si.x], sirius[si.y], sirius[si.z]);
  near(d, 8.6, 0.2) ? ok("Sirius at " + d.toFixed(2) + " ly") : fail("Sirius distance " + d);
}
const prox = byName("Proxima Centauri");
prox ? ok("Proxima Centauri at " + Math.hypot(prox[si.x], prox[si.y], prox[si.z]).toFixed(2) + " ly") : fail("Proxima missing");
for (const r of stars.rows) if (![r[si.x], r[si.y], r[si.z], r[si.absmag]].every(Number.isFinite)) { fail("non-finite star row " + r[si.desig]); break; }

// Exoplanets
const exo = load("exoplanets.json");
const pi = Object.fromEntries(exo.planetFields.map((f, i) => [f, i]));
if (exo.planets.length < 5000) fail("too few planets: " + exo.planets.length); else ok(exo.planets.length + " confirmed planets, " + exo.hosts.length + " hosts");
const k186f = exo.planets.find((p) => p[pi.name] === "Kepler-186 f");
k186f ? ok("Kepler-186 f: P = " + k186f[pi.periodDays] + " d, R = " + k186f[pi.radEarth] + " R⊕") : fail("Kepler-186 f missing");
const trap = exo.planets.filter((p) => /^TRAPPIST-1 /.test(p[pi.name]));
trap.length === 7 ? ok("TRAPPIST-1 has 7 planets") : fail("TRAPPIST-1 planets: " + trap.length);
for (const p of exo.planets) if (p[pi.host] === null || p[pi.host] === undefined) { fail("planet without host " + p[pi.name]); break; }

// Galaxies
const gal = load("galaxies.json");
const gi = Object.fromEntries(gal.fields.map((f, i) => [f, i]));
const m31 = gal.rows.find((r) => r[gi.name] === "M31");
m31 && near(m31[gi.distMly], 2.5, 0.2) ? ok("M31 at " + m31[gi.distMly] + " Mly") : fail("M31 missing or misplaced");
if (gal.rows.some((r) => /^milky\s*way$/i.test(r[gi.name]))) fail("Milky Way must not be a catalogue row");
for (const n of ["Large Magellanic Cloud", "Whirlpool Galaxy", "Sombrero Galaxy", "Centaurus A", "Cartwheel Galaxy"])
  gal.rows.some((r) => r[gi.common] === n) ? ok(n) : fail(n + " missing");

// HyperLEDA background layer (optional, but should be sane if present)
try {
  const far = load("galaxies-far.json");
  const fi = Object.fromEntries(far.fields.map((f, i) => [f, i]));
  far.rows.length > 10000 ? ok(far.rows.length + " HyperLEDA galaxies") : fail("too few HyperLEDA galaxies: " + far.rows.length);
  const bad = far.rows.find((r) => !(r[fi.distMly] > 0) || !Number.isFinite(r[fi.raDeg]) || !Number.isFinite(r[fi.absBmag]));
  if (bad) fail("bad HyperLEDA row " + bad[0]);
  const names = new Set(gal.rows.map((r) => r[gi.name]));
  const dup = far.rows.filter((r) => names.has(r[fi.name])).length;
  dup ? fail(dup + " HyperLEDA rows duplicate the main catalogue") : ok("no duplicates with the main galaxy catalogue");
} catch (e) { fail("galaxies-far.json: " + e.message); }

// Deep sky and Solar System
const deep = load("deep-sky.json");
deep.rows.some((r) => r[2] === "Sagittarius A*") ? ok("Sagittarius A* present") : fail("Sgr A* missing");
const solar = load("solar-system.json");
for (const id of ["sun", "earth", "moon", "mars", "phobos", "deimos", "jupiter", "io", "europa", "ganymede", "callisto", "saturn", "titan", "uranus", "neptune", "triton", "pluto", "charon"])
  if (!solar.bodies.some((b) => b.id === id)) fail("solar body missing: " + id);
ok(solar.bodies.length + " Solar System bodies");

if (failed) { console.error(failed + " problem(s)"); process.exit(1); }
console.log("catalogues look good");
