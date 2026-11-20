// The universe as the simulator holds it: what exists, where it is right now,
// and which parts are detailed enough to draw near the observer.
//
// Hierarchy, loaded only around the camera:
//   galaxy groups → galaxies (catalogue + procedural cells) → stellar sectors
//   (streamed cells inside the current galaxy) → star systems (activated when
//   close) → planets, moons, rings → surface detail (shader octaves, terrain).

import * as THREE from "three";
import { UPos, sub, LY, AU, KM, R_SUN, DEG, raDecToRender, fmtDistance, fmtNum, eqToRender } from "../engine/coords.js";
import { Rng, hashInts, hashString, designation } from "../engine/rng.js";
import { heliocentric, moonGeocentric, spinAxes, poleOf, moonOffset, orbitPolyline } from "./ephemeris.js";
import { galaxyParams, inside as insideGalaxy, nearestArm, SUN_R, describeMorphology, generateCloud } from "./galaxymodel.js";
import { LEVEL_SIZE } from "./sectorgen.js";
import { generateSystem, interpretExoSystem, typeLabel, proceduralStar } from "./systemgen.js";
import { generateDeep } from "./deepsky.js";
import { toLocal } from "./surfaces.js";
import { tempToRGB, spectralType, describeClass } from "./stellar.js";
import { eclToRender } from "../engine/coords.js";
import { Body, lookFromGenerated, disposeSharedBodyResources } from "../render/bodies.js";
import { StarField, GalaxyCloud, GalaxyPoints, SectorPoints, BodyPoints, OrbitLine, Belt, anchorLy } from "../render/sky.js";

const SOL = new UPos();
const G = 6.674e-11, M_SUN = 1.98847e30;

// ── Milky Way frame: galactic coordinates from IAU definitions ──
// NGP at RA 192.85948°, Dec 27.12825°; Galactic Centre at l = 0, b = 0
// (RA 266.40510°, Dec −28.93617°). Local frame: +X from the centre toward
// the Sun, +Y galactic north, +Z toward l = 90° (the direction of rotation).
function milkyWayFrame() {
  const ngp = new THREE.Vector3(...raDecToRender(192.85948, 27.12825));
  const gc = new THREE.Vector3(...raDecToRender(266.40510, -28.93617));
  const X = gc.clone().negate();
  const Y = ngp.clone().sub(X.clone().multiplyScalar(ngp.dot(X))).normalize();
  const Z = new THREE.Vector3().crossVectors(X, Y);
  const m = new THREE.Matrix4().makeBasis(X, Y, Z);
  return { quat: new THREE.Quaternion().setFromRotationMatrix(m), gcDir: gc };
}

// Disc orientation for a catalogue galaxy: inclination from the catalogue
// (or its axis ratio), position angle from HyperLEDA where known — seeded
// only when neither catalogue has it.
function galaxyQuat(g, posLy) {
  const los = new THREE.Vector3(...posLy).normalize();
  let inc;
  if (g.inclDeg !== null && g.inclDeg !== undefined) inc = g.inclDeg * DEG;
  else if (g.axisRatio) inc = Math.acos(Math.sqrt(Math.max(0, (g.axisRatio ** 2 - 0.04) / 0.96)));
  else inc = new Rng(g.seed).range(0.2, 1.4);
  let perp;
  if (g.paDeg !== null && g.paDeg !== undefined && g.raDeg !== undefined) {
    // On the sky the major axis lies at PA (north through east); the disc's
    // normal tilts away from us along the minor axis.
    const ra = g.raDeg * DEG, de = g.decDeg * DEG, pa = g.paDeg * DEG;
    const north = new THREE.Vector3(...eqToRender(-Math.sin(de) * Math.cos(ra), -Math.sin(de) * Math.sin(ra), Math.cos(de)));
    const east = new THREE.Vector3(...eqToRender(-Math.sin(ra), Math.cos(ra), 0));
    perp = north.multiplyScalar(-Math.sin(pa)).add(east.multiplyScalar(Math.cos(pa))).normalize();
  } else {
    const rng = new Rng(hashInts(g.seed, 3));
    const pa = rng.range(0, Math.PI * 2);
    const a = new THREE.Vector3(0, 1, 0);
    if (Math.abs(los.dot(a)) > 0.9) a.set(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(los, a).normalize();
    const v = new THREE.Vector3().crossVectors(los, u);
    perp = u.multiplyScalar(Math.cos(pa)).add(v.multiplyScalar(Math.sin(pa)));
  }
  const n = los.clone().negate().multiplyScalar(Math.cos(inc)).add(perp.multiplyScalar(Math.sin(inc))).normalize();
  const X = new THREE.Vector3().crossVectors(n, Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
  const Z = new THREE.Vector3().crossVectors(X, n);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, n, Z));
}

function quatFromBasis(x, y) {
  const X = new THREE.Vector3(...x), Y = new THREE.Vector3(...y);
  const Z = new THREE.Vector3().crossVectors(X, Y);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
}

// Planet tint as a point of light.
const MAP_TINT = { mercury: [0.8, 0.76, 0.7], venus: [1, 0.95, 0.82], earth: [0.7, 0.8, 1], mars: [1, 0.7, 0.5], jupiter: [1, 0.92, 0.8],
  saturn: [1, 0.92, 0.75], uranus: [0.75, 0.92, 1], neptune: [0.6, 0.72, 1], moon: [0.9, 0.9, 0.88] };

export class Universe {
  constructor(cat, ctx) {
    this.cat = cat;
    this.ctx = ctx;               // { far, near, quality, workers, settings, onDiscover }
    this.jd = 2451545;
    this.galaxies = [];
    this.systems = new Map();
    this.cells = new Map();
    this.pendingCells = new Set();
    this.discovered = loadDiscoveries();
    this.labels = [];
    this.bodyPointItems = [];
    this.nearBodies = [];
    this.buildSolarSystem();
    this.buildStars();
    this.buildGalaxies();
    this.buildDeepSky();
    this.bodyPoints = new BodyPoints(ctx.far, 512);
    this.procGal = new Map();
  }

  // ── Solar System ──
  buildSolarSystem() {
    const ctx = this.ctx;
    this.solar = new Map();
    const bodies = this.cat.solar.bodies;
    for (const b of bodies) {
      const def = {
        surfaceEntry: (this.cat.surfaces && this.cat.surfaces.bodies[b.id]) || null,
        id: b.id, name: b.name, kind: b.kind, radius: (b.eqRadiusKm || b.radiusKm) * KM, flattening: b.flattening || 0,
        triaxial: b.triaxial || null, look: b.look, atmosphere: b.atmosphere || null, rings: b.rings || null,
        teff: b.teffK, lumSun: b.lumSun, seed: hashString(b.id), pos: new UPos(), real: true
      };
      const body = new Body(def, ctx.nearCtx);
      this.solar.set(b.id, { data: b, def, body });
    }
    this.sun = this.solar.get("sun");
    // Orbits around the Sun, drawn once.
    this.solarOrbits = [];
    for (const [, s] of this.solar) {
      const b = s.data;
      let pts = null;
      if (b.elements) pts = orbitPolyline("standish", b.elements);
      else if (b.osculating) pts = orbitPolyline("osculating", b.osculating);
      else if (b.perihelion) pts = orbitPolyline("perihelion", b.perihelion);
      if (pts) {
        const col = b.kind === "planet" ? 0x7795c0 : b.kind === "comet" ? 0x6aa0a8 : 0x8a7f9a;
        this.solarOrbits.push({ line: new OrbitLine(pts.map((p) => eclToRender(p.map((v) => v * AU))), ctx.far, col), parent: "sun", id: b.id });
      }
    }
    // Belts: representative distributions, not individual catalogued objects.
    const q = ctx.quality;
    const rng = new Rng(77);
    this.belts = [
      { anchor: "sun", belt: new Belt({ count: Math.round(q.mwParticles * 0.06), inner: 2.1, outer: 3.3, ecc: 0.12, incl: 9 }, ctx.far, rng) },
      { anchor: "sun", belt: new Belt({ count: Math.round(q.mwParticles * 0.03), inner: 30, outer: 50, ecc: 0.1, incl: 10, bright: 2, tint: [0.75, 0.75, 0.8] }, ctx.far, rng) }
    ];
    this.moonOrbits = new Map();
  }

