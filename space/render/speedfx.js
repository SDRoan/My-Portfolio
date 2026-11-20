// Faint streaks drifting past the camera at warp-navigation speeds — a cue
// for motion when the nearest landmark is light-years away. They only appear
// above ~0.1 c, stay subtle, and are off with reduced motion.

import * as THREE from "three";

const N = 260, R = 420;                        // streaks, and the radius they live in (m)

export class SpeedStreaks {
  constructor(scene) {
    this.pts = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) this.respawn(i, null, true);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N * 6), 3));
    this.geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(N * 6), 3));
    this.mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.lines = new THREE.LineSegments(this.geo, this.mat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 6;
    this.lines.visible = false;
    scene.add(this.lines);
    this.scene = scene;
  }
  respawn(i, dir, anywhere) {
    // New streaks appear ahead (along the direction of travel) so they sweep past.
    let x, y, z;
    do { x = Math.random() * 2 - 1; y = Math.random() * 2 - 1; z = Math.random() * 2 - 1; } while (x * x + y * y + z * z > 1);
    this.pts[i * 3] = x * R; this.pts[i * 3 + 1] = y * R; this.pts[i * 3 + 2] = z * R;
    if (!anywhere && dir) { this.pts[i * 3] += dir.x * R; this.pts[i * 3 + 1] += dir.y * R; this.pts[i * 3 + 2] += dir.z * R; }
  }
  update(vel, speed, dt, reduced) {
    const c = 299792458;
    const f = reduced ? 0 : Math.min(1, Math.max(0, (Math.log10(Math.max(speed, 1) / c) + 1) / 2.5));
    this.lines.visible = f > 0.01;
    if (!this.lines.visible) return;
    const dir = vel.clone().normalize();
    const P = this.geo.attributes.position.array, C = this.geo.attributes.color.array;
    const step = (300 + 2200 * f) * dt, len = 6 + 90 * f;
    for (let i = 0; i < N; i++) {
      let x = this.pts[i * 3] - dir.x * step, y = this.pts[i * 3 + 1] - dir.y * step, z = this.pts[i * 3 + 2] - dir.z * step;
      if (x * x + y * y + z * z > R * R * 1.4) { this.respawn(i, dir, false); x = this.pts[i * 3]; y = this.pts[i * 3 + 1]; z = this.pts[i * 3 + 2]; }
      this.pts[i * 3] = x; this.pts[i * 3 + 1] = y; this.pts[i * 3 + 2] = z;
      P[i * 6] = x; P[i * 6 + 1] = y; P[i * 6 + 2] = z;
      P[i * 6 + 3] = x + dir.x * len; P[i * 6 + 4] = y + dir.y * len; P[i * 6 + 5] = z + dir.z * len;
      // Fade near the camera so nothing flashes across the lens.
      const k = 0.22 * f * Math.min(1, Math.sqrt(x * x + y * y + z * z) / 60);
      C[i * 6] = C[i * 6 + 3] = 0.75 * k; C[i * 6 + 1] = C[i * 6 + 4] = 0.85 * k; C[i * 6 + 2] = C[i * 6 + 5] = k;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }
  dispose() { this.geo.dispose(); this.mat.dispose(); this.scene.remove(this.lines); }
}
