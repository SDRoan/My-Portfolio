// A pool of surface workers (terrain chunks, city tiles). Each worker holds
// its own copy of a body's surface, re-sent whenever that surface changes
// (an elevation grid or regional patch arrives, a site is added). Messages
// to a worker are handled in order, so a job always sees the latest copy.
// Without module workers, the same code runs on the main thread.

import { buildChunk } from "../universe/surface-core.js";
import { buildCityTile } from "../earth/city-core.js";

import { placeRocks } from "../render/rock-core.js";
import { buildVegTile, buildGroundCover } from "../earth/veg-core.js";
import { synthTile } from "../earth/global-core.js";

// Bounded pool: 2–4 workers, at most two jobs in flight on each. Jobs wait
// in a priority queue (lower = sooner: rocks and the chunks under the
// player first, far preloads last) and are dropped unrun if they go stale
// (args.stale() returns true — a chunk merged away, a map tile no longer
// wanted).
export class SurfaceWorkers {
  constructor(size = 2) {
    this.workers = [];
    this.pending = new Map();
    this.seq = 0;
    this.queue = [];
    this.busy = [];
    this.synced = new Map();        // key → surface version sent to the workers
    this.local = new Map();         // key → surface (main-thread fallback)
    this.stats = { run: 0, dropped: 0, ms: 0 };
    try {
      for (let i = 0; i < size; i++) {
        const w = new Worker(new URL("../workers/surface-worker.js", import.meta.url), { type: "module" });
        w.onmessage = (e) => {
          const p = this.pending.get(e.data.id);
          if (!p) return;
          this.pending.delete(e.data.id);
          if (p.job) { this.busy[i]--; this.stats.run++; this.stats.ms += performance.now() - p.t0; this.pump(); }
          if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data.result);
        };
        w.onerror = (e) => { console.warn("[space] surface worker failed; building on the main thread", e.message); this.fallback = true; };
        this.workers.push(w); this.busy.push(0);
      }
    } catch (e) { this.fallback = true; }
  }
  get inflight() { return this.queue.length + this.busy.reduce((a, b) => a + b, 0); }
  post(w, job, args, transfer) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage({ id, job, args }, transfer || []);
    });
  }
  // Make sure every worker has this version of the surface.
  // Changes recorded in surface.log since the last sync (new tiles, patches)
  // go over as small deltas; anything else sends the whole surface again.
  sync(key, surface) {
    this.local.set(key, surface);
    const v = surface.version || 0, had = this.synced.get(key);
    if (had === v) return;
    this.synced.set(key, v);
    if (this.fallback) return;
    const log = surface.log || [];
    const since = had !== undefined ? log.filter((e) => e.v > had) : [];
    if (had !== undefined && since.length === v - had) {
      for (const w of this.workers) this.post(w, "delta", { key, entries: since }).catch(() => {});
      return;
    }
    const data = surface.serialize();
    for (const w of this.workers) this.post(w, "surface", { key, surface: data }).catch(() => {});
  }
  // args.priority (default 5) and args.stale() are read here, not sent.
  run(job, args) {
    if (this.fallback || !this.workers.length) {
      return new Promise((resolve, reject) => setTimeout(() => {
        try {
          if (args.stale && args.stale()) { reject(new Error("stale")); return; }
          const s = this.local.get(args.key);
          resolve(job === "chunk" ? buildChunk(s, args.node, args.res) : job === "rocks" ? placeRocks(s, args.lat, args.lon, args.style)
            : job === "veg" ? buildVegTile(s, args.args) : job === "ground" ? buildGroundCover(s, args.args) : job === "synth" ? synthTile(args.args) : buildCityTile(s, args.tile, args.opts));
        } catch (e) { reject(e); }
      }, 0));
    }
    return new Promise((resolve, reject) => {
      const { priority = 5, stale = null, ...data } = args;
      this.queue.push({ job, data, priority, stale, resolve, reject, n: ++this.seq });
      this.pump();
    });
  }
  pump() {
    while (this.queue.length) {
      let wi = -1;
      for (let i = 0; i < this.workers.length; i++) if (this.busy[i] < 2 && (wi < 0 || this.busy[i] < this.busy[wi])) wi = i;
      if (wi < 0) return;
      // Most urgent first; ties in arrival order.
      let bi = 0;
      for (let i = 1; i < this.queue.length; i++) { const a = this.queue[i], b = this.queue[bi]; if (a.priority < b.priority || (a.priority === b.priority && a.n < b.n)) bi = i; }
      const j = this.queue.splice(bi, 1)[0];
      if (j.stale && j.stale()) { this.stats.dropped++; j.reject(new Error("stale")); continue; }
      const id = ++this.seq;
      this.pending.set(id, { resolve: j.resolve, reject: j.reject, job: true, t0: performance.now() });
      this.busy[wi]++;
      this.workers[wi].postMessage({ id, job: j.job, args: j.data });
    }
  }
  dispose() {
    this.workers.forEach((w) => w.terminate());
    this.workers = [];
    this.pending.clear();
  }
}
