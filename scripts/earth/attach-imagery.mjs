// Attaches open imagery (made by imagery-sentinel2.py / imagery-ortho.py) to
// built Earth region packs: copies the image into the pack and records it in
// meta.json with its source, dates, resolution, licence and attribution.
// Attached layers survive a rebuild of the pack (build-region.mjs keeps them).
//
//   node scripts/earth/attach-imagery.mjs <dir with *.jpg + *.jpg.json> [pack …]
//
// File names: <pack>-s2.jpg (Copernicus Sentinel-2, 10 m: the regional layer)
// and <pack>-<ign|gsi|pdok|naip>.jpg (national orthophoto: the fine layer).
// The runtime draws the two finest layers of the nearest pack (regions.js).

import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync, statSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RG = join(ROOT, "space", "data", "earth", "regions");
const [src, ...only] = process.argv.slice(2);
const files = readdirSync(src).filter((f) => /\.jpg$/.test(f) && existsSync(join(src, f + ".json")));
const byPack = new Map();
for (const f of files) {
  const m = f.match(/^(.+)-(s2|ign|gsi|pdok|naip)\.jpg$/);
  if (!m || (only.length && !only.includes(m[1]))) continue;
  if (!byPack.has(m[1])) byPack.set(m[1], []);
  byPack.get(m[1]).push({ f, kind: m[2], info: JSON.parse(readFileSync(join(src, f + ".json"), "utf8")) });
}
for (const [id, layers] of byPack) {
  const mf = join(RG, id, "meta.json");
  if (!existsSync(mf)) { console.log("skip " + id + ": no pack"); continue; }
  const meta = JSON.parse(readFileSync(mf, "utf8"));
  meta.imagery = (meta.imagery || []).filter((im) => !im.attached);
  for (const { f, kind, info } of layers) {
    const file = kind === "s2" ? "img-s2.jpg" : "img-ortho.jpg";
    copyFileSync(join(src, f), join(RG, id, file));
    const s2 = kind === "s2";
    meta.imagery.push({
      file, width: info.width, height: info.height, bounds: info.bounds, attached: true,
      source: s2 ? "Copernicus Sentinel-2 L2A (" + info.dates.join(", ") + ")" : info.name,
      mission: s2 ? info.mission : undefined, processing: s2 ? info.product : undefined, scenes: s2 ? info.scenes.map((x) => x.scene) : undefined,
      dates: s2 ? info.dates : undefined, resolutionM: info.resolutionM, pixelM: info.pixelM,
      licence: s2 ? "Copernicus data policy: free, full and open (Reg. (EU) No 1159/2013)" : info.licence, attribution: info.attribution,
      bytes: statSync(join(RG, id, file)).size
    });
    console.log(id.padEnd(15) + " " + file.padEnd(13) + " " + info.width + "×" + info.height + " · " + info.pixelM + " m/px · " + (statSync(join(RG, id, file)).size / 1048576).toFixed(2) + " MB · " + (s2 ? info.dates.join(", ") : info.name));
  }
  writeFileSync(mf + ".tmp", JSON.stringify(meta)); renameSync(mf + ".tmp", mf);
}
