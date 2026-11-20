// Real stars for the simulator: every star brighter than naked-eye limit or
// within 25 pc from the HYG database, plus Gaia DR3's census of the 20 pc
// neighbourhood for the faint red and white dwarfs HYG misses.
//
//   node scripts/astronomy/build-star-catalog.mjs
//
// Positions are written in the simulator's frame — J2000 ecliptic, light-years,
// Sol at the origin — so the browser does no catalogue maths.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "data", "astronomy", "stars.json");
const HYG = "https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv";
const GAIA = "https://gea.esac.esa.int/tap-server/tap/sync";

const PC_LY = 3.261563777;
const EPS = 23.4392911 * Math.PI / 180;
const DEG = Math.PI / 180;

function eqToEclLy(xpc, ypc, zpc) {
  return [
    +(xpc * PC_LY).toFixed(4),
    +((ypc * Math.cos(EPS) + zpc * Math.sin(EPS)) * PC_LY).toFixed(4),
    +((-ypc * Math.sin(EPS) + zpc * Math.cos(EPS)) * PC_LY).toFixed(4)
  ];
}
function raDecDistToEq(raDeg, decDeg, distPc) {
  const a = raDeg * DEG, d = decDeg * DEG;
  return [distPc * Math.cos(d) * Math.cos(a), distPc * Math.cos(d) * Math.sin(a), distPc * Math.sin(d)];
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const head = lines[0].split(",").map((h) => h.replace(/"/g, ""));
  return lines.slice(1).map((ln) => {
    const cells = [];
    let cur = "", q = false;
    for (const ch of ln) {
      if (ch === '"') q = !q;
      else if (ch === "," && !q) { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    const o = {};
    head.forEach((h, i) => (o[h] = cells[i]));
    return o;
  });
}

// ── HYG ──
const hygText = await (await fetch(HYG)).text();
const hyg = parseCsv(hygText);
const stars = [];
for (const s of hyg) {
  const dist = +s.dist;
  if (!(dist > 0) || dist >= 100000) continue;            // Sol, or no parallax
  const mag = +s.mag;
  if (!(mag <= 6.5 || dist <= 25)) continue;
  const bayer = s.bf ? s.bf.trim() : "";
  stars.push({
    name: s.proper || null,
    desig: bayer || (s.hip ? "HIP " + s.hip : s.gl ? s.gl : s.hd ? "HD " + s.hd : "HYG " + s.id),
    hip: s.hip ? +s.hip : null,
    hd: s.hd ? +s.hd : null,
    gl: s.gl || null,
    raDeg: +s.ra * 15, decDeg: +s.dec, distPc: dist,
    pos: eqToEclLy(+s.x, +s.y, +s.z),
    absmag: +(+s.absmag).toFixed(2),
    ci: s.ci === "" ? null : +(+s.ci).toFixed(3),
    spect: s.spect || null,
    src: "HYG"
  });
}
console.log("HYG selected:", stars.length);

// ── Gaia DR3: the 20 pc census ──
const q = "SELECT source_id, ra, dec, parallax, phot_g_mean_mag, bp_rp FROM gaiadr3.gaia_source " +
          "WHERE parallax > 50 AND parallax_over_error > 10 AND phot_g_mean_mag IS NOT NULL";
const gaiaUrl = GAIA + "?" + new URLSearchParams({ REQUEST: "doQuery", LANG: "ADQL", FORMAT: "csv", QUERY: q });
let gaiaAdded = 0, gaiaMatched = 0;
try {
  const gaia = parseCsv(await (await fetch(gaiaUrl)).text());
  for (const g of gaia) {
    const distPc = 1000 / +g.parallax;
    const ra = +g.ra, dec = +g.dec;
    // Same star already from HYG? Epochs differ (2000 vs 2016), so allow for
    // proper motion with a generous radius, and require a similar distance.
    const match = stars.find((s) => s.distPc < 26 && Math.abs(s.distPc - distPc) / distPc < 0.15 &&
      angSep(s.raDeg, s.decDeg, ra, dec) < 0.12);
    if (match) { match.gaia = g.source_id; gaiaMatched++; continue; }
    const eq = raDecDistToEq(ra, dec, distPc);
    const absG = +g.phot_g_mean_mag + 5 - 5 * Math.log10(distPc);
    stars.push({
      name: null, desig: "Gaia DR3 " + g.source_id, gaia: g.source_id,
      raDeg: ra, decDeg: dec, distPc,
      pos: eqToEclLy(eq[0], eq[1], eq[2]),
      absmag: +absG.toFixed(2),
      bpRp: g.bp_rp === "" ? null : +(+g.bp_rp).toFixed(3),
      ci: null, spect: null, src: "Gaia"
    });
    gaiaAdded++;
  }
} catch (e) {
  console.warn("Gaia query failed, shipping HYG only:", e.message);
}
console.log("Gaia matched:", gaiaMatched, "added:", gaiaAdded);

function angSep(ra1, de1, ra2, de2) {
  const a = Math.sin(de1 * DEG) * Math.sin(de2 * DEG) +
    Math.cos(de1 * DEG) * Math.cos(de2 * DEG) * Math.cos((ra1 - ra2) * DEG);
  return Math.acos(Math.min(1, a)) / DEG;
}

// Compact rows: [name, desig, x, y, z, absmag, colour, spect, src, hip, gaia, distPc]
// colour is B−V for HYG stars and Gaia BP−RP (tagged) for Gaia-only ones.
const rows = stars.map((s) => [
  s.name, s.desig, s.pos[0], s.pos[1], s.pos[2], s.absmag,
  s.ci !== null && s.ci !== undefined ? s.ci : s.bpRp !== undefined && s.bpRp !== null ? "g" + s.bpRp : null,
  s.spect, s.src, s.hip || null, s.gaia || null, +s.distPc.toFixed(3)
]);
const out = {
  frame: "J2000 ecliptic, light-years, Sol at origin",
  fields: ["name", "desig", "x", "y", "z", "absmag", "colour", "spect", "src", "hip", "gaia", "distPc"],
  sources: [
    { name: "HYG Database v4.1 (astronexus)", url: "https://github.com/astronexus/HYG-Database", license: "CC BY-SA 4.0" },
    { name: "ESA Gaia DR3 (parallax > 50 mas)", url: "https://gea.esac.esa.int/archive/", license: "ESA/Gaia/DPAC, CC BY-SA 3.0 IGO" }
  ],
  retrieved: new Date().toISOString().slice(0, 10),
  rows
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
console.log("stars:", rows.length, "→", OUT);
