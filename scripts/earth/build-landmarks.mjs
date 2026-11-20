// Builds the Earth landmark registry: space/data/earth/landmarks.json
//
//   node scripts/earth/build-landmarks.mjs
//
// Two independent open sources per landmark, never averaged:
//   1. Wikidata (CC0): coordinates (P625), published height (P2048) and
//      elevation (P2044) in SI units, type (P31), country (P17), and the
//      landmark's OpenStreetMap ids (P402 relation, P10689 way, P11693 node).
//   2. OpenStreetMap (ODbL), fetched from the official API by those ids: the
//      mapped feature's centroid and extent.
// The distance between them is recorded; if Wikidata's point lies outside the
// mapped extent (or > 250 m from a small feature) that's a discrepancy, kept
// and reported, not resolved. The registry is a list of Wikidata ids (below)
// — add one to add a landmark; nothing about it is typed in by hand.
//
// For landmarks inside a detailed region pack, the pack's own footprints are
// searched (the tallest building within 80 m), so the panel can say whether
// the 3D shape on screen is the real footprint, and with which height.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readBundle, decodeGrid } from "../../space/engine/packs.js";
import { tmpdir } from "node:os";
import { decodeTile, tileOf, tileKey, FOOTPRINT_DATASET, HEIGHT_SOURCE } from "../../space/earth/tile-format.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RG = join(ROOT, "space", "data", "earth", "regions");
const UA = { "User-Agent": "portfolio-open-earth-builder/1.0 (static site preprocessing; github.com/SDRoan/My-Portfolio)" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wikidata ids, checked by label and description (see the report).
const QIDS = [
  // North America
  "Q9202", "Q9188", "Q11245", "Q44440", "Q5317", "Q125006", "Q11259", "Q160409", "Q134883",
  // Europe
  "Q243", "Q64436", "Q19675", "Q10285", "Q62408", "Q41225", "Q83125", "Q160659", "Q48435", "Q82425", "Q39054", "Q131013", "Q133274", "Q129846",
  // Middle East, Africa
  "Q12495", "Q62939", "Q277294", "Q37200", "Q130958", "Q12506", "Q5788",
  // Asia
  "Q9141", "Q245347", "Q183536", "Q57965", "Q83063", "Q548679", "Q18547", "Q80290", "Q212610", "Q798826", "Q43473", "Q402937", "Q497536",
  // Oceania, South America
  "Q45178", "Q54495", "Q33910", "Q79961", "Q210722", "Q676203",
  // Peaks
  "Q513", "Q43512", "Q7296", "Q130018", "Q39231", "Q583", "Q1374", "Q39739", "Q194057",
  // Airports, ports
  "Q8685", "Q8731", "Q8691", "Q204853", "Q193439", "Q1308991", "Q1027807", "Q1421994"
];

async function getJson(url, opts = {}) {
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(url, { ...opts, headers: { ...UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(90000) });
      if (r.status === 429 || r.status >= 500) throw new Error("HTTP " + r.status);
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { if (i === 5) throw e; await sleep(4000 * (i + 1)); }
  }
}

async function wikidata() {
  const q = `SELECT ?item ?itemLabel ?itemDescription ?coord ?h ?e ?typeLabel ?countryLabel ?rel ?way ?node ?hpCoord ?hpLabel WHERE {
    VALUES ?item { ${QIDS.map((x) => "wd:" + x).join(" ")} }
    OPTIONAL { ?item wdt:P625 ?coord }
    OPTIONAL { ?item p:P2048/psn:P2048/wikibase:quantityAmount ?h }
    OPTIONAL { ?item p:P2044/psn:P2044/wikibase:quantityAmount ?e }
    OPTIONAL { ?item wdt:P31 ?type } OPTIONAL { ?item wdt:P17 ?country }
    OPTIONAL { ?item wdt:P610 ?hp . ?hp wdt:P625 ?hpCoord }
    OPTIONAL { ?item wdt:P402 ?rel } OPTIONAL { ?item wdt:P10689 ?way } OPTIONAL { ?item wdt:P11693 ?node }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }`;
  const j = await getJson("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q));
  const by = new Map();
  for (const b of j.results.bindings) {
    const id = b.item.value.split("/").pop();
    if (!by.has(id)) by.set(id, { qid: id, name: b.itemLabel.value, description: (b.itemDescription || {}).value || "", coords: new Set(), heights: new Set(), elevations: new Set(), types: new Set(), countries: new Set(), osm: new Set() });
    const L = by.get(id);
    if (b.coord) L.coords.add(b.coord.value);
    if (b.h) L.heights.add(+(+b.h.value).toFixed(1));
    if (b.e) L.elevations.add(+(+b.e.value).toFixed(0));
    if (b.typeLabel) L.types.add(b.typeLabel.value);
    if (b.countryLabel) L.countries.add(b.countryLabel.value);
    if (b.rel) L.osm.add("relation/" + b.rel.value);
    if (b.way) L.osm.add("way/" + b.way.value);
    if (b.node) L.osm.add("node/" + b.node.value);
    if (b.hpCoord) L.summit = { coord: b.hpCoord.value, name: (b.hpLabel || {}).value || "" };
  }
  // Labels the query's label service left as bare ids.
  const bare = [...by.values()].filter((L) => /^Q\d+$/.test(L.name));
  if (bare.length) {
    const j2 = await getJson("https://www.wikidata.org/w/api.php?action=wbgetentities&props=labels&languages=mul|en&languagefallback=1&format=json&ids=" + bare.map((L) => L.qid).join("|"));
    for (const L of bare) { const e = j2 && j2.entities[L.qid]; if (e && e.labels) { const l = e.labels.en || e.labels.mul; if (l) L.name = l.value; } }
  }
  return [...by.values()];
}
// Areas, natural features and bridges have no building footprint of their own
// (tested on the Wikidata TYPE only, as whole words: a description such as
// "skyscraper in New York City" must not disqualify a skyscraper).
const NOT_A_BUILDING = /\b(square|park|airport|port|harbou?r|mountain|volcano|archipelago|island|neighbou?rhood|massif|peak|summit|city|town|district|wall|citadel|garden|street|bridge|plaza|inselberg|hill|cliff|rock formation|monolith)s?\b/i;
// Reviewed corrections: which features ARE the landmark, published heights, models.
const OVERRIDES = JSON.parse(readFileSync(join(ROOT, "space", "data", "earth", "landmark-overrides.json"), "utf8")).landmarks;
const OVCACHE = join(tmpdir(), "open-earth-cache");

// The OSM feature: centroid (mean of its nodes) and bounding box.
async function osmFeature(ref) {
  const [type, id] = ref.split("/");
  const j = await getJson("https://api.openstreetmap.org/api/0.6/" + type + "/" + id + (type === "node" ? "" : "/full") + ".json");
  if (!j) return null;
  const nodes = j.elements.filter((e) => e.type === "node" && typeof e.lat === "number");
  if (!nodes.length) return null;
  let la = 0, lo = 0, s = 90, n = -90, w = 180, e = -180;
  for (const p of nodes) { la += p.lat; lo += p.lon; s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lon); e = Math.max(e, p.lon); }
  const main = j.elements.find((x) => x.type === type && String(x.id) === id) || {};
  // Convex hull of the feature's nodes (its outline, for building-like features).
  const P = nodes.map((p) => [p.lon, p.lat]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of P) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (const p of P.slice().reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1)).flatMap(([x, y]) => [y, x]);
  return { ref, lat: la / nodes.length, lon: lo / nodes.length, bbox: [s, w, n, e], tags: main.tags || {}, hull };
}
const dist = (a, b, c, d) => { const R = 6371008.8, D = Math.PI / 180, x = Math.sin((c - a) * D / 2) ** 2 + Math.cos(a * D) * Math.cos(c * D) * Math.sin((d - b) * D / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };

// Region packs: which one covers a point, and its tallest footprint within 80 m.
const index = JSON.parse(readFileSync(join(RG, "index.json"), "utf8")).regions;
const tileCache = new Map();
function packTile(id, key) {
  const ck = id + "/" + key;
  if (tileCache.has(ck)) return tileCache.get(ck);
  const m = JSON.parse(readFileSync(join(RG, id, "meta.json"), "utf8"));
  let t = null;
  if (m.tiles[key] && m.bundles) {
    const [iy, ix] = key.split("_").map(Number), sp = m.bundleSpan, f = join(RG, id, "t", Math.floor(iy / sp) + "_" + Math.floor(ix / sp) + ".bin");
    if (existsSync(f)) { const raw = readFileSync(f), b = readBundle(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)); const g = b.get(key); if (g) t = decodeTile(new Uint8Array(gunzipSync(g))); }
  }
  tileCache.set(ck, t);
  return t;
}
const D2R = Math.PI / 180;
const inRing = (la, lo, r) => { let ins = false; for (let i = 0, j = r.length / 2 - 1; i < r.length / 2; j = i++) { const yi = r[i * 2], xi = r[i * 2 + 1], yj = r[j * 2], xj = r[j * 2 + 1]; if ((yi > la) !== (yj > la) && lo < ((xj - xi) * (la - yi)) / (yj - yi) + xi) ins = !ins; } return ins; };
const centroidOf = (r) => { let a = 0, o = 0; const k = r.length / 2; for (let i = 0; i < r.length; i += 2) { a += r[i]; o += r[i + 1]; } return [a / k, o / k]; };
const areaOf = (r) => { const [la0, lo0] = centroidOf(r), k = Math.cos(la0 * D2R); let A = 0; for (let i = 0, j = r.length / 2 - 1; i < r.length / 2; j = i++) A += ((r[j * 2 + 1] - lo0) * k * (r[i * 2] - la0) - (r[i * 2 + 1] - lo0) * k * (r[j * 2] - la0)) * 111320 * 111320; return Math.abs(A / 2); };
// Minimum-area bounding rectangle of a ring (lat/lon flat): length, width, bearing of the long side.
function dims(r) {
  const [la0, lo0] = centroidOf(r), k = Math.cos(la0 * D2R), P = [];
  for (let i = 0; i < r.length; i += 2) P.push([(r[i + 1] - lo0) * 111320 * k, (r[i] - la0) * 111320]);
  let best = null;
  for (let a = 0; a < 180; a += 0.5) {
    const c = Math.cos(a * D2R), sn = Math.sin(a * D2R); let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, y] of P) { const u = x * sn + y * c, v = x * c - y * sn; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const A = (u1 - u0) * (v1 - v0);
    if (!best || A < best.A) best = { A, L: u1 - u0, W: v1 - v0, bearing: a };
  }
  if (best.W > best.L) best = { A: best.A, L: best.W, W: best.L, bearing: (best.bearing + 90) % 180 };
  return { lengthM: +best.L.toFixed(1), widthM: +best.W.toFixed(1), bearing: best.bearing };
}
// All map-tile buildings of the pack within ~r metres of a point.
function packBuildings(R, lat, lon, r) {
  const [iy, ix] = tileOf(lat, lon), out = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const t = packTile(R.id, tileKey(iy + dy, ix + dx));
    if (!t) continue;
    for (const bd of t.buildings) { const c = centroidOf(bd.rings[0]); if (dist(lat, lon, c[0], c[1]) < r) out.push({ ...bd, c }); }
  }
  return out;
}
// The Overture export of a pack (geometry by id), for reviewed ids.
const ovCache = new Map();
function overtureOf(id) {
  if (!ovCache.has(id)) { const f = join(OVCACHE, "overture-" + id + ".json.gz"); ovCache.set(id, existsSync(f) ? JSON.parse(gunzipSync(readFileSync(f)).toString()) : null); }
  return ovCache.get(id);
}
const flatRing = (g) => { const r = g.type === "Polygon" ? g.coordinates[0] : g.coordinates[0][0]; const out = []; for (const [lo, la] of r.slice(0, -1)) out.push(la, lo); return out; };
// The landmark's footprint in the pack, by (1) reviewed ids, (2) the footprint
// containing the point, (3) the nearest footprint within 25 m (unverified).
// Returns the features drawn for it and the height actually drawn.
function footprintAt(lat, lon, osmPt, ov, osm) {
  const R = index.find((r) => lat > r.bbox.south && lat < r.bbox.north && lon > r.bbox.west && lon < r.bbox.east);
  if (!R) return null;
  const near = packBuildings(R, lat, lon, 400);
  const pick = (set, method, outline, extra = {}) => {
    if (!set.length) return null;
    const top = set.reduce((a, b) => (b.h > a.h ? b : a));
    const c = centroidOf(outline);
    return { region: R.id, method, pieces: set.length, h: top.h, src: top.src, ds: top.ds, outline, centroid: c, dims: dims(outline),
      dWikidata: Math.round(dist(lat, lon, c[0], c[1])), dOsm: osmPt ? Math.round(dist(osmPt[0], osmPt[1], c[0], c[1])) : null, ...extra };
  };
  const ids = ov && ov.geometry && ov.geometry.overture;
  if (ids && ids.length) {
    const X = overtureOf(R.id);
    if (X) {
      const outlines = X.buildings.filter((b) => ids.includes(b[0])).map((b) => flatRing(b[b.length - 1]));
      const parts = X.parts.filter((p) => ids.includes(p[0])).map((p) => flatRing(p[p.length - 1]));
      const sig = outlines.concat(parts).map(centroidOf);
      // Pieces drawn in the pack whose centroid matches one of those features (≤ 0.5 m).
      const set = near.filter((bd) => sig.some((c) => dist(c[0], c[1], bd.c[0], bd.c[1]) < 0.5));
      const outline = outlines.sort((a, b) => areaOf(b) - areaOf(a))[0] || parts[0];
      return pick(set, "reviewed id", outline, { ids, replaced: !!(ov.geometry.replaceSource) }) || (outline ? { region: R.id, method: "reviewed id", pieces: 0, ids, outline, centroid: centroidOf(outline), dims: dims(outline), replaced: !!ov.geometry.replaceSource,
        dWikidata: Math.round(dist(lat, lon, ...centroidOf(outline))), dOsm: osmPt ? Math.round(dist(osmPt[0], osmPt[1], ...centroidOf(outline))) : null } : null);
    }
  }
  // The OpenStreetMap feature itself, when it is a building or tower: every
  // piece whose centroid lies inside its outline (convex hull) is the landmark.
  const t = (osm && osm.tags) || {};
  if (osm && osm.hull && osm.hull.length >= 6 && ((t.building && t.building !== "no") || t["building:part"] || t.type === "building" || /^(tower|lighthouse|obelisk|monument)$/.test(t.man_made || "") || t.tower || t.historic === "monument")) {
    const set = near.filter((bd) => inRing(bd.c[0], bd.c[1], osm.hull));
    if (set.length) return pick(set, "inside the OpenStreetMap outline (" + osm.ref + ")", osm.hull);
  }
  for (const [la, lo] of [[lat, lon]].concat(osmPt ? [osmPt] : [])) {
    const cont = near.filter((bd) => inRing(la, lo, bd.rings[0]));
    if (cont.length) {
      const anchor = cont.reduce((a, b) => (areaOf(b.rings[0]) > areaOf(a.rings[0]) ? b : a));
      const set = near.filter((bd) => bd === anchor || inRing(bd.c[0], bd.c[1], anchor.rings[0]));
      return pick(set, "contains the " + (la === lat ? "Wikidata" : "OpenStreetMap") + " point", anchor.rings[0]);
    }
  }
  const n = near.filter((bd) => dist(lat, lon, bd.c[0], bd.c[1]) < 25).sort((a, b) => dist(lat, lon, a.c[0], a.c[1]) - dist(lat, lon, b.c[0], b.c[1]))[0];
  if (n) return pick([n], "nearest within 25 m (unverified)", n.rings[0]);
  return { region: R.id, method: "none" };
}

