// Flight. The observer's logical position is a UPos; the camera is always
// the render origin. Speed scales automatically with the distance to the
// nearest surface, so the same keys cover a walk across a crater and a
// crossing between galaxies — the mouse wheel trims the scale, Shift boosts,
// Alt creeps.
//
// Speeds above c are warp-style navigation for exploring, labelled as such;
// nothing here is a claim about real propulsion.

import * as THREE from "three";
import { UPos, sub, C, LY } from "../engine/coords.js";

export const MODES = ["free", "chase", "cockpit"];
const _f = new THREE.Vector3(), _u = new THREE.Vector3(), _w = new THREE.Vector3(), _w2 = new THREE.Vector3(), _r = new THREE.Vector3(), _cl = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m = new THREE.Matrix4(), _zero = new THREE.Vector3();

export class Navigator {
  constructor() {
    this.pos = new UPos();
    this.quat = new THREE.Quaternion();
    this.vel = new THREE.Vector3();          // m/s, render frame
    this.angVel = new THREE.Vector3();
    this.wheel = 0;                          // speed trim, powers of 2
    this.mode = "free";
    this.throttle = 0;
    this.travel = null;
    this.lastSpeed = 0;
    this.regime = "PLANETARY";
    this.landed = false;
    this.assist = false;
    this.gear = 0;              // 0 retracted … 1 down
    this.gearLength = 0;
    this.hullBox = null;
  }