  updateSolar(jd) {
    const T = (jd - 2451545) / 36525, d = jd - 2451545;
    const sunPos = this.sun.def.pos.set(SOL);
    for (const [id, s] of this.solar) {
      const b = s.data;
      if (id === "sun") continue;
      if (b.kind === "moon") continue;
      const v = heliocentric(b, jd, T);
      s.def.pos.set(SOL).add(v[0], v[1], v[2]);
      s.helio = v;
      s.def.helioDistAU = Math.hypot(v[0], v[1], v[2]) / AU;
    }
    for (const [id, s] of this.solar) {
      const b = s.data;
      if (b.kind !== "moon") continue;
      const parent = this.solar.get(b.parent);
      if (b.lunarTheory) {
        const v = eclToRender(moonGeocentric(T));
        s.def.pos.set(parent.def.pos).add(v[0], v[1], v[2]);
        s.orbitNormal = null;
      } else {
        const ppole = parent.data.spin ? poleOf(parent.data.spin, T) : [0, 1, 0];
        const o = moonOffset(b, ppole, jd);
        s.def.pos.set(parent.def.pos).add(o.pos[0], o.pos[1], o.pos[2]);
        s.orbitNormal = o.normal;
        s.orbitBasis = o.basis;
      }
    }
    // Orientation.
    for (const [id, s] of this.solar) {
      const b = s.data, body = s.body;
      if (b.spin) {
        const ax = spinAxes(b.spin, T, d);
        body.quat.copy(quatFromBasis(ax.meridian, ax.pole));
      } else if (b.tidallyLocked && b.parent) {
        const parent = this.solar.get(b.parent);
        const rel = sub(parent.def.pos, s.def.pos);
        const x = norm3(rel);
        const n = s.orbitNormal || [0, 1, 0];
        const y = norm3(sub3(n, scale3(x, dot3(n, x))));
        body.quat.copy(quatFromBasis(x, y));
      } else if (b.approxSpin) {
        body.quat.setFromAxisAngle(_Y, ((d / b.approxSpin) % 1) * Math.PI * 2);
      }
      // Lit by the Sun.
      if (id !== "sun") {
        const rel = sub(sunPos, s.def.pos);
        body.lightDir.set(rel[0], rel[1], rel[2]).normalize();
        body.lightCol.set(1, 1, 1);
      }
    }
  }

  // ── real stars ──
  buildStars() {
    this.stars = this.cat.stars;
    this.starField = new StarField(this.stars, this.ctx.far);
    for (const s of this.stars) s.upos = UPos.fromLy(s.posLy[0], s.posLy[1], s.posLy[2]);
  }

  // ── galaxies ──
  // Every galaxy has one stable id and one record, shared by its point
  // stand-in, its particle cloud, its sectors and the search index, so the
  // thing you see far away is the same thing you arrive at.
  buildGalaxies() {
    const mwf = milkyWayFrame();
    this.mwFrame = mwf;
    const mwRec = { id: "real:galaxy:MilkyWay", name: "Milky Way", common: "Milky Way", kind: "galaxy", real: true, milkyWay: true, seed: 1, ttype: 4, barred: true,
      diamKly: 100, group: "Local Group", src: "Structure: model after published arm and bar positions", type: "barred", lumSun: 2.5e10 };
    const gcUPos = SOL.offset([mwf.gcDir.x, mwf.gcDir.y, mwf.gcDir.z], SUN_R * LY);
    this.mw = { rec: mwRec, center: gcUPos, quat: mwf.quat, params: galaxyParams(mwRec), cloud: null, isMW: true, pinned: true };
    this.mw.invQuat = this.mw.quat.clone().invert();
    this.galaxies.push(this.mw);
    const list = this.cat.galaxies;
    // Catalogue galaxies as soft points, anchored at Sol.
    this.galaxyPoints = new GalaxyPoints(list, this.ctx.far, (g) => g.posLy);
    list.forEach((g, i) => {
      g.id = "real:galaxy:" + g.name;
      const e = { rec: g, center: UPos.fromLy(g.posLy[0], g.posLy[1], g.posLy[2]), quat: galaxyQuat(g, g.posLy), params: null, cloud: null,
        pointRef: { points: this.galaxyPoints, index: i }, pinned: true };
      e.invQuat = e.quat.clone().invert();
      g.entry = e;
      this.galaxies.push(e);
    });
    this.farGalaxies = null;          // HyperLEDA layer, added when it arrives
    // Groups: centroid and extent of their members, from the catalogue.
    const groups = new Map();
    for (const g of list) {
      if (!g.group || /^Near /.test(g.group) || g.group === "—") continue;
      if (!groups.has(g.group)) groups.set(g.group, []);
      groups.get(g.group).push(g);
    }
    groups.get("Local Group") && groups.get("Local Group").push({ posLy: [0, 0, 0], diamKly: 100, name: "Milky Way" });
    this.groups = [];
    for (const [name, members] of groups) {
      if (members.length < 2) continue;
      const c = [0, 0, 0];
      members.forEach((m) => { c[0] += m.posLy[0]; c[1] += m.posLy[1]; c[2] += m.posLy[2]; });
      c.forEach((v, i) => (c[i] = v / members.length));
      let r = 0;
      members.forEach((m) => (r = Math.max(r, Math.hypot(m.posLy[0] - c[0], m.posLy[1] - c[1], m.posLy[2] - c[2]))));
      this.groups.push({ name, members, centerLy: c, upos: UPos.fromLy(...c), radiusLy: Math.max(r, 3e5) });
    }
  }

  // The HyperLEDA layer (~32,600 galaxies), loaded in the background. Points
  // for all of them; full entries only for the ones you get near, found
  // through a coarse spatial grid.
  addFarGalaxies(list) {
    if (this.disposed || !list.length) return;
    this.farGalaxies = { list, points: new GalaxyPoints(list, this.ctx.far, (g) => g.posLy), grid: new Map(), cell: 10e6 };
    list.forEach((g, i) => {
      g.id = "real:galaxy:" + g.name;
      g.pointRef = { points: this.farGalaxies.points, index: i };
      const k = gridKey(g.posLy, this.farGalaxies.cell);
      if (!this.farGalaxies.grid.has(k)) this.farGalaxies.grid.set(k, []);
      this.farGalaxies.grid.get(k).push(g);
    });
  }

    // ── nebulae, clusters, black holes, neutron stars ──
  buildDeepSky() {
    this.deep = this.cat.deep.map((o) => ({ ...o, upos: UPos.fromLy(o.posLy[0], o.posLy[1], o.posLy[2]), cloud: null }));
    // Supermassive black holes at the centres of their host galaxies (catalogue
    // masses: M87* EHT 2019; M31* Bender+ 2005).
    const host = (n) => this.galaxies.find((e) => e.rec.name === n);
    const add = (name, gname, mass, extra, ref) => {
      const e = host(gname);
      if (!e) return;
      this.deep.push({ kind: "blackhole", subtype: "supermassive", real: true, name, aliases: [], upos: e.center.clone(), posLy: e.rec.posLy,
        distLy: e.rec.distLy, sizeLy: 0, extra: Object.assign({ massSun: mass }, extra), ref, seed: hashString(name), hostGalaxy: e.rec.common || e.rec.name });
    };
    add("M87*", "M87", 6.5e9, { disk: "bright", jets: true }, "Event Horizon Telescope Collaboration 2019");
    add("M31*", "M31", 1.4e8, { disk: "faint" }, "Bender et al. 2005");
    const sgr = this.deep.find((o) => o.name === "Sagittarius A*");
    if (sgr) sgr.upos = this.mw.center.clone();
    // Far stand-ins for every deep-sky object.
    const vis = this.deep.filter((o) => o.kind === "nebula" || o.kind === "cluster");
    this.deepPoints = new GalaxyPoints(vis.map((o) => ({
      posLy: o.posLy, lumSun: o.kind === "cluster" && o.subtype === "globular" ? 2e5 * (o.sizeLy / 100) ** 2 : 2000 * (o.sizeLy / 24),
      diamKly: o.sizeLy / 1000 / 0.45, type: o.subtype === "planetary" || o.subtype === "emission" ? "irregular" : "elliptical"
    })), this.ctx.far, (g) => g.posLy);
    vis.forEach((o, i) => (o.pointIndex = i));
    this.deepVis = vis;
    this.compact = [];
  }