// Pack elevation (to find where a bridge crosses water).
const demCache = new Map();
function demAt(id, lat, lon) {
  if (!demCache.has(id)) { const m = JSON.parse(readFileSync(join(RG, id, "meta.json"), "utf8")); demCache.set(id, m.dem.map((d) => ({ ...d, h: decodeGrid(gunzipSync(readFileSync(join(RG, id, d.file))), d.width, d.height) }))); }
  for (const d of demCache.get(id).slice().reverse()) {
    const b = d.bounds;
    if (lat <= b.south || lat >= b.north || lon <= b.west || lon >= b.east) continue;
    const v = d.h[Math.floor((b.north - lat) / (b.north - b.south) * d.height) * d.width + Math.floor((lon - b.west) / (b.east - b.west) * d.width)];
    return v === -32768 ? null : v * d.scale;
  }
  return null;
}
// A bridge's axis (from the pack's bridge-flagged roads) and its main-span
// centre (the middle of the water it crosses, along that axis).
function bridgeAxis(id, lat, lon, reach) {
  const [iy, ix] = tileOf(lat, lon), pts = [], k = 111320 * Math.cos(lat * D2R);
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const t = packTile(id, tileKey(iy + dy, ix + dx));
    if (t) for (const r of t.roads) if (r.flags & 1) for (let i = 0; i < r.pts.length; i += 2) if (dist(lat, lon, r.pts[i], r.pts[i + 1]) < reach) pts.push([(r.pts[i + 1] - lon) * k, (r.pts[i] - lat) * 111320]);
  }
  if (pts.length < 4) return null;
  let P = pts, ang = 0, cx = 0, cy = 0;
  for (let it = 0; it < 3; it++) {
    cx = P.reduce((a, p) => a + p[0], 0) / P.length; cy = P.reduce((a, p) => a + p[1], 0) / P.length;
    let sxx = 0, syy = 0, sxy = 0; for (const [x, y] of P) { sxx += (x - cx) ** 2; syy += (y - cy) ** 2; sxy += (x - cx) * (y - cy); }
    ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);                                   // from east, counter-clockwise
    const ux = Math.cos(ang), uy = Math.sin(ang);
    const keep = P.filter(([x, y]) => Math.abs(-(x - cx) * uy + (y - cy) * ux) < 40);
    if (keep.length < 4) break;
    P = keep;
  }
  let bearing = (90 - ang / D2R + 360) % 180;                                     // compass bearing of the axis
  const ux = Math.sin(bearing * D2R), uy = Math.cos(bearing * D2R);
  // Project the landmark point onto the axis, then walk it for the water.
  const s0 = (0 - cx) * ux + (0 - cy) * uy;
  const at = (s) => [lat + (cy + uy * s) / 111320, lon + (cx + ux * s) / k];
  const wet = (s) => { const [a, o] = at(s); const v = demAt(id, a, o); return v !== null && v <= -0.5; };
  let a = s0, b = s0;
  if (!wet(s0)) { let best = null; for (let d = 5; d < reach && best === null; d += 5) { if (wet(s0 + d)) best = s0 + d; else if (wet(s0 - d)) best = s0 - d; } if (best === null) return { bearing, center: at(s0), water: null }; a = b = best; }
  while (wet(a - 5) && a - s0 > -reach * 2) a -= 5;
  while (wet(b + 5) && b - s0 < reach * 2) b += 5;
  return { bearing, center: at((a + b) / 2), water: Math.round(b - a) };
}

