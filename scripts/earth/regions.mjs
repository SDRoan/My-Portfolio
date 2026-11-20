// Region packs: places on Earth that get high-resolution terrain, aerial
// imagery and real map data (buildings, roads, water, places). Built by
// build-region.mjs into space/data/earth/regions/<id>/ and loaded only when
// you approach.
//
// bbox / dem / imagery boxes are in degrees (cell edges). DEM resolution is
// in arc-seconds. osm: the Geofabrik extracts (download.geofabrik.de) the map
// data is cut from.

export const REGIONS = [
  {
    id: "kennedy", osm: ["florida"], name: "Kennedy Space Center · Cape Canaveral",
    bbox: { south: 28.38, north: 28.82, west: -80.84, east: -80.52 },
    dem: [
      { name: "outer", source: "3dep", arcsec: 1, bbox: { south: 28.38, north: 28.82, west: -80.84, east: -80.52 } },
      { name: "core", source: "3dep", arcsec: 1 / 3, bbox: { south: 28.56, north: 28.66, west: -80.66, east: -80.56 } }
    ],
    imagery: [
      { name: "outer", source: "naip", px: 4000, bbox: { south: 28.38, north: 28.82, west: -80.84, east: -80.52 } },
      { name: "core", source: "naip", px: 4000, bbox: { south: 28.56, north: 28.66, west: -80.66, east: -80.56 } }
    ],
    // Our original pad replaces whatever stands at LC-39A in the map data.
    exclude: [{ lat: 28.6083, lon: -80.6042, r: 350 }],
    startup: true
  },
  {
    id: "nyc", osm: ["new-york", "new-jersey"], name: "New York City · Manhattan",
    bbox: { south: 40.695, north: 40.882, west: -74.035, east: -73.9 },
    dem: [{ name: "city", source: "3dep", arcsec: 0.5, bbox: { south: 40.695, north: 40.882, west: -74.035, east: -73.9 } }],
    imagery: [{ name: "city", source: "naip", px: 4000, bbox: { south: 40.695, north: 40.882, west: -74.035, east: -73.9 } }]
  },
  {
    id: "grand-canyon", osm: ["arizona"], name: "Grand Canyon",
    bbox: { south: 35.95, north: 36.3, west: -112.35, east: -111.95 },
    dem: [{ name: "canyon", source: "3dep", arcsec: 1, bbox: { south: 35.95, north: 36.3, west: -112.35, east: -111.95 } }],
    imagery: [{ name: "canyon", source: "naip", px: 4000, bbox: { south: 35.95, north: 36.3, west: -112.35, east: -111.95 } }]
  },
  {
    id: "rainier", osm: ["washington"], name: "Mount Rainier",
    bbox: { south: 46.75, north: 46.95, west: -121.9, east: -121.6 },
    dem: [{ name: "mountain", source: "3dep", arcsec: 1, bbox: { south: 46.75, north: 46.95, west: -121.9, east: -121.6 } }],
    imagery: [{ name: "mountain", source: "naip", px: 4000, bbox: { south: 46.75, north: 46.95, west: -121.9, east: -121.6 } }]
  },
  {
    id: "everest", osm: ["nepal"], name: "Mount Everest · Khumbu",
    bbox: { south: 27.85, north: 28.1, west: 86.75, east: 87.05 },
    dem: [{ name: "massif", source: "copernicus", arcsec: 1, bbox: { south: 27.85, north: 28.1, west: 86.75, east: 87.05 } }],
    imagery: [{ name: "massif", source: "bmng", bbox: { south: 27.6, north: 28.35, west: 86.5, east: 87.3 } }]
  },
  // ── Overture Maps regions (source: "overture") ──
  // Map data from Overture's open GeoParquet release (buildings conflated from
  // OpenStreetMap, Microsoft and Google footprints; roads, water, airports,
  // ports), elevation from Copernicus GLO-30. No aerial imagery: no free
  // high-resolution global source exists, so the global land cover shows.
  { id: "paris", source: "overture", kind: "city", name: "Paris · Seine", bbox: { south: 48.84, north: 48.878, west: 2.28, east: 2.37 },
    dem: [{ name: "area", source: "copernicus", arcsec: 1, bbox: { south: 48.84, north: 48.878, west: 2.28, east: 2.37 } }], imagery: [] },
  { id: "london", source: "overture", kind: "city", name: "London · Westminster to Tower Bridge", bbox: { south: 51.495, north: 51.515, west: -0.145, east: -0.07 },
    dem: [{ name: "area", source: "copernicus", arcsec: 1, bbox: { south: 51.495, north: 51.515, west: -0.145, east: -0.07 } }], imagery: [] },
  { id: "heathrow", source: "overture", kind: "airport", name: "London Heathrow Airport", bbox: { south: 51.455, north: 51.485, west: -0.5, east: -0.405 },
    dem: [{ name: "area", source: "copernicus", arcsec: 1, bbox: { south: 51.455, north: 51.485, west: -0.5, east: -0.405 } }], imagery: [] },
  { id: "tokyo", source: "overture", kind: "city", name: "Tokyo · Minato to Sumida", bbox: { south: 35.65, north: 35.715, west: 139.735, east: 139.815 },
    dem: [{ name: "area", source: "copernicus", arcsec: 1, bbox: { south: 35.65, north: 35.715, west: 139.735, east: 139.815 } }], imagery: [] },
  { id: "haneda", source: "overture", kind: "airport", name: "Tokyo Haneda Airport", bbox: { south: 35.52, north: 35.57, west: 139.75, east: 139.83 },
    dem: [{ name: "area", source: "copernicus", arcsec: 1, bbox: { south: 35.52, north: 35.57, west: 139.75, east: 139.83 } }], imagery: [] },
  { id: "dubai", source: "overture", kind: "city", name: "Dubai · Downtown", bbox: { south: 25.18, north: 25.215, west: 55.255, east: 55.295 },
    dem: [{ name: "area", source: "copernicus", arcsec: 1, bbox: { south: 25.18, north: 25.215, west: 55.255, east: 55.295 } }], imagery: [] },
  { id: "dubai-palm", source: "overture", kind: "city", name: "Dubai · Palm Jumeirah and Burj Al Arab", bbox: { south: 25.095, north: 25.15, west: 55.105, east: 55.195 },
    dem: [{ name: "area", source: "copernicus", arcsec: 1, bbox: { south: 25.095, north: 25.15, west: 55.105, east: 55.195 } }], imagery: [] },
  { id: "dxb", source: "overture", kind: "airport", name: "Dubai International Airport", bbox: { south: 25.232, north: 25.27, west: 55.33, east: 55.4 },
    dem: [{ name: "area", source: "copernicus", arcsec: 1, bbox: { south: 25.232, north: 25.27, west: 55.33, east: 55.4 } }], imagery: [] },
  { id: "dhaka", source: "overture", kind: "city", name: "Dhaka · Old Dhaka to Sher-e-Bangla Nagar", bbox: { south: 23.7, north: 23.77, west: 90.37, east: 90.42 },
    dem: [{ name: "area", source: "copernicus", arcsec: 1, bbox: { south: 23.7, north: 23.77, west: 90.37, east: 90.42 } }], imagery: [] },
  { id: "giza", source: "overture", kind: "city", name: "Giza Pyramids", bbox: { south: 29.965, north: 29.995, west: 31.115, east: 31.15 },
    dem: [{ name: "area", source: "copernicus", arcsec: 1, bbox: { south: 29.965, north: 29.995, west: 31.115, east: 31.15 } }], imagery: [] },
  { id: "cairo", source: "overture", kind: "city", name: "Cairo · Nile, Downtown", bbox: { south: 30.03, north: 30.06, west: 31.215, east: 31.25 },
    dem: [{ name: "area", source: "copernicus", arcsec: 1, bbox: { south: 30.03, north: 30.06, west: 31.215, east: 31.25 } }], imagery: [] },
  { id: "rio", source: "overture", kind: "city", name: "Rio de Janeiro · Corcovado to Sugarloaf", bbox: { south: -22.965, north: -22.94, west: -43.22, east: -43.15 },
    dem: [{ name: "area", source: "copernicus", arcsec: 1, bbox: { south: -22.965, north: -22.94, west: -43.22, east: -43.15 } }], imagery: [] },
  { id: "sydney", source: "overture", kind: "city", name: "Sydney Harbour", bbox: { south: -33.87, north: -33.845, west: 151.195, east: 151.225 },
    dem: [{ name: "area", source: "copernicus", arcsec: 1, bbox: { south: -33.87, north: -33.845, west: 151.195, east: 151.225 } }], imagery: [] },
  { id: "liberty", source: "overture", kind: "landmark", name: "Liberty Island · Statue of Liberty", bbox: { south: 40.684, north: 40.696, west: -74.052, east: -74.036 },
    dem: [{ name: "area", source: "copernicus", arcsec: 1, bbox: { south: 40.684, north: 40.696, west: -74.052, east: -74.036 } }], imagery: [] },
  { id: "jfk", source: "overture", kind: "airport", name: "New York JFK Airport", bbox: { south: 40.62, north: 40.665, west: -73.83, east: -73.75 },
    dem: [{ name: "area", source: "copernicus", arcsec: 1, bbox: { south: 40.62, north: 40.665, west: -73.83, east: -73.75 } }], imagery: [] },
  { id: "lax", source: "overture", kind: "airport", name: "Los Angeles International Airport", bbox: { south: 33.925, north: 33.955, west: -118.44, east: -118.375 },
    dem: [{ name: "area", source: "copernicus", arcsec: 1, bbox: { south: 33.925, north: 33.955, west: -118.44, east: -118.375 } }], imagery: [] },
  { id: "port-la", source: "overture", kind: "port", name: "Port of Los Angeles", bbox: { south: 33.705, north: 33.77, west: -118.29, east: -118.205 },
    dem: [{ name: "area", source: "copernicus", arcsec: 1, bbox: { south: 33.705, north: 33.77, west: -118.29, east: -118.205 } }], imagery: [] },
  { id: "rotterdam", source: "overture", kind: "port", name: "Port of Rotterdam · Maasvlakte", bbox: { south: 51.94, north: 51.98, west: 4.0, east: 4.08 },
    dem: [{ name: "area", source: "copernicus", arcsec: 1, bbox: { south: 51.94, north: 51.98, west: 4.0, east: 4.08 } }], imagery: [] },
  { id: "singapore-port", source: "overture", kind: "port", name: "Port of Singapore · Pasir Panjang", bbox: { south: 1.265, north: 1.3, west: 103.75, east: 103.8 },
    dem: [{ name: "area", source: "copernicus", arcsec: 1, bbox: { south: 1.265, north: 1.3, west: 103.75, east: 103.8 } }], imagery: [] },
  // Peaks: Copernicus GLO-30 elevation only (no map data), so the summit is real.
  { id: "kilimanjaro", source: "dem-only", kind: "mountain", name: "Mount Kilimanjaro", bbox: { south: -3.196, north: -2.956, west: 37.233, east: 37.473 },
    dem: [{ name: "massif", source: "copernicus", arcsec: 1, bbox: { south: -3.196, north: -2.956, west: 37.233, east: 37.473 } }], imagery: [] },
  { id: "fuji", source: "dem-only", kind: "mountain", name: "Mount Fuji", bbox: { south: 35.241, north: 35.481, west: 138.607, east: 138.847 },
    dem: [{ name: "massif", source: "copernicus", arcsec: 1, bbox: { south: 35.241, north: 35.481, west: 138.607, east: 138.847 } }], imagery: [] },
  { id: "denali", source: "dem-only", kind: "mountain", name: "Denali", bbox: { south: 62.949, north: 63.189, west: -151.127, east: -150.887 },
    dem: [{ name: "massif", source: "copernicus", arcsec: 1, bbox: { south: 62.949, north: 63.189, west: -151.127, east: -150.887 } }], imagery: [] },
  { id: "aconcagua", source: "dem-only", kind: "mountain", name: "Aconcagua", bbox: { south: -32.773, north: -32.533, west: -70.131, east: -69.891 },
    dem: [{ name: "massif", source: "copernicus", arcsec: 1, bbox: { south: -32.773, north: -32.533, west: -70.131, east: -69.891 } }], imagery: [] },
  { id: "mont-blanc", source: "dem-only", kind: "mountain", name: "Mont Blanc", bbox: { south: 45.713, north: 45.953, west: 6.745, east: 6.985 },
    dem: [{ name: "massif", source: "copernicus", arcsec: 1, bbox: { south: 45.713, north: 45.953, west: 6.745, east: 6.985 } }], imagery: [] },
  { id: "matterhorn", source: "dem-only", kind: "mountain", name: "Matterhorn", bbox: { south: 45.857, north: 46.097, west: 7.538, east: 7.779 },
    dem: [{ name: "massif", source: "copernicus", arcsec: 1, bbox: { south: 45.857, north: 46.097, west: 7.538, east: 7.779 } }], imagery: [] },
  { id: "k2", source: "dem-only", kind: "mountain", name: "K2", bbox: { south: 35.761, north: 36.001, west: 76.395, east: 76.636 },
    dem: [{ name: "massif", source: "copernicus", arcsec: 1, bbox: { south: 35.761, north: 36.001, west: 76.395, east: 76.636 } }], imagery: [] },
];

// Worldwide cells (scripts/earth/world-cells.json): each becomes a standard
// Overture + Copernicus GLO-30 region, so any place on Earth is one entry away.
import { readFileSync as _rf } from "node:fs";
const _cells = JSON.parse(_rf(new URL("./world-cells.json", import.meta.url), "utf8")).cells;
for (const c of _cells) {
  const dLat = c.sizeKm / 2 / 111.32, dLon = c.sizeKm / 2 / (111.32 * Math.cos(c.lat * Math.PI / 180));
  const bbox = { south: +(c.lat - dLat).toFixed(5), north: +(c.lat + dLat).toFixed(5), west: +(c.lon - dLon).toFixed(5), east: +(c.lon + dLon).toFixed(5) };
  REGIONS.push({ id: c.id, source: "overture", kind: c.kind, name: c.name, bbox, world: true, dem: [{ name: "area", source: "copernicus", arcsec: 1, bbox }], imagery: [] });
}

