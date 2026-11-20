// Real global elevation for Earth, the Moon and Mars, reduced to compact
// grids the simulator streams when you approach each body.
//
//   node scripts/planetary/fetch-elevation.mjs [earth|moon|mars ...]
//
// Sources (all public domain — US Government works):
//   Earth  NOAA NCEI ETOPO 2022 (60 arc-second, surface elevation incl. ice
//          and bathymetry), read through NCEI's OPeNDAP server with a stride
//          of 10 → 1/6° = 10 arc-minutes (2160 × 1080), each sample taken at
//          the middle of its 10 × 10 block so it sits on the 10′ cell centre. https://www.ncei.noaa.gov/products/etopo-global-relief-model
//   Moon   LRO LOLA LDEM_4 (4 px/deg), NASA PDS Geosciences Node.
//   Mars   MGS MOLA MEGDR megt90n000cb (4 px/deg), NASA PDS Geosciences Node.
//
// Output, one per body: space/data/surfaces/<id>-elevation.i16.gz
//   little-endian Int16, row-delta encoded (each value is the difference from
//   its western neighbour); heights in metres × scale; rows from the north
//   pole down, columns from longitude −180° eastward.
// The raw downloads are not kept in the repository.

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "space", "data", "surfaces");
mkdirSync(OUT, { recursive: true });

async function fetchBuf(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(300000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { if (i === tries - 1) throw e; console.warn("retry", url, e.message); }
  }
}
function save(id, w, h, heights, scale, meta) {
  // Delta-encoded along each row (value minus its western neighbour), which
  // gzip compresses far better than raw heights; the browser undoes it.
  const buf = Buffer.alloc(w * h * 2);
  let lo = Infinity, hi = -Infinity;
  for (let y = 0; y < h; y++) {
    let prev = 0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const v = Math.max(-32767, Math.min(32767, Math.round(heights[i] / scale)));
      buf.writeInt16LE(((v - prev) << 16) >> 16, i * 2);
      prev = v;
      lo = Math.min(lo, v * scale); hi = Math.max(hi, v * scale);
    }
  }
  const gz = gzipSync(buf, { level: 9 });
  writeFileSync(join(OUT, id + "-elevation.i16.gz"), gz);
  const info = { file: id + "-elevation.i16.gz", width: w, height: h, scale, encoding: "int16le-row-delta", minM: lo, maxM: hi, bytes: gz.length, ...meta };
  writeFileSync(join(OUT, id + "-elevation.json"), JSON.stringify(info, null, 2));
  console.log(id, w + "×" + h, "range", lo.toFixed(0), "…", hi.toFixed(0), "m,", (gz.length / 1048576).toFixed(2), "MB");
}

