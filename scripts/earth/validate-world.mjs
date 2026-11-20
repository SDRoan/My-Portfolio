// Real-world validation of the Earth data, against independent open sources:
//
//   node scripts/earth/validate-world.mjs
//
//   landmarks  Wikidata vs OpenStreetMap (from landmarks.json), and whether a
//              detailed pack holds the landmark's real footprint
//   peaks      the highest point of the shipped elevation within 2 km of each
//              Wikidata summit, vs the published elevation, and how far it is
//   airports   every runway in OurAirports (public domain, thresholds from
//              surveys/AIPs) vs the runways drawn from Overture/OSM: heading,
//              length, position
//   rivers     Natural Earth river lines (public domain) vs the water drawn:
//              inside packs, OSM/Overture water polygons or tidal water burned
//              into the DEM; elsewhere, the global land cover's water share
//   cities     what each city pack contains (buildings, height sources,
//              roads by class, water)
//   imagery    imagery ↔ vector alignment (validate-imagery.py's results)
//
// Every check is classified, so a real source limitation isn't counted as a
// code bug:
//   PASS
//   WARN — SOURCE RESOLUTION LIMIT   the data is right but too coarse to show it
//   WARN — SOURCE DISAGREEMENT       independent open sources disagree (recorded, not averaged)
//   WARN — PARTIAL DATA              the open data covers only part of the feature
//   FAIL — INCORRECT IMPLEMENTATION  our geometry is wrong
// Writes space/data/earth/world-validation.txt.

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readBundle, decodeGrid } from "../../space/engine/packs.js";
import { decodeTile, tileOf, tileKey, HEIGHT_SOURCE, FOOTPRINT_DATASET } from "../../space/earth/tile-format.js";
import { readShapefile } from "../lib/shapefile.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RG = join(ROOT, "space", "data", "earth", "regions"), GL = join(ROOT, "space", "data", "earth", "global");
const CACHE = join(tmpdir(), "open-earth-cache");
const lines = [], out = (s) => { lines.push(s); console.log(s); };
const K = { PASS: "PASS", RES: "WARN — SOURCE RESOLUTION LIMIT", DIS: "WARN — SOURCE DISAGREEMENT", PART: "WARN — PARTIAL DATA", FAIL: "FAIL — INCORRECT IMPLEMENTATION" };
const RANK = [K.PASS, K.RES, K.PART, K.DIS, K.FAIL];
const worst = (...c) => c.reduce((a, b) => (RANK.indexOf(b) > RANK.indexOf(a) ? b : a), K.PASS);
const results = [], check = (name, cls, detail) => { if (cls === true) cls = K.PASS; if (cls === false) cls = K.FAIL; results.push(cls); out(cls + " · " + name + " — " + detail); };
const D2R = Math.PI / 180;
const dist = (a, b, c, d) => { const x = Math.sin((c - a) * D2R / 2) ** 2 + Math.cos(a * D2R) * Math.cos(c * D2R) * Math.sin((d - b) * D2R / 2) ** 2; return 2 * 6371008.8 * Math.asin(Math.sqrt(x)); };
const bearing = (a, b, c, d) => (Math.atan2(Math.sin((d - b) * D2R) * Math.cos(c * D2R), Math.cos(a * D2R) * Math.sin(c * D2R) - Math.sin(a * D2R) * Math.cos(c * D2R) * Math.cos((d - b) * D2R)) / D2R + 360) % 360;

const index = JSON.parse(readFileSync(join(RG, "index.json"), "utf8")).regions;
const meta = (id) => JSON.parse(readFileSync(join(RG, id, "meta.json"), "utf8"));
function tilesOf(id) {
  const m = meta(id), all = [];
  for (const bk of Object.keys(m.bundles || {})) {
    const raw = readFileSync(join(RG, id, "t", bk + ".bin"));
    for (const [, gz] of readBundle(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))) all.push(decodeTile(new Uint8Array(gunzipSync(gz))));
  }
  return all;
}
function demsOf(id) {
  return meta(id).dem.map((d) => ({ ...d, h: decodeGrid(gunzipSync(readFileSync(join(RG, id, d.file))), d.width, d.height) }));
}
const demAt = (dems, lat, lon) => {
  for (const d of dems.slice().reverse()) {
    const b = d.bounds;
    if (lat <= b.south || lat >= b.north || lon <= b.west || lon >= b.east) continue;
    const x = Math.floor((lon - b.west) / (b.east - b.west) * d.width), y = Math.floor((b.north - lat) / (b.north - b.south) * d.height), v = d.h[y * d.width + x];
    return v === -32768 ? null : v * d.scale;
  }
  return null;
};
const LM = JSON.parse(readFileSync(join(ROOT, "space", "data", "earth", "landmarks.json"), "utf8")).landmarks;
const lm = (name) => LM.find((r) => r.name === name);

