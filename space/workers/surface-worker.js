// Surface worker: builds terrain chunks, Earth city tiles (buildings,
// roads, water), vegetation tiles and ground cover off the main thread, from the same surface model the main
// thread uses for collision — so geometry and ground always agree.

import { Surface, buildChunk } from "../universe/surface-core.js";
import { buildCityTile } from "../earth/city-core.js";
import { placeRocks } from "../render/rock-core.js";
import { buildVegTile, buildGroundCover } from "../earth/veg-core.js";
import { synthTile } from "../earth/global-core.js";

const surfaces = new Map();

self.onmessage = (e) => {
  const { id, job, args } = e.data;
  try {
    if (job === "surface") {
      surfaces.set(args.key, Surface.from(args.surface));
      self.postMessage({ id, result: true });
    } else if (job === "delta") {
      const s = surfaces.get(args.key);
      if (s) for (const e of args.entries) s.apply(e);
      self.postMessage({ id, result: true });
    } else if (job === "chunk") {
      const s = surfaces.get(args.key);
      if (!s) throw new Error("surface " + args.key + " not synced");
      const r = buildChunk(s, args.node, args.res);
      self.postMessage({ id, result: r }, [r.P.buffer, r.N.buffer, r.D.buffer, r.E.buffer, r.B.buffer, r.index.buffer]);
    } else if (job === "rocks") {
      const s = surfaces.get(args.key);
      if (!s) throw new Error("surface " + args.key + " not synced");
      const r = placeRocks(s, args.lat, args.lon, args.style);
      self.postMessage({ id, result: r }, [r.rocks.buffer]);
    } else if (job === "city") {
      const s = surfaces.get(args.key);
      if (!s) throw new Error("surface " + args.key + " not synced");
      const r = buildCityTile(s, args.tile, args.opts);
      self.postMessage({ id, result: r }, r.transfer);
      delete r.transfer;
    } else if (job === "synth") {
      const r = synthTile(args.args);
      self.postMessage({ id, result: r }, r ? [r.tile] : []);
    } else if (job === "veg" || job === "ground") {
      const s = surfaces.get(args.key);
      if (!s) throw new Error("surface " + args.key + " not synced");
      const r = job === "veg" ? buildVegTile(s, args.args) : buildGroundCover(s, args.args);
      const tr = r.transfer; delete r.transfer;
      self.postMessage({ id, result: r }, tr);
    } else throw new Error("unknown job " + job);
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};
