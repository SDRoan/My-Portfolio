// Multi-resolution real terrain for the explorable bodies, from official
// public datasets (NASA PDS, USGS Astrogeology):
//
//   node scripts/planetary/build-terrain.mjs <body> [<body> …]   (or "all")
//
// For each body, on top of its whole-body grid (fetch-elevation.mjs, L0):
//   L1 tiles     global 15° tiles at the best affordable resolution, loaded
//                lazily near the camera — space/data/surfaces/tiles/<body>/
//   L2 patches   high-resolution windows over landmarks (loaded lazily)
//   imagery      the matching USGS global mosaic, same projection
// Every source is simple cylindrical, centred on 0° longitude, east
// positive, north up: checked from each file's own georeferencing before use
// (validateGeo), so heights and images line up by construction.
//
// Sampling is nearest-centre at each output cell (no averaging). Raw caches
// live outside the repository (os.tmpdir()); only the outputs are committed.

import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, statSync, unlinkSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openRanged } from "../lib/geotiff.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "space", "data", "surfaces");
const CACHE = join(tmpdir(), "open-planet-cache");
mkdirSync(CACHE, { recursive: true });
const USGS = "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/";
const PDS_MOLA = "https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/";
const PDS_LOLA = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/";
const RADIUS_KM = Object.fromEntries(JSON.parse(readFileSync(join(ROOT, "data", "astronomy", "solar-system.json"), "utf8")).bodies.map((b) => [b.id, b.eqRadiusKm || b.radiusKm]));

// ── sources: a common interface over raw PDS grids and USGS GeoTIFFs ──
// { W, H, lonLeft (deg at the left edge), bands, row(y) → Float64Array (full width, band 0 or all bands) }
async function rawPDS(url, W, H, little, dn) {
  const file = join(CACHE, url.split("/").pop());
  if (!existsSync(file)) {
    console.log("  downloading", url.split("/").pop());
    const r = await fetch(url); if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  }
  const buf = readFileSync(file);
  if (buf.length !== W * H * 2) throw new Error("unexpected size " + buf.length);
  return { W, H, lonLeft: 0, bands: 1, refRadius: null,
    async row(y) { const o = new Float64Array(W); for (let x = 0; x < W; x++) o[x] = (little ? buf.readInt16LE((y * W + x) * 2) : buf.readInt16BE((y * W + x) * 2)) * dn; return o; } };
}
async function tiff(file, dn = 1) {
  const t = await openRanged(USGS + file);
  const lonLeft = validateGeo(t, file);
  const cache = new Map();
  // Column 0 is at the central meridian − 180° (many USGS products for the
  // outer Solar System and some inner bodies are centred on 180°).
  return { W: t.W, H: t.H, lonLeft, bands: t.spp, refRadius: t.refRadius, nodata: t.nodata,
    async row(y) {
      if (cache.has(y)) return cache.get(y);
      const r = await t.row(y);
      for (let i = 0; i < r.length; i++) r[i] = t.nodata !== null && (r[i] === t.nodata || (t.bps === 32 && r[i] < -1e30)) ? NaN : r[i] * dn;
      if (cache.size > 64) cache.delete(cache.keys().next().value);
      cache.set(y, r);
      return r;
    } };
}
// Simple cylindrical, north edge at +90°, square pixels covering 360° — in
// metres on the body sphere or in degrees. Returns the longitude of the left
// edge, from the projection's central meridian and the tie point (most
// products start at central − 180°; some, like Rhea's, start at the origin).
function validateGeo(t, name) {
  const sx = t.scale[0], tieX = t.tie[3], tieY = t.tie[4];
  const deg = Math.abs(sx * t.W - 360) < 0.5;
  const R = deg ? null : sx * t.W / (2 * Math.PI);
  const okY = deg ? Math.abs(tieY - 90) < 0.01 : Math.abs(tieY - t.H * sx / 2) < sx * 1.5;
  const okH = Math.abs(t.H * 2 - t.W) <= 2;
  if (!okY || !okH) throw new Error("unexpected georeferencing for " + name + ": " + JSON.stringify({ sx, tieX, tieY, W: t.W, H: t.H }));
  const left = deg ? tieX : t.centralLon + tieX / (R * Math.PI / 180);
  const lonLeft = ((left + 540) % 360) - 180;
  validation.push(name + ": simple cylindrical, " + t.W + "×" + t.H + ", central meridian " + t.centralLon + "°, column 0 at " + lonLeft.toFixed(2) + "°, north edge 90°" + (R ? ", sphere " + (R / 1000).toFixed(1) + " km" : " (degrees)") + " ✓");
  return lonLeft;
}
const validation = [];

