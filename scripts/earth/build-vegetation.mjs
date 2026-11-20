// Builds the vegetation pack of each Earth region from open data:
//
//   node scripts/earth/build-vegetation.mjs [<id> …]        (ids in regions.mjs; default all)
//
// Sources
//   land cover   ESA WorldCover 10 m 2021 v200 (CC BY 4.0), read from the
//                public COGs on AWS with range requests — only the internal
//                tiles a region needs (scripts/lib/cog.mjs).
//   canopy       NLCD 2021 Tree Canopy Cover, CONUS, v2021-4 (USDA Forest
//                Service / MRLC; public domain) via the MRLC WCS, for the US
//                regions. Elsewhere tree density comes from the share of
//                WorldCover tree pixels.
//   map data     OpenStreetMap (ODbL), from the same Geofabrik extracts the
//                region packs use: individually mapped trees (natural=tree),
//                tree rows, woods, parks, lawns, scrub, wetlands, farmland,
//                orchards, vineyards — and areas that must stay clear
//                (parking, aprons, piers).
//
// Output: space/data/earth/regions/<id>/veg.bin — one SXB1 bundle with
//   meta    JSON: grid geometry, class names, sources, info strings, stats
//   grid    uint8 per 0.0002° cell (≈ 22 m N–S): class << 4 | density (0–15)
//   trees   exact OSM trees (binary, see TREE_BYTES)
//   rows    OSM tree rows (JSON polylines)
//   fields  OSM orchards and vineyards (JSON polygons with a row direction)
// Raw downloads are cached outside the repository (os.tmpdir()).

import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { REGIONS } from "./regions.mjs";
import { readTiff } from "../lib/geotiff.mjs";
import { readCogWindow } from "../lib/cog.mjs";
import { extractBox } from "../lib/osmpbf.mjs";
import { writeBundle } from "../../space/engine/packs.js";
import { VEG_CELL, CLASS, CLASS_NAMES, TREE_BYTES, FAMILY_HINT, LEAF_CYCLE } from "../../space/earth/veg-format.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "space", "data", "earth", "regions");
const CACHE = join(tmpdir(), "open-earth-cache");
mkdirSync(CACHE, { recursive: true });
const UA = "portfolio-open-earth-builder/1.0 (static site preprocessing; github.com/SDRoan/My-Portfolio)";
const D2R = Math.PI / 180;
const US = new Set(["kennedy", "nyc", "grand-canyon", "rainier", "jfk", "lax", "port-la"]);      // NLCD canopy covers the contiguous US

async function get(url, opts = {}, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...opts, headers: { "User-Agent": UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(600000) });
      if (r.status !== 200 && r.status !== 206) throw new Error("HTTP " + r.status + " " + url.slice(0, 140));
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { if (i === tries - 1) throw e; console.warn("  retry:", e.message); await new Promise((res) => setTimeout(res, 5000 * (i + 1))); }
  }
}
const fetchRange = (url, a, b) => get(url, { headers: { Range: "bytes=" + a + "-" + b } });

// ── ESA WorldCover 10 m 2021 v200: 3° × 3° COGs named by their SW corner ──
const WC = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/";
async function worldCover(b) {
  const px = 1 / 12000, W = Math.round((b.east - b.west) / px), H = Math.round((b.north - b.south) / px);
  const cacheFile = join(CACHE, "worldcover-" + [b.south, b.north, b.west, b.east].map((v) => v.toFixed(4)).join("_") + ".u8");
  if (existsSync(cacheFile)) return { W, H, px, data: new Uint8Array(readFileSync(cacheFile)), bounds: b };
  const data = new Uint8Array(W * H);
  for (let la = Math.floor(b.south / 3) * 3; la < b.north; la += 3) for (let lo = Math.floor(b.west / 3) * 3; lo < b.east; lo += 3) {
    const name = "ESA_WorldCover_10m_2021_v200_" + (la >= 0 ? "N" : "S") + String(Math.abs(la)).padStart(2, "0") + (lo >= 0 ? "E" : "W") + String(Math.abs(lo)).padStart(3, "0") + "_Map.tif";
    const box = { south: Math.max(b.south, la), north: Math.min(b.north, la + 3), west: Math.max(b.west, lo), east: Math.min(b.east, lo + 3) };
    const r = await readCogWindow(WC + name, box, fetchRange);
    const ox = Math.round((r.bounds.west - b.west) / px), oy = Math.round((b.north - r.bounds.north) / px);
    for (let y = 0; y < r.H; y++) for (let x = 0; x < r.W; x++) {
      const gx = ox + x, gy = oy + y;
      if (gx >= 0 && gx < W && gy >= 0 && gy < H) data[gy * W + gx] = r.data[y * r.W + x];
    }
    console.log("  worldcover " + name + " " + r.W + "×" + r.H);
  }
  writeFileSync(cacheFile, data);
  return { W, H, px, data, bounds: b };
}

