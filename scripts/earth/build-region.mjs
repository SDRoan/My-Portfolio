// Builds an Earth region pack from open data:
//
//   node scripts/earth/build-region.mjs <id> [<id> …]      (ids in regions.mjs, "all", or "index")
//
// For each region:
//   elevation  USGS 3DEP bare-earth DEM (US, public domain), via the National
//              Map 3DEPElevation ImageServer; or Copernicus DEM GLO-30
//              (elsewhere) from the AWS open-data bucket. Tidal water from
//              OpenStreetMap is burned in at −1.5 m so rivers and bays are water.
//   imagery    USDA NAIP aerial imagery (US, public domain) via the USGS
//              NAIPImagery ImageServer; NASA Blue Marble Next Generation 500 m
//              (public domain) elsewhere — cropped with libjpeg-turbo's djpeg.
//   map data   OpenStreetMap (ODbL), cut from Geofabrik's daily extracts:
//              buildings and building parts with their heights, roads, paths,
//              rail, runways, lakes, and a short list of named places.
//
// Output: space/data/earth/regions/<id>/ — meta.json, dem-*.i16.gz,
// img-*.jpg, t/<tile>.bin.gz — plus the index at regions/index.json.
// Raw downloads are cached outside the repository (os.tmpdir()).

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, statSync, renameSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { REGIONS } from "./regions.mjs";
import { readTiff } from "../lib/geotiff.mjs";
import { encodeTile, tileOf, tileKey, TILE_DEG, ROAD_CLASS, ROOF_SHAPE, FOOTPRINT_DATASET } from "../../space/earth/tile-format.js";
import { gunzipSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "space", "data", "earth", "regions");
const CACHE = join(tmpdir(), "open-earth-cache");
// Reviewed landmark corrections (space/data/earth/landmark-overrides.json): a
// published height for exactly the named Overture features, or features a
// landmark model replaces. Applied to the derived pack only; the source data
// is never edited.
const OVERRIDES = JSON.parse(readFileSync(join(ROOT, "space", "data", "earth", "landmark-overrides.json"), "utf8")).landmarks;
const OV_HEIGHT = new Map(), OV_REPLACED = new Set();
for (const [qid, o] of Object.entries(OVERRIDES)) for (const id of (o.geometry && o.geometry.overture) || []) {
  if (o.authoritativeHeight) OV_HEIGHT.set(id, { ...o.authoritativeHeight, qid });
  if (o.geometry.replaceSource) OV_REPLACED.add(id);
}
const PUBLISHED = 4;                                            // HEIGHT_SOURCE[4]
mkdirSync(CACHE, { recursive: true });
const UA = "portfolio-open-earth-builder/1.0 (static site preprocessing; github.com/SDRoan/My-Portfolio)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const D2R = Math.PI / 180;

async function cached(name, fetcher) {
  const f = join(CACHE, name);
  if (existsSync(f)) return readFileSync(f);
  const b = await fetcher();
  writeFileSync(f, b);
  return b;
}
async function get(url, opts = {}, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...opts, headers: { "User-Agent": UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(600000) });
      if (r.status === 429 || r.status === 504) throw new Error("HTTP " + r.status + " (busy)");
      if (!r.ok) throw new Error("HTTP " + r.status + " " + url.slice(0, 120));
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { if (i === tries - 1) throw e; console.warn("  retry:", e.message); await sleep(15000 * (i + 1)); }
  }
}
const h8 = (s) => createHash("sha1").update(s).digest("hex").slice(0, 12);

// ── elevation ──
async function dem3dep(b, arcsec) {
  const W = Math.round((b.east - b.west) * 3600 / arcsec), H = Math.round((b.north - b.south) * 3600 / arcsec);
  const url = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?" + new URLSearchParams({
    bbox: [b.west, b.south, b.east, b.north].join(","), bboxSR: 4326, imageSR: 4326, size: W + "," + H, format: "tiff",
    pixelType: "F32", interpolation: "RSP_BilinearInterpolation", noData: "-99999", f: "image" });
  const buf = await cached("3dep-" + h8(url) + ".tif", () => get(url));
  const t = readTiff(buf);
  if (t.W !== W || t.H !== H) throw new Error("3DEP returned " + t.W + "×" + t.H + ", asked " + W + "×" + H);
  return { W, H, data: t.data, nodata: -99999 };
}
async function demCopernicus(b, arcsec) {
  // GLO-30 tiles are 1°×1°, named by their south-west corner.
  const tiles = new Map();
  for (let la = Math.floor(b.south); la < b.north; la++) for (let lo = Math.floor(b.west); lo < b.east; lo++) {
    const ns = (la >= 0 ? "N" : "S") + String(Math.abs(la)).padStart(2, "0"), ew = (lo >= 0 ? "E" : "W") + String(Math.abs(lo)).padStart(3, "0");
    const name = "Copernicus_DSM_COG_10_" + ns + "_00_" + ew + "_00_DEM";
    const buf = await cached(name + ".tif", () => get("https://copernicus-dem-30m.s3.amazonaws.com/" + name + "/" + name + ".tif"));
    tiles.set(la + "," + lo, readTiff(buf));
  }
  const W = Math.round((b.east - b.west) * 3600 / arcsec), H = Math.round((b.north - b.south) * 3600 / arcsec);
  const data = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const lat = b.north - (y + 0.5) * arcsec / 3600, lon = b.west + (x + 0.5) * arcsec / 3600;
    const t = tiles.get(Math.floor(lat) + "," + Math.floor(lon));
    // GLO-30 is pixel-centred on whole arc-seconds from the tile's NW corner.
    const fx = (lon - Math.floor(lon)) * t.W, fy = (Math.floor(lat) + 1 - lat) * t.H;
    const x0 = Math.min(t.W - 2, Math.floor(fx)), y0 = Math.min(t.H - 2, Math.floor(fy)), tx = fx - x0, ty = fy - y0;
    const g = (i, j) => t.data[j * t.W + i];
    data[y * W + x] = (g(x0, y0) * (1 - tx) + g(x0 + 1, y0) * tx) * (1 - ty) + (g(x0, y0 + 1) * (1 - tx) + g(x0 + 1, y0 + 1) * tx) * ty;
  }
  return { W, H, data, nodata: null };
}

