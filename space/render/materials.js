// Shader materials. Two families:
//   far pass (light-years, no depth): luminous points and dust
//   near pass (compressed metres, log depth): planets, atmospheres, rings,
//     stars, glows, black holes
// Everything outputs linear HDR; tone mapping and sRGB happen once at the end.

import * as THREE from "three";
import { SHADOW_GLSL, shadowUniforms } from "./shadows.js";
import { NOISE_GLSL, LOGDEPTH_VERT_PARS, LOGDEPTH_VERT, LOGDEPTH_FRAG_PARS, LOGDEPTH_FRAG } from "../engine/noise-glsl.js";

// ── luminous points ──
// Brightness follows apparent magnitude: m = M + 5 log10(d / 10 pc), with M
// from each point's luminosity, so stars brighten as you approach them and
// galaxies fade with distance — no per-object fudge. A point with a physical
// radius becomes a soft disc once it subtends more than a pixel, keeping its
// total light (surface brightness falls as it spreads).
//
// Optional interstellar extinction: light from each point is dimmed by the
// dust between it and the camera, integrated analytically through a thin
// exponential dust layer in the galaxy's own frame (~1 mag per kpc in the
// plane near the Sun). That is what hides the inner Milky Way along the
// plane, and what draws the lane through an edge-on spiral.
// opts.shape: points carry aMajor (major-axis unit vector, render frame) and
// aRatio (minor/major); once resolved they draw as oriented ellipses with the
// same total light, and discs get a brighter central bulge.
export function lumPointsMaterial(opts = {}) {
  return new THREE.ShaderMaterial({
    defines: opts.shape ? { SHAPE: 1 } : {},
    uniforms: {
      uPxPerRad: { value: 1000 }, uMagZero: { value: 6.5 }, uExposure: { value: 1 },
      uFadeNear: { value: new THREE.Vector2(opts.fadeNear0 || 0, opts.fadeNear1 || 0) },
      uFadeFar: { value: new THREE.Vector2(opts.fadeFar0 || 1e30, opts.fadeFar1 || 2e30) },
      uHide: { value: new THREE.Vector4(0, 0, 0, -1) }, uMaxPx: { value: 160 }, uAlpha: { value: 1 },
      uCore: { value: opts.core || 1.4 }, uSoft: { value: opts.soft ? 1 : 0 },
      uExt: { value: new THREE.Vector4(0, 2.8e-4, 330, 50000) },
      uCamLocal: { value: new THREE.Vector3() }, uLocalOffset: { value: new THREE.Vector3() },
      uTint: { value: new THREE.Vector3(1, 1, 1) }
    },
    vertexShader: /* glsl */ `
      attribute float aLum; attribute vec3 aColor; attribute float aSize;
      uniform float uPxPerRad, uMagZero, uExposure, uMaxPx, uAlpha, uCore;
      uniform vec2 uFadeNear, uFadeFar; uniform vec4 uHide;
      uniform vec4 uExt; uniform vec3 uCamLocal, uLocalOffset, uTint;
      varying vec3 vCol; varying float vI; varying float vHard;
      #ifdef SHAPE
      attribute vec3 aMajor; attribute float aRatio;
      varying vec2 vAxis; varying float vRatio;
      #endif
      // Dust column between camera and point: ∫ exp(−|y|/h) along the segment,
      // weighted by the disc's radial falloff at the midpoint.
      float extinction(vec3 a, vec3 b) {
        float L = distance(a, b), h = uExt.z;
        float y0 = a.y, y1 = b.y, dy = abs(y1 - y0);
        float col;
        if (dy < 1.0) col = L * exp(-abs(y0) / h);
        else if (y0 * y1 >= 0.0) col = h * L / dy * abs(exp(-abs(y0) / h) - exp(-abs(y1) / h));
        else col = h * L / dy * ((1.0 - exp(-abs(y0) / h)) + (1.0 - exp(-abs(y1) / h)));
        float rm = length(((a + b) * 0.5).xz);
        float radial = min(6.0, exp(-(rm - 0.53 * uExt.w) / (uExt.w / 3.5)));
        return uExt.y * col * radial;
      }
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float d = max(length(mv.xyz), 1e-12);
        if (uHide.w > 0.0 && distance(mv.xyz, uHide.xyz) < uHide.w) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
        float dpc = d / 3.2616;
        float m = 4.83 - 2.5 * log(max(aLum, 1e-20)) / log(10.0) - 5.0 + 5.0 * log(dpc) / log(10.0);
        float flux = pow(10.0, -0.4 * (m - uMagZero));
        float ang = aSize / d * uPxPerRad;
        // Unresolved: a core that swells gently with brightness. Resolved: true size.
        float grow = clamp(pow(max(flux, 1.0), 0.16), 1.0, 7.0);
        float pt = uCore * grow;
        float sizePx = max(ang, pt);
        float I = flux * (pt * pt) / (sizePx * sizePx) / (grow * grow);
        float fade = smoothstep(uFadeNear.x, uFadeNear.y, d) * (1.0 - smoothstep(uFadeFar.x, uFadeFar.y, d));
        if (uExt.x > 0.5) I *= exp(-extinction(uCamLocal, position + uLocalOffset));
        vI = min(I, 60.0) * uExposure * fade * uAlpha;
        vHard = ang > pt ? 0.0 : 1.0;
        vCol = aColor * uTint;
        #ifdef SHAPE
        // Screen direction of the major axis; shape fades in as the point resolves.
        vec2 ax = (modelViewMatrix * vec4(aMajor, 0.0)).xy;
        vAxis = length(ax) > 1e-6 ? normalize(ax) : vec2(1.0, 0.0);
        vRatio = mix(1.0, clamp(aRatio, 0.18, 1.0), smoothstep(1.5, 5.0, ang));
        vI /= vRatio;                                   // same light over a thinner shape
        #endif
        gl_PointSize = min(sizePx * 2.0, uMaxPx);
        gl_Position = projectionMatrix * mv;
        if (vI < 0.0004) gl_PointSize = 0.0;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uSoft;
      varying vec3 vCol; varying float vI; varying float vHard;
      #ifdef SHAPE
      varying vec2 vAxis; varying float vRatio;
      #endif
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        #ifdef SHAPE
        p.y = -p.y;                                     // point coords run downward
        p = vec2(dot(p, vAxis), dot(p, vec2(-vAxis.y, vAxis.x)) / vRatio);
        #endif
        float r2 = dot(p, p);
        if (r2 > 1.0) discard;
        // Stars: a tight Gaussian core with faint wings. Extended: a soft blob.
        float a = vHard > 0.5 && uSoft < 0.5 ? exp(-r2 * 5.5) + 0.06 * exp(-r2 * 1.2) : exp(-r2 * 2.6) * (1.0 - r2);
        #ifdef SHAPE
        a += (1.0 - vRatio) * 0.8 * exp(-r2 * 16.0);     // flattened discs show a bulge
        #endif
        gl_FragColor = vec4(vCol * vI * a, 1.0);
      }`,
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending
  });
}

