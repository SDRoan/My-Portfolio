// A minimal GeoTIFF reader for the elevation and land-cover sources these
// scripts use: single-band, int16/uint16/float32 (little-endian) or uint8
// (either byte order: GeoServer WCS writes big-endian), uncompressed or DEFLATE,
// strips or tiles, with the horizontal (2) or floating-point (3) predictor.
// For very large uncompressed files (the USGS planetary mosaics) it can read
// just the rows it needs with HTTP range requests.

import { inflateSync } from "node:zlib";

const TAGS = { 256: "W", 257: "H", 258: "bps", 259: "compression", 273: "stripOffsets", 278: "rowsPerStrip", 279: "stripBytes",
  317: "predictor", 322: "tileW", 323: "tileH", 324: "tileOffsets", 325: "tileBytes", 339: "sampleFormat",
  33550: "pixelScale", 33922: "tiepoint", 34264: "transform", 42113: "nodata" };

export function parseHeader(buf) {
  const order = buf.toString("latin1", 0, 2);
  if (order !== "II" && order !== "MM") throw new Error("not a TIFF");
  const be = order === "MM";
  const r16 = (o) => (be ? buf.readUInt16BE(o) : buf.readUInt16LE(o)), r32 = (o) => (be ? buf.readUInt32BE(o) : buf.readUInt32LE(o));
  const rD = (o) => (be ? buf.readDoubleBE(o) : buf.readDoubleLE(o));
  if (r16(2) !== 42) throw new Error("BigTIFF not supported");
  const off = r32(4), n = r16(off), t = { be };
  const size = { 1: 1, 2: 1, 3: 2, 4: 4, 11: 4, 12: 8, 16: 8 };
  for (let i = 0; i < n; i++) {
    const e = off + 2 + i * 12, tag = r16(e), type = r16(e + 2), cnt = r32(e + 4);
    const name = TAGS[tag];
    if (!name) continue;
    const bytes = (size[type] || 1) * cnt, at = bytes <= 4 ? e + 8 : r32(e + 8);
    if (at + bytes > buf.length) { t[name] = { deferred: true, at, cnt, type }; continue; }
    const vals = [];
    for (let k = 0; k < cnt; k++) {
      const p = at + k * (size[type] || 1);
      vals.push(type === 3 ? r16(p) : type === 4 ? r32(p) : type === 12 ? rD(p) : type === 2 || type === 1 ? buf[p] : r32(p));
    }
    t[name] = type === 2 ? String.fromCharCode(...vals).replace(/\0+$/, "") : cnt === 1 ? vals[0] : vals;
  }
  t.bps = Array.isArray(t.bps) ? t.bps[0] : t.bps;
  t.sampleFormat = t.sampleFormat || 1;
  if (be && t.bps > 8) throw new Error("big-endian TIFF: only 8-bit samples supported");
  return t;
}

function readSample(b, o, bps, fmt) {
  if (bps === 32 && fmt === 3) return b.readFloatLE(o);
  if (bps === 16 && fmt === 2) return b.readInt16LE(o);
  if (bps === 16) return b.readUInt16LE(o);
  if (bps === 32 && fmt === 2) return b.readInt32LE(o);
  if (bps === 8) return b[o];
  throw new Error("unsupported sample " + bps + "/" + fmt);
}

// Decode one block (strip or tile) of w × h samples into out (Float32Array, row stride W) at (x0, y0).
function decodeBlock(raw, t, w, h, out, W, x0, y0, Hmax) {
  let b = t.compression === 8 || t.compression === 32946 ? inflateSync(raw) : raw;
  const bpp = t.bps / 8;
  if (t.predictor === 3) {                        // floating point: byte planes, differenced
    const rowBytes = w * bpp, res = Buffer.alloc(b.length);
    for (let y = 0; y < h; y++) {
      const r = y * rowBytes;
      for (let i = 1; i < rowBytes; i++) b[r + i] = (b[r + i] + b[r + i - 1]) & 255;
      for (let i = 0; i < w; i++) for (let k = 0; k < bpp; k++) res[r + i * bpp + (bpp - 1 - k)] = b[r + k * w + i];
    }
    b = res;
  }
  for (let y = 0; y < h; y++) {
    if (y0 + y >= Hmax) break;
    let acc = 0;
    for (let x = 0; x < w; x++) {
      let v = readSample(b, (y * w + x) * bpp, t.bps, t.sampleFormat);
      if (t.predictor === 2) { acc += v; v = acc; if (t.bps === 16 && t.sampleFormat === 2) v = (v << 16) >> 16; }
      if (x0 + x < W) out[(y0 + y) * W + x0 + x] = v;
    }
  }
}