// ── imagery ──
// The NAIP ImageServer serves square pixels in the output SR (degrees here):
// asked for a box and a size of another aspect, it widens the box. So the
// size is chosen square in degrees, and the extent it reports is recorded.
async function imgNaip(b, px, file) {
  const wD = b.east - b.west, hD = b.north - b.south;
  const W = wD >= hD ? px : Math.round(px * wD / hD), H = wD >= hD ? Math.round(px * hD / wD) : px;
  const url = "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage?" + new URLSearchParams({
    bbox: [b.west, b.south, b.east, b.north].join(","), bboxSR: 4326, imageSR: 4326, size: W + "," + H, format: "jpg", compressionQuality: 82,
    interpolation: "RSP_BilinearInterpolation", f: "image" });
  const buf = await cached("naip-" + h8(url) + ".jpg", () => get(url));
  writeFileSync(file, buf);
  const r = W / H, served = { ...b };
  // Same rule as the server: square pixels at the larger of the two sizes, centred.
  const res = Math.max(wD / W, hD / H), cx = (b.east + b.west) / 2, cy = (b.north + b.south) / 2;
  served.west = cx - res * W / 2; served.east = cx + res * W / 2; served.south = cy - res * H / 2; served.north = cy + res * H / 2;
  void r;
  return { W, H, bytes: buf.length, served };
}
async function imgBmng(b, file) {
  // Blue Marble NG, July 2004 surface reflectance, 21600×21600 per 90° tile (A1…D2).
  const col = "ABCD"[Math.floor((b.west + 180) / 90)], row = b.north > 0 ? 1 : 2;
  const name = "world.200407.3x21600x21600." + col + row + ".jpg";
  const src = await cached("bmng-" + name, () => get("https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-base/july/" + name));
  const lon0 = Math.floor((b.west + 180) / 90) * 90 - 180, lat0 = row === 1 ? 90 : 0, k = 21600 / 90;
  const x = Math.round((b.west - lon0) * k), y = Math.round((lat0 - b.north) * k), w = Math.round((b.east - b.west) * k), h = Math.round((b.north - b.south) * k);
  const srcFile = join(CACHE, "bmng-" + name), ppm = join(CACHE, "crop.ppm");
  execFileSync("djpeg", ["-crop", w + "x" + h + "+" + x + "+" + y, "-outfile", ppm, srcFile]);
  // djpeg aligns crops to the JPEG block grid; trim the PPM to exactly the box.
  const raw = readFileSync(ppm), hdr = raw.toString("latin1", 0, 64).match(/^P6\s+(\d+)\s+(\d+)\s+255\s/);
  const fw = +hdr[1], fh = +hdr[2], off = hdr[0].length, dx = fw - w;
  const out = Buffer.alloc(w * h * 3);
  for (let j = 0; j < h; j++) raw.copy(out, j * w * 3, off + (j * fw + dx) * 3, off + (j * fw + dx + w) * 3);
  writeFileSync(ppm, Buffer.concat([Buffer.from("P6\n" + w + " " + h + "\n255\n"), out]));
  execFileSync("cjpeg", ["-quality", "88", "-outfile", file, ppm]);
  return { W: w, H: h, bytes: statSync(file).size };
}

// ── OpenStreetMap (Geofabrik extracts, cut to the region) ──
const GEOFABRIK = { florida: "north-america/us/florida", "new-york": "north-america/us/new-york", "new-jersey": "north-america/us/new-jersey",
  arizona: "north-america/us/arizona", washington: "north-america/us/washington", nepal: "asia/nepal" };
const PLACE = (t) => !!t.name && !!(t.aeroway === "aerodrome" || /^(hospital|university|college)$/.test(t.amenity || "") || /^(attraction|museum|viewpoint)$/.test(t.tourism || "") ||
  t.leisure === "park" || t.railway === "station" || t.natural === "peak" || /^(city|town|village|suburb|neighbourhood)$/.test(t.place || "") ||
  /^(tower|lighthouse)$/.test(t.man_made || "") || (t.building && t.height));
const WANT_WAY = (t) => !!(t.building || t["building:part"] || t.highway || /^(rail|light_rail|tram)$/.test(t.railway || "") || /^(runway|taxiway)$/.test(t.aeroway || "") ||
  t.natural === "water" || t.waterway === "riverbank" || t.landuse === "reservoir" || PLACE(t));
const WANT_REL = (t) => t.type === "multipolygon" && !!(t.building || t["building:part"] || t.natural === "water" || t.waterway === "riverbank" || t.landuse === "reservoir" || PLACE(t));
async function osmExtract(R) {
  const { extractBox } = await import("../lib/osmpbf.mjs");
  const b = R.bbox, m = 0.02, box = { south: b.south - m, north: b.north + m, west: b.west - m, east: b.east + m };
  const all = new Map();
  for (const name of R.osm) {
    const file = join(CACHE, "geofabrik-" + name + ".osm.pbf");
    if (!existsSync(file)) writeFileSync(file, await get("https://download.geofabrik.de/" + GEOFABRIK[name] + "-latest.osm.pbf"));
    const els = extractBox(file, box, WANT_WAY, WANT_REL, PLACE, (msg) => process.stdout.write("  " + R.id + " " + name + " " + msg + "      \r"));
    for (const el of els) all.set(el.type + el.id, el);
    console.log("\n  " + name + ": " + els.length + " elements");
  }
  return [...all.values()];
}
function placesOf(els) {
  return els.filter((e) => e.tags && PLACE(e.tags)).map((e) => {
    if (e.type === "node") return e;
    const pts = e.type === "way" ? e.geometry : (e.members || []).flatMap((m) => m.geometry || []);
    if (!pts || !pts.length) return null;
    let a = 0, o = 0; for (const p of pts) { a += p.lat; o += p.lon; }
    return { ...e, lat: a / pts.length, lon: o / pts.length };
  }).filter(Boolean);
}