// Every `step`-th cell of rows y0…y1 (source rows), full width: a grid.
async function band(src, y0, y1, step) {
  const rows = [];
  for (let y = y0; y <= y1; y += step) rows.push(y);
  const W = Math.floor(src.W / step), data = new Float64Array(rows.length * W * src.bands);
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < rows.length) {
      const j = next++, r = await src.row(Math.min(src.H - 1, rows[j] + (step >> 1)));
      for (let x = 0; x < W; x++) for (let c = 0; c < src.bands; c++) data[(j * W + x) * src.bands + c] = r[Math.min(src.W - 1, x * step + (step >> 1)) * src.bands + c];
    }
  }));
  return { W, H: rows.length, data };
}

// ── encoding (same as fetch-elevation.mjs: int16 row-delta, gzip) ──
function encode(W, H, data, scale) {
  const buf = Buffer.alloc(W * H * 2);
  for (let y = 0; y < H; y++) {
    let prev = 0;
    for (let x = 0; x < W; x++) {
      const i = y * W + x, v0 = data[i];
      const v = Number.isFinite(v0) ? Math.max(-32767, Math.min(32767, Math.round(v0 / scale))) : -32768;
      buf.writeInt16LE(((v - prev) << 16) >> 16, i * 2);
      prev = v;
    }
  }
  return gzipSync(buf, { level: 9 });
}

// ── L1: global tiles ──
async function tiles(id, cfg) {
  const src = await cfg.source();
  const step = cfg.step, Wc = Math.floor(src.W / step), Hc = Math.floor(src.H / step);
  const cellDeg = 360 / Wc, T = cfg.tileDeg, n = Math.round(T / cellDeg);         // cells per tile edge
  const dir = join(OUT, "tiles", id);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  const off = cfg.offset || 0;
  const index = { tileDeg: T, cells: n, margin: 1, cellDeg, scale: cfg.scale, source: cfg.label, resolutionM: Math.round(cellDeg * Math.PI / 180 * RADIUS_KM[id] * 1000), tiles: {} };
  let total = 0, biggest = 0, mapped = 0, cells = 0;
  for (let ty = 0; ty < 180 / T; ty++) {
    // rows of this band plus one margin row each side (clamped at the poles)
    const r0 = Math.max(0, ty * n - 1), r1 = Math.min(Hc - 1, (ty + 1) * n);
    const g = await band(src, r0 * step, r1 * step + step - 1, step);
    for (let tx = 0; tx < 360 / T; tx++) {
      // columns west→east with wrap; source columns start at lonLeft
      const lonW = -180 + tx * T, c0 = Math.round(((lonW - src.lonLeft) % 360 + 360) % 360 / cellDeg) - 1;
      const w = n + 2, h = n + 2, data = new Float64Array(w * h);
      for (let j = 0; j < h; j++) {
        const rr = Math.min(g.H - 1, Math.max(0, ty * n - 1 + j - r0));
        for (let i = 0; i < w; i++) { const v = g.data[rr * g.W + (((c0 + i) % g.W) + g.W) % g.W]; data[j * w + i] = Number.isFinite(v) ? v + off : NaN; if (j && i && j < h - 1 && i < w - 1) { cells++; if (Number.isFinite(v)) mapped++; } }
      }
      if (!data.some(Number.isFinite)) continue;
      // Refuse to clip: the int16 range at this scale must hold the data.
      for (const v of data) if (Number.isFinite(v) && Math.abs(v / cfg.scale) > 32767) throw new Error(id + " tile " + ty + "_" + tx + ": " + v.toFixed(0) + " m exceeds the int16 range at scale " + cfg.scale);
      const gz = encode(w, h, data, cfg.scale);
      writeFileSync(join(dir, ty + "_" + tx + ".i16.gz"), gz);
      index.tiles[ty + "_" + tx] = gz.length; total += gz.length; biggest = Math.max(biggest, gz.length);
    }
    process.stdout.write("  " + id + " tiles band " + (ty + 1) + "/" + 180 / T + "\r");
  }
  index.bytes = total; index.largest = biggest; index.mappedFraction = +(mapped / cells).toFixed(4);
  writeFileSync(join(OUT, id + "-tiles.json"), JSON.stringify(index));
  console.log("\n  " + id + " L1: " + Object.keys(index.tiles).length + " tiles · " + index.resolutionM + " m cells · " + (total / 1048576).toFixed(1) + " MB · largest " + (biggest / 1024).toFixed(0) + " KB");
}