  // ── per-frame ──
  update(cam, camQuat, jd, ctx) {
    this.jd = jd;
    this.frame = (this.frame || 0) + 1;
    if (this.advancedJd !== jd) this.updateSolar(jd);
    const days = jd - 2451545;
    const nearList = [];

    // Galaxy containing the camera, if any (cheap test against nearby ones).
    this.current = this.findCurrentGalaxy(cam);

    // Real stars and the solar anchor.
    this.starField.update(SOL, cam, ctx);
    this.galaxyPoints.update(SOL, cam, ctx);
    this.deepPoints.update(SOL, cam, ctx);

    // Solar System bodies.
    const solarDist = Math.hypot(...sub(SOL, cam)) / LY;
    // Always placed (cheap) so distances stay current; meshes only build when visible.
    for (const [, s] of this.solar) {
      s.body.update(cam, ctx, ctx.timeSec);
      nearList.push(s.body);
    }
    const showOrbits = ctx.settings.orbits && solarDist < 0.05 && !ctx.blind;
    for (const o of this.solarOrbits) o.line.update(this.sun.def.pos, cam, ctx, showOrbits);
    this.updateMoonOrbits(cam, ctx, showOrbits);
    for (const b of this.belts) b.belt.update(this.solar.get(b.anchor).def.pos, cam, ctx, days);

    // Streamed stellar sectors in the current galaxy.
    this.updateSectors(cam, ctx);

    // Star systems near the camera (real catalogue or procedural).
    if (this.frame % 8 === 1) this.manageSystems(cam);
    for (const [, sys] of this.systems) this.updateSystem(sys, cam, ctx, days, nearList);

    // Galaxy clouds by level of detail; procedural galaxies far out.
    if (this.frame % 30 === 2) this.manageProcGalaxies(cam);
    if (this.frame % 10 === 5) this.managePromotions(cam, ctx);
    this.updateGalaxyLOD(cam, ctx);
    for (const [, c] of this.procGal) c.points.update(c.anchor, cam, ctx);
    if (this.farGalaxies) this.farGalaxies.points.update(SOL, cam, ctx);

    // Deep sky: clouds near, compact objects as bodies.
    this.updateDeep(cam, ctx, nearList);

    // Planets and moons as points of light when unresolved.
    this.updateBodyPoints(cam, ctx, nearList);
    this.nearBodies = nearList;
  }

  findCurrentGalaxy(cam) {
    let best = null;
    for (const e of this.galaxies) {
      const R = (e.params ? e.params.R : (e.rec.diamKly || 20) * 500) * 1.3;
      const d = sub(e.center, cam);
      const dl = Math.hypot(d[0], d[1], d[2]) / LY;
      if (dl > R) continue;
      if (!e.params) e.params = galaxyParams(e.rec);
      const lp = this.toLocal(e, cam);
      if (insideGalaxy(e.params, lp[0], lp[1], lp[2]) && (!best || dl < best.dl)) best = { e, dl, local: lp };
    }
    return best;
  }
  // Camera (or any UPos) → galaxy-local light-years.
  toLocal(e, p) {
    const d = sub(p, e.center);
    _v3.set(d[0] / LY, d[1] / LY, d[2] / LY).applyQuaternion(e.invQuat);
    return [_v3.x, _v3.y, _v3.z];
  }
  fromLocal(e, l) {
    _v3.set(l[0], l[1], l[2]).applyQuaternion(e.quat);
    return e.center.offset([_v3.x, _v3.y, _v3.z], LY);
  }

  // ── sectors ──
  // Cells load within radius r of the camera — and of where the camera will
  // be a second from now, so fast flight doesn't outrun streaming — but are
  // only released beyond r + 1 (hysteresis), so a boundary never flickers.
  // Each request carries its key; a late answer for a cell no longer wanted
  // is dropped instead of overwriting anything.
  updateSectors(cam, ctx) {
    const cur = this.current;
    const keep = new Set();
    this.pendingJobs = this.pendingCells.size;
    if (cur) {
      const e = cur.e;
      const radii = ctx.quality.sectorRadius;
      const solLocal = e.isMW ? this.toLocal(e, SOL) : null;
      const ahead = this.lookAhead ? this.toLocal(e, this.lookAhead) : null;
      for (let level = 0; level < 3; level++) {
        const L = LEVEL_SIZE[level], r = radii[level];
        const centers = [cur.local];
        if (ahead && Math.hypot(ahead[0] - cur.local[0], ahead[1] - cur.local[1], ahead[2] - cur.local[2]) > L * 0.5) centers.push(ahead);
        for (const c of centers) {
          const cx = Math.floor(c[0] / L), cy = Math.floor(c[1] / L), cz = Math.floor(c[2] / L);
          for (let x = -r - 1; x <= r + 1; x++) for (let y = -r - 1; y <= r + 1; y++) for (let z = -r - 1; z <= r + 1; z++) {
            const key = gkey(e) + "|" + level + ":" + (cx + x) + "," + (cy + y) + "," + (cz + z);
            keep.add(key);
            const inLoad = Math.abs(x) <= r && Math.abs(y) <= r && Math.abs(z) <= r;
            if (!inLoad || this.cells.has(key) || this.pendingCells.has(key) || this.pendingCells.size > 12) continue;
            this.pendingCells.add(key);
            const args = { galaxyParams: e.params, level, cx: cx + x, cy: cy + y, cz: cz + z, galaxyId: e.rec.seed >>> 0, excludeSol: solLocal };
            this.ctx.workers.run("cell", args).then((cell) => {
              this.pendingCells.delete(key);
              if (this.disposed || !this.keepCells || !this.keepCells.has(key) || this.cells.has(key)) return;
              cell.galaxy = e;
              cell.key = key;
              cell.anchor = this.fromLocal(e, cell.origin);
              cell.view = new SectorPoints(cell, this.ctx.far, e.quat);
              cell.fade = (r + 0.5) * L;
              this.cells.set(key, cell);
            }).catch(() => this.pendingCells.delete(key));
          }
        }
      }
    }
    this.keepCells = keep;
    for (const [key, cell] of this.cells) {
      if (!keep.has(key)) { cell.view.dispose(); this.cells.delete(key); continue; }
      cell.view.update(cell.anchor, cam, ctx, cell.fade * 1.4, cell.level > 0 ? this.extinctionFor(cell.galaxy, cam) : null);
    }
  }

  // Star record for a sector star. Its id names the galaxy, level, cell and
  // index, so the same star always comes back as itself.
  sectorStar(cell, i) {
    const e = cell.galaxy;
    const seed = cell.seed[i];
    const prefix = e.isMW ? "SR" : (e.rec.common || e.rec.name).replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "GX";
    const local = [cell.origin[0] + cell.pos[i * 3], cell.origin[1] + cell.pos[i * 3 + 1], cell.origin[2] + cell.pos[i * 3 + 2]];
    const id = "procedural:star:" + gkey(e) + ":" + cell.level + ":" + cell.cx + ":" + cell.cy + ":" + cell.cz + ":" + i;
    return {
      kind: "star", real: false, seed, name: designation(prefix, seed), teff: cell.teff[i], absMag: cell.absMag[i], cls: cell.cls[i],
      galaxy: e, local, upos: this.fromLocal(e, local), key: id, id
    };
  }

    // ── star systems ──
  manageSystems(cam) {
    const ACT = 0.06 * LY, DROP = 0.15 * LY;
    // Nearest candidate stars: catalogue, then streamed cells.
    const cands = [];
    for (const s of this.stars) {
      const d = distUP(s.upos, cam);
      if (d < ACT) cands.push({ rec: s, d, key: starKey(s) });
    }
    for (const [, cell] of this.cells) {
      if (cell.level > 1) {
        // Large cells: test only the few bright stars quickly.
      }
      const lc = this.toLocal(cell.galaxy, cam);
      const ox = cell.origin[0], oy = cell.origin[1], oz = cell.origin[2];
      const P = cell.pos;
      const lim = ACT / LY;
      for (let i = 0; i < cell.absMag.length; i++) {
        const dx = ox + P[i * 3] - lc[0], dy = oy + P[i * 3 + 1] - lc[1], dz = oz + P[i * 3 + 2] - lc[2];
        if (Math.abs(dx) > lim || Math.abs(dy) > lim || Math.abs(dz) > lim) continue;
        const d = Math.hypot(dx, dy, dz) * LY;
        if (d < ACT) { const rec = this.sectorStar(cell, i); cands.push({ rec, d, key: rec.key }); }
      }
    }
    for (const c of cands) if (!this.systems.has(c.key)) this.activateSystem(c.key, c.rec);
    for (const [key, sys] of this.systems) {
      if (!sys.pinned && distUP(sys.anchor, cam) > DROP) this.deactivateSystem(key);
    }
  }