// Join a multipolygon's member ways into closed rings.
function assembleRings(members) {
  const segs = members.filter((m) => m.type === "way" && m.geometry).map((m) => ({ role: m.role || "outer", pts: m.geometry.map((p) => [p.lat, p.lon]) }));
  const rings = [];
  for (const role of ["outer", "inner"]) {
    let pool = segs.filter((s) => (role === "outer" ? s.role !== "inner" : s.role === "inner")).map((s) => s.pts.slice());
    while (pool.length) {
      let ring = pool.shift();
      const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
      let grown = true;
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
    const pts = el.geometry.map((p) => [p.lat, p.lon]);
    const a = pts[0], z = pts[pts.length - 1];
    if (a[0] !== z[0] || a[1] !== z[1]) return [];
    return [[pts.slice(0, -1)]];
  }
  // relation: each outer with the inners inside it
  const rings = assembleRings(el.members || []);
  const outers = rings.filter((r) => r.role === "outer").map((r) => [r.pts]);
  for (const inner of rings.filter((r) => r.role === "inner")) {
    const o = outers.find((poly) => pointInRing(inner.pts[0], poly[0]));
    if (o) o.push(inner.pts);
  }
  return outers;
}
function pointInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i], [yj, xj] = ring[j];
    if ((yi > p[0]) !== (yj > p[0]) && p[1] < ((xj - xi) * (p[0] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const centroid = (ring) => { let a = 0, b = 0; for (const p of ring) { a += p[0]; b += p[1]; } return [a / ring.length, b / ring.length]; };
const areaM2 = (ring) => {
  const k = 111320, c = Math.cos(ring[0][0] * D2R);
  let s = 0;
  for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length]; s += p[1] * k * c * q[0] * k - q[1] * k * c * p[0] * k; }
  return Math.abs(s / 2);
};

// ── building heights ──
// 1. the height tag (metres; feet converted)  2. building:levels × 3 m
// 3. a conservative estimate from the building type and footprint.
function num(s) {
  if (s === undefined) return null;
  const m = String(s).replace(",", ".").match(/^\s*(-?[\d.]+)\s*(m|ft|')?/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return m[2] === "ft" || m[2] === "'" ? v * 0.3048 : v;
}
const RES = new Set(["house", "detached", "semidetached_house", "residential", "apartments", "terrace", "bungalow", "dormitory", "cabin", "static_caravan", "houseboat"]);
const COM = new Set(["commercial", "retail", "office", "hotel", "supermarket", "kiosk", "mall"]);
const IND = new Set(["industrial", "warehouse", "manufacture", "hangar", "storage_tank", "service", "garage", "garages", "shed", "carport", "barn", "farm_auxiliary", "silo", "transformer_tower", "hut"]);
const CIV = new Set(["school", "hospital", "university", "college", "public", "government", "civic", "church", "cathedral", "chapel", "mosque", "synagogue", "temple", "train_station", "transportation", "stadium", "museum", "fire_station", "police", "library", "kindergarten"]);
function classOf(t) { return RES.has(t) ? 0 : COM.has(t) ? 1 : IND.has(t) ? 2 : CIV.has(t) ? 3 : 4; }
function estimate(type, area) {
  const table = { house: 7, detached: 7, semidetached_house: 7, bungalow: 4, terrace: 9, residential: 9, apartments: 14, dormitory: 12,
    garage: 3, garages: 3, shed: 3, carport: 3, hut: 3, kiosk: 3, cabin: 4, roof: 5, commercial: 8, retail: 6, supermarket: 7, office: 14, hotel: 18,
    industrial: 9, warehouse: 9, manufacture: 9, hangar: 12, service: 4, church: 14, cathedral: 25, school: 9, hospital: 15, university: 14, college: 12,
    public: 10, government: 12, civic: 10, train_station: 10, transportation: 8, stadium: 18 };
  if (table[type]) return table[type];
  return area < 60 ? 3.5 : area < 200 ? 6 : area < 1000 ? 8 : 10;
}
function heightOf(tags, area) {
  const type = tags.building && tags.building !== "yes" ? tags.building : tags["building:part"] && tags["building:part"] !== "yes" ? tags["building:part"] : "yes";
  let h = num(tags.height), src = 0;
  const lv = num(tags["building:levels"]), rlv = num(tags["roof:levels"]) || 0;
  if (!(h > 0)) { if (lv > 0) { h = (lv + rlv) * 3; src = 1; } else { h = estimate(type, area); src = 2; } }
  let minH = num(tags.min_height);
  if (!(minH >= 0)) { const ml = num(tags["building:min_level"]); minH = ml > 0 ? ml * 3 : 0; }
  if (type === "roof" && !minH) minH = Math.max(0, h - 1);          // open canopies
  return { h: Math.min(h, 900), minH: Math.min(minH, h - 0.5 > 0 ? h - 0.5 : 0), src, cls: classOf(type) };
}

// ── road classes ──
const HW = { motorway: 0, motorway_link: 0, trunk: 1, trunk_link: 1, primary: 2, primary_link: 2, secondary: 3, secondary_link: 3, tertiary: 4, tertiary_link: 4,
  residential: 5, unclassified: 6, road: 6, service: 7, living_street: 8, pedestrian: 9, footway: 10, cycleway: 11, path: 12, bridleway: 12, steps: 13, track: 14 };
function roadClass(t) {
  if (t.tunnel && t.tunnel !== "no") return -1;
  if (t.area === "yes") return -1;
  if (t.highway in HW) return HW[t.highway];
  if (t.railway === "rail" || t.railway === "light_rail") return 15;
  if (t.railway === "tram") return 16;
  if (t.aeroway === "runway") return 17;
  if (t.aeroway === "taxiway") return 18;
  return -1;
}

// ── raster helpers ──
// Even-odd scanline fill of polygons (rings of [lat, lon]) over a grid.
function burn(grid, W, H, b, polys, fn) {
  for (const poly of polys) {
    let s = Infinity, n = -Infinity;
    for (const ring of poly) for (const p of ring) { s = Math.min(s, p[0]); n = Math.max(n, p[0]); }
    const y0 = Math.max(0, Math.floor((b.north - n) / (b.north - b.south) * H)), y1 = Math.min(H - 1, Math.ceil((b.north - s) / (b.north - b.south) * H));
    for (let y = y0; y <= y1; y++) {
      const lat = b.north - (y + 0.5) * (b.north - b.south) / H, xs = [];
      for (const ring of poly) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [ai, oi] = ring[i], [aj, oj] = ring[j];
        if ((ai > lat) !== (aj > lat)) xs.push(oi + (lat - ai) / (aj - ai) * (oj - oi));
      }
      xs.sort((a, c) => a - c);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.ceil((xs[k] - b.west) / (b.east - b.west) * W - 0.5)), xb = Math.min(W - 1, Math.floor((xs[k + 1] - b.west) / (b.east - b.west) * W - 0.5));
        for (let x = xa; x <= xb; x++) fn(y * W + x);
      }
    }
  }
}
function sampleGrid(g, b, lat, lon) {
  const fx = (lon - b.west) / (b.east - b.west) * g.W - 0.5, fy = (b.north - lat) / (b.north - b.south) * g.H - 0.5;
  const x = Math.max(0, Math.min(g.W - 1, Math.round(fx))), y = Math.max(0, Math.min(g.H - 1, Math.round(fy)));
  return g.data[y * g.W + x];
}
// Clip a ring to a lat/lon box (Sutherland–Hodgman).
function clipRing(ring, b) {
  const edges = [[(p) => p[1] >= b.west, (p, q) => [p[0] + (q[0] - p[0]) * (b.west - p[1]) / (q[1] - p[1]), b.west]],
    [(p) => p[1] <= b.east, (p, q) => [p[0] + (q[0] - p[0]) * (b.east - p[1]) / (q[1] - p[1]), b.east]],
    [(p) => p[0] >= b.south, (p, q) => [b.south, p[1] + (q[1] - p[1]) * (b.south - p[0]) / (q[0] - p[0])]],
    [(p) => p[0] <= b.north, (p, q) => [b.north, p[1] + (q[1] - p[1]) * (b.north - p[0]) / (q[0] - p[0])]]];
  let out = ring;
  for (const [inside, cut] of edges) {
    const src = out; out = [];
    for (let i = 0; i < src.length; i++) {
      const p = src[i], q = src[(i + 1) % src.length];
      if (inside(p)) { out.push(p); if (!inside(q)) out.push(cut(p, q)); } else if (inside(q)) out.push(cut(p, q));
    }
    if (out.length < 3) return [];
  }
  return out;
}

