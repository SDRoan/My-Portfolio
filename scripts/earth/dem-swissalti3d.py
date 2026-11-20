"""swisstopo swissALTI3D (2 m) for a small box, resampled to a lat/lon grid,
for a high-resolution elevation patch in an Earth region pack (Matterhorn).

  python3 scripts/earth/dem-swissalti3d.py <south> <west> <north> <east> <cellDegLat> <cellDegLon> <out.f32>

Source: swissALTI3D, Federal Office of Topography swisstopo — open
government data since 1 March 2021: free use, including commercial use and
redistribution, with the source named ("© swisstopo"). 1 km tiles (LV95,
EPSG:2056), heights in the Swiss national height system LN02 (orthometric;
within about a metre of EGM2008 orthometric heights in the Alps). The newest
vintage of each tile is used, found through swisstopo's STAC API
(data.geo.admin.ch). Only the tiles under the box are downloaded (~1 MB each).

Writes <out.f32> (float32, row-major from the north-west, NaN = no data:
outside Switzerland) and <out.f32.json>.
"""
import json, os, sys, urllib.request, tempfile
import numpy as np
import rasterio
from rasterio.merge import merge
from rasterio.warp import reproject, Resampling
from rasterio.crs import CRS
from rasterio.transform import from_bounds

API = "https://data.geo.admin.ch/api/stac/v0.9/collections/ch.swisstopo.swissalti3d/items"
UA = {"User-Agent": "portfolio-open-earth-builder/1.0"}


def items(S, W, N, E):
    url, out = f"{API}?bbox={W},{S},{E},{N}&limit=100", []
    while url:
        j = json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120))
        out += j["features"]
        url = next((l["href"] for l in j.get("links", []) if l.get("rel") == "next"), None)
    return out


def main():
    S, W, N, E, cla, clo = map(float, sys.argv[1:7])
    out = sys.argv[7]
    # Newest vintage per 1 km tile.
    best = {}
    for f in items(S, W, N, E):
        tile = f["id"].rsplit("_", 1)[-1]
        yr = int(f["id"].split("_")[1])
        if tile not in best or yr > best[tile][0]:
            href = next(a["href"] for k, a in f["assets"].items() if k.endswith(".tif") and "_2_2056" in k)
            best[tile] = (yr, href)
    cache = os.path.join(tempfile.gettempdir(), "open-earth-cache", "swissalti3d")
    os.makedirs(cache, exist_ok=True)
    srcs, years = [], set()
    for tile, (yr, href) in sorted(best.items()):
        f = os.path.join(cache, href.rsplit("/", 1)[-1])
        if not os.path.exists(f):
            urllib.request.urlretrieve(href, f)
        srcs.append(rasterio.open(f)); years.add(yr)
    print("  swissALTI3D tiles:", len(srcs), "vintages", sorted(years))
    mos, tr = merge(srcs, nodata=-9999)
    Wd, Hd = round((E - W) / clo), round((N - S) / cla)
    dst = np.full((Hd, Wd), np.nan, np.float32)
    src = mos[0].astype(np.float32)
    src[src <= -9000] = np.nan
    reproject(src, dst, src_transform=tr, src_crs=CRS.from_epsg(2056), src_nodata=np.nan,
              dst_transform=from_bounds(W, S, E, N, Wd, Hd), dst_crs=CRS.from_epsg(4326), dst_nodata=np.nan,
              resampling=Resampling.average)
    dst.tofile(out)
    i = np.nanargmax(dst)
    meta = {"width": Wd, "height": Hd, "bounds": {"south": S, "west": W, "north": N, "east": E}, "tiles": len(srcs), "vintages": sorted(years),
            "max": float(np.nanmax(dst)), "maxAt": [N - (i // Wd + 0.5) * cla, W + (i % Wd + 0.5) * clo], "valid": float(np.isfinite(dst).mean()),
            "source": "swissALTI3D 2 m, Federal Office of Topography swisstopo (open government data; © swisstopo)", "datum": "LN02 (Swiss national heights)"}
    json.dump(meta, open(out + ".json", "w"), indent=1)
    print(" ", Wd, "x", Hd, "max", round(meta["max"], 1), "at", [round(v, 5) for v in meta["maxAt"]], "valid", round(meta["valid"], 3))


if __name__ == "__main__":
    main()