  setMode(m) { this.mode = m; }
  cycleMode() { this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]; return this.mode; }

  lookAt(dir) {
    // Face a direction, keeping the current up as much as possible.
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quat);
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), dir.clone().normalize(), up);
    this.quat.setFromRotationMatrix(m);
  }

  resetOrientation() {
    // Level the roll: make the camera's up the closest thing to ecliptic north.
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.quat);
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), fwd, new THREE.Vector3(0, 1, 0));
    this.quat.setFromRotationMatrix(m);
    this.angVel.set(0, 0, 0);
  }

  // Travel toward a target: { pos: () => UPos, stop: metres, name }
  startTravel(target) {
    this.travel = { target, t: 0, aligned: false };
    this.vel.set(0, 0, 0);
  }
  cancelTravel() { this.travel = null; }

  update(dt, input, near, settings) {
    const look = input.takeLook();
    const wheel = input.takeWheel();
    if (wheel) this.wheel = Math.max(-12, Math.min(12, this.wheel - wheel));

    // ── orientation ──
    const sens = 0.0022 * (settings.sensitivity || 1);
    const inv = settings.invertY ? -1 : 1;
    const ship = this.mode !== "free";
    let yaw = -look.dx * sens, pitch = -look.dy * sens * inv, roll = 0;
    if (input.down("z")) roll += 1.4 * dt;
    if (input.down("x")) roll -= 1.4 * dt;
    this.manualRoll = input.down("z") || input.down("x");
    if (input.down("ArrowLeft")) yaw += 1.2 * dt;
    if (input.down("ArrowRight")) yaw -= 1.2 * dt;
    if (input.down("ArrowUp")) pitch += 1.0 * dt;
    if (input.down("ArrowDown")) pitch -= 1.0 * dt;
    // Landed: the craft rests on its gear; any lift (E / Up) or thrust takes off.
    if (this.landed) {
      // After boarding with E, E lifts off only once it has been released.
      if (this.boardHold && !input.down("e")) this.boardHold = false;
      const lift = (input.down("e") && !this.boardHold) || input.down("w") || input.touchLift > 0 || input.touchMove.y > 0;
      if (!lift) { this.vel.set(0, 0, 0); this.lastSpeed = 0; this.throttle = 0; this.angVel.set(0, 0, 0); this.regime = "LANDED"; return null; }
      this.landed = false;
      this.takeoffFrom = near.alt;
    }
    // In an atmosphere the craft flies like an aircraft: turning input rolls
    // the wings into a coordinated, banked turn and the craft levels itself
    // when the input stops. In vacuum there is no lift, so the bank stays a
    // visual cue only (see Spacecraft) and turns are pure yaw.
    this.inAtmo = !!near.atmoFactor && ship;
    // Real (lift) banking needs airspeed; hovering, the bank is the visual cue.
    this.realBank = this.inAtmo && this.vel.length() > 30;
    if (this.inAtmo && near.up && !this.manualRoll) {
      const k = near.atmoFactor;
      const fwd = _f.set(0, 0, -1).applyQuaternion(this.quat), upB = _u.set(0, 1, 0).applyQuaternion(this.quat);
      const U = _w.set(near.up[0], near.up[1], near.up[2]);
      const right = _r.crossVectors(fwd, U).normalize();
      const bankNow = Math.atan2(-upB.dot(right), upB.dot(U));            // + = left wing down
      // Coordinated turn: tan(bank) = airspeed × turn rate / g, up to 43°.
      const g = (near.entry && near.entry.gravity) || 9.81;
      // Too slow for lift to bank it: hold the wings level (the visual cue leans instead).
      const bankWant = this.realBank ? Math.max(-0.75, Math.min(0.75, Math.atan(this.vel.length() * this.angVel.y / g))) : 0;
      roll += (bankWant - bankNow) * Math.min(1, dt * 2.5 * k);
      yaw += Math.sin(bankNow) * 0.5 * k * dt;                             // lift turns the craft
    }
    if (ship) {
      // The craft turns with a little inertia; the free camera turns instantly.
      this.angVel.x += pitch * 6; this.angVel.y += yaw * 6; this.angVel.z += roll * 6;
      this.angVel.multiplyScalar(Math.exp(-dt * 7));
      pitch = this.angVel.x * dt; yaw = this.angVel.y * dt; roll = this.angVel.z * dt;
    }
    if (yaw || pitch || roll) {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, "YXZ"));
      this.quat.multiply(q).normalize();
    }

    // ── auto travel ──
    const moving = ["w", "a", "s", "d", "q", "e"].some((k) => input.down(k)) || input.touchMove.x || input.touchMove.y || input.touchLift;
    if (this.travel && moving) this.travel = null;
    if (this.travel) return this.updateTravel(dt, near);
    if (this.assist && moving && !input.down("q")) this.assist = false;
    if (this.assist) return this.updateLanding(dt, near);

    // ── translation ──
    const t = new THREE.Vector3(
      (input.down("d") ? 1 : 0) - (input.down("a") ? 1 : 0) + input.touchMove.x,
      (input.down("e") ? 1 : 0) - (input.down("q") ? 1 : 0) + input.touchLift,
      (input.down("s") ? 1 : 0) - (input.down("w") ? 1 : 0) - input.touchMove.y
    );
    if (t.lengthSq() > 1) t.normalize();
    this.throttle = t.length();
    let base = Math.max(1, near.scale) * 0.6;            // cover ~60% of the gap per second
    base *= Math.pow(2, this.wheel);
    if (input.down("Shift")) base *= 10;
    if (input.down("Alt") || input.down("Control")) base *= 0.1;      // precision
    base = Math.min(base, 5e9 * LY);
    // Drag: in an atmosphere top speed falls with air density.
    if (this.inAtmo) base = Math.min(base, 300 + 9000 * (1 - near.atmoFactor) + (input.down("Shift") ? 2000 : 0));
    const want = t.applyQuaternion(this.quat).multiplyScalar(base);
    if (ship) {
      // Thrust toward the wanted velocity; with no input, flight assist bleeds speed off.
      this.vel.lerp(want, 1 - Math.exp(-dt * (this.throttle > 0 ? 2.2 : 1.6)));
    } else {
      this.vel.lerp(want, 1 - Math.exp(-dt * 6));
    }
    let step = this.vel.clone().multiplyScalar(dt);
    const ev = this.collide(step, near, dt);
    this.pos.add(step.x, step.y, step.z);
    this.lastSpeed = step.length() / Math.max(dt, 1e-6);
    this.regime = regimeOf(this.lastSpeed, near);
    return ev;
  }

  // How far below its centre the craft reaches, along a world "up" — from the
  // hull's bounding box at its current attitude, plus the landing gear.
  clearance(up) {
    if (!this.hullBox) return 1.8;
    const inv = _q.copy(this.quat).invert();
    const u = _cl.set(up[0], up[1], up[2]).applyQuaternion(inv);      // own temp: callers hold _w
    const b = this.hullBox;
    let depth = 0;
    for (let i = 0; i < 8; i++) {
      const x = i & 1 ? b.max.x : b.min.x, y = i & 2 ? b.max.y : b.min.y, z = i & 4 ? b.max.z : b.min.z;
      depth = Math.max(depth, -(x * u.x + y * u.y + z * u.z));
    }
    return depth + (this.gear || 0) * this.gearLength + 0.05;
  }
  // Never sink through a surface; a gentle touch on gear counts as landing.
  collide(step, near, dt) {
    if (!near.body || !(near.dist < 3e5) || near.gas) return null;
    const n = _w2.set(near.up[0], near.up[1], near.up[2]);
    const floor = near.body.def.kind === "star" ? near.body.radius * 0.02 : this.clearance(near.up);
    const into = -step.dot(n);
    const alt = near.dist;
    if (alt - into < floor) {
      const vz = into / Math.max(dt, 1e-6);
      step.addScaledVector(n, into - (alt - floor));
      const landable = near.entry && near.entry.landable && !near.water;
      if (landable && this.gear > 0.9 && vz < 6 && this.vel.length() < 25 && this.hullBox) {
        this.landed = true; this.assist = false; this.vel.set(0, 0, 0);
        return vz > 3 ? "landed-hard" : "landed";
      }
      this.vel.addScaledVector(n, Math.max(0, -this.vel.dot(n)));
    }
    return null;
  }

  // Landing assist (L): level the wings to the local horizon, kill drift,
  // descend at a rate that slows with height, and set down on the gear.
  updateLanding(dt, near) {
    if (!near.body || !near.up || near.gas || !(near.alt < 2e4)) { this.assist = false; return "assist-off"; }
    const U = _w.set(near.up[0], near.up[1], near.up[2]);
    const fwd = _f.set(0, 0, -1).applyQuaternion(this.quat);
    fwd.addScaledVector(U, -fwd.dot(U));
    if (fwd.lengthSq() < 1e-6) fwd.set(1, 0, 0).addScaledVector(U, -U.x).normalize();
    fwd.normalize();
    const want = _q2.setFromRotationMatrix(_m.lookAt(_zero, fwd, U));
    this.quat.slerp(want, 1 - Math.exp(-dt * 2));
    const h = Math.max(0, near.dist - this.clearance(near.up));
    // Constant-deceleration approach (4 m/s²) down to a 1.2 m/s touchdown,
    // below the 3 m/s hard-landing threshold: ~18 s from 600 m.
    const vDown = Math.min(400, Math.max(1.2, Math.sqrt(8 * Math.max(0, h - 2))));
    const target = U.clone().multiplyScalar(-vDown);
    this.vel.lerp(target, 1 - Math.exp(-dt * 2.5));
    this.angVel.multiplyScalar(Math.exp(-dt * 5));
    let step = this.vel.clone().multiplyScalar(dt);
    const ev = this.collide(step, near, dt);
    this.pos.add(step.x, step.y, step.z);
    this.lastSpeed = step.length() / Math.max(dt, 1e-6);
    this.throttle = 0.35;
    this.regime = "LANDING";
    return ev;
  }

  updateTravel(dt, near) {
    const tr = this.travel;
    tr.t += dt;
    const target = tr.target.pos();
    const d = sub(target, this.pos);
    const D = Math.hypot(d[0], d[1], d[2]);
    const dir = new THREE.Vector3(d[0], d[1], d[2]).normalize();
    // Turn to face the target first; begin moving once roughly aligned.
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.quat);
    const ang = fwd.angleTo(dir);
    const want = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), dir, new THREE.Vector3(0, 1, 0).applyQuaternion(this.quat)));
    this.quat.slerp(want, 1 - Math.exp(-dt * 4));
    if (ang > 0.35 && tr.t < 1.6) { this.lastSpeed = 0; return null; }
    // Close the remaining gap exponentially: scale-free, so a hop to the Moon
    // and a crossing to Andromeda take seconds either way. Ramp in gently.
    const stop = tr.target.stop;
    const k = Math.min(2.0, 0.3 + tr.t * 0.9);
    const gap = D - stop;
    const newGap = gap * Math.exp(-k * dt);
    let move = gap - newGap;
    if (Math.abs(gap) < Math.max(stop * 0.004, 1)) {
      this.travel = null;
      this.lastSpeed = 0;
      return "arrived";
    }
    this.pos.add(dir.x * move, dir.y * move, dir.z * move);
    this.vel.copy(dir).multiplyScalar(move / dt);
    this.lastSpeed = Math.abs(move) / dt;
    this.regime = regimeOf(this.lastSpeed, near);
    this.throttle = 1;
    return null;
  }
}

function regimeOf(v, near) {
  if (near.body && near.dist < near.body.radius * 0.05 && v < 2e4) return "SURFACE";
  if (v < 3e5) return "PLANETARY";
  if (v < 0.5 * C * 1000) return "SYSTEM";
  if (v < 1e5 * LY) return "INTERSTELLAR";
  return "INTERGALACTIC";
}
