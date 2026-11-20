// Fetches ESA WorldCover 10 m 2021 v200 at reduced resolution for the whole
// planet: one internal overview (level 5, 1125 × 1125 px per 3° tile, ≈ 300 m)
// of each of the 2651 public COGs on AWS, by HTTP range requests — about
// 0.4 % of the full product. Cached outside the repository:
//
//   node scripts/earth/fetch-global-landcover.mjs [--level=5] [--jobs=12]
//
// build-global.mjs turns the cache into the shipped global pack.

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCogOverview } from "../lib/cog.mjs";

const LEVEL = +(process.argv.find((a) => a.startsWith("--level=")) || "--level=5").split("=")[1];
const JOBS = +(process.argv.find((a) => a.startsWith("--jobs=")) || "--jobs=12").split("=")[1];
export const WC_CACHE = join(tmpdir(), "open-earth-cache", "worldcover-L" + LEVEL);
mkdirSync(WC_CACHE, { recursive: true });
const BUCKET = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/";
const UA = "portfolio-open-earth-builder/1.0 (static site preprocessing; github.com/SDRoan/My-Portfolio)";

async function fetchRange(url, a, b) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { Range: "bytes=" + a + "-" + b, "User-Agent": UA }, signal: AbortSignal.timeout(120000) });
      if (r.status !== 206) throw new Error("HTTP " + r.status);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { if (i >= 6) throw e; await new Promise((res) => setTimeout(res, 1500 * (i + 1))); }
  }
}
async function listTiles() {
  const keys = [];
  let tok = null;
  do {
    const t = await (await fetch(BUCKET + "?list-type=2&prefix=v200/2021/map/" + (tok ? "&continuation-token=" + encodeURIComponent(tok) : ""))).text();
    for (const m of t.matchAll(/<Key>(v200\/2021\/map\/ESA_WorldCover_10m_2021_v200_([NS]\d\d[EW]\d\d\d)_Map\.tif)<\/Key>/g)) keys.push({ key: m[1], name: m[2] });
    const n = t.match(/<NextContinuationToken>([^<]+)/); tok = n && n[1];
  } while (tok);
  return keys;
}

if (process.argv[1] && process.argv[1].endsWith("fetch-global-landcover.mjs")) {
  const tiles = await listTiles();
  console.log(tiles.length + " WorldCover tiles");
  let done = 0, fetched = 0, failed = [];
  const queue = tiles.filter((t) => !existsSync(join(WC_CACHE, t.name + ".u8.gz")));
  done = tiles.length - queue.length;
  const worker = async () => {
    for (let t; (t = queue.shift()); ) {
      try {
        const r = await readCogOverview(BUCKET + t.key, LEVEL, fetchRange);
        const head = Buffer.alloc(16); head.writeUInt32LE(r.W, 0); head.writeUInt32LE(r.H, 4);
        writeFileSync(join(WC_CACHE, t.name + ".u8.gz"), gzipSync(Buffer.concat([head, Buffer.from(r.data)]), { level: 6 }));
        fetched++;
      } catch (e) { failed.push(t.name + " " + e.message); }
      if (++done % 50 === 0) process.stdout.write("  " + done + "/" + tiles.length + "\n");
    }
  };
  await Promise.all(Array.from({ length: JOBS }, worker));
  console.log("fetched " + fetched + ", failed " + failed.length + (failed.length ? "\n  " + failed.join("\n  ") : ""));
}
