// Adds a high-resolution elevation patch (from dem-swissalti3d.py) to a built
// Earth region pack, blended into the pack's Copernicus GLO-30 elevation:
//   - cells the fine source doesn't cover (outside Switzerland) take the
//     Copernicus value, and the fine data feathers in over ~150 m from them;
//   - at the patch's box edges the renderer fades it into the coarser data
//     (Patch.blend, surface-core.js).
// So there is no step at either kind of boundary.
//
//   node scripts/earth/add-dem-patch.mjs <pack> <grid.f32> <name>
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeGrid, encodeGrid } from "../../space/engine/packs.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const [id, f32, name] = process.argv.slice(2);
const dir = join(ROOT, "space", "data", "earth", "regions", id), mf = join(dir, "meta.json");
const meta = JSON.parse(readFileSync(mf, "utf8")), info = JSON.parse(readFileSync(f32 + ".json", "utf8"));
const raw = readFileSync(f32), fine = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const { width: W, height: H, bounds: b } = info;
// Copernicus (the pack's coarsest grid), bilinear.
const c = meta.dem.find((d) => !d.attached), ch = decodeGrid(gunzipSync(readFileSync(join(dir, c.file))), c.width, c.height), cb = c.bounds;
const cop = (la, lo) => {
  const fx = (lo - cb.west) / (cb.east - cb.west) * c.width - 0.5, fy = (cb.north - la) / (cb.north - cb.south) * c.height - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0, g = (x, y) => ch[y * c.width + x] * c.scale;
  return (g(x0, y0) * (1 - tx) + g(x0 + 1, y0) * tx) * (1 - ty) + (g(x0, y0 + 1) * (1 - tx) + g(x0 + 1, y0 + 1) * tx) * ty;
};
// Feather weight: box-blurred validity (radius R cells), remapped so it is 0 at the no-data edge.
const R = 25, valid = new Float32Array(W * H);
for (let i = 0; i < W * H; i++) valid[i] = Number.isFinite(fine[i]) ? 1 : 0;
const blur = (src) => {
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) { let s = 0; for (let x = -R; x <= R; x++) s += src[y * W + Math.max(0, Math.min(W - 1, x))]; for (let x = 0; x < W; x++) { tmp[y * W + x] = s / (2 * R + 1); s += src[y * W + Math.min(W - 1, x + R + 1)] - src[y * W + Math.max(0, x - R)]; } }
  for (let x = 0; x < W; x++) { let s = 0; for (let y = -R; y <= R; y++) s += tmp[Math.max(0, Math.min(H - 1, y)) * W + x]; for (let y = 0; y < H; y++) { out[y * W + x] = s / (2 * R + 1); s += tmp[Math.min(H - 1, y + R + 1) * W + x] - tmp[Math.max(0, y - R) * W + x]; } }
  return out;
};
const bw = blur(valid), scale = 0.2, h = new Int16Array(W * H);
let filled = 0, maxV = -1e9, maxAt = null;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = y * W + x, la = b.north - (y + 0.5) / H * (b.north - b.south), lo = b.west + (x + 0.5) / W * (b.east - b.west);
  const cv = cop(la, lo), w = valid[i] ? Math.max(0, Math.min(1, 2 * bw[i] - 1)) : 0;
  if (!valid[i]) filled++;
  const v = valid[i] ? w * fine[i] + (1 - w) * cv : cv;
  h[i] = Math.round(v / scale);
  if (v > maxV) { maxV = v; maxAt = [la, lo]; }
}
const file = "dem-" + name + ".i16.gz", gz = gzipSync(encodeGrid(h, W, H), { level: 9 });
writeFileSync(join(dir, file), gz);
const arcsec = (b.north - b.south) / H * 3600;
meta.dem = meta.dem.filter((d) => d.file !== file).concat([{ file, width: W, height: H, scale, bounds: b, arcsec: +arcsec.toFixed(3), attached: true,
  source: "swisstopo swissALTI3D 2 m (" + info.vintages.join(", ") + "), resampled to ~5 m, blended into Copernicus GLO-30", datum: info.datum,
  filledFromCopernicus: +(filled / (W * H)).toFixed(3), bytes: gz.length }]);
writeFileSync(mf, JSON.stringify(meta));
console.log(id + ": " + file + " " + W + "×" + H + " @" + (arcsec * 30.87).toFixed(1) + " m · " + (gz.length / 1048576).toFixed(2) + " MB · max " + maxV.toFixed(1) + " m at " + maxAt.map((v) => v.toFixed(5)).join(", ") + " · " + (100 * filled / (W * H)).toFixed(1) + "% filled from Copernicus");
