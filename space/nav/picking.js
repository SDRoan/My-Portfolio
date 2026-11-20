// Click-to-select. Everything selectable is projected to the screen on demand
// (not every frame): bodies with discs win when the click lands on them, then
// the brightest point near the cursor, then extended objects like galaxies.

import * as THREE from "three";
import { sub, LY, UPos } from "../engine/coords.js";

const _v = new THREE.Vector3();

export function pick(u, targets, cam, camQuat, fovDeg, w, h, x, y) {
  const inv = camQuat.clone().invert();
  const t = Math.tan((fovDeg * Math.PI) / 360);
  const aspect = w / h;
  const project = (rel) => {
    _v.set(rel[0], rel[1], rel[2]).applyQuaternion(inv);
    if (_v.z >= 0) return null;
    const sx = (_v.x / -_v.z) / (t * aspect), sy = (_v.y / -_v.z) / t;
    return [(sx * 0.5 + 0.5) * w, (0.5 - sy * 0.5) * h, -_v.z];
  };
  const pxPerRad = h / ((fovDeg * Math.PI) / 180);
  let best = null;
  const consider = (score, make) => { if (!best || score < best.score) best = { score, make }; };

  // Resolved bodies: hit inside the disc, nearest first.
  for (const b of u.nearBodies) {
    if (!b.group || !b.group.visible) {
      // Unresolved bodies can still be clicked as points.
      if (b.screenR < 0.35 && b.dist < 1e14) {
        const p = project(b.rel);
        if (!p) continue;
        const d = Math.hypot(p[0] - x, p[1] - y);
        if (d < 12) consider(1 + d / 12, () => bodyTarget(u, targets, b));
      }
      continue;
    }
    const p = project(b.rel);
    if (!p) continue;
    const d = Math.hypot(p[0] - x, p[1] - y);
    if (d < b.screenR + 6) consider(d < b.screenR ? b.dist / 1e30 : 0.5 + d / 100, () => bodyTarget(u, targets, b));
  }

  // Catalogue stars.
  const camLy = null;
  for (const s of u.stars) {
    const rel = sub(s.upos, cam);
    const p = project(rel);
    if (!p) continue;
    const dx = p[0] - x, dy = p[1] - y;
    if (Math.abs(dx) > 20 || Math.abs(dy) > 20) continue;
    const dLy = p[2] / LY;
    const m = s.absMag + 5 * Math.log10(Math.max(dLy / 3.2616, 1e-6)) - 5;
    const r = Math.max(6, Math.min(18, 14 - m));
    const d = Math.hypot(dx, dy);
    if (d < r) consider(1 + d / r + m * 0.02, () => targets.star(s));
  }
  // Sector stars.
  for (const [, cell] of u.cells) {
    const lc = u.toLocal(cell.galaxy, cam);
    const q = cell.galaxy.quat;
    for (let i = 0; i < cell.absMag.length; i++) {
      const lx = cell.origin[0] + cell.pos[i * 3] - lc[0], ly = cell.origin[1] + cell.pos[i * 3 + 1] - lc[1], lz = cell.origin[2] + cell.pos[i * 3 + 2] - lc[2];
      const dLy = Math.hypot(lx, ly, lz);
      const m = cell.absMag[i] + 5 * Math.log10(Math.max(dLy / 3.2616, 1e-6)) - 5;
      if (m > 9) continue;
      _v.set(lx, ly, lz).applyQuaternion(q);
      const p = project([_v.x, _v.y, _v.z]);
      if (!p) continue;
      const d = Math.hypot(p[0] - x, p[1] - y);
      const r = Math.max(6, Math.min(18, 14 - m));
      if (d < r) consider(1 + d / r + m * 0.02, () => targets.procStar(u.sectorStar(cell, i)));
    }
  }
  // Deep-sky objects and galaxies (extended): weaker priority than points.
  for (const o of u.deep) {
    const p = project(sub(o.upos, cam));
    if (!p) continue;
    const rpx = Math.max(10, ((o.sizeLy / 2) * LY / Math.max(p[2], 1)) * pxPerRad);
    const d = Math.hypot(p[0] - x, p[1] - y);
    if (d < rpx) consider(2 + d / rpx, () => targets.deep(o));
  }
  for (const e of u.galaxies) {
    if (u.current && u.current.e === e) continue;
    const p = project(sub(e.center, cam));
    if (!p) continue;
    const rpx = Math.max(9, (((e.rec.diamKly || 20) * 500 * LY) / Math.max(p[2], 1)) * pxPerRad * 0.6);
    const d = Math.hypot(p[0] - x, p[1] - y);
    if (d < rpx) consider(2.5 + d / rpx, () => targets.galaxy(e));
  }
  if (u.farGalaxies) {
    for (const g of u.farGalaxies.list) {
      if (g.entry) continue;
      const p = project(sub(g.upos || (g.upos = UPos.fromLy(g.posLy[0], g.posLy[1], g.posLy[2])), cam));
      if (!p) continue;
      const rpx = Math.max(7, ((g.diamKly * 500 * LY) / Math.max(p[2], 1)) * pxPerRad * 0.6);
      const d = Math.hypot(p[0] - x, p[1] - y);
      if (d < rpx) consider(2.7 + d / rpx, () => targets.galaxy(u.promoteGalaxy(g)));
    }
  }
  for (const [, cell] of u.procGal) {
    for (const g of cell.list) {
      const p = project(sub(g.upos, cam));
      if (!p) continue;
      const rpx = Math.max(8, ((g.diamKly * 500 * LY) / Math.max(p[2], 1)) * pxPerRad * 0.6);
      const d = Math.hypot(p[0] - x, p[1] - y);
      if (d < rpx) consider(2.6 + d / rpx, () => targets.galaxy(u.promoteGalaxy(g)));
    }
  }
  return best ? best.make() : null;
}

export function bodyTarget(u, targets, b) {
  if (u.solar.has(b.def.id)) return targets.solar(b.def.id);
  if (b.def.id.startsWith("deep:")) {
    const o = u.deep.find((x) => "deep:" + x.name === b.def.id);
    return o ? targets.deep(o) : null;
  }
  for (const [, sys] of u.systems) {
    if (sys.starBody === b) return sys.rec.real ? targets.star(sys.rec) : targets.procStar(sys.rec);
    if (sys.bodies.includes(b)) return targets.sysBody(b);
  }
  return null;
}
