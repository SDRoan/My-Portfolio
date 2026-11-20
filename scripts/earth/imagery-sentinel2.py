"""True-colour Copernicus Sentinel-2 imagery for one box, for an Earth region pack.

  python3 scripts/earth/imagery-sentinel2.py <south> <west> <north> <east> <px> <out.jpg>

Source: Copernicus Sentinel-2 Level-2A surface reflectance (Collection 1,
ESA processing baseline >= 05.00), as Cloud-Optimised GeoTIFFs in the
AWS Open Data registry (s3://e84-earth-search-sentinel-data), found through
the Earth Search STAC API. No key or account. Only the window covering the box
is read, by HTTP range requests.

Scene choice: up to 25 scenes from the last three years with < 25 % cloud on
the whole tile are ranked by the Scene Classification layer (SCL) inside the
box itself (cloud, cloud shadow, cirrus, snow-free check, no-data), then by
season (high sun) and age. The best scene is used; if it doesn't cover the box
fully (tile edge) or has residual cloud, scenes from the SAME date (same orbit,
adjacent tiles: no seam) fill the gaps first, then the next-best dates.
Haze counts against a scene: the mean aerosol optical thickness (AOT band)
inside the box, and the whole tile's cloud cover (SCL misses some cumulus).

Colour: B04/B03/B02 reflectance (DN x 1e-4 - 0.1), a small per-band dark
offset (haze; 0.5th percentile, at most 0.025), a shared white point (the
99.7th percentile of brightness, clamped 0.20-0.38), then a display gamma
of 1/1.9. No saturation boost.

Writes <out.jpg> (equirectangular: rows evenly spaced in latitude, columns in
longitude, exactly the box) and <out.jpg>.json with the scenes and dates.
"""
import json, os, sys, urllib.request, datetime
import numpy as np
import rasterio
from rasterio.vrt import WarpedVRT
from rasterio.enums import Resampling
from rasterio.crs import CRS
from rasterio.transform import from_bounds
from PIL import Image

os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif")
os.environ.setdefault("GDAL_HTTP_MULTIRANGE", "YES")
os.environ.setdefault("GDAL_HTTP_MERGE_CONSECUTIVE_RANGES", "YES")
STAC = "https://earth-search.aws.element84.com/v1/search"
UA = {"User-Agent": "portfolio-open-earth-builder/1.0", "Content-Type": "application/json"}
BAD = {0, 1, 3, 8, 9, 10}          # no data, saturated/defective, cloud shadow, cloud medium/high, cirrus


def search(S, W, N, E, years=3):
    end = datetime.date.today()
    body = {"collections": ["sentinel-2-c1-l2a"], "bbox": [W, S, E, N], "limit": 100,
            "datetime": f"{end.year - years}-01-01T00:00:00Z/{end.isoformat()}T23:59:59Z",
            "query": {"eo:cloud_cover": {"lt": 25}},
            "sortby": [{"field": "properties.eo:cloud_cover", "direction": "asc"}]}
    req = urllib.request.Request(STAC, data=json.dumps(body).encode(), headers=UA)
    return json.load(urllib.request.urlopen(req, timeout=120))["features"]


def warp(href, S, W, N, E, w, h, resampling, dtype=None):
    with rasterio.open(href) as src:
        with WarpedVRT(src, crs=CRS.from_epsg(4326), transform=from_bounds(W, S, E, N, w, h), width=w, height=h,
                       resampling=resampling, nodata=0) as v:
            return v.read(1, out_dtype=dtype)


