// Earth map tiles: a compact binary format for real buildings, roads and
// water on a fixed geographic grid, written by scripts/earth/build-region.mjs
// and read by the surface workers.
//
// The grid covers the whole planet: tile (iy, ix) spans latitude
// [iy·D − 90, (iy+1)·D − 90] and longitude [ix·D − 180, (ix+1)·D − 180] with
// D = 0.01° (about 1.1 × 1.0 km at mid-latitudes). Only tiles a region pack
// ships exist; the format itself is worldwide.
//
// Coordinates are int16 offsets from the tile's south-west corner in units of
// D / 16384 (about 7 cm), so a feature may reach two tiles beyond its own.
//
// Layout (little-endian):
//   "OSM1" · u16 version · u16 0 · i32 iy · i32 ix · u32 nBuildings · u32 nRoads · u32 nWater
//   building: u8 class · u8 heightSource · u16 height dm · u16 minHeight dm · u8 nRings
//             [v2: · u8 roof shape · u16 roof height dm · u8 footprint dataset]
//             · nRings × u16 count · points (i16 x, i16 y)…   (ring 0 outer, then holes)
//   road:     u8 class · u8 flags · u16 width dm (0 = class default) · u16 count · points…
//   water:    u8 kind · u8 nRings · nRings × u16 count · points…

export const TILE_DEG = 0.01;
export const Q = TILE_DEG / 16384;

export const BUILDING_CLASS = ["residential", "commercial", "industrial", "civic", "other"];
// How a building's height was found (see CREDITS.md / README).
export const HEIGHT_SOURCE = ["height tag", "levels × 3 m", "estimated from type and footprint", "procedural (global urban fallback, not mapped)", "published landmark height (reviewed override)"];
export const ROAD_CLASS = ["motorway", "trunk", "primary", "secondary", "tertiary", "residential", "unclassified", "service",
  "living_street", "pedestrian", "footway", "cycleway", "path", "steps", "track", "rail", "tram", "runway", "taxiway", "river"];
// Class 19 (river) comes only from the global base pack (Natural Earth): drawn as water.
export const ROAD_FLAGS = { bridge: 1 };
export const WATER_KIND = ["tidal", "lake", "paved", "deck"];   // tidal: burned into the elevation grid; lake: drawn as a surface;
// paved: airport aprons and runway areas; deck: piers, docks, breakwaters (raised a little)
// Version 2 (Overture packs): roof shapes from the data, and where each footprint comes from.
export const ROOF_SHAPE = ["flat", "gabled", "hipped", "pyramidal", "dome", "onion", "skillion", "round", "gambrel", "mansard", "half_hipped", "saltbox"];
export const FOOTPRINT_DATASET = ["OpenStreetMap", "Microsoft ML Buildings", "Google Open Buildings", "Esri Community Maps", "other open dataset", "procedural"];

export function tileOf(lat, lon) { return [Math.floor((lat + 90) / TILE_DEG), Math.floor((lon + 180) / TILE_DEG)]; }
export function tileBounds(iy, ix) {
  const s = iy * TILE_DEG - 90, w = ix * TILE_DEG - 180;
  return { south: s, west: w, north: s + TILE_DEG, east: w + TILE_DEG };
}
export const tileKey = (iy, ix) => iy + "_" + ix;

