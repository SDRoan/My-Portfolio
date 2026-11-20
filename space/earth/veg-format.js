// Vegetation pack format, shared by the builder (scripts/earth/build-vegetation.mjs),
// the surface workers (veg-core.js) and the main thread (vegetation.js).
//
// grid: one byte per VEG_CELL × VEG_CELL degrees, rows from the north:
//   class << 4 | density, density 0–15 = tree canopy 0–100 %.
// Classes 1–11 are ESA WorldCover classes; 12–15 are OpenStreetMap areas that
// refine them (a mapped wood, park, lawn or scrub); 0 is kept clear (mapped
// parking, aprons, piers, the launch site) or has no data.

export const VEG_CELL = 0.0002;
export const CLASS = { none: 0, tree: 1, shrub: 2, grass: 3, crop: 4, built: 5, bare: 6, snow: 7, water: 8, wetland: 9, mangrove: 10, moss: 11,
  forest: 12, park: 13, lawn: 14, scrub: 15 };
export const CLASS_NAMES = ["clear", "tree cover", "shrubland", "grassland", "cropland", "built-up", "bare / sparse", "snow and ice", "permanent water",
  "herbaceous wetland", "mangroves", "moss and lichen", "mapped wood / forest (OSM)", "mapped park / garden (OSM)", "mapped grass / lawn (OSM)", "mapped scrub / heath (OSM)"];

// Exact OSM trees: int32 lat·1e7, int32 lon·1e7, u16 height dm, u16 crown dm,
// u16 trunk diameter cm, u8 family hint, u8 leaf cycle, u16 info string, u32 OSM id (low 32 bits).
export const TREE_BYTES = 22;
export const FAMILY_HINT = { unknown: 0, broad: 1, needle: 2, palm: 3, mangrove: 4 };
export const LEAF_CYCLE = { deciduous: 1, evergreen: 2, semi_deciduous: 3, semi_evergreen: 4, mixed: 5 };

export function decodeTrees(u8) {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), n = v.getUint32(0, true), out = [];
  for (let i = 0, o = 4; i < n; i++, o += TREE_BYTES) {
    out.push({ lat: v.getInt32(o, true) / 1e7, lon: v.getInt32(o + 4, true) / 1e7, h: v.getUint16(o + 8, true) / 10, crown: v.getUint16(o + 10, true) / 10,
      trunk: v.getUint16(o + 12, true) / 100, hint: v.getUint8(o + 14), cycle: v.getUint8(o + 15), info: v.getUint16(o + 16, true), id: v.getUint32(o + 18, true) });
  }
  return out;
}