// ── range reads, for files far too large to download whole ──
async function fetchRange(url, a, b, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { Range: "bytes=" + a + "-" + b }, signal: AbortSignal.timeout(120000) });
      if (r.status !== 206 && r.status !== 200) throw new Error("HTTP " + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      return r.status === 200 ? buf.subarray(a, b + 1) : buf;
    } catch (e) { if (i === tries - 1) throw e; await new Promise((res) => setTimeout(res, 2000 * (i + 1))); }
  }
}
async function pmap(list, n, fn) {
  const out = new Array(list.length); let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (next < list.length) { const i = next++; out[i] = await fn(list[i], i); } }));
  return out;
}
// A window of a raw row-major grid (PDS IMG): rows y0…y1, columns x0…x1
// (columns may wrap past the edge), every `step`-th sample.
async function rawWindow(url, { W, bpp, little, offset = 0 }, y0, y1, x0, x1, step = 1) {
  const rows = []; for (let y = y0; y <= y1; y += step) rows.push(y);
  const cols = []; for (let x = x0; x <= x1; x += step) cols.push(((x % W) + W) % W);
  const minC = Math.min(...cols), maxC = Math.max(...cols), wraps = maxC - minC > (x1 - x0) + 1;
  const out = new Float64Array(rows.length * cols.length);
  await pmap(rows, 8, async (y, j) => {
    const base = offset + y * W * bpp;
    const buf = wraps ? await fetchRange(url, base, base + W * bpp - 1) : await fetchRange(url, base + minC * bpp, base + (maxC + 1) * bpp - 1);
    const o0 = wraps ? 0 : minC;
    cols.forEach((c, i) => { const o = (c - o0) * bpp; out[j * cols.length + i] = bpp === 2 ? (little ? buf.readInt16LE(o) : buf.readInt16BE(o)) : buf.readFloatLE(o); });
    if (j % 100 === 0) process.stdout.write("  rows " + j + "/" + rows.length + "\r");
  });
  return { W: cols.length, H: rows.length, data: out };
}
// Every `step`-th row and column of a large uncompressed GeoTIFF (classic or
// BigTIFF, any rows per strip), by range requests.
async function tiffSubsample(url, step) {
  const { openRanged } = await import("../lib/geotiff.mjs");
  const t = await openRanged(url);
  const W = Math.floor(t.W / step), H = Math.floor(t.H / step), h = Math.floor(step / 2), out = new Float64Array(W * H);
  // Rotate products centred on 180° so column 0 is at −180°.
  const rot = Math.round((t.lonLeft + 180) / 360 * W);
  await pmap(Array.from({ length: H }, (_, y) => y), 8, async (y) => {
    const r = await t.row(Math.min(t.H - 1, y * step + h));
    for (let x = 0; x < W; x++) {
      const v = r[Math.min(t.W - 1, x * step + h) * t.spp];
      out[y * W + (x + rot) % W] = (t.nodata !== null && v === t.nodata) || (t.bps === 32 && v < -1e30) ? NaN : v;
    }
    if (y % 100 === 0) process.stdout.write("  rows " + y + "/" + H + "\r");
  });
  console.log();
  return { W, H, data: out, refRadius: t.refRadius, srcW: t.W, srcH: t.H, centralLon: t.centralLon };
}
// Fill missing cells (NaN) smoothly from their mapped neighbours (repeated
// averaging, coarse to fine). Returns the coverage mask (1 mapped, 0 not).
function inpaint(g) {
  const { W, H, data } = g, mask = new Uint8Array(W * H);
  let missing = 0;
  for (let i = 0; i < data.length; i++) if (Number.isFinite(data[i])) mask[i] = 1; else missing++;
  if (!missing) return mask;
  const known = mask.slice();
  let mean = 0, n = 0; for (let i = 0; i < data.length; i++) if (known[i]) { mean += data[i]; n++; }
  mean /= Math.max(1, n);
  for (let i = 0; i < data.length; i++) if (!known[i]) data[i] = mean;
  for (let it = 0; it < 400; it++) {
    const step = Math.max(1, Math.floor(64 / (1 + it / 6)));
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (known[i]) continue;
      const xl = ((x - step) % W + W) % W, xr = (x + step) % W, yu = Math.max(0, y - step), yd = Math.min(H - 1, y + step);
      data[i] = (data[y * W + xl] + data[y * W + xr] + data[yu * W + x] + data[yd * W + x]) / 4;
    }
  }
  return mask;
}
function maxAbs(a) { let m = 0; for (const v of a) if (Number.isFinite(v)) m = Math.max(m, Math.abs(v)); return m; }
// A regional patch over a lat/lon box: <body>-<name>-elevation.* with bounds.
function savePatch(id, name, g, bounds, meta) {
  const scale = Math.max(1, Math.ceil(maxAbs(g.data) / 32000));
  save(id + "-" + name, g.W, g.H, g.data, scale, { ...meta, bounds });
}
const RADIUS_KM = Object.fromEntries(JSON.parse(readFileSync(join(ROOT, "data", "astronomy", "solar-system.json"), "utf8")).bodies.map((b) => [b.id, b.eqRadiusKm || b.radiusKm]));
// A global grid from a USGS mosaic: heights re-referenced from the product's
// sphere to the simulator's catalogue radius; unmapped cells inpainted and
// recorded in a coverage mask.
async function usgsGlobal(id, file, step, meta) {
  const url = "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/" + file;
  const g = await tiffSubsample(url, step);
  // Some products store radius from the centre (Vesta: 204–285 km), not height.
  const finite = g.data.filter(Number.isFinite), med = finite.sort((a, c) => a - c)[finite.length >> 1];
  const isRadius = med > 0.5 * g.refRadius;
  const off = isRadius ? -RADIUS_KM[id] * 1000 : g.refRadius - RADIUS_KM[id] * 1000;
  for (let i = 0; i < g.data.length; i++) if (Number.isFinite(g.data[i])) g.data[i] += off;
  const mask = inpaint(g);
  const mapped = mask.reduce((a, b) => a + b, 0) / mask.length;
  let cov = null;
  if (mapped < 0.999) {
    // Feather the mask (~3° on each side) so procedural fill fades in rather
    // than starting at a hard edge; mapped cells away from the edge stay 100.
    let m = Float32Array.from(mask, (v) => v * 100);
    const r = Math.max(1, Math.round(g.W / 360 * 3));
    for (let pass = 0; pass < 3; pass++) {
      const t = new Float32Array(m.length);
      for (let y = 0; y < g.H; y++) { let acc = 0; for (let x = -r; x <= r; x++) acc += m[y * g.W + ((x % g.W) + g.W) % g.W];
        for (let x = 0; x < g.W; x++) { t[y * g.W + x] = acc / (2 * r + 1); acc += m[y * g.W + (x + r + 1) % g.W] - m[y * g.W + ((x - r) % g.W + g.W) % g.W]; } }
      for (let x = 0; x < g.W; x++) for (let y = 0; y < g.H; y++) { let acc = 0, n = 0; for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < g.H) { acc += t[yy * g.W + x]; n++; } } m[y * g.W + x] = acc / n; }
    }
    for (let i = 0; i < m.length; i++) m[i] = mask[i] ? Math.max(m[i], 50) : Math.min(m[i], 50);   // the data's own extent stays the 50% line
    const mb = Buffer.alloc(mask.length * 2);
    for (let y = 0; y < g.H; y++) { let prev = 0; for (let x = 0; x < g.W; x++) { const i = y * g.W + x, v = Math.round(m[i]); mb.writeInt16LE(((v - prev) << 16) >> 16, i * 2); prev = v; } }
    const gz = gzipSync(mb, { level: 9 });
    writeFileSync(join(OUT, id + "-coverage.i16.gz"), gz);
    cov = { file: id + "-coverage.i16.gz", width: g.W, height: g.H, scale: 0.01, bytes: gz.length };
  }
  const scale = Math.max(1, Math.ceil(maxAbs(g.data) / 32000));
  save(id, g.W, g.H, g.data, scale, { ...meta, url, reference: isRadius ? "radius values converted to heights above " + RADIUS_KM[id] + " km" : "heights re-referenced from the product's " + (g.refRadius / 1000).toFixed(1) + " km sphere to " + RADIUS_KM[id] + " km",
    mappedFraction: +mapped.toFixed(4), coverage: cov, sourceSize: g.srcW + "×" + g.srcH, sampling: "every " + step + "th row and column (range requests)", sourceCentralMeridian: g.centralLon, columnZero: "-180" });
}