// ── landmarks ──
out("== Landmarks (" + LM.length + " in the registry)");
const conf = LM.reduce((a, r) => ((a[r.confidence] = (a[r.confidence] || 0) + 1), a), {});
out("  location confidence: " + JSON.stringify(conf));
for (const r of LM.filter((x) => x.discrepancy)) out("  discrepancy: " + r.name + " — " + r.discrepancy);
const CITY = {
  "New York": ["Empire State Building", "One World Trade Center", "Statue of Liberty", "Central Park", "Brooklyn Bridge", "Times Square"],
  Paris: ["Eiffel Tower", "Arc de Triomphe", "Louvre Museum"], London: ["Palace of Westminster", "Big Ben", "Tower Bridge", "London Eye"],
  Tokyo: ["Tokyo Tower", "Tokyo Skytree"], Dubai: ["Burj Khalifa", "Jumeirah Burj Al Arab", "Palm Jumeirah"], Dhaka: ["Ahsan Manzil", "Jatiya Sangsad Bhaban"],
  "Cairo / Giza": ["Great Pyramid of Giza", "The Great Sphinx"], Rio: ["Christ the Redeemer", "Sugarloaf Mountain"], Sydney: ["Sydney Opera House", "Sydney Harbour Bridge"]
};
// Height tolerance: rendering/rounding (2 m or 1.5 %).
const near = (a, b) => Math.abs(a - b) <= Math.max(2, 0.015 * b);
function judge(r) {
  const cls = [], why = [];
  // Location: two sources agreeing, or one plus a confirming footprint/bridge.
  if (!r.pack) { cls.push(K.FAIL); why.push("no pack"); }
  if (r.confidence === "single source") { cls.push(K.PART); why.push("one source only"); }
  else if (r.confidence === "low") { cls.push(K.DIS); why.push(r.discrepancy || "sources disagree"); }
  why.unshift(r.osm ? "Wikidata–OSM " + r.distanceM + " m (" + r.confidence + ")" : "one source (" + r.confidence + ")");
  const f = r.footprint;
  if (f) {
    why.push("footprint [" + f.match + "] " + f.lengthM + " × " + f.widthM + " m, centroid " + f.distanceWikidataM + " m from Wikidata" + (f.distanceOsmM != null ? ", " + f.distanceOsmM + " m from OSM" : ""));
    if (/unverified/.test(f.match)) cls.push(K.PART);
    if (f.distanceWikidataM > 150) { cls.push(K.FAIL); why.push("footprint far from the landmark"); }
  }
  if (r.model) why.push("model " + r.model.type + (r.model.waterCrossedM ? " (crosses " + r.model.waterCrossedM + " m of water)" : ""));
  // Height drawn vs published.
  const drawn = f && f.heightM;
  if (drawn != null) {
    const pub = r.heightValues || [];
    const auth = r.authoritativeHeight;
    if (auth) { why.push("drawn " + drawn + " m = reviewed published height " + auth.valueM + " m (" + auth.measurement + ")"); if (!near(drawn, auth.valueM)) cls.push(K.FAIL); }
    else if (pub.length) { const ok = pub.some((v) => near(drawn, v)); why.push("drawn " + drawn + " m (" + f.heightSource + ") vs Wikidata " + pub.join(" / ") + " m"); if (!ok) cls.push(K.DIS); }
    else why.push("drawn " + drawn + " m (" + f.heightSource + ")");
  }
  if (r.sourceDisagreement) { cls.push(K.DIS); why.push(r.sourceDisagreement); }
  if (r.partial) { cls.push(K.PART); why.push(r.partial); }
  return [worst(...cls), why.join(" · ")];
}
for (const [city, names] of Object.entries(CITY)) {
  out("  " + city + ":");
  for (const n of names) {
    const r = lm(n);
    if (!r) { check(city + " · " + n, K.FAIL, "not in the registry"); continue; }
    const [c, d] = judge(r);
    check(city + " · " + n, c, d);
  }
}

