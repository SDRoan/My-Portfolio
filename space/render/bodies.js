// Bodies drawn in the near pass: stars as discs, planets, moons, rings,
// atmospheres, black holes and neutron stars.
//
// Every frame each body is placed relative to the camera in float64, then
// depth-compressed (coords.js): same direction, same angular size, coordinates
// the GPU can hold. Geometry detail follows on-screen size; below a pixel the
// mesh hides and the far pass's point of light stands in for it.

import * as THREE from "three";
import { sub, compress } from "../engine/coords.js";
import { planetMaterial, cloudMaterial, atmosphereMaterial, ringMaterial, starMaterial, glowMaterial, diskMaterial, beamMaterial } from "./materials.js";
import { tempToRGB } from "../universe/stellar.js";
import { Rng } from "../engine/rng.js";
import { Terrain } from "./terrain.js";
import { Surface, loadField, toLocal, TerrainStreamer, loadFeatures } from "../universe/surfaces.js";
import { RockField, rockKind } from "./rocks.js";

const TEX_BASE = new URL("../../textures/", import.meta.url);
const texCache = new Map();
export function loadTexture(file, opts = {}) {
  if (texCache.has(file)) return texCache.get(file);
  // userData.ready flips when the image has arrived; until then a body keeps
  // showing its point of light instead of an unlit black disc.
  const t = new THREE.TextureLoader().load(new URL(file, TEX_BASE).href, (tx) => { tx.userData.ready = true; },
    undefined, () => { t.userData.ready = true; t.userData.failed = true; });
  t.colorSpace = opts.linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.anisotropy = 8;
  texCache.set(file, t);
  return t;
}

const geoCache = new Map();
function sphereGeo(seg) {
  if (!geoCache.has(seg)) geoCache.set(seg, new THREE.SphereGeometry(1, seg, Math.max(8, seg >> 1)));
  return geoCache.get(seg);
}
const planeGeo = new THREE.PlaneGeometry(2, 2);

export function disposeSharedBodyResources() {
  geoCache.forEach((g) => g.dispose());
  geoCache.clear();
  texCache.forEach((t) => t.dispose());
  texCache.clear();
}

// Named looks for Solar System bodies without a usable map.
const PRESET_LOOKS = {
  earth: { mode: 3 },
  pluto: { mode: 1, c0: [0.45, 0.32, 0.24], c1: [0.72, 0.6, 0.5], c2: [0.9, 0.85, 0.8], crater: 0.15, special: 2 },
  charon: { mode: 1, c0: [0.38, 0.37, 0.36], c1: [0.55, 0.54, 0.52], c2: [0.7, 0.69, 0.67], crater: 0.25, special: 8 },
  ceres: { mode: 1, c0: [0.25, 0.24, 0.23], c1: [0.35, 0.34, 0.33], c2: [0.45, 0.44, 0.43], crater: 0.45 },
  eris: { mode: 1, c0: [0.85, 0.85, 0.86], c1: [0.92, 0.92, 0.93], c2: [0.97, 0.97, 0.98], crater: 0.1 },
  haumea: { mode: 1, c0: [0.8, 0.8, 0.82], c1: [0.88, 0.88, 0.9], c2: [0.95, 0.95, 0.96], crater: 0.1 },
  makemake: { mode: 1, c0: [0.62, 0.45, 0.35], c1: [0.78, 0.65, 0.55], c2: [0.9, 0.82, 0.75], crater: 0.1 },
  vesta: { mode: 1, c0: [0.35, 0.33, 0.31], c1: [0.5, 0.48, 0.45], c2: [0.62, 0.6, 0.57], crater: 0.5, mount: 0.9 },
  rock: { mode: 1, c0: [0.28, 0.27, 0.26], c1: [0.38, 0.37, 0.35], c2: [0.48, 0.46, 0.44], crater: 0.55 },
  phobos: { mode: 1, c0: [0.18, 0.16, 0.15], c1: [0.27, 0.25, 0.23], c2: [0.35, 0.33, 0.3], crater: 0.7, craterFreq: 4 },
  io: { mode: 1, c0: [0.7, 0.6, 0.25], c1: [0.85, 0.75, 0.35], c2: [0.95, 0.9, 0.6], special: 3 },
  europa: { mode: 1, c0: [0.75, 0.7, 0.62], c1: [0.85, 0.8, 0.72], c2: [0.92, 0.9, 0.85], special: 4 },
  ganymede: { mode: 1, c0: [0.32, 0.29, 0.26], c1: [0.5, 0.47, 0.43], c2: [0.72, 0.7, 0.66], crater: 0.25 },
  callisto: { mode: 1, c0: [0.2, 0.18, 0.16], c1: [0.32, 0.29, 0.26], c2: [0.55, 0.52, 0.48], crater: 0.7 },
  icymoon: { mode: 1, c0: [0.7, 0.7, 0.7], c1: [0.82, 0.82, 0.82], c2: [0.92, 0.92, 0.93], crater: 0.55 },
  darkice: { mode: 1, c0: [0.3, 0.3, 0.31], c1: [0.42, 0.42, 0.43], c2: [0.6, 0.6, 0.62], crater: 0.55 },
  enceladus: { mode: 1, special: 6, crater: 0.15 },
  titan: { mode: 1, special: 5 },
  iapetus: { mode: 1, c0: [0.6, 0.58, 0.55], c1: [0.75, 0.73, 0.7], c2: [0.85, 0.83, 0.8], crater: 0.45, special: 1 },
  triton: { mode: 1, c0: [0.62, 0.6, 0.58], c1: [0.78, 0.74, 0.7], c2: [0.9, 0.86, 0.82], special: 9 },
  comet: { mode: 1, special: 7, crater: 0.3 }
};