// ── L2: landmark windows ──
async function patch(id, p, srcCache) {
  const src = srcCache[p.src] || (srcCache[p.src] = await SOURCES[p.src]());
  const step = p.step || 1, cellDeg = 360 / src.W * step;
  // snap the box to source cells at this step
  const x0 = Math.floor(((p.box.west - src.lonLeft) % 360 + 360) % 360 / cellDeg), x1 = x0 + Math.round((p.box.east - p.box.west) / cellDeg) - 1;
  const y0 = Math.floor((90 - p.box.north) / cellDeg), y1 = Math.floor((90 - p.box.south) / cellDeg) - 1;
  const W = x1 - x0 + 1, H = y1 - y0 + 1, data = new Float64Array(W * H);
  const off = src.heightRef === "sphere" ? src.refRadius - RADIUS_KM[id] * 1000 : src.heightRef === "radius" ? -RADIUS_KM[id] * 1000 : 0;
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < H) {
      const j = next++, r = await src.row(Math.min(src.H - 1, (y0 + j) * step + (step >> 1)));
      for (let i = 0; i < W; i++) { const v = r[((((x0 + i) * step + (step >> 1)) % src.W) + src.W) % src.W]; data[j * W + i] = Number.isFinite(v) ? v + off : NaN; }
    }
  }));
  const bounds = { west: src.lonLeft + x0 * cellDeg, east: src.lonLeft + (x1 + 1) * cellDeg, north: 90 - y0 * cellDeg, south: 90 - (y1 + 1) * cellDeg };
  if (bounds.west >= 180) { bounds.west -= 360; bounds.east -= 360; }
  let m = 1; for (const v of data) if (Number.isFinite(v)) m = Math.max(m, Math.abs(v));
  const scale = m > 32000 ? Math.ceil(m / 32000) : m > 3200 ? 1 : 0.1;
  const gz = encode(W, H, data, scale);
  const file = id + "-" + p.name + "-elevation.i16.gz";
  writeFileSync(join(OUT, file), gz);
  const resolutionM = Math.round(cellDeg * Math.PI / 180 * RADIUS_KM[id] * 1000);
  writeFileSync(join(OUT, id + "-" + p.name + "-elevation.json"), JSON.stringify({ file, width: W, height: H, scale, bounds, lazy: true, source: p.label, resolutionM, bytes: gz.length }, null, 1));
  console.log("  " + id + " L2 " + p.name + " " + W + "×" + H + " @" + resolutionM + " m · " + (gz.length / 1048576).toFixed(2) + " MB");
}

