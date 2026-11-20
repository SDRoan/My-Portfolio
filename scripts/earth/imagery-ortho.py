"""National open orthophotos for one box, for an Earth region pack.

  python3 scripts/earth/imagery-ortho.py <source> <south> <west> <north> <east> <px> <out.jpg>

Sources (each openly licensed for reuse and redistribution with attribution;
see CREDITS.md):
  ign    France: IGN BD ORTHO (50 cm), Géoplateforme WMS, layer
         ORTHOIMAGERY.ORTHOPHOTOS.BDORTHO. Licence Ouverte / Etalab 2.0.
  pdok   Netherlands: Beeldmateriaal Nederland aerial photo 2025 (HR, 7.5 cm),
         PDOK WMS luchtfotorgb, layer 2025_orthoHR. CC BY 4.0.
  naip   United States: USDA NAIP (0.6 m), USGS The National Map ImageServer.
         Public domain (US Government).
  gsi    Japan: GSI (Geospatial Information Authority of Japan) seamless photo
         tiles (地理院タイル seamlessphoto), zoom 16. GSI content terms
         (compatible with CC BY 4.0); credit 国土地理院 and state the processing.

WMS sources are requested directly in EPSG:4326, so rows are evenly spaced in
latitude and columns in longitude, exactly the box (the pack's frame). The
GSI tiles are Web Mercator and are resampled here (bilinear) to that frame.
Writes <out.jpg> and <out.jpg>.json.
"""
import io, json, math, os, sys, time, urllib.request, concurrent.futures as cf
import numpy as np
from PIL import Image

UA = {"User-Agent": "portfolio-open-earth-builder/1.0 (static site preprocessing)"}
INFO = {
    "ign": {"name": "IGN BD ORTHO (France)", "resolutionM": 0.5, "licence": "Licence Ouverte / Etalab 2.0",
            "attribution": "Orthophotos © IGN (BD ORTHO), Licence Ouverte Etalab 2.0; resampled",
            "url": "https://data.geopf.fr/wms-r/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=ORTHOIMAGERY.ORTHOPHOTOS.BDORTHO&STYLES=&CRS=EPSG:4326&FORMAT=image/jpeg"},
    "pdok": {"name": "Beeldmateriaal Nederland, Luchtfoto 2025 HR (PDOK)", "resolutionM": 0.08, "licence": "CC BY 4.0",
             "attribution": "Luchtfoto © Beeldmateriaal Nederland (PDOK), CC BY 4.0; resampled",
             "url": "https://service.pdok.nl/hwh/luchtfotorgb/wms/v1_0?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=2025_orthoHR&STYLES=&CRS=EPSG:4326&FORMAT=image/jpeg"},
    "naip": {"name": "USDA NAIP (National Agriculture Imagery Program)", "resolutionM": 0.6, "licence": "Public domain (US Government)",
             "attribution": "USDA NAIP imagery via USGS The National Map (public domain)",
             "url": "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage?bboxSR=4326&imageSR=4326&format=jpg&compressionQuality=90&interpolation=RSP_BilinearInterpolation&f=image"},
    "gsi": {"name": "GSI Japan seamless aerial photo (地理院タイル)", "resolutionM": 2.4, "licence": "GSI content terms (PDL 1.0, CC BY 4.0 compatible)",
            "attribution": "国土地理院 (GSI Japan) 地理院タイル seamlessphoto を加工して作成 (resampled)",
            "url": "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"},
}


def get(url):
    for k in range(6):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120).read()
        except Exception as e:
            err = e
            time.sleep(2 * (k + 1))
    raise err


def wms(src, S, W, N, E, w, h):
    # A few strips, each within the server's size limit.
    rows, strip = [], 2000
    for y0 in range(0, h, strip):
        hh = min(strip, h - y0)
        n1 = N - (N - S) * y0 / h
        s1 = N - (N - S) * (y0 + hh) / h
        url = INFO[src]["url"] + (f"&bbox={W},{s1},{E},{n1}&size={w},{hh}" if src == "naip" else f"&BBOX={s1},{W},{n1},{E}&WIDTH={w}&HEIGHT={hh}")
        rows.append(np.asarray(Image.open(io.BytesIO(get(url))).convert("RGB")))
    return np.concatenate(rows, 0)