function writeGrid(file, g, scale) {
  const buf = Buffer.alloc(g.W * g.H * 2);
  for (let y = 0; y < g.H; y++) {
    let prev = 0;
    for (let x = 0; x < g.W; x++) {
      const i = y * g.W + x, v0 = g.data[i];
      const v = Number.isFinite(v0) ? Math.max(-32767, Math.min(32767, Math.round(v0 / scale))) : -32768;
      buf.writeInt16LE(((v - prev) << 16) >> 16, i * 2);
      prev = v;
    }
  }
  const gz = gzipSync(buf, { level: 9 });
  writeFileSync(file, gz);
  return gz.length;
}

// ── Overture Maps (regions with source: "overture") ──
// The features come from scripts/earth/export-overture.py (DuckDB over
// Overture's public GeoParquet release); they are mapped onto the same
// structures the OpenStreetMap path produces. Overture buildings are already
// conflated across OpenStreetMap, Microsoft and Google footprints.
const OV_ROAD = { motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, residential: 5, unclassified: 6, unknown: 6, service: 7, living_street: 8,
  pedestrian: 9, footway: 10, sidewalk: 10, crosswalk: 10, cycleway: 11, path: 12, bridleway: 12, steps: 13, track: 14 };
const OV_DATASET = { OpenStreetMap: 0, "Microsoft ML Buildings": 1, "Google Open Buildings": 2, "Esri Community Maps": 3 };
async function overtureFeatures(R) {
  const file = join(CACHE, "overture-" + R.id + ".json.gz");
  if (!existsSync(file)) {
    const b = R.bbox, py = process.env.OVERTURE_PYTHON || "python3";
    console.log("  exporting from Overture " + (process.env.OVERTURE_RELEASE || "") + "…");
    execFileSync(py, [join(ROOT, "scripts", "earth", "export-overture.py"), R.id, b.south, b.west, b.north, b.east, file].map(String), { stdio: "inherit" });
  }
  const X = JSON.parse(gunzipSync(readFileSync(file)).toString());
  const ll = (c) => [c[1], c[0]];
  const polys = (g) => g.type === "Polygon" ? [g.coordinates.map((r) => r.slice(0, -1).map(ll))] : g.type === "MultiPolygon" ? g.coordinates.map((p) => p.map((r) => r.slice(0, -1).map(ll))) : [];
  const lines = (g) => g.type === "LineString" ? [g.coordinates.map(ll)] : g.type === "MultiLineString" ? g.coordinates.map((l) => l.map(ll)) : [];
  const roofOf = (s) => Math.max(0, ROOF_SHAPE.indexOf(s || "flat"));
  // A height and its source: measured → floors × 3 m → class/footprint estimate.
  const hinfo = (h, minH, floors, cls, roofH, A) => {
    let src = 0, H = h;
    if (!(H > 0)) { if (floors > 0) { H = floors * 3 + (roofH || 0); src = 1; } else { H = estimate(cls || "yes", A); src = 2; } }
    return { h: Math.min(H, 900), minH: Math.min(minH || 0, Math.max(0, H - 0.5)), src, cls: classOf(cls || "yes") };
  };
  const out = { buildings: [], parts: [], roads: [], waters: [], paved: [], decks: [], counts: { datasets: {}, roofs: {} } };
  const withParts = new Set(X.parts.map((p) => p[0]));
  out.overrides = [];
  for (const b of X.buildings) {
    const [id, name, h, minH, floors, roof, roofH, , cls, , ds, , under, g] = b;
    if (under) continue;
    if (OV_REPLACED.has(id)) { out.overrides.push({ id, replaced: "building and its parts (drawn by the landmark model)" }); continue; }
    if (withParts.has(id)) continue;                                 // drawn as its parts
    const auth = OV_HEIGHT.get(id);
    for (const poly of polys(g)) {
      const A = areaM2(poly[0]);
      const hi = { ...hinfo(h, minH, floors, cls, roofH, A), roof: roofOf(roof), roofH: roofH || 0, ds: OV_DATASET[ds] ?? 4 };
      if (auth && auth.applyTo === "building") { out.overrides.push({ id, from: hi.h, to: auth.valueM, source: auth.source }); hi.h = auth.valueM; hi.src = PUBLISHED; hi.roof = 0; hi.roofH = 0; }
      out.buildings.push({ poly, hinfo: hi, name });
      out.counts.datasets[ds] = (out.counts.datasets[ds] || 0) + 1;
      if (roof) out.counts.roofs[roof] = (out.counts.roofs[roof] || 0) + 1;
    }
  }
  // "tallest-part" overrides: the highest part of the named building gets the published height.
  const tallest = new Map();
  for (const p of X.parts) if (OV_HEIGHT.get(p[0])?.applyTo === "tallest-part" && !p[7] && (!tallest.has(p[0]) || (p[1] || 0) > (tallest.get(p[0])[1] || 0))) tallest.set(p[0], p);
  for (const p of X.parts) {
    const [bid, h, minH, floors, roof, roofH, , under, g] = p;
    if (under || OV_REPLACED.has(bid)) continue;
    for (const poly of polys(g)) {
      const hi = { ...hinfo(h, minH, floors, "yes", roofH, areaM2(poly[0])), roof: roofOf(roof), roofH: roofH || 0, ds: 0 };
      if (tallest.get(bid) === p) { const a = OV_HEIGHT.get(bid); out.overrides.push({ id: bid, part: "tallest", from: hi.h, to: a.valueM, source: a.source }); hi.h = a.valueM; hi.src = PUBLISHED; }
      out.buildings.push({ poly, hinfo: hi });
    }
  }
  const flag = (rules, f) => (rules || []).some((r) => (r.values || []).includes(f));
  for (const sg of X.segments) {
    const [sub, cls, , rflags, railFlags, widths, , g] = sg;
    if (flag(rflags, "is_tunnel") || flag(railFlags, "is_tunnel") || flag(railFlags, "is_underground")) continue;   // not drawn on the surface
    let c = -1;
    if (sub === "road") c = OV_ROAD[cls] ?? -1;
    else if (sub === "rail") c = /subway|unknown/.test(cls || "") ? -1 : cls === "tram" || cls === "light_rail" ? 16 : 15;
    if (c < 0) continue;
    const w = widths && widths.length && widths[0].value;
    for (const pts of lines(g)) out.roads.push({ cls: c, tags: { bridge: flag(rflags, "is_bridge") || flag(railFlags, "is_bridge") ? "yes" : "no", width: w ? String(w) : undefined }, pts });
  }
  for (const w of X.water) {
    const [sub, cls, , g] = w;
    for (const poly of polys(g)) out.waters.push({ poly, tags: { natural: "water", water: cls || sub, overtureSubtype: sub } });
  }
  for (const f of X.infrastructure) {
    const [sub, cls, , , g] = f;
    if (cls === "runway" || cls === "taxiway") {
      for (const pts of lines(g)) out.roads.push({ cls: cls === "runway" ? 17 : 18, tags: {}, pts });
      for (const poly of polys(g)) out.paved.push(poly);
    } else if (cls === "apron" || cls === "helipad") for (const poly of polys(g)) out.paved.push(poly);
    else if (/pier|breakwater|dock|groyne|quay/.test(cls || "")) {
      for (const poly of polys(g)) out.decks.push(poly);
      for (const pts of lines(g)) out.roads.push({ cls: 9, tags: { width: "6" }, pts });       // a pier mapped as a line: a walkable deck
    }
  }
  out.landUse = X.land_use;
  console.log("  overture: " + out.buildings.length + " buildings/parts " + JSON.stringify(out.counts.datasets) + " · roofs " + JSON.stringify(out.counts.roofs) + " · " + out.roads.length + " road/rail lines · " + out.waters.length + " water · " + out.paved.length + " paved · " + out.decks.length + " decks");
  return out;
}

