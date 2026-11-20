// Surface map (T): the body's global map as an equirectangular image, with
// your position and the body's landmarks on it. Click a landmark to select
// it. Only bodies with a real bundled global map get one; the rest say so.

import { LANDMARKS } from "../nav/targets.js";

const TEX = new URL("../../textures/", import.meta.url);

// The equirectangular map for a body: longitude −180° at the left edge,
// north at the top — the same convention as the surface data.
function mapFile(def) {
  const e = def.surfaceEntry;
  if (e && e.surfaceMap) return e.surfaceMap;                 // Venus: radar surface, not cloud tops
  if (e && e.globalMap) return e.globalMap;                   // USGS / New Horizons mosaics
  if (def.id === "earth") return "earth_bluemarble.webp";
  const look = def.lookName || def.look;
  if (typeof look === "string" && look.startsWith("map:")) return look.slice(4);
  return null;
}

export class SurfaceMap {
  constructor(root, onPick) {
    this.el = document.createElement("div");
    this.el.className = "sx-map";
    this.el.innerHTML = '<div class="sx-map-card"><div class="sx-map-head"><span class="sx-k"></span><button type="button" class="sx-btn sx-map-x" aria-label="Close map">×</button></div>' +
      '<div class="sx-map-frame"><img alt=""><div class="sx-map-pins"></div><div class="sx-map-you" aria-hidden="true"></div></div><div class="sx-map-note"></div></div>';
    root.appendChild(this.el);
    this.title = this.el.querySelector(".sx-k");
    this.img = this.el.querySelector("img");
    this.pins = this.el.querySelector(".sx-map-pins");
    this.you = this.el.querySelector(".sx-map-you");
    this.note = this.el.querySelector(".sx-map-note");
    this.frame = this.el.querySelector(".sx-map-frame");
    this.el.querySelector(".sx-map-x").addEventListener("click", () => this.close());
    this.onPick = onPick;
    this.body = null;
  }
  get isOpen() { return this.el.classList.contains("is-open"); }
  // body: the renderer body; ll: { lat, lon } of the craft or walker (or null).
  open(body, ll) {
    const def = body.def, file = mapFile(def);
    this.body = body;
    this.title.textContent = def.name.toUpperCase() + " · SURFACE MAP";
    this.pins.innerHTML = "";
    if (!file) {
      this.frame.style.display = "none";
      this.note.textContent = "No global map is bundled for " + def.name + " — its surface here is a procedural interpretation.";
    } else {
      this.frame.style.display = "";
      this.img.src = new URL(file, TEX).href;
      this.img.alt = def.name + " global map";
      for (const L of LANDMARKS.filter((x) => x.body === def.id)) {
        const b = document.createElement("button");
        b.type = "button"; b.className = "sx-map-pin"; b.title = L.name;
        b.style.left = this.x(L.lon) + "%"; b.style.top = ((90 - L.lat) / 180) * 100 + "%";
        b.innerHTML = "<span>" + L.name.replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</span>";
        b.addEventListener("click", () => { this.onPick(L); this.close(); });
        this.pins.appendChild(b);
      }
      this.note.textContent = (def.surfaceEntry && def.surfaceEntry.imagery ? def.surfaceEntry.imagery : "Global map") + " · equirectangular, 0° longitude at centre · click a landmark to select it";
    }
    this.update(ll);
    this.el.classList.add("is-open");
  }
  update(ll) {
    if (!ll) { this.you.style.display = "none"; return; }
    this.you.style.display = "";
    this.you.style.left = this.x(ll.lon) + "%";
    this.you.style.top = ((90 - ll.lat) / 180) * 100 + "%";
  }
  // Longitude → % across the image (a map centred off the prime meridian is shifted).
  x(lon) {
    const shift = (this.body && this.body.def.surfaceEntry && this.body.def.surfaceEntry.mapLonShift) || 0;
    return ((((lon + 180) / 360 - shift) % 1 + 1) % 1) * 100;
  }
  close() { this.el.classList.remove("is-open"); this.body = null; }
  dispose() { this.el.remove(); }
}
