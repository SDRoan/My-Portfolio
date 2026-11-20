// Real nebulae, star clusters, black holes and neutron stars.
//
//   node scripts/astronomy/build-deep-sky.mjs
//
// There is no single open bulk catalogue that carries distances *and* physical
// sizes for these, so this is a curated table. Positions are J2000 (SIMBAD);
// distances and sizes are literature values, cited per row. The simulator
// places each object for real, and labels its internal structure as a
// procedural visualisation — the shapes are generated, not imaged.
//
// Output positions are J2000 ecliptic, light-years, Sol at origin.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "data", "astronomy", "deep-sky.json");
const EPS = 23.4392911 * Math.PI / 180;
const DEG = Math.PI / 180;

// [kind, subtype, name, alt names, RA°, Dec°, distance ly, size ly, extra, reference]
const OBJECTS = [
  // ── nebulae ──
  ["nebula", "emission", "Orion Nebula", ["M42", "NGC 1976"], 83.822, -5.391, 1344, 24, {}, "Kounkel+ 2017 (VLBA)"],
  ["nebula", "emission", "Eagle Nebula", ["M16", "NGC 6611"], 274.700, -13.807, 5700, 70, { pillars: true }, "Hillenbrand+ 1993"],
  ["nebula", "emission", "Lagoon Nebula", ["M8", "NGC 6523"], 270.904, -24.387, 4100, 110, {}, "Arias+ 2006"],
  ["nebula", "emission", "Trifid Nebula", ["M20", "NGC 6514"], 270.675, -22.971, 4100, 40, { reflection: true }, "Rho+ 2008"],
  ["nebula", "emission", "Carina Nebula", ["NGC 3372"], 161.265, -59.867, 7500, 230, {}, "Smith 2006"],
  ["nebula", "emission", "Rosette Nebula", ["NGC 2237", "Caldwell 49"], 97.980, 4.950, 5200, 130, { cavity: true }, "Román-Zúñiga & Lada 2008"],
  ["nebula", "emission", "North America Nebula", ["NGC 7000"], 314.750, 44.330, 2590, 90, {}, "Kuhn+ 2020 (Gaia)"],
  ["nebula", "emission", "Tarantula Nebula", ["30 Doradus", "NGC 2070"], 84.676, -69.101, 161000, 600, {}, "Pietrzyński+ 2019 (LMC distance)"],
  ["nebula", "reflection", "Witch Head Nebula", ["IC 2118"], 76.750, -7.200, 900, 50, {}, "Kun+ 2001"],
  ["nebula", "dark", "Horsehead Nebula", ["Barnard 33"], 85.245, -2.458, 1375, 3.5, {}, "Anthony-Twarog 1982"],
  ["nebula", "dark", "Coalsack Nebula", ["Caldwell 99"], 191.000, -62.500, 600, 60, {}, "Seidensticker & Schmidt-Kaler 1989"],
  ["nebula", "planetary", "Ring Nebula", ["M57", "NGC 6720"], 283.396, 33.029, 2570, 1.3, {}, "Gaia EDR3 central star"],
  ["nebula", "planetary", "Helix Nebula", ["NGC 7293", "Caldwell 63"], 337.411, -20.837, 655, 2.9, {}, "Gaia EDR3 central star"],
  ["nebula", "planetary", "Dumbbell Nebula", ["M27", "NGC 6853"], 299.902, 22.721, 1360, 2.5, {}, "Gaia EDR3 central star"],
  ["nebula", "planetary", "Cat's Eye Nebula", ["NGC 6543", "Caldwell 6"], 269.639, 66.633, 3300, 0.4, {}, "Reed+ 1999"],
  ["nebula", "snr", "Crab Nebula", ["M1", "NGC 1952"], 83.633, 22.015, 6500, 11, { pulsar: "Crab Pulsar" }, "Trimble 1973"],
  ["nebula", "snr", "Veil Nebula", ["Cygnus Loop", "NGC 6960"], 312.750, 30.670, 2400, 120, {}, "Fesen+ 2018"],
  ["nebula", "snr", "Cassiopeia A", ["3C 461"], 350.850, 58.815, 11000, 10, {}, "Reed+ 1995"],
  // ── open clusters ──
  ["cluster", "open", "Pleiades", ["M45", "Seven Sisters"], 56.750, 24.117, 444, 43, { members: 1000, reflection: true, ageMyr: 100 }, "Gaia DR2 (Lodieu+ 2019)"],
  ["cluster", "open", "Hyades", ["Melotte 25"], 66.750, 15.870, 153, 60, { members: 400, ageMyr: 625 }, "Gaia DR2 (Lodieu+ 2019)"],
  ["cluster", "open", "Beehive Cluster", ["M44", "Praesepe"], 130.100, 19.670, 577, 23, { members: 1000, ageMyr: 600 }, "Gaia DR2"],
  ["cluster", "open", "Jewel Box", ["NGC 4755", "Kappa Crucis Cluster"], 193.400, -60.330, 6440, 20, { members: 100, ageMyr: 14 }, "Dufton+ 2006"],
  ["cluster", "open", "Double Cluster", ["NGC 869", "NGC 884", "h and Chi Persei"], 34.750, 57.130, 7500, 70, { members: 600, ageMyr: 14 }, "Currie+ 2010"],
  ["cluster", "open", "Westerlund 1", ["Wd1"], 251.767, -45.851, 12100, 6, { members: 5000, ageMyr: 4 }, "Beasor+ 2021"],
  // ── globular clusters ──
  ["cluster", "globular", "Omega Centauri", ["NGC 5139"], 201.697, -47.479, 17090, 172, { members: 10000000, ageMyr: 11500 }, "Baumgardt & Vasiliev 2021"],
  ["cluster", "globular", "47 Tucanae", ["NGC 104"], 6.024, -72.081, 14700, 120, { members: 1000000, ageMyr: 12000 }, "Baumgardt & Vasiliev 2021"],
  ["cluster", "globular", "Great Globular Cluster in Hercules", ["M13", "NGC 6205"], 250.421, 36.461, 22200, 145, { members: 300000, ageMyr: 11650 }, "Baumgardt & Vasiliev 2021"],
  ["cluster", "globular", "M22", ["NGC 6656"], 279.100, -23.905, 10600, 100, { members: 300000, ageMyr: 12000 }, "Baumgardt & Vasiliev 2021"],
  ["cluster", "globular", "M4", ["NGC 6121"], 245.897, -26.526, 6400, 75, { members: 100000, ageMyr: 12200 }, "Baumgardt & Vasiliev 2021"],
  // ── black holes ──
  ["blackhole", "supermassive", "Sagittarius A*", ["Sgr A*"], 266.4168, -29.0078, 26670, 0, { massSun: 4.3e6, disk: "faint" }, "GRAVITY Collaboration 2019"],
  ["blackhole", "stellar", "Cygnus X-1", ["HDE 226868 system"], 299.590, 35.202, 7240, 0, { massSun: 21.2, disk: "xray", companion: "O9.7 Iab supergiant" }, "Miller-Jones+ 2021"],
  ["blackhole", "stellar", "V404 Cygni", ["GS 2023+338"], 306.016, 33.867, 7800, 0, { massSun: 9, disk: "xray", companion: "K0 IV star" }, "Miller-Jones+ 2009"],
  ["blackhole", "stellar", "Gaia BH1", ["Gaia DR3 4373465352415301632"], 262.172, -0.581, 1560, 0, { massSun: 9.62, disk: "none", companion: "G-type dwarf" }, "El-Badry+ 2023"],
  ["blackhole", "stellar", "Gaia BH2", ["Gaia DR3 5870569352746779008"], 207.570, -59.240, 3800, 0, { massSun: 8.94, disk: "none", companion: "red giant" }, "El-Badry+ 2023"],
  ["blackhole", "stellar", "Gaia BH3", ["Gaia DR3 4318465066420528000"], 294.960, 14.930, 1926, 0, { massSun: 32.7, disk: "none", companion: "metal-poor giant" }, "Gaia Collaboration 2024"],
  // ── neutron stars ──
  ["neutronstar", "pulsar", "Crab Pulsar", ["PSR B0531+21"], 83.633, 22.014, 6500, 0, { periodS: 0.0337 }, "ATNF Pulsar Catalogue"],
  ["neutronstar", "pulsar", "Vela Pulsar", ["PSR B0833-45"], 128.836, -45.176, 959, 0, { periodS: 0.0893 }, "ATNF Pulsar Catalogue"],
  ["neutronstar", "pulsar", "PSR B1919+21", ["CP 1919"], 290.437, 21.884, 2283, 0, { periodS: 1.3373 }, "ATNF Pulsar Catalogue; first pulsar found"],
  ["neutronstar", "pulsar", "Geminga", ["PSR J0633+1746"], 98.476, 17.770, 815, 0, { periodS: 0.2371 }, "ATNF Pulsar Catalogue"],
  ["neutronstar", "pulsar", "PSR J0437-4715", [], 69.316, -47.252, 510, 0, { periodS: 0.00576 }, "ATNF Pulsar Catalogue; nearest millisecond pulsar"],
  ["neutronstar", "isolated", "RX J1856.5-3754", [], 284.150, -37.910, 400, 0, { periodS: 7.06 }, "Walter+ 2010"],
  ["neutronstar", "magnetar", "SGR 1806-20", [], 272.164, -20.411, 28000, 0, { periodS: 7.56 }, "Bibby+ 2008"]
];

