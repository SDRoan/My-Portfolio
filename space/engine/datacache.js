// A bounded, persistent cache for the static data packs (map-tile bundles,
// elevation grids, vegetation packs), in the browser's Cache Storage.
//
// - Bounded: at most `limit` bytes (300 MB on desktop, 150 MB on phones),
//   least-recently-used entries evicted first. It never grows without limit.
// - Versioned: keyed by the site build (version.json), so a new build never
//   serves stale packs; the previous build's cache is deleted.
// - Optional: anywhere Cache Storage is missing or refused (private windows,
//   file://, quota), it simply falls through to the network.
// The index (url → size, last use) lives in localStorage: a few KB.

const NAME = "sx-data-";
const INDEX = "sx-data-index-v1";
let ready = null, cache = null, index = null, limit = 300 * 1048576, dirty = 0;

function isMobile() { try { return matchMedia("(pointer: coarse)").matches || Math.min(screen.width, screen.height) < 600; } catch (e) { return false; } }

function open() {
  if (ready) return ready;
  ready = (async () => {
    if (typeof caches === "undefined" || !/^https?:$/.test(location.protocol)) return null;
    try {
      if (isMobile()) limit = 150 * 1048576;
      let build = "dev";
      try { build = (await (await fetch(new URL("../../version.json", import.meta.url), { cache: "no-store" })).json()).build || "dev"; } catch (e) { /* offline */ }
      for (const k of await caches.keys()) if (k.startsWith(NAME) && k !== NAME + build) await caches.delete(k);
      cache = await caches.open(NAME + build);
      try { const j = JSON.parse(localStorage.getItem(INDEX) || "null"); index = j && j.build === build ? j : { build, entries: {} }; } catch (e) { index = { build, entries: {} }; }
      return cache;
    } catch (e) { cache = null; return null; }
  })();
  return ready;
}

function save() {
  if (dirty++ % 8) return;                          // every 8th change; cheap enough
  try { localStorage.setItem(INDEX, JSON.stringify(index)); } catch (e) { /* storage full or blocked */ }
}

async function evict() {
  let total = 0;
  const list = Object.entries(index.entries);
  for (const [, e] of list) total += e.n;
  if (total <= limit) return;
  list.sort((a, b) => a[1].t - b[1].t);              // least recently used first
  for (const [url, e] of list) {
    if (total <= limit * 0.85) break;
    try { await cache.delete(url); } catch (e2) { /* gone already */ }
    delete index.entries[url]; total -= e.n;
  }
  dirty = 0; save();
}

// fetch() for immutable-per-build data: from the cache if present, else the
// network (then stored). Returns an ArrayBuffer.
export async function cachedBytes(url) {
  const key = String(url);
  const c = await open();
  if (c) {
    try {
      const hit = await c.match(key);
      if (hit) { const e = index.entries[key]; if (e) { e.t = Date.now(); save(); } return await hit.arrayBuffer(); }
    } catch (e) { /* fall through */ }
  }
  const r = await fetch(key);
  if (!r.ok) throw new Error("HTTP " + r.status + " " + key);
  const buf = await r.arrayBuffer();
  if (c) {
    try {
      await c.put(key, new Response(buf.slice(0), { headers: { "Content-Type": "application/octet-stream" } }));
      index.entries[key] = { n: buf.byteLength, t: Date.now() };
      save();
      evict();
    } catch (e) { /* quota: just don't cache */ }
  }
  return buf;
}

// For the settings panel / debug overlay.
export function cacheStats() {
  if (!index) return { bytes: 0, entries: 0, limit };
  let n = 0; for (const e of Object.values(index.entries)) n += e.n;
  return { bytes: n, entries: Object.keys(index.entries).length, limit };
}