export class Body {
  // def: { id, name, kind, radius (m), flattening, triaxial, look, atmosphere, rings, teff, seed, ... }
  constructor(def, ctx) {
    this.def = def;
    this.ctx = ctx;
    this.pos = def.pos;                                  // UPos, updated by the owner
    this.quat = new THREE.Quaternion();
    this.radius = def.radius;
    this.group = null;
    this.rel = [0, 0, 0];
    this.dist = Infinity;
    this.screenR = 0;
    this.lightDir = new THREE.Vector3(1, 0, 0);
    this.lightCol = new THREE.Vector3(1, 1, 1);
    this.light2Dir = new THREE.Vector3(1, 0, 0);
    this.light2Col = new THREE.Vector3(0, 0, 0);
    this.seg = 0;
  }

  build() {
    const d = this.def, q = this.ctx.quality;
    const g = new THREE.Group();
    g.matrixAutoUpdate = true;
    this.group = g;
    if (d.kind === "star") {
      this.mat = starMaterial();
      this.mat.uniforms.uColor.value.set(...tempToRGB(d.teff || 5772));
      this.mat.uniforms.uSeedF.value = (d.seed || 3) % 16777216;
      this.mesh = new THREE.Mesh(sphereGeo(32), this.mat);
      g.add(this.mesh);
      this.glow = new THREE.Mesh(planeGeo, glowMaterial());
      this.glow.material.uniforms.uColor.value.set(...tempToRGB(d.teff || 5772));
      this.glow.material.uniforms.uRays.value = 1;
      this.glow.renderOrder = 5;
      this.ctx.scene.add(this.glow);
    } else if (d.kind === "blackhole") {
      this.mesh = new THREE.Mesh(sphereGeo(48), new THREE.MeshBasicMaterial({ color: 0x000000 }));
      g.add(this.mesh);
      if (d.disk !== "none") {
        this.disk = new THREE.Mesh(new THREE.RingGeometry(1, 1, 160, 1), diskMaterial());
        this.disk.geometry.dispose();
        this.disk.geometry = new THREE.RingGeometry(3 / 2.6, (d.disk === "faint" ? 14 : 30) / 2.6, 200, 8);
        const u = this.disk.material.uniforms;
        u.uInner.value = 3 / 2.6; u.uOuter.value = (d.disk === "faint" ? 14 : 30) / 2.6;
        u.uI.value = d.disk === "faint" ? 0.8 : 3.2;
        if (d.disk === "faint") { u.uHot.value.set(1, 0.6, 0.35); u.uCool.value.set(0.7, 0.2, 0.05); }
        this.disk.rotation.x = -Math.PI / 2;
        this.disk.renderOrder = 3;
        g.add(this.disk);
        // Photon ring and the lensed image of the disc's far side, drawn as a
        // camera-facing band around the shadow.
        this.halo = new THREE.Mesh(planeGeo, glowMaterial());
        const hu = this.halo.material.uniforms;
        hu.uColor.value.set(1, 0.75, 0.45); hu.uI.value = d.disk === "faint" ? 0.6 : 2.2; hu.uCore.value = 0.42;
        this.halo.renderOrder = 4;
        this.ctx.scene.add(this.halo);
      }
      if (d.jets) {
        this.jets = new THREE.Group();
        for (const s of [1, -1]) {
          const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 6, 400, 24, 1, true), beamMaterial([0.55, 0.7, 1], 0.5));
          cone.position.y = s * 200; if (s < 0) cone.rotation.x = Math.PI;
          this.jets.add(cone);
        }
        g.add(this.jets);
      }
    } else if (d.kind === "neutronstar") {
      this.mat = starMaterial();
      this.mat.uniforms.uColor.value.set(0.75, 0.85, 1);
      this.mat.uniforms.uI.value = 6;
      this.mesh = new THREE.Mesh(sphereGeo(24), this.mat);
      g.add(this.mesh);
      this.glow = new THREE.Mesh(planeGeo, glowMaterial());
      this.glow.material.uniforms.uColor.value.set(0.7, 0.82, 1);
      this.glow.material.uniforms.uI.value = 1.5;
      this.ctx.scene.add(this.glow);
      if (d.subtype === "pulsar" || d.subtype === "magnetar") {
        this.beams = new THREE.Group();
        for (const s of [1, -1]) {
          const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 30, 3000, 24, 1, true), beamMaterial([0.6, 0.75, 1], 0.35));
          cone.position.y = s * 1500; if (s < 0) cone.rotation.x = Math.PI;
          this.beams.add(cone);
        }
        this.beamAxis = new THREE.Group();
        this.beamAxis.rotation.z = 0.5;                  // magnetic axis ~30° off the spin axis
        this.beamAxis.add(this.beams);
        g.add(this.beamAxis);
      }
    } else {
      // planet, moon, dwarf, asteroid, comet
      let look = typeof d.look === "string" ? resolveLook(d.look) : d.look || resolveLook("rock");
      // A map whose longitude 0 isn't at its centre (Mercury: see the manifest's mapLonShift).
      if (d.surfaceEntry && d.surfaceEntry.mapLonShift) look = Object.assign({}, look, { mapShift: d.surfaceEntry.mapLonShift });
      // A real global mosaic (Pluto, Charon): drawn as the map; where nothing
      // was imaged, the procedural colours fill in.
      if (d.surfaceEntry && d.surfaceEntry.globalMap) look = Object.assign({}, look, { mode: 0, map: d.surfaceEntry.globalMap, mapFill: d.surfaceEntry.globalMapFill ? 1 : 0, mapTint: d.surfaceEntry.globalMapGrey ? 1 : 0, special: 0 });   // no painted features over real imagery
      const opts = Object.assign({ bump: q.bump, seed: (d.seed || 11) % 16777216 }, look);
      if (look.map) opts.map = loadTexture(look.map);
      // Earth: NASA Blue Marble land, NASA Black Marble night lights; oceans and
      // relief are shaded from ETOPO 2022 once the elevation grid arrives.
      if (look.mode === 3) { opts.map = loadTexture("earth_bluemarble.webp"); opts.night = loadTexture("earth_blackmarble.webp"); }
      opts.radius = d.radius;
      const surf = this.getSurface();
      // (Not for Venus from orbit: what you see there is cloud tops.)
      if (surf.field && !(d.surfaceEntry && d.surfaceEntry.surfaceMap)) { opts.elevTex = surf.field.texture(); opts.elevScale = 1 / surf.elevSpan(); }
      opts.airless = !d.atmosphere && look.mode !== 2;
      Object.assign(opts, groundStyle(d));
      opts.relief = (d.reliefKm || look.reliefKm || 6) * 1000 / d.radius;
      if (d.atmosphere) { opts.atmoTint = d.atmosphere.color; opts.atmoAmt = Math.min(0.6, 0.25 * (d.atmosphere.density || 0.5)); }
      this.mat = planetMaterial(opts);
      this.look = opts;
      // Close-up terrain for every solid body (gas and ice giants have none).
      this.canTerrain = opts.mode !== 2 && this.getSurface().solid && d.radius > 1500;
      this.mesh = new THREE.Mesh(sphereGeo(16), this.mat);
      g.add(this.mesh);
      if (look.mode === 3 || (look.clouds && look.clouds > 0)) {
        const cm = cloudMaterial(look.mode === 3 ? loadTexture("earth_clouds.webp") : null, (d.seed || 5) % 16777216);
        cm.uniforms.uCover.value = look.mode === 3 ? -1 : look.clouds;
        this.clouds = new THREE.Mesh(sphereGeo(64), cm);
        this.clouds.scale.setScalar(1 + Math.max(6, 0.0012 * d.radius / 1000) * 1000 / d.radius);
        this.clouds.renderOrder = 1;
        g.add(this.clouds);
      }
      if (d.atmosphere) {
        const a = d.atmosphere;
        const Rkm = d.radius / 1000;
        this.atmo = new THREE.Mesh(sphereGeo(64), atmosphereMaterial(q.atmoSteps));
        const u = this.atmo.material.uniforms;
        const hKm = a.heightKm || Math.max(40, Rkm * 0.015);
        this.atmoRa = 1 + hKm / Rkm;
        u.uRa.value = this.atmoRa;
        u.uH.value = (hKm / 11) / Rkm;
        // Rayleigh-like coefficients in units of 1/R, tinted by the atmosphere's colour.
        const base = [5.8e-6, 13.5e-6, 33.1e-6];
        const col = a.color || [0.3, 0.55, 1];
        const k = (a.density || 1) * d.radius;
        const tint = [col[0] / 0.3, col[1] / 0.55, col[2] / 1.0];
        const bR = base.map((b, i) => b * k * Math.pow(tint[i], 0.6));
        // Thick hazy atmospheres scatter more evenly across wavelengths.
        if (look.mode === 2 || a.density > 1.5) { const m = (bR[0] + bR[1] + bR[2]) / 3; for (let i = 0; i < 3; i++) bR[i] = m * col[i] * 1.2; }
        u.uBetaR.value.set(...bR);
        u.uBetaM.value = 21e-6 * k * 0.5;
        const dust = DUST[d.id];
        if (dust) { u.uDust.value = dust.tau / u.uH.value; u.uDustAlb.value.set(...dust.albedo); }
        this.atmo.renderOrder = 2;
        this.ctx.scene.add(this.atmo);
      }
      if (d.rings) this.buildRings(d.rings);
      if (d.kind === "comet") this.buildTail();
    }
    this.ctx.scene.add(g);
  }

  buildRings(r) {
    let tex;
    if (r.texture) tex = loadTexture(r.texture);
    else tex = ringProfileTexture(r);
    const geo = new THREE.RingGeometry(r.innerR, r.outerR, 192, 1);
    const pos = geo.attributes.position, uv = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const rr = Math.hypot(pos.getX(i), pos.getY(i));
      uv.setXY(i, (rr - r.innerR) / (r.outerR - r.innerR), 0.5);
    }
    this.ring = new THREE.Mesh(geo, ringMaterial(tex, { gain: r.texture ? 1.1 : 1, tint: r.tint || [1, 1, 1] }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.renderOrder = 3;
    this.group.add(this.ring);
  }

  buildTail() {
    // Dust tail (warm, broad) and ion tail (blue, narrow), always pointing away
    // from the Sun, with length growing as the comet nears perihelion.
    this.tail = new THREE.Group();
    for (const [col, w, I] of [[[1, 0.9, 0.75], 0.08, 0.5], [[0.5, 0.7, 1], 0.025, 0.7]]) {
      const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.0005, w, 1, 20, 1, true), beamMaterial(col, I));
      cone.position.y = 0.5;
      this.tail.add(cone);
    }
    this.ctx.scene.add(this.tail);
  }

  dispose() {
    if (!this.group) return;
    const kill = (o) => {
      if (!o) return;
      o.traverse((m) => {
        if (m.material) m.material.dispose();
        if (m.geometry && !isShared(m.geometry)) m.geometry.dispose();
      });
      if (o.parent) o.parent.remove(o);
    };
    kill(this.group); kill(this.glow); kill(this.halo); kill(this.atmo); kill(this.tail);
    if (this.terrain) { this.terrain.dispose(); this.terrain = null; }
    if (this.rocks) { this.rocks.dispose(); this.rocks = null; }
    this.group = null; this.glow = this.halo = this.atmo = this.tail = null;
  }

  // Place and shade for this frame. cam: UPos; returns on-screen radius (px).
  update(cam, ctx, timeSec) {
    sub(this.pos, cam, this.rel);
    const D = Math.hypot(this.rel[0], this.rel[1], this.rel[2]);
    this.dist = D;
    const R = this.radius;
    const angR = Math.asin(Math.min(1, R / Math.max(D, R)));
    this.screenR = angR * ctx.pxPerRad;
    // Build a little before it can be seen, so textures are loading early; draw
    // only once it covers a pixel-fraction *and* its maps are ready.
    const nearVisible = this.screenR > 0.05 || (this.def.kind === "star" && this.screenR > 0.005);
    const visible = (this.screenR > 0.35 || (this.def.kind === "star" && this.screenR > 0.02));
    if (nearVisible && !this.group) this.build();
    if (!visible || !this.isReady()) {
      if (this.group && !nearVisible && performance.now() - (this.lastSeen || 0) > 15000) this.dispose();
      if (this.group) { this.group.visible = false; this.setAux(false); }
      this.lod = 0;
      return this.screenR;
    }
    this.lastSeen = performance.now();
    const s = compress(D);
    const px = this.rel[0] * s, py = this.rel[1] * s, pz = this.rel[2] * s;
    const g = this.group;
    g.visible = true;
    g.position.set(px, py, pz);
    g.quaternion.copy(this.quat);
    const d = this.def;
    // The orbital mesh takes the body's real shape (ellipsoid / triaxial).
    const ax = this.surface ? this.surface.axes : [1, 1 - (d.flattening || 0), 1];
    g.scale.set(R * s * ax[0], R * s * ax[1], R * s * ax[2]);

    // Geometry detail by screen size.
    const want = this.screenR < 6 ? 16 : this.screenR < 40 ? 32 : this.screenR < 200 ? 64 : ctx.quality.sphereSeg;
    if (want !== this.seg && this.mesh && d.kind !== "blackhole") { this.mesh.geometry = sphereGeo(want); this.seg = want; }

    if (this.mat && this.mat.uniforms.uLightDir) {
      const u = this.mat.uniforms;
      u.uLightDir.value.copy(this.lightDir);
      u.uLightCol.value.copy(this.lightCol);
      u.uLight2Dir.value.copy(this.light2Dir);
      u.uLight2Col.value.copy(this.light2Col);
      u.uTime.value = timeSec;
      // Extra noise octaves only when close enough to see them.
      u.uDetail.value = this.screenR > 2000 ? 3 : this.screenR > 600 ? 2 : this.screenR > 150 ? 1 : 0;
      if (u.uDebug && !this.terrain) { const c = ctx.debugLod ? DEBUG_LOD[this.lod || 1] : [1, 1, 1]; u.uDebug.value.set(c[0], c[1], c[2]); }
    }
    if (this.mat && this.mat.uniforms.uTime && d.kind === "star") this.mat.uniforms.uTime.value = timeSec;
    if (this.clouds) {
      const cu = this.clouds.material.uniforms;
      cu.uLightDir.value.copy(this.lightDir);
      cu.uLightCol.value.copy(this.lightCol);
      cu.uTime.value = timeSec;
      this.clouds.rotation.y = timeSec * 2e-6;
      // A finer shell up close, so the cloud deck's horizon isn't faceted.
      const cseg = this.dist - this.radius < this.radius * 0.3 ? 384 : 64;
      if (this.cseg !== cseg) { this.clouds.geometry = sphereGeo(cseg); this.cseg = cseg; }
    }
    this.groundR = R;
    if (this.canTerrain) this.updateTerrain(R, s, px, py, pz, ctx, timeSec);
    if (this.atmo) this.updateAtmosphere(R, s, px, py, pz);
    if (this.ring) {
      const ru = this.ring.material.uniforms;
      ru.uSun.value.copy(this.lightDir);
      ru.uPole.value.set(0, 1, 0).applyQuaternion(this.quat);
      ru.uCenter.value.set(px, py, pz);
      ru.uRadius.value = R * s;
    }
    if (this.glow) this.updateGlow(ctx, R, s, px, py, pz);
    if (this.halo) {
      this.halo.position.set(px, py, pz);
      this.halo.quaternion.copy(ctx.camQuat);
      this.halo.scale.setScalar(R * s * 2.2);
      this.halo.visible = true;
    }
    if (this.disk) this.disk.material.uniforms.uTime.value = timeSec;
    if (this.beams) {
      // Real pulsars spin many times a second; the beam sweep is slowed to a
      // safe, readable rate (the info panel gives the true period).
      this.beams.rotation.y = ctx.reducedMotion ? 0 : timeSec * 0.6;
      this.beamAxis.rotation.y = ctx.reducedMotion ? 0 : timeSec * 0.9;
    }
    if (this.tail) this.updateTail(ctx, R, s, px, py, pz);
    // Level of detail, for the debug overlay (and its optional tint).
    this.lod = this.terrain ? 4 : this.seg <= 16 ? 1 : this.seg <= 32 ? 2 : 3;
    if (this.mat && this.mat.uniforms.uDebug) {
      const c = ctx.debugLod ? DEBUG_LOD[this.lod] : [1, 1, 1];
      this.mat.uniforms.uDebug.value.set(c[0], c[1], c[2]);
    }
    return this.screenR;
  }

  // True once every map this body draws with has loaded (or failed — then it
  // falls back to drawing without it rather than vanishing forever).
  isReady() {
    if (!this.group) return false;
    const u = this.mat && this.mat.uniforms;
    if (!u) return true;
    for (const k of ["uMap", "uNight"]) {
      const t = u[k] && u[k].value;
      if (t && t.isTexture && !t.userData.ready) return false;
    }
    return true;
  }

  // The body's surface model (shape + elevation), created on first use and
  // independent of rendering, so collision works before any mesh exists.
  getSurface() {
    if (!this.surface) {
      const d = this.def;
      const look = typeof d.look === "string" ? resolveLook(d.look) : d.look || resolveLook("rock");
      this.surface = new Surface(d, d.surfaceEntry, Object.assign({ seed: (d.seed || 11) % 16777216 }, look));
    }
    return this.surface;
  }
  // Start fetching the real elevation grid (when the body has one).
  requestField() {
    const surf = this.getSurface();
    if (!surf.needsField() || this.fieldLoading) return;
    this.fieldLoading = true;
    loadField(d_entry(this)).then((f) => {
      surf.field = f;
      const e = this.def.surfaceEntry;
      if (this.mat && this.mat.uniforms.uElev && !(e && e.surfaceMap)) { this.mat.uniforms.uElev.value = f.texture(); this.mat.uniforms.uElevOn.value = 1; this.mat.uniforms.uElevScale.value = 1 / surf.elevSpan(); }
    }).catch((e) => { console.warn("[space] elevation unavailable for", this.def.name, e.message); surf.mode = "real-imagery-procedural-relief"; });
  }
  // Ground below a world position: { r: distance to centre, ground: surface radius,
  // alt: height above ground, dir: body-local unit direction, up: world unit up }.
  groundAt(upos) {
    const rel = sub(upos, this.pos);
    const d = toLocal(this.quat, rel);
    const surf = this.getSurface();
    // Detail 5: the same octaves as the terrain chunks built around a camera
    // near the ground (terrain.js: min(5, level − 3)), so what you stand on is
    // what you see.
    const ground = surf.radiusAt(d.x, d.y, d.z, 5);
    return { r: d.r, ground, alt: d.r - ground, dir: d, up: [rel[0] / d.r, rel[1] / d.r, rel[2] / d.r], water: surf.isWater(d.x, d.y, d.z) };
  }

  updateTerrain(R, s, px, py, pz, ctx, timeSec) {
    const alt = this.dist - R;
    const surf = this.getSurface();
    const shapeData = !!(surf.entry && surf.entry.terrain && surf.entry.terrain.shapeFromData);
    // Reconstructed features at real positions (craters, ridges, …).
    if (!this.featuresAsked && surf.entry && surf.entry.terrain && surf.entry.terrain.features && alt < R * 4) {
      this.featuresAsked = true;
      loadFeatures(this.def.id).then((list) => surf.setFeatures(list));
    }
    if (alt < R * (shapeData ? 8 : 3)) this.requestField();
    // Finer real data (global tiles, landmark patches) streams in around the camera.
    if (surf.field && this.def.surfaceEntry && alt < R * 3) {
      if (!this.streamer) this.streamer = new TerrainStreamer(surf, this.def.surfaceEntry);
      if ((this.streamClock = (this.streamClock || 0) - 1) <= 0) {
        this.streamClock = 8;
        const inv = _q.copy(this.quat).invert();
        _v.set(-this.rel[0], -this.rel[1], -this.rel[2]).applyQuaternion(inv).normalize();
        this.streamer.update(Math.asin(Math.max(-1, Math.min(1, _v.y))) * 180 / Math.PI, Math.atan2(-_v.z, _v.x) * 180 / Math.PI, Math.max(0, alt));
      }
    }
    // Irregular bodies whose shape comes from the data (Phobos, Enceladus):
    // show the real shape from much farther out, not a sphere.
    const near = shapeData ? 6 : 0.6;
    if (!this.terrain && alt < R * near && surf.ready()) {
      const look = this.terrainLook();
      this.terrain = new Terrain(this.ctx.scene, look, surf, ctx.quality, this.def.id);
    }
    if (this.terrain && alt > R * near * 1.6) { this.terrain.dispose(); this.terrain = null; this.mesh.visible = true; if (this.rocks) { this.rocks.dispose(); this.rocks = null; } return; }
    if (!this.terrain) return;
    const inv = _q.copy(this.quat).invert();
    _v.set(-this.rel[0], -this.rel[1], -this.rel[2]).applyQuaternion(inv);
    this.terrainFrame = ctx.frameNo;                 // see dropStaleTerrain()
    const covered = this.terrain.update([_v.x, _v.y, _v.z], ctx.terrainBudget || 3);
    this.terrain.place(_p.set(px, py, pz), this.quat, s, this.lightDir, this.lightCol, timeSec, ctx.debugLod ? DEBUG_LOD[4] : null);
    // Things fixed to the ground (Earth's region packs) ride with the terrain.
    if (this.onSurfacePlace) this.onSurfacePlace(this.terrain, _p, this.quat, s, this.lightDir, this.lightCol);
    // Rocks close to the ground (procedural, per world; not on Earth).
    const rk = rockKind(this.def.id);
    if (rk) {
      if (!this.rocks) this.rocks = new RockField(this.ctx.scene, this, rk, ctx.quality);
      _v.set(-this.rel[0], -this.rel[1], -this.rel[2]).applyQuaternion(_q.copy(this.quat).invert());
      const r = _v.length(); _v.divideScalar(r);
      this.rocks.update(surf, [_v.x, _v.y, _v.z], r - surf.radiusAt(_v.x, _v.y, _v.z, 0));
      this.rocks.place(_p, this.quat, s);
    }
    this.mesh.visible = !covered;
  }
  // Terrain material: the orbital look, with a surface map where the visible
  // map is cloud tops (Venus), and the elevation texture where one exists.
  terrainLook() {
    const e = this.def.surfaceEntry;
    const look = Object.assign({}, this.look);
    // Venus: the Magellan radar map of the ground (greyscale backscatter),
    // tinted the colour of light under its clouds.
    if (e && e.surfaceMap) { look.map = loadTexture(e.surfaceMap); look.mode = 0; look.mapTint = e.surfaceMap.endsWith("_usgs.jpg") ? 1 : 0; look.c1 = [0.62, 0.5, 0.36]; }
    // Real elevation: Earth's water and imagery, and height-keyed colour for
    // bodies without a real map (so their colour follows the real relief).
    if (this.surface.field) { look.elevTex = this.surface.field.texture(); look.elevScale = 1 / this.surface.elevSpan(); }
    return look;
  }

  // Terrain and rocks that weren't placed this frame (the body was skipped or
  // hidden — a long jump away, say) would otherwise linger at stale positions.
  dropStaleTerrain(frameNo) {
    if (this.terrain && this.terrainFrame !== frameNo) { this.terrain.dispose(); this.terrain = null; if (this.mesh) this.mesh.visible = true; }
    if (this.rocks && this.terrainFrame !== frameNo) { this.rocks.dispose(); this.rocks = null; }
  }

  setAux(v) {
    if (this.glow) this.glow.visible = v;
    if (this.halo) this.halo.visible = v;
    if (this.atmo) this.atmo.visible = v;
    if (this.tail) this.tail.visible = v;
  }

  updateAtmosphere(R, s, px, py, pz) {
    const a = this.atmo;
    a.visible = true;
    a.position.set(px, py, pz);
    a.quaternion.copy(this.quat);
    const inv = _q.copy(this.quat).invert();
    const u = a.material.uniforms;
    // The scattering model is a sphere. Near a flattened planet, size it to
    // the reference shape under the camera, so the camera's height above the
    // sphere is its real height (Earth's ground at the Cape is ~5 km inside
    // the equatorial radius); from afar the equatorial radius is used.
    let Re = R;
    const near = this.dist / R;
    // Only for nearly round bodies (Earth 0.34%, Mars 0.59%): on Saturn a
    // polar-sized sphere would cut through the equatorial limb.
    if (near < this.atmoRa * 4 && (this.def.flattening || 0) < 0.01) {
      _v.set(-px, -py, -pz).applyQuaternion(inv).normalize();
      const w = 1 - Math.min(1, Math.max(0, (near - this.atmoRa * 2) / (this.atmoRa * 2)));
      // Below the datum (Gale, Hellas) the shell's base follows the ground:
      // single scattering alone darkens a deep basin's horizon, which real
      // skies refill by multiple scattering. Above it (Olympus Mons) the
      // base stays at the datum, so a summit sky is thinner.
      const sf = this.getSurface();
      Re = R + (sf.baseRadius(_v.x, _v.y, _v.z) + Math.min(0, sf.solid ? sf.heightAt(_v.x, _v.y, _v.z, 0) : 0) - R) * w;
    }
    a.scale.setScalar(Re * s * this.atmoRa);
    // Camera and Sun in the planet's own frame, in planet radii.
    u.uCam.value.set(-px, -py, -pz).divideScalar(Re * s).applyQuaternion(inv);
    u.uSun.value.copy(this.lightDir).applyQuaternion(inv);
    // Below the 1-bar level of a giant the shell can't be ray-marched from
    // outside in; the atmosphere-interior effect takes over there. On a solid
    // body the camera can be below the reference sphere (Gale crater is
    // ~4.5 km under it) and the march simply starts in denser air.
    if (u.uCam.value.length() < 1.0 && !this.getSurface().solid) { a.visible = false; return; }
    const inside = u.uCam.value.length() < this.atmoRa;
    a.material.side = inside ? THREE.BackSide : THREE.FrontSide;
    // Depth-tested from inside too: the sky lies behind the ground and the
    // craft, never over them.
    a.material.depthTest = true;
    // Surface radiance here is albedo × cos(sun angle); matching in-scatter
    // needs the same irradiance, about π in these units.
    u.uSunI.value = 3.6 * Math.max(0.15, this.lightCol.x);
  }

  updateGlow(ctx, R, s, px, py, pz) {
    const gl = this.glow;
    gl.visible = true;
    gl.position.set(px, py, pz);
    gl.quaternion.copy(ctx.camQuat);
    const d = this.def;
    const u = gl.material.uniforms;
    if (d.kind === "star") {
      // The corona/glare scales with the disc but never vanishes to nothing,
      // so a distant sun still dazzles.
      const minPx = 26 * Math.min(1, Math.sqrt(Math.max(0.05, d.lumSun || 1)) * 0.6 + 0.4);
      const wantPx = Math.max(this.screenR * 5, minPx);
      const sizeW = (wantPx / Math.max(this.screenR, 1e-6)) * R * s;
      gl.scale.setScalar(sizeW);
      u.uCore.value = Math.min(0.5, Math.max(0.02, this.screenR / wantPx));
      u.uI.value = 2.4;
    } else {
      gl.scale.setScalar(Math.max(this.screenR * 8, 14) / Math.max(this.screenR, 1e-6) * R * s);
      u.uCore.value = 0.1;
    }
  }

  updateTail(ctx, R, s, px, py, pz) {
    const t = this.tail;
    const rSunAU = this.def.helioDistAU || 5;
    const active = rSunAU < 5;
    t.visible = active;
    if (!active) return;
    const lenM = 1.2e10 / Math.max(0.3, rSunAU * rSunAU);         // ~0.1 AU near 1 AU
    t.position.set(px, py, pz);
    // Away from the Sun.
    _v.copy(this.lightDir).negate();
    t.quaternion.setFromUnitVectors(_up, _v);
    t.scale.setScalar(lenM * s);
  }
}

