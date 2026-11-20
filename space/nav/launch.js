// The launch: a real-time, scripted ascent of the actual craft through the
// actual Earth scene — pad → liftoff → climb through the cloud deck → upper
// atmosphere → low Earth orbit — then control passes to the player.
//
// Everything is computed in the Earth's own frame (the pad turns with the
// planet), in float64, and handed to the navigator as a universe position,
// so the floating origin follows the craft the whole way up.
//
// Profile (normal motion, 15 s):
//   0.0–1.5  systems online: cores light, nav lights on
//   1.5–3.0  thrust building: glow, dust, slight vibration
//   3.0–5.0  liftoff: vertical rise to ~35 m, gear stows
//   5.0–8.0  ascent: nose pitches up, climb to ~3 km
//   8.0–12   atmospheric climb: through the clouds (~7 km) to ~100 km
//   12–15    space: pitch toward the horizon, low Earth orbit at ~400 km
// The real trip to orbit takes about eight minutes; this one is compressed
// and labelled as such. Reduced motion: the same path in 7 s, no shake.

import * as THREE from "three";

const STAGES = [
  [0, "SYSTEMS ONLINE"], [1.5, "THRUST BUILDING"], [3, "LIFTOFF"], [5, "ASCENT"],
  [8, "ATMOSPHERIC CLIMB"], [10.5, "UPPER ATMOSPHERE"], [12.5, "ORBITAL NAVIGATION ONLINE"]
];
const ss = (a, b, t) => { const x = Math.min(1, Math.max(0, (t - a) / (b - a))); return x * x * (3 - 2 * x); };

export class Launch {
  constructor({ earth, site, nav, ship, reduced }) {
    this.earth = earth; this.site = site; this.nav = nav; this.ship = ship;
    this.T = 15;
    this.rate = reduced ? 15 / 7 : 1;
    this.t = 0;
    this.done = false;
    this.rest = -ship.gearBottom + 0.02;                // craft centre above the pad top on its gear
  }
  stage() { let s = STAGES[0][1]; for (const [t, n] of STAGES) if (this.t >= t) s = n; return s; }

  // Height above the pad (m) and distance flown downrange to the east (m).
  profile(t) {
    let h;
    if (t < 3) h = 0;
    else if (t < 5) h = 35 * ss(3, 5, t);
    else if (t < 8) h = 35 + (3000 - 35) * Math.pow((t - 5) / 3, 2.2);
    else if (t < 12) h = 3000 * Math.pow(100000 / 3000, (t - 8) / 4);
    else h = 100000 * Math.pow(4, Math.min(1, (t - 12) / 3));
    const x = t < 5.5 ? 0 : 650000 * Math.pow(Math.min(1, (t - 5.5) / 9.5), 2.6);
    return { h, x };
  }
  // World pose at time t: position (UPos), forward and up (world unit vectors).
  pose(t) {
    const F = this.site.frame;                      // from LaunchSite.locate
    const R = this.site.ground + 2.2 + this.rest;   // pad top + resting height
    const { h, x } = this.profile(t);
    const phi = x / R;                              // along the east great circle
    const up0 = F.upLocal, east0 = F.eastLocal;
    const dir = up0.clone().multiplyScalar(Math.cos(phi)).addScaledVector(east0, Math.sin(phi)).normalize();
    const local = dir.clone().multiplyScalar(R + h);
    const world = local.clone().applyQuaternion(this.earth.quat);
    const pos = this.earth.pos.clone().add(world.x, world.y, world.z);
    return { pos, dir, local };
  }

  // Advance and drive the navigator; returns the state for effects/HUD.
  update(dt) {
    if (this.done) return null;
    this.t = Math.min(this.T, this.t + dt * this.rate);
    const t = this.t;
    const p = this.pose(t), q = this.pose(Math.min(this.T, t + 0.05));
    const upW = p.dir.clone().applyQuaternion(this.earth.quat);
    const eastW = this.site.frame.eastLocal.clone().applyQuaternion(this.earth.quat);
    // Heading: level and facing east on the pad; then along the flight path.
    const vel = new THREE.Vector3().subVectors(q.local, p.local).applyQuaternion(this.earth.quat);
    const along = vel.lengthSq() > 1e-6 ? vel.normalize() : eastW.clone();
    const k = ss(4.6, 6.2, t);
    const level = eastW.clone().addScaledVector(upW, -eastW.dot(upW)).normalize();
    const fwd = level.clone().lerp(along, k).normalize();
    const upP = upW.clone().addScaledVector(fwd, -upW.dot(fwd)).normalize();
    this.nav.pos.set(p.pos);
    this.nav.quat.setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), fwd, upP));
    this.nav.vel.set(0, 0, 0);
    // The path is time-compressed, so its rate of change isn't a speed. Show
    // the speed a real ascent has at this height instead (≈0.4 km/s at 3 km,
    // ≈3.3 km/s at 100 km, 7.67 km/s in a 400 km orbit).
    const hNow = this.profile(t).h;
    this.nav.lastSpeed = hNow < 0.5 ? 0 : 7670 * Math.pow(Math.min(1, hNow / 400000), 0.6);
    this.nav.regime = t < 3 ? "PRE-LAUNCH" : t < 12 ? "ATMOSPHERIC ASCENT" : "ORBITAL INSERTION";
    this.nav.landed = false;
    const thrust = t < 1.5 ? 0.12 + 0.1 * (t / 1.5) : t < 3 ? 0.25 + 0.55 * ss(1.5, 3, t) : 1;
    const gear = 1 - ss(4.2, 5.6, t);
    const h = this.profile(t).h;
    if (t >= this.T) this.done = true;
    return { t, stage: this.stage(), thrust, boost: t > 5, gear, alt: h,
      dust: (t > 1.4 ? ss(1.4, 3.2, t) : 0) * (1 - ss(20, 80, h)), shake: (ss(1.5, 3, t) - ss(8, 11, t)) * 0.6 };
  }
}
