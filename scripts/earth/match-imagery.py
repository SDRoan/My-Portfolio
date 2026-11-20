"""Colour-matches a pack's fine orthophoto layer to its Sentinel-2 layer, so
the finer box doesn't show as a differently-tinted rectangle inside the
regional imagery (different sensors, dates and processing).

  python3 scripts/earth/match-imagery.py <pack> [<pack> …]

Per channel, in linear light: the ortho's mean over the overlap is matched
to Sentinel-2's by a gain (no offset, so blacks and dark hues are kept) (the ortho resampled to 10 m for the
statistics only); the full-resolution ortho is then transformed and saved.
The original is kept as img-ortho.orig.jpg in the scratch cache, not shipped.
"""
import json, os, sys, shutil, tempfile
import numpy as np
from PIL import Image

RG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "space", "data", "earth", "regions")
lin = lambda a: np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)
srgb = lambda a: np.where(a <= 0.0031308, a * 12.92, 1.055 * np.clip(a, 0, None) ** (1 / 2.4) - 0.055)
for pid in sys.argv[1:]:
    mf = os.path.join(RG, pid, "meta.json"); meta = json.load(open(mf))
    ims = {m["file"]: m for m in meta["imagery"] if m.get("attached")}
    if "img-ortho.jpg" not in ims or "img-s2.jpg" not in ims:
        print(pid, "skip"); continue
    keep = os.path.join(tempfile.gettempdir(), "open-earth-cache", pid + "-img-ortho.orig.jpg")
    if not os.path.exists(keep):
        shutil.copy(os.path.join(RG, pid, "img-ortho.jpg"), keep)
    fo, so = ims["img-ortho.jpg"], ims["img-s2.jpg"]
    O = Image.open(keep).convert("RGB"); S = Image.open(os.path.join(RG, pid, "img-s2.jpg")).convert("RGB")
    b, c = fo["bounds"], so["bounds"]
    # The ortho's box on the Sentinel-2 grid.
    x0 = (b["west"] - c["west"]) / (c["east"] - c["west"]) * S.width; x1 = (b["east"] - c["west"]) / (c["east"] - c["west"]) * S.width
    y0 = (c["north"] - b["north"]) / (c["north"] - c["south"]) * S.height; y1 = (c["north"] - b["south"]) / (c["north"] - c["south"]) * S.height
    s = lin(np.asarray(S.crop((int(x0), int(y0), int(x1), int(y1))), np.float32) / 255)
    o_small = lin(np.asarray(O.resize((s.shape[1], s.shape[0]), Image.BOX), np.float32) / 255)
    o = lin(np.asarray(O, np.float32) / 255)
    gain, off = [], []
    # Gain only (means matched, per channel): an offset would shift the hue
    # of dark tones (water turned purple at JFK) and lift or crush blacks.
    for k in range(3):
        g = s[..., k].mean() / (o_small[..., k].mean() + 1e-6)
        gain.append(float(g)); off.append(0.0)
        o[..., k] = o[..., k] * g
    out = (np.clip(srgb(np.clip(o, 0, 1)), 0, 1) * 255 + 0.5).astype(np.uint8)
    Image.fromarray(out).save(os.path.join(RG, pid, "img-ortho.jpg"), quality=84, optimize=True, progressive=True)
    fo["colourMatched"] = {"to": "img-s2.jpg", "gain": [round(v, 3) for v in gain], "offset": [round(v, 4) for v in off]}
    fo["bytes"] = os.path.getsize(os.path.join(RG, pid, "img-ortho.jpg"))
    with open(mf + ".tmp", "w") as f:
        json.dump(meta, f, separators=(",", ":"))
    os.replace(mf + ".tmp", mf)
    print(pid, "gain", [round(v, 2) for v in gain], "offset", [round(v, 3) for v in off])
