"""Imagery ↔ vector alignment for the Earth region packs.

  python3 scripts/earth/validate-imagery.py

For every imagery layer of every pack built from Overture, inside the pack's
box: the vector reference (the same Overture water polygons, and for airports
the runways, that the pack's map tiles are drawn from) is rasterised on the
image's own grid, and cross-correlated with the image (water: darkness;
runways: brightness) over shifts up to ±60 m. The best shift (sub-pixel) is
the imagery's offset from the vector data, i.e. from the frame the terrain,
buildings and roads are drawn in. A shift the image doesn't support (a flat
correlation peak) is reported as such, not as an offset.

Writes space/data/earth/imagery-alignment.json.
"""
import gzip, json, math, os, sys, tempfile
import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
RG = os.path.join(ROOT, "space", "data", "earth", "regions")
CACHE = os.path.join(tempfile.gettempdir(), "open-earth-cache")
AIRPORTS = {"jfk", "lax", "heathrow", "haneda", "dxb"}
Image.MAX_IMAGE_PIXELS = None


def rings(g):
    if g["type"] == "Polygon":
        return [g["coordinates"]]
    if g["type"] == "MultiPolygon":
        return g["coordinates"]
    return []


def lines(g):
    if g["type"] == "LineString":
        return [g["coordinates"]]
    if g["type"] == "MultiLineString":
        return g["coordinates"]
    return []


def xcorr(a, b, R):
    """Best shift (dx, dy) of b relative to a within ±R px, normalised cross-correlation; sub-pixel."""
    a = (a - a.mean()) / (a.std() + 1e-9)
    b = (b - b.mean()) / (b.std() + 1e-9)
    H, W = a.shape
    F = np.fft.rfft2(a, s=(H + R, W + R)) * np.conj(np.fft.rfft2(b, s=(H + R, W + R)))
    c = np.fft.irfft2(F, s=(H + R, W + R)) / (H * W)
    # c[dy, dx] = sum a[y+dy, x+dx] b[y, x]: a shifted by (dy, dx) matches b
    win = np.zeros((2 * R + 1, 2 * R + 1))
    for dy in range(-R, R + 1):
        for dx in range(-R, R + 1):
            win[dy + R, dx + R] = c[dy % (H + R), dx % (W + R)]
    j, i = np.unravel_index(np.argmax(win), win.shape)
    # Distinctness: how far the correlation falls from the peak to the search
    # border (60 m away). A real alignment signal falls off; a flat one doesn't.
    border = np.concatenate([win[0], win[-1], win[1:-1, 0], win[1:-1, -1]])
    z = float((win[j, i] - border.mean()) / (abs(win[j, i]) + abs(border.mean()) + 1e-9))
    peak = win[j, i]

    def sub(m, p, q):
        d = m - 2 * p + q
        return 0.0 if abs(d) < 1e-12 else 0.5 * (m - q) / d
    sx = sub(win[j, i - 1], peak, win[j, i + 1]) if 0 < i < 2 * R else 0
    sy = sub(win[j - 1, i], peak, win[j + 1, i]) if 0 < j < 2 * R else 0
    # How distinct the peak is: against the window's median.
    edge = i in (0, 2 * R) or j in (0, 2 * R)             # peak on the search border: no real optimum
    return float(i - R + sx), float(j - R + sy), float(peak), float(np.median(win)), (0.0 if edge else z)


def blur(x, r):
    if r < 1:
        return x
    k = 2 * r + 1
    c = np.cumsum(np.pad(x, ((r + 1, r), (0, 0)), mode="edge"), 0); x = (c[k:] - c[:-k]) / k
    c = np.cumsum(np.pad(x, ((0, 0), (r + 1, r)), mode="edge"), 1); return (c[:, k:] - c[:, :-k]) / k


def edges(x):
    gy, gx = np.gradient(x)
    return np.hypot(gx, gy)