// ── the specific landmark fixes ──
out("\n== Landmark fixes");
{
  const r = lm("Ahsan Manzil"), f = r && r.footprint;
  check("Ahsan Manzil · structure", f && f.match === "reviewed id" && f.distanceWikidataM < 30 && f.distanceOsmM < 30 ? K.PASS : K.FAIL,
    f ? "matched " + (f.ids || []).join(", ") + " (OSM way/624025793) · centroid " + f.distanceWikidataM + " m from Wikidata, " + f.distanceOsmM + " m from the OSM feature · " + f.lengthM + " × " + f.widthM + " m · walls drawn " + f.heightM + " m (" + f.heightSource + "), dome model to " + (r.model ? r.model.topM : "—") + " m" : "no footprint");
  if (r && r.partial) check("Ahsan Manzil · extent", K.PART, r.partial);
  const b = lm("Burj Khalifa"), bf = b && b.footprint;
  check("Burj Khalifa · height", bf && near(bf.heightM, 829.8) ? K.PASS : K.FAIL, bf ? "top drawn at " + bf.heightM + " m (" + bf.heightSource + ") · published 829.8 m · " + bf.pieces + " parts · footprint " + bf.lengthM + " × " + bf.widthM + " m, " + bf.distanceWikidataM + " m from Wikidata" : "no footprint");
  const o = lm("Sydney Opera House");
  check("Sydney Opera House · model", o && o.model && o.model.ring && o.footprint && o.footprint.distanceWikidataM < 50 ? K.PASS : K.FAIL,
    o && o.model ? "podium on the real outline (" + o.model.ring.length / 2 + " vertices, " + o.footprint.lengthM + " × " + o.footprint.widthM + " m vs published 183 × 120 m), axis " + o.model.bearing + "°, shells to " + o.model.topAslM + " m above sea level · " + o.accuracy : "no model");
  for (const n of ["Sydney Harbour Bridge", "Brooklyn Bridge"]) {
    const x = lm(n), m = x && x.model, span = m && (m.spanM || m.mainSpanM);
    check(n + " · structure", m && m.waterCrossedM && Math.abs(m.waterCrossedM - span) < 0.35 * span ? K.PASS : K.FAIL,
      m ? "axis " + m.bearing + "° from the real bridge roads · main span centred on " + m.waterCrossedM + " m of water (published span " + span + " m) · deck " + m.deckAslM + " m" : "no model");
  }
}

// ── iconic heights ──
out("\n== Iconic heights (published vs drawn)");
for (const n of ["Empire State Building", "One World Trade Center", "CN Tower", "Eiffel Tower", "Tokyo Tower", "Tokyo Skytree", "Burj Khalifa", "Petronas Towers", "Shanghai Tower", "Taipei 101", "Big Ben", "Great Pyramid of Giza", "Jatiya Sangsad Bhaban"]) {
  const r = lm(n);
  if (!r) { out("  " + n + ": not in the registry"); continue; }
  const f = r.footprint;
  out("  " + n.padEnd(24) + " published " + (r.heightValues && r.heightValues.length ? r.heightValues.join(" / ") : "—") + " m · " + (f && f.heightM != null ? "drawn " + f.heightM + " m (" + f.heightSource + ")" : r.pack ? "no footprint" : "outside the detailed packs (marker only, nothing drawn)"));
}