// features: { buildings: [{cls, src, h, minH, rings: [[[lat, lon], …], …]}],
//             roads: [{cls, flags, width, pts: [[lat, lon], …]}], water: [{kind, rings}] }
export function encodeTile(iy, ix, f, version = 1) {
  const b = tileBounds(iy, ix);
  const q = (lat, lon) => [Math.max(-32768, Math.min(32767, Math.round((lon - b.west) / Q))), Math.max(-32768, Math.min(32767, Math.round((lat - b.south) / Q)))];
  let size = 32;
  for (const x of f.buildings) size += 7 + (version >= 2 ? 4 : 0) + x.rings.reduce((s, r) => s + 2 + r.length * 4, 0);
  for (const x of f.roads) size += 6 + x.pts.length * 4;
  for (const x of f.water) size += 2 + x.rings.reduce((s, r) => s + 2 + r.length * 4, 0);
  const buf = new ArrayBuffer(size), v = new DataView(buf);
  let o = 0;
  const u8 = (x) => { v.setUint8(o, x); o += 1; }, u16 = (x) => { v.setUint16(o, x, true); o += 2; }, i16 = (x) => { v.setInt16(o, x, true); o += 2; };
  const u32 = (x) => { v.setUint32(o, x, true); o += 4; }, i32 = (x) => { v.setInt32(o, x, true); o += 4; };
  for (const c of "OSM1") u8(c.charCodeAt(0));
  u16(version); u16(0); i32(iy); i32(ix); u32(f.buildings.length); u32(f.roads.length); u32(f.water.length);
  const pts = (list) => { for (const [la, lo] of list) { const [x, y] = q(la, lo); i16(x); i16(y); } };
  for (const x of f.buildings) {
    u8(x.cls); u8(x.src); u16(Math.min(65535, Math.round(x.h * 10))); u16(Math.min(65535, Math.round((x.minH || 0) * 10))); u8(x.rings.length);
    if (version >= 2) { u8(x.roof || 0); u16(Math.min(65535, Math.round((x.roofH || 0) * 10))); u8(x.ds ?? 0); }
    for (const r of x.rings) u16(r.length);
    for (const r of x.rings) pts(r);
  }
  for (const x of f.roads) { u8(x.cls); u8(x.flags || 0); u16(Math.round((x.width || 0) * 10)); u16(x.pts.length); pts(x.pts); }
  for (const x of f.water) { u8(x.kind); u8(x.rings.length); for (const r of x.rings) u16(r.length); for (const r of x.rings) pts(r); }
  return new Uint8Array(buf, 0, o);
}

// → { iy, ix, bounds, buildings: [{cls, src, h, minH, rings: [Float64Array [lat, lon, …], …]}], roads, water }
export function decodeTile(buf) {
  const v = new DataView(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength);
  let o = 0;
  const u8 = () => v.getUint8(o++), u16 = () => { const x = v.getUint16(o, true); o += 2; return x; }, i16 = () => { const x = v.getInt16(o, true); o += 2; return x; };
  const u32 = () => { const x = v.getUint32(o, true); o += 4; return x; }, i32 = () => { const x = v.getInt32(o, true); o += 4; return x; };
  const magic = String.fromCharCode(u8(), u8(), u8(), u8());
  if (magic !== "OSM1") throw new Error("not a map tile");
  const version = u16(); u16();
  const iy = i32(), ix = i32(), nB = u32(), nR = u32(), nW = u32();
  const b = tileBounds(iy, ix);
  const pts = (n) => { const a = new Float64Array(n * 2); for (let i = 0; i < n; i++) { const x = i16(), y = i16(); a[i * 2] = b.south + y * Q; a[i * 2 + 1] = b.west + x * Q; } return a; };
  const rings = (k) => { const ns = []; for (let i = 0; i < k; i++) ns.push(u16()); return ns.map(pts); };
  const buildings = [], roads = [], water = [];
  for (let i = 0; i < nB; i++) {
    const cls = u8(), src = u8(), h = u16() / 10, minH = u16() / 10, k = u8();
    let roof = 0, roofH = 0, ds = 0;
    if (version >= 2) { roof = u8(); roofH = u16() / 10; ds = u8(); }
    buildings.push({ cls, src, h, minH, roof, roofH, ds, rings: rings(k) });
  }
  for (let i = 0; i < nR; i++) { const cls = u8(), flags = u8(), width = u16() / 10, n = u16(); roads.push({ cls, flags, width, pts: pts(n) }); }
  for (let i = 0; i < nW; i++) { const kind = u8(), k = u8(); water.push({ kind, rings: rings(k) }); }
  return { iy, ix, bounds: b, buildings, roads, water };
}