// ── high-resolution regional packs (HiRISE / CTX stereo DTMs) ──
// Equirectangular DTMs in metres (latitude of true scale 0): sampled every
// `step` cells over an optional lat/lon crop. Gaps are filled from the
// coarser HRSC–MOLA blend and the DTM is feathered into it over `featherM`,
// so neither holes nor the pack's edge make a cliff. The vertical datum is
// checked against HRSC–MOLA (median difference over valid cells).
async function hiresPack(id, p) {
  const t = await openRanged(USGS + p.file), R = p.radius;
  const sx = t.scale[0], sy = t.scale[1], toDeg = 180 / Math.PI / R;
  const lonOf = (i) => t.centralLon + (t.tie[3] + (i + 0.5) * sx) * toDeg, latOf = (j) => (t.tie[4] - (j + 0.5) * sy) * toDeg;
  // Crop (cell indices) and output grid.
  const c = p.crop || {};
  const i0 = c.west !== undefined ? Math.max(0, Math.floor((c.west - t.centralLon) / toDeg / sx - t.tie[3] / sx)) : 0;
  const i1 = c.east !== undefined ? Math.min(t.W - 1, Math.floor((c.east - t.centralLon) / toDeg / sx - t.tie[3] / sx)) : t.W - 1;
  const j0 = c.north !== undefined ? Math.max(0, Math.floor((t.tie[4] - c.north / toDeg) / sy)) : 0;
  const j1 = c.south !== undefined ? Math.min(t.H - 1, Math.floor((t.tie[4] - c.south / toDeg) / sy)) : t.H - 1;
  const step = p.step, W = Math.floor((i1 - i0 + 1) / step), H = Math.floor((j1 - j0 + 1) / step);
  const data = new Float64Array(W * H).fill(NaN);
  let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < H) {
      const j = next++, row = await t.row(j0 + j * step + (step >> 1), i0, i0 + W * step - 1);
      for (let i = 0; i < W; i++) { const v = row[i * step + (step >> 1)]; data[j * W + i] = v > -1e30 && v !== t.nodata ? v : NaN; }
      if (j % 200 === 0) process.stdout.write("  " + p.name + " rows " + j + "/" + H + "\r");
    }
  }));
  // Edges of the output cells (degrees).
  const bounds = { west: lonOf(i0) - sx * toDeg / 2, east: lonOf(i0 + W * step - 1) + sx * toDeg / 2, north: latOf(j0) + sy * toDeg / 2, south: latOf(j0 + H * step - 1) - sy * toDeg / 2 };
  // Coarse reference (HRSC–MOLA 200 m) at every output cell, bilinear.
  const ref = await SOURCES.hrsc200(), rdeg = 360 / ref.W;
  const ry0 = Math.floor((90 - bounds.north) / rdeg) - 1, ry1 = Math.ceil((90 - bounds.south) / rdeg) + 1;
  const rows = new Map();
  for (let y = ry0; y <= ry1; y++) rows.set(y, await ref.row(y));
  const coarse = new Float64Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const lat = bounds.north - (j + 0.5) * (bounds.north - bounds.south) / H, lon = bounds.west + (i + 0.5) * (bounds.east - bounds.west) / W;
    const fy = (90 - lat) / rdeg - 0.5, fx = (lon + 180) / rdeg - 0.5, y0 = Math.floor(fy), x0 = Math.floor(fx), ty = fy - y0, tx = fx - x0;
    const a = rows.get(y0), b = rows.get(y0 + 1);
    coarse[j * W + i] = (a[x0] * (1 - tx) + a[x0 + 1] * tx) * (1 - ty) + (b[x0] * (1 - tx) + b[x0 + 1] * tx) * ty;
  }
  // Datum check.
  const diffs = [];
  for (let k = 0; k < data.length; k += 7) if (Number.isFinite(data[k]) && Number.isFinite(coarse[k])) diffs.push(data[k] - coarse[k]);
  diffs.sort((a, b) => a - b);
  const median = diffs[diffs.length >> 1], valid = data.reduce((s, v) => s + (Number.isFinite(v) ? 1 : 0), 0) / data.length;
  // Distance (m) to the nearest gap or edge: two-pass chamfer transform.
  const cell = (bounds.north - bounds.south) / H / toDeg, dist = new Float64Array(W * H);
  for (let k = 0; k < dist.length; k++) dist[k] = Number.isFinite(data[k]) ? 1e9 : 0;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) { const k = j * W + i; if (!i || !j || i === W - 1 || j === H - 1) dist[k] = Math.min(dist[k], cell); if (i) dist[k] = Math.min(dist[k], dist[k - 1] + cell); if (j) dist[k] = Math.min(dist[k], dist[k - W] + cell); }
  for (let j = H - 1; j >= 0; j--) for (let i = W - 1; i >= 0; i--) { const k = j * W + i; if (i < W - 1) dist[k] = Math.min(dist[k], dist[k + 1] + cell); if (j < H - 1) dist[k] = Math.min(dist[k], dist[k + W] + cell); }
  const out = new Float64Array(W * H);
  for (let k = 0; k < out.length; k++) {
    const w = Math.min(1, dist[k] / p.featherM), v = Number.isFinite(data[k]) ? data[k] - median : coarse[k];
    out[k] = coarse[k] + w * w * (3 - 2 * w) * (v - coarse[k]);
  }
  const gz = encode(W, H, out, 0.5);
  const file = id + "-" + p.name + "-elevation.i16.gz";
  writeFileSync(join(OUT, file), gz);
  const resolutionM = Math.round(cell);
  writeFileSync(join(OUT, id + "-" + p.name + "-elevation.json"), JSON.stringify({ file, width: W, height: H, scale: 0.5, bounds, lazy: true, source: p.label, resolutionM, bytes: gz.length,
    datumOffsetM: +median.toFixed(1), coverage: +valid.toFixed(3), note: "gaps filled from HRSC–MOLA 200 m; feathered over " + p.featherM + " m" }, null, 1));
  validation.push(p.file + ": equirectangular metres, central meridian " + t.centralLon + "°, " + W + "×" + H + " at " + resolutionM + " m; datum vs HRSC–MOLA median " + median.toFixed(1) + " m; DTM coverage " + (valid * 100).toFixed(0) + "% ✓");
  console.log("\n  " + id + " HI " + p.name + " " + W + "×" + H + " @" + resolutionM + " m · " + (gz.length / 1048576).toFixed(2) + " MB · datum offset " + median.toFixed(1) + " m · coverage " + (valid * 100).toFixed(0) + "%");
}

