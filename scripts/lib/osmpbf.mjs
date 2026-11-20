// A small OpenStreetMap PBF reader (the format of Geofabrik's extracts),
// enough to cut a region out of a state or country file.
//
// extractBox(file, bbox, wantWay, wantRel) returns elements in the same shape
// as the Overpass API's `out tags geom`:
//   { type: "way", id, tags, geometry: [{lat, lon}, …] }
//   { type: "relation", id, tags, members: [{type, ref, role, geometry}] }
//   { type: "node", id, tags, lat, lon }      (tagged nodes only)
// Ways are kept when any of their nodes lies in the box; relations when any
// member way does — and those relations' other member ways are fetched in
// further passes, so a river polygon that leaves the box still closes.

import { openSync, readSync, closeSync, fstatSync } from "node:fs";
import { inflateSync } from "node:zlib";

// ── protobuf ──
class PB {
  constructor(buf, start = 0, end = buf.length) { this.b = buf; this.p = start; this.end = end; }
  more() { return this.p < this.end; }
  varint() {
    let r = 0, s = 0, b;
    do { b = this.b[this.p++]; if (s < 28) r |= (b & 0x7f) << s; else r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80);
    return r >= 0 ? r : r >>> 0;
  }
  varint64() { let r = 0, m = 1, b; do { b = this.b[this.p++]; r += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return r; }
  svarint64() { const v = this.varint64(); return v % 2 === 1 ? -(v + 1) / 2 : v / 2; }
  key() { const k = this.varint(); return [k >>> 3, k & 7]; }
  bytes() { const n = this.varint(); const s = this.p; this.p += n; return [s, this.p]; }
  skip(wt) { if (wt === 0) this.varint64(); else if (wt === 1) this.p += 8; else if (wt === 2) { const n = this.varint(); this.p += n; } else if (wt === 5) this.p += 4; else throw new Error("wire type " + wt); }
  packed(fn) { const [s, e] = this.bytes(); const sub = new PB(this.b, s, e), out = []; while (sub.more()) out.push(fn(sub)); return out; }
}

function* blobs(file) {
  const fd = openSync(file, "r"), size = fstatSync(fd).size;
  let pos = 0;
  const len = Buffer.alloc(4);
  try {
    while (pos < size) {
      readSync(fd, len, 0, 4, pos); pos += 4;
      const hl = len.readUInt32BE(0), hb = Buffer.alloc(hl);
      readSync(fd, hb, 0, hl, pos); pos += hl;
      let type = "", ds = 0;
      const h = new PB(hb);
      while (h.more()) { const [f, wt] = h.key(); if (f === 1) { const [s, e] = h.bytes(); type = hb.toString("utf8", s, e); } else if (f === 3) ds = h.varint(); else h.skip(wt); }
      const bb = Buffer.alloc(ds);
      readSync(fd, bb, 0, ds, pos); pos += ds;
      if (type !== "OSMData") continue;
      const b = new PB(bb);
      let data = null;
      while (b.more()) {
        const [f, wt] = b.key();
        if (f === 1) { const [s, e] = b.bytes(); data = bb.subarray(s, e); }
        else if (f === 3) { const [s, e] = b.bytes(); data = inflateSync(bb.subarray(s, e)); }
        else b.skip(wt);
      }
      if (data) yield data;
    }
  } finally { closeSync(fd); }
}

// Decode one PrimitiveBlock, calling visitor.node(id, lat, lon, tags|null),
// visitor.way(id, tags, refs), visitor.relation(id, tags, members).
function block(buf, v) {
  const pb = new PB(buf);
  const strings = [];
  let gran = 100, latOff = 0, lonOff = 0;
  const groups = [];
  while (pb.more()) {
    const [f, wt] = pb.key();
    if (f === 1) { const [s, e] = pb.bytes(); const st = new PB(buf, s, e); while (st.more()) { const [g] = st.key(); const [a, z] = st.bytes(); strings.push(g === 1 ? buf.toString("utf8", a, z) : ""); } }
    else if (f === 2) groups.push(pb.bytes());
    else if (f === 17) gran = pb.varint();
    else if (f === 19) latOff = pb.varint64();
    else if (f === 20) lonOff = pb.varint64();
    else pb.skip(wt);
  }
  const deg = (x, off) => 1e-9 * (off + gran * x);
  const tagsOf = (keys, vals) => { if (!keys.length) return null; const t = {}; for (let i = 0; i < keys.length; i++) t[strings[keys[i]]] = strings[vals[i]]; return t; };
  for (const [gs, ge] of groups) {
    const g = new PB(buf, gs, ge);
    while (g.more()) {
      const [f, wt] = g.key();
      if (f === 2 && v.node) {                                   // DenseNodes
        const [s, e] = g.bytes(), d = new PB(buf, s, e);
        let ids = [], lats = [], lons = [], kv = [];
        while (d.more()) {
          const [k, w] = d.key();
          if (k === 1) ids = d.packed((x) => x.svarint64());
          else if (k === 8) lats = d.packed((x) => x.svarint64());
          else if (k === 9) lons = d.packed((x) => x.svarint64());
          else if (k === 10) kv = d.packed((x) => x.varint());
          else d.skip(w);
        }
        let id = 0, la = 0, lo = 0, ki = 0;
        for (let i = 0; i < ids.length; i++) {
          id += ids[i]; la += lats[i]; lo += lons[i];
          let tags = null;
          if (kv.length) { while (kv[ki] !== 0 && ki < kv.length) { (tags || (tags = {}))[strings[kv[ki]]] = strings[kv[ki + 1]]; ki += 2; } ki++; }
          v.node(id, deg(la, latOff), deg(lo, lonOff), tags);
        }
      } else if (f === 1 && v.node) {                            // plain Node
        const [s, e] = g.bytes(), n = new PB(buf, s, e);
        let id = 0, la = 0, lo = 0, keys = [], vals = [];
        while (n.more()) { const [k, w] = n.key(); if (k === 1) id = n.svarint64(); else if (k === 2) keys = n.packed((x) => x.varint()); else if (k === 3) vals = n.packed((x) => x.varint()); else if (k === 8) la = n.svarint64(); else if (k === 9) lo = n.svarint64(); else n.skip(w); }
        v.node(id, deg(la, latOff), deg(lo, lonOff), tagsOf(keys, vals));
      } else if (f === 3 && v.way) {
        const [s, e] = g.bytes(), w = new PB(buf, s, e);
        let id = 0, keys = [], vals = [], refs = [];
        while (w.more()) { const [k, wt2] = w.key(); if (k === 1) id = w.varint64(); else if (k === 2) keys = w.packed((x) => x.varint()); else if (k === 3) vals = w.packed((x) => x.varint()); else if (k === 8) refs = w.packed((x) => x.svarint64()); else w.skip(wt2); }
        for (let i = 1; i < refs.length; i++) refs[i] += refs[i - 1];
        v.way(id, tagsOf(keys, vals), refs);
      } else if (f === 4 && v.relation) {
        const [s, e] = g.bytes(), r = new PB(buf, s, e);
        let id = 0, keys = [], vals = [], roles = [], mem = [], types = [];
        while (r.more()) { const [k, wt2] = r.key(); if (k === 1) id = r.varint64(); else if (k === 2) keys = r.packed((x) => x.varint()); else if (k === 3) vals = r.packed((x) => x.varint()); else if (k === 8) roles = r.packed((x) => x.varint()); else if (k === 9) mem = r.packed((x) => x.svarint64()); else if (k === 10) types = r.packed((x) => x.varint()); else r.skip(wt2); }
        for (let i = 1; i < mem.length; i++) mem[i] += mem[i - 1];
        v.relation(id, tagsOf(keys, vals), mem.map((ref, i) => ({ type: ["node", "way", "relation"][types[i]], ref, role: strings[roles[i]] })));
      } else g.skip(wt);
    }
  }
}

export function extractBox(file, b, wantWay, wantRel, wantNode, log = () => {}) {
  const inBox = (la, lo) => la >= b.south && la <= b.north && lo >= b.west && lo <= b.east;
  const nodes = new Map(), ways = new Map(), rels = [], tagged = [];
  let n = 0;
  // Pass 1: nodes in the box; ways touching it; relations of interest.
  for (const buf of blobs(file)) {
    block(buf, {
      node(id, la, lo, tags) { if (inBox(la, lo)) { nodes.set(id, [la, lo]); if (tags && wantNode && wantNode(tags)) tagged.push({ type: "node", id, tags, lat: la, lon: lo }); } },
      way(id, tags, refs) { for (const r of refs) if (nodes.has(r)) { ways.set(id, { tags: tags || {}, refs }); break; } },
      relation(id, tags, members) { if (tags && wantRel(tags) && members.some((m) => m.type === "way" && ways.has(m.ref))) rels.push({ id, tags, members }); }
    });
    if (++n % 500 === 0) log("pass 1 · " + n + " blocks · " + nodes.size + " nodes · " + ways.size + " ways");
  }
  // Pass 2: member ways of those relations that never touched the box.
  const needWays = new Set();
  for (const r of rels) for (const m of r.members) if (m.type === "way" && !ways.has(m.ref)) needWays.add(m.ref);
  const needNodes = new Set();
  if (needWays.size) {
    for (const buf of blobs(file)) block(buf, { way(id, tags, refs) { if (needWays.has(id)) { ways.set(id, { tags: tags || {}, refs }); for (const r of refs) if (!nodes.has(r)) needNodes.add(r); } } });
    log("pass 2 · " + needWays.size + " outside member ways");
  }
  for (const w of ways.values()) for (const r of w.refs) if (!nodes.has(r)) needNodes.add(r);
  // Pass 3: the nodes those ways need outside the box.
  if (needNodes.size) {
    for (const buf of blobs(file)) block(buf, { node(id, la, lo) { if (needNodes.has(id)) nodes.set(id, [la, lo]); } });
    log("pass 3 · " + needNodes.size + " outside nodes");
  }
  const geom = (refs) => { const g = []; for (const r of refs) { const p = nodes.get(r); if (p) g.push({ lat: p[0], lon: p[1] }); } return g; };
  const out = tagged;
  for (const [id, w] of ways) if (wantWay(w.tags)) out.push({ type: "way", id, tags: w.tags, geometry: geom(w.refs) });
  for (const r of rels) out.push({ type: "relation", id: r.id, tags: r.tags,
    members: r.members.map((m) => ({ type: m.type, ref: m.ref, role: m.role, geometry: m.type === "way" && ways.has(m.ref) ? geom(ways.get(m.ref).refs) : null })) });
  return out;
}