// ── peaks ──
out("\n== Peaks (DEM summit vs published summit; tolerances follow the DEM's cell size and the summit's sharpness)");
const PEAKS = [["Mount Everest", "everest"], ["K2", "k2"], ["Mount Kilimanjaro", "kilimanjaro"], ["Denali", "denali"], ["Mount Fuji", "fuji"], ["Mont Blanc", "mont-blanc"], ["Matterhorn", "matterhorn"], ["Aconcagua", "aconcagua"], ["Mount Rainier", "rainier"]];
for (const [n, id] of PEAKS) {
  const r = lm(n);
  if (!r || !existsSync(join(RG, id, "meta.json"))) { check("peak " + n, K.FAIL, "missing " + (r ? "pack " + id : "registry entry")); continue; }
  const dems = demsOf(id);
  const W0 = r.summitWikidata || r.summit || r;
  const cands = [["Wikidata summit", W0.lat, W0.lon]];
  if (r.osm && r.osm.extentM === 0) cands.push(["OpenStreetMap peak node", r.osm.lat, r.osm.lon]);
  // The finest DEM at the summit, and its local maximum within 2 km.
  const P = r.summit || r;
  const dem = dems.slice().reverse().find((d) => P.lat > d.bounds.south && P.lat < d.bounds.north && P.lon > d.bounds.west && P.lon < d.bounds.east);
  const cell = dem.arcsec * 30.87, step = (dem.bounds.north - dem.bounds.south) / dem.height;
  let best = -Infinity, bl = 0, bo = 0;
  for (let la = P.lat - 0.02; la <= P.lat + 0.02; la += step) for (let lo = P.lon - 0.02 / Math.cos(P.lat * D2R); lo <= P.lon + 0.02 / Math.cos(P.lat * D2R); lo += step) {
    if (dist(P.lat, P.lon, la, lo) > 2000) continue;
    const v = demAt(dems, la, lo);
    if (v !== null && v > best) { best = v; bl = la; bo = lo; }
  }
  let ring = 0; for (let a = 0; a < 360; a += 15) ring += demAt(dems, bl + 150 * Math.cos(a * D2R) / 111320, bo + 150 * Math.sin(a * D2R) / (111320 * Math.cos(bl * D2R))) / 24;
  const relief = best - ring, sharp = relief > 60, tol = sharp ? Math.max(5 * cell, 150) : Math.max(3 * cell, 100);
  const dz = r.elevationM ? best - r.elevationM : null;
  // A published summit agrees with the DEM if it is within the tolerance of
  // the DEM's highest cell, or the DEM there is within 15 m of that maximum
  // (a broad summit: where the highest cell falls is ill-defined).
  const offs = cands.map(([name, la, lo]) => { const d = Math.round(dist(la, lo, bl, bo)), drop = Math.round(best - demAt(dems, la, lo)); return { name, d, drop, ok: d <= tol || drop <= 15 }; });
  const agree = offs.filter((o) => o.ok), apart = cands.length > 1 ? Math.round(dist(cands[0][1], cands[0][2], cands[1][1], cands[1][2])) : 0;
  let c = K.PASS, note = "";
  if (!agree.length) { c = sharp ? K.RES : K.FAIL; note = sharp ? " — the DEM's highest cell is displaced on a steep summit" : ""; }
  else if (agree.length < offs.length) {
    if (apart > 150) { c = K.DIS; note = " — the published coordinates are " + apart + " m apart; the DEM confirms the " + agree.map((o) => o.name).join(" and "); }
    else { c = K.RES; note = " — both published coordinates agree (" + apart + " m apart); the DEM's highest cell on this steep summit is displaced"; }
  }
  if (dz !== null && Math.abs(dz) > 30) { const rr = dz < 0 && sharp; c = worst(c, rr ? K.RES : K.FAIL); if (rr) note += " — a " + cell.toFixed(0) + " m DEM undersamples a sharp summit (" + Math.round(dz) + " m)"; }
  check("peak " + n, c, "DEM (" + dem.source.replace(/ \(.*/, "") + ", " + cell.toFixed(0) + " m cells) summit " + Math.round(best) + " m · published " + (r.elevationM ?? "—") + " m" + (dz !== null ? " (Δ " + Math.round(dz) + " m)" : "") +
    " · " + offs.map((o) => o.name + " " + o.d + " m from the DEM maximum, " + o.drop + " m lower").join("; ") + " (tolerance " + Math.round(tol) + " m) · relief within 150 m: " + Math.round(relief) + " m" + note + (r.summitSource ? " · marker on " + r.summitSource : ""));
}

// ── airports ──
out("\n== Airports (OurAirports runway thresholds vs runways drawn)");
const csv = readFileSync(join(CACHE, "ourairports-runways.csv"), "utf8").split("\n").map((l) => l.split(",").map((x) => x.replace(/^"|"$/g, "")));
const head = csv[0], col = (n) => head.indexOf(n);
for (const [icao, id] of [["KJFK", "jfk"], ["KLAX", "lax"], ["EGLL", "heathrow"], ["RJTT", "haneda"], ["OMDB", "dxb"]]) {
  if (!existsSync(join(RG, id, "meta.json"))) { check("airport " + icao, false, "pack " + id + " missing"); continue; }
  const rws = tilesOf(id).flatMap((t) => t.roads.filter((r) => r.cls === 17));
  // Join pieces of the same runway: by heading and collinearity.
  const segs = rws.map((r) => { const p = r.pts, n = p.length / 2; return { a: [p[0], p[1]], b: [p[(n - 1) * 2], p[(n - 1) * 2 + 1]] }; });
  for (const row of csv.filter((r) => r[col("airport_ident")] === icao && r[col("closed")] === "0")) {
    const la1 = +row[col("le_latitude_deg")], lo1 = +row[col("le_longitude_deg")], la2 = +row[col("he_latitude_deg")], lo2 = +row[col("he_longitude_deg")];
    if (!la1 || !la2) continue;
    const hd = bearing(la1, lo1, la2, lo2) % 180, mid = [(la1 + la2) / 2, (lo1 + lo2) / 2], len = dist(la1, lo1, la2, lo2);
    // Pieces within 150 m of the OurAirports centreline, heading within 5°.
    let covered = 0, hdErr = [];
    for (const s of segs) {
      const h2 = bearing(s.a[0], s.a[1], s.b[0], s.b[1]) % 180, dh = Math.min(Math.abs(h2 - hd), 180 - Math.abs(h2 - hd));
      const sm = [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2];
      // distance from the piece's midpoint to the OA centreline
      const kx = 111320 * Math.cos(mid[0] * D2R), ax = (lo1 - sm[1]) * kx, ay = (la1 - sm[0]) * 111320, bx = (lo2 - sm[1]) * kx, by = (la2 - sm[0]) * 111320;
      const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy))), off = Math.hypot(ax + t * dx, ay + t * dy);
      if (off < 150 && dh < 5) { covered += dist(s.a[0], s.a[1], s.b[0], s.b[1]); hdErr.push(dh); }
    }
    const ok = covered > 0.6 * len;
    check("airport " + icao + " runway " + row[col("le_ident")] + "/" + row[col("he_ident")], ok, "OurAirports " + Math.round(len) + " m at " + hd.toFixed(1) + "° · drawn " + Math.round(covered) + " m along it" + (hdErr.length ? ", heading within " + Math.max(...hdErr).toFixed(1) + "°" : ""));
  }
}

