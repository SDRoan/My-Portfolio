// Off-main-thread generation: star sector cells and galaxy particle clouds.
// Results come back as transferable typed arrays.

import { generateCell } from "../universe/sectorgen.js";
import { generateCloud } from "../universe/galaxymodel.js";

self.onmessage = (e) => {
  const { id, job, args } = e.data;
  try {
    if (job === "cell") {
      const r = generateCell(args);
      self.postMessage({ id, result: r }, [r.pos.buffer, r.absMag.buffer, r.teff.buffer, r.cls.buffer, r.seed.buffer]);
    } else if (job === "cloud") {
      const r = generateCloud(args.params, args.count);
      self.postMessage({ id, result: r }, [r.pos.buffer, r.col.buffer, r.lum.buffer, r.size.buffer, r.dpos.buffer, r.dsize.buffer, r.dop.buffer]);
    }
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