async function thomasShape(id, file, note) {
  const url = "https://sbnarchive.psi.edu/pds4/non_mission/ast-sat.thomas.shape-models_V1_0/data/" + file + ".tab";
  const rows = (await fetchBuf(url)).toString("utf8").trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
  const grid = new Map();                                    // "lat,lonW" → radius km
  for (const [la, lo, r] of rows) grid.set(la + "," + ((lo % 360) + 360) % 360, r);
  const at = (la, loW) => grid.get(la + "," + loW);
  const W = 360, H = 180, data = new Float64Array(W * H), R0 = RADIUS_KM[id];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const lat = 90 - (y + 0.5), lonE = -180 + (x + 0.5), lonW = ((-lonE % 360) + 360) % 360;
    const la0 = Math.max(-90, Math.min(85, Math.floor(lat / 5) * 5)), lo0 = Math.floor(lonW / 5) * 5;
    const ty = (lat - la0) / 5, tx = (lonW - lo0) / 5, lo1 = (lo0 + 5) % 360;
    const r = (at(la0, lo0) * (1 - tx) + at(la0, lo1) * tx) * (1 - ty) + (at(la0 + 5, lo0) * (1 - tx) + at(la0 + 5, lo1) * tx) * ty;
    data[y * W + x] = (r - R0) * 1000;
  }
  const scale = Math.max(1, Math.ceil(maxAbs(data) / 32000));
  save(id, W, H, data, scale, { source: "Thomas shape model, 5° grid (PDS Small Bodies Node)", url, license: "Public domain (NASA PDS)", note,
    reference: "radius minus " + R0 + " km; longitudes converted from west- to east-positive", shapeFromData: true, mappedFraction: 1 });
}