  activateSystem(key, rec) {
    const nearCtx = this.ctx.nearCtx;
    const sys = { key, rec, anchor: rec.upos.clone(), bodies: [], orbits: [], planets: [], belts: [], real: rec.real };
    let starProps;
    if (rec.real) {
      starProps = { name: rec.name || rec.desig, teff: rec.teff, lumSun: rec.lumSun, radiusSun: rec.radiusSun || 1, massSun: rec.massSun || 1, seed: rec.seed };
    } else {
      starProps = proceduralStar(rec);
      rec.props = starProps;
    }
    sys.star = starProps;
    const starBody = new Body({ id: key + ":star", name: starProps.name, kind: "star", radius: (starProps.radiusSun || 1) * R_SUN,
      teff: starProps.teff, lumSun: starProps.lumSun, seed: starProps.seed, pos: rec.upos.clone(), real: rec.real }, nearCtx);
    sys.starBody = starBody;
    sys.bodies.push(starBody);
    // System content.
    let content = null;
    if (rec.real && rec.exoHost) content = interpretExoSystem(rec.exoHost, rec.exoHost.planetList);
    else if (!rec.real) content = generateSystem(rec);
    sys.content = content;
    if (content) {
      // Orbital plane of the system.
      const prng = new Rng(hashInts(starProps.seed, 9));
      const tilt = (content.planeTiltDeg !== undefined ? content.planeTiltDeg : prng.range(0, 60)) * DEG;
      const node = (content.planeNodeDeg !== undefined ? content.planeNodeDeg : prng.range(0, 360)) * DEG;
      sys.planeQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt, node, 0, "YXZ"));
      for (const c of content.companions || []) {
        const b = new Body({ id: key + ":" + c.name, name: c.name, kind: "star", radius: c.radiusSun * R_SUN, teff: c.teff, lumSun: c.lumSun,
          seed: c.seed, pos: rec.upos.clone(), real: false }, nearCtx);
        b.orbit = c; sys.bodies.push(b); sys.companion = b;
        sys.orbits.push({ line: new OrbitLine(ellipse(c.aAU * AU, c.ecc, 0, 0, 0, sys.planeQuat), this.ctx.far, 0xb08a6a), anchor: () => sys.anchor });
      }
      for (const p of content.planets) {
        const look = lookFromGenerated(p.look);
        const b = new Body({ id: key + ":" + p.name, name: p.name, kind: "planet", radius: p.radiusKm * KM, look, atmosphere: p.atmosphere,
          rings: p.rings, seed: p.seed, pos: rec.upos.clone(), real: !!p.real, reliefKm: p.look.reliefKm,
          surfaceEntry: syntheticEntry(p.name, p.gas, p.radiusKm, p.massEarth, p.teqK, p.atmosphere, !!p.real) }, nearCtx);
        b.planet = p; b.system = sys;
        const pq = new THREE.Quaternion().setFromAxisAngle(_X, (p.tiltDeg || 0) * DEG).premultiply(sys.planeQuat);
        b.baseQuat = pq;
        sys.bodies.push(b); sys.planets.push(b);
        sys.orbits.push({ line: new OrbitLine(ellipse(p.aAU * AU, p.ecc, p.incDeg * DEG, p.nodeDeg * DEG, p.argPeriDeg * DEG, sys.planeQuat), this.ctx.far, p.real ? 0x7fb0d0 : 0x8a90b0), anchor: () => sys.anchor });
        for (const m of p.moons || []) {
          const mb = new Body({ id: key + ":" + m.name, name: m.name, kind: "moon", radius: m.radiusKm * KM, look: lookFromGenerated(m.look),
            atmosphere: m.atmosphere, seed: m.seed, pos: rec.upos.clone(), real: false,
            surfaceEntry: syntheticEntry(m.name, false, m.radiusKm, m.massEarth, m.teqK, m.atmosphere, false) }, nearCtx);
          mb.moon = m; mb.parentBody = b; mb.system = sys;
          sys.bodies.push(mb);
          sys.orbits.push({ line: new OrbitLine(ellipse(m.aKm * KM, m.ecc, m.incDeg * DEG, m.nodeDeg * DEG, 0, pq), this.ctx.far, 0x7a7f96), anchor: () => b.pos, small: true });
        }
      }
      for (const bl of content.belts || []) {
        sys.belts.push(new Belt({ count: Math.round(this.ctx.quality.mwParticles * 0.02), inner: bl.innerAU, outer: bl.outerAU, ecc: 0.08, incl: 6,
          massSun: starProps.massSun, quat: sys.planeQuat }, this.ctx.far, new Rng(bl.seed)));
      }
    }
    this.systems.set(key, sys);
    if (!rec.real) this.ctx.onDiscover(sys, this.recordDiscovery(sys));
  }

  deactivateSystem(key) {
    const sys = this.systems.get(key);
    sys.bodies.forEach((b) => b.dispose());
    sys.orbits.forEach((o) => o.line.dispose());
    sys.belts.forEach((b) => b.dispose());
    this.systems.delete(key);
  }

  // Move every body to time jd — before navigation, so anything resting on
  // or following a body sees its position for this frame, not the last one
  // (Earth alone moves ~500 m per frame along its orbit).
  advance(jd) {
    this.updateSolar(jd);
    const days = jd - 2451545;
    for (const [, sys] of this.systems) this.advanceSystem(sys, days);
    this.advancedJd = jd;
  }
  advanceSystem(sys, days) {
    if (sys.advancedDays === days) return;
    sys.advancedDays = days;
    const starPos = sys.anchor;
    sys.starBody.pos.set(starPos);
    if (sys.companion) {
      const c = sys.companion.orbit;
      const M = c.phase + (2 * Math.PI * days) / c.periodDays;
      const p = keplerPos(c.aAU * AU, c.ecc, 0, 0, 0, M, sys.planeQuat);
      sys.companion.pos.set(starPos).add(p[0], p[1], p[2]);
    }
    for (const b of sys.bodies) {
      if (b.planet) {
        const p = b.planet;
        const M = p.phase + (2 * Math.PI * days) / p.periodDays;
        const v = keplerPos(p.aAU * AU, p.ecc, p.incDeg * DEG, p.nodeDeg * DEG, p.argPeriDeg * DEG, M, sys.planeQuat);
        b.pos.set(starPos).add(v[0], v[1], v[2]);
        const spin = p.tidallyLocked ? Math.atan2(-v[2], -v[0]) : ((days * 24) / (p.dayHours || 24)) * Math.PI * 2;
        b.quat.copy(b.baseQuat).multiply(_q.setFromAxisAngle(_Y, spin));
      }
    }
    for (const b of sys.bodies) {
      if (b.moon) {
        const m = b.moon;
        const M = m.phase + (2 * Math.PI * days) / m.periodDays;
        const v = keplerPos(m.aKm * KM, m.ecc, m.incDeg * DEG, m.nodeDeg * DEG, 0, M, b.parentBody.baseQuat);
        b.pos.set(b.parentBody.pos).add(v[0], v[1], v[2]);
        const x = norm3([-v[0], -v[1], -v[2]]);
        const y = [0, 1, 0];
        _v3.set(...y).applyQuaternion(b.parentBody.baseQuat);
        const yy = norm3(sub3([_v3.x, _v3.y, _v3.z], scale3(x, dot3([_v3.x, _v3.y, _v3.z], x))));
        b.quat.copy(quatFromBasis(x, yy));
      }
    }
  }

  updateSystem(sys, cam, ctx, days, nearList) {
    const starPos = sys.anchor;
    this.advanceSystem(sys, days);
    // Lighting: primary star, plus the companion as a second light.
    for (const b of sys.bodies) {
      if (b.def.kind === "star") continue;
      const r1 = sub(starPos, b.pos);
      b.lightDir.set(r1[0], r1[1], r1[2]).normalize();
      b.lightCol.copy(colorVec(sys.star.teff));
      if (sys.companion) {
        const r2 = sub(sys.companion.pos, b.pos);
        const k = Math.min(1, (sys.companion.def.lumSun / Math.max(1e-6, sys.star.lumSun)) * Math.pow(Math.hypot(...r1) / Math.max(1, Math.hypot(...r2)), 2));
        b.light2Dir.set(r2[0], r2[1], r2[2]).normalize();
        b.light2Col.copy(colorVec(sys.companion.def.teff)).multiplyScalar(k);
      }
    }
    for (const b of sys.bodies) { b.update(cam, ctx, ctx.timeSec); nearList.push(b); }
    const show = ctx.settings.orbits && !ctx.blind;
    for (const o of sys.orbits) o.line.update(o.anchor(), cam, ctx, show);
    for (const bl of sys.belts) bl.update(starPos, cam, ctx, days);
    // The star's own catalogue point would sit on top of its disc.
    if (sys.starBody.screenR > 1.5) {
      const r = sub(starPos, cam);
      ctx.hideStar.set(r[0] / LY, r[1] / LY, r[2] / LY, 1e-6);
    }
  }

  updateMoonOrbits(cam, ctx, show) {
    for (const [id, s] of this.solar) {
      if (s.data.kind !== "moon" || !s.data.moon) continue;
      let o = this.moonOrbits.get(id);
      if (!o) {
        const b = s.data;
        const parent = this.solar.get(b.parent);
        const T = (this.jd - 2451545) / 36525;
        const ppole = parent.data.spin ? poleOf(parent.data.spin, T) : [0, 1, 0];
        const pts = [];
        const P = Math.abs(b.moon[1]);
        for (let k = 0; k <= 128; k++) {
          if (b.lunarTheory) {
            const v = eclToRender(moonGeocentric(T + (k / 128) * (P / 36525)));
            pts.push(v);
          } else pts.push(moonOffset(b, ppole, this.jd + (k / 128) * P).pos);
        }
        o = new OrbitLine(pts, this.ctx.far, 0x7a7f96);
        this.moonOrbits.set(id, o);
      }
      // Only the moons of the planet you're near.
      const ppos = this.solar.get(s.data.parent).def.pos;
      o.update(ppos, cam, ctx, show && distUP(ppos, cam) < o.radius * 6);
    }
  }

  // ── galaxy clouds ──
  // Tiers: soft point (always there) → small particle cloud → full cloud →
  // inside: full cloud as a backdrop with nearby particles handed over to
  // streamed sector stars. A tier is only removed once the next is drawn: the
  // point stays lit until its cloud has faded fully in, and a cloud is only
  // swapped for a denser one when the denser one has arrived.
  updateGalaxyLOD(cam, ctx) {
    const q = ctx.quality;
    const cands = [];
    for (const e of this.galaxies) {
      const d = distUP(e.center, cam) / LY;
      const R = (e.rec.diamKly || 20) * 500;
      const px = (R / Math.max(d, R)) * ctx.pxPerRad;
      e.px = px; e.distLy = d;
      const isInside = this.current && this.current.e === e;
      if (px > 4 || isInside || e.travelTarget) cands.push(e);
      else if (e.cloud && px < 2.5) this.dropCloud(e);
    }
    cands.sort((a, b) => b.px - a.px);
    const maxBig = 5, maxSmall = 28;
    cands.forEach((e, i) => {
      const isInside = this.current && this.current.e === e;
      const big = e.isMW || isInside || e.travelTarget || (i < maxBig && e.px > 100);
      if (i >= maxSmall && !big) { if (e.cloud) this.dropCloud(e); return; }
      const count = e.isMW ? q.mwParticles : big ? q.galaxyParticles : Math.min(6000, q.galaxyParticles);
      if ((!e.cloud || e.cloudCount < count) && !e.loadingCloud) this.requestCloud(e, count);
      e.lod = isInside ? 4 : !e.cloud ? 0 : e.cloudCount >= q.galaxyParticles ? (e.px > 600 ? 3 : 2) : 1;
      if (!e.cloud) return;
      const frac = isInside ? 1 : Math.min(1, Math.max(0.05, (e.px * e.px) / (e.cloudCount * 0.8)));
      // Fade the cloud in over the point; only then let the point go dark.
      e.fadeIn = Math.min(1, (e.fadeIn || 0) + 0.04);
      const alpha = isInside ? 1 : Math.min(e.fadeIn, Math.max(0, (e.px - 4) / 16));
      // Inside: hand nearby particles to sector stars. Just outside, in the halo:
      // fade the few particles that would otherwise loom as huge blobs.
      const R = (e.rec.diamKly || 20) * 500;
      const fadeNear = isInside ? 1500 : e.distLy < R * 2 ? R * 0.2 : 0;
      e.cloud.update(e.center, cam, ctx, frac, alpha, fadeNear, isInside ? 0.15 : 0.6, this.extinctionFor(e, cam));
      // Dark adaptation is for the faint and far: it tapers off as a galaxy
      // fills the view (full strength at the point→cloud handoff, so no jump).
      const full = ctx.darkAdapt || 1, floor = Math.min(full, 5);
      const adapt = floor + (full - floor) * Math.min(1, Math.max(0, 1 - (e.px - 20) / 380));
      e.cloud.mat.uniforms.uExposure.value = (ctx.galaxyExposureBase || 1) * adapt;
      if (ctx.debugLod) e.cloud.mat.uniforms.uTint.value.set(...LOD_COLORS[e.lod]);
      else e.cloud.mat.uniforms.uTint.value.set(1, 1, 1);
      setPoint(e, alpha < 0.98);
    });
  }
  // Dust model for a galaxy, seen from the camera (null if it has no dust).
  extinctionFor(e, cam) {
    const p = e.params || (e.params = galaxyParams(e.rec));
    if (!p.dust) return null;
    return { camLocal: this.toLocal(e, cam), kappa: 2.2e-4 * (p.dust / 0.22) * (50000 / p.R), h: Math.max(60, 480 * p.R / 50000), R: p.R };
  }
  requestCloud(e, count) {
    e.loadingCloud = true;
    const token = (e.cloudToken = (e.cloudToken || 0) + 1);
    if (!e.params) e.params = galaxyParams(e.rec);
    this.cloudJobs = (this.cloudJobs || 0) + 1;
    this.ctx.workers.run("cloud", { params: e.params, count }).then((data) => {
      this.cloudJobs--;
      e.loadingCloud = false;
      // A late answer for a cloud that has since been dropped or superseded is discarded.
      if (this.disposed || token !== e.cloudToken || e.removed) return;
      if (e.cloud) e.cloud.dispose();
      else e.fadeIn = 0;
      e.cloud = new GalaxyCloud(data, this.ctx.far, { quat: e.quat });
      e.cloudCount = count;
    }).catch(() => { this.cloudJobs--; e.loadingCloud = false; });
  }
  dropCloud(e) {
    e.cloudToken = (e.cloudToken || 0) + 1;
    e.loadingCloud = false;
    if (e.cloud) e.cloud.dispose();
    e.cloud = null; e.cloudCount = 0; e.fadeIn = 0; e.lod = 0;
    setPoint(e, true);
  }

  // ── procedural galaxies: cells of 30 Mly (all) and 300 Mly (bright only) ──
  // Beyond the catalogue's reach (~40 Mly) the universe is filled from a seed.
  // Density follows a cosmic-web noise so galaxies gather into sheets,
  // filaments and clusters with voids between them. Cells release with one
  // cell of hysteresis.
  manageProcGalaxies(cam) {
    const camLy = cam.toLy();
    const keep = new Set();
    const levels = [{ L: 30e6, r: this.ctx.quality.procGalaxyCells, n: 22, minR: 40e6 }, { L: 300e6, r: 2, n: 14, minR: 180e6 }];
    levels.forEach((lv, li) => {
      const cx = Math.floor(camLy[0] / lv.L), cy = Math.floor(camLy[1] / lv.L), cz = Math.floor(camLy[2] / lv.L);
      for (let x = -lv.r - 1; x <= lv.r + 1; x++) for (let y = -lv.r - 1; y <= lv.r + 1; y++) for (let z = -lv.r - 1; z <= lv.r + 1; z++) {
        const key = li + ":" + (cx + x) + "," + (cy + y) + "," + (cz + z);
        keep.add(key);
        if (this.procGal.has(key) || Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) > lv.r) continue;
        const cell = makeGalaxyCell(li, cx + x, cy + y, cz + z, lv);
        cell.points = new GalaxyPoints(cell.list, this.ctx.far, (g) => g.localLy);
        cell.anchor = UPos.fromLy((cx + x) * lv.L, (cy + y) * lv.L, (cz + z) * lv.L);
        cell.list.forEach((g, i) => {
          g.upos = cell.anchor.offset(g.localLy, LY);
          g.id = "procedural:galaxy:" + li + ":" + (cx + x) + ":" + (cy + y) + ":" + (cz + z) + ":" + i;
          g.pointRef = { points: cell.points, index: i };
        });
        this.procGal.set(key, cell);
      }
    });
    for (const [key, cell] of this.procGal) {
      if (keep.has(key)) continue;
      if (cell.list.some((g) => g.entry && (g.entry.travelTarget || (this.current && this.current.e === g.entry)))) continue;
      cell.points.dispose();
      for (const g of cell.list) if (g.entry) this.demote(g.entry);
      this.procGal.delete(key);
    }
  }

  // Any galaxy record (catalogue, HyperLEDA or procedural) → its full entry.
  promoteGalaxy(g) {
    if (g.entry) return g.entry;
    const center = g.upos || UPos.fromLy(g.posLy[0], g.posLy[1], g.posLy[2]);
    const quat = g.quat || galaxyQuat(g, g.posLy);
    const e = { rec: g, center, quat, params: null, cloud: null, procedural: !g.real, pointRef: g.pointRef };
    e.invQuat = e.quat.clone().invert();
    g.entry = e;
    this.galaxies.push(e);
    return e;
  }
  demote(e) {
    if (e.pinned) return;
    e.removed = true;
    if (e.cloud) this.dropCloud(e);
    const i = this.galaxies.indexOf(e);
    if (i >= 0) this.galaxies.splice(i, 1);
    e.rec.entry = null;
  }
  // Galaxies you are getting near become entries before they need a cloud;
  // they're released again (with hysteresis) once well out of range.
  managePromotions(cam, ctx) {
    const near = (g, posLy) => {
      const d = distUP(g.upos || (g.upos = UPos.fromLy(posLy[0], posLy[1], posLy[2])), cam) / LY;
      const R = (g.diamKly || 20) * 500;
      return (R / Math.max(d, R)) * ctx.pxPerRad;
    };
    const consider = (g, posLy) => {
      const px = near(g, posLy);
      if (px > 3 && !g.entry) this.promoteGalaxy(g);
      else if (g.entry && px < 1.5 && !g.entry.travelTarget && !(this.current && this.current.e === g.entry)) this.demote(g.entry);
    };
    if (this.farGalaxies) {
      const F = this.farGalaxies, camLy = cam.toLy();
      const cx = Math.floor(camLy[0] / F.cell), cy = Math.floor(camLy[1] / F.cell), cz = Math.floor(camLy[2] / F.cell);
      for (let x = -2; x <= 2; x++) for (let y = -2; y <= 2; y++) for (let z = -2; z <= 2; z++) {
        for (const g of F.grid.get((cx + x) + "," + (cy + y) + "," + (cz + z)) || []) consider(g, g.posLy);
      }
      for (const e of this.galaxies.slice()) if (e.rec.far) consider(e.rec, e.rec.posLy);
    }
    for (const [, cell] of this.procGal) for (const g of cell.list) consider(g, null);
  }

  // Get ahead of a trip: the destination's representation starts loading the
  // moment travel begins, and isn't released until you've arrived and left.
  preload(t) {
    if (this.travelPin) this.unpin(this.travelPin);
    this.travelPin = t;
    if (t.entry) {
      t.entry.travelTarget = true;
      if (!t.entry.params) t.entry.params = galaxyParams(t.entry.rec);
      // Only ever upgrade: never replace a denser cloud with a lighter one.
      const want = t.entry.isMW ? this.ctx.quality.mwParticles : this.ctx.quality.galaxyParticles;
      if ((t.entry.cloudCount || 0) < want && !t.entry.loadingCloud) this.requestCloud(t.entry, want);
    }
    const starRec = t.kind === "star" && t.rec ? t.rec : t.exo ? t.exo.host.star : t.sysKey && t.starRec ? t.starRec : null;
    if (starRec) {
      const key = starRec.real ? starKey(starRec) : starRec.key;
      if (!this.systems.has(key)) this.activateSystem(key, starRec);
      this.systems.get(key).pinned = true;
      t.pinnedSystem = key;
    }
    if (t.body && !t.body.group) t.body.build();
  }
  unpin(t) {
    if (t.entry) t.entry.travelTarget = false;
    if (t.pinnedSystem && this.systems.has(t.pinnedSystem)) this.systems.get(t.pinnedSystem).pinned = false;
    if (this.travelPin === t) this.travelPin = null;
  }

    // ── deep sky ──
  updateDeep(cam, ctx, nearList) {
    for (const o of this.deepVis) {
      const d = distUP(o.upos, cam) / LY;
      const R = Math.max(0.2, o.sizeLy / 2);
      const px = (R / Math.max(d, R)) * ctx.pxPerRad;
      o.px = px;
      if (px > 8) {
        if (!o.cloud) {
          const budget = o.kind === "cluster" && o.subtype === "globular" ? Math.round(ctx.quality.nebulaParticles * 4) : ctx.quality.nebulaParticles;
          o.cloud = new GalaxyCloud(generateDeep(o, budget), this.ctx.far, { hard: o.kind === "cluster" });
          o.cloud.count = o.cloud.geo.attributes.aLum.count;
        }
        const alpha = Math.min(1, (px - 8) / 20);
        o.cloud.update(o.upos, cam, ctx, 1, alpha, d < R * 1.5 ? R * 0.15 : 0);
        o.cloud.mat.uniforms.uExposure.value = ctx.starExposure;
        this.deepPoints.setHidden(o.pointIndex, alpha >= 0.99, null);
      } else if (o.cloud && px < 4) {
        o.cloud.dispose(); o.cloud = null;
        this.deepPoints.setHidden(o.pointIndex, false, o.kind === "cluster" && o.subtype === "globular" ? 2e5 * (o.sizeLy / 100) ** 2 : 2000 * (o.sizeLy / 24));
      }
    }
    // Black holes and neutron stars become bodies when close.
    for (const o of this.deep) {
      if (o.kind !== "blackhole" && o.kind !== "neutronstar") continue;
      const d = distUP(o.upos, cam);
      const R = compactRadius(o);
      const near = d < Math.max(R * 4e5, 0.02 * LY);
      if (near && !o.body) {
        o.body = new Body({ id: "deep:" + o.name, name: o.name, kind: o.kind, subtype: o.subtype, radius: R, pos: o.upos.clone(), real: true,
          disk: o.extra.disk || (o.kind === "blackhole" ? "bright" : null), jets: o.extra.jets, seed: o.seed }, this.ctx.nearCtx);
        o.body.quat.setFromAxisAngle(_X, 0.35);
      }
      if (!near && o.body && d > Math.max(R * 8e5, 0.04 * LY)) { o.body.dispose(); o.body = null; }
      if (o.body) { o.body.update(cam, ctx, ctx.timeSec); nearList.push(o.body); }
    }
  }

  updateBodyPoints(cam, ctx, nearList) {
    const items = this.bodyPointItems;
    items.length = 0;
    const add = (body, starPos, starLum, tint, albedo) => {
      if (body.def.kind === "star" || body.def.kind === "blackhole" || body.def.kind === "neutronstar") return;
      const rel = body.rel;
      const dObs = body.dist;
      const toStar = sub(starPos, body.pos);
      const r = Math.hypot(toStar[0], toStar[1], toStar[2]) || 1;
      const cosA = -(rel[0] * toStar[0] + rel[1] * toStar[1] + rel[2] * toStar[2]) / (dObs * r || 1);
      const phase = Math.max(0.02, (1 + cosA) / 2);
      let lum = starLum * albedo * Math.pow(body.radius / r, 2) / 4 * phase;
      if (body.def.kind === "comet" && body.def.helioDistAU < 5) lum *= 1e6 / Math.pow(body.def.helioDistAU, 4);
      // Fade out only as the drawn disc takes over (not while its maps load).
      if (body.group && body.group.visible) lum *= Math.max(0, 1 - (body.screenR - 1) / 3);
      // An eye adapted to a nearby sunlit world doesn't see its moons blaze:
      // cap points at about magnitude −1.
      const dpc = Math.max(dObs, 1) / 3.0857e16;
      lum = Math.min(lum, Math.pow(10, (4.83 - 5 + 5 * Math.log10(dpc) + 1) / 2.5));
      if (lum <= 0) return;
      items.push({ rel: [rel[0], rel[1], rel[2]], lum, color: tint });
    };
    for (const [id, s] of this.solar) {
      add(s.body, this.sun.def.pos, 1, MAP_TINT[id] || [0.85, 0.82, 0.78], s.data.albedo || 0.3);
    }
    for (const [, sys] of this.systems) {
      for (const b of sys.bodies) {
        const c = b.def.look && b.def.look.c1 ? b.def.look.c1 : [0.8, 0.8, 0.8];
        add(b, sys.anchor, sys.star.lumSun || 1, c, b.planet ? b.planet.albedo || 0.3 : 0.25);
      }
    }
    this.bodyPoints.set(items, ctx);
  }

  // ── what the camera is near ──
  // Nearest surface (metres) among loaded bodies, and that body. Drives the
  // automatic speed scale.
  // The surface below a position, measured from that position (not the
  // camera) against the body's real shape: reference ellipsoid + elevation.
  // Gas and ice giants have no floor at their cloud tops — the floor is the
  // simulation's pressure limit far below; `alt` is still measured from the
  // 1-bar level so the HUD reads sensibly.
  nearestSurface(cam, bodiesOnly) {
    let best = Infinity, which = null, info = null;
    for (const b of this.nearBodies) {
      const k = b.def.kind;
      const d = distUP(b.pos, cam);
      if (d - b.radius * 1.02 > best) continue;
      let ground = b.radius * (k === "blackhole" ? 1.2 : 1), gi = null;
      const e = b.def.surfaceEntry;
      const solidKind = k === "planet" || k === "moon" || k === "dwarf" || k === "asteroid" || k === "comet";
      const gas = e && e.surfaceType && e.surfaceType !== "solid";
      if (solidKind && !gas && d < b.radius * 4) { gi = b.groundAt(cam); ground = gi.ground; }
      // A giant's "surface" is its oblate 1-bar level (Saturn's is ~10% flatter
      // at the poles); the simulation's floor lies depthLimit below it.
      let oneBar = b.radius;
      if (gas && b.getSurface) {
        const l = toLocal(b.quat, sub(cam, b.pos));
        oneBar = b.getSurface().baseRadius(l.x, l.y, l.z);
        ground = oneBar - (e.depthLimitMeters || 0);
      }
      const floorDist = d - ground;
      if (floorDist < best) {
        best = floorDist; which = b;
        const rel = sub(cam, b.pos);
        info = { up: gi ? gi.up : [rel[0] / d, rel[1] / d, rel[2] / d], ground, r: d, dir: gi ? gi.dir : null, water: gi ? gi.water : false,
          alt: gas ? d - oneBar : floorDist, gas: !!gas, entry: e || null };
      }
    }
    if (bodiesOnly) return Object.assign({ dist: best, body: which, scale: best }, info || {});
    // Stars in loaded cells / the catalogue, as obstacles at interstellar scale.
    const camLy = null;
    let starD = Infinity;
    for (const s of this.stars) {
      const d = distUP(s.upos, cam);
      if (d < starD) starD = d;
    }
    for (const [, cell] of this.cells) {
      if (cell.level !== 0) continue;
      const lc = this.toLocal(cell.galaxy, cam);
      const P = cell.pos;
      for (let i = 0; i < cell.absMag.length; i++) {
        const d = Math.hypot(cell.origin[0] + P[i * 3] - lc[0], cell.origin[1] + P[i * 3 + 1] - lc[1], cell.origin[2] + P[i * 3 + 2] - lc[2]) * LY;
        if (d < starD) starD = d;
      }
    }
    let galD = Infinity;
    for (const e of this.galaxies) {
      const R = (e.rec.diamKly || 20) * 500 * LY;
      const d = distUP(e.center, cam) - R;
      if (d < galD) galD = d;
    }
    const inGalaxy = !!this.current;
    const scale = Math.min(best, inGalaxy ? Math.max(starD * 0.5, 1e9) : Infinity, inGalaxy ? Infinity : Math.max(galD, 1e18));
    const sc = which && info && info.gas ? Math.max(1000, Math.abs(info.alt)) : best;
    const scale2 = Math.min(sc, inGalaxy ? Math.max(starD * 0.5, 1e9) : Infinity, inGalaxy ? Infinity : Math.max(galD, 1e18));
    return Object.assign({ dist: best, body: which, scale: isFinite(scale2) ? scale2 : 1e20, starD, galD }, info || {});
  }

  // ── where am I ──
  location(cam) {
    const lines = [];
    const cur = this.current;
    let group = null;
    for (const g of this.groups) if (distUP(g.upos, cam) < g.radiusLy * LY * 1.2) { group = g; break; }
    if (cur) {
      const e = cur.e;
      lines.push(e.rec.common || e.rec.name);
      if (e.isMW) {
        const [x, y, z] = cur.local;
        const r = Math.hypot(x, z);
        const solD = distUP(SOL, cam) / LY;
        if (solD < 300) lines.push("Orion Spur · Local Bubble");
        else if (r < 6000 && Math.abs(y) < 3000) lines.push("Galactic bulge");
        else if (Math.abs(y) > 3000) lines.push("Galactic halo");
        else {
          const na = nearestArm(e.params, r, Math.atan2(-z, x));
          lines.push(na.d < 0.12 && na.arm ? na.arm.name : "Inter-arm region");
        }
      } else {
        const lc = cur.local;
        lines.push("Sector " + designation("", hashInts(Math.floor(lc[0] / 1000), Math.floor(lc[1] / 1000), Math.floor(lc[2] / 1000))).slice(1));
      }
    } else {
      if (group) lines.push(group.name);
      let near = null, nd = Infinity;
      for (const e of this.galaxies) { if (e.distLy < nd) { nd = e.distLy; near = e; } }
      lines.push(near ? "Intergalactic space · " + fmtDistance(nd * LY) + " from " + (near.rec.common || near.rec.name) : "Intergalactic space");
    }
    // Star system and body.
    let sys = null, sd = Infinity;
    const solD = distUP(SOL, cam);
    if (solD < 0.05 * LY) { sys = "Sol System"; sd = solD; }
    for (const [, s] of this.systems) { const d = distUP(s.anchor, cam); if (d < sd && d < 0.05 * LY) { sd = d; sys = s.star.name + " System"; } }
    if (sys) lines.push(sys);
    let bb = null, bd = Infinity;
    for (const b of this.nearBodies) {
      if (b.dist < b.radius * 30 && b.dist - b.radius < bd) { bd = b.dist - b.radius; bb = b; }
    }
    if (bb) {
      const k = bb.def.kind;
      // Height above the reference shape under the camera (sea level on Earth,
      // the oblate 1-bar level on a giant), not above the equatorial radius.
      let alt = bb.dist - bb.radius;
      if (k !== "star" && bb.getSurface && bb.dist < bb.radius * 4) {
        const l = toLocal(bb.quat, sub(cam, bb.pos));
        alt = l.r - bb.getSurface().baseRadius(l.x, l.y, l.z);
      }
      const e = bb.def.surfaceEntry;
      const solid = !e || e.surfaceType === "solid";
      // Only a real atmosphere (a surface pressure), not a plume or exosphere shell.
      const atmoH = bb.atmoRa && (!solid || (e && e.atmosphere && e.atmosphere.pressureBar)) ? (bb.atmoRa - 1) * bb.radius : 0;
      const agl = solid && bb.groundAt && k !== "star" ? bb.groundAt(cam).alt : bb.dist - bb.radius;
      const label = k === "star" ? "Stellar vicinity" : !solid && alt < 0 ? "Inside the atmosphere · " + fmtDistance(-alt) + " below cloud tops"
        : solid && agl < 2500 ? "Surface · " + fmtDistance(Math.max(0, agl)) + " up"
        : (solid ? agl : alt) < atmoH ? "Atmosphere · " + fmtDistance(solid ? agl : alt) + " altitude" : alt < bb.radius * 0.05 ? "Low orbit" : "Orbit";
      lines.push(bb.def.name + " · " + label);
    } else if (!sys && !cur && !group) lines.push("Deep space");
    return lines;
  }

  dispose() {
    this.disposed = true;
    for (const [, s] of this.solar) s.body.dispose();
    for (const [k] of this.systems) this.deactivateSystem(k);
    for (const [, c] of this.cells) c.view.dispose();
    for (const e of this.galaxies) if (e.cloud) e.cloud.dispose();
    for (const [, c] of this.procGal) c.points.dispose();
    if (this.farGalaxies) this.farGalaxies.points.dispose();
    for (const o of this.deep) { if (o.cloud) o.cloud.dispose(); if (o.body) o.body.dispose(); }
    this.solarOrbits.forEach((o) => o.line.dispose());
    this.moonOrbits.forEach((o) => o.dispose());
    this.belts.forEach((b) => b.belt.dispose());
    this.starField.dispose(); this.galaxyPoints.dispose(); this.deepPoints.dispose(); this.bodyPoints.dispose();
    disposeSharedBodyResources();
  }

  // ── discoveries (procedural systems visited; stored locally) ──
  recordDiscovery(sys) {
    const id = sys.key;
    const first = !this.discovered.has(id);
    const r = sys.rec;
    const entry = this.discovered.get(id) || { id, name: sys.star.name, seed: r.seed, teff: r.teff, absMag: r.absMag, cls: r.cls,
      galaxy: r.galaxy.isMW ? "mw" : r.galaxy.rec.name, local: r.local, planets: sys.content ? sys.content.planets.length : 0, customName: null };
    this.discovered.set(id, entry);
    saveDiscoveries(this.discovered);
    return first;
  }
  renameDiscovery(id, name) {
    const e = this.discovered.get(id);
    if (!e) return;
    e.customName = name || null;
    saveDiscoveries(this.discovered);
  }
  // Rebuild a discovered star as a target from its stored record.
  discoveredStar(entry) {
    const e = entry.galaxy === "mw" ? this.mw : this.galaxies.find((g) => g.rec.name === entry.galaxy);
    if (!e) return null;
    if (!e.params) e.params = galaxyParams(e.rec);
    return { kind: "star", real: false, seed: entry.seed, name: entry.name, teff: entry.teff, absMag: entry.absMag, cls: entry.cls,
      galaxy: e, local: entry.local, upos: this.fromLocal(e, entry.local), key: entry.id, id: entry.id };
  }
}