// ── rivers ──
// Best available source first: inside a pack, the detailed vector water
// (OSM/Overture water polygons, and tidal water burned into the elevation),
// checked against independent reference points ON the river — the bridges
// Wikidata says cross it (P177), with their own coordinates (POLYGON
// validation: the point must fall on drawn water). Then Natural Earth's
// centrelines where it has them (LINE validation, ±300 m: 1:10m generalised).
// Outside packs, the global land cover (~925 m cells) — not a fair test for a
// river narrower than a cell, so that is classed a resolution limit when the
// detailed check passes.
out("\n== Rivers");
const NE = join(CACHE, "ne");
const rivers = ["ne_10m_rivers_lake_centerlines", "ne_10m_rivers_europe", "ne_10m_rivers_north_america"].flatMap((n) => readShapefile(readFileSync(join(NE, n + ".shp")), readFileSync(join(NE, n + ".dbf"))));
const named = (re) => rivers.filter((f) => re.test(f.props.name || "") || re.test(f.props.name_en || "")).flatMap((f) => f.parts.flat());
const inPoly = (la, lo, rings) => { let ins = false; for (const r of rings) for (let i = 0, j = r.length / 2 - 1; i < r.length / 2; j = i++) { const yi = r[i * 2], xi = r[i * 2 + 1], yj = r[j * 2], xj = r[j * 2 + 1]; if ((yi > la) !== (yj > la) && lo < ((xj - xi) * (la - yi)) / (yj - yi) + xi) ins = !ins; } return ins; };
// Drawn water in a pack, within r metres of a point.
const waterCache = new Map();
function packWater(id) {
  if (!waterCache.has(id)) {
    const T = tilesOf(id), dems = demsOf(id), polys = T.flatMap((t) => t.water.filter((w) => w.kind === 1).map((w) => w.rings));
    waterCache.set(id, (la, lo, r) => {
      const n = Math.max(1, Math.ceil(r / 20)), sy = r / n / 111320, sx = sy / Math.cos(la * D2R);
      for (let dy = -n; dy <= n; dy++) for (let dx = -n; dx <= n; dx++) {
        if (dx * dx + dy * dy > n * n) continue;
        const a = la + dy * sy, o = lo + dx * sx, v = demAt(dems, a, o);
        if ((v !== null && v <= -0.5) || polys.some((p) => inPoly(a, o, p))) return true;
      }
      return false;
    });
  }
  return waterCache.get(id);
}
async function bridgesOver(qid, b) {
  const f = join(CACHE, "wd-river-" + qid + "-" + [b.south, b.west, b.north, b.east].join("_") + ".json");
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  // Inside the pack's box only (wikibase:box): bridges that cross the river
  // (P177), and places located in or next to it (P206: ghats, piers, ports).
  const q = `SELECT ?b ?bLabel ?c ?how WHERE { SERVICE wikibase:box { ?b wdt:P625 ?c. bd:serviceParam wikibase:cornerSouthWest "Point(${b.west} ${b.south})"^^geo:wktLiteral; wikibase:cornerNorthEast "Point(${b.east} ${b.north})"^^geo:wktLiteral. }
    { ?b wdt:P177 wd:${qid}. BIND("crosses" AS ?how) } UNION { ?b wdt:P206 wd:${qid}. BIND("next to" AS ?how) }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }`;
  let j = null;
  for (let k = 0; k < 5 && !j; k++) {
    try { const r = await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q), { headers: { "User-Agent": "portfolio-open-earth-builder/1.0", Accept: "application/sparql-results+json" }, signal: AbortSignal.timeout(60000) }); if (r.ok) j = await r.json(); else throw new Error("HTTP " + r.status); }
    catch (e) { await new Promise((res) => setTimeout(res, 3000 * (k + 1))); }
  }
  if (!j) throw new Error("Wikidata query failed for " + qid);
  const list = j.results.bindings.map((x) => { const m = x.c.value.match(/Point\(([-\d.]+) ([-\d.]+)\)/); return m ? { name: x.bLabel.value, lat: +m[2], lon: +m[1], how: x.how.value } : null; }).filter(Boolean);
  writeFileSync(f, JSON.stringify(list));
  return list;
}
const RIVERS = [["Seine", "Q1471", /^Seine$/, "paris"], ["Thames", "Q19686", /^Thames$/, "london"], ["Nile", "Q3392", /^Nile$/, "cairo"], ["Buriganga", "Q2991464", /Buriganga/, "dhaka"],
  ["Hudson", "Q3140", /^Hudson$/, "nyc"], ["East River", "Q212862", /East River/, "nyc"]];
