// Real galaxies for the simulator.
//
//   node scripts/astronomy/build-galaxy-catalog.mjs
//
// The bulk comes from the Updated Nearby Galaxy Catalog (Karachentsev,
// Makarov & Kaisina 2013, AJ 145, 101; VizieR J/AJ/145/101) — every known
// galaxy within ~11 Mpc, with measured distances, diameters, morphology,
// inclination and the neighbour that dominates its tidal field. Beyond that
// volume a short list of landmark galaxies is added by hand, with values
// taken from NED (median redshift-independent distances) and noted per row.
//
// Beyond both, HyperLEDA (Makarov et al. 2014) adds every galaxy brighter
// than B = 15.5 that has a distance — redshift-independent where measured,
// otherwise from redshift — about 33,000 galaxies out to a few hundred Mpc.
// HyperLEDA also supplies position angles, so disc orientations come from the
// data wherever a galaxy is matched.
//
// If VizieR is unreachable, the previously processed UNGC rows are reused.
//
// Output positions are J2000 ecliptic, in megalight-years, Sol at origin.

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "data", "astronomy", "galaxies.json");
const OUT_FAR = join(ROOT, "data", "astronomy", "galaxies-far.json");
const MIRRORS = ["https://vizier.cfa.harvard.edu", "https://vizier.cds.unistra.fr"];
const QUERY = "/viz-bin/asu-tsv?-source=J/AJ/145/101/catalog&-out.max=unlimited" +
  "&-out=Name,RAJ2000,DEJ2000,a26,b/a,TT,Mcl,Dist,A26,i,BMag,M26,MD";

const MPC_MLY = 3.261563777;
const EPS = 23.4392911 * Math.PI / 180;
const DEG = Math.PI / 180;

// Common names, and the barred spirals (UNGC's T-type doesn't record bars).
const COMMON = {
  MESSIER031: "Andromeda Galaxy", MESSIER033: "Triangulum Galaxy", LMC: "Large Magellanic Cloud",
  SMC: "Small Magellanic Cloud", MESSIER051a: "Whirlpool Galaxy", MESSIER051: "Whirlpool Galaxy",
  MESSIER104: "Sombrero Galaxy", MESSIER101: "Pinwheel Galaxy", MESSIER081: "Bode's Galaxy",
  MESSIER082: "Cigar Galaxy", NGC5128: "Centaurus A", NGC0253: "Sculptor Galaxy",
  MESSIER064: "Black Eye Galaxy", MESSIER063: "Sunflower Galaxy", MESSIER083: "Southern Pinwheel Galaxy",
  MESSIER094: "Cat's Eye Galaxy", MESSIER106: "M106", NGC0300: "NGC 300", NGC4945: "NGC 4945",
  MESSIER032: "M32", MESSIER110: "M110", NGC6822: "Barnard's Galaxy", IC1613: "IC 1613",
  NGC4594: "Sombrero Galaxy", NGC5194: "Whirlpool Galaxy", NGC5195: "NGC 5195",
  NGC3031: "Bode's Galaxy", NGC3034: "Cigar Galaxy", NGC5457: "Pinwheel Galaxy",
  NGC4826: "Black Eye Galaxy", NGC5055: "Sunflower Galaxy", NGC5236: "Southern Pinwheel Galaxy",
  IC0342: "IC 342", Maffei1: "Maffei 1", Maffei2: "Maffei 2", NGC2403: "NGC 2403",
  SagdSph: "Sagittarius Dwarf Spheroidal", Fornax: "Fornax Dwarf", Sculptor: "Sculptor Dwarf"
};
const BARRED = new Set(["LMC", "MESSIER083", "NGC5236", "NGC0300", "IC0342", "NGC1313", "NGC4945", "NGC2903",
  "MESSIER095", "NGC3351", "NGC4725", "NGC6744", "NGC1097", "NGC1300", "NGC1365", "NGC4394", "NGC3359"]);

