// The simulator. create() builds everything (reporting progress for the
// loading sequence), reveal() fades it in, and the returned controller's
// dispose() tears it all down — GPU resources, workers, listeners, loop.

import * as THREE from "three";
import { UPos, sub, LY, AU, KM, C, fmtDistance, fmtSpeed } from "./engine/coords.js";
import { TimeController } from "./engine/time.js";
import { Input } from "./engine/input.js";
import { PRESETS, loadSettings, saveSettings, FrameMonitor } from "./engine/quality.js";
import { WorkerPool } from "./engine/workers.js";
import { SpaceRenderer } from "./render/renderer.js";
import { Spacecraft, LENGTH as SHIP_LEN } from "./craft/spacecraft.js";
import { SpeedStreaks } from "./render/speedfx.js";
import { LaunchSite, SITE } from "./render/launchsite.js";
import { CLASS_NAMES } from "./earth/veg-format.js";
import { AtmoFX, ATMO_COLORS } from "./render/atmofx.js";
import { DUST } from "./render/bodies.js";
import { SurfaceMap } from "./ui/map.js";
import { EarthRegions } from "./earth/regions.js";
import { LocalShadows, shadowStyle } from "./render/shadows.js";
import { disposeSurfaceWorkers } from "./render/terrain.js";
import { toLocal, latLon as dirLatLon } from "./universe/surfaces.js";
import { Launch } from "./nav/launch.js";
import { Walker } from "./nav/walker.js";
import { horizonAngles, airFactor, daylightJD, surfaceRows } from "./nav/explore.js";
import { loadField, dirFromLatLon } from "./universe/surfaces.js";
import { loadCatalogs, loadFarGalaxies } from "./universe/catalog.js";
import { Universe } from "./universe/universe.js";
import { Navigator } from "./nav/navigator.js";
import { Targets, Search } from "./nav/targets.js";
import { pick, bodyTarget } from "./nav/picking.js";
import { HUD } from "./ui/hud.js";
import { Ambient } from "./ui/audio.js";

const CSS_URL = new URL("./space.css", import.meta.url).href;

