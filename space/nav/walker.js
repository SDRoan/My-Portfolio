// Walking on a surface after leaving the craft.
//
// The walker lives in the body's frame: "up" is away from the body's centre,
// the ground is the body's real surface (surfaces.js — the same shape the
// terrain and the craft's collision use), and gravity is the body's surface
// gravity. Walking speed is human (1.4 m/s, 3.5 m/s with Shift); gravity sets
// how high a jump goes and how long a fall takes — about 0.5 m on Earth,
// 1.3 m on Mars, 3 m on the Moon for the same push.

import * as THREE from "three";
import { sub } from "../engine/coords.js";

const EYE = 1.68, PUSH = 3.1;

export class Walker {
  constructor() {
    this.pos = null;
    this.vel = new THREE.Vector3();
    this.fwd = new THREE.Vector3();          // horizontal heading (world)
    this.pitch = 0;
    this.grounded = true;
    this.body = null;
    this.quat = new THREE.Quaternion();
    this.lastSpeed = 0;
  }
  start(body, upos, heading) {
    this.body = body;
    this.pos = upos.clone();
    this.vel.set(0, 0, 0);
    this.fwd.copy(heading);
    this.pitch = -0.08;
    this.settle();
  }
  up() { const r = sub(this.pos, this.body.pos); const l = Math.hypot(r[0], r[1], r[2]); return _u.set(r[0] / l, r[1] / l, r[2] / l); }
  // Put the eye at standing height on the ground.
  settle() {
    const g = this.body.groundAt(this.pos);
    const U = _u2.set(g.up[0], g.up[1], g.up[2]);
    this.pos.add(U.x * (EYE - g.alt), U.y * (EYE - g.alt), U.z * (EYE - g.alt));
  }
  gravity() {
    const e = this.body.def.surfaceEntry;
    return e && e.gravity ? e.gravity : 9.81;
  }
  // Rotation of the planet under us (applied by the frame follower).
  rotateWith(dq) { this.fwd.applyQuaternion(dq); this.vel.applyQuaternion(dq); }

  update(dt, input, settings) {
    const look = input.takeLook();
    const U = this.up().clone();
    // Look: yaw about local up, pitch clamped.
    const sens = 0.0022 * (settings.sensitivity || 1);
    let yaw = -look.dx * sens;
    if (input.down("ArrowLeft")) yaw += 1.5 * dt;
    if (input.down("ArrowRight")) yaw -= 1.5 * dt;
    this.fwd.applyAxisAngle(U, yaw);
    this.fwd.addScaledVector(U, -this.fwd.dot(U)).normalize();
    this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch - look.dy * sens * (settings.invertY ? -1 : 1)));
    const right = _r.crossVectors(this.fwd, U).normalize();
    // Move: walking pace, with acceleration limited by traction (weaker
    // where gravity is weak — you can't push off the ground as hard).
    const g = this.gravity();
    const fw = (input.down("w") ? 1 : 0) - (input.down("s") ? 1 : 0) + input.touchMove.y;
    const rt = (input.down("d") ? 1 : 0) - (input.down("a") ? 1 : 0) + input.touchMove.x;
    const speed = input.down("Shift") ? 3.5 : 1.4;
    const wish = _w.copy(this.fwd).multiplyScalar(fw).addScaledVector(right, rt);
    if (wish.lengthSq() > 1) wish.normalize();
    wish.multiplyScalar(speed);
    const vr = this.vel.dot(U);
    const vh = this.vel.clone().addScaledVector(U, -vr);
    const accel = this.grounded ? Math.min(10, 1.2 * g + 0.6) : 0.4;
    vh.lerp(wish, 1 - Math.exp(-dt * accel));
    let vUp = vr - g * dt;
    if (this.grounded && (input.jump || input.touchLift > 0)) { vUp = PUSH; this.grounded = false; }
    input.jump = false;
    this.vel.copy(vh).addScaledVector(U, vUp);
    const before = this.pos.clone();
    this.pos.add(this.vel.x * dt, this.vel.y * dt, this.vel.z * dt);
    // Buildings (Earth map data): their footprint stops you below the roof.
    if (this.blocker && this.blocker(this.pos)) {
      this.pos.set(before);
      this.vel.addScaledVector(U, -this.vel.dot(U)).multiplyScalar(-0.2).addScaledVector(U, Math.min(0, vUp));
      this.bumped = true;
    }
    const gr = this.body.groundAt(this.pos);
    if (gr.water) {                            // the shoreline stops you
      this.pos.set(before);
      this.vel.set(0, 0, 0);
    } else if (gr.alt < EYE) {
      const U2 = _u2.set(gr.up[0], gr.up[1], gr.up[2]);
      this.pos.add(U2.x * (EYE - gr.alt), U2.y * (EYE - gr.alt), U2.z * (EYE - gr.alt));
      if (this.vel.dot(U2) < 0) this.vel.addScaledVector(U2, -this.vel.dot(U2));
      this.grounded = true;
    } else this.grounded = gr.alt < EYE + 0.05;
    this.lastSpeed = this.vel.length();
    this.altitude = gr.alt - EYE;
    // Camera orientation: heading + pitch in the local frame.
    const lookDir = this.fwd.clone().multiplyScalar(Math.cos(this.pitch)).addScaledVector(U, Math.sin(this.pitch));
    this.quat.setFromRotationMatrix(_m.lookAt(_o, lookDir, U));
    return gr;
  }
}
const _u = new THREE.Vector3(), _u2 = new THREE.Vector3(), _r = new THREE.Vector3(), _w = new THREE.Vector3(), _m = new THREE.Matrix4(), _o = new THREE.Vector3();