// PDS 4 px/deg grids: 1440 × 720, rows from 90°N, columns from 0°E → rotate
// half a turn so column 0 is −180°.
function pdsGrid(buf, little, dnScale) {
  const W = 1440, H = 720, out = new Float64Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = little ? buf.readInt16LE((y * W + x) * 2) : buf.readInt16BE((y * W + x) * 2);
    out[y * W + ((x + W / 2) % W)] = v * dnScale;
  }
  return out;
}

const jobs = {
  async moon() {
    const url = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/ldem_4.img";
    save("moon", 1440, 720, pdsGrid(await fetchBuf(url), true, 0.5), 1,
      { source: "LRO LOLA LDEM_4 (NASA PDS Geosciences Node)", url, reference: "heights above a 1737.4 km sphere", license: "Public domain (NASA)" });
  },
  async mars() {
    const url = "https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg004/megt90n000cb.img";
    save("mars", 1440, 720, pdsGrid(await fetchBuf(url), false, 1), 1,
      { source: "MGS MOLA MEGDR, 4 px/deg (NASA PDS Geosciences Node)", url, reference: "heights relative to the MOLA areoid", license: "Public domain (NASA)" });
  },
  async earth() {
    // OPeNDAP ASCII: z[lat][lon], lat ascending from −90 — fetched in bands.
    const base = "https://www.ngdc.noaa.gov/thredds/dodsC/global/ETOPO2022/60s/60s_surface_elev_netcdf/ETOPO_2022_v1_60s_N90W180_surface.nc.ascii";
    const S = 10, W = 21600 / S, H = 10800 / S, out = new Float64Array(W * H);
    const band = 120;
    for (let r0 = 0; r0 < H; r0 += band) {
      const r1 = Math.min(H, r0 + band) - 1;
      const q = "?z%5B" + (r0 * S + 5) + ":" + S + ":" + (r1 * S + 5) + "%5D%5B5:" + S + ":" + (21600 - 1) + "%5D";
      const txt = (await fetchBuf(base + q)).toString("utf8");
      const lines = txt.split("\n").filter((l) => /^\[\d+\],/.test(l));
      lines.forEach((l, k) => {
        const vals = l.split(",").slice(1).map(Number);
        const latRow = r0 + k;                       // south → north
        const y = H - 1 - latRow;                    // store north → south
        for (let x = 0; x < W; x++) out[y * W + x] = vals[x];
      });
      process.stdout.write("  earth rows " + (r1 + 1) + "/" + H + "\r");
    }
    console.log();
    save("earth", W, H, out, 1, { source: "NOAA NCEI ETOPO 2022 v1, 60 arc-second surface elevation, subsampled to 10 arc-minutes (1/6°)", url: "https://www.ncei.noaa.gov/products/etopo-global-relief-model",
      reference: "metres relative to mean sea level (EGM2008 geoid); includes ice-sheet surfaces and bathymetry", license: "Public domain (US Government work, NOAA)" });
  },
  // Full 60″ (~1.8 km) resolution around the launch site: the Cape's barrier
  // island and the Banana and Indian River lagoons are narrower than a 10′
  // cell, so at that resolution the pad would stand in the sea.
  async "earth-ksc"() {
    const base = "https://www.ngdc.noaa.gov/thredds/dodsC/global/ETOPO2022/60s/60s_surface_elev_netcdf/ETOPO_2022_v1_60s_N90W180_surface.nc.ascii";
    const lat0 = 26.5, lat1 = 30.5, lon0 = -82.5, lon1 = -78.5;      // cell edges
    const i0 = Math.round((lat0 + 90) * 60), i1 = Math.round((lat1 + 90) * 60) - 1;
    const j0 = Math.round((lon0 + 180) * 60), j1 = Math.round((lon1 + 180) * 60) - 1;
    const W = j1 - j0 + 1, H = i1 - i0 + 1, out = new Float64Array(W * H);
    const txt = (await fetchBuf(base + "?z%5B" + i0 + ":1:" + i1 + "%5D%5B" + j0 + ":1:" + j1 + "%5D")).toString("utf8");
    const lines = txt.split("\n").filter((l) => /^\[\d+\],/.test(l));
    if (lines.length !== H) throw new Error("expected " + H + " rows, got " + lines.length);
    lines.forEach((l, k) => {
      const vals = l.split(",").slice(1).map(Number);
      const y = H - 1 - k;                           // store north → south
      for (let x = 0; x < W; x++) out[y * W + x] = vals[x];
    });
    save("earth-ksc", W, H, out, 1, { source: "NOAA NCEI ETOPO 2022 v1, 60 arc-second surface elevation (full resolution)", url: "https://www.ncei.noaa.gov/products/etopo-global-relief-model",
      reference: "metres relative to mean sea level (EGM2008 geoid)", license: "Public domain (US Government work, NOAA)",
      bounds: { north: lat1, south: lat0, west: lon0, east: lon1 }, note: "Detail patch around Cape Canaveral; cell-centred grid" });
  }
};