const polyOk = {};
for (const [river, qid, re, id] of RIVERS) {
  if (!existsSync(join(RG, id, "meta.json"))) { check("river " + river, K.FAIL, "pack missing"); continue; }
  const b = index.find((r) => r.id === id).bbox, w = packWater(id);
  // POLYGON validation: bridges over the river (Wikidata) must stand on drawn water.
  // Bridges first; places "next to" the river only where no bridge is in the pack.
  const all = (await bridgesOver(qid, b)).filter((p) => p.lat > b.south && p.lat < b.north && p.lon > b.west && p.lon < b.east);
  let br = all.filter((p) => p.how === "crosses"), tolM = 60, what = "Wikidata bridges over the " + river + " stand on";
  if (!br.length) { br = all.filter((p) => p.how === "next to"); tolM = 100; what = "Wikidata places on the " + river + " (P206: ghats, piers, ports) are on or within 100 m of"; }
  if (br.length) {
    const hit = br.filter((p) => w(p.lat, p.lon, tolM)), miss = br.filter((p) => !hit.includes(p));
    polyOk[river] = hit.length / br.length >= 0.7;
    const thin = tolM === 100 && br.length < 3;                        // too few independent references to call it verified
    check("river " + river + " (" + id + " pack, polygon)", thin && polyOk[river] ? K.PART : polyOk[river] ? K.PASS : hit.length ? K.PART : K.FAIL,
      (thin ? "only " + br.length + " independent reference point(s) in the pack — " : "") +
      hit.length + "/" + br.length + " " + what + " drawn water" + (tolM === 60 ? " (±60 m)" : "") + (hit.length ? " (" + hit.map((p) => p.name).slice(0, 3).join(", ") + (hit.length > 3 ? ", …" : "") + ")" : "") + (miss.length ? " · not: " + miss.map((p) => p.name).slice(0, 4).join(", ") : ""));
  } else out("  river " + river + " (" + id + " pack): no Wikidata bridge or riverside place with coordinates inside the pack");
  // LINE validation: Natural Earth centreline points.
  const pts = named(re).filter(([lo, la]) => la > b.south && la < b.north && lo > b.west && lo < b.east);
  if (!pts.length) { out("  river " + river + " (" + id + " pack, line): Natural Earth has no centreline here (too small for its 1:10m scale) — polygon validation used"); continue; }
  const hit = pts.filter(([lo, la]) => w(la, lo, 300)).length, ok = hit / pts.length >= 0.8;
  check("river " + river + " (" + id + " pack, line)", ok ? K.PASS : polyOk[river] ? K.RES : K.FAIL,
    hit + "/" + pts.length + " Natural Earth points on drawn water (±300 m)" + (!ok && polyOk[river] ? " — Natural Earth's 1:10m line is generalised by more than that here; the detailed polygon check passes" : ""));
}
// Global: the land cover's water share along major rivers.
const gidx = JSON.parse(readFileSync(join(GL, "index.json"), "utf8"));
const grids = new Map();
function gcell(lat, lon) {
  const la0 = Math.floor(lat / 3) * 3, lo0 = Math.floor(lon / 3) * 3, name = (la0 >= 0 ? "N" : "S") + String(Math.abs(la0)).padStart(2, "0") + (lo0 >= 0 ? "E" : "W") + String(Math.abs(lo0)).padStart(3, "0");
  if (!grids.has(name)) {
    const bk = Math.floor(lat / 15) * 15 + "_" + Math.floor(lon / 15) * 15;
    let g = null;
    if (gidx.bundles[bk]) {
      const raw = readFileSync(join(GL, "b" + bk + ".bin")), m = readBundle(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)), e = m.get("lc/" + name);
      if (e && e[0] === 71) g = new Uint8Array(gunzipSync(e.subarray(1)));
      else if (e) {
        const f = join(CACHE, "v.webp"); writeFileSync(f, e.subarray(1));
        const ppm = execFileSync("dwebp", ["-quiet", "-ppm", "-o", "-", f], { maxBuffer: 1 << 26 }), hdr = ppm.toString("latin1", 0, 40).match(/^P6\s+(\d+)\s+(\d+)\s+255\s/);
        const px = ppm.subarray(hdr[0].length); g = new Uint8Array(360 * 360); for (let i = 0; i < g.length; i++) g[i] = px[i * 3];
      }
    }
    grids.set(name, g);
  }
  const g = grids.get(name);
  if (!g) return -1;
  const x = Math.min(359, Math.floor((lon - lo0) * 120)), y = Math.min(359, Math.floor((la0 + 3 - lat) * 120));
  return g[y * 360 + x];
}
for (const [river, re] of [["Amazon", /^Amazonas$|^Amazon$/], ["Nile", /^Nile$/], ["Mississippi", /^Mississippi$/], ["Ganges", /^Ganges$/], ["Yangtze", /^Chang Jiang$|^Yangtze$/], ["Thames", /^Thames$/], ["Seine", /^Seine$/]]) {
  const pts = named(re);
  if (!pts.length) { out("  river " + river + ": not found in Natural Earth by that name"); continue; }
  let n = 0, wet = 0;
  for (const [lo, la] of pts) {
    n++;
    let w = false;
    for (let dy = -1; dy <= 1 && !w; dy++) for (let dx = -1; dx <= 1 && !w; dx++) { const v = gcell(la + dy / 120, lo + dx / 120); if (v >= 0 && ((v >> 4) === 8 || ((v >> 2) & 3) >= 1)) w = true; }
    if (w) wet++;
  }
  const ok = wet / n > 0.6;
  check("river " + river + " (global land cover)", ok ? K.PASS : polyOk[river] ? K.RES : K.FAIL, wet + "/" + n + " Natural Earth points within one ~925 m cell of land-cover water" +
    (!ok && polyOk[river] ? " — the river is narrower than the global ~925 m cell; inside the detailed pack it validates against vector water (above)" : ""));
}