const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const DEBUG_LOD = [[1, 0.3, 0.3], [1, 0.4, 0.4], [1, 0.9, 0.3], [0.4, 1, 0.4], [0.4, 0.7, 1]];
const _v = new THREE.Vector3();
// Ground character per world, for the terrain shader up close: bump strength,
// dust on flats, ice glint, rock exposed on slopes; rock colour factor; the
// fill light from the sky (none without air) and how diffuse the sunlight is
// (Venus and Titan: scattered through a thick atmosphere).
const STYLE = {
  mars: { surf: [0.9, 0.5, 0, 0.75], surfTint: [0.55, 0.48, 0.45], ambient: 0.03, diffuse: 0.12 },
  moon: { surf: [0.8, 0.15, 0, 0.5], surfTint: [0.72, 0.72, 0.74], ambient: 0.003 },
  mercury: { surf: [0.8, 0.15, 0, 0.5], surfTint: [0.7, 0.68, 0.66], ambient: 0.003 },
  venus: { surf: [0.6, 0.05, 0, 0.85], surfTint: [0.62, 0.56, 0.5], ambient: 0.1, diffuse: 0.8 },
  earth: { surf: [0.25, 0, 0, 0.3], surfTint: [0.8, 0.8, 0.8], ambient: 0.03 },
  titan: { surf: [0.4, 0.25, 0.1, 0.4], surfTint: [0.75, 0.68, 0.6], ambient: 0.12, diffuse: 0.75 },
  io: { surf: [0.6, 0.35, 0, 0.5], surfTint: [0.62, 0.55, 0.42], ambient: 0.003 },
  ceres: { surf: [0.8, 0.2, 0, 0.6], surfTint: [0.7, 0.7, 0.7], ambient: 0.003 },
  vesta: { surf: [0.85, 0.2, 0, 0.65], surfTint: [0.68, 0.66, 0.64], ambient: 0.003 },
  pluto: { surf: [0.5, 0.35, 0.6, 0.4], surfTint: [0.82, 0.76, 0.7], ambient: 0.005 },
  charon: { surf: [0.6, 0.2, 0.3, 0.5], surfTint: [0.75, 0.74, 0.74], ambient: 0.004 },
  triton: { surf: [0.45, 0.35, 0.6, 0.35], surfTint: [0.82, 0.78, 0.76], ambient: 0.005 }
};
const ICY = { surf: [0.35, 0.2, 0.9, 0.3], surfTint: [0.86, 0.89, 0.93], ambient: 0.004 };
const ICY_IDS = new Set(["europa", "enceladus", "ganymede", "callisto", "mimas", "tethys", "dione", "rhea", "iapetus", "miranda", "ariel", "umbriel", "titania", "oberon", "nereid", "proteus"]);
function groundStyle(d) {
  return STYLE[d.id] || (ICY_IDS.has(d.id) ? ICY : { surf: [0.75, 0.2, 0, 0.55], surfTint: [0.7, 0.7, 0.7], ambient: d.atmosphere ? 0.03 : 0.004 });
}