// Dust dims whatever is behind it (multiplicative). Order-independent enough
// for lanes seen against their own galaxy.
export function dustMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uPxPerRad: { value: 1000 }, uMaxPx: { value: 160 }, uFadeNear: { value: new THREE.Vector2(0, 0) }, uStrength: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute float aSize; attribute float aOpacity;
      uniform float uPxPerRad, uMaxPx, uStrength; uniform vec2 uFadeNear;
      varying float vOp;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float d = max(length(mv.xyz), 1e-9);
        float px = aSize / d * uPxPerRad;
        // Dust only reads once it spans pixels; tiny specks would just speckle.
        vOp = aOpacity * uStrength * smoothstep(1.5, 6.0, px) * smoothstep(uFadeNear.x, uFadeNear.y, d) * (px > uMaxPx * 0.5 ? (uMaxPx * 0.5) / px : 1.0);
        gl_PointSize = min(px * 2.0, uMaxPx);
        gl_Position = projectionMatrix * mv;
        if (vOp < 0.003) gl_PointSize = 0.0;
      }`,
    fragmentShader: /* glsl */ `
      varying float vOp;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot(p, p);
        if (r2 > 1.0) discard;
        float a = vOp * (1.0 - r2) * (1.0 - r2);
        gl_FragColor = vec4(mix(vec3(1.0), vec3(0.62, 0.5, 0.42), a), 1.0);
      }`,
    transparent: true, depthWrite: false, depthTest: false,
    blending: THREE.MultiplyBlending, premultipliedAlpha: true
  });
}

// Plain line material for orbits in the far pass.
export function orbitLineMaterial(color, opacity) {
  return new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending });
}

// ── planets and moons ──
// One shader, four modes: 0 texture map, 1 procedural rocky, 2 procedural gas
// giant, 3 Earth (day/night/ocean glint). Positions in object space are on the
// unit sphere, so latitude/longitude and noise come straight from them.
export const PLANET_FRAG = /* glsl */ `
  uniform int uMode; uniform sampler2D uMap; uniform sampler2D uNight;
  uniform vec3 uLightDir; uniform vec3 uLightCol; uniform vec3 uLight2Dir; uniform vec3 uLight2Col;
  uniform float uAmbient; uniform float uSeedF; uniform vec4 uTerr; uniform float uWarp;
  uniform vec3 uC0, uC1, uC2, uOcean, uIceCol; uniform float uSea, uIceLat, uLava, uBump, uAirless;
  uniform vec4 uGas; uniform int uSpecial; uniform float uTime; uniform float uDetail; uniform float uRelief;
  uniform vec3 uAtmoTint; uniform float uAtmoAmt; uniform vec3 uDebug;
  uniform sampler2D uElev; uniform float uElevOn; uniform float uRadius; uniform float uElevScale; uniform float uDiffuse; uniform float uMapShift; uniform float uMapFill; uniform float uMapTint;
  uniform sampler2D uImg0, uImg1; uniform vec4 uImg0B, uImg1B; uniform float uImg0On, uImg1On;
  // Global land cover around the camera (earth/global.js): one byte per
  // 1/120° cell, class << 4 | water quarter << 2 | tree quarter.
  uniform sampler2D uLc; uniform vec4 uLcB; uniform float uLcOn; uniform vec2 uLcSize;
  // The nearest detailed region pack's box: inside it the 10–30 m DEM (with
  // tidal water burned in) knows where water is better than ~925 m land cover.
  uniform vec4 uPackB; uniform float uPackOn;
  varying vec3 vObj; varying vec3 vN; varying vec3 vView; varying float vH; varying mat3 vModel;
  #ifdef TERRAIN
  varying float vElev; varying vec3 vMet;
  uniform vec4 uSurf; uniform vec3 uSurfTint;
  // Periodic value noise on a metre lattice (period 2048 m matches the
  // chunks' aBase wrap), for ground detail below the mesh resolution.
  float h3(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.x + p.y) * p.z); }
  float vnP(vec3 x, float P) {
    vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
    float a = h3(mod(i, P)), b = h3(mod(i + vec3(1, 0, 0), P)), c = h3(mod(i + vec3(0, 1, 0), P)), d = h3(mod(i + vec3(1, 1, 0), P));
    float e = h3(mod(i + vec3(0, 0, 1), P)), g = h3(mod(i + vec3(1, 0, 1), P)), k = h3(mod(i + vec3(0, 1, 1), P)), l = h3(mod(i + vec3(1, 1, 1), P));
    return mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), mix(mix(e, g, f.x), mix(k, l, f.x), f.y), f.z);
  }
  float detailN(vec3 m, float q, int oct) { float s = 0.0, a = 0.5; for (int o = 0; o < 5; o++) { if (o >= oct) break; s += a * vnP(m * q, 2048.0 * q); q *= 2.0; a *= 0.5; } return s; }
  #endif

  vec2 lonlatUV(vec3 n) { return vec2(0.5 + atan(-n.z, n.x) / 6.2831853, 0.5 + asin(clamp(n.y, -1.0, 1.0)) / 3.14159265); }
  vec3 sampleMap(sampler2D t, vec3 n) {
    vec2 uv = lonlatUV(n);
    uv.x = fract(uv.x + uMapShift);              // maps centred off the prime meridian (see manifest mapLonShift)
    vec2 uv2 = vec2(fract(uv.x + 0.5), uv.y);
    vec2 dx = dFdx(uv), dy = dFdy(uv), dx2 = dFdx(uv2), dy2 = dFdy(uv2);
    if (dot(dx, dx) + dot(dy, dy) > dot(dx2, dx2) + dot(dy2, dy2)) { dx = dx2; dy = dy2; }
    vec3 c = textureGrad(t, uv, dx, dy).rgb;
    // Magnified far past its resolution (a 3.7 km global map seen from a few
    // km up), bilinear filtering shows the texel grid as squares. There, blend
    // to cubic B-spline filtering: four bilinear taps (Sigg & Hadwiger 2005).
    vec2 ts = vec2(textureSize(t, 0));
    float mag = 1.0 / max(length(dx * ts) + length(dy * ts), 1e-6);
    if (mag > 1.5) {
      vec2 p = uv * ts - 0.5, f = fract(p), i = p - f;
      vec2 f2 = f * f, f3 = f2 * f;
      vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0, w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
      vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0, w3 = f3 / 6.0;
      vec2 g0 = w0 + w1, g1 = w2 + w3;
      vec2 h0 = (i - 0.5 + w1 / g0) / ts, h1 = (i + 1.5 + w3 / g1) / ts;
      vec3 b = g0.y * (g0.x * textureLod(t, vec2(h0.x, h0.y), 0.0).rgb + g1.x * textureLod(t, vec2(h1.x, h0.y), 0.0).rgb)
             + g1.y * (g0.x * textureLod(t, vec2(h0.x, h1.y), 0.0).rgb + g1.x * textureLod(t, vec2(h1.x, h1.y), 0.0).rgb);
      c = mix(c, b, smoothstep(1.5, 3.0, mag));
    }
    return c;
  }
  float hgt(vec3 n) { return terrainHeight(n, uint(uSeedF), uTerr, uWarp, int(uDetail)); }
  #ifdef TERRAIN
  // ── Earth: ground from global land cover (ESA WorldCover classes) ──
  float lcByte(ivec2 p) { return floor(texelFetch(uLc, clamp(p, ivec2(0), ivec2(uLcSize) - 1), 0).r * 255.0 + 0.5); }
  // Water share, bilinear between cell centres (smooth coasts, lakes, wide rivers).
  float lcWater(vec2 c) {
    vec2 p = c - 0.5, f = fract(p); ivec2 i = ivec2(floor(p));
    float a = mod(floor(lcByte(i) / 4.0), 4.0), b = mod(floor(lcByte(i + ivec2(1, 0)) / 4.0), 4.0);
    float d = mod(floor(lcByte(i + ivec2(0, 1)) / 4.0), 4.0), e = mod(floor(lcByte(i + ivec2(1, 1)) / 4.0), 4.0);
    return mix(mix(a, b, f.x), mix(d, e, f.x), f.y) / 3.0;
  }
  // Albedo (linear) of a class at a point; mx/my: local east/north metres.
  vec3 lcAlbedo(float cls, float tree, vec3 n, float mx, float my, vec3 bm) {
    float k1 = fbm(n * 9000.0, 21u, 3), k2 = fbm(n * 60000.0, 22u, 2);
    vec3 c;
    if (cls < 1.5) c = mix(vec3(0.022, 0.045, 0.02), vec3(0.04, 0.07, 0.03), 0.5 + 0.5 * k1) * (0.85 + 0.3 * k2);           // tree cover: canopy
    else if (cls < 2.5) c = mix(vec3(0.09, 0.085, 0.05), vec3(0.05, 0.07, 0.035), 0.5 + 0.5 * k1);                        // shrubland
    else if (cls < 3.5) c = mix(vec3(0.075, 0.1, 0.035), vec3(0.13, 0.13, 0.06), 0.5 + 0.5 * k1);                         // grassland
    else if (cls < 4.5) {                                                                                                 // cropland: a patchwork of fields
      vec2 q = vec2(mx, my) / 180.0; vec2 f = floor(q + vec2(0.0, floor(q.x) * 0.37));
      float h = fract(sin(dot(f, vec2(12.9898, 78.233))) * 43758.5453);
      c = h < 0.35 ? vec3(0.07, 0.1, 0.035) : h < 0.6 ? vec3(0.17, 0.15, 0.08) : h < 0.8 ? vec3(0.12, 0.09, 0.055) : vec3(0.1, 0.12, 0.04);
      float row = 0.9 + 0.1 * sin((h > 0.5 ? mx : my) * 3.14);
      c *= row * (0.92 + 0.16 * k2);
    } else if (cls < 5.5) {                                                                                               // built-up: blocks and streets
      vec2 q = vec2(mx, my) / 85.0, f = fract(q); vec2 id = floor(q);
      float h = fract(sin(dot(id, vec2(41.3, 289.1))) * 43758.5453);
      // Painted blocks only where no 3D streets are built (beyond ~3 km); nearer,
      // plain pavement under the procedural or mapped streets and buildings.
      float far = smoothstep(2500.0, 6000.0, length(vView));
      float street = (1.0 - step(0.12, f.x) * step(0.12, f.y)) * far;
      h = mix(0.5 + 0.2 * k1, h, far);
      c = mix(vec3(0.15, 0.145, 0.14) * (0.8 + 0.4 * h), vec3(0.06, 0.06, 0.065), street);
      c = mix(c, vec3(0.05, 0.08, 0.035), step(0.88, h) * (1.0 - street));                                               // the odd green lot
    } else if (cls < 6.5) c = mix(vec3(0.28, 0.23, 0.17), vec3(0.2, 0.18, 0.15), 0.5 + 0.5 * k1) * (0.9 + 0.2 * k2);       // bare / sparse
    else if (cls < 7.5) c = vec3(0.78, 0.8, 0.83) * (0.95 + 0.05 * k1);                                                   // snow and ice
    else if (cls < 8.5) c = vec3(0.03, 0.06, 0.08);                                                                       // water
    else if (cls < 9.5) c = mix(vec3(0.05, 0.07, 0.035), vec3(0.04, 0.06, 0.06), 0.5 + 0.5 * k1);                        // herbaceous wetland
    else if (cls < 10.5) c = vec3(0.018, 0.045, 0.02) * (0.85 + 0.3 * k1);                                                // mangroves
    else c = mix(vec3(0.12, 0.12, 0.08), vec3(0.09, 0.1, 0.06), 0.5 + 0.5 * k1);                                         // moss and lichen
    // Scattered trees in open classes (tree share), and a hint of the regional hue from the satellite map.
    if (cls > 1.5 && cls < 6.5 && cls != 5.0) c = mix(c, vec3(0.025, 0.05, 0.022), tree * 0.6 * step(0.55, 0.5 + 0.5 * fbm(n * 40000.0, 23u, 2)));
    float bl = max(dot(bm, vec3(0.333)), 1e-3), cl = max(dot(c, vec3(0.333)), 1e-3);
    return mix(c, bm * (cl / bl), 0.25);
  }
  #endif

  vec3 rockyColor(vec3 n, float h, out float emissive, out float water) {
    emissive = 0.0; water = 0.0;
    float lat = n.y;
    vec3 col = h < 0.0 ? mix(uC0, uC1, smoothstep(-0.6, 0.0, h)) : mix(uC1, uC2, smoothstep(0.0, 0.9, h));
    col *= 0.88 + 0.24 * fbm(n * 38.0, uint(uSeedF) + 50u, 3);
    if (uSea > -5.0 && h < uSea) {
      float depth = clamp((uSea - h) * 2.0, 0.0, 1.0);
      col = mix(uOcean * 1.6, uOcean * 0.6, depth);
      water = 1.0;
      if (uLava > 0.5) {
        // Lava seas: a dark cooling crust broken by glowing cracks.
        float crust = ridged(n * 22.0, uint(uSeedF) + 61u, 4);
        emissive = (1.0 - depth * 0.5) * (0.12 + 0.88 * smoothstep(0.55, 0.9, crust));
        col = vec3(0.06, 0.045, 0.04);
        water = 0.0;
      }
    }
    if (uLava > 0.0 && uLava <= 0.5) {
      float crack = ridged(n * 9.0, uint(uSeedF) + 70u, 4);
      emissive = smoothstep(0.82, 0.95, crack) * uLava * 2.0;
    }
    float ice = smoothstep(uIceLat - 0.04, uIceLat + 0.02, abs(lat) + h * 0.05);
    col = mix(col, uIceCol, ice);
    if (ice > 0.5) water = 0.0;
    return col;
  }

  vec3 gasColor(vec3 n) {
    float lat = n.y;
    float turb = fbm(n * vec3(2.0, 7.0, 2.0) * (1.0 + uGas.y), uint(uSeedF), 5) * uGas.y;
    float b = sin((lat + turb * 0.12) * uGas.x * 3.14159) * 0.5 + 0.5;
    float b2 = sin((lat * 1.7 + turb * 0.2) * uGas.x * 1.3) * 0.5 + 0.5;
    vec3 col = mix(mix(uC0, uC1, b), uC2, b2 * 0.6);
    col *= 0.9 + 0.2 * fbm(n * vec3(6.0, 30.0, 6.0), uint(uSeedF) + 9u, 3);
    if (uGas.z > 0.0) {
      vec3 sp = normalize(vec3(0.6, -0.35, 0.72));
      float d = length((n - sp) * vec3(1.0, 1.8, 1.0));
      col = mix(col, uC0 * vec3(1.15, 0.8, 0.7), smoothstep(0.16, 0.08, d) * uGas.z);
    }
    return col;
  }

  void specials(vec3 n, inout vec3 col) {
    float lon = atan(-n.z, n.x);
    if (uSpecial == 1) {                       // Iapetus: dark leading hemisphere
      col *= mix(0.12, 1.0, smoothstep(-0.4, 0.4, cos(lon - 1.57)));
    } else if (uSpecial == 2) {                // Pluto: Tombaugh Regio, Cthulhu
      float heart = smoothstep(0.42, 0.3, length(vec2(lon - 3.0, n.y - 0.2) * vec2(0.9, 1.4)));
      float dark = smoothstep(-0.05, -0.35, n.y) * smoothstep(0.7, 0.2, abs(lon - 1.8));
      col = mix(col, vec3(0.93, 0.88, 0.82), heart);
      col = mix(col, vec3(0.32, 0.17, 0.1), dark * 0.85);
    } else if (uSpecial == 3) {                // Io: sulphur, plains and volcanic spots
      float f = fbm(n * 6.0, uint(uSeedF) + 3u, 5);
      col = mix(vec3(0.85, 0.75, 0.3), vec3(0.95, 0.9, 0.6), smoothstep(-0.2, 0.3, f));
      col = mix(col, vec3(0.55, 0.25, 0.08), smoothstep(0.6, 0.75, fbm(n * 14.0, uint(uSeedF) + 4u, 3) + 0.5) * 0.8);
      col = mix(col, vec3(0.1, 0.07, 0.05), smoothstep(0.55, 0.62, vnoise(n * 22.0, uint(uSeedF) + 5u)) * 0.9);
    } else if (uSpecial == 4) {                // Europa: lineae over bright ice
      float l = ridged(n * 7.0, uint(uSeedF) + 11u, 4);
      col = mix(vec3(0.85, 0.82, 0.76), vec3(0.6, 0.42, 0.28), smoothstep(0.75, 0.92, l));
    } else if (uSpecial == 5) {                // Titan: opaque orange haze
      col = vec3(0.78, 0.55, 0.28) * (0.92 + 0.08 * fbm(n * vec3(2.0, 6.0, 2.0), uint(uSeedF), 3));
    } else if (uSpecial == 6) {                // Enceladus: fresh ice, tiger stripes
      col = vec3(0.95, 0.97, 1.0) * (0.95 + 0.05 * fbm(n * 20.0, uint(uSeedF), 3));
      if (n.y < -0.75) col = mix(col, vec3(0.5, 0.65, 0.75), smoothstep(0.9, 0.97, ridged(n * 12.0, uint(uSeedF) + 2u, 2)));
    } else if (uSpecial == 7) {                // comet nucleus: dark crust
      col = vec3(0.07, 0.065, 0.06) * (0.8 + 0.4 * fbm(n * 8.0, uint(uSeedF), 4));
    } else if (uSpecial == 8) {                // Charon: Mordor Macula, the red cap
      col = mix(col, vec3(0.35, 0.18, 0.12), smoothstep(0.75, 0.9, n.y) * 0.9);
    } else if (uSpecial == 9) {                // Triton: pinkish south cap, cantaloupe terrain
      col = mix(col, vec3(0.88, 0.75, 0.7), smoothstep(-0.1, -0.45, n.y));
    }
  }

  vec3 shade(vec3 nGeo, vec3 nObj, vec3 base, float h, float water, float emissive, vec3 Nworld) {
    vec3 V = normalize(vView);
    vec3 N = Nworld;
    float mu = max(dot(N, V), 0.0);
    vec3 L = normalize(uLightDir);
    float mu0 = max(dot(N, L), 0.0);
    // Terminator softness on the geometric normal so bumps can't light the night side.
    float geo = smoothstep(-0.03, 0.08, dot(nGeo, L));
    float lam = mu0;
    float ls = 2.0 * mu0 / (mu0 + mu + 1e-4);
    float lit = mix(lam, ls * 0.75, uAirless) * geo;
    #ifdef TERRAIN
    lit *= localShadow(cameraPosition - vView, mu0);          // local sun shadows (render/shadows.js)
    #endif
    // Under a thick atmosphere (Venus, Titan) sunlight arrives scattered from
    // the whole sky: shading flattens toward an even day-side glow.
    lit = mix(lit, 0.42 * smoothstep(-0.25, 0.35, dot(nGeo, L)), uDiffuse);
    vec3 c = base * (uAmbient + lit * uLightCol);
    float mu02 = max(dot(N, normalize(uLight2Dir)), 0.0);
    c += base * mu02 * uLight2Col * smoothstep(-0.03, 0.08, dot(nGeo, normalize(uLight2Dir)));
    if (water > 0.5) {
      vec3 Hh = normalize(L + V);
      c += uLightCol * pow(max(dot(N, Hh), 0.0), 240.0) * 0.16 * geo;
    }
    c += uOcean * emissive * 1.5 * (uLava > 0.5 ? 1.0 : 0.0) + vec3(1.0, 0.35, 0.08) * emissive * (uLava <= 0.5 ? 1.5 : 0.0);
    // Aerial tint toward the limb for bodies with an atmosphere. Up close the
    // ground is seen at grazing angles too (from eye height, all of it), so
    // terrain only takes the tint with distance — not the street at your feet.
    float limb = uAtmoAmt * pow(1.0 - mu, 3.0);
    #ifdef TERRAIN
    limb *= smoothstep(1500.0, 30000.0, length(vView));
    #endif
    c = mix(c, uAtmoTint * (lit + 0.02), limb);
    return c;
  }