def main():
    S, W, N, E = map(float, sys.argv[1:5])
    px, out = int(sys.argv[5]), sys.argv[6]
    lat = (S + N) / 2
    wM, hM = (E - W) * np.cos(np.radians(lat)), N - S
    Wd, Hd = (px, round(px * hM / wM)) if wM >= hM else (round(px * wM / hM), px)
    feats = search(S, W, N, E)
    if not feats:
        sys.exit("no Sentinel-2 scenes")
    # Rank by the cloud mask inside the box (SCL at 20 m, read coarse).
    sw, sh = max(32, Wd // 8), max(32, Hd // 8)
    scored = []
    for f in feats[:int(os.environ.get("S2_CANDIDATES", "25"))]:
        try:
            scl = warp(f["assets"]["scl"]["href"], S, W, N, E, sw, sh, Resampling.nearest)
        except Exception as e:
            print("  skip", f["id"], e); continue
        bad = float(np.isin(scl, list(BAD)).mean())
        # Haze: mean aerosol optical thickness (AOT, 550 nm) over the box.
        try:
            aot = warp(f["assets"]["aot"]["href"], S, W, N, E, sw, sh, Resampling.nearest, "float32")
            aot = float(aot[aot > 0].mean() * 0.001) if (aot > 0).any() else 0.0
        except Exception:
            aot = 0.0
        nod = float((scl == 0).mean())
        snow = float((scl == 11).mean())
        d = datetime.date.fromisoformat(f["properties"]["datetime"][:10])
        # Sun high (season), and recent, as tie-breakers.
        sun = abs(((d.timetuple().tm_yday - (172 if lat >= 0 else 355)) + 182) % 365 - 182) / 182
        age = (datetime.date.today() - d).days / 1095
        cloud = bad - nod
        # The tile's own cloud cover too: SCL misses some small cumulus.
        tile_cc = f["properties"].get("eo:cloud_cover", 0) / 100
        scored.append((cloud * 4 + nod * 0.5 + snow * 0.5 + 0.6 * aot + 0.3 * tile_cc + 0.03 * sun + 0.02 * age, cloud, nod, f, d))
        print(f"  {f['id']}  cloud/shadow {cloud:.3f}  no-data {nod:.2f}  snow {snow:.3f}  aot {aot:.2f}  tile cloud {tile_cc:.3f}")
    scored.sort(key=lambda s: s[0])
    best_date = scored[0][4]
    # Same date first (seamless: the same pass), then the rest by score.
    order = [s for s in scored if s[4] == best_date] + [s for s in scored if s[4] != best_date]
    rgb = np.zeros((3, Hd, Wd), np.float32)
    have = np.zeros((Hd, Wd), bool)
    used = []
    for _, cloud, nod, f, d in order:
        if have.all() or (len(used) >= 4):
            break
        if cloud > 0.2:
            continue
        scl = warp(f["assets"]["scl"]["href"], S, W, N, E, Wd, Hd, Resampling.nearest)
        ok = ~np.isin(scl, list(BAD)) & ~have
        if d != best_date:
            ok &= ~have
        if ok.mean() < 0.0005:
            continue
        bands = [warp(f["assets"][k]["href"], S, W, N, E, Wd, Hd, Resampling.cubic, "float32") for k in ("red", "green", "blue")]
        ok &= bands[0] > 0
        for i in range(3):
            rgb[i][ok] = bands[i][ok] * 1e-4 - 0.1
        have |= ok
        used.append({"scene": f["id"], "date": d.isoformat(), "pixels": round(float(ok.mean()), 4),
                     "cloud_in_box": round(cloud, 4), "processing_baseline": f["properties"].get("s2:processing_baseline")})
        print("  used", f["id"], "fills", round(float(ok.mean()), 3))
    if not have.all():
        # Residual gaps (persistent cloud): take the best scene's pixels as they are.
        f = order[0][3]
        bands = [warp(f["assets"][k]["href"], S, W, N, E, Wd, Hd, Resampling.cubic, "float32") for k in ("red", "green", "blue")]
        gap = ~have & (bands[0] > 0)
        for i in range(3):
            rgb[i][gap] = bands[i][gap] * 1e-4 - 0.1
        print("  residual gap filled from best scene:", round(float(gap.mean()), 4))
    valid = rgb[0] > 0
    dark = [min(0.025, float(np.percentile(rgb[i][valid], 0.5))) for i in range(3)]
    for i in range(3):
        rgb[i] -= dark[i]
    lum = rgb.mean(0)[valid]
    white = float(np.clip(np.percentile(lum, 99.7), 0.20, 0.38))
    img = np.clip(rgb / white, 0, 1) ** (1 / 1.9)
    Image.fromarray((img.transpose(1, 2, 0) * 255 + 0.5).astype(np.uint8)).save(out, quality=88, optimize=True, progressive=True)
    meta = {"bounds": {"south": S, "west": W, "north": N, "east": E}, "width": Wd, "height": Hd, "mission": "Copernicus Sentinel-2", "product": "Level-2A surface reflectance (Collection 1)", "bands": "B04/B03/B02 (10 m)",
            "resolutionM": 10, "pixelM": round(wM * 111320 / Wd, 1), "scenes": used, "dates": sorted({u["date"] for u in used}),
            "colour": {"dark": [round(x, 4) for x in dark], "white": round(white, 3), "gamma": 1.9},
            "source": "Earth Search STAC (Element 84) / AWS Open Data: s3://e84-earth-search-sentinel-data",
            "attribution": "Contains modified Copernicus Sentinel data " + "/".join(sorted({u["date"][:4] for u in used}))}
    json.dump(meta, open(out + ".json", "w"), indent=1)
    print(out, Wd, "x", Hd, os.path.getsize(out) // 1024, "KB", meta["dates"])


if __name__ == "__main__":
    main()
