// Far-pass objects. Units are light-years; the camera is the origin. Each
// object keeps its geometry relative to its own anchor (a star, a galaxy
// centre, a cell corner) and only the anchor offset is recomputed per frame,
// in float64 — so vertex coordinates stay small and precise.

import * as THREE from "three";
import { sub, LY, AU, DEG, eqToRender } from "../engine/coords.js";
import { Rng, hashString } from "../engine/rng.js";
import { lumPointsMaterial, dustMaterial, orbitLineMaterial } from "./materials.js";
import { tempToRGB } from "../universe/stellar.js";

const _rel = [0, 0, 0];
export function anchorLy(obj, anchor, cam) {
  sub(anchor, cam, _rel);
  obj.position.set(_rel[0] / LY, _rel[1] / LY, _rel[2] / LY);
}

function pointsGeometry(n) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute("aLum", new THREE.BufferAttribute(new Float32Array(n), 1));
  g.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(n), 1));
  return g;
}

// ── real stars (catalogue + exoplanet hosts), anchored at Sol ──
export class StarField {
  constructor(stars, scene) {
    const n = stars.length;
    this.geo = pointsGeometry(n);
    const P = this.geo.attributes.position.array, Lm = this.geo.attributes.aLum.array, C = this.geo.attributes.aColor.array;
    stars.forEach((s, i) => {
      P[i * 3] = s.posLy[0]; P[i * 3 + 1] = s.posLy[1]; P[i * 3 + 2] = s.posLy[2];
      Lm[i] = Math.pow(10, -0.4 * (s.absMag - 4.83));        // V-band luminosity, solar units
      const c = tempToRGB(s.teff);
      C[i * 3] = c[0]; C[i * 3 + 1] = c[1]; C[i * 3 + 2] = c[2];
    });
    this.mat = lumPointsMaterial();
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    scene.add(this.points);
  }
  update(sol, cam, ctx) { anchorLy(this.points, sol, cam); applyCommon(this.mat, ctx); }
  dispose() { this.geo.dispose(); this.mat.dispose(); this.points.removeFromParent(); }
}

// ext: { camLocal: [x,y,z] in the galaxy frame (ly), kappa per ly, h (ly), R (ly) }
export function setExtinction(mat, ext, offset) {
  const u = mat.uniforms;
  if (!ext) { u.uExt.value.x = 0; return; }
  u.uExt.value.set(1, ext.kappa, ext.h, ext.R);
  u.uCamLocal.value.set(ext.camLocal[0], ext.camLocal[1], ext.camLocal[2]);
  if (offset) u.uLocalOffset.value.set(offset[0], offset[1], offset[2]);
  else u.uLocalOffset.value.set(0, 0, 0);
}

export function applyCommon(mat, ctx) {
  const u = mat.uniforms;
  if (u.uPxPerRad) u.uPxPerRad.value = ctx.pxPerRad;
  if (u.uMaxPx) u.uMaxPx.value = ctx.maxPointPx;
  if (u.uExposure) u.uExposure.value = ctx.starExposure;
  if (u.uHide) u.uHide.value.copy(ctx.hideStar);
}