// ── NLCD 2021 Tree Canopy Cover (percent), via the MRLC WCS, in WGS 84 ──
async function canopy(b) {
  const url = "https://www.mrlc.gov/geoserver/mrlc_download/wcs?" + new URLSearchParams({
    service: "WCS", version: "2.0.1", request: "GetCoverage", coverageId: "mrlc_download__nlcd_tcc_conus_2021_v2021-4", format: "image/geotiff",
    subsettingCrs: "http://www.opengis.net/def/crs/EPSG/0/4326", outputCrs: "http://www.opengis.net/def/crs/EPSG/0/4326" }) +
    "&subset=Lat(" + b.south + "," + b.north + ")&subset=Long(" + b.west + "," + b.east + ")";
  const file = join(CACHE, "nlcd-tcc-2021-" + [b.south, b.north, b.west, b.east].join("_") + ".tif");
  if (!existsSync(file)) writeFileSync(file, await get(url));
  const buf = readFileSync(file), t = readTiff(buf);
  const { parseHeader } = await import("../lib/geotiff.mjs");
  const m = parseHeader(buf).transform;
  if (!m) throw new Error("canopy: no georeferencing");
  return { W: t.W, H: t.H, data: t.data, west: m[3], north: m[7], dx: m[0], dy: -m[5] };
}

// ── OpenStreetMap vegetation ──
const GEOFABRIK = { florida: "florida", "new-york": "new-york", "new-jersey": "new-jersey", arizona: "arizona", washington: "washington", nepal: "nepal" };
const VEG_AREA = (t) => !!(/^(wood|scrub|heath|wetland|grassland|beach|sand|bare_rock|scree|glacier)$/.test(t.natural || "") ||
  /^(forest|orchard|vineyard|grass|meadow|farmland|village_green|recreation_ground|cemetery|plant_nursery)$/.test(t.landuse || "") ||
  /^(park|garden|pitch|golf_course|dog_park)$/.test(t.leisure || "") || t.amenity === "parking" || t.aeroway === "apron" || t.man_made === "pier" || !!t["area:highway"]);
const WANT_WAY = (t) => VEG_AREA(t) || t.natural === "tree_row";
const WANT_REL = (t) => t.type === "multipolygon" && VEG_AREA(t);
const WANT_NODE = (t) => t.natural === "tree";

