// Surface imagery used by the planetary surface system. Afterwards run
// `node scripts/pack-assets.mjs --images` (WebP where it pays, ≥ 40 dB).
//
//   node scripts/planetary/fetch-imagery.mjs
//
// Files are stored unmodified in textures/ (no image processing needed):
//   earth_bluemarble.png  NASA "The Blue Marble" land-surface composite
//                         (Stöckli et al., NASA Goddard / SVS #2915), 2048×1024,
//                         public domain. Ocean colour is not taken from it —
//                         the shader shades oceans from ETOPO 2022 bathymetry.
//   earth_blackmarble.jpg NASA Black Marble 2016 (Suomi NPP VIIRS night
//                         lights), 3600×1800, public domain.
//   venus_surface.jpg     Solar System Scope Venus surface map (CC BY 4.0),
//                         based on NASA Magellan radar imagery.
//   earth_clouds.jpg      Solar System Scope Earth clouds (CC BY 4.0).

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FILES = [
  ["earth_bluemarble.png", "https://svs.gsfc.nasa.gov/vis/a000000/a002900/a002915/bluemarble-2048.png"],
  ["earth_blackmarble.jpg", "https://assets.science.nasa.gov/content/dam/science/esd/eo/images/imagerecords/144000/144898/BlackMarble_2016_01deg.jpg"],
  ["venus_surface.jpg", "https://www.solarsystemscope.com/textures/download/2k_venus_surface.jpg"],
  ["earth_clouds.jpg", "https://www.solarsystemscope.com/textures/download/2k_earth_clouds.jpg"]
];
// New Horizons global mosaics (USGS Astrogeology, public domain), greyscale,
// sampled from the 300 m GeoTIFFs by range requests and written as JPEG with
// libjpeg-turbo's cjpeg. Unimaged areas stay black (0); the simulator fills
// those with procedural colour and labels them as such.
const MOSAICS = [
  ["pluto_newhorizons.jpg", "Pluto_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif", 12],
  ["charon_newhorizons.jpg", "Charon_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif", 6]
];
async function range(url, a, b) { const r = await fetch(url, { headers: { Range: "bytes=" + a + "-" + b } }); if (r.status !== 206) throw new Error("HTTP " + r.status); return Buffer.from(await r.arrayBuffer()); }
async function mosaic(out, file, step) {
  const { parseHeader } = await import("../lib/geotiff.mjs");
  const { execFileSync } = await import("node:child_process");
  const url = "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/" + file;
  const t = parseHeader(await range(url, 0, (1 << 20) - 1));
  let offs = t.stripOffsets;
  if (offs.deferred) { const tb = await range(url, offs.at, offs.at + offs.cnt * 4 - 1); offs = Array.from({ length: offs.cnt }, (_, i) => tb.readUInt32LE(i * 4)); }
  const W = Math.floor(t.W / step), H = Math.floor(t.H / step), px = Buffer.alloc(W * H);
  // Products centred on 180° (Pluto) are rotated so column 0 is at −180°.
  const { openRanged } = await import("../lib/geotiff.mjs");
  const rot = Math.round(((await openRanged(url)).lonLeft + 180) / 360 * W);
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => { while (next < H) { const y = next++; const o = offs[y * step + (step >> 1)], b = await range(url, o, o + t.W - 1); for (let x = 0; x < W; x++) px[y * W + (x + rot) % W] = b[x * step + (step >> 1)]; } }));
  const pgm = join(ROOT, "textures", out + ".pgm");
  writeFileSync(pgm, Buffer.concat([Buffer.from("P5\n" + W + " " + H + "\n255\n"), px]));
  execFileSync("cjpeg", ["-quality", "86", "-grayscale", "-outfile", join(ROOT, "textures", out), pgm]);
  (await import("node:fs")).unlinkSync(pgm);
  console.log(out, W + "×" + H);
}
const only = process.argv.slice(2);
for (const [out, file, step] of MOSAICS) if (!only.length || only.includes(out)) await mosaic(out, file, step);
if (only.length) process.exit(0);

for (const [name, url] of FILES) {
  const r = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!r.ok) throw new Error(name + ": HTTP " + r.status);
  const b = Buffer.from(await r.arrayBuffer());
  writeFileSync(join(ROOT, "textures", name), b);
  console.log(name, (b.length / 1048576).toFixed(2), "MB");
}