// ── a galaxy's particle cloud and dust ──
export class GalaxyCloud {
  constructor(data, scene, opts = {}) {
    this.count = data.count;
    this.geo = pointsGeometry(0);
    this.geo.setAttribute("position", new THREE.BufferAttribute(data.pos, 3));
    this.geo.setAttribute("aLum", new THREE.BufferAttribute(data.lum, 1));
    this.geo.setAttribute("aColor", new THREE.BufferAttribute(data.col, 3));
    this.geo.setAttribute("aSize", new THREE.BufferAttribute(data.size, 1));
    this.mat = lumPointsMaterial({ soft: !opts.hard, core: opts.hard ? 1.4 : 1.2 });
    this.group = new THREE.Group();
    this.points = new THREE.Points(this.geo, this.mat);
    // Bounded: cull by a real bounding sphere, padded for the soft sprites.
    this.geo.computeBoundingSphere();
    let maxS = 0;
    for (let i = 0; i < data.size.length; i++) if (data.size[i] > maxS) maxS = data.size[i];
    this.geo.boundingSphere.radius += maxS;
    this.points.renderOrder = 1;
    this.group.add(this.points);
    if (data.dustCount > 0) {
      this.dgeo = new THREE.BufferGeometry();
      this.dgeo.setAttribute("position", new THREE.BufferAttribute(data.dpos, 3));
      this.dgeo.setAttribute("aSize", new THREE.BufferAttribute(data.dsize, 1));
      this.dgeo.setAttribute("aOpacity", new THREE.BufferAttribute(data.dop, 1));
      this.dmat = dustMaterial();
      this.dust = new THREE.Points(this.dgeo, this.dmat);
      this.dgeo.computeBoundingSphere();
      this.dgeo.boundingSphere.radius *= 1.1;
      this.dust.renderOrder = 3;
      this.group.add(this.dust);
    }
    if (opts.quat) this.group.quaternion.copy(opts.quat);
    scene.add(this.group);
  }
  // fraction: share of particles to draw (LOD); alpha: cross-fade with the point stand-in.
  // dustScale: from inside a galaxy, lanes are seen edge-on through
  // thousands of light-years and would otherwise read as solid black.
  update(anchor, cam, ctx, fraction, alpha, fadeNear, dustScale = 1, ext = null) {
    anchorLy(this.group, anchor, cam);
    applyCommon(this.mat, ctx);
    setExtinction(this.mat, ext, null);
    const n = Math.max(64, Math.floor(this.count * fraction));
    this.geo.setDrawRange(0, n);
    // Fewer particles each carry more of the light, so total brightness holds.
    this.mat.uniforms.uAlpha.value = alpha * (this.count / n);
    this.mat.uniforms.uExposure.value = ctx.galaxyExposure;
    this.mat.uniforms.uFadeNear.value.set(fadeNear * 0.3, fadeNear * 1.6);
    this.mat.uniforms.uHide.value.set(0, 0, 0, -1);
    if (this.dust) {
      const du = this.dmat.uniforms;
      du.uPxPerRad.value = ctx.pxPerRad; du.uMaxPx.value = ctx.maxPointPx;
      du.uStrength.value = alpha * dustScale;
      du.uFadeNear.value.set(fadeNear * 0.5, fadeNear * 1.5);
      this.dgeo.setDrawRange(0, Math.max(16, Math.floor(this.dgeo.attributes.aSize.count * fraction)));
    }
  }
  dispose() {
    this.geo.dispose(); this.mat.dispose();
    if (this.dgeo) { this.dgeo.dispose(); this.dmat.dispose(); }
    this.group.removeFromParent();
  }
}

// ── galaxies as single soft points (the far level of detail) ──
// Each keeps its true luminosity and radius, so it shows as a dot when tiny
// and a fuzzy patch of the right angular size as it nears.
export class GalaxyPoints {
  constructor(list, scene, anchorOf) {
    this.list = list;
    this.geo = pointsGeometry(list.length);
    const P = this.geo.attributes.position.array, Lm = this.geo.attributes.aLum.array;
    const C = this.geo.attributes.aColor.array, S = this.geo.attributes.aSize.array;
    // Shape: each galaxy's major axis and axis ratio, so that once a galaxy
    // spans a few pixels it reads as an oriented ellipse rather than a dot.
    // Position angles are HyperLEDA's where known; otherwise seeded.
    const M = new Float32Array(list.length * 3), Q = new Float32Array(list.length);
    list.forEach((g, i) => {
      const p = anchorOf(g);
      P[i * 3] = p[0]; P[i * 3 + 1] = p[1]; P[i * 3 + 2] = p[2];
      Lm[i] = g.lumSun;
      const rng = new Rng(g.seed !== undefined ? g.seed : hashString(g.name || String(i)));
      const early = g.type === "elliptical" || g.type === "lenticular" || g.type === "dsph";
      const c = early ? [1, 0.82, 0.62] : g.type === "irregular" ? [0.75, 0.82, 1] : [0.95, 0.9, 0.85];
      const v = 0.94 + rng.next() * 0.12, warm = (rng.next() - 0.5) * 0.08;
      C[i * 3] = c[0] * v * (1 + warm); C[i * 3 + 1] = c[1] * v; C[i * 3 + 2] = c[2] * v * (1 - warm);
      S[i] = g.diamKly * 500 * 0.45;
      const ax = majorAxis(g, p, rng);
      M[i * 3] = ax[0]; M[i * 3 + 1] = ax[1]; M[i * 3 + 2] = ax[2];
      Q[i] = g.axisRatio ? g.axisRatio : g.type === "elliptical" ? rng.range(0.6, 0.95) : g.type === "dsph" || g.type === "irregular" ? rng.range(0.55, 0.9)
        : g.type ? rng.range(0.22, 0.95) : 1;
    });
    this.geo.setAttribute("aMajor", new THREE.BufferAttribute(M, 3));
    this.geo.setAttribute("aRatio", new THREE.BufferAttribute(Q, 1));
    this.mat = lumPointsMaterial({ soft: true, core: 1.1, shape: true });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 0;
    scene.add(this.points);
    this.alpha = new Float32Array(list.length).fill(1);
  }
  // Hide entries whose full cloud is drawn, by zeroing their light.
  setHidden(i, hidden, lum) {
    this.geo.attributes.aLum.array[i] = hidden ? 0 : lum;
    this.geo.attributes.aLum.needsUpdate = true;
  }
  update(anchor, cam, ctx) {
    anchorLy(this.points, anchor, cam);
    applyCommon(this.mat, ctx);
    this.mat.uniforms.uExposure.value = ctx.galaxyExposure;
    this.mat.uniforms.uHide.value.set(0, 0, 0, -1);
  }
  dispose() { this.geo.dispose(); this.mat.dispose(); this.points.removeFromParent(); }
}