// Dominant neighbour → the group it belongs to.
const GROUPS = {
  MilkyWay: "Local Group", MESSIER031: "Local Group", MESSIER033: "Local Group",
  MESSIER081: "M81 Group", MESSIER082: "M81 Group", NGC2403: "M81 Group", NGC3077: "M81 Group",
  NGC5128: "Centaurus A / M83 Group", MESSIER083: "Centaurus A / M83 Group", NGC4945: "Centaurus A / M83 Group",
  NGC0253: "Sculptor Group", NGC0300: "Sculptor Group", NGC0055: "Sculptor Group", NGC7793: "Sculptor Group",
  NGC0247: "Sculptor Group", MESSIER101: "M101 Group", MESSIER051: "M51 Group", NGC5194: "M51 Group",
  MESSIER094: "Canes Venatici I Group", MESSIER106: "Canes Venatici I Group", NGC4449: "Canes Venatici I Group",
  IC0342: "IC 342 / Maffei Group", Maffei1: "IC 342 / Maffei Group", Maffei2: "IC 342 / Maffei Group",
  MESSIER104: "M104 Group", NGC4594: "M104 Group", MESSIER064: "Canes Venatici I Group",
  NGC5055: "M51 Group", MESSIER063: "M51 Group"
};

// Landmarks outside the UNGC volume. [designation, common name, RA°, Dec°,
// distance Mpc, major diameter kpc, T-type, barred, b/a, group, note]
const CURATED = [
  ["MESSIER087", "Virgo A (M87)", 187.70593, 12.39112, 16.4, 37, -5, false, 0.9, "Virgo Cluster", "NED median D; hosts M87*"],
  ["MESSIER049", "M49", 187.44499, 8.00042, 16.4, 48, -5, false, 0.8, "Virgo Cluster", "NED"],
  ["MESSIER060", "M60", 190.91653, 11.55264, 16.5, 37, -5, false, 0.8, "Virgo Cluster", "NED"],
  ["MESSIER084", "M84", 186.26560, 12.88698, 16.8, 30, -4, false, 0.9, "Virgo Cluster", "NED"],
  ["MESSIER086", "M86", 186.54921, 12.94597, 16.8, 40, -4, false, 0.6, "Virgo Cluster", "NED"],
  ["MESSIER100", "M100", 185.72846, 15.82238, 16.1, 33, 4, false, 0.85, "Virgo Cluster", "NED"],
  ["MESSIER088", "M88", 187.99671, 14.42039, 16.4, 40, 3, false, 0.45, "Virgo Cluster", "NED"],
  ["MESSIER090", "M90", 189.20758, 13.16292, 16.8, 46, 2, false, 0.45, "Virgo Cluster", "NED"],
  ["MESSIER058", "M58", 189.43134, 11.81826, 19.0, 33, 3, true, 0.8, "Virgo Cluster", "NED"],
  ["MESSIER061", "M61", 185.47888, 4.47364, 16.5, 30, 4, true, 0.9, "Virgo Cluster", "NED"],
  ["NGC4565", "Needle Galaxy", 189.08658, 25.98767, 12.4, 70, 3, false, 0.14, "Coma I Group", "NED"],
  ["NGC4414", "NGC 4414", 186.61286, 31.22353, 17.8, 17, 5, false, 0.55, "Coma I Group", "NED"],
  ["NGC1300", "NGC 1300", 49.92081, -19.41111, 18.9, 33, 4, true, 0.66, "Eridanus Cluster", "NED"],
  ["NGC1365", "Great Barred Spiral (NGC 1365)", 53.40155, -36.14040, 17.9, 60, 3, true, 0.55, "Fornax Cluster", "NED"],
  ["NGC1316", "Fornax A", 50.67383, -37.20821, 20.0, 50, -2, false, 0.7, "Fornax Cluster", "NED"],
  ["NGC1399", "NGC 1399", 54.62094, -35.45074, 20.0, 30, -5, false, 0.95, "Fornax Cluster", "NED"],
  ["NGC1232", "NGC 1232", 47.43908, -20.57944, 14.5, 30, 5, false, 0.86, "Eridanus Group", "NED"],
  ["NGC1097", "NGC 1097", 41.57938, -30.27489, 16.0, 45, 3, true, 0.67, "NGC 1097 Group", "NED"],
  ["NGC2841", "NGC 2841", 140.51104, 50.97648, 14.1, 45, 3, false, 0.44, "NGC 2841 Group", "NED"],
  ["NGC7331", "NGC 7331", 339.26708, 34.41592, 14.7, 37, 3, false, 0.36, "Deer Lick Group", "NED"],
  ["MESSIER095", "M95", 160.99064, 11.70367, 10.0, 22, 3, true, 0.75, "Leo I Group", "NED"],
  ["MESSIER096", "M96", 161.69060, 11.81994, 10.7, 30, 2, false, 0.7, "Leo I Group", "NED"],
  ["MESSIER066", "M66", 170.06252, 12.99154, 10.6, 30, 3, true, 0.45, "Leo Triplet", "NED"],
  ["MESSIER065", "M65", 169.73302, 13.09223, 10.7, 30, 1, false, 0.3, "Leo Triplet", "NED"],
  ["MESSIER109", "M109", 179.39992, 53.37452, 19.0, 50, 4, true, 0.6, "M109 Group", "NED"],
  ["ESO350-040", "Cartwheel Galaxy", 9.42083, -33.71667, 150.0, 45, 0, false, 0.8, "Cartwheel Group", "NED; ring galaxy"],
  ["NGC4889", "NGC 4889", 195.03384, 27.97697, 102.0, 75, -4, false, 0.7, "Coma Cluster", "NED"],
  ["NGC4874", "NGC 4874", 194.89879, 27.95939, 102.0, 70, -5, false, 0.95, "Coma Cluster", "NED"],
  ["NGC6872", "Condor Galaxy", 304.23500, -70.76800, 89.0, 160, 3, true, 0.3, "Pavo Group", "NED"],
  ["UGC12158", "UGC 12158", 340.54400, 19.99700, 115.0, 40, 4, true, 0.9, "—", "NED"],
  ["NGC4038", "Antennae Galaxies", 180.47100, -18.86760, 22.0, 30, 9, false, 0.6, "NGC 4038 Group", "NED; interacting pair"],
  ["NGC0891", "NGC 891", 35.63922, 42.34917, 9.7, 37, 3, false, 0.1, "NGC 1023 Group", "NED"]
];