// Atmospheric dust: vertical visible optical depth and an effective albedo
// (R, G, B). Mars: τ ≈ 0.5 in the clear season (MER Pancam, Lemmon et al.
// 2015). The dust absorbs blue (single-scattering albedo ≈ 0.97 / 0.8 / 0.6,
// Wolff et al. 2009); multiple scattering deepens that colour, which a
// single-scattering model misses, so the albedo here is more saturated — an
// approximation tuned to the butterscotch of rover images.
export const DUST = { mars: { tau: 0.5, albedo: [0.92, 0.6, 0.34] } };
const _up = new THREE.Vector3(0, 1, 0);
function d_entry(b) { return b.def.surfaceEntry; }
function isShared(g) { for (const v of geoCache.values()) if (v === g) return true; return g === planeGeo; }

export function resolveLook(name) {
  if (typeof name !== "string") return name;
  if (name.startsWith("map:")) return { mode: 0, map: name.slice(4) };
  const p = PRESET_LOOKS[name] || PRESET_LOOKS.rock;
  return Object.assign({ cont: 1.6, mount: 0.4, warp: 0.3, craterFreq: 6, sea: -9, ice: 2 }, p);
}

// Look from a generated planet (systemgen) to shader options.
export function lookFromGenerated(L) {
  if (L.kind === "gas") return { mode: 2, c0: L.c0, c1: L.c1, c2: L.c2, bands: L.bands, turb: L.turb, storm: L.storm, glow: L.glow, seed: L.seed };
  return { mode: 1, c0: L.c0, c1: L.c1, c2: L.c2, ocean: L.ocean, iceCol: L.iceCol, cont: L.cont, mount: L.mount, warp: L.warp,
    crater: L.crater, craterFreq: L.craterFreq, sea: L.sea, ice: L.ice, lava: L.lava, clouds: L.clouds, reliefKm: L.reliefKm, seed: L.seed };
}