// Major axis (unit vector, render frame) of a galaxy on the sky.
function majorAxis(g, p, rng) {
  if (g.quat) { const x = new THREE.Vector3(1, 0, 0).applyQuaternion(g.quat); return [x.x, x.y, x.z]; }
  if (g.paDeg !== null && g.paDeg !== undefined && g.raDeg !== undefined) {
    const ra = g.raDeg * DEG, de = g.decDeg * DEG, pa = g.paDeg * DEG;
    const n = eqToRender(-Math.sin(de) * Math.cos(ra), -Math.sin(de) * Math.sin(ra), Math.cos(de));
    const e = eqToRender(-Math.sin(ra), Math.cos(ra), 0);
    return [n[0] * Math.cos(pa) + e[0] * Math.sin(pa), n[1] * Math.cos(pa) + e[1] * Math.sin(pa), n[2] * Math.cos(pa) + e[2] * Math.sin(pa)];
  }
  // Unknown: any direction across the line of sight.
  const los = new THREE.Vector3(p[0], p[1], p[2]).normalize();
  const a = new THREE.Vector3(rng.gauss(), rng.gauss(), rng.gauss()).cross(los).normalize();
  return [a.x || 1, a.y, a.z];
}

// ── a cell of procedural stars ──
export class SectorPoints {
  constructor(cell, scene, quat) {
    const n = cell.absMag.length;
    this.cell = cell;
    this.geo = pointsGeometry(0);
    this.geo.setAttribute("position", new THREE.BufferAttribute(cell.pos, 3));
    const lum = new Float32Array(n), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      lum[i] = Math.pow(10, -0.4 * (cell.absMag[i] - 4.83));
      const c = tempToRGB(cell.teff[i]);
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
    }
    this.geo.setAttribute("aLum", new THREE.BufferAttribute(lum, 1));
    this.geo.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    this.geo.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(n), 1));
    this.mat = lumPointsMaterial();
    this.points = new THREE.Points(this.geo, this.mat);
    // A cell is a small bounded box: let three.js cull it normally.
    this.geo.computeBoundingSphere();
    this.points.renderOrder = 2;
    this.points.quaternion.copy(quat);
    scene.add(this.points);
  }
  update(anchorUPos, cam, ctx, fadeFar, ext = null) {
    anchorLy(this.points, anchorUPos, cam);
    applyCommon(this.mat, ctx);
    setExtinction(this.mat, ext, this.cell.origin);
    this.mat.uniforms.uFadeFar.value.set(fadeFar * 0.75, fadeFar);
  }
  dispose() { this.geo.dispose(); this.mat.dispose(); this.points.removeFromParent(); }
}

// ── planets and moons as points of reflected light ──
export class BodyPoints {
  constructor(scene, max = 256) {
    this.max = max;
    this.geo = pointsGeometry(max);
    this.mat = lumPointsMaterial({ core: 1.3 });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    scene.add(this.points);
  }
  // items: [{ rel: [m,m,m] camera-relative, lum: Lsun-equivalent, color }]
  set(items, ctx) {
    const P = this.geo.attributes.position.array, Lm = this.geo.attributes.aLum.array, C = this.geo.attributes.aColor.array;
    const n = Math.min(items.length, this.max);
    for (let i = 0; i < n; i++) {
      const it = items[i];
      P[i * 3] = it.rel[0] / LY; P[i * 3 + 1] = it.rel[1] / LY; P[i * 3 + 2] = it.rel[2] / LY;
      Lm[i] = it.lum;
      C[i * 3] = it.color[0]; C[i * 3 + 1] = it.color[1]; C[i * 3 + 2] = it.color[2];
    }
    this.geo.setDrawRange(0, n);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aLum.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.points.position.set(0, 0, 0);
    applyCommon(this.mat, ctx);
    this.mat.uniforms.uHide.value.set(0, 0, 0, -1);
  }
  dispose() { this.geo.dispose(); this.mat.dispose(); this.points.removeFromParent(); }
}