function sexa(s, hours) {
  const p = s.trim().split(/\s+/).map(Number);
  const sign = s.trim().startsWith("-") ? -1 : 1;
  const v = Math.abs(p[0]) + (p[1] || 0) / 60 + (p[2] || 0) / 3600;
  return sign * v * (hours ? 15 : 1);
}
function pretty(name) {
  const n = name.trim();
  let m = n.match(/^MESSIER0*(\d+)(\w?)$/);
  if (m) return "M" + m[1] + m[2];
  m = n.match(/^(NGC|IC|UGC|ESO|PGC|DDO|UGCA)0*(\d.*)$/);
  if (m) return m[1] + " " + m[2];
  return n;
}
function eclMly(raDeg, decDeg, mly) {
  const a = raDeg * DEG, d = decDeg * DEG;
  const x = Math.cos(d) * Math.cos(a), y = Math.cos(d) * Math.sin(a), z = Math.sin(d);
  return [x, y * Math.cos(EPS) + z * Math.sin(EPS), -y * Math.sin(EPS) + z * Math.cos(EPS)]
    .map((v) => +(v * mly).toFixed(5));
}

let tsv = null;
for (const m of MIRRORS) {
  try {
    const r = await fetch(m + QUERY, { signal: AbortSignal.timeout(90000) });
    if (r.ok) { tsv = await r.text(); break; }
  } catch (e) { console.warn("mirror failed:", m, e.message); }
}
let previous = null;
if (!tsv) {
  try { previous = JSON.parse(readFileSync(OUT, "utf8")); } catch (e) { /* none */ }
  if (!previous) throw new Error("VizieR unreachable and no previous catalogue to reuse");
  console.warn("VizieR unreachable — reusing previously processed UNGC rows");
}