export async function create({ onProgress = () => {}, onExit = () => {} } = {}) {
  const ac = new AbortController();
  const signal = ac.signal;
  await loadCss();
  onProgress("css");

  const settings = loadSettings();
  let quality = PRESETS[settings.quality];

  const root = document.createElement("div");
  root.className = "sx-root";
  root.setAttribute("role", "application");
  root.setAttribute("aria-label", "Space exploration simulator");
  if (settings.reducedMotion) root.classList.add("is-reduced");
  if (matchMedia("(pointer: coarse)").matches) root.classList.add("is-touch");
  const canvas = document.createElement("canvas");
  canvas.className = "sx-canvas";
  canvas.tabIndex = 0;
  root.appendChild(canvas);
  document.body.appendChild(root);

  let sr;
  try {
    sr = new SpaceRenderer(canvas, quality);
  } catch (e) {
    return failure(root, "This browser couldn't start WebGL 2, which the simulator needs. Everything else on the portfolio still works.", onExit, ac);
  }
  sr.resize(root.clientWidth, root.clientHeight);
  const gl = sr.renderer.getContext();
  const maxPointPx = Math.min(256, (gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) || [1, 64])[1]);

  const cat = await loadCatalogs((n) => onProgress("catalog:" + n));
  onProgress("catalogs");

  const workers = new WorkerPool(Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 4) - 2)));
  const time = new TimeController();
  const nearCtx = { scene: sr.nearScene, quality };
  const universe = new Universe(cat, {
    far: sr.farScene, near: sr.nearScene, nearCtx, quality, workers, settings,
    onDiscover: (sys, first) => discovered(sys, first)
  });
  const targets = new Targets(universe);
  targets.from = () => nav.pos;                 // landmarks route around the limb from here
  const search = new Search(universe, targets);
  // The craft (nav) always exists; the free observer (obs) is a separate
  // viewpoint you can fly while the craft waits where you left it.
  const nav = new Navigator();
  nav.mode = "chase";
  const obs = new Navigator();
  obs.mode = "free";
  const ship = new Spacecraft(sr.nearScene);
  // The craft's real extent and gear, for ground clearance and landing.
  nav.hullBox = ship.bounds.box.clone();
  nav.gearLength = ship.bounds.box.min.y - ship.gearBottom;
  nav.gear = 1; ship.setGear(1);
  const walker = new Walker();
  const atmoFx = new AtmoFX(sr.nearScene);
  const site = new LaunchSite(sr.nearScene);
  const streaks = new SpeedStreaks(sr.nearScene);
  let camMode = "chase";                      // chase (third person) → cockpit → free; "walk" on foot
  const active = () => (camMode === "free" ? obs : nav);
  const ambient = new Ambient();
  const input = new Input(canvas);
  const monitor = new FrameMonitor();
  onProgress("universe");

  // ── every session starts on the pad at Cape Canaveral, in daylight ──
  // Earth's real elevation is loaded first so the pad, the terrain and the
  // collision all agree from the first frame.
  const earth = universe.solar.get("earth");
  try { earth.body.getSurface().field = await loadField(earth.def.surfaceEntry); }
  catch (e) { console.warn("[space] Earth elevation unavailable — using the reference ellipsoid", e.message); earth.body.getSurface().mode = "real-imagery-procedural-relief"; }
  // The pad and its apron: graded ground 3 m above sea level (see Surface.addSite).
  // The decks (apron 110 m at +1.2 m, pad 34 m at +2.2 m) match launchsite.js.
  earth.body.getSurface().addSite(SITE.lat, SITE.lon, 900, 3, [[110, 1.2], [34, SITE.padTop]]);
  // Region packs: high-resolution elevation, aerial imagery and real map
  // data. The launch site's pack loads before the launch; others on approach.
  const earthRegions = new EarthRegions(earth.body, sr.nearScene);
  await earthRegions.init();
  for (const r of earthRegions.index.regions.filter((x) => x.startup)) { try { await earthRegions.load(r.id); } catch (e) { /* the launch works without it */ } }
  earthRegions.veg.prewarm(SITE.lat, SITE.lon, earth.body.getSurface());
  // Water for landing: outside the region packs, ask the global land cover
  // (null = not loaded yet, or inside a pack: the DEM decides).
  earth.body.getSurface().waterAt = (lat, lon) => {
    if (earthRegions.inPack(lat, lon)) return null;
    const v = earthRegions.global.sample(lat, lon);
    return v < 0 ? null : ((v >> 2) & 3) >= 2;
  };       // trees around the pad, ready for liftoff
  search.addPlaces(earthRegions.index.regions);
  // The Earth landmark registry (verified coordinates; scripts/earth/build-landmarks.mjs).
  fetch(new URL("./data/earth/landmarks.json", import.meta.url)).then((r) => (r.ok ? r.json() : null)).then((j) => { if (j) { search.addRegistry(j.landmarks); earthRegions.setLandmarkModels(j.landmarks); } }).catch(() => {});
  let earthCam = null;                           // camera over the Earth: { lat, lon, alt, ahead }
  earth.body.onSurfacePlace = (terrain, p, quat, s, L, C) => {
    if (earthCam) earthRegions.applyImagery(terrain.mat, earthCam.lat, earthCam.lon);
    earthRegions.place(p, quat, s, L, C);
  };
  onProgress("surface");
  time.jd = daylightJD(universe, "earth", SITE, time.jd);
  universe.updateSolar(time.jd);
  site.locate(earth.body);
  let launch = new Launch({ earth: earth.body, site, nav, ship, reduced: settings.reducedMotion });
  let launchHold = Infinity;                       // set on reveal
  launch.update(0);
  let launchState = { t: 0, stage: "SYSTEMS ONLINE", thrust: 0.1, gear: 1, dust: 0, shake: 0 };
  // The chase camera starts settled behind the craft.
  // On the pad: behind, a little above, and off to one side of the craft.
  const rigOffset = new THREE.Vector3(-SHIP_LEN * 0.35, SHIP_LEN * 0.3, SHIP_LEN * 1.25).applyQuaternion(nav.quat);
  const rigQuat = nav.quat.clone();
  let cockpitBlend = 0;                       // 0 = chase rig, 1 = pilot's eye

  // Background: the HyperLEDA layer (~32,600 galaxies) arrives after start-up.
  loadFarGalaxies().then((list) => { universe.addFarGalaxies(list); search.addGalaxies(list, universe); })
    .catch((e) => console.warn("[space] far galaxy catalogue unavailable:", e.message));

  let selected = null;
  let focusing = null;
  let lift = 0;
  let disposed = false;
  let raf = 0;
  const hideStar = new THREE.Vector4(0, 0, 0, -1);
  const camQuatTmp = new THREE.Quaternion();

  // Test handle, only with ?sxdebug in the URL.
  if (/[?&]sxdebug\b/.test(location.search)) window.__sx = { universe, nav, obs, ship, walker, site, targets, time, sr, settings, get camMode() { return camMode; }, get launch() { return launch; },
    select: (t) => select(t), search: (q) => search.query(q), travel: () => travel(), skipLaunch: () => skipLaunch(), land: () => startLanding(), exitCraft: () => exitCraft(), enterCraft: () => enterCraft(), near: () => lastNear,
    // Tests: put the craft at a body's latitude/longitude, alt metres above the
    // ground, facing heading° (0 = north) and pitched pitch°.
    place(id, lat, lon, alt, heading = 0, pitch = 0) {
      if (launch) skipLaunch();
      if (camMode === "walk") enterCraft();
      const b = universe.solar.get(id).body;
      const d = dirFromLatLon(lat, lon), up = new THREE.Vector3(...d);
      const ground = b.getSurface().radiusAt(d[0], d[1], d[2], 5);
      const north = new THREE.Vector3(0, 1, 0).addScaledVector(up, -up.y).normalize();
      const east = new THREE.Vector3().crossVectors(north, up);
      const h = heading * Math.PI / 180, pt = pitch * Math.PI / 180;
      const fwd = north.multiplyScalar(Math.cos(h)).addScaledVector(east, Math.sin(h)).multiplyScalar(Math.cos(pt)).addScaledVector(up, Math.sin(pt));
      const upW = up.clone().applyQuaternion(b.quat), fwdW = fwd.applyQuaternion(b.quat);
      nav.pos.set(b.pos).add(upW.x * (ground + alt), upW.y * (ground + alt), upW.z * (ground + alt));
      nav.quat.setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), fwdW, upW));
      nav.vel.set(0, 0, 0); nav.angVel.set(0, 0, 0); nav.travel = null; nav.landed = false; nav.assist = false; nav.throttle = 0;
      rigOffset.set(0, SHIP_LEN * 0.25, SHIP_LEN * 1.2).applyQuaternion(nav.quat); rigQuat.copy(nav.quat);
      shipFrame.prime(b);
    },
    mode(m) { for (let i = 0; i < 3 && camMode !== m; i++) cycleMode(); return camMode; },
    get earthRegions() { return earthRegions; },
    // Developer only: vertical exaggeration of a body's relief (default 1×).
    exaggerate(id, k) { const s = universe.solar.get(id).body.getSurface(); s.exag = k; return s.exag; },
    // Tests: move time to a morning at a body's lat/lon (span: its solar day, days).
    daylight(id, lat, lon, span) { time.jd = daylightJD(universe, id, { lat, lon }, time.jd, span); universe.advance(time.jd); return time.jd; } };

  // ── HUD wiring ──
  const hud = new HUD(root, {
    onExit: () => exit(),
    search: (q) => search.query(q),
    onSearchSelect: (t) => { if (t) select(t, true); },
    onRate: (i) => time.setRate(i),
    onMode: () => cycleMode(),
    onUiOpen: () => input.releaseLock(),
    getSettings: () => settings,
    getSources: () => cat.sources.concat([{ name: "Solar System: JPL Solar System Dynamics (elements), IAU WGCCRE 2015 (rotation)", url: "https://ssd.jpl.nasa.gov/" }], SURFACE_SOURCES),
    onSetting: (k, v) => setSetting(k, v),
    onToggleSound: () => setSetting("sound", !ambient.on),
    onStick: (x, y) => { input.touchMove.x = x; input.touchMove.y = y; },
    onLift: (v) => { input.touchLift = v; },
    onWheel: (d) => { input.wheel += d; },
    onTravel: () => travel(),
    onSkipLaunch: () => skipLaunch()
  }, signal);
  hud.setMode(camMode);
  hud.setSound(false);

  function setSetting(k, v) {
    if (k === "quality") {
      settings.quality = v; quality = PRESETS[v]; nearCtx.quality = quality; universe.ctx.quality = quality; sr.setQuality(quality);
    } else if (k === "sound") {
      settings.muted = !v;
      if (v) ambient.start(); else ambient.stop();
      hud.setSound(v);
    } else {
      settings[k] = v;
      if (k === "reducedMotion") root.classList.toggle("is-reduced", v);
    }
    saveSettings(settings);
  }

  function select(t, fromSearch) {
    selected = t;
    if (!t) { hud.showInfo(null); return; }
    hud.showInfo(t, {
      travel: () => travel(),
      focus: () => { focusing = t; },
      rename: () => rename(t)
    });
    if (fromSearch) focusing = t;
  }
  function travel() {
    if (launch || camMode === "walk") { hud.message(launch ? "Launch in progress — Space skips it" : "Board the craft first (E near it)"); return; }
    if (!selected) { hud.message("Select something first — click it, or search with /"); return; }
    nav.landed = false; nav.assist = false;
    focusing = null;
    // Start loading the destination now, while the trip is under way.
    universe.preload(selected);
    if (selected.kind === "landmark" && selected.body === earth.body) earthRegions.preload(selected.lat, selected.lon);       // pack, land cover, map tiles, plants
    // The ship's own size sits between it and the stop point in third person.
    active().startTravel({ pos: selected.travelPos || selected.pos, stop: selected.stop + (camMode === "chase" ? SHIP_LEN * 4 : 0), name: selected.name });
    hud.message("Travelling to " + selected.name + " · any movement key cancels");
  }
  function rename(t) {
    const name = prompt("Name this system (kept only in your browser; not an official designation):", "");
    if (name === null) return;
    universe.renameDiscovery(t.id, name.trim().slice(0, 40));
    select(targets.procStar(t.rec));
  }
  function cycleMode() {
    if (launch || camMode === "walk") return;
    const order = ["chase", "cockpit", "free"];
    const prevCam = camPos(), prevQ = camQuat().clone();
    camMode = order[(order.indexOf(camMode) + 1) % order.length];
    if (camMode === "cockpit") cockpitBlend = 0;   // glide from the chase view into the canopy
    if (camMode === "free") {
      // The observer starts exactly where the camera was; the craft stays put.
      obs.pos.set(prevCam); obs.quat.copy(prevQ); obs.vel.set(0, 0, 0); obs.travel = null;
      obsFrame.prime(lastNear && lastNear.body);
    } else if (camMode === "chase") {
      // Back to the craft: from far away, snap; nearby, glide in.
      const d = sub(prevCam, nav.pos);
      const L = Math.hypot(d[0], d[1], d[2]);
      if (L > SHIP_LEN * 200) rigOffset.set(0, SHIP_LEN * 0.25, SHIP_LEN * 1.2).applyQuaternion(nav.quat);
      else rigOffset.set(d[0], d[1], d[2]);
      rigQuat.copy(prevQ);
    }
    hud.setMode(camMode);
    hud.message("CAMERA: " + CAMERA_LABEL[camMode]);
  }
  function discovered(sys, first) {
    const p = sys.content ? sys.content.planets.length : 0;
    const solD = sys.rec.galaxy && sys.rec.galaxy.isMW ? fmtDistance(Math.hypot(...sub(sys.anchor, new UPos()))) + " from Sol" : "in " + (sys.rec.galaxy.rec.common || sys.rec.galaxy.rec.name);
    if (first) hud.toast("NEW SYSTEM DISCOVERED · PROCEDURAL", sys.star.name, sys.star.description + " · " + p + " planet" + (p === 1 ? "" : "s") + " · " + solD);
    else hud.message("Entering " + sys.star.name + " (visited before)");
  }

  // ── keys ──
  input.on("g", () => travel());
  input.on("f", () => { if (selected) focusing = selected; });
  input.on("c", () => cycleMode());
  input.on("o", () => { setSetting("orbits", !settings.orbits); hud.message("Orbit lines " + (settings.orbits ? "on" : "off")); });
  input.on("k", () => { setSetting("labels", !settings.labels); hud.message("Labels " + (settings.labels ? "on" : "off")); });
  input.on("l", () => startLanding());
  input.on("t", () => toggleMap());           // (M is mouse-look, N is "time: now")
  input.on("Enter", () => { if (camMode === "walk") enterCraft(); else exitCraft(); });
  input.on(" ", () => { if (launch) skipLaunch(); else if (camMode === "walk") input.jump = true; });
  input.on("h", () => hud.toggleModal("help"));
  input.on("i", () => { if (hud.info.classList.contains("is-open")) hud.showInfo(null); else if (selected) select(selected); });
  input.on("r", () => active().resetOrientation());
  input.on("p", () => time.togglePause());
  input.on(",", () => time.slower());
  input.on(".", () => time.faster());
  input.on("n", () => { time.now(); hud.message("Time set to now"); });
  input.on("m", () => input.toggleLock());
  input.on("/", () => hud.openSearch());
  // Developer tools: F3 diagnostics overlay, F4 level-of-detail colours.
  let debugOn = false;
  input.on("F3", () => { debugOn = !debugOn; if (!debugOn) hud.setDebug(""); });
  input.on("F4", () => { frameCtx.debugLod = !frameCtx.debugLod; hud.message("LOD colours " + (frameCtx.debugLod ? "on" : "off")); });
  // F5: spacecraft developer view — bounds, forward vector, camera and engine anchors.
  input.on("F5", () => { ship.setDebug(!ship.debug); hud.message("Craft debug " + (ship.debug ? "on" : "off")); });
  input.onEscape = () => {
    if (launch) { skipLaunch(); return; }
    if (document.pointerLockElement) { input.releaseLock(); return; }
    if (hud.anyOpen) { hud.closeSearch(); hud.closeModals(); canvas.focus(); return; }
    if (active().travel) { active().cancelTravel(); hud.message("Travel cancelled"); return; }
    if (hud.info.classList.contains("is-open")) { hud.showInfo(null); return; }
    hud.toggleModal("settings");
  };
  input.onClick = (x, y) => {
    if (hud.anyOpen) { hud.closeSearch(); hud.closeModals(); return; }
    const r = root.getBoundingClientRect();
    const t = pick(universe, targets, camPos(), camQuat(), sr.nearCamera.fov, r.width, r.height, x - r.left, y - r.top);
    select(t);
  };

  window.addEventListener("resize", () => sr.resize(root.clientWidth, root.clientHeight), { signal });
  document.addEventListener("visibilitychange", () => { last = performance.now(); }, { signal });

  // ── camera rig ──
  // Third person: framed from the craft's real bounds — the distance is solved
  // so the wingspan fills a set share of the screen width at the current field
  // of view and aspect, which keeps phones and wide screens alike. The offset
  // is smoothed in the craft's frame, so turns swing the view gently, but the
  // craft's travel is never smoothed (at warp the camera would fall behind).
  // Boost and very high speed pull it back a little; it eases back after.
  // The camera aims at a point ahead of the nose, not at the hull.
  // Cockpit: the pilot's eye inside the canopy, reached by a short glide.
  const _ahead = new THREE.Vector3(), _up = new THREE.Vector3(), _m = new THREE.Matrix4();
  let pullback = 0;
  function chaseDistance() {
    const B = ship.bounds, cam = sr.nearCamera;
    const tanH = Math.tan((cam.fov * Math.PI) / 360) * cam.aspect;
    const share = cam.aspect < 1 ? 0.62 : 0.4;        // of the screen's width
    return Math.max(B.L * 0.95, (B.W / 2) / (share * tanH));
  }
  function updateRig(dt) {
    if (camMode === "cockpit") cockpitBlend = Math.min(1, cockpitBlend + dt / 0.6);
    if (camMode === "free") return;
    const v = Math.max(1, nav.lastSpeed);
    const speedPull = Math.min(1, Math.max(0, (Math.log10(v) - 7) / 3)) * 0.35;
    const boostPull = input.down("Shift") ? 0.14 : 0;
    const wantPull = settings.reducedMotion ? 0 : speedPull + boostPull;
    pullback += (wantPull - pullback) * (1 - Math.exp(-dt * 2.5));
    const D = chaseDistance() * (1 + pullback);
    const want = _ahead.set(0, D * 0.24, D).applyQuaternion(nav.quat);
    rigOffset.lerp(want, 1 - Math.exp(-dt * 4.5));
    // Aim ahead of the nose, a little above the hull line.
    const L = ship.bounds.L;
    // Portrait: aim lower and nearer, which lifts the craft clear of the
    // touch controls toward the middle of the screen.
    const portrait = sr.nearCamera.aspect < 1;
    const target = _ahead.set(0, portrait ? -D * 0.05 : D * 0.07, -L * 0.5 - D * (portrait ? 0.45 : 0.9)).applyQuaternion(nav.quat).sub(rigOffset);
    // Camera roll: near a body the horizon stays mostly level — the camera
    // inherits only about a fifth of the craft's bank (≈8° of a 40° bank),
    // enough to feel the turn while keeping the view readable.
    const shipUp = _up.set(0, 1, 0).applyQuaternion(ship.bankQuat(_bq)).applyQuaternion(nav.quat);
    if (lastNear && lastNear.up && lastNear.body && lastNear.r < lastNear.body.radius * 20) {
      const f = _fw.set(0, 0, -1).applyQuaternion(nav.quat);
      const level = _lv.set(lastNear.up[0], lastNear.up[1], lastNear.up[2]);
      level.addScaledVector(f, -level.dot(f));
      if (level.lengthSq() > 1e-6) { level.normalize(); shipUp.lerp(level, 0.78).normalize(); }
    }
    const wantQ = new THREE.Quaternion().setFromRotationMatrix(_m.lookAt(new THREE.Vector3(), target, shipUp));
    rigQuat.slerp(wantQ, 1 - Math.exp(-dt * 7));
    // Launch vibration (off with reduced motion or with camera shake disabled).
    const shake = launchState && launch ? launchState.shake : 0;
    if (shake > 0 && settings.shake !== false && !settings.reducedMotion) {
      const t = frameCtx.timeSec;
      shakeOff.set(Math.sin(t * 47) * 0.35, Math.sin(t * 53 + 1) * 0.3, Math.sin(t * 41 + 2) * 0.2).multiplyScalar(shake);
    } else shakeOff.set(0, 0, 0);
  }
  const _bq = new THREE.Quaternion(), _fw = new THREE.Vector3(), _lv = new THREE.Vector3(), shakeOff = new THREE.Vector3(), headOff = new THREE.Vector3();
  let lastNear = null;
  function smooth(k) { return k * k * (3 - 2 * k); }
  // The pilot sits inside the craft, so the cockpit view rolls with the bank.
  const _cq = new THREE.Quaternion();
  function cockpitQuat() { return _cq.copy(nav.quat).multiply(ship.bankQuat(_bq)); }
  function camQuat() {
    if (camMode === "walk") return camQuatTmp.copy(walker.quat);
    if (camMode === "free") return camQuatTmp.copy(obs.quat);
    if (camMode === "cockpit") return camQuatTmp.copy(rigQuat).slerp(cockpitQuat(), smooth(cockpitBlend));
    return camQuatTmp.copy(rigQuat);
  }
  function camPos() {
    if (camMode === "walk") return walker.pos;
    if (camMode === "free") return obs.pos;
    if (camMode === "cockpit") {
      const o = _co.copy(ship.cockpitAnchor.position).add(headOff).applyQuaternion(cockpitQuat()).lerp(rigOffset, 1 - smooth(cockpitBlend));
      return nav.pos.clone().add(o.x, o.y, o.z);
    }
    return nav.pos.clone().add(rigOffset.x + shakeOff.x, rigOffset.y + shakeOff.y, rigOffset.z + shakeOff.z);
  }
  const _co = new THREE.Vector3();

  // ── loop ──
  let last = performance.now();
  let hudClock = 0;
  const startT = performance.now();
  const frameCtx = { pxPerRad: 1000, maxPointPx, starExposure: 1, galaxyExposure: 1, hideStar, settings, quality, timeSec: 0, camQuat: new THREE.Quaternion(), reducedMotion: false };

  function frame(now) {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    let dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (dt <= 0) dt = 0.016;
    monitor.push(dt);
    if (settings.autoQuality && monitor.verdict() === "down") {
      const order = ["ultra", "high", "medium", "low"];
      const i = order.indexOf(settings.quality);
      if (i < order.length - 1) { setSetting("quality", order[i + 1]); hud.message("Graphics lowered to " + PRESETS[order[i + 1]].label + " to keep things smooth"); }
    }
    time.step(dt);
    universe.advance(time.jd);                 // bodies first, then whatever rides on them
    frameCtx.terrainBudget = framesRun++ < 120 ? 40 : 3;      // build the pad's terrain quickly at start
    const walking = camMode === "walk";
    const me = walking ? walker : active();
    // Carry everything riding on a body along with it before measuring
    // anything: Earth moves ~30 km/s, so a measurement taken before this is
    // off by hundreds of metres.
    if (!launch) {
      shipFrame.follow(universe.nearestSurface(nav.pos, true), nav);
      if (camMode === "free") obsFrame.follow(universe.nearestSurface(obs.pos, true), obs);
      if (walking) walkFrame.follow(universe.nearestSurface(walker.pos, true), walker);
    }
    const shipNear = universe.nearestSurface(nav.pos);
    const near = walking ? shipNear : camMode === "free" ? universe.nearestSurface(obs.pos) : shipNear;
    lastNear = shipNear;
    shipNear.atmoFactor = airFactor(shipNear.body, shipNear.alt);
    let ev = null;
    if (launch) {
      // The pad turns with the Earth; the launch flies in the Earth's frame.
      // Hold the countdown until the helmet transition has faded out.
      launchState = launch.update(launchHold > 0 ? 0 : dt) || launchState;
      launchHold = Math.max(0, launchHold - dt);
      input.takeLook(); input.takeWheel();        // no steering until control is handed over
      if (launch.done) finishLaunch("PLAYER CONTROL ENABLED");
    } else {
      if (walking) {
        walker.update(dt, input, settings);
        if (input.down("e") && !prevE) enterCraft();
      } else ev = me.update(dt, input, near, settings);
      // A craft left behind while you roam as the observer brakes and holds station.
      if (camMode === "free" && !nav.landed) { nav.vel.multiplyScalar(Math.exp(-dt * 8)); nav.pos.add(nav.vel.x * dt, nav.vel.y * dt, nav.vel.z * dt); nav.throttle = 0; }
    }
    prevE = input.down("e");
    // Re-measure after moving, for the camera, HUD and effects this frame.
    lastNear = universe.nearestSurface(nav.pos, true);
    lastNear.atmoFactor = airFactor(lastNear.body, lastNear.alt);
    // Gear: down for landing (assist, or low and slow over ground), up in flight.
    const gearWant = launch ? launchState.gear : nav.landed || nav.assist || (lastNear.alt < 250 && !lastNear.gas && nav.lastSpeed < 120) ? 1 : 0;
    nav.gear += (gearWant - nav.gear) * Math.min(1, dt * 1.6);
    ship.setGear(nav.gear);
    ship.manualRoll = nav.manualRoll; ship.realBank = nav.realBank;
    if (ev === "landed" || ev === "landed-hard") {
      hud.message(ev === "landed" ? "Touchdown · " + shipNear.body.def.name + (shipNear.entry && shipNear.entry.walkable ? " — Enter to step outside" : "") : "Hard landing — gear held");
    }
    if (ev === "assist-off") hud.message("Landing assist off");
    updateRig(dt);
    // Streaming looks a second ahead along the direction of travel.
    universe.lookAhead = me.pos.clone().add(me.vel.x * 1.2, me.vel.y * 1.2, me.vel.z * 1.2);
    if (ev === "arrived" && selected) {
      hud.message("Arrived · " + selected.name);
      universe.unpin(selected);
      // An exoplanet chosen from search: once its system has loaded, lock on to the planet itself.
      if (selected.exo) {
        const sys = universe.systems.get(selected.exo.key);
        const b = sys && sys.planets.find((x) => x.def.name === selected.exo.planet.name);
        // Arrived in the system: carry on to the planet itself.
        if (b) { select(targets.sysBody(b)); travel(); }
      }
    }
    if (focusing) {
      const d = sub(focusing.pos(), camPos());
      const dir = new THREE.Vector3(d[0], d[1], d[2]).normalize();
      const me2 = active();
      const want = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), dir, new THREE.Vector3(0, 1, 0).applyQuaternion(me2.quat)));
      me2.quat.slerp(want, 1 - Math.exp(-dt * 5));
      if (new THREE.Vector3(0, 0, -1).applyQuaternion(me2.quat).angleTo(dir) < 0.002) focusing = null;
    }

    const cam = camPos();
    const q = camQuat();
    frameCtx.pxPerRad = sr.pxPerRad;
    frameCtx.quality = quality;
    frameCtx.timeSec = (now - startT) / 1000;
    frameCtx.camQuat.copy(q);
    frameCtx.reducedMotion = settings.reducedMotion;
    hideStar.set(0, 0, 0, -1);
    frameCtx.dt = dt;
    adaptExposure(near);
    // Out between the galaxies the eye dark-adapts (or, for a camera, the
    // exposure lengthens) — that's what makes thousands of faint galaxies
    // visible there. Inside a galaxy, normal exposure.
    const darkAdapt = universe.current ? 1 : 30;
    frameCtx.darkAdapt = darkAdapt;
    frameCtx.galaxyExposureBase = frameCtx.galaxyExposure;
    frameCtx.galaxyExposure *= darkAdapt;
    sr.renderer.info.reset();
    frameCtx.frameNo = (frameCtx.frameNo || 0) + 1;
    universe.update(cam, q, time.jd, frameCtx);
    for (const [, sb] of universe.solar) if (sb.body && (sb.body.terrain || sb.body.rocks)) sb.body.dropStaleTerrain(frameCtx.frameNo);

    // The craft is always in the scene. In the cockpit it stays drawn — you
    // see the nose ahead and the instruments around you; the canopy's faces
    // point outward, so the glass doesn't block the view from inside.
    const shipRel = sub(nav.pos, cam);
    const boosting = input.down("Shift") && camMode !== "free" && !walking;
    const thrust = launch ? launchState.thrust : nav.landed || walking || camMode === "free" ? 0.02 : nav.throttle + (nav.travel ? 0.6 : 0);
    ship.update(new THREE.Vector3(...shipRel), nav.quat, sunDirFor(universe, nav.pos), thrust,
      launch ? launchState.boost : boosting || (!!nav.travel && nav.lastSpeed > C), frameCtx.timeSec, Math.hypot(...shipRel) < 5e7, dt);
    ambient.setEngine(launch ? launchState.thrust * (launchState.boost ? 1 : 0.7) : thrust, lastNear && lastNear.atmoFactor || 0);
    // The pad rides the Earth (30 km/s round the Sun, turning daily): re-place it.
    if (earth.body.dist - earth.body.radius < 4e5) site.locate(earth.body);
    site.update(cam, launch ? launchState.dust : 0, frameCtx.timeSec);
    updateEarthCity(cam);
    updateLandGate();
    updateAtmoFx(cam, q);
    if (camMode === "cockpit") updateCockpit(dt);
    // Pilot's head: a slight lean with turns and acceleration (off with camera shake disabled).
    if (camMode === "cockpit" && settings.shake !== false && !settings.reducedMotion) {
      headOff.lerp(_hv.set(-nav.angVel.y * 0.05, 0, Math.max(-0.04, Math.min(0.04, -nav.throttle * 0.03))), 1 - Math.exp(-dt * 3));
    } else headOff.set(0, 0, 0);
    streaks.update(me.vel, me.lastSpeed, dt, settings.reducedMotion);

    updateLens(q);
    updateShadows(cam);
    sr.render(q);

    hudClock -= dt;
    if (hudClock <= 0) {
      hudClock = 0.1;
      updateSurfaceHud(lastNear);
      if (surfMap.isOpen) { const m = mapPlace(); if (m && m.body === surfMap.body) surfMap.update(m.ll); else surfMap.close(); }
      hud.setLocation(universe.location(cam));
      hud.setSpeed(me.lastSpeed, walking ? "ON FOOT" : me.regime, walking ? 0 : me.wheel, me.lastSpeed > C);
      hud.setTime(time.label(), time.rateIndex);
    }
    updateTargetHud(cam, q);
    // Inside a giant's clouds there is nothing to see beyond them.
    if (settings.labels && !frameCtx.blind) updateLabels(cam, q); else hud.setLabels([]);
    fps = fps * 0.95 + (1 / dt) * 0.05;
    if (debugOn && (debugClock -= dt) <= 0) { debugClock = 0.25; hud.setDebug(debugText(cam)); }
  }

  // ── developer overlay ──
  let fps = 60, debugClock = 0;
  function debugText(cam) {
    const u = universe, info = sr.renderer.info;
    const ly = cam.toLy();
    let stars = u.stars.length, planets = 0;
    for (const [, c] of u.cells) stars += c.absMag.length;
    for (const b of u.nearBodies) if (b.group && b.def.kind !== "star") planets++;
    const cur = u.current;
    const sel = selected;
    let selLod = "—", selDist = "—";
    if (sel) {
      const d = sub(sel.pos(), cam);
      selDist = fmtDistance(Math.hypot(d[0], d[1], d[2]));
      if (sel.body) selLod = ["point", "sphere·16", "sphere·32", "sphere·64+", "terrain"][sel.body.lod || 0];
      else if (sel.entry) selLod = ["point", "small cloud", "full cloud", "close", "inside"][sel.entry.lod || 0];
      else if (sel.rec && u.systems.has(sel.id)) selLod = "system loaded";
      else selLod = "point";
    }
    const l0 = cur ? cur.local.map((v) => Math.floor(v / 20)).join(",") : "—";
    return [
      "FPS            " + fps.toFixed(0) + "   quality " + settings.quality,
      "camera (render) 0, 0, 0  — floating origin",
      "sector index   " + cam.sx + ", " + cam.sy + ", " + cam.sz + "   (1e13 m cells)",
      "offset in cell " + cam.x.toExponential(3) + ", " + cam.y.toExponential(3) + ", " + cam.z.toExponential(3) + " m",
      "universe (ly)  " + ly.map((v) => v.toExponential(4)).join(", "),
      "galaxy         " + (cur ? (cur.e.rec.common || cur.e.rec.name) + "  local " + cur.local.map((v) => v.toFixed(0)).join(", ") + " ly" : "none (intergalactic)"),
      "sector (L0)    " + l0,
      "active sectors " + u.cells.size + "   pending " + u.pendingCells.size,
      "stars loaded   " + stars + "   systems " + u.systems.size,
      "bodies drawn   " + planets,
      "galaxy entries " + u.galaxies.length + "   clouds " + u.galaxies.filter((e) => e.cloud).length + (u.farGalaxies ? "   far layer " + u.farGalaxies.list.length : "   far layer loading"),
      "current gal LOD " + (cur ? ["point", "small", "full", "close", "inside"][cur.e.lod || 0] : "—"),
      "selected       " + (sel ? sel.id : "—"),
      "selected LOD   " + selLod + "   distance " + selDist,
      "worker jobs    " + workers.pending.size + "   cloud jobs " + (u.cloudJobs || 0),
      "GPU geometries " + info.memory.geometries + "   textures " + info.memory.textures,
      "draw calls     " + info.render.calls + "   triangles " + info.render.triangles,
      "LOD colours    " + (frameCtx.debugLod ? "on (F4)" : "off (F4)")
    ].concat(surfaceDebug()).join("\n");
  }

  // Surface fields for the debug overlay: what the ground under the craft is
  // made of and how it is being drawn.
  function surfaceDebug() {
    const n = lastNear, b = n && n.body;
    if (!b || !b.getSurface || !(n.r < b.radius * 4)) return ["surface        —"];
    const sf = b.getSurface(), e = b.def.surfaceEntry || {}, t = e.terrain || {};
    const ll = n.dir ? latLonOf(n.dir).join("  ") : "—";
    const elev = n.dir && !n.gas ? sf.elevation(n.dir.x, n.dir.y, n.dir.z) : null;
    return [
      "surface body   " + b.def.name + "  " + (e.surfaceType || "solid") + "  g " + (e.gravity ? e.gravity.toPrecision(4) : "—") + " m/s²",
      "surface mode   " + sf.mode + (sf.field ? "  field " + sf.field.W + "×" + sf.field.H + (sf.field.patches.length ? " +" + sf.field.patches.length + " patch" : "") : t.file ? "  field loading" : ""),
      "surface source " + (t.source || "procedural"),
      "ground         " + ll + "  alt " + (n.gas ? "(1 bar) " : "") + fmtDistance(n.alt) + (elev !== null ? "  dataset elev " + elev.toFixed(0) + " m" : "") + (n.water ? "  WATER" : ""),
      "terrain        " + (b.terrain ? b.terrain.chunks + " chunks  " + (b.terrain.triangles || 0) + " tris" : "sphere (no chunks)") + "  landed " + nav.landed + "  assist " + nav.assist + "  gear " + nav.gear.toFixed(2),
      "camera mode    " + camMode + (camMode === "walk" ? "  walker alt " + (walker.altitude || 0).toFixed(2) + " m  grounded " + walker.grounded : ""),
      "terrain build  " + (b.terrain ? b.terrain.built + " chunks · " + (b.terrain.built ? (b.terrain.buildMs / b.terrain.built).toFixed(1) : "0") + " ms avg (worker)" : "—") + "  exaggeration " + sf.exag + "×",
      ...(b === earth.body ? (() => { const m = earthRegions.summary(); return [
        "earth regions  " + (m.regions.join(", ") || "none") + "  tiles " + m.tiles + " (near/mid/far " + m.lod.join("/") + ")  build " + m.avgBuildMs + " ms",
        "map geometry   " + m.buildings + " buildings · " + m.roads + " roads · " + m.triangles + " tris · heights tagged/levels/estimated/procedural " + m.heightSources.join("/"),
        ...(earthCam ? (() => { const st = earthRegions.status(earthCam.lat, earthCam.lon, earthCam.alt), c = st.counts, exp = earthRegions.regionAt(earthCam.lat, earthCam.lon).map((r) => r.id).join(",") || "global base";
          return ["EARTH  lat " + earthCam.lat.toFixed(5) + "  lon " + earthCam.lon.toFixed(5) + "  region " + st.region + " (expected " + exp + ")  pack loaded " + st.packLoaded,
            "  terrain " + st.terrain + " · imagery " + st.imagery + " · land cover " + st.landCover + " · water " + st.water + " · roads " + st.roads + " · buildings " + st.buildings + " · vegetation " + st.vegetation,
            "  active: " + c.buildings + " buildings · " + c.trees + " trees · " + c.roads + " roads · " + c.waterTiles + " water tiles · map tiles " + c.mapTiles + " (global " + c.globalTiles + ")" + (landGate ? "  LANDING HELD: loading" : "")]; })() : [])]; })() : [])
    ];
  }

  // Near a body you move with it: its orbital motion carries you along, and
  // low down you also turn with its rotation, so the ground stays put under
  // you instead of sliding past at hundreds of metres a second.
  function makeFrameFollower() {
    let frameBody = null;
    const framePrev = new UPos(), frameQPrev = new THREE.Quaternion();
    return {
      follow(near, who) {
        const b = near.body;
        const d0 = b ? Math.hypot(...sub(who.pos, b.pos)) : Infinity;
        const inFrame = b && d0 < b.radius * 80 && b.def.kind !== "blackhole";
        if (!inFrame) { frameBody = null; return; }
        if (frameBody === b) {
          const d = sub(b.pos, framePrev);
          who.pos.add(d[0], d[1], d[2]);
          if (d0 - b.radius < b.radius * 0.15) {
            const dq = b.quat.clone().multiply(frameQPrev.clone().invert());
            const r = sub(who.pos, b.pos);
            const v = new THREE.Vector3(r[0], r[1], r[2]).applyQuaternion(dq);
            who.pos.set(b.pos).add(v.x, v.y, v.z);
            if (who.rotateWith) who.rotateWith(dq); else who.quat.premultiply(dq);
          }
        }
        frameBody = b;
        framePrev.set(b.pos);
        frameQPrev.copy(b.quat);
        // (who.rotateWith, when present, receives the rotation instead of a quaternion.)
      },
      // Start riding body b from where things are now (call when something is
      // placed on or near a body between frames: stepping out, a mode switch).
      prime(b) {
        frameBody = b || null;
        if (b) { framePrev.set(b.pos); frameQPrev.copy(b.quat); }
      }
    };
  }
  const shipFrame = makeFrameFollower(), obsFrame = makeFrameFollower(), walkFrame = makeFrameFollower();
  let framesRun = 0, prevE = false;
  const _hv = new THREE.Vector3();

  // ── launch, landing, walking ──
  function finishLaunch(msg) {
    launch = null;
    shipFrame.prime(earth.body);                 // ride the Earth from this very frame
    hud.setLaunch(null);
    nav.vel.set(0, 0, 0); nav.angVel.set(0, 0, 0); nav.landed = false;
    hud.toast("ORBITAL NAVIGATION ONLINE", "Low Earth orbit", msg + " · search with / · H for controls");
  }
  // Skip straight to the end of the ascent: low Earth orbit over the Atlantic.
  function skipLaunch() {
    if (!launch) return;
    launch.t = launch.T;
    launch.update(0);
    rigOffset.set(0, SHIP_LEN * 0.25, SHIP_LEN * 1.2).applyQuaternion(nav.quat);
    rigQuat.copy(nav.quat);
    finishLaunch("Launch skipped");
  }
  // Earth region packs: where the camera is over the Earth, and where it will
  // be in four seconds (tiles load ahead of a low, fast pass).
  const _lead = new THREE.Vector3();
  function updateEarthCity(cam) {
    const eb = earth.body;
    const rel = sub(cam, eb.pos), D = Math.hypot(rel[0], rel[1], rel[2]);
    if (D - eb.radius > 2e5) {
      earthCam = null; earthRegions.update({ lat: 0, lon: 0, alt: 1e9 });
      if (attribEl.textContent) { attribEl.textContent = ""; attribEl.style.display = "none"; }
      return;
    }
    const l = toLocal(eb.quat, rel), ll = dirLatLon(l), surf = eb.getSurface();
    const alt = Math.max(0, l.r - surf.radiusAt(l.x, l.y, l.z, 0));
    const me = camMode === "walk" ? walker : camMode === "free" ? obs : nav;
    _lead.set(0, 0, 0); if (me.vel) _lead.copy(me.vel).multiplyScalar(4);
    let ahead = null;
    if (_lead.lengthSq() > 100) {
      const a = toLocal(eb.quat, [rel[0] + _lead.x, rel[1] + _lead.y, rel[2] + _lead.z]), al = dirLatLon(a);
      ahead = { lat: al.lat, lon: al.lon, alt: Math.max(0, a.r - surf.radiusAt(a.x, a.y, a.z, 0)) };
    }
    earthCam = { lat: ll.lat, lon: ll.lon, alt, ahead, pos: [l.x * l.r, l.y * l.r, l.z * l.r] };
    earthRegions.reach = quality.cityReach || 1;
    earthRegions.veg.setQuality(settings.quality);
    earthRegions.update(earthCam);
    // Attribution the data licences ask for, while that data is on screen.
    const here = earthRegions.regionAt(ll.lat, ll.lon, 0.3);
    const showMap = here.length && alt < 3e4;
    const ev = here.some((r) => r.id === "everest"), ov = here.some((r) => r.source === "overture"), demOnly = here.length && here.every((r) => r.source === "dem-only");
    // Attached open imagery (Sentinel-2, national orthophotos) and extra elevation, as each source asks to be credited.
    const extra = [];
    for (const r of here) { const R = earthRegions.regions.get(r.id), M = R && R.meta; if (!M) continue;
      for (const im of M.imagery || []) if (im.attached && im.attribution && !extra.includes("Imagery: " + im.attribution)) extra.push("Imagery: " + im.attribution);
      for (const d of M.dem || []) if (d.attached && /swisstopo/.test(d.source) && !extra.includes("Elevation: © swisstopo (swissALTI3D)")) extra.push("Elevation: © swisstopo (swissALTI3D)"); }
    const ext = extra.length ? " · " + extra.join(" · ") : "";
    const txt = showMap && demOnly ? "Elevation: Copernicus DEM © DLR e.V. / Airbus, provided under COPERNICUS by the EU and ESA" + ext + (alt < 6000 ? " · Land cover © ESA WorldCover project 2021 (CC BY 4.0)" : "")
      : showMap && ov ? "Map data: Overture Maps — © OpenStreetMap contributors (ODbL), Microsoft ML Building Footprints (CDLA Permissive 2.0), Google Open Buildings · Elevation: Copernicus DEM © DLR/Airbus, ESA" + ext +
        (alt < 6000 ? " · Land cover © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium (CC BY 4.0)" : "")
      : showMap ? "Map data © OpenStreetMap contributors (ODbL) · Elevation: " + (ev ? "Copernicus DEM © DLR/Airbus, ESA" : "USGS 3DEP") + " · Imagery: " + (ev ? "NASA Blue Marble NG" : "USDA NAIP / USGS") +
      (alt < 6000 ? " · Land cover © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium (CC BY 4.0)" + (ev ? "" : " · Canopy: NLCD 2021 Tree Canopy Cover, USDA Forest Service") : "")
      // Outside the packs: the global base layer.
      : alt < 6e4 ? "Land cover © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium (CC BY 4.0) · Roads, rivers: Natural Earth · Buildings here are procedural, not mapped" : "";
    if (attribEl.textContent !== txt) { attribEl.textContent = txt; attribEl.style.display = txt ? "block" : "none"; }
    // Lit windows after sunset (sun below ~3° at the camera).
    const sunUp = new THREE.Vector3(rel[0] / D, rel[1] / D, rel[2] / D).dot(eb.lightDir);
    earthRegions.setNight(Math.min(1, Math.max(0, (0.05 - sunUp) / 0.15)));
  }
  const attribEl = root.appendChild(document.createElement("div"));
  attribEl.className = "sx-attrib"; attribEl.style.display = "none";
  // Local sun shadows near a surface (render/shadows.js), sized by quality.
  const shadows = new LocalShadows(sr.renderer, sr.nearScene);
  shadows.extra.push(earthRegions.veg.shadowScene);          // nearby trees cast shadows too
  if (window.__sx) window.__sx.shadows = shadows;
  const _shF = new THREE.Vector3(), _shL = new THREE.Vector3();
  function updateShadows(cam) {
    shadows.configure(quality.shadowCascades || 0, quality.shadowSize || 2048);
    const n = camMode === "walk" ? universe.nearestSurface(walker.pos, true) : lastNear, b = n && n.body;
    const on = !!(b && !n.gas && b.def.kind !== "star" && n.alt < 3e4 && n.alt > -100 && b.terrain);
    if (!on) { shadows.update(null, null, null, false); return; }
    const up = new THREE.Vector3(...n.up), L = _shL.copy(b.lightDir).normalize();
    if (up.dot(L) < -0.05) { shadows.update(null, null, null, false); return; }   // night side: nothing to shadow
    // Centre: between the camera and the craft (both in the near cascade).
    if (camMode === "walk") _shF.set(0, 0, 0);
    else { const r = sub(nav.pos, cam); _shF.set(r[0], r[1], r[2]).multiplyScalar(0.5); }
    shadows.update(_shF, L, shadowStyle(b.def.id, !!b.def.atmosphere), true);
  }

  // Walking into a building: blocked by its footprint up to its roof.
  walker.blocker = (pos) => {
    const wb = walker.body, l = toLocal(wb.quat, sub(pos, wb.pos));
    // Larger nearby rocks (any world), buildings (Earth map data).
    if (wb.rocks && wb.rocks.blocked([l.x * (l.r - 1.2), l.y * (l.r - 1.2), l.z * (l.r - 1.2)])) return true;
    if (wb !== earth.body) return false;
    if (earthRegions.veg.blocked([l.x * (l.r - 1.2), l.y * (l.r - 1.2), l.z * (l.r - 1.2)])) return true;     // tree trunks
    return earthRegions.blocked(l, l.r - 1.5, wb.getSurface().baseRadius(l.x, l.y, l.z));
  };

  // An individually mapped OpenStreetMap tree within 25 m of the walker: what
  // its tags say, and nothing more (generated trees are not listed).
  // Outside the detailed packs, what the ground and buildings are made from.
  function earthGroundRows() {
    if (!earthCam || earthCam.alt > 6e4 || earthRegions.inPack(earthCam.lat, earthCam.lon)) return [];
    const v = earthRegions.global.sample(earthCam.lat, earthCam.lon);
    if (v < 0) return [["Ground", "LOADING LOCAL EARTH DATA", "warn"]];
    const rows = [["Ground", CLASS_NAMES[v >> 4] + " — ESA WorldCover 2021, ~925 m cells (global base)"]];
    if (v >> 4 === 5) rows.push(["Buildings", "PROCEDURAL urban fallback in built-up land cover — not mapped", "warn"]);
    return rows;
  }
  function mappedTreeRows() {
    if (walker.body !== earth.body) return [];
    const l = toLocal(earth.body.quat, sub(walker.pos, earth.body.pos));
    const t = earthRegions.veg.mappedTreeNear([l.x * l.r, l.y * l.r, l.z * l.r]);
    if (!t) return [];
    return [["Tree (mapped)", Math.round(t.distance) + " m away · " + (t.info || "no species, leaf type or size tagged"), "", "minor"], ["Tree source", "OpenStreetMap (natural=tree)", "", "minor"]];
  }

  // Surface map of the world you are at (T).
  const surfMap = new SurfaceMap(root, (L) => { const t = targets.landmark(L); if (t) select(t, true); });
  function mapPlace() {
    const walking = camMode === "walk";
    const n = walking ? universe.nearestSurface(walker.pos, true) : lastNear;
    if (!n || !n.body || !(n.r < n.body.radius * 4) || !universe.solar.has(n.body.def.id)) return null;
    return { body: n.body, ll: n.dir ? { lat: Math.asin(Math.max(-1, Math.min(1, n.dir.y))) * 180 / Math.PI, lon: Math.atan2(-n.dir.z, n.dir.x) * 180 / Math.PI } : null };
  }
  function toggleMap() {
    if (surfMap.isOpen) { surfMap.close(); return; }
    const m = mapPlace();
    if (!m) { hud.message("Fly closer to a world to open its map"); return; }
    input.releaseLock();
    surfMap.open(m.body, m.ll);
  }

  function startLanding() {
    if (launch || camMode === "walk") return;
    const n = lastNear;
    if (!n || !n.body) return;
    if (n.gas) { hud.message(n.body.def.name + " has no solid surface — fly in to explore its atmosphere"); return; }
    if (!(n.alt < 2e4)) { hud.message("Too high to land — descend below 20 km (" + fmtDistance(n.alt) + " now)"); return; }
    if (n.water) { hud.message("Open water below — find land to set down on"); return; }
    // Over Earth, hold until the local layers around the landing point are in
    // (or 20 s pass, reporting what failed): no setting down on bare ground
    // that is still loading.
    if (!nav.assist && n.body === earth.body && earthCam) {
      const st = earthRegions.status(earthCam.lat, earthCam.lon, earthCam.alt);
      if (!localReady(st)) { landGate = { t0: performance.now() }; hud.message("LOADING LOCAL EARTH DATA — landing when ready", 3000); return; }
    }
    nav.assist = !nav.assist;
    nav.travel = null;
    hud.message(nav.assist ? "Landing assist on — leveling, descending" : "Landing assist off");
  }
  // Local Earth layers ready for landing: terrain, imagery, water, land cover,
  // and (within the packs, or where the global base has them) roads, buildings, vegetation.
  let landGate = null;
  const LAYERS = ["terrain", "imagery", "water", "landCover", "roads", "buildings", "vegetation"];
  function localReady(st) { return LAYERS.every((k) => st[k] !== "LOADING"); }
  function updateLandGate() {
    if (!landGate) return;
    if (launch || camMode === "walk" || nav.assist || !earthCam) { landGate = null; return; }
    const st = earthRegions.status(earthCam.lat, earthCam.lon, earthCam.alt), waited = performance.now() - landGate.t0;
    if (localReady(st) || waited > 20000) {
      const bad = LAYERS.filter((k) => st[k] === "LOADING" || st[k] === "FAILED");
      landGate = null; nav.assist = true; nav.travel = null;
      hud.message(bad.length ? "Landing — still missing: " + bad.map((k) => k + " " + st[k].toLowerCase()).join(", ") : "Local Earth data ready — landing assist on", 3500);
    } else if ((landGate.shown = (landGate.shown || 0) - 1) <= 0) {
      landGate.shown = 60;
      hud.message("LOADING LOCAL EARTH DATA — " + LAYERS.filter((k) => st[k] === "LOADING").join(", "), 1500);
    }
  }
  function exitCraft() {
    const n = lastNear;
    if (launch || camMode === "walk" || !nav.landed) { if (!nav.landed && !launch) hud.message("Land first (L for landing assist)"); return; }
    if (!n.entry || !n.entry.walkable) { hud.message("This surface can't be walked on"); return; }
    // Step out on the port side, a few metres from the hull, facing forward.
    const side = new THREE.Vector3(-1, 0, 0).applyQuaternion(nav.quat);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(nav.quat);
    const U = new THREE.Vector3(...n.up);
    side.addScaledVector(U, -side.dot(U)).normalize();
    fwd.addScaledVector(U, -fwd.dot(U)).normalize();
    const p = nav.pos.clone().add(side.x * 16, side.y * 16, side.z * 16);
    walker.start(n.body, p, fwd);
    walkFrame.prime(n.body);
    camMode = "walk";
    hud.setMode("free");
    hud.message(n.entry.atmosphere && n.entry.atmosphere.breathable ? "On foot · " + n.body.def.name : "On foot · suit sealed · " + n.body.def.name);
  }
  function enterCraft() {
    if (camMode !== "walk") return;
    const d = Math.hypot(...sub(walker.pos, nav.pos));
    if (d > 30) { hud.message("Walk back to the craft to board (" + d.toFixed(0) + " m away)"); return; }
    camMode = "chase";
    nav.boardHold = true;
    rigOffset.set(0, SHIP_LEN * 0.3, SHIP_LEN * 1.2).applyQuaternion(nav.quat);
    hud.setMode(camMode);
    hud.message("Aboard · W or E to lift off");
  }

  // Inside an atmosphere you can't see out of: the giants below their cloud
  // tops, and the haze near the surfaces of Venus and Titan.
  function updateAtmoFx(cam, q) {
    const n = camMode === "walk" ? universe.nearestSurface(walker.pos, true) : lastNear;
    const b = n && n.body;
    if (!b) { atmoFx.set(null); frameCtx.blind = false; return; }
    const id = b.def.surfaceEntry && b.def.surfaceEntry.id;
    const cols = ATMO_COLORS[id] || (n.gas ? ATMO_COLORS.jupiter : null);
    const sunUp = Math.max(0.15, new THREE.Vector3(...n.up).dot(b.lightDir) * 0.8 + 0.4);
    frameCtx.blind = !!(n.gas && n.alt < 0);
    if (n.gas && n.alt < 0) {
      atmoFx.set("giant", cols, -n.alt / (b.def.surfaceEntry.depthLimitMeters || 1e5), new THREE.Vector3(...n.up), sunUp, frameCtx.timeSec);
      frameCtx.starExposure = 0; frameCtx.galaxyExposure = 0;
    } else if ((id === "venus" || id === "titan") && n.alt < 6e4) {
      atmoFx.set("haze", cols, 1 - n.alt / 6e4, new THREE.Vector3(...n.up), sunUp, frameCtx.timeSec);
    } else atmoFx.set(null);
  }

  // Cockpit instruments, redrawn ~8 times a second.
  let cockpitClock = 0;
  function updateCockpit(dt) {
    ship.cockpit.animate(nav.angVel.x, nav.angVel.y, nav.angVel.z, nav.throttle);
    if ((cockpitClock -= dt) > 0) return;
    cockpitClock = 0.12;
    const n = lastNear, b = n && n.body;
    const close = b && n.r < b.radius * 20;
    const pole = close ? new THREE.Vector3(0, 1, 0).applyQuaternion(b.quat) : null;
    const ang = close ? horizonAngles(nav.quat, n.up, pole, ship.bankQuat(_bq)) : { pitch: null, roll: null, heading: null };
    const ll = close && n.dir ? latLonOf(n.dir) : null;
    const tgt = selected ? selected.name : "—";
    const dist = selected ? fmtDistance(Math.max(0, Math.hypot(...sub(selected.pos(), nav.pos)) - (selected.radius || 0))) : "—";
    const alt = close ? fmtDistance(Math.max(0, n.alt)) : "—";
    const vs = close ? nav.vel.dot(new THREE.Vector3(...n.up)) : 0;
    const e = b && b.def.surfaceEntry;
    ship.cockpit.update({
      nav: { body: b ? b.def.name : "—", target: tgt.slice(0, 16), dist, lat: ll ? ll[0] : "—", lon: ll ? ll[1] : "—" },
      flight: { speed: fmtSpeed(nav.lastSpeed), alt, vs: close ? vs.toFixed(1) + " m/s" : "—", thrust: Math.round(nav.throttle * 100) + "%", regime: nav.regime },
      ship: { engines: launch ? launchState.stage.split(" ")[0] : input.down("Shift") ? "BOOST" : nav.throttle > 0.05 ? "THRUST" : "IDLE",
        view: "COCKPIT", gear: nav.gear > 0.95 ? "DOWN" : nav.gear < 0.05 ? "UP" : "MOVING",
        medium: n && n.atmoFactor > 0.01 ? "ATMOSPHERE" : n && n.gas && n.alt < 0 ? "ATMOSPHERE" : "VACUUM", gravity: e && e.gravity && close ? e.gravity.toPrecision(3) + " m/s²" : "—" },
      hud: { heading: ang.heading, pitch: ang.pitch, roll: ang.roll, speed: fmtSpeed(nav.lastSpeed), alt: close ? "ALT " + alt : "",
        target: selected ? tgt : "", dist: selected ? dist : "", landing: landingText(n) }
    });
  }
  function latLonOf(d) {
    const lat = Math.asin(Math.max(-1, Math.min(1, d.y))) * 180 / Math.PI, lon = Math.atan2(-d.z, d.x) * 180 / Math.PI;
    return [Math.abs(lat).toFixed(3) + "° " + (lat >= 0 ? "N" : "S"), Math.abs(lon).toFixed(3) + "° " + (lon >= 0 ? "E" : "W")];
  }
  // SAFE when slow, low, level and over land.
  function landingText(n) {
    if (!n || !n.body || n.gas || !(n.alt < 3000) || !(n.entry && n.entry.landable)) return "";
    if (nav.landed) return "LANDED";
    const U = new THREE.Vector3(...n.up);
    const vs = nav.vel.dot(U), hs = nav.vel.clone().addScaledVector(U, -vs).length();
    const tilt = Math.acos(Math.min(1, new THREE.Vector3(0, 1, 0).applyQuaternion(nav.quat).dot(U))) * 180 / Math.PI;
    const ok = !n.water && vs > -6 && hs < 25 && tilt < 20;
    return (ok ? "LANDING SAFE" : "LANDING UNSAFE") + (n.water ? " · WATER" : tilt >= 20 ? " · LEVEL OFF" : vs <= -6 ? " · SINK RATE" : hs >= 25 ? " · DRIFT" : "");
  }

  // Surface readouts and the contextual actions (LAND / EXIT CRAFT / …).
  function updateSurfaceHud(n) {
    const acts = [];
    if (launch) {
      hud.setLaunch({ stage: launchState.stage, progress: launch.t / launch.T });
      hud.setSurface(null); hud.setActions([]);
      return;
    }
    hud.setLaunch(null);
    if (camMode === "walk") {
      const g = walker.body.groundAt(walker.pos), e = walker.body.def.surfaceEntry || {};
      const suit = e.atmosphere && e.atmosphere.breathable ? null : "SUIT · life support active · no breathable atmosphere";
      hud.setSurface(walker.body.def.name.toUpperCase() + (walker.body.def.id === "earth" && Math.hypot(...sub(walker.pos, site.upos)) < 5e4 ? " · " + SITE.name : ""),
        // Elevation above the body's reference surface (sea level on Earth).
        surfaceRows(walker.body, g, { alt: walker.body.getSurface().heightAt(g.dir.x, g.dir.y, g.dir.z, 5) + Math.max(0, g.alt - 1.68) }).slice(0, 7).concat(earthGroundRows(), mappedTreeRows()),
        (suit ? suit + " · " : "") + "WASD walk · Shift run · Space jump · E board (within 30 m)");
      const d = Math.hypot(...sub(walker.pos, nav.pos));
      if (d < 30) acts.push({ label: "Enter craft", key: "E", run: enterCraft, tone: "go" });
      hud.setActions(acts);
      return;
    }
    const b = n && n.body;
    const close = b && n.r < b.radius * 4 && b.def.kind !== "star" && b.def.kind !== "blackhole" && b.def.kind !== "neutronstar";
    if (!close) { hud.setSurface(null); hud.setActions([]); return; }
    const e = b.def.surfaceEntry || {};
    const U = new THREE.Vector3(...n.up);
    const vs = nav.vel.dot(U), hs = nav.vel.clone().addScaledVector(U, -vs).length();
    const lt = landingText(n);
    if (n.gas) {
      const lim = e.depthLimitMeters || 1e5;
      const deep = n.alt < -lim * 0.95;
      hud.setSurface(b.def.name.toUpperCase() + " · " + (n.alt < 0 ? "INSIDE THE ATMOSPHERE" : "CLOUD TOPS BELOW"),
        [["Altitude (1 bar)", (n.alt < 0 ? "−" : "") + fmtDistance(Math.abs(n.alt))], ["Gravity", e.gravity ? e.gravity.toPrecision(3) + " m/s²" : "—"],
          ["Surface", "None — " + (e.surfaceType === "ice-giant" ? "ice giant" : "gas giant")], ["Limit", "~" + (lim / 1000) + " km below 1 bar", deep ? "warn" : ""]],
        deep ? "PRESSURE LIMIT — deeper flight is beyond this simulation" + (b.def.id === "jupiter" ? " (the Galileo probe stopped transmitting near 22 bar)." : ".")
          : "No solid surface to land on: the gas grows hotter and denser all the way down.");
      if (n.alt > 0 && n.alt < 3e5) acts.push({ label: "Enter atmosphere", key: "Q", run: () => hud.message("Descend with Q (or pitch down) — there is no ground, only deeper cloud"), tone: "" });
      if (deep) acts.push({ label: "Pressure limit", key: "", run: null, tone: "warn" });
    } else if (n.alt < 2e5) {
      hud.setSurface(b.def.name.toUpperCase(), surfaceRows(b, n, { alt: n.alt - nav.clearance(n.up), vs, hs, landing: lt, landingOk: lt.indexOf("SAFE") === 8 || lt === "LANDED" }).concat(b === earth.body ? earthGroundRows() : []), null);
      if (nav.landed) { if (e.walkable) acts.push({ label: "Exit craft", key: "Enter", run: exitCraft, tone: "go" }); acts.push({ label: "Take off", key: "E", run: () => hud.message("Hold E (up) to lift off"), tone: "" }); }
      else if (n.alt < 2e4 && e.landable) acts.push({ label: nav.assist ? "Landing assist on" : "Land", key: "L", run: startLanding, tone: nav.assist ? "go" : "" });
    } else { hud.setSurface(null); }
    hud.setActions(acts);
  }

  // Eye adaptation: under a sunlit sky the eye stops down for the bright
  // atmosphere, so the stars fade out and the ground reads at a normal
  // exposure. Thin atmospheres (Mars) adapt less.
  function adaptExposure(near) {
    let day = 0;
    const b = near.body;
    if (b && b.atmo && b.atmoRa) {
      const hA = (b.atmoRa - 1) * b.radius;
      // Height above the real ground (the ellipsoid and terrain), not above the
      // equatorial radius — at Cape Canaveral those differ by about 5 km.
      const alt = Math.max(0, near.alt !== undefined && near.body === b ? near.alt : b.dist - b.radius);
      if (alt < hA) {
        const up = new THREE.Vector3(-b.rel[0], -b.rel[1], -b.rel[2]).normalize();
        const s = up.dot(b.lightDir);
        const t = Math.min(1, Math.max(0, (s + 0.12) / 0.32));
        day = t * t * (3 - 2 * t) * Math.pow(1 - alt / hA, 0.6) * Math.min(1, (b.def.atmosphere.density || 1) * 1.5 + (DUST[b.def.id] ? DUST[b.def.id].tau * 1.6 : 0));
      }
    }
    day = Math.min(1, Math.max(0, day || 0));
    // No air: the sky stays black, but an eye adapted to sunlit ground can't
    // see faint stars — dim them low over the day side (Apollo crews saw the
    // same); at night, or from high orbit, they come back.
    let glare = 0;
    if (b && !b.atmo && near.alt !== undefined && b.def.kind !== "star" && b.def.kind !== "blackhole") {
      const hLim = Math.min(2e5, b.radius * 0.25), alt = Math.max(0, near.alt);
      if (alt < hLim) {
        const up = new THREE.Vector3(-b.rel[0], -b.rel[1], -b.rel[2]).normalize(), sun = up.dot(b.lightDir);
        const t = Math.min(1, Math.max(0, (sun + 0.03) / 0.15));
        glare = t * t * (3 - 2 * t) * (1 - alt / hLim);
      }
    }
    const starTarget = Math.max(0.0003, Math.pow(1 - day, 2.5) * (1 - 0.993 * glare));
    // A thick sky is already bright; boost thin ones more.
    // Dust counts as thick air here: its sky is already bright.
    const dens = b && b.def.atmosphere ? (b.def.atmosphere.density || 1) + (DUST[b.def.id] ? DUST[b.def.id].tau * 4 : 0) : 1;
    const expTarget = 1 + (2.0 * day) / Math.max(1, dens * 1.6);
    // Temporal adaptation: the eye stops down quickly in bright light (~0.4 s)
    // and opens up slowly in the dark (~2.5 s); a jump (a jump to another
    // world) resets it.
    const dt = Math.min(0.1, frameCtx.dt || 0.016), ad = adaptState;
    if (ad.body !== b || ad.star === undefined) { ad.body = b; ad.star = starTarget; ad.exp = expTarget; }
    const k = (tgt, cur, upTau, downTau) => cur + (tgt - cur) * (1 - Math.exp(-dt / (tgt > cur ? upTau : downTau)));
    ad.star = k(starTarget, ad.star, 2.5, 0.4);           // stars brighten slowly, fade fast
    ad.exp = k(expTarget, ad.exp, 0.5, 2.0);
    frameCtx.starExposure = ad.star;
    frameCtx.galaxyExposure = ad.star;
    sr.renderer.toneMappingExposure = ad.exp;
    frameCtx.glare = glare;
  }
  const adaptState = {};

  // ── screen projection helpers for brackets/labels ──
  const _inv = new THREE.Quaternion(), _p = new THREE.Vector3();
  function toScreen(rel, q) {
    _inv.copy(q).invert();
    _p.set(rel[0], rel[1], rel[2]).applyQuaternion(_inv);
    const w = root.clientWidth, h = root.clientHeight;
    const t = Math.tan((sr.nearCamera.fov * Math.PI) / 360);
    if (_p.z >= 0) return { onScreen: false, dx: _p.x, dy: -_p.y };
    const sx = (_p.x / -_p.z) / (t * (w / h)), sy = (_p.y / -_p.z) / t;
    const x = (sx * 0.5 + 0.5) * w, y = (0.5 - sy * 0.5) * h;
    const on = x > 0 && x < w && y > 0 && y < h;
    return { onScreen: on, x, y, dx: x - w / 2, dy: y - h / 2 };
  }
  function updateTargetHud(cam, q) {
    if (!selected) { hud.setTarget(null); hud.setBracket(null); return; }
    const rel = sub(selected.pos(), cam);
    const D = Math.hypot(rel[0], rel[1], rel[2]);
    hud.setTarget(selected, Math.max(0, D - (selected.kind === "galaxy" || selected.kind === "group" ? 0 : selected.radius)));
    const p = toScreen(rel, q);
    const pr = sr.renderer.getPixelRatio();
    const rpx = (Math.asin(Math.min(1, selected.radius / Math.max(D, selected.radius))) * sr.pxPerRad) / pr;
    hud.setBracket(p, rpx + 8, fmtDistance(Math.max(0, D - (selected.kind === "galaxy" ? 0 : selected.radius))));
  }
  function updateLabels(cam, q) {
    const items = [];
    for (const b of universe.nearBodies) {
      const k = b.def.kind;
      if (k === "star" && !b.system && b.def.id !== "sun") continue;
      if (k === "moon" && b.dist > 3e9) continue;
      if ((k === "asteroid" || k === "comet") && b.dist > 3 * AU) continue;
      if (b.dist > 80 * AU) continue;
      if (b.screenR > 60) continue;
      const p = toScreen(b.rel, q);
      if (!p.onScreen) continue;
      items.push({ x: p.x, y: p.y, text: b.def.name, d: b.dist });
    }
    // Galaxies when out among them.
    if (!universe.current) {
      for (const e of universe.galaxies) {
        if (!(e.px > 6) || e.rec.procedural) continue;
        const p = toScreen(sub(e.center, cam), q);
        if (p.onScreen) items.push({ x: p.x, y: p.y, text: e.rec.common || e.rec.name, d: e.distLy * LY });
      }
    }
    // Named places below you (region packs), once you're low over a city.
    if (earthCam && earthCam.alt < 12000) {
      const eb = earth.body, surf = eb.getSurface();
      for (const { p, d } of earthRegions.nearbyPlaces(earthCam.lat, earthCam.lon, 4000 + earthCam.alt * 1.5, 10)) {
        const dir = dirFromLatLon(p.lat, p.lon), r = surf.radiusAt(dir[0], dir[1], dir[2], 0) + 25;
        const w = new THREE.Vector3(dir[0] * r, dir[1] * r, dir[2] * r).applyQuaternion(eb.quat);
        const rel = sub(eb.pos, cam);
        const sp = toScreen([rel[0] + w.x, rel[1] + w.y, rel[2] + w.z], q);
        if (sp.onScreen) items.push({ x: sp.x, y: sp.y, text: p.name, d: Math.hypot(d, earthCam.alt) });
      }
    }
    // Don't label what a nearer resolved body is hiding.
    const discs = [];
    for (const b of universe.nearBodies) {
      if (b.screenR < 8 || !b.group || !b.group.visible) continue;
      const p = toScreen(b.rel, q);
      if (p.onScreen) discs.push({ x: p.x, y: p.y, r: b.screenR / sr.renderer.getPixelRatio(), d: b.dist });
    }
    const shown = items.filter((it) => !discs.some((c) => it.d > c.d * 1.0001 && Math.hypot(it.x - c.x, it.y - c.y) < c.r));
    shown.sort((a, b) => a.d - b.d);
    hud.setLabels(shown.slice(0, 14));
  }
  function updateLens(q) {
    const off = new THREE.Vector4(0, 0, 0, 0);
    let n = 0;
    for (const b of universe.nearBodies) {
      if (b.def.kind !== "blackhole" || n > 1 || !(b.screenR > 0.6)) continue;
      const p = toScreen(b.rel, q);
      if (!p.onScreen) continue;
      const pr = sr.renderer.getPixelRatio();
      const hdev = root.clientHeight * pr;
      const shadow = b.screenR / hdev;
      sr.setLens(n++, new THREE.Vector4(p.x / root.clientWidth, 1 - p.y / root.clientHeight, shadow, shadow * 1.7));
    }
    for (; n < 2; n++) sr.setLens(n, off);
  }

  // ── teardown ──
  let exiting = false;
  function exit() {
    if (exiting) return;
    exiting = true;
    onExit();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    input.dispose();
    ac.abort();
    ambient.dispose();
    earthRegions.dispose();
    disposeSurfaceWorkers();
    shadows.dispose();
    surfMap.dispose();
    workers.dispose();
    universe.dispose();
    ship.dispose();
    streaks.dispose();
    site.dispose();
    atmoFx.dispose();
    sr.dispose();
    root.remove();
  }

  return {
    // First frame before the reveal, so the fade lands on a finished image.
    warm() { frame(performance.now()); },
    reveal() {
      root.classList.add("is-on");
      canvas.focus({ preventScroll: true });
      launchHold = settings.reducedMotion ? 0.2 : 0.9;
      if (!launch) hud.message(root.classList.contains("is-touch") ? "Tap Earth, the Moon or the Sun · Search to find anything" : "Click Earth, the Moon or the Sun · / to search · H for controls", 5200);
    },
    dispose,
    root
  };
}