// ── regional patches: real crater and volcano geometry at higher resolution ──
const LDEM64 = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/ldem_64.img";
const MEG32 = "https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg032/megt90n000fb.img";
const MEG128 = (tile) => "https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg128/" + tile + ".img";
// Box (degrees, east-positive −180…180) → rows/cols of a 0…360°E grid with ppd pixels per degree, top row at lat0.
async function pdsPatch(url, grid, ppd, lat0, box, dn, step = 1) {
  const y0 = Math.round((lat0 - box.north) * ppd), y1 = Math.round((lat0 - box.south) * ppd) - 1;
  const w0 = ((box.west % 360) + 360) % 360, x0 = Math.round(w0 * ppd), x1 = x0 + Math.round((box.east - box.west) * ppd) - 1;
  const g = await rawWindow(url, grid, y0, y1, x0, x1, step);
  for (let i = 0; i < g.data.length; i++) g.data[i] *= dn;
  console.log();
  return g;
}
const MOON_PATCHES = [
  ["tycho", { south: -46, north: -40.5, west: -15, east: -7.5 }],
  ["copernicus", { south: 7.5, north: 11.75, west: -22.5, east: -17.5 }],
  ["apollo11", { south: -0.5, north: 1.75, west: 22.25, east: 24.75 }],
  ["apollo17", { south: 19, north: 21.25, west: 29.5, east: 32 }]
];
const MARS_PATCHES = [
  // name, box, ppd source
  ["olympus", { south: 12, north: 25.5, west: -141, east: -126 }, 32],
  ["valles", { south: -18, north: -2, west: -95, east: -40 }, 32],
  ["hellas", { south: -54, north: -30, west: 55, east: 87 }, 32],
  ["gale", { south: -6.5, north: -4.25, west: 136.5, east: 139 }, 128, "megt00n090hb", 0],
  ["jezero", { south: 17.25, north: 19.5, west: 76.5, east: 79 }, 128, "megt44n000hb", 44]
];
Object.assign(jobs, {
  async "moon-patches"() {
    for (const [name, box] of MOON_PATCHES) {
      const g = await pdsPatch(LDEM64, { W: 23040, bpp: 2, little: true }, 64, 90, box, 0.5);
      savePatch("moon", name, g, box, { source: "LRO LOLA LDEM_64 (64 px/deg, ~474 m), NASA PDS Geosciences Node", url: LDEM64, reference: "heights above the 1737.4 km sphere", license: "Public domain (NASA)" });
    }
  },
  async "mars-patches"() {
    for (const [name, box, ppd, tile, lat0] of MARS_PATCHES) {
      const g = ppd === 32 ? await pdsPatch(MEG32, { W: 11520, bpp: 2, little: false }, 32, 90, box, 1)
        : await pdsPatch(MEG128(tile), { W: 11520, bpp: 2, little: false }, 128, lat0, { ...box, west: box.west - 90 * Math.floor(((box.west % 360) + 360) % 360 / 90), east: box.east - 90 * Math.floor(((box.west % 360) + 360) % 360 / 90) }, 1);
      savePatch("mars", name, g, box, { source: "MGS MOLA MEGDR " + ppd + " px/deg (~" + (59.2 * 32 / ppd).toFixed(1) + " km → " + (3389.5 * Math.PI / 180 / ppd).toFixed(2) + " km cells), NASA PDS Geosciences Node",
        url: ppd === 32 ? MEG32 : MEG128(tile), reference: "heights relative to the MOLA areoid", license: "Public domain (NASA)" });
    }
  },
  async mercury() {
    await usgsGlobal("mercury", "Mercury_Messenger_USGS_DEM_Global_665m_v2.tif", 16, { source: "MESSENGER global DEM 665 m (USGS Astrogeology, Becker et al. 2016)", license: "Public domain (NASA/USGS)" });
  },
  async venus() {
    await usgsGlobal("venus", "Venus_Magellan_Topography_Global_4641m_v02.tif", 4, { source: "Magellan global topography 4641 m (USGS Astrogeology, from the Magellan altimeter GTDR)", license: "Public domain (NASA/JPL/USGS)" });
  },
  async ceres() {
    await usgsGlobal("ceres", "Ceres_Dawn_FC_HAMO_DTM_DLR_Global_60ppd_Oct2016.tif", 15, { source: "Dawn FC HAMO global DTM 60 px/deg (DLR, via USGS Astrogeology)", license: "Public domain (NASA)" });
  },
  async vesta() {
    await usgsGlobal("vesta", "Vesta_Dawn_HAMO_DTM_DLR_Global_48ppd.tif", 12, { source: "Dawn HAMO global DTM 48 px/deg (DLR, via USGS Astrogeology)", license: "Public domain (NASA)" });
  },
  async pluto() {
    await usgsGlobal("pluto", "Pluto_NewHorizons_Global_DEM_300m_Jul2017_16bit.tif", 16, { source: "New Horizons global DEM 300 m (Schenk et al. 2018, USGS Astrogeology) — encounter hemisphere mapped", license: "Public domain (NASA)" });
  },
  async enceladus() {
    await usgsGlobal("enceladus", "Enceladus/enceladus_cassini_iss_shapemodel_bland_2019/enceladus_2019pm_radius.tif", 1, { source: "Cassini ISS global shape model, radius grid 0.5° (Bland et al. 2019, USGS Astrogeology)", license: "Public domain (NASA/USGS)", shapeFromData: true });
  },
  async phobos() {
    await usgsGlobal("phobos", "Phobos_ME_HRSC_DEM_Global_2ppd.tif", 1, { source: "Mars Express HRSC global DEM 2 px/deg (DLR, via USGS Astrogeology)", license: "Public domain / ESA-DLR-FU Berlin release via USGS", shapeFromData: true });
  },
  // Peter Thomas optical shape models (PDS Small Bodies Node, bundle
  // ast-sat.thomas.shape-models v1.0): radius on a 5° planetocentric grid.
  // Longitudes are WEST-positive — established by comparing the Thomas Phobos
  // model with the HRSC Phobos DEM (r = 0.967 west vs 0.873 east) — and are
  // converted to east-positive here.
  async deimos() { await thomasShape("deimos", "m2deimos", "Thomas (1993) Viking-based shape model; ~400 m uncertainty over 200–355° W"); },
  async hyperion() { await thomasShape("hyperion", "s7hyperion", "Thomas Voyager 2 shape model; worst fit 330–30° W north of 30° S, ~95% of the surface within 20 km"); },
  async charon() {
    await usgsGlobal("charon", "Charon_NewHorizons_Global_DEM_300m_Jul2017_16bit.tif", 8, { source: "New Horizons global DEM 300 m (Schenk et al. 2018, USGS Astrogeology) — encounter hemisphere mapped", license: "Public domain (NASA)" });
  }
});

const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(jobs);
for (const id of want) await jobs[id]();
// Re-encode what was written into the compact H2D1 form (lossless).
const { packSurfaceGrids } = await import("../pack-assets.mjs");
packSurfaceGrids();
