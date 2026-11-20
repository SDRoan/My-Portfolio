// Checks that each body's imagery and elevation share one projection:
//
//   node scripts/planetary/validate-alignment.mjs
//
// For every body in the surface manifest with both a DEM and a global map:
//   1. both are equirectangular, 2:1, rows north → south;
//   2. fine detail is compared at 0.5°: the high-passed gradient magnitude of
//      the map (crater rims, scarps) against that of the DEM, at longitude
//      offsets 0…355° (5° steps) and with a north–south flip. The best offset
//      must be 0° (±5°) and not flipped — the test that caught the half-turn
//      error in the old Mercury map.
// Writes space/data/surfaces/alignment-report.txt. Needs libjpeg-turbo (djpeg).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeGrid } from "../../space/engine/packs.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIR = join(ROOT, "space", "data", "surfaces");
const M = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")).bodies;
const SSS = { mercury: "mercury.jpg", venus: "venus_surface.jpg", moon: "moon.jpg", mars: "mars.jpg" };

function grid(file, W, H, scale) {
  const g = decodeGrid(gunzipSync(readFileSync(join(DIR, file))), W, H), h = new Float32Array(W * H);
  for (let i = 0; i < h.length; i++) h[i] = g[i] === -32768 ? NaN : g[i] * scale;
  return { W, H, h };
}
function image(file) {
  const path = join(ROOT, "textures", file);
  if (file.endsWith(".webp")) {
    // dwebp -pgm writes YUV 4:2:0; the top two-thirds of the rows are luminance. Quarter it like djpeg -scale 1/4.
    const out = execFileSync("dwebp", ["-pgm", "-o", "-", path], { maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "ignore"] });
    const m = out.toString("latin1", 0, 40).match(/^P5\s+(\d+)\s+(\d+)\s+255\s/);
    const W0 = +m[1], H0 = Math.round(+m[2] * 2 / 3), y = out.subarray(m[0].length), W = W0 >> 2, H = H0 >> 2, p = new Uint8Array(W * H);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      let t = 0;
      for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) t += y[(r * 4 + a) * W0 + c * 4 + b];
      p[r * W + c] = t >> 4;
    }
    return { W, H, p };
  }
  const out = execFileSync("djpeg", ["-grayscale", "-scale", "1/4", "-pnm", path], { maxBuffer: 1 << 28 });
  const m = out.toString("latin1", 0, 40).match(/^P5\s+(\d+)\s+(\d+)\s+255\s/);
  return { W: +m[1], H: +m[2], p: out.subarray(m[0].length) };
}
function corr(a, b) {
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i], y = b[i]; if (!Number.isFinite(x) || !Number.isFinite(y)) continue; n++; sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y; }
  return n < 100 ? 0 : (sab - sa * sb / n) / Math.sqrt((saa - sa * sa / n) * (sbb - sb * sb / n) || 1);
}

const lines = [], fails = [];
for (const [id, e] of Object.entries(M)) {
  const t = e.terrain;
  const imgFile = e.globalMap || (e.surfaceMap && e.surfaceMap !== "venus_surface.jpg" ? e.surfaceMap : null) || SSS[id];
  if (!t || !t.file || !imgFile || !existsSync(join(ROOT, "textures", imgFile))) continue;
  const g = grid(t.file, t.width, t.height, t.scale || 1), I = image(imgFile);
  if (Math.abs(g.W / g.H - 2) > 0.02 || Math.abs(I.W / I.H - 2) > 0.02) { fails.push(id + ": not 2:1"); continue; }
  for (const [N, Hh, r] of [[720, 360, 5], [180, 90, 3]]) {
  // Resample both to N × Hh (0.5°, then 2° if the fine test is inconclusive).
  const shift = e.mapLonShift || 0;
  const dem = new Float64Array(N * Hh), img = new Float64Array(N * Hh);
  for (let y = 0; y < Hh; y++) for (let x = 0; x < N; x++) {
    const gx = Math.floor((x + 0.5) / N * g.W), gy = Math.floor((y + 0.5) / Hh * g.H);
    dem[y * N + x] = g.h[gy * g.W + gx];
    const ix = Math.floor((((x + 0.5) / N + shift) % 1) * I.W), iy = Math.floor((y + 0.5) / Hh * I.H);
    const v = I.p[iy * I.W + ix];
    img[y * N + x] = v < 3 ? NaN : v;                      // black = unimaged
  }
  // Detail only: gradient magnitude (crater rims, scarps, ridges), high-passed
  // against a 5° box mean so broad albedo/elevation trends can't dominate.
  const gradHP = (a) => {
    const gm = new Float64Array(N * Hh).fill(NaN);
    for (let y = 1; y < Hh - 1; y++) for (let x = 0; x < N; x++) {
      const gx = a[y * N + (x + 1) % N] - a[y * N + (x + N - 1) % N], gy = a[(y + 1) * N + x] - a[(y - 1) * N + x];
      gm[y * N + x] = Math.hypot(gx * Math.cos((90 - (y + 0.5) * 180 / Hh) * Math.PI / 180), gy);
    }
    const out = new Float64Array(N * Hh).fill(NaN);
    for (let y = r; y < Hh - r; y++) for (let x = 0; x < N; x++) {
      let s = 0, c = 0;
      for (let j = -r; j <= r; j += 2) for (let i = -r; i <= r; i += 2) { const v = gm[(y + j) * N + (x + i + N) % N]; if (Number.isFinite(v)) { s += v; c++; } }
      out[y * N + x] = c ? gm[y * N + x] - s / c : NaN;
    }
    return out;
  };
  const D = gradHP(dem), Gi = gradHP(img);
  const res = [];
  for (const flip of [false, true]) for (let off = 0; off < N; off += N / 72) {
    const a = new Float64Array(N * Hh);
    for (let y = 0; y < Hh; y++) for (let x = 0; x < N; x++) a[y * N + x] = Gi[(flip ? Hh - 1 - y : y) * N + (x + off) % N];
    res.push({ off: off * 360 / N, flip, r: corr(a, D) });
  }
  res.sort((p, q) => q.r - p.r);
  const best = res[0], at0 = res.find((x) => x.off === 0 && !x.flip);
  const ok = !best.flip && (best.off <= 5 || best.off >= 355);
  // A peak that barely beats the rest of the sweep decides nothing.
  const decisive = best.r > 0.04 && best.r > 1.8 * Math.abs(res[1].off === best.off ? res[2].r : res[1].r);
  const line = id.padEnd(10) + " map " + imgFile.padEnd(26) + " @" + (180 / Hh) + "° best offset " + String(best.off).padStart(3) + "°" + (best.flip ? " FLIPPED" : "") +
    " r=" + best.r.toFixed(3) + "  (at 0°: " + at0.r.toFixed(3) + ", runner-up " + res[1].off + "° " + res[1].r.toFixed(3) + ")  " + (ok && decisive ? "ALIGNED ✓" : ok ? "weak peak at 0°" : decisive ? "MISALIGNED ✗" : "inconclusive");
  if (!decisive && N === 720) continue;
  lines.push(line);
  if (!ok && decisive) fails.push(line);
  break;
  }
}
const txt = lines.join("\n") + "\n" + (existsSync(join(DIR, "validation.txt")) ? "\nGeoreferencing of the sources (build-terrain.mjs):\n" + readFileSync(join(DIR, "validation.txt"), "utf8") : "");
writeFileSync(join(DIR, "alignment-report.txt"), txt);
console.log(txt);
if (fails.length) { console.log("NOT ALIGNED:\n" + fails.join("\n")); process.exitCode = 1; }
