// A small pool of module workers for procedural generation. If module workers
// aren't available, jobs run on the main thread instead — slower, still right.

import { generateCell } from "../universe/sectorgen.js";
import { generateCloud } from "../universe/galaxymodel.js";

export class WorkerPool {
  constructor(size) {
    this.workers = [];
    this.pending = new Map();
    this.seq = 0;
    this.rr = 0;
    try {
      for (let i = 0; i < size; i++) {
        const w = new Worker(new URL("../workers/universe-worker.js", import.meta.url), { type: "module" });
        w.onmessage = (e) => {
          const p = this.pending.get(e.data.id);
          if (!p) return;
          this.pending.delete(e.data.id);
          if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data.result);
        };
        w.onerror = () => { this.fallback = true; };
        this.workers.push(w);
      }
    } catch (e) {
      this.fallback = true;
    }
  }
  run(job, args) {
    if (this.fallback || !this.workers.length) {
      return new Promise((resolve, reject) => setTimeout(() => {
        try { resolve(job === "cell" ? generateCell(args) : generateCloud(args.params, args.count)); }
        catch (e) { reject(e); }
      }, 0));
    }
    const id = ++this.seq;
    const w = this.workers[this.rr++ % this.workers.length];
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage({ id, job, args });
    });
  }
  dispose() {
    this.workers.forEach((w) => w.terminate());
    this.workers = [];
    this.pending.clear();
  }
}
