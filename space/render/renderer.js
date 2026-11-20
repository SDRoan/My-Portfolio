// Frame composition.
//
//   1. Far pass → its own HDR target. Units are light-years, the camera sits
//      at the origin, and everything is additive or multiplicative points and
//      lines with no depth: stars, galaxies, nebulae, belts, orbit lines.
//   2. Composite the far target into the frame, bending it around up to two
//      black holes (point-lens deflection, an approximation).
//   3. Near pass on top, with a logarithmic depth buffer: planets, moons,
//      stars as discs, atmospheres, rings, black holes, the spacecraft.
//   4. Optional bloom, then tone mapping and sRGB once at the end.

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { Pass, FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

class SpacePass extends Pass {
  constructor(owner) {
    super();
    this.owner = owner;
    this.needsSwap = false;
    this.quad = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: {
        tSky: { value: null }, uAspect: { value: 1 },
        uLens0: { value: new THREE.Vector4(0, 0, 0, 0) }, uLens1: { value: new THREE.Vector4(0, 0, 0, 0) }
      },
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
      fragmentShader: /* glsl */ `
        uniform sampler2D tSky; uniform float uAspect; uniform vec4 uLens0, uLens1;
        varying vec2 vUv;
        // Lens: xy screen centre (uv), z shadow radius (uv height units), w Einstein radius.
        vec2 bend(vec2 uv, vec4 L, inout float dark) {
          if (L.w <= 0.0) return uv;
          vec2 d = (uv - L.xy) * vec2(uAspect, 1.0);
          float r = length(d);
          if (r < L.z) { dark = 1.0; return uv; }
          float defl = L.w * L.w / max(r, 1e-5);
          vec2 src = d * (1.0 - defl / r);
          return L.xy + src / vec2(uAspect, 1.0);
        }
        void main() {
          float dark = 0.0;
          vec2 uv = bend(vUv, uLens0, dark);
          uv = bend(uv, uLens1, dark);
          vec3 c = texture2D(tSky, uv).rgb;
          gl_FragColor = vec4(c * (1.0 - dark), 1.0);
        }`,
      depthTest: false, depthWrite: false
    }));
  }
  render(renderer, writeBuffer, readBuffer) {
    const o = this.owner;
    renderer.setRenderTarget(o.skyTarget);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, false);
    renderer.render(o.farScene, o.farCamera);
    this.quad.material.uniforms.tSky.value = o.skyTarget.texture;
    renderer.setRenderTarget(readBuffer);
    renderer.clear(true, true, false);
    this.quad.render(renderer);
    renderer.clearDepth();
    renderer.render(o.nearScene, o.nearCamera);
  }
  dispose() { this.quad.dispose(); this.quad.material.dispose(); }
}

export class SpaceRenderer {
  constructor(canvas, quality) {
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, logarithmicDepthBuffer: true, powerPreference: "high-performance", alpha: false
    });
    if (!this.renderer.capabilities.isWebGL2) throw new Error("WebGL2 is required");
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.autoClear = false;
    // Counted across all passes of a frame; main resets once per frame.
    this.renderer.info.autoReset = false;

    this.farScene = new THREE.Scene();
    this.farCamera = new THREE.PerspectiveCamera(60, 1, 1e-14, 1e12);
    this.nearScene = new THREE.Scene();
    this.nearCamera = new THREE.PerspectiveCamera(60, 1, 0.05, 2e10);
    this.skyTarget = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false });

    this.composer = new EffectComposer(this.renderer);
    this.spacePass = new SpacePass(this);
    this.composer.addPass(this.spacePass);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.32, 0.55, 0.92);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.setQuality(quality);
  }
  setQuality(q) {
    this.quality = q;
    this.bloom.enabled = !!q.bloom;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
    if (this.w) this.resize(this.w, this.h);
  }
  resize(w, h) {
    this.w = w; this.h = h;
    this.renderer.setSize(w, h, false);
    const pr = this.renderer.getPixelRatio();
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.skyTarget.setSize(Math.floor(w * pr), Math.floor(h * pr));
    for (const cam of [this.farCamera, this.nearCamera]) { cam.aspect = w / h; cam.updateProjectionMatrix(); }
    this.spacePass.quad.material.uniforms.uAspect.value = w / h;
  }
  // Pixels per radian at the current resolution — what point sizes scale by.
  get pxPerRad() {
    const pr = this.renderer.getPixelRatio();
    return (this.h * pr) / (this.nearCamera.fov * Math.PI / 180);
  }
  setFov(f) {
    for (const cam of [this.farCamera, this.nearCamera]) { cam.fov = f; cam.updateProjectionMatrix(); }
  }
  setLens(i, v) { this.spacePass.quad.material.uniforms[i === 0 ? "uLens0" : "uLens1"].value.copy(v); }
  render(quat) {
    this.farCamera.quaternion.copy(quat);
    this.nearCamera.quaternion.copy(quat);
    this.farCamera.updateMatrixWorld();
    this.nearCamera.updateMatrixWorld();
    this.composer.render();
  }
  dispose() {
    this.composer.dispose && this.composer.dispose();
    this.spacePass.dispose();
    this.bloom.dispose();
    this.skyTarget.dispose();
    this.renderer.dispose();
    try { this.renderer.forceContextLoss(); } catch (e) { /* already lost */ }
  }
}