// Whole file in memory → { W, H, data: Float32Array, nodata, geo }
export function readTiff(buf) {
  const t = parseHeader(buf);
  const W = t.W, H = t.H, out = new Float32Array(W * H);
  const list = (x) => (Array.isArray(x) ? x : [x]);
  if (t.tileW) {
    const offs = list(t.tileOffsets), bytes = list(t.tileBytes), across = Math.ceil(W / t.tileW);
    offs.forEach((o, i) => decodeBlock(buf.subarray(o, o + bytes[i]), t, t.tileW, t.tileH, out, W, (i % across) * t.tileW, Math.floor(i / across) * t.tileH, H));
  } else {
    const offs = list(t.stripOffsets), bytes = list(t.stripBytes), rps = t.rowsPerStrip || H;
    offs.forEach((o, i) => decodeBlock(buf.subarray(o, o + bytes[i]), t, W, Math.min(rps, H - i * rps), out, W, 0, i * rps, H));
  }
  return { W, H, data: out, nodata: t.nodata !== undefined ? Number(t.nodata) : null, geo: { scale: t.pixelScale, tie: t.tiepoint } };
}

// Range-read every `step`-th row (and column) of a huge uncompressed,
// one-row-per-strip TIFF. Returns { W, H (of the subsample), data, nodata }.
export async function readRowsRanged(url, step, fetchRange) {
  const head = await fetchRange(url, 0, 1 << 20);
  const t = parseHeader(head);
  if (t.compression !== 1) throw new Error("ranged reading needs an uncompressed TIFF");
  if ((t.rowsPerStrip || 1) !== 1) throw new Error("ranged reading expects one row per strip");
  let offs = t.stripOffsets;
  if (offs.deferred) {                              // the offset table lies beyond the first megabyte
    const tb = await fetchRange(url, offs.at, offs.at + offs.cnt * 4 - 1);
    offs = Array.from({ length: offs.cnt }, (_, i) => tb.readUInt32LE(i * 4));
  }
  const W = Math.floor(t.W / step), H = Math.floor(t.H / step), bpp = t.bps / 8, out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * step + Math.floor(step / 2), o = offs[row];
    const b = await fetchRange(url, o, o + t.W * bpp - 1);
    for (let x = 0; x < W; x++) out[y * W + x] = readSample(b, (x * step + Math.floor(step / 2)) * bpp, t.bps, t.sampleFormat);
    if (y % 64 === 0) process.stdout.write("  rows " + y + "/" + H + "\r");
  }
  console.log();
  return { W, H, data: out, nodata: t.nodata !== undefined ? Number(t.nodata) : null, srcW: t.W, srcH: t.H, geo: { scale: t.pixelScale, tie: t.tiepoint } };
}