// ── imagery: a global mosaic at a target width, as JPEG (via cjpeg) ──
// A local file (an archive the build unpacked), read whole: column 0 at −180°.
async function localTiff(path) {
  const { readTiff } = await import("../lib/geotiff.mjs");
  const t = readTiff(readFileSync(path));
  return { W: t.W, H: t.H, lonLeft: t.geo.tie ? t.geo.tie[3] : -180, bands: 1, async row(y) { return Float64Array.from(t.data.subarray(y * t.W, (y + 1) * t.W)); } };
}
async function imagery(id, im) {
  const src = im.zip ? await (async () => {
    // USGS distributes some mosaics only inside a zip (Mimas: Cassini/DLR).
    const zf = join(CACHE, id + ".zip"), out = join(CACHE, id + "-" + im.member.split("/").pop());
    if (!existsSync(zf)) writeFileSync(zf, Buffer.from(await (await fetch(USGS + im.zip)).arrayBuffer()));
    if (!existsSync(out)) writeFileSync(out, execFileSync("unzip", ["-p", zf, im.member], { maxBuffer: 1 << 30 }));
    validation.push(im.zip + " → " + im.member + ": geographic degrees, column 0 at −180° (Herschel checked at the Gazetteer position) ✓");
    return localTiff(out);
  })() : await tiff(im.file);
  const step = Math.max(1, Math.round(src.W / im.width)), g = await band(src, 0, src.H - 1, step);
  const grey = src.bands === 1, nb = grey ? 1 : 3, out = Buffer.alloc(g.W * g.H * nb);
  // Rotate so the output's column 0 is at −180° (the simulator's convention).
  const rot = Math.round((src.lonLeft + 180) / 360 * g.W);
  for (let y = 0; y < g.H; y++) for (let x = 0; x < g.W; x++) {
    const xo = (x + rot) % g.W, i = y * g.W + x;
    for (let c = 0; c < nb; c++) { const v = g.data[i * src.bands + c]; out[(y * g.W + xo) * nb + c] = Number.isFinite(v) ? Math.max(0, Math.min(255, v)) : 0; }
  }
  const pnm = join(CACHE, id + (grey ? ".pgm" : ".ppm"));
  writeFileSync(pnm, Buffer.concat([Buffer.from((grey ? "P5" : "P6") + "\n" + g.W + " " + g.H + "\n255\n"), out]));
  const file = id + "_usgs.jpg";
  execFileSync("cjpeg", ["-quality", "85", ...(grey ? ["-grayscale"] : []), "-outfile", join(ROOT, "textures", file), pnm]);
  unlinkSync(pnm);
  const bytes = statSync(join(ROOT, "textures", file)).size;
  writeFileSync(join(OUT, id + "-imagery.json"), JSON.stringify({ file, width: g.W, height: g.H, grey, source: im.label, surfaceOnly: !!im.surfaceOnly, resolutionM: Math.round(360 / g.W * Math.PI / 180 * RADIUS_KM[id] * 1000), fill: !!im.fill, bytes }, null, 1));
  console.log("  " + id + " imagery " + g.W + "×" + g.H + (grey ? " grey" : " colour") + " · " + (bytes / 1048576).toFixed(2) + " MB");
}

// ── sources ──
const SOURCES = {
  meg32: async () => rawPDS(PDS_MOLA + "meg032/megt90n000fb.img", 11520, 5760, false, 1),
  mola463: async () => tiff("Mars_MGS_MOLA_DEM_mosaic_global_463m.tif"),
  hrsc200: async () => tiff("Mars/HRSC_MOLA_Blend/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif"),
  ldem16: async () => rawPDS(PDS_LOLA + "ldem_16.img", 5760, 2880, true, 0.5),
  lola118: async () => tiff("Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif", 0.5),
  merc665: async () => Object.assign(await tiff("Mercury_Messenger_USGS_DEM_Global_665m_v2.tif"), { heightRef: "sphere" }),
  venus4641: async () => Object.assign(await tiff("Venus_Magellan_Topography_Global_4641m_v02.tif"), { heightRef: "sphere" }),
  ceres60: async () => Object.assign(await tiff("Ceres_Dawn_FC_HAMO_DTM_DLR_Global_60ppd_Oct2016.tif"), { heightRef: "sphere" }),
  vesta48: async () => Object.assign(await tiff("Vesta_Dawn_HAMO_DTM_DLR_Global_48ppd.tif"), { heightRef: "radius" }),
  pluto300: async () => Object.assign(await tiff("Pluto_NewHorizons_Global_DEM_300m_Jul2017_16bit.tif"), { heightRef: "sphere" }),
  charon300: async () => Object.assign(await tiff("Charon_NewHorizons_Global_DEM_300m_Jul2017_16bit.tif"), { heightRef: "sphere" })
};