def xyz(src, S, W, N, E, w, h, z=16):
    n = 2 ** z
    tx = lambda lon: (lon + 180) / 360 * n
    ty = lambda lat: (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
    x0, x1, y0, y1 = int(tx(W)), int(tx(E)), int(ty(N)), int(ty(S))
    mos = np.zeros(((y1 - y0 + 1) * 256, (x1 - x0 + 1) * 256, 3), np.uint8)

    def one(xy):
        x, y = xy
        try:
            return xy, np.asarray(Image.open(io.BytesIO(get(INFO[src]["url"].format(z=z, x=x, y=y)))).convert("RGB"))
        except Exception:
            return xy, None
    jobs = [(x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]
    with cf.ThreadPoolExecutor(6) as ex:
        for (x, y), a in ex.map(one, jobs):
            if a is not None:
                mos[(y - y0) * 256:(y - y0 + 1) * 256, (x - x0) * 256:(x - x0 + 1) * 256] = a
    print("  tiles", len(jobs))
    # Output pixel centres → mosaic pixel coordinates (bilinear).
    lons = W + (np.arange(w) + 0.5) / w * (E - W)
    lats = N - (np.arange(h) + 0.5) / h * (N - S)
    fx = (np.array([tx(l) for l in lons]) - x0) * 256 - 0.5
    fy = (np.array([ty(l) for l in lats]) - y0) * 256 - 0.5
    X, Y = np.meshgrid(fx, fy)
    ix, iy = np.clip(np.floor(X).astype(int), 0, mos.shape[1] - 2), np.clip(np.floor(Y).astype(int), 0, mos.shape[0] - 2)
    ax, ay = (X - ix)[..., None], (Y - iy)[..., None]
    m = mos.astype(np.float32)
    out = (m[iy, ix] * (1 - ax) + m[iy, ix + 1] * ax) * (1 - ay) + (m[iy + 1, ix] * (1 - ax) + m[iy + 1, ix + 1] * ax) * ay
    return out.clip(0, 255).astype(np.uint8)


def main():
    src = sys.argv[1]
    S, W, N, E = map(float, sys.argv[2:6])
    px, out = int(sys.argv[6]), sys.argv[7]
    lat = (S + N) / 2
    wM, hM = (E - W) * math.cos(math.radians(lat)), N - S
    w, h = (px, round(px * hM / wM)) if wM >= hM else (round(px * wM / hM), px)
    if src == "naip":
        # The NAIP ImageServer serves square pixels in degrees and widens any
        # other box: ask for a square-degree size in one request, and keep
        # the extent it reports.
        w, h = (px, round(px * (N - S) / (E - W))) if (E - W) >= (N - S) else (round(px * (E - W) / (N - S)), px)
        j = json.loads(get(INFO[src]["url"].replace("f=image", "f=json") + f"&bbox={W},{S},{E},{N}&size={w},{h}"))
        e = j["extent"]
        S, W, N, E = e["ymin"], e["xmin"], e["ymax"], e["xmax"]
        a = np.asarray(Image.open(io.BytesIO(get(j["href"]))).convert("RGB"))
        h, w = a.shape[:2]
    else:
        a = xyz(src, S, W, N, E, w, h) if src == "gsi" else wms(src, S, W, N, E, w, h)
    Image.fromarray(a).save(out, quality=84, optimize=True, progressive=True)
    i = INFO[src]
    meta = {k: i[k] for k in ("name", "resolutionM", "licence", "attribution")}
    meta.update({"bounds": {"south": S, "west": W, "north": N, "east": E}, "width": w, "height": h, "pixelM": round((E - W) * math.cos(math.radians(lat)) * 111320 / w, 2), "service": i["url"].split("?")[0], "fetched": time.strftime("%Y-%m-%d")})
    json.dump(meta, open(out + ".json", "w"), indent=1)
    print(out, w, "x", h, os.path.getsize(out) // 1024, "KB")


if __name__ == "__main__":
    main()