def main():
    idx = json.load(open(os.path.join(RG, "index.json")))["regions"]
    results = []
    for r in idx:
        mf = os.path.join(RG, r["id"], "meta.json")
        if not os.path.exists(mf):
            continue
        meta = json.load(open(mf))
        ims = [m for m in meta.get("imagery", []) if m.get("attached")]
        ov = os.path.join(CACHE, "overture-" + r["id"] + ".json.gz")
        if not ims:
            continue
        if not os.path.exists(ov):
            for im in ims:
                results.append({"pack": r["id"], "layer": im["file"], "offsetM": None, "note": "no vector reference in this pack (elevation-only pack): alignment not measurable here"})
            continue
        X = json.load(gzip.open(ov, "rt"))
        bb = meta["bbox"]
        for im in ims:
            b = im["bounds"]
            img = Image.open(os.path.join(RG, r["id"], im["file"])).convert("RGB")
            Wf, Hf = img.size
            # Crop to the pack's box (where the vector data is), on the image grid.
            x0 = int((bb["west"] - b["west"]) / (b["east"] - b["west"]) * Wf); x1 = int((bb["east"] - b["west"]) / (b["east"] - b["west"]) * Wf)
            y0 = int((b["north"] - bb["north"]) / (b["north"] - b["south"]) * Hf); y1 = int((b["north"] - bb["south"]) / (b["north"] - b["south"]) * Hf)
            x0, y0, x1, y1 = max(0, x0), max(0, y0), min(Wf, x1), min(Hf, y1)
            # Work at ≥ 2.5 m pixels.
            pxm = im["pixelM"]
            k = max(1, int(round(2.5 / pxm))) if pxm < 2.5 else 1
            crop = img.crop((x0, y0, x1, y1))
            if k > 1:
                crop = crop.resize(((x1 - x0) // k, (y1 - y0) // k), Image.BILINEAR)
            a = np.asarray(crop, np.float32) / 255
            lum = a.mean(2)
            H, W = lum.shape
            cw, cs = b["west"] + x0 / Wf * (b["east"] - b["west"]), b["north"] - y0 / Hf * (b["north"] - b["south"])
            ce, cn = b["west"] + x1 / Wf * (b["east"] - b["west"]), b["north"] - y1 / Hf * (b["north"] - b["south"])
            P = lambda lo, la: ((lo - cw) / (ce - cw) * W, (cs - la) / (cs - cn) * H)
            pm = pxm * k
            refs = []
            mask = Image.new("L", (W, H), 0); d = ImageDraw.Draw(mask)
            if r["id"] in AIRPORTS:
                feat = "runways (Overture)"
                # Paving between grass: low colour saturation.
                sig = 1 - (a.max(2) - a.min(2)) / (a.max(2) + 1e-3)
                for f in X["infrastructure"]:
                    if f[1] == "runway":
                        for ln in lines(f[-1]):
                            d.line([P(lo, la) for lo, la in ln], fill=255, width=max(1, int(45 / pm)))
                        for poly in rings(f[-1]):
                            d.polygon([P(lo, la) for lo, la in poly[0]], fill=255)
            if r["id"] in AIRPORTS:
                refs.append((feat, sig, np.asarray(mask, np.float32) / 255))
                mask = Image.new("L", (W, H), 0); d = ImageDraw.Draw(mask)
            if True:
                feat = "water polygons (Overture)"
                # Water in true colour: dark, and no redder than it is blue.
                sig = (1 - lum) * np.clip(0.5 + 4 * (a[..., 2] - a[..., 0]), 0, 1)
                for w in X["water"]:
                    for poly in rings(w[-1]):
                        d.polygon([P(lo, la) for lo, la in poly[0]], fill=255)
                        for hole in poly[1:]:
                            d.polygon([P(lo, la) for lo, la in hole], fill=0)
            refs.append((feat, sig, np.asarray(mask, np.float32) / 255))
            R = int(math.ceil(60 / pm))
            # For each usable reference, two estimators — boundary (edge
            # strength) and area — and the most distinct correlation peak wins.
            cands = []
            for feat_i, sig_i, V in refs:
                cover = float(V.mean())
                if cover < 0.003 or cover > 0.97:
                    continue
                sb = max(1, int(round((8 if "runway" in feat_i else 6) / pm)))
                cands.append((feat_i, cover, "edges") + xcorr(edges(blur(sig_i, sb)), edges(blur(V, sb)), R))
                cands.append((feat_i, cover, "area") + xcorr(blur(sig_i, sb), blur(V, sb), R))
            if not cands:
                results.append({"pack": r["id"], "layer": im["file"], "offsetM": None, "note": "too little reference water or runway in the box"}); continue
            # Every reference with a distinct peak gives an estimate. A rigid
            # feature that matches is evidence of alignment; a reference that
            # disagrees is usually the reference moving (tidal shoreline, aprons
            # as grey as runways), so the smallest distinct offset is reported
            # and the others are listed beside it.
            distinct = [c for c in cands if c[7] >= 0.25]
            if os.environ.get("IA_DEBUG"):
                print("   cands", r["id"], im["file"], [(c[0][:6], c[2], round(math.hypot(c[3], c[4]) * pm, 1), round(c[7], 2)) for c in cands])
            others = []
            if distinct:
                best = min(distinct, key=lambda c: (c[3] ** 2 + c[4] ** 2))
                for c in distinct:
                    if c is not best:
                        others.append(c[0].split(" (")[0] + " " + c[2] + ": " + str(round(math.hypot(c[3], c[4]) * pxm * k, 1)) + " m")
            else:
                best = max(cands, key=lambda c: c[7])
            feat, cover, method, dx, dy, peak, med, z = best
            dE, dN = dx * pm, -dy * pm
            off = math.hypot(dE, dN)
            lim = round(max(2 * im["pixelM"], 10), 1)
            res = {"pack": r["id"], "layer": im["file"], "source": im["source"], "pixelM": im["pixelM"], "feature": feat, "coverage": round(cover, 3),
                   "dE": round(dE, 1), "dN": round(dN, 1), "offsetM": round(off, 1), "score": round(z, 2), "method": method, "limitM": lim}
            if others:
                res["otherEstimates"] = sorted(set(others))
            if z < 0.25:
                res.update({"offsetM": None, "note": "no distinct correlation peak against " + feat + " (falls only " + str(round(100 * z)) + "% within 60 m): the image can't pin the offset here"})
            results.append(res)
            print(r["id"].ljust(15), im["file"].ljust(13), feat.ljust(26), "offset", res["offsetM"], "m", "(dE %.1f dN %.1f)" % (dE, dN), method, "z", round(z, 1))
    json.dump({"method": __doc__.strip().splitlines()[0], "results": results}, open(os.path.join(ROOT, "space", "data", "earth", "imagery-alignment.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
