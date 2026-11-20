"""Exports Overture Maps features for one region box to a compact JSON file
that build-region.mjs turns into map tiles (instead of a Geofabrik extract).

  python3 scripts/earth/export-overture.py <id> <south> <west> <north> <east> <out.json.gz>

Requires the duckdb Python package (pip install duckdb). No key or account:
Overture's GeoParquet release is public on AWS (s3://overturemaps-us-west-2).
Only the files whose bounding boxes overlap the region are opened — found
through Overture's STAC catalogue (stac.overturemaps.org) — and within them
DuckDB reads only the row groups whose bbox statistics overlap, by HTTP range
requests. A city box takes seconds to a few minutes.

Exported (geometry as GeoJSON coordinates, lon/lat):
  buildings       Overture buildings theme: OpenStreetMap, Microsoft ML
                  footprints, Google Open Buildings, Esri community maps —
                  already conflated by Overture (one record per building).
                  height, min_height, num_floors, roof shape/height/direction,
                  class, the source dataset
  parts           building parts (drawn instead of outlines that have them)
  segments        transportation: roads, rail (and their bridge/tunnel flags,
                  widths, levels)
  water           base water polygons and lines (rivers, lakes, reservoirs, sea)
  infrastructure  airports (runways, taxiways, aprons, helipads), ports and
                  waterfronts (piers, breakwaters, docks), bridges
  land_use        parks, forests, grass, farmland, orchards, … (vegetation)
"""
import duckdb, json, gzip, os, sys, time, urllib.request

REL = os.environ.get("OVERTURE_RELEASE", "2026-10-21.0")
CACHE = os.path.join(os.environ.get("TMPDIR", "/tmp"), "open-earth-cache")
os.makedirs(CACHE, exist_ok=True)
UA = {"User-Agent": "portfolio-open-earth-builder/1.0 (static site preprocessing; github.com/SDRoan/My-Portfolio)"}

def stac_index():
    f = os.path.join(CACHE, "overture-stac-" + REL + ".json")
    if os.path.exists(f):
        return json.load(open(f))
    import concurrent.futures as cf
    def get(u):
        for k in range(5):
            try:
                return json.load(urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=60))
            except Exception as e:
                err = e
                time.sleep(2 * (k + 1))
        raise err
    out = {}
    for theme, typ in [("buildings", "building"), ("buildings", "building_part"), ("transportation", "segment"), ("base", "water"), ("base", "infrastructure"), ("base", "land_use")]:
        c = get(f"https://stac.overturemaps.org/{REL}/{theme}/{typ}/collection.json")
        items = [l["href"] for l in c["links"] if l["rel"] == "item"]
        with cf.ThreadPoolExecutor(16) as ex:
            its = list(ex.map(get, items))
        out[typ] = [[i["bbox"], i["assets"]["aws"]["href"].replace("https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/", "s3://overturemaps-us-west-2/")] for i in its]
    json.dump(out, open(f, "w"))
    return out

def main():
    rid, S, W, N, E, out = sys.argv[1], *map(float, sys.argv[2:6]), sys.argv[6]
    idx = stac_index()
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';")
    def files(t):
        return [f for b, f in idx[t] if b[0] <= E and b[2] >= W and b[1] <= N and b[3] >= S]
    where = f"bbox.xmin < {E} AND bbox.xmax > {W} AND bbox.ymin < {N} AND bbox.ymax > {S}"
    geo = "ST_AsGeoJSON(geometry)"
    res = {"release": REL, "id": rid, "bbox": [S, W, N, E]}
    t0 = time.time()
    def q(t, cols, extra=""):
        fs = files(t)
        if not fs:
            return []
        return con.execute(f"SELECT {cols}, {geo} FROM read_parquet({fs}) WHERE {where} {extra}").fetchall()
    bcols = "id, names.primary, height, min_height, num_floors, roof_shape, roof_height, roof_direction, class, subtype, sources[1].dataset, has_parts, is_underground"
    res["buildings"] = [list(r[:-1]) + [json.loads(r[-1])] for r in q("building", bcols)]
    res["parts"] = [list(r[:-1]) + [json.loads(r[-1])] for r in q("building_part", "building_id, height, min_height, num_floors, roof_shape, roof_height, roof_direction, is_underground")]
    seg = q("segment", "subtype, class, names.primary, to_json(road_flags), to_json(rail_flags), to_json(width_rules), to_json(level_rules)")
    res["segments"] = [[r[0], r[1], r[2], json.loads(r[3]) if r[3] else None, json.loads(r[4]) if r[4] else None, json.loads(r[5]) if r[5] else None, json.loads(r[6]) if r[6] else None, json.loads(r[7])] for r in seg]
    res["water"] = [[r[0], r[1], r[2], json.loads(r[3])] for r in q("water", "subtype, class, names.primary")]
    keep = "AND (subtype IN ('airport', 'pier', 'water', 'bridge') OR class IN ('runway', 'taxiway', 'apron', 'helipad', 'pier', 'breakwater', 'dock', 'groyne', 'quay'))"
    res["infrastructure"] = [[r[0], r[1], r[2], r[3], json.loads(r[4])] for r in q("infrastructure", "subtype, class, names.primary, height", keep)]
    res["land_use"] = [[r[0], r[1], r[2], json.loads(r[3])] for r in q("land_use", "subtype, class, names.primary")]
    with gzip.open(out, "wt") as f:
        json.dump(res, f)
    print(rid, {k: len(v) for k, v in res.items() if isinstance(v, list) and k != "bbox"}, round(time.time() - t0), "s")

if __name__ == "__main__":
    main()