function bridgeNear(id, lat, lon) {
  const [iy, ix] = tileOf(lat, lon);
  let best = null;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const t = packTile(id, tileKey(iy + dy, ix + dx));
    if (!t) continue;
    for (const r of t.roads) if (r.flags & 1) for (let i = 0; i < r.pts.length; i += 2) { const d = dist(lat, lon, r.pts[i], r.pts[i + 1]); if (d < 100 && (best === null || d < best)) best = Math.round(d); }
  }
  return best;
}
const M_CLASS = {
  "opera-shells": "REAL LOCATION + REAL FOOTPRINT + APPROXIMATE ARCHITECTURAL MODEL",
  dome: "REAL FOOTPRINT (PARTIAL) + PUBLISHED HEIGHT + APPROXIMATE DOME MODEL",
  "arch-bridge": "REAL LOCATION + APPROXIMATE STRUCTURE", "suspension-bridge": "REAL LOCATION + APPROXIMATE STRUCTURE",
  walkways: "EXACT OPEN-DATA TOWERS + APPROXIMATE WALKWAYS", statue: "REAL LOCATION + APPROXIMATE PROCEDURAL SCULPTURE"
};
const list = await wikidata();
console.log(list.length + " landmarks from Wikidata");
const out = [];
for (const L of list) {
  const coords = [...L.coords].map((c) => { const m = c.match(/Point\(([-\d.]+) ([-\d.]+)\)/); return m ? [+m[2], +m[1]] : null; }).filter(Boolean);
  if (!coords.length) { console.log("  no coordinates: " + L.qid + " " + L.name); continue; }
  const [lat, lon] = coords[0];
  const ov = OVERRIDES[L.qid] || null;
  let osm = null, osmVia = "Wikidata";
  if (!L.osm.size && ov && ov.geometry && ov.geometry.osm) { for (const r of ov.geometry.osm) L.osm.add(r); osmVia = "reviewed override"; }
  for (const ref of L.osm) { try { osm = await osmFeature(ref); } catch (e) { osm = null; } if (osm) break; await sleep(400); }
  await sleep(400);
  const rec = {
    qid: L.qid, name: L.name, description: L.description, type: [...L.types].slice(0, 3).join(", "), country: [...L.countries][0] || "",
    lat: +lat.toFixed(6), lon: +lon.toFixed(6), wikidataCoords: coords.length,
    // A massif's coordinate is often its centre; its highest point (P610) is the summit.
    summit: L.summit ? (() => { const m = L.summit.coord.match(/Point\(([-\d.]+) ([-\d.]+)\)/); return m ? { lat: +(+m[2]).toFixed(6), lon: +(+m[1]).toFixed(6) } : null; })() : null,
    heightM: L.heights.size ? Math.max(...L.heights) : null, heightValues: [...L.heights], elevationM: L.elevations.size ? Math.max(...L.elevations) : null,
    sources: ["Wikidata " + L.qid + " (CC0)"]
  };
  if (osm) {
    const d = dist(lat, lon, osm.lat, osm.lon), [s, w, n, e] = osm.bbox;
    const inside = lat >= s - 1e-4 && lat <= n + 1e-4 && lon >= w - 1e-4 && lon <= e + 1e-4;
    const span = dist(s, w, n, e);
    rec.osm = { ref: osm.ref, lat: +osm.lat.toFixed(6), lon: +osm.lon.toFixed(6), extentM: Math.round(span), height: osm.tags.height || null, ele: osm.tags.ele || null };
    rec.distanceM = Math.round(d);
    rec.sources.push("OpenStreetMap " + osm.ref + " (ODbL)" + (osmVia !== "Wikidata" ? " — id from the reviewed override" + (ov.geometry.site ? "; OSM " + ov.geometry.site + " carries wikidata=" + L.qid : "") : ""));
    rec.confidence = (inside && span < 3000) || d < 100 ? "high" : inside || d < 250 ? "medium" : "low";
    if (!inside && d > 250) rec.discrepancy = "Wikidata point is " + Math.round(d) + " m from the OSM feature's centroid and outside its extent";
  } else { rec.confidence = "single source"; rec.discrepancy = "no OpenStreetMap id on Wikidata (or not fetchable): one source only"; }
  if (rec.heightValues.length > 1 && Math.max(...rec.heightValues) - Math.min(...rec.heightValues) > 1) rec.heightNote = "Wikidata lists several heights (" + rec.heightValues.join(", ") + " m); the largest is shown";
  const fp = footprintAt(lat, lon, osm ? [osm.lat, osm.lon] : null, ov, osm);
  const isBuilding = !NOT_A_BUILDING.test(rec.type) || !!(ov && ov.geometry);
  if (fp) {
    rec.pack = fp.region;
    if (isBuilding && fp.outline) {
      rec.footprint = { match: fp.method, pieces: fp.pieces, heightM: fp.h ?? null, heightSource: fp.h != null ? HEIGHT_SOURCE[fp.src] : null, dataset: fp.h != null ? FOOTPRINT_DATASET[fp.ds] || "OpenStreetMap" : "OpenStreetMap (via Overture)",
        lengthM: fp.dims.lengthM, widthM: fp.dims.widthM, centroid: fp.centroid.map((v) => +v.toFixed(6)), distanceWikidataM: fp.dWikidata, distanceOsmM: fp.dOsm, ids: fp.ids, replacedByModel: fp.replaced || undefined };
    } else if (fp.method !== "none" && isBuilding) rec.footprintNote = "no footprint contains the point or lies within 25 m";
  }
  if (ov) {
    if (ov.authoritativeHeight) rec.authoritativeHeight = ov.authoritativeHeight;
    if (ov.published) rec.published = ov.published;
    if (ov.partial) rec.partial = ov.partial;
    if (ov.sourceDisagreement) rec.sourceDisagreement = ov.sourceDisagreement;
    if (ov.orientation) rec.orientation = ov.orientation;
    if (ov.geometry && ov.geometry.note) rec.geometryNote = ov.geometry.note;
  }
  // A bridge with one source: a bridge-flagged road of the pack's map data within 100 m confirms it.
  if (rec.confidence === "single source" && /bridge/i.test(rec.type) && fp) {
    const d = bridgeNear(fp.region, lat, lon);
    if (d !== null) { rec.confidence = "medium"; rec.sources.push("bridge-flagged road " + d + " m away in pack " + fp.region + " (OpenStreetMap)"); rec.discrepancy = undefined; }
  }
  // One source, but a building footprint (OSM via Overture) containing the point or within 25 m: an independent confirmation.
  if (rec.confidence === "single source" && rec.footprint && rec.footprint.distanceWikidataM < 25) {
    rec.confidence = "medium"; rec.sources.push(rec.footprint.dataset + " footprint " + rec.footprint.distanceWikidataM + " m away (pack " + rec.pack + ")");
    rec.discrepancy = undefined;
  }
  // Summits: two published coordinates (Wikidata's highest point P610, or its
  // point; OpenStreetMap's peak node). The marker goes on the one the pack's
  // elevation confirms is higher — never on a raw DEM pixel — and a
  // disagreement between them is recorded, not averaged.
  if (rec.pack && (rec.summit || /mountain|volcano|massif|peak/i.test(rec.type)) && rec.osm && rec.osm.extentM === 0 && rec.osm.ele) {
    const w = rec.summit || { lat: rec.lat, lon: rec.lon }, o = { lat: rec.osm.lat, lon: rec.osm.lon };
    const hw = demAt(rec.pack, w.lat, w.lon), ho = demAt(rec.pack, o.lat, o.lon), d = Math.round(dist(w.lat, w.lon, o.lat, o.lon));
    rec.summitWikidata = w;
    if (hw !== null && ho !== null && d > 150 && ho > hw + 20) {
      rec.summit = o; rec.summitSource = "OpenStreetMap peak node " + rec.osm.ref + " (ele " + rec.osm.ele + " m)";
      rec.discrepancy = "Wikidata's summit coordinate is " + d + " m from OpenStreetMap's peak node; the elevation model is " + Math.round(ho - hw) + " m higher at the OSM node (" + Math.round(ho) + " vs " + Math.round(hw) + " m), so the marker uses it";
    } else { rec.summit = w; rec.summitSource = "Wikidata " + (L.summit ? "highest point (P610)" : "coordinate") + (d <= 150 ? ", OSM peak node " + d + " m away" : ""); }
  }
  // Landmark models: placed from the real geometry.
  if (ov && ov.model && rec.pack) {
    const M = { ...ov.model };
    delete M.note;
    if (M.type === "dome" && rec.footprint) { M.anchor = { lat: rec.footprint.centroid[0], lon: rec.footprint.centroid[1] }; M.bearing = 0; }
    else if (M.type === "opera-shells" && fp && fp.outline) {
      const d = dims(fp.outline);
      // The long axis, pointing to the northern (harbour) end.
      M.anchor = { lat: +fp.centroid[0].toFixed(7), lon: +fp.centroid[1].toFixed(7) }; M.bearing = d.bearing > 90 ? d.bearing + 180 : d.bearing; M.lengthM = d.lengthM; M.widthM = d.widthM;
      M.ring = fp.outline.map((v) => +v.toFixed(7));
    } else if (M.type === "arch-bridge" || M.type === "suspension-bridge") {
      const span = M.spanM || M.mainSpanM, ax = bridgeAxis(rec.pack, lat, lon, span / 2 + 150);
      if (ax) { M.anchor = { lat: +ax.center[0].toFixed(7), lon: +ax.center[1].toFixed(7) }; M.bearing = +ax.bearing.toFixed(2); M.waterCrossedM = ax.water; }
    } else if (M.type === "walkways") {
      const X = overtureOf(rec.pack), c = M.between.map((id) => { const b = X && X.buildings.find((x) => x[0] === id); return b ? centroidOf(flatRing(b[b.length - 1])) : null; });
      if (c[0] && c[1]) { M.anchor = { lat: (c[0][0] + c[1][0]) / 2, lon: (c[0][1] + c[1][1]) / 2 }; M.lengthM = Math.round(dist(c[0][0], c[0][1], c[1][0], c[1][1])); const k = Math.cos(c[0][0] * D2R); M.bearing = +((Math.atan2((c[1][1] - c[0][1]) * k, c[1][0] - c[0][0]) / D2R + 360) % 360).toFixed(2); }
    } else if (M.type === "statue") {
      // On the mapped monument point if OSM has one (it agrees with Wikidata), on the mapped pedestal outline.
      M.anchor = osm && osm.ref.startsWith("node/") ? { lat: osm.lat, lon: osm.lon } : { lat, lon }; M.bearing = M.facingDeg;
      if (ov.geometry && ov.geometry.pedestal) { try { const pd = await osmFeature(ov.geometry.pedestal); if (pd && pd.hull) { M.ring = pd.hull.map((v) => +v.toFixed(7)); M.anchor = { lat: +pd.lat.toFixed(7), lon: +pd.lon.toFixed(7) }; } } catch (e) { /* square pedestal */ } }
    }
    if (M.anchor) { rec.model = M; rec.modelNote = ov.model.note; }
  }
  const fpH = rec.footprint && rec.footprint.heightSource;
  rec.accuracy = rec.model
    ? (M_CLASS[rec.model.type] || "REAL LOCATION + APPROXIMATE MODEL")
    : rec.footprint && fpH === "height tag" ? "EXACT OPEN-DATA GEOMETRY"
    : rec.footprint && fpH === HEIGHT_SOURCE[4] ? "REAL FOOTPRINT + PUBLISHED HEIGHT"
    : rec.footprint ? "REAL FOOTPRINT + ESTIMATED HEIGHT"
    : rec.pack ? "REAL LOCATION + OPEN-DATA SURROUNDINGS" : "REAL LOCATION (marker; global base surroundings)";
  out.push(rec);
  console.log("  " + rec.qid.padEnd(9) + " " + rec.name.slice(0, 32).padEnd(32) + " " + (rec.distanceM ?? "—") + " m · " + rec.confidence + (rec.pack ? " · pack " + rec.pack : "") + (rec.footprint ? " · footprint [" + rec.footprint.match + "] " + rec.footprint.heightM + " m (" + rec.footprint.heightSource + ")" : "") + (rec.model ? " · model " + rec.model.type : ""));
}
writeFileSync(join(ROOT, "space", "data", "earth", "landmarks.json"), JSON.stringify({ built: new Date().toISOString().slice(0, 10), sources: "Wikidata (CC0) + OpenStreetMap API (ODbL); region packs (Overture / OSM)", landmarks: out }, null, 1));
console.log(out.length + " written · confidence " + JSON.stringify(out.reduce((a, r) => ((a[r.confidence] = (a[r.confidence] || 0) + 1), a), {})));