// ── ports ──
out("\n== Ports (docks, piers and water drawn)");
for (const [name, id] of [["Port of Los Angeles", "port-la"], ["Port of Rotterdam", "rotterdam"], ["Port of Singapore (Tanjong Pagar–Pasir Panjang)", "singapore-port"]]) {
  if (!existsSync(join(RG, id, "meta.json"))) { check("port " + name, K.FAIL, "pack missing"); continue; }
  const T = tilesOf(id), decks = T.reduce((a, t) => a + t.water.filter((w) => w.kind === 3).length, 0), lakes = T.reduce((a, t) => a + t.water.filter((w) => w.kind === 1).length, 0);
  const d = demsOf(id)[0]; let wet = 0; for (const v of d.h) if (v !== -32768 && v * d.scale <= -0.5) wet++;
  const ok = decks > 0 && (wet > 0 || lakes > 0);
  check("port " + name, ok ? K.PASS : K.FAIL, decks + " piers/docks/quays (Overture infrastructure) · " + (100 * wet / d.h.length).toFixed(0) + "% of the pack is tidal water in the elevation · " + lakes + " inland water polygons");
}

// ── imagery alignment ──
const IA = join(ROOT, "space", "data", "earth", "imagery-alignment.json");
if (existsSync(IA)) {
  out("\n== Imagery ↔ vector alignment (validate-imagery.py: best shift of the imagery's water/paving against the vector water/runways)");
  for (const r of JSON.parse(readFileSync(IA, "utf8")).results) {
    const lim = r.limitM;
    // A weak correlation peak (falling < 50% within 60 m) can't prove a misalignment.
    const c = r.offsetM === null ? K.PART : r.offsetM <= lim ? K.PASS : r.offsetM <= 2 * lim ? K.RES : r.score < 0.5 ? K.PART : K.FAIL;
    check("imagery " + r.pack + " · " + r.layer, c, r.offsetM === null ? r.note : "offset " + r.offsetM + " m (dE " + r.dE + ", dN " + r.dN + ") against " + r.feature + " · " + r.method + " correlation (falls " + Math.round(r.score * 100) + "% within 60 m) · limit " + lim + " m (" + r.pixelM + " m pixels)" + (r.otherEstimates ? " · other estimates: " + r.otherEstimates.join("; ") : ""));
  }
}

