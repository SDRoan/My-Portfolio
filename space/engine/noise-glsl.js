// GLSL twin of noise.js — same hash, same octaves, same offsets. WebGL2 only
// (unsigned integer arithmetic); three.js r160 compiles ShaderMaterials as
// GLSL ES 3.0 there.

export const NOISE_GLSL = /* glsl */ `
uint pcg3(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v.x ^ v.y ^ v.z;
}
float lattice(ivec3 i, uint seed) {
  uvec3 u = uvec3(i) + uvec3(seed, seed * 3u, 0u);
  return float(pcg3(u)) * (1.0 / 4294967296.0);
}
float vnoise(vec3 p, uint seed) {
  vec3 fl = floor(p);
  ivec3 i = ivec3(fl);
  vec3 f = p - fl;
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = lattice(i, seed), b = lattice(i + ivec3(1,0,0), seed);
  float c = lattice(i + ivec3(0,1,0), seed), d = lattice(i + ivec3(1,1,0), seed);
  float e = lattice(i + ivec3(0,0,1), seed), g = lattice(i + ivec3(1,0,1), seed);
  float h = lattice(i + ivec3(0,1,1), seed), k = lattice(i + ivec3(1,1,1), seed);
  float x1 = mix(a, b, u.x), x2 = mix(c, d, u.x), x3 = mix(e, g, u.x), x4 = mix(h, k, u.x);
  return mix(mix(x1, x2, u.y), mix(x3, x4, u.y), u.z) * 2.0 - 1.0;
}
float fbm(vec3 p, uint seed, int oct) {
  float sum = 0.0, amp = 0.5, f = 1.0;
  for (int i = 0; i < 12; i++) {
    if (i >= oct) break;
    float fi = float(i);
    sum += amp * vnoise(p * f + vec3(fi * 17.13, fi * 9.71, fi * 3.37), seed + uint(i));
    f *= 2.03; amp *= 0.5;
  }
  return sum;
}
float ridged(vec3 p, uint seed, int oct) {
  float sum = 0.0, amp = 0.5, f = 1.0, w = 1.0;
  for (int i = 0; i < 10; i++) {
    if (i >= oct) break;
    float fi = float(i);
    float n = 1.0 - abs(vnoise(p * f + vec3(fi * 5.17, fi * 11.3, fi * 7.91), seed + 31u + uint(i)));
    n *= n * w;
    w = min(1.0, n * 2.0);
    sum += amp * n;
    f *= 2.07; amp *= 0.5;
  }
  return sum;
}
float craters(vec3 p, uint seed, float freq) {
  p *= freq;
  vec3 fl = floor(p);
  ivec3 i0 = ivec3(fl);
  float h = 0.0;
  for (int dz = -1; dz <= 1; dz++) for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
    ivec3 c = i0 + ivec3(dx, dy, dz);
    if (lattice(c, seed + 101u) > 0.45) continue;
    vec3 pt = vec3(c) + vec3(lattice(c, seed + 102u), lattice(c, seed + 103u), lattice(c, seed + 104u));
    float rad = 0.15 + 0.35 * lattice(c, seed + 105u);
    float d = length(p - pt) / rad;
    if (d < 1.0) h += (d * d - 1.0) * 0.6;
    else if (d < 1.6) { float t = (d - 1.0) / 0.6; h += 0.25 * (1.0 - t) * (1.0 - t); }
  }
  return h;
}
// params: x cont, y mount, z crater, w craterFreq ; warp separately
float terrainHeight(vec3 p, uint seed, vec4 P, float warp, int detail) {
  float wx = fbm(vec3(p.x * P.x + 3.1, p.y * P.x, p.z * P.x), seed + 7u, 3) * warp;
  vec3 q = p + vec3(wx, wx * 0.7, -wx * 0.4);
  float c = fbm(q * P.x, seed, 7 + detail);
  float m = ridged(q * P.x * 3.1, seed, 6 + detail);
  float h = c * 1.4 + m * P.y * clamp((c + 0.05) * 3.0, 0.0, 1.0);
  if (P.z > 0.0) h += P.z * (craters(p, seed, P.w) + 0.5 * craters(p, seed + 9u, P.w * 3.3)
    + (detail > 0 ? 0.22 * craters(p, seed + 17u, P.w * 11.7) : 0.0));
  return h;
}
`;

// Log depth buffer chunks for hand-written shaders in the near pass, which
// spans millimetres to a billion compressed metres.
export const LOGDEPTH_VERT_PARS = "\n#include <common>\n#include <logdepthbuf_pars_vertex>\n";
export const LOGDEPTH_VERT = "\n#include <logdepthbuf_vertex>\n";
export const LOGDEPTH_FRAG_PARS = "\n#include <logdepthbuf_pars_fragment>\n";
export const LOGDEPTH_FRAG = "\n#include <logdepthbuf_fragment>\n";