function eclLy(raDeg, decDeg, ly) {
  const a = raDeg * DEG, d = decDeg * DEG;
  const x = Math.cos(d) * Math.cos(a), y = Math.cos(d) * Math.sin(a), z = Math.sin(d);
  return [x, y * Math.cos(EPS) + z * Math.sin(EPS), -y * Math.sin(EPS) + z * Math.cos(EPS)]
    .map((v) => +(v * ly).toFixed(3));
}

const rows = OBJECTS.map((o) => [o[0], o[1], o[2], o[3], o[4], o[5], o[6], eclLy(o[4], o[5], o[6]), o[7], o[8], o[9]]);
const out = {
  frame: "J2000 ecliptic, light-years, Sol at origin",
  fields: ["kind", "subtype", "name", "aliases", "raDeg", "decDeg", "distLy", "pos", "sizeLy", "extra", "ref"],
  sources: [
    { name: "SIMBAD Astronomical Database (positions)", url: "https://simbad.cds.unistra.fr/" },
    { name: "ATNF Pulsar Catalogue", url: "https://www.atnf.csiro.au/research/pulsar/psrcat/" },
    { name: "Literature distances and sizes, cited per object", url: "" }
  ],
  rows
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
console.log("deep-sky objects:", rows.length, "→", OUT);