const lines = tsv ? tsv.split("\n").filter((l) => l && !l.startsWith("#")) : [""];
const head = lines[0].split("\t").map((s) => s.trim());
const body = lines.slice(3);
const out = [];
const seen = new Set();
if (previous) {
  for (const r of previous.rows) {
    if (r[15] !== "UNGC") continue;
    out.push(r.slice(0, 16));
    seen.add(r[0].replace(/^M(\d+)(\w?)$/, (m, n, x) => "MESSIER" + n.padStart(3, "0") + x).replace(/\s+/g, ""));
  }
}
for (const ln of body) {
  const c = ln.split("\t");
  const r = {};
  head.forEach((h, i) => (r[h] = (c[i] || "").trim()));
  if (!r.Name || !r.Dist) continue;
  if (/^milky\s*way$/i.test(r.Name)) continue;            // modelled separately
  const ra = sexa(r.RAJ2000, true), dec = sexa(r.DEJ2000, false);
  const mpc = +r.Dist;
  const key = r.Name.replace(/\s+/g, "");
  seen.add(key);
  out.push([
    pretty(r.Name), COMMON[key] || null,
    +ra.toFixed(5), +dec.toFixed(5), +(mpc * MPC_MLY).toFixed(4),
    eclMly(ra, dec, mpc * MPC_MLY),
    r.A26 ? +(+r.A26 * 3.261563777).toFixed(2) : null,   // kly
    r.TT === "" ? null : +r.TT, r.Mcl || null, BARRED.has(key) ? 1 : 0,
    r["b/a"] ? +r["b/a"] : null, r.i ? +r.i : null,
    r.BMag ? +r.BMag : null, r.M26 ? +r.M26 : null,
    GROUPS[key] || (r.MD ? (GROUPS[r.MD.replace(/\s+/g, "")] || "Near " + pretty(r.MD)) : null),
    "UNGC"
  ]);
}
for (const g of CURATED) {
  if (seen.has(g[0])) continue;
  const mly = g[4] * MPC_MLY;
  out.push([pretty(g[0]), g[1], g[2], g[3], +mly.toFixed(4), eclMly(g[2], g[3], mly),
    +(g[5] * 3.261563777).toFixed(2), g[6], null, g[7] ? 1 : 0, g[8], null, null, null, g[9], "NED: " + g[10]]);
}

// ── HyperLEDA ──
const LEDA = "http://atlas.obs-hp.fr/hyperleda/fG.cgi?n=meandata&c=o&of=1,leda,simbad&nra=l&nakd=1" +
  "&d=objname,al2000,de2000,modz,mod0,bt,t,logd25,logr25,pa&a=csv%5B,%5D&ob=&sql=" +
  encodeURIComponent("objtype='G' and bt<15.5 and (modz is not null or mod0 is not null)");