function assembleRings(members) {
  const segs = members.filter((m) => m.type === "way" && m.geometry && m.geometry.length).map((m) => ({ role: m.role || "outer", pts: m.geometry.map((p) => [p.lat, p.lon]) }));
  const rings = [];
  for (const role of ["outer", "inner"]) {
    const pool = segs.filter((s) => (role === "outer" ? s.role !== "inner" : s.role === "inner")).map((s) => s.pts.slice());
    while (pool.length) {
      let ring = pool.shift(), grown = true;
      const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
      while (!same(ring[0], ring[ring.length - 1]) && grown) {
        grown = false;
        for (let i = 0; i < pool.length; i++) {
          const p = pool[i], end = ring[ring.length - 1];
          if (same(p[0], end)) ring = ring.concat(p.slice(1));
          else if (same(p[p.length - 1], end)) ring = ring.concat(p.slice(0, -1).reverse());
          else if (same(p[p.length - 1], ring[0])) ring = p.slice(0, -1).concat(ring);
          else if (same(p[0], ring[0])) ring = p.slice(1).reverse().concat(ring);
          else continue;
          pool.splice(i, 1); grown = true; break;
        }
      }
      if (ring.length >= 4 && same(ring[0], ring[ring.length - 1])) rings.push({ role, pts: ring.slice(0, -1) });
    }
  }
  return rings;
}
function polysOf(el) {
  if (el.type === "way") {
    if (!el.geometry || el.geometry.length < 4) return [];
    const pts = el.geometry.map((p) => [p.lat, p.lon]), a = pts[0], z = pts[pts.length - 1];
    if (a[0] !== z[0] || a[1] !== z[1]) return [];
    return [[pts.slice(0, -1)]];
  }
  const rings = assembleRings(el.members || []);
  const outers = rings.filter((r) => r.role === "outer").map((r) => [r.pts]);
  for (const inner of rings.filter((r) => r.role === "inner")) { const o = outers.find((poly) => inRing(inner.pts[0], poly[0])); if (o) o.push(inner.pts); }
  return outers;
}
function inRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i], [yj, xj] = ring[j];
    if ((yi > p[0]) !== (yj > p[0]) && p[1] < ((xj - xi) * (p[0] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// Even-odd scanline fill over a grid (rows from the north).
function burn(W, H, b, cell, polys, fn) {
  for (const poly of polys) {
    let s = Infinity, n = -Infinity;
    for (const ring of poly) for (const p of ring) { s = Math.min(s, p[0]); n = Math.max(n, p[0]); }
    const y0 = Math.max(0, Math.floor((b.north - n) / cell)), y1 = Math.min(H - 1, Math.ceil((b.north - s) / cell));
    for (let y = y0; y <= y1; y++) {
      const lat = b.north - (y + 0.5) * cell, xs = [];
      for (const ring of poly) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [ai, oi] = ring[i], [aj, oj] = ring[j];
        if ((ai > lat) !== (aj > lat)) xs.push(oi + (lat - ai) / (aj - ai) * (oj - oi));
      }
      xs.sort((a, c) => a - c);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.ceil((xs[k] - b.west) / cell - 0.5)), xb = Math.min(W - 1, Math.floor((xs[k + 1] - b.west) / cell - 0.5));
        for (let x = xa; x <= xb; x++) fn(y * W + x);
      }
    }
  }
}
function num(s) {
  if (s === undefined) return null;
  const m = String(s).replace(",", ".").match(/^\s*(-?[\d.]+)\s*(m|ft|'|cm|mm)?\s*$/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return m[2] === "ft" || m[2] === "'" ? v * 0.3048 : m[2] === "cm" ? v / 100 : m[2] === "mm" ? v / 1000 : v;
}
// Genera named in OSM → the broad visual family. Only used when the tag names
// one of them; nothing is inferred beyond what the data says.
const PALM = /^(sabal|washingtonia|phoenix|roystonea|cocos|syagrus|livistona|trachycarpus|butia|serenoa|dypsis|archontophoenix|veitchia|wodyetia|bismarckia|chamaerops|ptychosperma|adonidia|caryota|thrinax|coccothrinax|pritchardia|arecaceae)\b/i;
const MANGROVE = /^(rhizophora|avicennia|laguncularia|conocarpus)\b/i;
const CONIFER = /^(pinus|picea|abies|pseudotsuga|tsuga|thuja|juniperus|cedrus|taxus|larix|sequoia|sequoiadendron|cupressus|chamaecyparis|taxodium|metasequoia|cryptomeria|araucaria|calocedrus|podocarpus|xanthocyparis|platycladus)\b/i;
function genusOf(t) {
  for (const k of ["genus", "species", "taxon"]) if (t[k]) return String(t[k]).trim().split(/\s+/)[0];
  return null;
}
function familyHint(t) {
  const g = genusOf(t);
  if (g && PALM.test(g)) return FAMILY_HINT.palm;
  if (g && MANGROVE.test(g)) return FAMILY_HINT.mangrove;
  if (t.leaf_type === "needleleaved" || (g && CONIFER.test(g))) return FAMILY_HINT.needle;
  if (t.leaf_type === "broadleaved") return FAMILY_HINT.broad;
  if (t.leaf_type === "palm") return FAMILY_HINT.palm;
  return FAMILY_HINT.unknown;
}
// What the panel shows for a mapped tree: only what its tags say.
function infoOf(t) {
  const parts = [];
  const sp = t.species || t.taxon;
  if (sp) parts.push(String(sp));
  else if (t.genus) parts.push("genus " + t.genus);
  for (const k of ["species:en", "taxon:en", "genus:en"]) if (t[k]) { parts.push(String(t[k])); break; }
  if (t.leaf_type) parts.push(t.leaf_type);
  if (t.leaf_cycle) parts.push(t.leaf_cycle);
  const h = num(t.height) || num(t.est_height), c = num(t.diameter_crown);
  if (h) parts.push("height " + +h.toFixed(1) + " m" + (t.height ? "" : " (est_height)"));
  if (c) parts.push("crown " + +c.toFixed(1) + " m");
  return parts.join(" · ");
}
function bearingOfLongestEdge(ring) {
  let best = 0, ang = 0;
  const c = Math.cos(ring[0][0] * D2R);
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    const dx = (q[1] - p[1]) * c, dy = q[0] - p[0], l = Math.hypot(dx, dy);
    if (l > best) { best = l; ang = Math.atan2(dx, dy); }       // radians from north, clockwise
  }
  return ang;
}

async function build(R) {
  console.log("== " + R.id + " · " + R.name);
  const C = VEG_CELL;
  const snap = (v, f) => +(f(v / C) * C).toFixed(6);
  const b = { south: snap(R.bbox.south, Math.floor), north: snap(R.bbox.north, Math.ceil), west: snap(R.bbox.west, Math.floor), east: snap(R.bbox.east, Math.ceil) };
  const W = Math.round((b.east - b.west) / C), H = Math.round((b.north - b.south) / C);

  // 1. Land cover → majority class per cell and tree-pixel share.
  const wc = await worldCover(b);
  const cls = new Uint8Array(W * H), treeShare = new Float32Array(W * H);
  const WC_TO = { 10: CLASS.tree, 20: CLASS.shrub, 30: CLASS.grass, 40: CLASS.crop, 50: CLASS.built, 60: CLASS.bare, 70: CLASS.snow, 80: CLASS.water, 90: CLASS.wetland, 95: CLASS.mangrove, 100: CLASS.moss };
  const k = C / wc.px;                       // source pixels per cell (2.4)
  const hist = new Uint16Array(256);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx0 = Math.floor(x * k), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * k)), sy0 = Math.floor(y * k), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * k));
    hist.fill(0);
    let n = 0, trees = 0;
    for (let sy = sy0; sy < sy1 && sy < wc.H; sy++) for (let sx = sx0; sx < sx1 && sx < wc.W; sx++) { const v = wc.data[sy * wc.W + sx]; hist[v]++; n++; if (v === 10 || v === 95) trees++; }
    let best = 0, bv = 0;
    for (const v of [10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100]) if (hist[v] > best) { best = hist[v]; bv = v; }
    cls[y * W + x] = WC_TO[bv] || CLASS.none;
    treeShare[y * W + x] = n ? trees / n : 0;
  }

  // 2. Tree density: NLCD canopy percent (US), else the WorldCover tree share
  // smoothed over the neighbouring cells.
  const dens = new Float32Array(W * H);
  let canopySrc = null;
  if (US.has(R.id)) {
    const m = 0.003, cv = await canopy({ south: b.south - m, north: b.north + m, west: b.west - m, east: b.east + m });
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const lat = b.north - (y + 0.5) * C, lon = b.west + (x + 0.5) * C;
      const fx = (lon - cv.west) / cv.dx - 0.5, fy = (cv.north - lat) / cv.dy - 0.5;
      const x0 = Math.max(0, Math.min(cv.W - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(cv.H - 2, Math.floor(fy))), tx = Math.min(1, Math.max(0, fx - x0)), ty = Math.min(1, Math.max(0, fy - y0));
      const g = (i, j) => { const v = cv.data[j * cv.W + i]; return v > 100 ? 0 : v; };
      dens[y * W + x] = ((g(x0, y0) * (1 - tx) + g(x0 + 1, y0) * tx) * (1 - ty) + (g(x0, y0 + 1) * (1 - tx) + g(x0 + 1, y0 + 1) * tx) * ty) / 100;
    }
    canopySrc = "NLCD 2021 Tree Canopy Cover (CONUS, v2021-4), USDA Forest Service / MRLC";
  } else {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let s = 0, w = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const ww = dx || dy ? 0.5 : 1; s += treeShare[yy * W + xx] * ww; w += ww;
      }
      dens[y * W + x] = s / w;
    }
  }

  // 3. OpenStreetMap: mapped areas refine the class; mapped trees are kept exactly.
  const m = 0.01, box = { south: b.south - m, north: b.north + m, west: b.west - m, east: b.east + m };
  const els = [];
  // Overture regions: its land-use polygons stand in for OSM's vegetation
  // areas (their classes are OSM tag values); no individually mapped trees.
  if (R.source === "overture") {
    const f = join(CACHE, "overture-" + R.id + ".json.gz");
    const X = JSON.parse(gunzipSync(readFileSync(f)).toString());
    let k = 0;
    for (const [sub, cls, , g] of X.land_use) {
      const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
      for (const p of polys) {
        const tags = { landuse: cls, leisure: cls, natural: cls === "forest" ? "wood" : cls, amenity: cls, aeroway: cls };
        if (sub === "park" && !/park|garden|golf/.test(cls || "")) tags.leisure = "park";
        // A closed way per ring: outer first (holes are dropped).
        const ring = p[0];
        els.push({ type: "way", id: ++k, tags, geometry: ring.map(([lon, lat]) => ({ lat, lon })) });
      }
    }
    console.log("  overture land use: " + els.length + " polygons");
  }
  for (const name of (R.source ? [] : R.osm)) {
    const file = join(CACHE, "geofabrik-" + GEOFABRIK[name] + ".osm.pbf");
    if (!existsSync(file)) throw new Error("missing " + file + " (download the Geofabrik extract first)");
    const got = extractBox(file, box, WANT_WAY, WANT_REL, WANT_NODE, (msg) => process.stdout.write("  " + name + " " + msg + "      \r"));
    els.push(...got);
    console.log("\n  " + name + ": " + got.length + " vegetation elements");
  }
  const seen = new Set(), uniq = els.filter((e) => !seen.has(e.type + e.id) && seen.add(e.type + e.id));
  const layer = (pred) => uniq.filter((e) => e.type !== "node" && pred(e.tags || {})).flatMap(polysOf);
  const keepWaterSnow = (fn) => (i) => { const c = cls[i]; if (c !== CLASS.water && c !== CLASS.snow) fn(i); };
  const set = (c) => keepWaterSnow((i) => { cls[i] = c; });
  const counts = {};
  const apply = (name, pred, fn) => { const polys = layer(pred); counts[name] = polys.length; burn(W, H, b, C, polys, fn); };
  apply("farmland", (t) => t.landuse === "farmland", set(CLASS.crop));
  apply("park", (t) => /^(park|garden|golf_course|dog_park)$/.test(t.leisure || "") || /^(village_green|recreation_ground|cemetery)$/.test(t.landuse || ""), set(CLASS.park));
  apply("grass", (t) => /^(grass|meadow)$/.test(t.landuse || "") || t.natural === "grassland" || t.leisure === "pitch", set(CLASS.lawn));
  apply("scrub", (t) => /^(scrub|heath)$/.test(t.natural || ""), set(CLASS.scrub));
  // A mapped wood/forest confirms cells the satellite sees as tree cover (and
  // marks woods inside mapped parks); it doesn't plant trees on shrubland,
  // meadows, rock or snow — landuse=forest also marks
  // forest-management areas (e.g. the Kaibab National Forest) that include
  // bare rock, meadows and snow.
  apply("forest", (t) => t.natural === "wood" || t.landuse === "forest", (i) => {
    const c = cls[i];
    if (c === CLASS.tree) { cls[i] = CLASS.forest; dens[i] = Math.max(dens[i], 0.3); }
    else if (c === CLASS.park || c === CLASS.lawn) cls[i] = CLASS.forest;      // a mapped wood inside a park
  });
  apply("wetland", (t) => t.natural === "wetland", set(CLASS.wetland));
  apply("mangrove", (t) => t.natural === "wetland" && t.wetland === "mangrove", set(CLASS.mangrove));
  apply("bare", (t) => /^(beach|sand|bare_rock|scree)$/.test(t.natural || ""), set(CLASS.bare));
  apply("glacier", (t) => t.natural === "glacier", (i) => { cls[i] = CLASS.snow; dens[i] = 0; });
  apply("clear", (t) => t.amenity === "parking" || t.aeroway === "apron" || t.man_made === "pier" || !!t["area:highway"], (i) => { cls[i] = CLASS.none; dens[i] = 0; });
  // The launch site and anything else a region keeps clear.
  for (const ex of R.exclude || []) {
    const dLat = ex.r / 111320, dLon = ex.r / (111320 * Math.cos(ex.lat * D2R));
    for (let y = Math.max(0, Math.floor((b.north - ex.lat - dLat) / C)); y <= Math.min(H - 1, Math.ceil((b.north - ex.lat + dLat) / C)); y++)
      for (let x = Math.max(0, Math.floor((ex.lon - dLon - b.west) / C)); x <= Math.min(W - 1, Math.ceil((ex.lon + dLon - b.west) / C)); x++) {
        const lat = b.north - (y + 0.5) * C, lon = b.west + (x + 0.5) * C;
        if (Math.hypot((lat - ex.lat) * 111320, (lon - ex.lon) * 111320 * Math.cos(lat * D2R)) < ex.r) { cls[y * W + x] = CLASS.none; dens[y * W + x] = 0; }
      }
  }
  const grid = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) grid[i] = (cls[i] << 4) | Math.max(0, Math.min(15, Math.round(dens[i] * 15)));

  // Exact trees (natural=tree nodes inside the box).
  const strings = [""], strIdx = new Map([["", 0]]);
  const str = (s) => { if (!s) return 0; if (!strIdx.has(s)) { strIdx.set(s, strings.length); strings.push(s); } return strIdx.get(s); };
  const inBox = (la, lo) => la > b.south && la < b.north && lo > b.west && lo < b.east;
  const trees = uniq.filter((e) => e.type === "node" && inBox(e.lat, e.lon));
  const tb = Buffer.alloc(4 + trees.length * TREE_BYTES);
  tb.writeUInt32LE(trees.length, 0);
  let o = 4, withHeight = 0, withCrown = 0, withTaxon = 0, withLeaf = 0;
  for (const e of trees) {
    const t = e.tags;
    const h = num(t.height) || num(t.est_height) || 0, crown = num(t.diameter_crown) || 0;
    const circ = num(t.circumference), dia = t.diameter && /[a-z]/i.test(t.diameter) ? num(t.diameter) : null;
    const trunk = circ ? circ / Math.PI : dia || 0;
    if (h) withHeight++; if (crown) withCrown++; if (t.genus || t.species || t.taxon) withTaxon++; if (t.leaf_type) withLeaf++;
    tb.writeInt32LE(Math.round(e.lat * 1e7), o); tb.writeInt32LE(Math.round(e.lon * 1e7), o + 4);
    tb.writeUInt16LE(Math.min(65535, Math.round(h * 10)), o + 8); tb.writeUInt16LE(Math.min(65535, Math.round(crown * 10)), o + 10);
    tb.writeUInt16LE(Math.min(65535, Math.round(trunk * 100)), o + 12);
    tb.writeUInt8(familyHint(t), o + 14); tb.writeUInt8(LEAF_CYCLE[t.leaf_cycle] || 0, o + 15);
    tb.writeUInt16LE(str(infoOf(t)), o + 16); tb.writeUInt32LE(e.id % 4294967296, o + 18);
    o += TREE_BYTES;
  }
  // Tree rows and orchard/vineyard fields.
  const rows = uniq.filter((e) => e.type === "way" && e.tags.natural === "tree_row" && e.geometry && e.geometry.length > 1 && e.geometry.some((p) => inBox(p.lat, p.lon)))
    .map((e) => ({ id: e.id % 4294967296, pts: e.geometry.map((p) => [+p.lat.toFixed(7), +p.lon.toFixed(7)]), h: num(e.tags.height) || num(e.tags.est_height) || 0,
      crown: num(e.tags.diameter_crown) || 0, hint: familyHint(e.tags), info: str(infoOf(e.tags)) }));
  const fields = [];
  for (const e of uniq) {
    const t = e.tags || {};
    if (e.type === "node" || !(t.landuse === "orchard" || t.landuse === "vineyard")) continue;
    for (const poly of polysOf(e)) {
      if (!poly[0].some((p) => inBox(p[0], p[1]))) continue;
      fields.push({ kind: t.landuse, id: e.id % 4294967296, angle: +bearingOfLongestEdge(poly[0]).toFixed(4), rings: poly.map((r) => r.map((p) => [+p[0].toFixed(7), +p[1].toFixed(7)])),
        info: str([t.trees, t.crop, t.produce].filter(Boolean).join(" · ")) });
    }
  }

  // Stats: land-cover share (by cell), mapped data.
  const share = {};
  for (let i = 0; i < W * H; i++) { const n = CLASS_NAMES[cls[i]]; share[n] = (share[n] || 0) + 1; }
  for (const n in share) share[n] = +(share[n] / (W * H) * 100).toFixed(2);
  const meta = {
    version: 1, id: R.id, bounds: b, cell: C, W, H, classes: CLASS_NAMES, strings,
    sources: { landCover: "ESA WorldCover 10 m 2021 v200 (CC BY 4.0)", density: canopySrc || "share of ESA WorldCover tree-cover pixels (3 × 3 cells)", osm: "OpenStreetMap contributors (ODbL), Geofabrik extracts " + new Date().toISOString().slice(0, 10) },
    stats: { classSharePercent: share, osmAreas: counts, mappedTrees: trees.length, mappedTreesWith: { height: withHeight, crown: withCrown, taxon: withTaxon, leafType: withLeaf }, treeRows: rows.length, fields: fields.length },
    built: new Date().toISOString().slice(0, 10)
  };
  const z = (u8) => gzipSync(u8, { level: 9 });
  const entries = [["meta", z(Buffer.from(JSON.stringify(meta)))], ["grid", z(grid)], ["trees", z(tb.subarray(0, o))], ["rows", z(Buffer.from(JSON.stringify(rows)))], ["fields", z(Buffer.from(JSON.stringify(fields)))]];
  const bytes = writeBundle(entries);
  const dir = join(OUT, R.id);
  writeFileSync(join(dir, "veg.bin"), bytes);
  // Region meta and index learn about the pack.
  const mf = join(dir, "meta.json"), rm = JSON.parse(readFileSync(mf, "utf8"));
  rm.veg = { file: "veg.bin", bytes: bytes.length, mappedTrees: trees.length, treeRows: rows.length, fields: fields.length, built: meta.built };
  writeFileSync(mf, JSON.stringify(rm));
  const ixf = join(OUT, "index.json"), ix = JSON.parse(readFileSync(ixf, "utf8"));
  const er = ix.regions.find((r) => r.id === R.id);
  if (er) { er.bytes = (er.bytes || 0) - ((er.vegBytes || 0)) + bytes.length; er.vegBytes = bytes.length; writeFileSync(ixf, JSON.stringify(ix, null, 1)); }
  console.log("  grid " + W + "×" + H + " · " + entries.map(([k, v]) => k + " " + (v.length / 1024).toFixed(0) + " KB").join(" · ") + " · total " + (bytes.length / 1048576).toFixed(2) + " MB");
  console.log("  mapped trees " + trees.length + " (height " + withHeight + ", crown " + withCrown + ", taxon " + withTaxon + ", leaf type " + withLeaf + ") · rows " + rows.length + " · fields " + fields.length);
  console.log("  classes %", JSON.stringify(share));
}

const want = process.argv.slice(2);
for (const R of REGIONS.filter((r) => !want.length || want.includes(r.id))) await build(R);