// Radial ring profile → a 1-D texture.
const RING_PRESETS = {
  jupiter: { lines: [], sheets: [[1.40, 1.71, 0.04], [1.72, 1.81, 0.18]], tint: [0.85, 0.7, 0.55] },
  uranus: { lines: [[1.637, 0.004, 0.25], [1.652, 0.004, 0.25], [1.666, 0.004, 0.25], [1.75, 0.004, 0.3], [1.786, 0.004, 0.3],
    [1.846, 0.004, 0.25], [1.863, 0.004, 0.25], [1.89, 0.004, 0.32], [2.001, 0.008, 0.7]], sheets: [], tint: [0.55, 0.55, 0.55] },
  neptune: { lines: [[2.148, 0.006, 0.35], [2.31, 0.006, 0.15], [2.541, 0.007, 0.45]], sheets: [[1.65, 1.73, 0.08], [2.15, 2.31, 0.05]], tint: [0.6, 0.55, 0.5] }
};
function ringProfileTexture(r) {
  const N = 1024;
  const c = document.createElement("canvas");
  c.width = N; c.height = 1;
  const g = c.getContext("2d");
  const img = g.createImageData(N, 1);
  const preset = RING_PRESETS[r.preset];
  const rng = new Rng(r.seed || 1);
  // Procedural rings get a banded profile with a few gaps.
  const gaps = preset ? [] : Array.from({ length: 4 }, () => [rng.range(r.innerR, r.outerR), rng.range(0.005, 0.03)]);
  for (let i = 0; i < N; i++) {
    const rr = r.innerR + (r.outerR - r.innerR) * (i + 0.5) / N;
    let a = 0;
    if (preset) {
      preset.sheets.forEach((s) => { if (rr >= s[0] && rr <= s[1]) a += s[2]; });
      preset.lines.forEach((l) => { a += l[2] * Math.exp(-(((rr - l[0]) / l[1]) ** 2)); });
    } else {
      const x = (i + 0.5) / N;
      a = (r.opacity || 0.6) * (0.55 + 0.45 * Math.sin(x * 60 + (r.seed % 7))) * Math.sin(Math.PI * x) ** 0.4;
      gaps.forEach((gp) => { if (Math.abs(rr - gp[0]) < gp[1]) a *= 0.1; });
    }
    const t = preset ? preset.tint : r.tint || [0.85, 0.8, 0.7];
    img.data[i * 4] = t[0] * 255; img.data[i * 4 + 1] = t[1] * 255; img.data[i * 4 + 2] = t[2] * 255;
    img.data[i * 4 + 3] = Math.min(255, a * 255);
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
