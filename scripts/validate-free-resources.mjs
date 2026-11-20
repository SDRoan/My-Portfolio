// Free-only check: fails (exit 1) if anything this project needs could cost money.
//
//   node scripts/validate-free-resources.mjs
//
// 1. Every entry of space/data/licenses.json: cost FREE, billingRequired
//    false, a licence on the allow-list, a status that isn't PAID / TRIAL /
//    BILLING REQUIRED / UNCLEAR / UNKNOWN.
// 2. Runtime code (pages, scripts, styles the browser loads): every external
//    host it references for loading must be declared in licenses.json.
// 3. Everywhere (runtime and build scripts): no forbidden paid/proprietary
//    providers (Google Maps Platform / Earth / Street View / 3D Tiles, Bing,
//    Mapbox services, Cesium ion, Esri basemaps, OSM tile servers), and no
//    API keys or tokens other than NASA's public DEMO_KEY.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const M = JSON.parse(readFileSync(join(ROOT, "space", "data", "licenses.json"), "utf8"));
const problems = [], notes = [];
const bad = (s) => problems.push(s);

// 1. The manifest.
const allow = M.policy.allowedLicences.map((x) => x.toLowerCase());
for (const r of M.resources) {
  // Kept at the owner's explicit request: reported, not failed.
  if (r.ownerOverride) { notes.push("owner's choice: " + r.id + " — " + r.license + (r.note ? " · " + r.note : "")); if (r.cost !== "FREE" || r.billingRequired !== false) bad(r.id + ": costs money"); continue; }
  if (r.cost !== "FREE") bad(r.id + ": cost is " + r.cost);
  if (r.billingRequired !== false) bad(r.id + ": billing required");
  if (/PAID|TRIAL|BILLING|UNCLEAR|UNKNOWN/i.test(r.status)) bad(r.id + ": status " + r.status);
  if (!allow.some((a) => r.license.toLowerCase().includes(a.toLowerCase()))) bad(r.id + ": licence not on the allow-list: " + r.license);
  if (/credit card|billing|paid/i.test(r.accountRequired || "") && !/no billing/i.test(r.accountRequired)) bad(r.id + ": account needs payment: " + r.accountRequired);
}
const declared = new Set(M.resources.flatMap((r) => r.hosts || []));

// Files.
const SKIP = new Set([".git", "node_modules", "data", "__pycache__"]);
function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    if (SKIP.has(f)) continue;
    const p = join(dir, f), st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if ([".js", ".mjs", ".html", ".css", ".py", ".json"].includes(extname(f)) && st.size < 5e6) out.push(p);
  }
  return out;
}
const files = walk(ROOT).filter((p) => !p.includes("/vendor/") && !p.endsWith("licenses.json"));
const runtime = files.filter((p) => !p.includes("/scripts/") && /\.(js|html|css)$/.test(p));

// 3. Forbidden providers and secrets, everywhere.
const FORBIDDEN = [
  [/maps\.googleapis\.com|maps\.google\.|google\.com\/maps|tile\.googleapis\.com|earthengine|street ?view/i, "Google Maps Platform / Earth / Street View / 3D Tiles"],
  [/virtualearth\.net|bing\.com\/maps|dev\.virtualearth/i, "Bing Maps"],
  [/api\.mapbox\.com|mapbox:\/\/|tiles\.mapbox\.com/i, "Mapbox services"],
  [/cesium\.com\/ion|ion\.cesium\.com|assets\.cesium\.com/i, "Cesium ion"],
  [/arcgisonline\.com|services\.arcgis\.com\/.*World_Imagery|server\.arcgisonline/i, "Esri basemaps"],
  [/tile\.openstreetmap\.org/i, "OSM tile servers (usage policy forbids production use)"]
];
for (const p of files) {
  const t = readFileSync(p, "utf8"), rel = p.slice(ROOT.length + 1);
  for (const [re, what] of FORBIDDEN) if (re.test(t)) {
    // Mentions in comments/docs that say "not used" are fine; flag actual URLs only.
    for (const line of t.split("\n")) if (re.test(line) && /https?:\/\/|mapbox:\/\//.test(line)) bad(rel + ": references " + what + ": " + line.trim().slice(0, 120));
  }
  for (const m of t.matchAll(/(api[_-]?key|access[_-]?token|client[_-]?secret|NEO_KEY)\s*[:=]\s*["'`]([A-Za-z0-9_\-.]{8,})["'`]/gi)) if (m[2] !== "DEMO_KEY") bad(rel + ": looks like a secret (" + m[1] + ")");
  for (const m of t.matchAll(/[?&](api_key|key|access_token|token)=([A-Za-z0-9_\-]{16,})/g)) bad(rel + ": URL carries a key (" + m[1] + ")");
}

// 2. Runtime hosts.
const hostsSeen = new Map();
for (const p of runtime) {
  const t = readFileSync(p, "utf8"), rel = p.slice(ROOT.length + 1);
  // Loading contexts only (fetch, import, src, url(), stylesheet/preload links, import maps).
  for (const m of t.matchAll(/(?:fetch\(\s*|import\(\s*|from\s+|src\s*=\s*|url\(\s*|href\s*=\s*(?=["'][^"']+\.(?:css|js|woff2?|json|glb|gltf|jpg|png|webp)["'])|"three[^"]*":\s*)["'`]?(https?:\/\/[^\/"'`)\s]+)/g)) {
    const host = m[1].replace(/^https?:\/\//, "");
    if (!hostsSeen.has(host)) hostsSeen.set(host, new Set());
    hostsSeen.get(host).add(rel);
  }
}
for (const [h, where] of hostsSeen) {
  if (declared.has(h)) notes.push("runtime host " + h + " (declared) — " + [...where].join(", "));
  else bad("undeclared runtime host " + h + " in " + [...where].join(", "));
}

console.log(M.resources.length + " resources in the manifest; " + runtime.length + " runtime files and " + (files.length - runtime.length) + " other files scanned.");
for (const n of notes) console.log("  " + n);
if (problems.length) { console.log("\nFAIL — " + problems.length + " problem(s):"); for (const p of problems) console.log("  ✗ " + p); process.exit(1); }
console.log("\nPASS — every listed resource is free (no payment, no billing, no paid API), licences are on the allow-list, and the only external runtime hosts are declared ones.");
