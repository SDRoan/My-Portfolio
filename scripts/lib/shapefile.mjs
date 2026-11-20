// A minimal ESRI shapefile reader (.shp polylines/polygons + .dbf attributes),
// enough for Natural Earth's vector layers.
//
//   readShapefile(shpBuf, dbfBuf) → [{ parts: [[[lon, lat], …], …], props: {…} }]

export function readShapefile(shp, dbf) {
  const props = dbf ? readDbf(dbf) : [];
  const out = [];
  let o = 100, i = 0;
  while (o + 8 <= shp.length) {
    const len = shp.readInt32BE(o + 4) * 2, rec = o + 8;
    const type = shp.readInt32LE(rec);
    if (type === 3 || type === 5 || type === 13 || type === 15 || type === 23 || type === 25) {
      const nParts = shp.readInt32LE(rec + 36), nPts = shp.readInt32LE(rec + 40);
      const starts = [];
      for (let k = 0; k < nParts; k++) starts.push(shp.readInt32LE(rec + 44 + k * 4));
      const p0 = rec + 44 + nParts * 4, parts = [];
      for (let k = 0; k < nParts; k++) {
        const a = starts[k], b = k + 1 < nParts ? starts[k + 1] : nPts, pts = [];
        for (let j = a; j < b; j++) pts.push([shp.readDoubleLE(p0 + j * 16), shp.readDoubleLE(p0 + j * 16 + 8)]);
        parts.push(pts);
      }
      out.push({ type: type % 10 === 5 ? "polygon" : "line", parts, props: props[i] || {} });
    }
    o = rec + len; i++;
  }
  return out;
}

function readDbf(b) {
  const n = b.readUInt32LE(4), hlen = b.readUInt16LE(8), rlen = b.readUInt16LE(10), fields = [];
  for (let o = 32; b[o] !== 0x0d && o < hlen; o += 32) fields.push({ name: b.toString("latin1", o, o + 11).replace(/\0.*$/, ""), type: String.fromCharCode(b[o + 11]), len: b[o + 16] });
  const rows = [];
  for (let r = 0; r < n; r++) {
    let o = hlen + r * rlen + 1;
    const row = {};
    for (const f of fields) {
      const s = b.toString("utf8", o, o + f.len).replace(/\0+/g, "").trim();
      row[f.name] = f.type === "N" || f.type === "F" ? (s === "" ? null : +s) : s;
      o += f.len;
    }
    rows.push(row);
  }
  return rows;
}