const BODIES = {
  mars: {
    tiles: { source: SOURCES.meg32, step: 1, tileDeg: 15, scale: 1, label: "MGS MOLA MEGDR 32 px/deg (PDS)" },
    patches: [
      { name: "olympus", src: "mola463", box: { south: 12, north: 25.5, west: -141, east: -126 }, label: "MGS MOLA 463 m (USGS)" },
      { name: "olympus-caldera", src: "hrsc200", box: { south: 17.5, north: 19.8, west: -135, east: -132.4 }, label: "HRSC–MOLA blend 200 m (USGS/DLR)" },
      { name: "valles", src: "mola463", step: 2, box: { south: -18, north: -2, west: -95, east: -40 }, label: "MGS MOLA 463 m, every 2nd cell (USGS)" },
      { name: "noctis", src: "mola463", box: { south: -12, north: -3, west: -106, east: -95 }, label: "MGS MOLA 463 m (USGS)" },
      { name: "elysium", src: "mola463", box: { south: 21, north: 28.5, west: 142, east: 150 }, label: "MGS MOLA 463 m (USGS)" },
      { name: "gale", src: "hrsc200", box: { south: -6.6, north: -4.2, west: 136.4, east: 139 }, label: "HRSC–MOLA blend 200 m (USGS/DLR)" },
      { name: "jezero", src: "hrsc200", box: { south: 17.2, north: 19.6, west: 76.4, east: 79 }, label: "HRSC–MOLA blend 200 m (USGS/DLR)" },
      // Wider 200 m windows over the remaining showcase sites.
      { name: "valles-hrsc", src: "hrsc200", step: 2, box: { south: -11, north: -3, west: -78, east: -62 }, label: "HRSC–MOLA blend 200 m, every 2nd cell (USGS/DLR)" },
      { name: "noctis-hrsc", src: "hrsc200", step: 2, box: { south: -10, north: -3, west: -104, east: -96 }, label: "HRSC–MOLA blend 200 m, every 2nd cell (USGS/DLR)" },
      { name: "elysium-hrsc", src: "hrsc200", step: 2, box: { south: 22, north: 28, west: 144, east: 150 }, label: "HRSC–MOLA blend 200 m, every 2nd cell (USGS/DLR)" }
    ],
    // High-resolution stereo DTMs (public domain, USGS Astrogeology).
    hires: [
      { name: "gale-hirise", file: "MSL_Gale_DEM_Mosaic_1m_v3.tif", radius: 3396190, step: 25, featherM: 800,
        label: "MSL Gale HiRISE DEM mosaic 1 m, sampled at 25 m (USGS)" },
      { name: "jezero-ctx", file: "mars2020_landing_site_dtm/J03_045994_1986_J03_046060_1986_20m_DTM.tif", radius: 3396190, step: 1, featherM: 1000,
        crop: { south: 17.95, north: 18.9 }, label: "Mars 2020 landing-site CTX stereo DTM 20 m (USGS)" }
    ],
    imagery: { file: "Mars_Viking_ClrMosaic_global_925m.tif", width: 4096, label: "Viking MDIM colour mosaic 925 m (USGS)" }
  },
  moon: {
    tiles: { source: SOURCES.ldem16, step: 1, tileDeg: 15, scale: 0.5, label: "LRO LOLA LDEM_16 (PDS)" },
    patches: [
      { name: "tycho-118", src: "lola118", box: { south: -45.2, north: -41.4, west: -14, east: -8.7 }, label: "LRO LOLA 118 m (USGS)" },
      { name: "copernicus-118", src: "lola118", box: { south: 8, north: 11.3, west: -22, east: -18.2 }, label: "LRO LOLA 118 m (USGS)" },
      { name: "apollo11-118", src: "lola118", box: { south: 0.1, north: 1.25, west: 22.9, east: 24.1 }, label: "LRO LOLA 118 m (USGS)" },
      { name: "apollo17-118", src: "lola118", box: { south: 19.6, north: 20.8, west: 30.1, east: 31.4 }, label: "LRO LOLA 118 m (USGS)" }
    ],
    imagery: { file: "Lunar_LRO_LROC-WAC_Mosaic_global_100m_June2013.tif", width: 4096, label: "LRO LROC WAC mosaic 100 m (USGS)" }
  },
  mercury: {
    tiles: { source: SOURCES.merc665, step: 8, tileDeg: 15, scale: 1, label: "MESSENGER DEM 665 m, every 8th cell (USGS)" },
    patches: [
      // Caloris Planitia: IAU centre 31.65° N, 161.99° E, 1500 km across.
      { name: "caloris", src: "merc665", step: 2, box: { south: 12, north: 52, west: 138, east: 180 }, label: "MESSENGER DEM 665 m, every 2nd cell (USGS)" },
      { name: "rembrandt", src: "merc665", step: 2, box: { south: -41, north: -25, west: 79, east: 97 }, label: "MESSENGER DEM 665 m, every 2nd cell (USGS)" },
      { name: "rachmaninoff", src: "merc665", box: { south: 23, north: 32, west: 52, east: 63 }, label: "MESSENGER DEM 665 m (USGS)" }
    ],
    // Monochrome (the enhanced-colour basemap is false colour, not what Mercury looks like).
    imagery: { file: "Mercury_MESSENGER_mosaic_global_250m_2013.tif", width: 4096, label: "MESSENGER MDIS global monochrome mosaic 250 m (USGS)" }
  },
  venus: {
    tiles: { source: SOURCES.venus4641, step: 2, tileDeg: 15, scale: 1, label: "Magellan topography 4641 m, every 2nd cell (USGS)" },
    patches: [
      { name: "maxwell", src: "venus4641", box: { south: 58, north: 72, west: -10, east: 20 }, label: "Magellan topography 4641 m (USGS)" },
      { name: "atalanta", src: "venus4641", box: { south: 35, north: 65, west: 140, east: 180 }, label: "Magellan topography 4641 m (USGS)" }
    ],
    // Radar backscatter (the surface itself, seen through the clouds).
    imagery: { file: "Venus_Magellan_C3-MDIR_Global_Mosaic_2025m.tif", width: 4096, label: "Magellan C3-MDIR radar mosaic 2025 m (USGS)", surfaceOnly: true }
  },
  ceres: {
    tiles: { source: SOURCES.ceres60, step: 6, tileDeg: 15, scale: 1, label: "Dawn HAMO DTM 60 px/deg, every 6th cell (DLR/USGS)" },
    patches: [
      { name: "occator", src: "ceres60", box: { south: 13, north: 27, west: -128, east: -113 }, label: "Dawn HAMO DTM 137 m (DLR/USGS)" },
      { name: "ahuna", src: "ceres60", box: { south: -13.5, north: -7.5, west: -47, east: -40.5 }, label: "Dawn HAMO DTM 137 m (DLR/USGS)" }
    ],
    imagery: { file: "Ceres_Dawn_FC_DLR_global_20ppd_Oct2015.tif", width: 4096, label: "Dawn FC global mosaic 20 px/deg (DLR/USGS)" }
  },
  vesta: {
    tiles: { source: SOURCES.vesta48, step: 6, tileDeg: 15, scale: 2, label: "Dawn HAMO DTM 48 px/deg, every 6th cell (DLR/USGS)" },
    imagery: { file: "Vesta_Dawn_FC_HAMO_Mosaic_Global_74ppd.tif", width: 4096, label: "Dawn FC HAMO mosaic 74 px/deg (USGS)" }
  },
  pluto: {
    tiles: { source: SOURCES.pluto300, step: 8, tileDeg: 15, scale: 1, label: "New Horizons DEM 300 m, every 8th cell (USGS) — encounter hemisphere" },
    // Sputnik Planitia: IAU centre 19.51° N, 178.69° E — straddles 180°.
    patches: [{ name: "sputnik-w", src: "pluto300", step: 2, box: { south: -10, north: 45, west: 155, east: 180 }, label: "New Horizons DEM 300 m, every 2nd cell (USGS)" },
      { name: "sputnik-e", src: "pluto300", step: 2, box: { south: -10, north: 45, west: -180, east: -158 }, label: "New Horizons DEM 300 m, every 2nd cell (USGS)" }]
  },
  charon: { tiles: { source: SOURCES.charon300, step: 4, tileDeg: 15, scale: 1, label: "New Horizons DEM 300 m, every 4th cell (USGS) — encounter hemisphere" } },
  // Imagery-only bodies (no global DEM published): real map, real shape.
  io: { imagery: { file: "Io_GalileoSSI-Voyager_Global_Mosaic_ClrMerge_1km.tif", width: 4096, label: "Galileo SSI / Voyager colour-merge mosaic 1 km (USGS)" } },
  europa: { imagery: { file: "Europa_Voyager_GalileoSSI_global_mosaic_500m.tif", width: 4096, label: "Voyager / Galileo SSI mosaic 500 m (USGS)" } },
  ganymede: { imagery: { file: "Ganymede_Voyager_GalileoSSI_Global_ClrMosaic_1435m.tif", width: 4096, label: "Voyager / Galileo SSI colour mosaic 1435 m (USGS)" } },
  callisto: { imagery: { file: "Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif", width: 4096, label: "Voyager / Galileo SSI mosaic 1 km (USGS)" } },
  titan: { imagery: { file: "Titan_ISS_P19658_Mosaic_Global_4km.tif", width: 4040, label: "Cassini ISS 938 nm mosaic 4 km (USGS)" } },
  enceladus: { imagery: { file: "Enceladus_Cassini_ISS_Global_Mosaic_100m_HPF.tif", width: 4096, label: "Cassini ISS mosaic 100 m (USGS)" } },
  tethys: { imagery: { file: "Tethys_Cassini_mosaic_global_293m.tif", width: 4096, label: "Cassini ISS mosaic 293 m (USGS)" } },
  dione: { imagery: { file: "Dione_Cassini_Voyager_mosaic_global_154m.tif", width: 4096, label: "Cassini / Voyager mosaic 154 m (USGS)" } },
  rhea: { imagery: { file: "Rhea_Cassini_Voyager_mosaic_global_417m.tif", width: 4096, label: "Cassini / Voyager mosaic 417 m (USGS)" } },
  iapetus: { imagery: { file: "Iapetus_Cassini_Voyager_mosaic_global_783m.tif", width: 4096, label: "Cassini / Voyager mosaic 783 m (USGS)" } },
  triton: { imagery: { file: "Triton_Voyager2_ClrMosaic_GlobalFill_600m.tif", width: 4096, label: "Voyager 2 colour mosaic 600 m, unimaged areas filled by USGS (USGS)" } },
  mimas: { imagery: { zip: "Mimas/Cassini_DLR_Mimas.zip", member: "Cassini_DLR/MI_170630_DLR_basemap_degrees.tif", width: 4096, label: "Cassini ISS global basemap (DLR, via USGS), 16 px/deg" } },
  phobos: { imagery: { file: "Phobos_ME_SRC_Mosaic_Global_16ppd.tif", width: 2880, label: "Mars Express SRC mosaic 16 px/deg (USGS/DLR)" } }
};