let added = 0, matched = 0;
const far = [];
try {
  const csv = await (await fetch(LEDA, { signal: AbortSignal.timeout(600000) })).text();
  const rows = csv.split("\n").filter((l) => l && !l.startsWith("#")).slice(1).map((l) => l.split(","));
  // Spatial index of what we already have, for cross-matching by position.
  const grid = new Map();
  const cellKey = (ra, dec) => Math.floor(ra) + ":" + Math.floor(dec + 90);
  out.forEach((r, i) => { const k = cellKey(r[2], r[3]); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
  const byName = new Map(out.map((r, i) => [r[0], i]));
  for (const c of rows) {
    const [name, al, de, modz, mod0, bt, t, logd25, logr25, pa] = c;
    const ra = +al * 15, dec = +de;
    const mod = mod0 !== "" ? +mod0 : +modz;
    if (!Number.isFinite(ra) || !Number.isFinite(dec) || !Number.isFinite(mod) || bt === "") continue;
    const absB = +bt - mod;
    if (absB < -23.6 || absB > -9) continue;                 // misclassified stars, bad distances
    const mpc = Math.pow(10, (mod - 25) / 5);
    if (mpc < 0.05) continue;
    // Already in the catalogue? Then only borrow its position angle. Match by
    // name first; then by position, within a radius that grows with the
    // galaxy's size (big nearby galaxies have loosely defined centres).
    const d25 = logd25 !== "" ? 0.1 * Math.pow(10, +logd25) : 0;
    const radius = Math.max(1.5, d25 * 0.25) / 60;
    let hit = byName.has(pretty(name)) ? byName.get(pretty(name)) : -1;
    for (let dr = -1; dr <= 1 && hit < 0; dr++) for (let dd = -1; dd <= 1 && hit < 0; dd++) {
      const list = grid.get((Math.floor(ra) + dr) + ":" + (Math.floor(dec + 90) + dd)) || [];
      for (const i of list) {
        const r = out[i];
        const sep = Math.acos(Math.min(1, Math.sin(dec * DEG) * Math.sin(r[3] * DEG) + Math.cos(dec * DEG) * Math.cos(r[3] * DEG) * Math.cos((ra - r[2]) * DEG))) / DEG;
        if (sep < radius) { hit = i; break; }
      }
    }
    if (hit >= 0) { if (pa !== "") out[hit][16] = +(+pa).toFixed(1); matched++; continue; }
    const d25arcmin = logd25 !== "" ? 0.1 * Math.pow(10, +logd25) : null;
    const kpc = d25arcmin ? mpc * 1000 * d25arcmin * Math.PI / 10800 : null;
    // Compact row: [name, ra°, dec°, distMly, diamKly, T, b/a, absB, PA°, redshiftDistance?]
    far.push([pretty(name), +ra.toFixed(3), +dec.toFixed(3), +(mpc * MPC_MLY).toFixed(2),
      kpc ? +(kpc * 3.261563777).toFixed(1) : null, t !== "" ? Math.round(+t) : null,
      logr25 !== "" ? +Math.pow(10, -logr25).toFixed(2) : null, +absB.toFixed(1), pa !== "" ? Math.round(+pa) : null, mod0 !== "" ? 0 : 1]);
    added++;
  }
  console.log("HyperLEDA: added", added, "matched", matched);
} catch (e) {
  console.warn("HyperLEDA unavailable, skipping:", e.message);
}
for (const r of out) if (r.length < 17) r[16] = null;

const json = {
  frame: "J2000 ecliptic, megalight-years, Sol at origin",
  fields: ["name", "common", "raDeg", "decDeg", "distMly", "pos", "diamKly", "ttype", "dwarfClass", "barred",
    "axisRatio", "inclDeg", "absBmag", "logMass", "group", "src", "paDeg"],
  sources: [
    { name: "Updated Nearby Galaxy Catalog (Karachentsev, Makarov & Kaisina 2013)", url: "https://vizier.cds.unistra.fr/viz-bin/VizieR?-source=J/AJ/145/101" },
    { name: "NASA/IPAC Extragalactic Database (NED), distances for landmark galaxies", url: "https://ned.ipac.caltech.edu/" },
    { name: "HyperLEDA (Makarov et al. 2014), galaxies with B < 15.5 and position angles", url: "http://atlas.obs-hp.fr/hyperleda/" }
  ],
  retrieved: new Date().toISOString().slice(0, 10),
  rows: out
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(json));
console.log("galaxies:", out.length, "→", OUT);
if (far.length) {
  writeFileSync(OUT_FAR, JSON.stringify({
    frame: "Positions from RA/Dec + distance; computed in the browser",
    fields: ["name", "raDeg", "decDeg", "distMly", "diamKly", "ttype", "axisRatio", "absBmag", "paDeg", "redshiftDistance"],
    source: { name: "HyperLEDA (Makarov et al. 2014)", url: "http://atlas.obs-hp.fr/hyperleda/" },
    retrieved: new Date().toISOString().slice(0, 10),
    rows: far
  }));
  console.log("far galaxies:", far.length, "→", OUT_FAR);
}
