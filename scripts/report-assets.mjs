// Runtime asset report: sizes, duplicates, unreferenced files, compression.
//
//   node scripts/report-assets.mjs [--requested <urls.txt>]
//
// "Referenced" means named by something the simulator loads: the surface
// manifest (grids, coverage masks, patches, tile sets, maps), the tile-set
// indexes, the Earth region index and metas, the catalogue JSON, or a string
// literal in the simulator's code or index.html. With --requested, also lists
// files no recorded test route ever fetched (one URL per line).

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const files = ["space/data", "textures", "data/astronomy"].flatMap((d) => walk(join(ROOT, d))).filter((f) => !/\/\.DS_Store$/.test(f));
const rel = (f) => relative(ROOT, f);

// ── referenced set ──
const ref = new Set();
const S = "space/data/surfaces/", R = "space/data/earth/regions/";
const man = JSON.parse(readFileSync(join(ROOT, S, "manifest.json"), "utf8"));
ref.add(S + "manifest.json");
for (const e of Object.values(man.bodies)) {
  const t = e.terrain || {};
  if (t.file) ref.add(S + t.file);
  if (t.coverage) ref.add(S + t.coverage.file);
  for (const p of t.patches || []) ref.add(S + p.file);
  if (t.tileSet) {
    ref.add(S + t.tileSet);
    const ix = JSON.parse(readFileSync(join(ROOT, S, t.tileSet), "utf8"));
    if (ix.bundles) for (const k of Object.keys(ix.bundles)) ref.add(S + "tiles/" + e.id + "/" + k + ".bin");
    else for (const k of Object.keys(ix.tiles)) ref.add(S + "tiles/" + e.id + "/" + k + ".i16.gz");
  }
  for (const m of [e.globalMap, e.surfaceMap]) if (m) ref.add("textures/" + m);
}
if (existsSync(join(ROOT, R, "index.json"))) {
  ref.add(R + "index.json");
  for (const r of JSON.parse(readFileSync(join(ROOT, R, "index.json"), "utf8")).regions) {
    const m = JSON.parse(readFileSync(join(ROOT, R, r.id, "meta.json"), "utf8"));
    ref.add(R + r.id + "/meta.json");
    for (const d of m.dem) ref.add(R + r.id + "/" + d.file);
    for (const i of m.imagery) ref.add(R + r.id + "/" + i.file);
    if (m.bundles) for (const k of Object.keys(m.bundles)) ref.add(R + r.id + "/t/" + k + ".bin");
    else for (const k of Object.keys(m.tiles)) ref.add(R + r.id + "/t/" + k + ".bin.gz");
  }
}
// String literals in code and the page.
const code = [...walk(join(ROOT, "space")).filter((f) => f.endsWith(".js")), join(ROOT, "index.html"), ...readdirSync(ROOT).filter((f) => f.endsWith(".js")).map((f) => join(ROOT, f))].map((f) => readFileSync(f, "utf8")).join("\n");
for (const f of files) {
  const r = rel(f), base = r.split("/").pop();
  if (ref.has(r)) continue;
  if (r.startsWith("data/astronomy/") && code.includes(base.replace(/\.json$/, ""))) ref.add(r);
  else if (r.startsWith("textures/") && code.includes(base)) ref.add(r);
  else if (/\.json$/.test(base) && /-(elevation|tiles|imagery)\.json$/.test(base)) ref.add(r + " (build metadata)");
}

// ── report ──
const info = files.map((f) => ({ f: rel(f), size: statSync(f).size }));
const total = info.reduce((s, x) => s + x.size, 0);
const mb = (b) => (b / 1048576).toFixed(2) + " MB";
const out = [];
out.push("Runtime assets: " + info.length + " files, " + mb(total));
const byDir = {};
for (const x of info) { const d = x.f.split("/").slice(0, x.f.startsWith("space/data/surfaces/tiles") || x.f.startsWith("space/data/earth/regions") ? 5 : 3).join("/"); byDir[d] = byDir[d] || [0, 0]; byDir[d][0]++; byDir[d][1] += x.size; }
out.push("\nBy folder:"); for (const [d, [n, s]] of Object.entries(byDir).sort((a, b) => b[1][1] - a[1][1])) out.push("  " + mb(s).padStart(10) + "  " + String(n).padStart(5) + " files  " + d);
out.push("\nTop 50:"); for (const x of info.slice().sort((a, b) => b.size - a.size).slice(0, 50)) out.push("  " + mb(x.size).padStart(10) + "  " + x.f);
const hashes = new Map();
for (const x of info) { const h = createHash("sha1").update(readFileSync(join(ROOT, x.f))).digest("hex"); if (!hashes.has(h)) hashes.set(h, []); hashes.get(h).push(x); }
const dups = [...hashes.values()].filter((l) => l.length > 1 && l[0].size > 1024);
out.push("\nDuplicate files (same bytes): " + (dups.length ? "" : "none"));
for (const l of dups) out.push("  " + mb(l[0].size) + "  " + l.map((x) => x.f).join("  =  "));
const unused = info.filter((x) => !ref.has(x.f) && ![...ref].some((r) => r.startsWith(x.f + " ")));
out.push("\nNot referenced by the simulator or page: " + (unused.length ? unused.length + " files, " + mb(unused.reduce((s, x) => s + x.size, 0)) : "none"));
for (const x of unused.slice(0, 60)) out.push("  " + mb(x.size).padStart(10) + "  " + x.f);
// Compression of the gzipped grids.
let gzIn = 0, gzOut = 0;
for (const x of info) if (x.f.endsWith(".gz")) { gzOut += x.size; try { gzIn += gunzipSync(readFileSync(join(ROOT, x.f))).length; } catch (e) { /* not gzip */ } }
out.push("\nGzipped grids/tiles: " + mb(gzOut) + " on disk, " + mb(gzIn) + " raw (ratio " + (gzIn / Math.max(1, gzOut)).toFixed(2) + ")");
const i = process.argv.indexOf("--requested");
if (i > 0) {
  const req = new Set(readFileSync(process.argv[i + 1], "utf8").split("\n").map((u) => { try { return decodeURIComponent(new URL(u).pathname).replace(/^\/(My-Portfolio\/)?/, ""); } catch (e) { return ""; } }));
  const never = info.filter((x) => !req.has(x.f));
  out.push("\nNever requested on the recorded routes: " + never.length + " files, " + mb(never.reduce((s, x) => s + x.size, 0)) + " (expected: data for places the routes don't visit)");
}
console.log(out.join("\n"));