// ── orbit lines ──
export class OrbitLine {
  // pointsM: array of [x,y,z] metres relative to the parent, render frame.
  constructor(pointsM, scene, color = 0x6f8fb8) {
    const arr = new Float32Array(pointsM.length * 3);
    pointsM.forEach((p, i) => { arr[i * 3] = p[0] / LY; arr[i * 3 + 1] = p[1] / LY; arr[i * 3 + 2] = p[2] / LY; });
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
    this.mat = orbitLineMaterial(color, 0.35);
    this.line = new THREE.Line(this.geo, this.mat);
    this.line.frustumCulled = false;
    this.line.renderOrder = 5;
    scene.add(this.line);
    let r = 0;
    pointsM.forEach((p) => (r = Math.max(r, Math.hypot(p[0], p[1], p[2]))));
    this.radius = r;
  }
  update(parent, cam, ctx, visible) {
    anchorLy(this.line, parent, cam);
    // Fade orbits that are tiny on screen or that we're far outside of.
    const d = Math.hypot(this.line.position.x, this.line.position.y, this.line.position.z) * LY;
    const px = this.radius / Math.max(d, this.radius) * ctx.pxPerRad;
    const a = visible ? Math.min(1, Math.max(0, (px - 12) / 60)) * 0.32 : 0;
    this.mat.opacity = a;
    this.line.visible = a > 0.005;
  }
  dispose() { this.geo.dispose(); this.mat.dispose(); this.line.removeFromParent(); }
}

// ── asteroid belts: thousands of bodies on Kepler orbits, solved on the GPU ──
// A representative distribution, not individual catalogued asteroids.
export class Belt {
  constructor(spec, scene, rng) {
    const n = spec.count;
    const g = new THREE.BufferGeometry();
    const el1 = new Float32Array(n * 3), el2 = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      el1[i * 3] = spec.inner + (spec.outer - spec.inner) * Math.pow(rng.next(), 0.8);   // a (AU)
      el1[i * 3 + 1] = Math.min(0.35, Math.abs(rng.gauss()) * spec.ecc);                  // e
      el1[i * 3 + 2] = Math.abs(rng.gauss()) * spec.incl * Math.PI / 180;                 // i
      el2[i * 3] = rng.next() * Math.PI * 2; el2[i * 3 + 1] = rng.next() * Math.PI * 2; el2[i * 3 + 2] = rng.next() * Math.PI * 2;
    }
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute("aEl1", new THREE.BufferAttribute(el1, 3));
    g.setAttribute("aEl2", new THREE.BufferAttribute(el2, 3));
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uDays: { value: 0 }, uMass: { value: spec.massSun || 1 }, uAU: { value: AU / LY }, uBright: { value: spec.bright || 1 },
        uPxPerRad: { value: 1000 }, uTint: { value: new THREE.Vector3(...(spec.tint || [0.8, 0.75, 0.68])) } },
      vertexShader: /* glsl */ `
        attribute vec3 aEl1; attribute vec3 aEl2;
        uniform float uDays, uMass, uAU, uBright, uPxPerRad;
        varying float vI;
        void main() {
          float a = aEl1.x, e = aEl1.y, inc = aEl1.z, N = aEl2.x, w = aEl2.y;
          float n = 0.01720209895 * sqrt(uMass) / pow(a, 1.5);
          float M = mod(aEl2.z + n * uDays, 6.2831853);
          float E = M;
          for (int k = 0; k < 6; k++) E = E - (E - e * sin(E) - M) / (1.0 - e * cos(E));
          float xv = a * (cos(E) - e), yv = a * sqrt(1.0 - e * e) * sin(E);
          float cw = cos(w), sw = sin(w), cn = cos(N), sn = sin(N), ci = cos(inc), si = sin(inc);
          vec3 ecl = vec3((cw*cn - sw*sn*ci)*xv + (-sw*cn - cw*sn*ci)*yv, (cw*sn + sw*cn*ci)*xv + (-sw*sn + cw*cn*ci)*yv, (sw*si)*xv + (cw*si)*yv);
          vec3 p = vec3(ecl.x, ecl.z, -ecl.y) * uAU;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float dAU = length(mv.xyz) / uAU;
          vI = uBright * clamp(0.06 / (dAU * dAU + 0.002), 0.0, 1.2);
          gl_PointSize = 2.2;
          gl_Position = projectionMatrix * mv;
          if (vI < 0.004) gl_PointSize = 0.0;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uTint; varying float vI;
        void main() { vec2 p = gl_PointCoord * 2.0 - 1.0; float r2 = dot(p, p); if (r2 > 1.0) discard;
          gl_FragColor = vec4(uTint * vI * exp(-r2 * 3.0), 1.0); }`,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    if (spec.quat) this.points.quaternion.copy(spec.quat);
    scene.add(this.points);
  }
  update(anchor, cam, ctx, days) {
    anchorLy(this.points, anchor, cam);
    this.mat.uniforms.uDays.value = days;
    this.mat.uniforms.uPxPerRad.value = ctx.pxPerRad;
  }
  dispose() { this.geo.dispose(); this.mat.dispose(); this.points.removeFromParent(); }
}
