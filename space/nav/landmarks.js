// Named places for search, travel and validation (no dependencies, so the
// validation scripts can import it too).
// Landmarks: planetocentric latitude, east-positive longitude (degrees) — the
// convention of the elevation grids and the IAU rotation models.
const W = (src) => "Wikipedia / " + src;
const G = "IAU/USGS Gazetteer of Planetary Nomenclature (nomenclature data files)";
export const LANDMARKS = [
  { body: "earth", name: "Kennedy Space Center LC-39A", aka: ["KSC", "Cape Canaveral", "LC-39A", "Launch Complex 39A"], kind: "Launch site", lat: 28.6083, lon: -80.6042, src: W("NASA KSC") },
  { body: "earth", name: "Mount Everest", aka: ["Everest", "Sagarmatha", "Chomolungma"], kind: "Summit", lat: 27.9881, lon: 86.925, src: W("Survey of Nepal / NGS") },
  { body: "earth", name: "Grand Canyon", aka: ["Grand Canyon Village"], kind: "Canyon", lat: 36.0544, lon: -112.1401, src: W("USGS GNIS") },
  { body: "earth", name: "Mauna Kea", aka: ["Maunakea"], kind: "Summit", lat: 19.8207, lon: -155.4681, src: W("USGS GNIS") },
  { body: "earth", name: "Dead Sea", kind: "Lowest land", lat: 31.5, lon: 35.5, src: W("GNS Israel") },
  // Inside the detailed region packs (search could miss them: the packs list only their top-ranked OSM places).
  { body: "earth", name: "Times Square", aka: ["Midtown Manhattan", "Midtown", "Manhattan"], kind: "Square", lat: 40.758, lon: -73.9855, src: W("OpenStreetMap / NYC DCP") },
  { body: "earth", name: "Central Park", aka: ["The Ramble", "Great Lawn"], kind: "Park", lat: 40.7812, lon: -73.9665, src: W("NYC Parks") },
  { body: "earth", name: "Central Park Reservoir", aka: ["Jacqueline Kennedy Onassis Reservoir"], kind: "Reservoir", lat: 40.7856, lon: -73.9625, src: W("NYC Parks") },
  { body: "earth", name: "Empire State Building", kind: "Building", lat: 40.7484, lon: -73.9857, src: W("USGS GNIS") },
  { body: "earth", name: "Vehicle Assembly Building", aka: ["VAB"], kind: "Building", lat: 28.5864, lon: -80.651, src: W("NASA KSC") },
  { body: "earth", name: "Mount Rainier", aka: ["Tahoma", "Columbia Crest"], kind: "Summit", lat: 46.8529, lon: -121.7604, src: W("USGS GNIS / NGS") },
  { body: "earth", name: "Longmire", aka: ["Longmire, Mount Rainier"], kind: "Forest valley", lat: 46.7501, lon: -121.8126, src: W("USGS GNIS") },
  { body: "earth", name: "Paradise, Mount Rainier", aka: ["Paradise"], kind: "Subalpine meadows", lat: 46.7865, lon: -121.7353, src: W("USGS GNIS") },
  { body: "earth", name: "Grand Canyon North Rim", aka: ["North Rim"], kind: "Canyon rim", lat: 36.1987, lon: -112.0519, src: W("USGS GNIS") },
  { body: "earth", name: "Everest Base Camp", aka: ["South Base Camp"], kind: "Base camp", lat: 28.0026, lon: 86.8528, src: W("Survey of Nepal") },
  // Elsewhere: the global base layer (land cover, roads, rivers, urban fallback).
  { body: "earth", name: "South Pole", aka: ["Geographic South Pole", "Amundsen–Scott South Pole Station", "Antarctica"], kind: "Pole", lat: -90, lon: 0, src: W("NSF / USAP") },
  { body: "earth", name: "Paris", kind: "City", lat: 48.8566, lon: 2.3522, src: W("IGN") },
  { body: "earth", name: "London", kind: "City", lat: 51.5074, lon: -0.1278, src: W("Ordnance Survey") },
  { body: "earth", name: "Tokyo", kind: "City", lat: 35.6812, lon: 139.7671, src: W("GSI Japan") },
  { body: "earth", name: "Sydney", kind: "City", lat: -33.8688, lon: 151.2093, src: W("Geoscience Australia") },
  { body: "earth", name: "Manaus", aka: ["Amazon rainforest"], kind: "City on the Amazon", lat: -3.119, lon: -60.0217, src: W("IBGE") },
  { body: "earth", name: "Black Forest", aka: ["Schwarzwald"], kind: "Forest", lat: 48.3, lon: 8.15, src: W("BKG") },
  { body: "earth", name: "Big Sur", kind: "Coast", lat: 36.2704, lon: -121.8081, src: W("USGS GNIS") },
  { body: "earth", name: "Challenger Deep", aka: ["Mariana Trench"], kind: "Ocean trench", lat: 11.3733, lon: 142.5917, src: W("GEBCO") },
  { body: "moon", name: "Apollo 11 · Tranquility Base", aka: ["Apollo 11", "Tranquility Base"], kind: "Landing site", lat: 0.67408, lon: 23.47297, src: W("LROC") },
  { body: "moon", name: "Apollo 17 · Taurus–Littrow", aka: ["Apollo 17", "Taurus-Littrow"], kind: "Landing site", lat: 20.1908, lon: 30.7717, src: W("LROC") },
  { body: "moon", name: "Tycho", aka: ["Tycho crater"], kind: "Crater", lat: -43.31, lon: -11.36, src: W("IAU Gazetteer of Planetary Nomenclature") },
  { body: "moon", name: "Copernicus", aka: ["Copernicus crater"], kind: "Crater", lat: 9.62, lon: -20.08, src: W("IAU Gazetteer of Planetary Nomenclature") },
  { body: "moon", name: "Shackleton", aka: ["Shackleton crater", "lunar south pole"], kind: "Crater", lat: -89.67, lon: 129.78, src: W("IAU Gazetteer of Planetary Nomenclature") },
  { body: "mars", name: "Olympus Mons", kind: "Volcano", lat: 18.65, lon: -133.8, src: W("IAU Gazetteer of Planetary Nomenclature") },
  { body: "mars", name: "Gale crater", aka: ["Gale", "Curiosity", "Aeolis Mons", "Mount Sharp"], kind: "Crater · Curiosity rover", lat: -5.4, lon: 137.8, src: W("IAU Gazetteer of Planetary Nomenclature") },
  { body: "mars", name: "Jezero crater", aka: ["Jezero", "Perseverance"], kind: "Crater · Perseverance rover", lat: 18.38, lon: 77.58, src: W("IAU Gazetteer of Planetary Nomenclature") },
  { body: "mars", name: "Hellas Planitia", aka: ["Hellas", "Hellas basin"], kind: "Impact basin", lat: -42.4, lon: 70.5, src: W("IAU Gazetteer of Planetary Nomenclature") },
  { body: "mars", name: "Valles Marineris", kind: "Canyon system", lat: -14.006, lon: -58.588, src: W("IAU Gazetteer of Planetary Nomenclature") },
  // Below: centres taken directly from the IAU/USGS Gazetteer data files
  // (asc-planetarynames-data, *_nomenclature_center_pts), east-positive.
  { body: "mars", name: "Elysium Mons", kind: "Volcano", lat: 25.023, lon: 147.214, src: G },
  { body: "mars", name: "Noctis Labyrinthus", kind: "Canyon maze", lat: -6.362, lon: -101.189, src: G },
  { body: "mars", name: "Arsia Mons", aka: ["Tharsis"], kind: "Volcano · Tharsis", lat: -8.257, lon: -120.092, src: G },
  { body: "mercury", name: "Caloris Planitia", aka: ["Caloris Basin", "Caloris"], kind: "Impact basin", lat: 31.652, lon: 161.985, src: G },
  { body: "mercury", name: "Rembrandt", aka: ["Rembrandt basin"], kind: "Impact basin", lat: -32.892, lon: 87.866, src: G },
  { body: "mercury", name: "Rachmaninoff", kind: "Peak-ring basin", lat: 27.661, lon: 57.37, src: G },
  { body: "venus", name: "Maxwell Montes", kind: "Mountains · highland", lat: 65.2, lon: 3.3, src: G },
  { body: "venus", name: "Atalanta Planitia", kind: "Lowland plain", lat: 45.6, lon: 165.8, src: G },
  { body: "ceres", name: "Occator", kind: "Crater · bright faculae", lat: 19.819, lon: -120.665, src: G },
  { body: "ceres", name: "Ahuna Mons", kind: "Cryovolcano", lat: -10.478, lon: -43.8, src: G },
  { body: "ceres", name: "Kerwan", kind: "Impact basin", lat: -10.767, lon: 123.987, src: G },
  { body: "ceres", name: "Vendimia Planitia", kind: "Plain", lat: 23, lon: 135, src: G },
  // Vesta: the Gazetteer uses the IAU "Claudia double-prime" system (crater
  // Claudia at 146° E). The Dawn DTM is in the same system: all 42 Gazetteer
  // craters ≥ 20 km are depressions in it at zero offset, against a median
  // of 52% at other offsets (scripts/planetary/validate-landmarks.mjs --vesta).
  { body: "vesta", name: "Rheasilvia", kind: "Impact basin", lat: -71.951, lon: 86.303, src: G },
  { body: "vesta", name: "Veneneia", kind: "Impact basin", lat: -47.932, lon: -54.324, src: G },
  { body: "vesta", name: "Divalia Fossae", kind: "Equatorial troughs", lat: -9.053, lon: -163.77, src: G },
  { body: "vesta", name: "Saturnalia Fossae", kind: "Troughs", lat: 28.051, lon: 37.055, src: G },
  { body: "vesta", name: "Marcia", aka: ["Snowman"], kind: "Crater", lat: 8.979, lon: -20.452, src: G },
  { body: "pluto", name: "Sputnik Planitia", kind: "Nitrogen-ice basin", lat: 19.51, lon: 178.69, src: G },
  { body: "pluto", name: "Tenzing Montes", kind: "Mountains", lat: -15.61, lon: 177.38, src: G },
  { body: "pluto", name: "Hillary Montes", kind: "Mountains", lat: 3.26, lon: 169.58, src: G },
  { body: "charon", name: "Argo Chasma", kind: "Canyon", lat: 27.8, lon: 80.4, src: G },
  { body: "europa", name: "Conamara Chaos", kind: "Chaos terrain", lat: 9.7, lon: 87.3, src: G },
  { body: "europa", name: "Pwyll", kind: "Crater", lat: -25.2, lon: 88.6, src: G },
  { body: "io", name: "Loki Patera", kind: "Volcanic depression", lat: 13.008, lon: 51.214, src: G },
  { body: "io", name: "Pele", kind: "Eruptive centre", lat: -18.71, lon: 104.72, src: G },
  { body: "io", name: "Boosaule Montes", kind: "Mountains", lat: -3.749, lon: 90.894, src: G },
  { body: "titan", name: "Kraken Mare", kind: "Hydrocarbon sea", lat: 68, lon: 50, src: G },
  { body: "titan", name: "Ligeia Mare", kind: "Hydrocarbon sea", lat: 79.7, lon: 112.1, src: G },
  { body: "titan", name: "Selk", kind: "Crater", lat: 7, lon: 161, src: G },
  { body: "enceladus", name: "Damascus Sulcus", aka: ["tiger stripes"], kind: "Tiger stripe · south polar terrain", lat: -80.59, lon: 74.13, src: G },
  { body: "enceladus", name: "Baghdad Sulcus", kind: "Tiger stripe · south polar terrain", lat: -86.91, lon: 129.46, src: G },
  { body: "mimas", name: "Herschel", kind: "Crater", lat: -1.38, lon: -111.76, src: G },
  { body: "iapetus", name: "Turgis", kind: "Impact basin", lat: 16.9, lon: -28.4, src: G },
  { body: "iapetus", name: "Engelier", kind: "Impact basin", lat: -40.5, lon: 95.3, src: G },
  { body: "triton", name: "Leviathan Patera", kind: "Volcanic depression", lat: 17, lon: 28.5, src: G },
  { body: "triton", name: "Tuonela Planitia", kind: "Plain", lat: 34, lon: 14.5, src: G }
];