async function build(R) {
  console.log("== " + R.id + " · " + R.name);
  const dir = join(OUT, R.id);
  if (existsSync(join(dir, "t"))) rmSync(join(dir, "t"), { recursive: true });
  mkdirSync(join(dir, "t"), { recursive: true });
  // Imagery attached after the build (scripts/earth/attach-imagery.mjs) survives a rebuild.
  let old = null;
  try { old = existsSync(join(dir, "meta.json")) ? JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) : null; } catch (e) { console.log("  (previous meta.json unreadable: " + e.message + ")"); }
  const meta = { id: R.id, name: R.name, bbox: R.bbox, built: new Date().toISOString().slice(0, 10), dem: [], imagery: [], tiles: {}, places: [], exclude: R.exclude || [], stats: {} };
  const attached = old ? (old.imagery || []).filter((im) => im.attached) : [];

  // Map data first: tidal water is burned into the elevation below.
  const ov = R.source === "overture" ? await overtureFeatures(R) : null;
  const els = ov || R.source === "dem-only" ? [] : await osmExtract(R);
  const buildings = ov ? ov.buildings : [], parts = [], roads = ov ? ov.roads : [], waters = ov ? ov.waters : [];
  for (const el of els) {
    const t = el.tags || {};
    if (t["building:part"] && t["building:part"] !== "no") { for (const p of polysOf(el)) parts.push({ poly: p, tags: t }); continue; }
    if (t.building && t.building !== "no") { for (const p of polysOf(el)) buildings.push({ poly: p, tags: t }); continue; }
    if (t.natural === "water" || t.waterway === "riverbank" || t.landuse === "reservoir") { for (const p of polysOf(el)) waters.push({ poly: p, tags: t }); continue; }
    if (el.type === "way" && el.geometry) { const c = roadClass(t); if (c >= 0) roads.push({ cls: c, tags: t, pts: el.geometry.map((p) => [p.lat, p.lon]) }); }
  }
  // Outlines that have parts are drawn as their parts (the 3D-building convention).
  const grid = new Map(), gk = (la, lo) => Math.floor(la / 0.002) + ":" + Math.floor(lo / 0.002);
  for (const p of parts) { const c = centroid(p.poly[0]); const k = gk(...c); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(c); }
  let skipped = 0;
  const kept = buildings.filter((bd) => {
    const ring = bd.poly[0];
    let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity;
    for (const p of ring) { s = Math.min(s, p[0]); n = Math.max(n, p[0]); w = Math.min(w, p[1]); e = Math.max(e, p[1]); }
    for (let la = Math.floor(s / 0.002); la <= Math.floor(n / 0.002); la++) for (let lo = Math.floor(w / 0.002); lo <= Math.floor(e / 0.002); lo++) {
      for (const c of grid.get(la + ":" + lo) || []) if (pointInRing(c, ring)) { skipped++; return false; }
    }
    return true;
  });
  const allB = kept.concat(parts);

  // Elevation.
  const scaleFor = (g) => { let m = 1; for (const v of g.data) if (Number.isFinite(v) && v > -9999) m = Math.max(m, Math.abs(v)); return Math.max(0.1, Math.ceil(m / 32000 * 10) / 10); };
  const tidal = [], lakes = [];
  const grids = [];
  for (const d of R.dem) {
    const g = d.source === "3dep" ? await dem3dep(d.bbox, d.arcsec) : await demCopernicus(d.bbox, d.arcsec);
    for (let i = 0; i < g.data.length; i++) if (g.nodata !== null && g.data[i] <= g.nodata + 1) g.data[i] = NaN;
    grids.push({ d, g });
  }
  // Water polygons: tidal (at sea level → burned in) or lakes (drawn as a surface).
  const finest = grids[grids.length - 1];
  for (const w of waters) {
    const ring = w.poly[0], probe = ring.filter((_, i) => i % Math.max(1, Math.floor(ring.length / 24)) === 0);
    const hs = probe.map((p) => { for (let k = grids.length - 1; k >= 0; k--) { const G = grids[k], b = G.d.bbox; if (p[0] > b.south && p[0] < b.north && p[1] > b.west && p[1] < b.east) return sampleGrid(G.g, b, p[0], p[1]); } return NaN; }).filter(Number.isFinite).sort((a, c) => a - c);
    const med = hs.length ? hs[Math.floor(hs.length / 2)] : NaN, low = hs.length ? hs[0] : NaN;
    // Sea level: low shores, or the sea itself (ocean, sea, bay, strait), or a
    // large water body whose shore reaches sea level (Sydney's Port Jackson is
    // mostly cliffs: its median shore is high, but it is the sea).
    const t = w.tags || {}, seaClass = t.overtureSubtype === "ocean" || /^(sea|bay|strait|sound|ocean|lagoon)$/.test(t.water || "");
    if (Number.isFinite(med) && (med < 2.5 || seaClass || (low < 1 && areaM2(ring) > 5e5))) tidal.push(w.poly); else if (Number.isFinite(med)) lakes.push(w.poly);
  }
  for (const { d, g } of grids) {
    let burned = 0;
    // Tidal water at sea level. The 30 m elevation over a river between
    // embankments (the Thames) often reads several metres; only cells above
    // 12 m are spared (cliffs where a coastline polygon is generalised).
    burn(g.data, g.W, g.H, d.bbox, tidal, (i) => { if (!(g.data[i] > 12)) { g.data[i] = -1.5; burned++; } });
    // Inland water (rivers above sea level, lakes): the renderer draws each
    // tile's piece flat at the lowest ground on its outline, so the channel
    // is carved 0.5 m below that level (a flat bed: enough, and no dark walls) — otherwise the 30 m elevation, noisy
    // over a narrow river, covers the water (the Buriganga, the Nile in Cairo).
    let carved = 0;
    for (const poly of lakes) {
      let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity;
      for (const p of poly[0]) { s = Math.min(s, p[0]); n = Math.max(n, p[0]); w = Math.min(w, p[1]); e = Math.max(e, p[1]); }
      if (n <= R.bbox.south || s >= R.bbox.north || e <= R.bbox.west || w >= R.bbox.east) continue;
      const [iy0, ix0] = tileOf(Math.max(s, R.bbox.south), Math.max(w, R.bbox.west)), [iy1, ix1] = tileOf(Math.min(n, R.bbox.north - 1e-9), Math.min(e, R.bbox.east - 1e-9));
      for (let iy = iy0; iy <= iy1; iy++) for (let ix = ix0; ix <= ix1; ix++) {
        const tb = { south: iy * TILE_DEG - 90, west: ix * TILE_DEG - 180 }; tb.north = tb.south + TILE_DEG; tb.east = tb.west + TILE_DEG;
        const rings = poly.map((r) => clipRing(r, tb));
        if (!rings[0] || rings[0].length < 3) continue;
        let hmin = Infinity;
        for (const p of rings[0]) { const v = sampleGrid(g, d.bbox, p[0], p[1]); if (Number.isFinite(v)) hmin = Math.min(hmin, v); }
        if (!Number.isFinite(hmin)) continue;
        burn(g.data, g.W, g.H, d.bbox, [rings.filter((r) => r.length >= 3)], (i) => { if (g.data[i] > hmin - 0.5) { g.data[i] = hmin - 0.5; carved++; } });
      }
    }
    if (carved) console.log("  inland water channels carved: " + carved + " cells");
    const scale = scaleFor(g);
    const file = "dem-" + d.name + ".i16.gz";
    const bytes = writeGrid(join(dir, file), g, scale);
    meta.dem.push({ file, width: g.W, height: g.H, scale, bounds: d.bbox, arcsec: d.arcsec, source: d.source === "3dep" ? "USGS 3DEP bare-earth DEM (1/3 arc-second sources)" : "Copernicus DEM GLO-30", burnedWaterCells: burned, bytes });
    console.log("  dem " + d.name + " " + g.W + "×" + g.H + " @" + (d.arcsec * 30.9).toFixed(0) + " m · " + (bytes / 1048576).toFixed(2) + " MB · water cells " + burned);
  }
  void finest;

  // Imagery.
  for (const im of R.imagery) {
    const file = "img-" + im.name + ".jpg";
    const r = im.source === "naip" ? await imgNaip(im.bbox, im.px, join(dir, file)) : await imgBmng(im.bbox, join(dir, file));
    meta.imagery.push({ file, width: r.W, height: r.H, bounds: r.served || im.bbox, source: im.source === "naip" ? "USDA NAIP via USGS The National Map" : "NASA Blue Marble Next Generation (July 2004, 500 m)", bytes: r.bytes });
    console.log("  imagery " + im.name + " " + r.W + "×" + r.H + " · " + (r.bytes / 1048576).toFixed(2) + " MB");
  }
  for (const im of attached) if (existsSync(join(dir, im.file))) { meta.imagery.push(im); console.log("  imagery " + im.file + " (attached, kept)"); }
  for (const d of old ? (old.dem || []).filter((x) => x.attached) : []) if (existsSync(join(dir, d.file))) { meta.dem.push(d); console.log("  dem " + d.file + " (attached, kept)"); }

  // Tiles.
  const tiles = new Map();
  const T = (iy, ix) => { const k = tileKey(iy, ix); if (!tiles.has(k)) tiles.set(k, { iy, ix, buildings: [], roads: [], water: [] }); return tiles.get(k); };
  const inBox = (p) => p[0] > R.bbox.south && p[0] < R.bbox.north && p[1] > R.bbox.west && p[1] < R.bbox.east;
  const heightSrc = [0, 0, 0, 0, 0];
  for (const bd of allB) {
    const c = centroid(bd.poly[0]);
    if (!inBox(c)) continue;
    const A = areaM2(bd.poly[0]);
    const h = bd.hinfo || heightOf(bd.tags, A);
    // Tiny footprints are noise, except a mapped spire or mast (Burj Khalifa's
    // top part is 0.95 m² and 828 m tall).
    if ((A < 4 && !((h.src === 0 || h.src === PUBLISHED) && h.h > 30)) || A > 2e6) continue;
    heightSrc[h.src]++;
    T(...tileOf(c[0], c[1])).buildings.push({ cls: h.cls, src: h.src, h: h.h, minH: h.minH, roof: h.roof || 0, roofH: h.roofH || 0, ds: h.ds ?? 0, rings: bd.poly });
  }
  for (const rd of roads) {
    // Densify to ≤ 100 m, then cut into per-tile pieces (sharing their end points).
    const pts = [];
    for (let i = 0; i < rd.pts.length - 1; i++) {
      const [a0, o0] = rd.pts[i], [a1, o1] = rd.pts[i + 1];
      const n = Math.max(1, Math.ceil(Math.hypot((a1 - a0) * 111320, (o1 - o0) * 111320 * Math.cos(a0 * D2R)) / 100));
      for (let k = 0; k < n; k++) pts.push([a0 + (a1 - a0) * k / n, o0 + (o1 - o0) * k / n]);
    }
    pts.push(rd.pts[rd.pts.length - 1]);
    let cur = null, curKey = null;
    for (let i = 0; i < pts.length - 1; i++) {
      const mid = [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2];
      if (!inBox(mid)) { cur = null; curKey = null; continue; }
      const [iy, ix] = tileOf(...mid), k = tileKey(iy, ix);
      if (k !== curKey) { cur = { cls: rd.cls, flags: rd.tags.bridge && rd.tags.bridge !== "no" ? 1 : 0, width: num(rd.tags.width) || 0, pts: [pts[i]] }; T(iy, ix).roads.push(cur); curKey = k; }
      cur.pts.push(pts[i + 1]);
    }
  }
  const areaLists = [[lakes, 1]].concat(ov ? [[ov.paved, 2], [ov.decks, 3]] : []);
  for (const [list, kind] of areaLists) for (const poly of list) {
    let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity;
    for (const p of poly[0]) { s = Math.min(s, p[0]); n = Math.max(n, p[0]); w = Math.min(w, p[1]); e = Math.max(e, p[1]); }
    // Only the tiles inside the region (a sea or river polygon can reach far beyond it).
    const [iy0, ix0] = tileOf(Math.max(s, R.bbox.south), Math.max(w, R.bbox.west)), [iy1, ix1] = tileOf(Math.min(n, R.bbox.north - 1e-9), Math.min(e, R.bbox.east - 1e-9));
    for (let iy = iy0; iy <= iy1; iy++) for (let ix = ix0; ix <= ix1; ix++) {
      const tb = { south: iy * TILE_DEG - 90, west: ix * TILE_DEG - 180 }; tb.north = tb.south + TILE_DEG; tb.east = tb.west + TILE_DEG;
      const rings = poly.map((r) => clipRing(r, tb)).filter((r, i) => i === 0 ? r.length : r.length);
      if (rings.length && rings[0].length >= 3) T(iy, ix).water.push({ kind, rings });
    }
  }
  let tileBytes = 0, nB = 0, nR = 0;
  for (const [k, t] of tiles) {
    if (!t.buildings.length && !t.roads.length && !t.water.length) continue;
    const gz = gzipSync(encodeTile(t.iy, t.ix, t, ov ? 2 : 1), { level: 9 });
    writeFileSync(join(dir, "t", k + ".bin.gz"), gz);
    meta.tiles[k] = gz.length;
    tileBytes += gz.length; nB += t.buildings.length; nR += t.roads.length;
  }
  // Named places (labels and search).
  const P = placesOf(els);
  const rank = (t) => t.aeroway ? 9 : t.place === "city" || t.place === "town" ? 8 : t.natural === "peak" ? 8 : t.tourism ? 7 : t.amenity ? 6 : t.railway ? 5 : t.leisure ? 5 : t.place ? 4 : 3;
  const seen = new Set();
  meta.places = P.map((p) => ({ name: p.tags.name, lat: p.lat ?? p.center?.lat, lon: p.lon ?? p.center?.lon, kind: p.tags.aeroway ? "Airport" : p.tags.natural === "peak" ? "Peak" : p.tags.place ? "Place" : p.tags.tourism ? "Attraction" : p.tags.amenity ? "Facility" : p.tags.railway ? "Station" : p.tags.leisure ? "Park" : p.tags.man_made ? "Tower" : "Building", r: rank(p.tags) }))
    .filter((p) => p.name && Number.isFinite(p.lat) && inBox([p.lat, p.lon]) && !seen.has(p.name) && seen.add(p.name))
    .sort((a, b) => b.r - a.r).slice(0, 300).map(({ r, ...p }) => p);
  meta.stats = { buildings: nB, outlinesReplacedByParts: skipped, heightSources: { tagged: heightSrc[0], fromLevels: heightSrc[1], estimated: heightSrc[2], publishedOverride: heightSrc[PUBLISHED] },
    landmarkOverrides: ov ? ov.overrides : [],
    roads: nR, lakes: lakes.length, tidalWaterPolygons: tidal.length, tiles: Object.keys(meta.tiles).length, tileBytes,
    roadClasses: Object.fromEntries(ROAD_CLASS.map((c, i) => [c, roads.filter((r) => r.cls === i).length]).filter((x) => x[1])) };
  // The vegetation pack (build-vegetation.mjs) is separate; keep its entry.
  if (old && old.veg && existsSync(join(dir, old.veg.file))) meta.veg = old.veg;
  writeFileSync(join(dir, "meta.json.tmp"), JSON.stringify(meta));
  renameSync(join(dir, "meta.json.tmp"), join(dir, "meta.json"));
  console.log("  " + nB + " buildings (" + heightSrc.join("/") + " tagged/levels/estimated), " + nR + " road pieces, " + lakes.length + " lakes · " +
    meta.stats.tiles + " tiles · " + (tileBytes / 1048576).toFixed(2) + " MB · " + meta.places.length + " places");
}