// ── worldwide prototype cells (scripts/earth/world-cells.json) ──
out("\n== Worldwide prototype cells (same pipeline, places outside the original packs)");
for (const c of JSON.parse(readFileSync(join(ROOT, "scripts", "earth", "world-cells.json"), "utf8")).cells) {
  if (!existsSync(join(RG, c.id, "meta.json"))) { check("world " + c.id, K.FAIL, "pack not built"); continue; }
  const m = meta(c.id), st = m.stats || {}, km2 = c.sizeKm * c.sizeKm, img = (m.imagery || []).length, veg = !!m.veg;
  const dens = (st.buildings || 0) / km2;
  // A city cell must show a real city (footprints and streets); a rural cell
  // real, sparse structure — and never the procedural urban fallback.
  const ok = c.kind === "city" ? dens > 200 && st.roads > 1000 : st.roads > 20;
  check("world " + c.id, ok ? (img && veg ? K.PASS : K.PART) : K.FAIL,
    c.name + " · " + st.buildings + " buildings (" + dens.toFixed(0) + "/km²; heights tagged/levels/estimated " + [st.heightSources.tagged, st.heightSources.fromLevels, st.heightSources.estimated].join("/") + ") · " + st.roads + " road pieces · " + st.lakes + " water areas · imagery " + (img ? "Sentinel-2" : "none") + " · vegetation " + (veg ? "yes" : "no"));
}

// ── city packs ──
out("\n== City, airport and port packs");
for (const r of index.filter((x) => existsSync(join(RG, x.id, "meta.json")))) {
  const m = meta(r.id), st = m.stats || {};
  if (!st.buildings && !st.roads) continue;
  out("  " + r.id.padEnd(15) + " " + (st.buildings || 0) + " buildings (heights tagged/levels/estimated " + [st.heightSources?.tagged, st.heightSources?.fromLevels, st.heightSources?.estimated].join("/") + ") · " + (st.roads || 0) + " road pieces · " + (st.lakes || 0) + " water areas · " + ((r.bytes || 0) / 1048576).toFixed(1) + " MB");
}
const count = Object.fromEntries(RANK.map((c) => [c, results.filter((x) => x === c).length]));
out("\n" + results.length + " checks: " + RANK.map((c) => count[c] + " " + c).join(" · "));
out("PASS " + count[K.PASS] + " / WARN " + (count[K.RES] + count[K.DIS] + count[K.PART]) + " / FAIL " + count[K.FAIL]);
writeFileSync(join(ROOT, "space", "data", "earth", "world-validation.txt"), lines.join("\n") + "\n");