// Flags: --imagery-only; --only=<patch or hi-res pack names, comma-separated>
// builds just those (no tiles, no imagery).
const args = process.argv.slice(2), imageryOnly = args.includes("--imagery-only");
const onlyArg = args.find((a) => a.startsWith("--only=")), only = onlyArg ? new Set(onlyArg.slice(7).split(",")) : null;
const want = args.filter((a) => !a.startsWith("--"));
const list = want.includes("all") || !want.length ? Object.keys(BODIES) : want;
for (const id of list) {
  const B = BODIES[id];
  if (!B) { console.warn("unknown body", id); continue; }
  console.log("== " + id);
  const srcCache = {};
  if (B.tiles && !imageryOnly && !only) {
    const s = await B.tiles.source();
    B.tiles.offset = s.heightRef === "sphere" ? s.refRadius - RADIUS_KM[id] * 1000 : s.heightRef === "radius" ? -RADIUS_KM[id] * 1000 : 0;
    B.tiles.source = async () => s;
    await tiles(id, B.tiles);
  }
  if (!imageryOnly) for (const p of B.patches || []) if (!only || only.has(p.name)) await patch(id, p, srcCache);
  if (!imageryOnly) for (const p of B.hires || []) if (!only || only.has(p.name)) await hiresPack(id, p);
  if (B.imagery && !only) await imagery(id, B.imagery);
}
// Pack: H2D1 grids, 2 × 2 tile bundles (scripts/pack-assets.mjs).
{
  const { packSurfaceGrids, packPlanetTiles } = await import("../pack-assets.mjs");
  packSurfaceGrids();
  for (const id of list) packPlanetTiles(id);
}
writeFileSync(join(OUT, "validation.txt"), validation.join("\n") + "\n", { flag: "a" });
console.log(validation.join("\n"));