`;

export function planetMaterial(opts) {
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uMode: { value: opts.mode }, uMap: { value: opts.map || null }, uNight: { value: opts.night || null },
      uLightDir: { value: new THREE.Vector3(1, 0, 0) }, uLightCol: { value: new THREE.Vector3(1, 1, 1) },
      uLight2Dir: { value: new THREE.Vector3(1, 0, 0) }, uLight2Col: { value: new THREE.Vector3(0, 0, 0) },
      uAmbient: { value: opts.ambient !== undefined ? opts.ambient : 0.012 }, uSeedF: { value: opts.seed || 1 },
      uTerr: { value: new THREE.Vector4(opts.cont || 1.8, opts.mount || 0.5, opts.crater || 0, opts.craterFreq || 6) },
      uWarp: { value: opts.warp || 0.4 },
      uC0: { value: new THREE.Vector3(...(opts.c0 || [0.4, 0.38, 0.36])) }, uC1: { value: new THREE.Vector3(...(opts.c1 || [0.6, 0.57, 0.53])) },
      uC2: { value: new THREE.Vector3(...(opts.c2 || [0.8, 0.77, 0.72])) }, uOcean: { value: new THREE.Vector3(...(opts.ocean || [0.06, 0.16, 0.29])) },
      uIceCol: { value: new THREE.Vector3(...(opts.iceCol || [0.95, 0.97, 0.98])) },
      uSea: { value: opts.sea !== undefined ? opts.sea : -9 }, uIceLat: { value: opts.ice !== undefined ? opts.ice : 2 },
      uLava: { value: opts.lava || 0 }, uBump: { value: opts.bump ? 1 : 0 }, uAirless: { value: opts.airless ? 1 : 0 },
      uGas: { value: new THREE.Vector4(opts.bands || 10, opts.turb || 0.6, opts.storm || 0, opts.glow || 0) },
      uSpecial: { value: opts.special || 0 }, uTime: { value: 0 }, uDetail: { value: 0 }, uRelief: { value: opts.relief || 0.004 },
      uAtmoTint: { value: new THREE.Vector3(...(opts.atmoTint || [0.4, 0.6, 1])) }, uAtmoAmt: { value: opts.atmoAmt || 0 },
      uDebug: { value: new THREE.Vector3(1, 1, 1) },
      // Real elevation (metres) for oceans and relief shading — Earth from ETOPO 2022.
      uElev: { value: opts.elevTex || null }, uElevOn: { value: opts.elevTex ? 1 : 0 }, uRadius: { value: opts.radius || 6.371e6 },
      uElevScale: { value: opts.elevScale || 1e-3 }, uDiffuse: { value: opts.diffuse || 0 },
      // Ground material (terrain chunks): x bump strength, y dust on flats,
      // z ice glint, w how much slopes expose rock; tint = rock colour factor.
      uSurf: { value: new THREE.Vector4(...(opts.surf || [0.6, 0.3, 0, 0.6])) }, uSurfTint: { value: new THREE.Vector3(...(opts.surfTint || [0.7, 0.7, 0.7])) }, uMapShift: { value: opts.mapShift || 0 }, uMapFill: { value: opts.mapFill || 0 }, uMapTint: { value: opts.mapTint || 0 },
      // Regional aerial imagery (Earth region packs), up to two layers,
      // finest last: bounds are (south, west, north, east) in radians.
      uImg0: { value: null }, uImg0B: { value: new THREE.Vector4() }, uImg0On: { value: 0 },
      uImg1: { value: null }, uImg1B: { value: new THREE.Vector4() }, uImg1On: { value: 0 },
      uLc: { value: null }, uLcB: { value: new THREE.Vector4() }, uLcOn: { value: 0 }, uLcSize: { value: new THREE.Vector2(1, 1) },
      uPackB: { value: new THREE.Vector4() }, uPackOn: { value: 0 },
      ...(opts.terrain ? shadowUniforms : {})
    },
    // Terrain chunks carry their direction on the unit sphere as aDir, since
    // their positions are displaced and chunk-relative.
    vertexShader: (opts.terrain ? "#define TERRAIN\n" : "") + LOGDEPTH_VERT_PARS + /* glsl */ `
      varying vec3 vObj; varying vec3 vN; varying vec3 vView; varying float vH; varying mat3 vModel;
      #ifdef TERRAIN
      attribute vec3 aDir; attribute float aElev; attribute vec3 aBase; varying float vElev; varying vec3 vMet;
      #endif
      void main() {
        #ifdef TERRAIN
        vObj = aDir; vElev = aElev; vMet = aBase + position;
        #else
        vObj = position;
        #endif
        vH = 0.0; vModel = mat3(modelMatrix);
        vN = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vView = cameraPosition - wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      ` + LOGDEPTH_VERT + "}",
    fragmentShader: (opts.terrain ? "#define TERRAIN\n" + SHADOW_GLSL : "") + LOGDEPTH_FRAG_PARS + NOISE_GLSL + PLANET_FRAG + /* glsl */ `
      void main() {
        vec3 n = normalize(vObj);
        vec3 Ngeo = normalize(vN);
        vec3 col; float water = 0.0, emi = 0.0, h = 0.0;
        vec3 Nw = Ngeo;
        if (uMode == 0 || uMode == 3) {
          col = sampleMap(uMap, n);
          // Greyscale mosaics: tinted with the body's mean colour.
          if (uMapTint > 0.5) col *= uC1 / max(dot(uC1, vec3(0.3333)), 0.01);
          if (uMapFill > 0.5) {
            // Unimaged (black) areas take procedural colour keyed to the real height.
            if (max(col.r, max(col.g, col.b)) < 0.012) {
              #ifdef TERRAIN
              float ef = vElev;
              #else
              float ef = uElevOn > 0.5 ? textureLod(uElev, lonlatUV(n), 0.0).r : 0.0;
              #endif
              col = rockyColor(n, clamp(ef * uElevScale, -1.0, 1.0), emi, water);
            }
          }
          if (uElevOn > 0.5) {
            // Oceans shaded from real bathymetry: turquoise shelves, deep blue basins.
            float e = textureLod(uElev, lonlatUV(n), 0.0).r;
            #ifdef TERRAIN
            // Up close, the finest elevation there is (detail patches
            // included), computed per vertex on the CPU.
            e = vElev;
            // Global land cover: the ground's class, water and texture, faded
            // in close to the ground (from orbit the satellite map shows).
            float lcW = -1.0;
            if (uMode == 3 && uLcOn > 0.5) {
              float la0 = asin(clamp(n.y, -1.0, 1.0)), lo0 = atan(-n.z, n.x);
              vec2 uvl = vec2((lo0 - uLcB.y) / (uLcB.w - uLcB.y), (uLcB.z - la0) / (uLcB.z - uLcB.x));
              if (uvl.x > 0.0 && uvl.x < 1.0 && uvl.y > 0.0 && uvl.y < 1.0) {
                vec2 cc = uvl * uLcSize;
                // Organic edges: warp the lookup by up to ~0.6 cell.
                vec2 wv = vec2(fbm(n * 3000.0, 31u, 3), fbm(n * 3000.0 + 7.0, 32u, 3)) * 0.6;
                float lw = lcWater(cc + wv * 0.8);
                float v = lcByte(ivec2(floor(cc + wv)));
                float cls = floor(v / 16.0), tree = mod(v, 4.0) / 3.0;
                vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), n) + vec3(1e-6)), north = cross(n, east);
                float fade = 1.0 - smoothstep(60000.0, 220000.0, length(vView));
                if (fade > 0.0) {
                  vec3 lc = lcAlbedo(cls, tree, n, dot(vMet, east), dot(vMet, north), col);
                  col = mix(col, lc, fade * (lw > 0.5 ? 0.0 : 1.0));
                }
                lcW = mix(e <= 0.0 ? 1.0 : 0.0, lw, fade);
              }
            }
            // Regional aerial imagery where a region pack covers this point.
            float imgW = 0.0;
            if (uImg0On + uImg1On > 0.0) {
              float la = asin(clamp(n.y, -1.0, 1.0)), lo = atan(-n.z, n.x);
              // Derivatives taken here, in uniform control flow, for mip selection.
              vec2 gx = vec2(dFdx(lo), dFdx(la)), gy = vec2(dFdy(lo), dFdy(la));
              for (int k = 0; k < 2; k++) {
                vec4 B = k == 0 ? uImg0B : uImg1B;
                float on = k == 0 ? uImg0On : uImg1On;
                if (on < 0.5 || la < B.x || la > B.z || lo < B.y || lo > B.w) continue;
                vec2 uv = vec2((lo - B.y) / (B.w - B.y), (la - B.x) / (B.z - B.x));
                float edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
                float w = smoothstep(0.0, 0.06, edge);
                vec2 sc = vec2(1.0 / (B.w - B.y), 1.0 / (B.z - B.x));
                vec3 ic = k == 0 ? textureGrad(uImg0, uv, gx * sc, gy * sc).rgb : textureGrad(uImg1, uv, gx * sc, gy * sc).rgb;
                // Aerial photos already carry sky light and camera exposure;
                // scale toward surface albedo before the scene's own lighting.
                // Pure black is a source's no-data (NAIP beyond the coast), not imagery.
                w *= smoothstep(0.0008, 0.003, max(ic.r, max(ic.g, ic.b)));      // linear: below ~10/255 sRGB
                col = mix(col, ic * 0.72, w); imgW = max(imgW, w);
              }
            }
            #endif
            bool isWater = e <= 0.0;
            #ifdef TERRAIN
            // Outside the region packs the land cover draws the shoreline, lakes
            // and wide rivers (the 10′ elevation grid can't).
            // Regional imagery reaches past the pack's box; out there the
            // elevation is the coarse global grid, so the land cover decides.
            float la1 = asin(clamp(n.y, -1.0, 1.0)), lo1 = atan(-n.z, n.x);
            bool inPack = uPackOn > 0.5 && la1 > uPackB.x && la1 < uPackB.z && lo1 > uPackB.y && lo1 < uPackB.w;
            if (lcW >= 0.0 && (imgW < 0.5 || !inPack)) isWater = lcW > 0.5 || (inPack && e <= -0.5);
            #endif
            if (uMode == 3 && isWater) {
              float dpt = clamp(-e / 6000.0, 0.0, 1.0);
              vec3 wc = mix(vec3(0.07, 0.24, 0.32), vec3(0.008, 0.035, 0.09), pow(dpt, 0.35));
              #ifdef TERRAIN
              wc = mix(wc, col * 0.8, imgW);       // the photographed water itself
              #endif
              col = wc;
              water = 1.0;
            }
            #ifdef TERRAIN
            else if (uMode == 3 && imgW < 0.99 && lcW < 0.0) {
              // Land the 20 km imagery pixels paint as sea (barrier islands,
              // narrow capes): low coastal scrub and sand instead.
              float seaLook = smoothstep(0.03, 0.10, col.b - col.r) * (1.0 - smoothstep(0.25, 0.45, col.g));
              float v = fbm(n * 3000.0, 5u, 3);
              vec3 land = mix(vec3(0.06, 0.075, 0.035), vec3(0.17, 0.16, 0.11), smoothstep(-0.3, 0.5, v));
              col = mix(col, land, seaLook * (1.0 - imgW));
            }
            #endif
            #ifndef TERRAIN
            else {
              // Relief shading of the land from the elevation gradient.
              vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), n) + vec3(1e-6));
              vec3 north = cross(n, east);
              float dl = 0.0029;
              float eE = textureLod(uElev, lonlatUV(normalize(n + east * dl)), 0.0).r;
              float eN = textureLod(uElev, lonlatUV(normalize(n + north * dl)), 0.0).r;
              float sea = uMode == 3 ? 0.0 : -1e9;
              vec2 g = vec2(max(eE, sea) - e, max(eN, sea) - e) / (dl * uRadius) * (uMode == 3 ? 6.0 : 3.0);
              Nw = normalize(vModel * normalize(n - east * g.x - north * g.y));
            }
            #endif
          } else if (uMode == 3) {
            water = smoothstep(0.04, 0.12, col.b - col.r) * (1.0 - smoothstep(0.2, 0.45, col.g));
          }
        } else if (uMode == 1 && uElevOn > 0.5) {
          // Real elevation (Ceres, Vesta, Pluto, Charon): colour keyed to the
          // real height, shading from the real slope — no invented craters.
          #ifdef TERRAIN
          float e = vElev;
          #else
          float e = textureLod(uElev, lonlatUV(n), 0.0).r;
          #endif
          h = clamp(e * uElevScale, -1.0, 1.0);
          col = rockyColor(n, h, emi, water);
          #ifndef TERRAIN
          vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), n) + vec3(1e-6)), north = cross(n, east);
          float dl = 0.004;
          float eE = textureLod(uElev, lonlatUV(normalize(n + east * dl)), 0.0).r, eN = textureLod(uElev, lonlatUV(normalize(n + north * dl)), 0.0).r;
          vec2 g = vec2(eE - e, eN - e) / (dl * uRadius) * 3.0;
          Nw = normalize(vModel * normalize(n - east * g.x - north * g.y));
          #endif
        } else if (uMode == 1) {
          h = hgt(n);
          col = rockyColor(n, h, emi, water);
          if (uBump > 0.5 && water < 0.5) {
            // Slope from the height field, in the sphere's tangent plane.
            vec3 t1 = normalize(cross(n, abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
            vec3 t2 = cross(n, t1);
            float e = 0.0025;
            float h1 = hgt(normalize(n + t1 * e)), h2 = hgt(normalize(n + t2 * e));
            vec3 g = (t1 * (h1 - h) + t2 * (h2 - h)) / e;
            vec3 nb = normalize(n - g * uRelief * 18.0);
            #ifdef TERRAIN
            // Real relief is in the geometry; add only the finer bump on top.
            Nw = normalize(Ngeo + vModel * (nb - n) * 0.6);
            #else
            Nw = normalize(vModel * nb);
            #endif
          }
        } else {
          col = gasColor(n);
        }
        specials(n, col);
        #ifdef TERRAIN
        // Close-up ground: rock exposed on slopes and in patches, dust and
        // grain on flats, and surface relief below the mesh resolution in the
        // lighting — all faded out with distance.
        float glint = 0.0;
        {
          float dist = length(vView), fade = 1.0 - smoothstep(120.0, 1400.0, dist);
          if (fade > 0.001 && uSurf.x > 0.0 && water < 0.5 && uMode != 2) {
            vec3 m = vMet, up = normalize(vModel * n);
            float slope = 1.0 - clamp(dot(Ngeo, up), 0.0, 1.0);
            float patchy = detailN(m, 1.0 / 32.0, 3), grain = detailN(m, 0.5, 3);
            float rocky = clamp((patchy - 0.5) * 3.0 + slope * 4.0 * uSurf.w, 0.0, 1.0);
            col = mix(col, col * uSurfTint, rocky * 0.75 * fade);
            col *= mix(1.0, 0.82 + 0.36 * grain, fade);
            col *= 1.0 + uSurf.y * 0.25 * (1.0 - rocky) * (1.0 - slope) * fade;
            // Bump from the detail field's gradient (body frame → world).
            float q = 0.25, e = 0.12;
            float h0 = detailN(m, q, 4);
            vec3 gb = vec3(detailN(m + vec3(e, 0, 0), q, 4) - h0, detailN(m + vec3(0, e, 0), q, 4) - h0, detailN(m + vec3(0, 0, e), q, 4) - h0) / e;
            vec3 gw = normalize(vModel * gb + vec3(1e-6)) * length(gb);
            Nw = normalize(Nw - uSurf.x * fade * (1.0 + rocky) * (gw - dot(gw, Nw) * Nw));
            glint = uSurf.z * fade;
          }
        }
        #endif
        vec3 c = shade(Ngeo, n, col, h, water, emi, Nw);
        #ifdef TERRAIN
        if (glint > 0.0) { vec3 Hh = normalize(normalize(uLightDir) + normalize(vView)); c += uLightCol * pow(max(dot(Nw, Hh), 0.0), 60.0) * 0.12 * glint; }
        #endif
        if (uMode == 3) {
          // City lights on the night side, fading through twilight.
          float night = 1.0 - smoothstep(-0.12, 0.05, dot(Ngeo, normalize(uLightDir)));
          // The night map (~500 m per pixel) is an orbital view: a whole city is
          // one bright smear. Near the ground it fades out (lit windows on the
          // real buildings take over: regions.js setNight), and water never glows.
          float orbital = mix(0.03, 1.0, smoothstep(4000.0, 60000.0, length(vView)));
          c += sampleMap(uNight, n) * night * vec3(1.0, 0.78, 0.5) * 0.9 * orbital * (1.0 - water);
        }
        if (uMode == 2 && uGas.w > 0.0) {
          // Hot Jupiters glow by their own heat on the night side.
          c += vec3(1.0, 0.25, 0.05) * uGas.w * 0.35 * (0.6 + 0.4 * fbm(n * 5.0, uint(uSeedF) + 2u, 3));
        }
        gl_FragColor = vec4(c * uDebug, 1.0);
      ` + LOGDEPTH_FRAG + "}",
    extensions: { derivatives: true }
  });
  return m;
}

// Cloud deck (Earth: real cloud map; others: procedural).
export function cloudMaterial(map, seed) {
  return new THREE.ShaderMaterial({
    uniforms: { uMap: { value: map || null }, uLightDir: { value: new THREE.Vector3(1, 0, 0) }, uLightCol: { value: new THREE.Vector3(1, 1, 1) },
      uSeedF: { value: seed || 7 }, uCover: { value: 0.5 }, uTime: { value: 0 } },
    vertexShader: LOGDEPTH_VERT_PARS + /* glsl */ `
      varying vec3 vObj; varying vec3 vN; varying vec3 vView;
      void main() { vObj = position; vN = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0); vView = cameraPosition - wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp; ` + LOGDEPTH_VERT + "}",
    fragmentShader: LOGDEPTH_FRAG_PARS + NOISE_GLSL + /* glsl */ `
      uniform sampler2D uMap; uniform vec3 uLightDir, uLightCol; uniform float uSeedF, uCover, uTime;
      varying vec3 vObj; varying vec3 vN; varying vec3 vView;
      void main() {
        vec3 n = normalize(vObj);
        float a;
        if (uCover < 0.0) {
          vec2 uv = vec2(0.5 + atan(-n.z, n.x) / 6.2831853, 0.5 + asin(clamp(n.y, -1.0, 1.0)) / 3.14159265);
          vec2 uv2 = vec2(fract(uv.x + 0.5), uv.y);
          vec2 dx = dFdx(uv), dy = dFdy(uv), dx2 = dFdx(uv2), dy2 = dFdy(uv2);
          if (dot(dx, dx) + dot(dy, dy) > dot(dx2, dx2) + dot(dy2, dy2)) { dx = dx2; dy = dy2; }
          a = textureGrad(uMap, uv, dx, dy).r;
          a = smoothstep(0.08, 0.85, a);
        } else {
          float f = fbm(n * vec3(3.0, 6.0, 3.0) + vec3(uTime * 0.002, 0.0, 0.0), uint(uSeedF) + 300u, 6);
          a = smoothstep(0.55 - uCover, 0.9 - uCover, f + 0.5);
        }
        vec3 N = normalize(vN);
        float l = max(dot(N, normalize(uLightDir)), 0.0);
        float term = smoothstep(-0.05, 0.12, dot(N, normalize(uLightDir)));
        float mu = max(dot(N, normalize(vView)), 0.0);
        gl_FragColor = vec4(vec3(0.97) * (0.008 + l * uLightCol * term), a * (0.35 + 0.65 * smoothstep(0.0, 0.25, mu)));
      ` + LOGDEPTH_FRAG + "}",
    transparent: true, depthWrite: false
  });
}

// ── atmosphere: single-scattering, ray-marched through the shell ──
// Works in units of the planet's radius in its own frame. From space it gives
// the thin blue limb and sunset-coloured terminator; from inside, the sky
// colour, horizon haze, and the daytime glare that hides the stars.
export function atmosphereMaterial(steps) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uCam: { value: new THREE.Vector3() }, uSun: { value: new THREE.Vector3(1, 0, 0) },
      uRa: { value: 1.016 }, uH: { value: 0.0013 }, uBetaR: { value: new THREE.Vector3(37, 86, 211) },
      uBetaM: { value: 30 }, uSunI: { value: 22 }, uFade: { value: 1 },
      // Suspended dust (Mars): grey extinction (1/R) and a coloured single-
      // scattering albedo — it absorbs blue, so the sky scatters butterscotch.
      uDust: { value: 0 }, uDustAlb: { value: new THREE.Vector3(1, 1, 1) }
    },
    vertexShader: LOGDEPTH_VERT_PARS + /* glsl */ `
      varying vec3 vLocal;
      void main() { vLocal = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); ` + LOGDEPTH_VERT + "}",
    fragmentShader: LOGDEPTH_FRAG_PARS + /* glsl */ `
      uniform vec3 uCam, uSun, uBetaR, uDustAlb; uniform float uRa, uH, uBetaM, uSunI, uFade, uDust;
      varying vec3 vLocal;
      #define STEPS ${steps}
      vec2 sphere(vec3 o, vec3 d, float r) {
        float b = dot(o, d), c = dot(o, o) - r * r, h = b * b - c;
        if (h < 0.0) return vec2(1e9, -1e9);
        h = sqrt(h); return vec2(-b - h, -b + h);
      }
      void main() {
        vec3 o = uCam;
        vec3 d = normalize(vLocal * uRa - o);
        vec2 ta = sphere(o, d, uRa);
        vec2 tp = sphere(o, d, 1.0);
        float t0 = max(ta.x, 0.0), t1 = ta.y;
        if (tp.x > 0.0 && tp.x < t1) t1 = tp.x;
        if (t1 <= t0) discard;
        // Samples bunch up near the camera (quadratic spacing), where the air
        // is densest for low-altitude views along the horizon.
        float span = t1 - t0;
        vec3 sum = vec3(0.0), sumD = vec3(0.0); float sumM = 0.0; float odR = 0.0;
        vec3 ext = uBetaR + vec3(uDust);
        vec3 L = normalize(uSun);
        for (int i = 0; i < STEPS; i++) {
          float u0 = float(i) / float(STEPS), u1 = float(i + 1) / float(STEPS);
          float ds = span * (u1 * u1 - u0 * u0);
          vec3 p = o + d * (t0 + span * (0.5 * (u0 + u1)) * (0.5 * (u0 + u1)));
          float r = length(p);
          float dens = exp(-(r - 1.0) / uH);
          // Light scattered within this segment is dimmed by part of the
          // segment, not all of it: integrate exactly, (1 − e^−kτ)/kτ. Matters
          // when one segment is optically thick (dusty air deep in Gale crater,
          // 4.5 km below the datum, looking along the horizon).
          vec3 kt = ext * dens * ds * 0.55;
          vec3 inSeg = (1.0 - exp(-kt)) / max(kt, vec3(1e-5));
          vec3 viewT = exp(-ext * odR * 0.55) * inSeg;
          odR += dens * ds;
          // Sunlight reaches this point unless the planet is in the way; the
          // slant path to the Sun reddens it near the terminator.
          vec2 sp = sphere(p, L, 1.0);
          float lit = (sp.x > 0.0) ? 0.0 : 1.0;
          float cosz = dot(p / r, L);
          float slant = exp(-(r - 1.0) / uH) * uH / max(cosz + 0.15, 0.02);
          vec3 sunT = exp(-ext * slant);
          // Single scattering over-reddens long paths; real skies are refilled
          // by multiple scattering, so the extinction along the view is
          // softened (the 0.55 above).
          sum += dens * ds * lit * sunT * viewT;
          sumD += dens * ds * lit * sunT * viewT;
          sumM += dens * ds * lit * dot(sunT * viewT, vec3(0.333));
        }
        float mu = dot(d, L);
        float phR = 0.0597 * (1.0 + mu * mu);
        float g = 0.76;
        float phM = 0.1193 * (1.0 - g * g) * (1.0 + mu * mu) / ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
        // Dust: a broad forward peak plus an isotropic part (multiple scattering).
        float gd = 0.6;
        float phD = 0.6 * 0.0796 * (1.0 - gd * gd) / pow(1.0 + gd * gd - 2.0 * gd * mu, 1.5) + 0.4 * 0.0796;
        vec3 col = uSunI * (sum * uBetaR * phR + sumM * uBetaM * 0.02 * phM + sumD * uDust * uDustAlb * phD);
        vec3 T = exp(-ext * odR);
        float a = 1.0 - dot(T, vec3(0.333));
        gl_FragColor = vec4(col * uFade, clamp(a, 0.0, 1.0) * uFade);
      ` + LOGDEPTH_FRAG + "}",
    transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor
  });
}

// ── rings, with the planet's shadow across them ──
export function ringMaterial(tex, opts = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: tex }, uSun: { value: new THREE.Vector3(1, 0, 0) }, uPole: { value: new THREE.Vector3(0, 1, 0) },
      uCenter: { value: new THREE.Vector3() }, uRadius: { value: 1 }, uGain: { value: opts.gain || 1 },
      uTint: { value: new THREE.Vector3(...(opts.tint || [1, 1, 1])) }
    },
    vertexShader: LOGDEPTH_VERT_PARS + /* glsl */ `
      varying vec2 vUv; varying vec3 vP;
      void main() { vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vP = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; ` + LOGDEPTH_VERT + "}",
    fragmentShader: LOGDEPTH_FRAG_PARS + /* glsl */ `
      uniform sampler2D uMap; uniform vec3 uSun, uPole, uCenter, uTint; uniform float uRadius, uGain;
      varying vec2 vUv; varying vec3 vP;
      void main() {
        vec4 t = texture2D(uMap, vUv);
        vec3 s = normalize(uSun);
        vec3 p = vP - uCenter;
        float along = dot(p, s);
        float shade = (along < 0.0 && length(p - along * s) < uRadius) ? 0.03 : 1.0;
        float same = dot(uPole, s) * dot(uPole, cameraPosition - vP);
        float light = (same >= 0.0 ? 1.0 : 0.25) * shade * (0.15 + 0.85 * abs(dot(uPole, s)) * 4.0);
        light = min(light, 1.0) * shade;
        gl_FragColor = vec4(t.rgb * uTint * light * uGain, t.a);
      ` + LOGDEPTH_FRAG + "}",
    transparent: true, depthWrite: false, side: THREE.DoubleSide
  });
}

// ── stars up close ──
export function starMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Vector3(1, 1, 1) }, uTime: { value: 0 }, uSeedF: { value: 3 }, uI: { value: 4 } },
    vertexShader: LOGDEPTH_VERT_PARS + /* glsl */ `
      varying vec3 vObj; varying vec3 vN; varying vec3 vView;
      void main() { vObj = position; vN = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0); vView = cameraPosition - wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp; ` + LOGDEPTH_VERT + "}",
    fragmentShader: LOGDEPTH_FRAG_PARS + NOISE_GLSL + /* glsl */ `
      uniform vec3 uColor; uniform float uTime, uSeedF, uI;
      varying vec3 vObj; varying vec3 vN; varying vec3 vView;
      void main() {
        vec3 n = normalize(vObj);
        float mu = max(dot(normalize(vN), normalize(vView)), 0.0);
        // Granulation drifts slowly; supergranules modulate it.
        float g = fbm(n * 60.0 + vec3(0.0, uTime * 0.01, uTime * 0.007), uint(uSeedF), 4);
        float sg = fbm(n * 9.0 + vec3(uTime * 0.002), uint(uSeedF) + 40u, 3);
        float spots = smoothstep(0.66, 0.72, fbm(n * 5.0 + vec3(uTime * 0.0004), uint(uSeedF) + 90u, 4) + 0.3) * step(abs(n.y), 0.45);
        float limb = 1.0 - 0.6 * (1.0 - mu) - 0.15 * (1.0 - mu * mu);
        vec3 tint = mix(uColor * vec3(1.0, 0.7, 0.45), uColor, pow(mu, 0.4));
        float bright = limb * (0.9 + 0.12 * g + 0.06 * sg) * (1.0 - 0.35 * spots);
        gl_FragColor = vec4(tint * bright * uI, 1.0);
      ` + LOGDEPTH_FRAG + "}"
  });
}

// Billboard glow (corona, or a compact object's halo). Additive, depth-tested
// so a planet in front eclipses it.
export function glowMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Vector3(1, 1, 1) }, uI: { value: 1 }, uCore: { value: 0.12 }, uRays: { value: 0.0 } },
    vertexShader: LOGDEPTH_VERT_PARS + /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); ` + LOGDEPTH_VERT + "}",
    fragmentShader: LOGDEPTH_FRAG_PARS + /* glsl */ `
      uniform vec3 uColor; uniform float uI, uCore, uRays;
      varying vec2 vUv;
      void main() {
        float r = length(vUv);
        if (r > 1.0) discard;
        float k = uCore / max(r, uCore * 0.5);
        float a = (k * k * 0.5 + 0.25 * exp(-r * 6.0)) * (1.0 - r) * (1.0 - r);
        float th = atan(vUv.y, vUv.x);
        a *= 1.0 + uRays * 0.35 * pow(abs(cos(th * 3.0)), 40.0);
        gl_FragColor = vec4(uColor * a * uI, 1.0);
      ` + LOGDEPTH_FRAG + "}",
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
  });
}

// ── black holes ──
// Accretion disc: temperature falling with radius (T ∝ r^−¾), Doppler beaming
// on the approaching side, streaks that wind with the orbit. A visual
// approximation of the physics, not a general-relativistic render.
export function diskMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uInner: { value: 3 }, uOuter: { value: 25 }, uSpin: { value: new THREE.Vector3(0, 1, 0) },
      uI: { value: 3 }, uHot: { value: new THREE.Vector3(1, 0.9, 0.8) }, uCool: { value: new THREE.Vector3(1, 0.4, 0.1) } },
    vertexShader: LOGDEPTH_VERT_PARS + /* glsl */ `
      varying vec2 vXY; varying vec3 vW; varying vec3 vTan;
      void main() {
        vXY = position.xy;
        float th = atan(position.y, position.x);
        vTan = normalize(mat3(modelMatrix) * vec3(-sin(th), cos(th), 0.0));     // orbital direction
        vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; ` + LOGDEPTH_VERT + "}",
    fragmentShader: LOGDEPTH_FRAG_PARS + NOISE_GLSL + /* glsl */ `
      uniform float uTime, uInner, uOuter, uI; uniform vec3 uSpin, uHot, uCool;
      varying vec2 vXY; varying vec3 vW; varying vec3 vTan;
      void main() {
        float r = length(vXY);
        if (r < uInner || r > uOuter) discard;
        float x = (r - uInner) / (uOuter - uInner);
        float th = atan(vXY.y, vXY.x);
        float omega = 1.0 / pow(r / uInner, 1.5);
        float streak = fbm(vec3(cos(th - uTime * omega * 0.6) * r * 0.3, sin(th - uTime * omega * 0.6) * r * 0.3, r * 0.8), 17u, 4);
        float temp = pow(uInner / r, 0.75);
        vec3 col = mix(uCool, uHot, temp);
        // Approaching side (orbital velocity toward the camera) brightens.
        vec3 vel = normalize(vTan);
        float beta = 0.5 * omega;
        float dop = pow(max(0.2, 1.0 + beta * dot(vel, normalize(cameraPosition - vW))), 3.0);
        float edge = smoothstep(0.0, 0.05, x) * (1.0 - smoothstep(0.6, 1.0, x));
        float I = uI * temp * temp * dop * edge * (0.55 + 0.9 * streak);
        gl_FragColor = vec4(col * I, 1.0);
      ` + LOGDEPTH_FRAG + "}",
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending
  });
}

// Beams and jets: additive cones fading along their length.
export function beamMaterial(color, intensity) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Vector3(...color) }, uI: { value: intensity } },
    vertexShader: LOGDEPTH_VERT_PARS + /* glsl */ `
      varying float vT; varying vec2 vR;
      void main() { vT = uv.y; vR = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); ` + LOGDEPTH_VERT + "}",
    fragmentShader: LOGDEPTH_FRAG_PARS + /* glsl */ `
      uniform vec3 uColor; uniform float uI;
      varying float vT; varying vec2 vR;
      void main() {
        float edge = sin(vR.x * 3.14159 * 2.0) * 0.5 + 0.5;
        float a = (1.0 - vT) * (1.0 - vT) * (0.4 + 0.6 * edge);
        gl_FragColor = vec4(uColor * a * uI, 1.0);
      ` + LOGDEPTH_FRAG + "}",
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending
  });
}