// ── ranged access to large remote GeoTIFFs (classic or BigTIFF, uncompressed
// strips, 1 or 3 samples per pixel) — only the bytes asked for are fetched ──
async function rangeFetch(url, a, b, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { Range: "bytes=" + a + "-" + b }, signal: AbortSignal.timeout(120000) });
      if (r.status !== 206) throw new Error("HTTP " + r.status);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { if (i === tries - 1) throw e; await new Promise((res) => setTimeout(res, 1500 * (i + 1))); }
  }
}
export async function openRanged(url) {
  const head = await rangeFetch(url, 0, 15);
  if (head.toString("latin1", 0, 2) !== "II") throw new Error("only little-endian TIFF supported");
  const big = head.readUInt16LE(2) === 43;
  const ifdOff = big ? Number(head.readBigUInt64LE(8)) : head.readUInt32LE(4);
  const cntBuf = await rangeFetch(url, ifdOff, ifdOff + 7);
  const n = big ? Number(cntBuf.readBigUInt64LE(0)) : cntBuf.readUInt16LE(0);
  const es = big ? 20 : 12, base = ifdOff + (big ? 8 : 2);
  const ifd = await rangeFetch(url, base, base + n * es - 1);
  const size = { 1: 1, 2: 1, 3: 2, 4: 4, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8 };
  const t = {};
  const want = { 256: "W", 257: "H", 258: "bps", 259: "compression", 273: "stripOffsets", 277: "spp", 278: "rowsPerStrip", 284: "planar", 339: "sampleFormat", 33550: "pixelScale", 33922: "tiepoint", 42113: "nodata", 34735: "geoKeys", 34736: "geoDoubles" };
  for (let i = 0; i < n; i++) {
    const e = i * es, tag = ifd.readUInt16LE(e), type = ifd.readUInt16LE(e + 2);
    const cnt = big ? Number(ifd.readBigUInt64LE(e + 4)) : ifd.readUInt32LE(e + 4);
    const name = want[tag]; if (!name) continue;
    const bytes = (size[type] || 1) * cnt, inline = big ? 8 : 4;
    let data;
    if (bytes <= inline) data = ifd.subarray(e + (big ? 12 : 8), e + (big ? 12 : 8) + bytes);
    else { const off = big ? Number(ifd.readBigUInt64LE(e + 12)) : ifd.readUInt32LE(e + 8); data = await rangeFetch(url, off, off + bytes - 1); }
    const vals = [];
    for (let k = 0; k < cnt; k++) {
      const p = k * (size[type] || 1);
      vals.push(type === 3 ? data.readUInt16LE(p) : type === 4 ? data.readUInt32LE(p) : type === 16 ? Number(data.readBigUInt64LE(p)) : type === 12 ? data.readDoubleLE(p) : data[p]);
    }
    t[name] = type === 2 ? String.fromCharCode(...vals).replace(/\0+$/, "") : (name === "stripOffsets" || cnt > 1) ? vals : vals[0];
  }
  if (t.compression !== 1) throw new Error("ranged reading needs an uncompressed TIFF");
  // The projection's central meridian (GeoKeys 3088 ProjCenterLong or 3080
  // ProjNatOriginLong), in degrees: column W/2 is at this longitude.
  let centralLon = 0;
  if (Array.isArray(t.geoKeys)) {
    const k = t.geoKeys, d = Array.isArray(t.geoDoubles) ? t.geoDoubles : [t.geoDoubles];
    for (let i = 4; i + 3 < k.length; i += 4) if ((k[i] === 3088 || k[i] === 3080) && k[i + 1] === 34736) centralLon = d[k[i + 3]];
  }
  t.bps = Array.isArray(t.bps) ? t.bps[0] : t.bps;
  t.spp = t.spp || 1; t.rowsPerStrip = t.rowsPerStrip || t.H; t.planar = t.planar || 1;
  t.sampleFormat = Array.isArray(t.sampleFormat) ? t.sampleFormat[0] : (t.sampleFormat || 1);
  const bpp = t.bps / 8, rowBytes = t.W * bpp * (t.planar === 1 ? t.spp : 1), stripsPerBand = Math.ceil(t.H / t.rowsPerStrip);
  const offs = t.stripOffsets;
  const read = (b, o) => t.bps === 8 ? b[o] : t.bps === 16 ? (t.sampleFormat === 2 ? b.readInt16LE(o) : b.readUInt16LE(o)) : t.sampleFormat === 3 ? b.readFloatLE(o) : b.readInt32LE(o);
  const nodata = t.nodata !== undefined ? Number(t.nodata) : null;
  return {
    W: t.W, H: t.H, spp: t.spp, bps: t.bps, nodata, scale: t.pixelScale, tie: t.tiepoint, centralLon,
    // Longitude (−180…180) of the left edge: central meridian + tie x.
    lonLeft: (() => { if (!t.pixelScale || !t.tiepoint) return -180; const sx = t.pixelScale[0], deg = Math.abs(sx * t.W - 360) < 0.5;
      const l = deg ? t.tiepoint[3] : centralLon + t.tiepoint[3] / (sx * t.W / (2 * Math.PI) * Math.PI / 180); return ((l + 540) % 360) - 180; })(),
    refRadius: t.pixelScale ? t.pixelScale[0] * t.W / (2 * Math.PI) : null,
    // Samples (all bands) of row y, columns x0…x1 (inclusive, no wrap): Float64Array of (x1-x0+1)*spp.
    async row(y, x0 = 0, x1 = t.W - 1) {
      const out = new Float64Array((x1 - x0 + 1) * t.spp);
      for (let band = 0; band < (t.planar === 1 ? 1 : t.spp); band++) {
        const s = Math.floor(y / t.rowsPerStrip) + band * stripsPerBand, within = (y % t.rowsPerStrip) * rowBytes;
        const step = bpp * (t.planar === 1 ? t.spp : 1);
        const b = await rangeFetch(url, offs[s] + within + x0 * step, offs[s] + within + (x1 + 1) * step - 1);
        for (let x = 0; x <= x1 - x0; x++) {
          if (t.planar === 1) for (let c = 0; c < t.spp; c++) out[x * t.spp + c] = read(b, x * step + c * bpp);
          else out[x * t.spp + band] = read(b, x * step);
        }
      }
      return out;
    }
  };
}
