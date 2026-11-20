// Inside an atmosphere you can't see out of: a camera-centred dome that
// replaces the sky with the atmosphere's own light.
//
//   gas/ice giants, below the cloud tops: opaque — banded cloud decks lit from
//     above, darkening with depth toward the simulation's pressure limit.
//   Venus and Titan near the surface: a translucent haze over the view.
// The colours are representative of each world; the structure is procedural.

import * as THREE from "three";
import { NOISE_GLSL, LOGDEPTH_VERT_PARS, LOGDEPTH_VERT, LOGDEPTH_FRAG_PARS, LOGDEPTH_FRAG } from "../engine/noise-glsl.js";

export const ATMO_COLORS = {
  jupiter: [[0.86, 0.74, 0.58], [0.25, 0.16, 0.1]], saturn: [[0.9, 0.82, 0.62], [0.28, 0.22, 0.12]],
  uranus: [[0.62, 0.86, 0.9], [0.08, 0.2, 0.26]], neptune: [[0.42, 0.58, 0.95], [0.04, 0.08, 0.22]],
  venus: [[0.96, 0.72, 0.38], [0.45, 0.25, 0.08]], titan: [[0.92, 0.6, 0.28], [0.32, 0.17, 0.06]]
};

export class AtmoFX {
  constructor(scene) {
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uUp: { value: new THREE.Vector3(0, 1, 0) }, uTop: { value: new THREE.Vector3(1, 1, 1) }, uDeep: { value: new THREE.Vector3() },
        uDepth: { value: 0 }, uAlpha: { value: 0 }, uSun: { value: 1 }, uT: { value: 0 }, uBands: { value: 1 } },
      vertexShader: LOGDEPTH_VERT_PARS + "varying vec3 vDir; void main(){ vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);" + LOGDEPTH_VERT + "}",
      fragmentShader: LOGDEPTH_FRAG_PARS + NOISE_GLSL + `
        uniform vec3 uUp, uTop, uDeep; uniform float uDepth, uAlpha, uSun, uT, uBands;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float e = dot(d, normalize(uUp));
          // Light falls off with depth; looking up is brighter than down.
          float light = mix(0.25, 1.0, smoothstep(-0.7, 0.8, e)) * mix(1.0, 0.12, uDepth) * uSun;
          vec3 c = mix(uDeep, uTop, smoothstep(-0.9, 0.9, e) * (1.0 - 0.7 * uDepth));
          // Cloud decks: horizontal bands that stream past as you descend.
          float band = fbm(vec3(d.xz * 2.5, e * 9.0 + uDepth * 30.0 + uT * 0.02), 9u, 4) * uBands;
          c *= 0.82 + 0.4 * band;
          gl_FragColor = vec4(c * light * 1.6, uAlpha);
        ` + LOGDEPTH_FRAG + "}",
      side: THREE.BackSide, transparent: true, depthWrite: false, depthTest: false
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(5, 48, 24), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }
  // mode: "giant" (opaque, below cloud tops) or "haze" (translucent overlay).
  set(mode, colors, depth, upWorld, sun, t) {
    const u = this.mat.uniforms;
    this.mesh.visible = !!mode;
    if (!mode) return;
    u.uTop.value.set(...colors[0]); u.uDeep.value.set(...colors[1]);
    u.uDepth.value = Math.max(0, Math.min(1, depth));
    u.uUp.value.copy(upWorld);
    u.uSun.value = sun; u.uT.value = t;
    // Opaque giants draw first, in the opaque pass, as the sky (three.js draws
    // every opaque object before any transparent one, so a transparent dome
    // would cover the craft); haze draws over the scene.
    this.mesh.renderOrder = mode === "giant" ? -10 : 50;
    this.mat.transparent = mode !== "giant";
    u.uAlpha.value = mode === "giant" ? 1 : Math.min(0.55, depth);
    u.uBands.value = mode === "giant" ? 1 : 0.4;
  }
  dispose() { this.mesh.geometry.dispose(); this.mat.dispose(); this.mesh.removeFromParent(); }
}