// Surface data and imagery (see CREDITS.md for licences and processing).
const SURFACE_SOURCES = [
  { name: "Earth elevation: NOAA NCEI ETOPO 2022, 60″ (public domain)", url: "https://www.ncei.noaa.gov/products/etopo-global-relief-model" },
  { name: "Moon elevation: LRO LOLA LDEM_4, NASA PDS Geosciences Node (public domain)", url: "https://pds-geosciences.wustl.edu/missions/lro/lola.htm" },
  { name: "Mars elevation: MGS MOLA MEGDR, NASA PDS Geosciences Node (public domain)", url: "https://pds-geosciences.wustl.edu/missions/mgs/megdr.html" },
  { name: "Earth by day: NASA Blue Marble, Scientific Visualization Studio (public domain)", url: "https://svs.gsfc.nasa.gov/2915" },
  { name: "Earth at night: NASA Black Marble 2016 (public domain)", url: "https://earthobservatory.nasa.gov/features/NightLights" },
  { name: "Landmark coordinates: IAU Gazetteer of Planetary Nomenclature; USGS GNIS", url: "https://planetarynames.wr.usgs.gov/" },
  { name: "Mars dust optical depth: Lemmon et al. 2015, Icarus 251 (MER Pancam)", url: "https://doi.org/10.1016/j.icarus.2014.03.029" },
  { name: "Moon and Mars terrain: LRO LOLA LDEM_16/64 and 118 m; MGS MOLA MEGDR 32 px/deg and 463 m; HRSC–MOLA blend 200 m (public domain / ESA-DLR-FU Berlin via USGS)", url: "https://pds-geosciences.wustl.edu/" },
  { name: "Planetary mosaics: Viking MDIM (Mars), LROC WAC (Moon), MESSENGER MDIS (Mercury), Magellan C3-MDIR (Venus), Dawn FC (Ceres, Vesta), Galileo/Voyager (Io, Europa, Ganymede, Callisto), Cassini ISS (Titan, Enceladus, Tethys, Dione, Rhea, Iapetus), Voyager 2 (Triton), Mars Express (Phobos) — USGS Astrogeology", url: "https://astrogeology.usgs.gov/" },
  { name: "Enceladus shape: Cassini ISS shape model (Bland et al. 2019); Phobos: Mars Express HRSC DEM", url: "https://astrogeology.usgs.gov/" },
  { name: "Mars high-resolution packs: MSL Gale HiRISE DEM mosaic 1 m (sampled 25 m); Mars 2020 Jezero CTX DTM 20 m — NASA/JPL/UArizona via USGS Astrogeology (public domain)", url: "https://astrogeology.usgs.gov/" },
  { name: "Deimos and Hyperion shapes: P. Thomas small-body shape models, NASA PDS Small Bodies Node", url: "https://sbnarchive.psi.edu/pds4/non_mission/ast-sat.thomas.shape-models_V1_0/" },
  { name: "Ellipsoid shapes: Mimas (Tajeddine et al. 2014), Tethys/Dione/Rhea/Iapetus (Thomas 2010), Haumea (Ortiz et al. 2017)", url: "https://doi.org/10.1126/science.1255299" },
  { name: "Reconstructed features (labelled): IAU Gazetteer positions; Herschel (Moore et al. 2004), Iapetus ridge (Giese et al. 2008), Enceladus tiger stripes (Porco et al. 2006)", url: "https://planetarynames.wr.usgs.gov/" },
  { name: "Mimas map: Cassini ISS global basemap (NASA/JPL-Caltech/SSI, DLR), via USGS Astrogeology", url: "https://astrogeology.usgs.gov/" },
  { name: "Planetary landmark coordinates: IAU/USGS Gazetteer of Planetary Nomenclature data files", url: "https://planetarynames.wr.usgs.gov/" },
  { name: "Mercury, Venus, Ceres, Vesta, Pluto, Charon elevation: MESSENGER, Magellan, Dawn (DLR), New Horizons global DEMs via USGS Astrogeology (public domain)", url: "https://astrogeology.usgs.gov/" },
  { name: "Pluto and Charon maps: New Horizons global mosaics, USGS Astrogeology (public domain)", url: "https://astrogeology.usgs.gov/" },
  { name: "Earth regions — elevation: USGS 3D Elevation Program (public domain)", url: "https://www.usgs.gov/3d-elevation-program" },
  { name: "Earth regions — elevation (Everest): Copernicus DEM GLO-30, © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018 provided under COPERNICUS by the European Union and ESA", url: "https://spacedata.copernicus.eu/collections/copernicus-digital-elevation-model" },
  { name: "Earth regions — aerial imagery: USDA NAIP via USGS The National Map (public domain); NASA Blue Marble NG (Everest)", url: "https://www.usgs.gov/the-national-map-data-delivery" },
  { name: "Earth regions — buildings, roads, water and places: © OpenStreetMap contributors, ODbL 1.0 (extracts by Geofabrik); the derived tiles are offered under the ODbL", url: "https://www.openstreetmap.org/copyright" },
  { name: "Earth everywhere — major roads and rivers: Natural Earth 10 m (public domain); urban areas outside the region packs are procedural blocks placed in ESA WorldCover built-up land cover, not mapped buildings", url: "https://www.naturalearthdata.com/" },
  { name: "Earth city, airport and port packs outside the US: Overture Maps (release 2026-10-21.0) — buildings conflated from OpenStreetMap, Microsoft ML Building Footprints (CDLA Permissive 2.0), Google Open Buildings and Esri; roads, water, airports, ports: OpenStreetMap via Overture, ODbL 1.0", url: "https://overturemaps.org/" },
  { name: "Earth landmark registry: Wikidata (CC0) cross-checked with the OpenStreetMap API (ODbL); runway checks against OurAirports (public domain)", url: "https://www.wikidata.org/" },
  { name: "Homepage: DamagedHelmet model (Khronos glTF Sample Models; theblueturtle_, CC BY-NC 4.0; ctxwing, CC BY 4.0); fonts Inter, Space Grotesk, JetBrains Mono (SIL OFL 1.1, self-hosted); three.js (MIT, self-hosted)", url: "https://github.com/KhronosGroup/glTF-Sample-Models" },
  { name: "Worldwide prototype cells (Berlin, Chattogram, São Paulo, Nairobi, Seoul, Mexico City, Auckland, five rural areas): Overture Maps (ODbL / CDLA), Copernicus DEM GLO-30, Sentinel-2, ESA WorldCover — same sources and licences as the city packs", url: "https://overturemaps.org/" },
  { name: "Earth pack imagery (regional, 10 m): Contains modified Copernicus Sentinel data 2023–2026 — Sentinel-2 Level-2A, via the AWS Open Data registry (Earth Search, Element 84)", url: "https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice" },
  { name: "Earth pack imagery (Paris): Orthophotos © IGN — BD ORTHO, Licence Ouverte / Etalab 2.0", url: "https://geoservices.ign.fr/bdortho" },
  { name: "Earth pack imagery (Tokyo, Haneda): 国土地理院 (GSI Japan) 地理院タイル seamlessphoto を加工して作成", url: "https://maps.gsi.go.jp/development/ichiran.html" },
  { name: "Earth pack imagery (Rotterdam): Luchtfoto © Beeldmateriaal Nederland (PDOK), CC BY 4.0", url: "https://www.beeldmateriaal.nl/" },
  { name: "Earth pack imagery (JFK, LAX, Port of Los Angeles, Liberty Island): USDA NAIP via USGS The National Map (public domain)", url: "https://www.usgs.gov/the-national-map-data-delivery" },
  { name: "Earth elevation (Matterhorn, 5 m patch): swissALTI3D © swisstopo (open government data)", url: "https://www.swisstopo.admin.ch/en/height-model-swissalti3d" },
  { name: "Earth landmark models (Sydney Opera House, Harbour and Brooklyn bridges, Tower Bridge walkways, Ahsan Manzil dome, Christ the Redeemer): original approximate models from published dimensions (Banglapedia, Transport for NSW, NYC DOT, City of London, Santuário Cristo Redentor)", url: "https://www.wikidata.org/" },
  { name: "Earth vegetation — land cover: © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium (WorldCover 10 m 2021 v200, CC BY 4.0)", url: "https://esa-worldcover.org/" },
  { name: "Earth vegetation — tree canopy (US regions): NLCD 2021 Tree Canopy Cover (CONUS, v2021-4), USDA Forest Service, via MRLC (public domain)", url: "https://www.mrlc.gov/data/nlcd-2021-usfs-tree-canopy-cover-conus" },
  { name: "Earth vegetation — mapped trees, tree rows, woods, parks, orchards: © OpenStreetMap contributors, ODbL 1.0", url: "https://www.openstreetmap.org/copyright" },
  { name: "Polygon triangulation: earcut (Mapbox), ISC licence", url: "https://github.com/mapbox/earcut" }
];

const CAMERA_LABEL = { chase: "THIRD PERSON", cockpit: "COCKPIT", free: "FREE OBSERVER" };

function sunDirFor(universe, pos) {
  const d = sub(universe.sun.def.pos, pos);
  return new THREE.Vector3(d[0], d[1], d[2]).normalize();
}

function failure(root, text, onExit, ac) {
  root.classList.add("is-on");
  const box = document.createElement("div");
  box.className = "sx-error";
  box.innerHTML = "<div><p>" + text + '</p><button class="sx-btn sx-exit" type="button">Return to portfolio</button></div>';
  root.appendChild(box);
  box.querySelector("button").addEventListener("click", () => onExit(), { signal: ac.signal });
  return {
    warm() {}, reveal() {}, root,
    dispose() { ac.abort(); root.remove(); }
  };
}

// The transition layer (entry.js) normally loads this first and removes it
// after the exit animation; loading here too keeps create() self-sufficient.
function loadCss() {
  if (document.querySelector('link[data-sx-css]')) return Promise.resolve();
  return new Promise((resolve) => {
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = CSS_URL; l.dataset.sxCss = "1";
    l.onload = () => resolve(); l.onerror = () => resolve();
    document.head.appendChild(l);
  });
}
