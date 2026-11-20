// Rock placement (no dependencies: runs in the surface workers).
//
// Rocks sit on a stable latitude/longitude lattice of ~3 m cells, so the same
// rock is always in the same place. Each cell's chance of holding a rock
// rises with the local slope (crater walls, scarps, ejecta-strewn rims shed
// boulders) and with a patchiness field, and falls on smooth flats. Sizes
// follow a power law. Each rock rests on the body's real ground function,
// sunk about a third of its height.

const CELL = 3;
export const ROCK_RADIUS = 120;            // beyond this, no individual rocks

function hash(a, b, s) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// → { origin: [x,y,z] (body frame, m), rocks: Float32Array of 10 per rock:
//     x, y, z (relative to origin), size, q (4: orientation quaternion), shape (0–2), tone (0–1) }
export function placeRocks(surf, lat, lon, style) {
  const R = surf.R, dLat = CELL / R, n = Math.ceil(ROCK_RADIUS / CELL);
  const o = [Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon)];
  const oR = surf.radiusAt(o[0], o[1], o[2], 5), origin = [o[0] * oR, o[1] * oR, o[2] * oR];
  const out = [];
  const i0 = Math.round(lat / dLat);
  const hAt = (a, b) => { const d = [Math.cos(a) * Math.cos(b), Math.sin(a), -Math.cos(a) * Math.sin(b)]; return surf.radiusAt(d[0], d[1], d[2], 5); };
  for (let i = i0 - n; i <= i0 + n; i++) {
    const la = i * dLat, dLon = CELL / (R * Math.max(0.02, Math.cos(la))), j0 = Math.round(lon / dLon);
    for (let j = j0 - n; j <= j0 + n; j++) {
      const a = la + (hash(i, j, 2) - 0.5) * dLat, b = j * dLon + (hash(i, j, 3) - 0.5) * dLon;
      const dx = (b - lon) * Math.cos(lat) * R, dy = (a - lat) * R;
      const dist = Math.hypot(dx, dy);
      if (dist > ROCK_RADIUS) continue;
      const u = hash(i, j, 1);
      if (u > style.density * 2.5) continue;                     // cheap reject before sampling the ground
      // Slope over ±6 m from the real ground; patchiness on ~40 m.
      const h0 = hAt(a, b), hE = hAt(a, b + 6 / (R * Math.max(0.02, Math.cos(a)))), hN = hAt(a + 6 / R, b);
      const slope = Math.hypot(hE - h0, hN - h0) / 6;
      const patch = 0.5 + 0.5 * Math.sin(i * 0.15 + hash(i >> 4, j >> 4, 9) * 6.28) * Math.cos(j * 0.13 + hash(j >> 4, i >> 4, 10) * 6.28);
      const p = style.density * (0.35 + 0.65 * patch) * (0.55 + Math.min(2.5, slope * 6));
      if (u > p) continue;
      let size = Math.min(style.max, 0.06 / Math.pow(1 - hash(i, j, 4) * 0.995, 0.55));
      if (slope > 0.25) size = Math.min(style.max, size * 1.5);      // bigger blocks on steep ground
      if (size < 0.15 && dist > 30) continue;                       // pebbles only close by
      const d = [Math.cos(a) * Math.cos(b), Math.sin(a), -Math.cos(a) * Math.sin(b)];
      const r = h0 + size * style.flat * 0.3;
      // Orientation: local up, a random heading and a slight tilt.
      const yaw = hash(i, j, 6) * 6.283, tx = (hash(i, j, 5) - 0.5) * 0.5, tz = (hash(i, j, 7) - 0.5) * 0.5;
      const q = upQuat(d, yaw, tx, tz);
      out.push(d[0] * r - origin[0], d[1] * r - origin[1], d[2] * r - origin[2], size, q[0], q[1], q[2], q[3], Math.floor(hash(i, j, 8) * 3), hash(i, j, 11));
    }
  }
  return { origin, rocks: new Float32Array(out) };
}

// Quaternion turning +Y to `up`, then yawing about it and tilting a little.
function upQuat(up, yaw, tx, tz) {
  // from (0,1,0) to up
  const x = up[2], z = -up[0], w = 1 + up[1], l = Math.hypot(x, w, z) || 1;
  let a = [x / l, 0, z / l, w / l];
  if (up[1] < -0.9999) a = [1, 0, 0, 0];
  const mul = (p, q) => [p[3] * q[0] + p[0] * q[3] + p[1] * q[2] - p[2] * q[1], p[3] * q[1] - p[0] * q[2] + p[1] * q[3] + p[2] * q[0], p[3] * q[2] + p[0] * q[1] - p[1] * q[0] + p[2] * q[3], p[3] * q[3] - p[0] * q[0] - p[1] * q[1] - p[2] * q[2]];
  const ry = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], rx = [Math.sin(tx / 2), 0, 0, Math.cos(tx / 2)], rz = [0, 0, Math.sin(tz / 2), Math.cos(tz / 2)];
  return mul(mul(mul(a, ry), rx), rz);
}