// ── helpers ──
// A surface entry for a generated (or catalogue exoplanet) body.
function syntheticEntry(name, gas, radiusKm, massEarth, teqK, atmo, real) {
  const R = radiusKm * 1000, M = (massEarth || 0) * 5.972e24;
  return {
    id: name, name, radiusMeters: R, gravity: M ? +(6.674e-11 * M / (R * R)).toPrecision(3) : null, gravityEstimated: true,
    surfaceType: gas ? "gas-giant" : "solid", landable: !gas, walkable: !gas, explorationMode: gas ? "atmospheric-flight" : "surface",
    depthLimitMeters: gas ? 120000 : null,
    atmosphere: { pressureBar: atmo ? +(atmo.density || 0).toFixed(2) : 0, breathable: false, note: atmo ? atmo.kind : null },
    temperatureK: teqK || null,
    terrain: gas ? { mode: "none", label: "No solid surface" } : { mode: "procedural", label: real ? "REAL EXOPLANET · SURFACE VISUALIZATION: PROCEDURAL INTERPRETATION" : "PROCEDURAL INTERPRETATION" },
    imagery: "Procedural", generated: true
  };
}
function gkey(e) { return e.isMW ? "mw" : String(e.rec.seed); }
export function starKey(s) { return "real:star:" + (s.hip ? "HIP" + s.hip : s.desig); }
function gridKey(p, c) { return Math.floor(p[0] / c) + "," + Math.floor(p[1] / c) + "," + Math.floor(p[2] / c); }
// A galaxy's point stand-in stays lit until its cloud has fully faded in.
function setPoint(e, lit) {
  if (!e.pointRef) return;
  e.pointRef.points.setHidden(e.pointRef.index, !lit, e.rec.lumSun);
}
// Debug colours per level of detail: point, small cloud, full cloud, close, inside.
export const LOD_COLORS = [[1, 0.25, 0.25], [1, 0.85, 0.2], [0.3, 1, 0.35], [0.3, 0.8, 1], [0.8, 0.4, 1]];
function distUP(a, b) { const d = sub(a, b); return Math.hypot(d[0], d[1], d[2]); }
function norm3(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
function sub3(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function scale3(a, k) { return [a[0] * k, a[1] * k, a[2] * k]; }
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function colorVec(T) { const c = tempToRGB(T || 5772); return new THREE.Vector3(c[0], c[1], c[2]); }
const _v3 = new THREE.Vector3(), _q = new THREE.Quaternion();
const _X = new THREE.Vector3(1, 0, 0), _Y = new THREE.Vector3(0, 1, 0);

// Keplerian position in a plane given by quat (orbit in its XZ plane).
function keplerPos(a, e, inc, node, argp, M, quat) {
  M = ((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  let E = M;
  for (let i = 0; i < 8; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const xv = a * (Math.cos(E) - e), yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(argp), sw = Math.sin(argp), cn = Math.cos(node), sn = Math.sin(node), ci = Math.cos(inc), si = Math.sin(inc);
  const x = (cw * cn - sw * sn * ci) * xv + (-sw * cn - cw * sn * ci) * yv;
  const y = (cw * sn + sw * cn * ci) * xv + (-sw * sn + cw * cn * ci) * yv;
  const z = (sw * si) * xv + (cw * si) * yv;
  _v3.set(x, z, -y).applyQuaternion(quat);
  return [_v3.x, _v3.y, _v3.z];
}
function ellipse(a, e, inc, node, argp, quat) {
  const pts = [];
  for (let k = 0; k <= 160; k++) {
    const E = (k / 160) * Math.PI * 2;
    const M = E - e * Math.sin(E);
    pts.push(keplerPos(a, e, inc, node, argp, M, quat));
  }
  return pts;
}
export function compactRadius(o) {
  if (o.kind === "neutronstar") return 12000;
  const rs = 2 * G * (o.extra.massSun || 10) * M_SUN / (299792458 ** 2);
  return rs * 2.6;                            // the shadow, not the horizon
}

function makeGalaxyCell(level, cx, cy, cz, lv) {
  const rng = new Rng(hashInts(9001 + level, cx, cy, cz));
  const list = [];
  // Cosmic web: ridges of a smooth noise field gather galaxies into filaments.
  const web = (x, y, z) => {
    const f = (a, b, c) => Math.sin(a * 0.9 + 1.3) * Math.cos(b * 1.1 - 0.4) + Math.sin(b * 0.7 + c * 1.3) * Math.cos(c * 0.8 + a * 0.5) * 0.8;
    const v = f(x, y, z);
    return Math.max(0.05, 1 - Math.abs(v) * 1.4);
  };
  const s = level === 0 ? 1 / 30e6 * 6 : 1 / 300e6 * 2.5;
  const n = rng.poisson(lv.n * Math.pow(web((cx + 0.5) * lv.L * s, (cy + 0.5) * lv.L * s, (cz + 0.5) * lv.L * s), 2) * 2);
  for (let i = 0; i < n; i++) {
    const lx = rng.next() * lv.L, ly = rng.next() * lv.L, lz = rng.next() * lv.L;
    const wx = cx * lv.L + lx, wy = cy * lv.L + ly, wz = cz * lv.L + lz;
    if (Math.hypot(wx, wy, wz) < lv.minR) continue;
    const seed = hashInts(level, hashInts(cx, cy, cz), i);
    const grng = new Rng(seed);
    const u = grng.next();
    const type = level === 1 ? (u < 0.5 ? "elliptical" : "spiral") : u < 0.12 ? "elliptical" : u < 0.2 ? "lenticular" : u < 0.55 ? "spiral" : u < 0.7 ? "barred" : u < 0.82 ? "irregular" : "dsph";
    const diamKly = type === "dsph" ? grng.range(2, 8) : type === "irregular" ? grng.range(8, 35) : type === "elliptical" && level === 1 ? grng.range(120, 400) : grng.range(30, 160);
    const absB = type === "dsph" ? grng.range(-12, -9) : -16 - Math.log10(diamKly / 10) * 4.5 + grng.range(-0.8, 0.8);
    const g = {
      kind: "galaxy", real: false, procedural: true, seed, name: designation(level === 0 ? "PG" : "PGX", seed), type, diamKly,
      ttype: type === "spiral" || type === "barred" ? grng.int(1, 7) : null, barred: type === "barred",
      lumSun: Math.pow(10, -0.4 * (absB - 5.44)), absBmag: absB, localLy: [lx, ly, lz], group: null
    };
    const n3 = new THREE.Vector3(grng.gauss(), grng.gauss(), grng.gauss()).normalize();
    const X = new THREE.Vector3().crossVectors(n3, Math.abs(n3.y) < 0.9 ? _Y : _X).normalize();
    const Z = new THREE.Vector3().crossVectors(X, n3);
    g.quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, n3, Z));
    list.push(g);
  }
  return { list, level };
}

// ── local storage for discoveries ──
const DKEY = "sx-discoveries-v1";
function loadDiscoveries() {
  try { return new Map((JSON.parse(localStorage.getItem(DKEY) || "[]") || []).map((e) => [e.id, e])); } catch (e) { return new Map(); }
}
function saveDiscoveries(m) {
  try { localStorage.setItem(DKEY, JSON.stringify([...m.values()].slice(-500))); } catch (e) { /* storage unavailable */ }
}

export { SOL, keplerPos, describeMorphology, typeLabel, spectralType, describeClass, fmtNum, distUP };