function writeIndex() {
  const regions = readdirSync(OUT).filter((d) => existsSync(join(OUT, d, "meta.json"))).map((d) => {
    const m = JSON.parse(readFileSync(join(OUT, d, "meta.json"), "utf8"));
    const bytes = readdirSync(join(OUT, d)).reduce((s, f) => s + (f === "t" ? readdirSync(join(OUT, d, "t")).reduce((a, g) => a + statSync(join(OUT, d, "t", g)).size, 0) : statSync(join(OUT, d, f)).size), 0);
    const RR = REGIONS.find((r) => r.id === m.id) || {};
    return { id: m.id, name: m.name, bbox: m.bbox, startup: !!RR.startup, source: RR.source || "osm", kind: RR.kind || "", bytes, buildings: m.stats.buildings,
      places: m.places.slice(0, 80) };          // the best-ranked places, for search before the pack loads
  });
  writeFileSync(join(OUT, "index.json"), JSON.stringify({ tileDeg: TILE_DEG, regions }, null, 1));
  console.log("index:", regions.map((r) => r.id + " " + (r.bytes / 1048576).toFixed(1) + " MB").join(", "));
}

const want = process.argv.slice(2);                 // ids, "all", or "index" (rewrite the index only)
const list = want.includes("index") ? [] : want.includes("all") || !want.length ? REGIONS : REGIONS.filter((r) => want.includes(r.id));
mkdirSync(OUT, { recursive: true });
for (const R of list) await build(R);
{ const { packRegionTiles } = await import("../pack-assets.mjs"); for (const R of list) packRegionTiles(R.id); }
writeIndex();
