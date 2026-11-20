// Local sun shadows near a surface.
//
// Up to three cascades — orthographic depth maps centred on the player and
// aligned with the actual Sun direction — cover about ±120 m, ±900 m and
// ±6 km. Only objects marked as casters (the craft, rocks, Earth buildings,
// the launch pad, and the terrain chunks themselves) are drawn into them,
// and never the whole planet. Receivers (terrain, buildings, roads, rocks)
// sample the cascades with a percentage-closer filter whose width and
// darkness depend on the world: hard and black on airless bodies, softer
// under Mars's dust, nearly washed out under the clouds of Venus and Titan.
//
// Render space near a surface is metres relative to the camera, so a
// cascade's matrix maps those coordinates straight to shadow-map texels.

import * as THREE from "three";

export const CASTER_LAYER = 3;
const HALF = [120, 900, 6000];

// Shared by every receiving material (same objects, so one update reaches all).
export const shadowUniforms = {
  uShOn: { value: 0 }, uShSoft: { value: 1 }, uShStrength: { value: 1 },
  uShMap0: { value: null }, uShMap1: { value: null }, uShMap2: { value: null },
  uShMat0: { value: new THREE.Matrix4() }, uShMat1: { value: new THREE.Matrix4() }, uShMat2: { value: new THREE.Matrix4() },
  uShTexel: { value: new THREE.Vector3(1, 1, 1) },         // texel size (m) per cascade
  uShSize: { value: 2048 }
};

// GLSL: 1 = fully lit, 0 = in shadow. wp: render-space position; nl: N·L.
export const SHADOW_GLSL = /* glsl */ `
  uniform float uShOn, uShSoft, uShStrength, uShSize; uniform vec3 uShTexel;
  uniform sampler2D uShMap0, uShMap1, uShMap2; uniform mat4 uShMat0, uShMat1, uShMat2;
  float shTap(sampler2D m, vec3 p, float bias, float r) {
    float s = 0.0;
    for (int i = -2; i <= 2; i++) for (int j = -2; j <= 2; j++) {
      vec2 o = vec2(float(i), float(j)) * r;
      s += (p.z - bias > texture2D(m, p.xy + o).r) ? 0.0 : 1.0;
    }
    return s / 25.0;
  }
  float localShadow(vec3 wp, float nl) {
    if (uShOn < 0.5) return 1.0;
    float slope = sqrt(max(0.0, 1.0 - nl * nl)) / max(nl, 0.15);
    for (int k = 0; k < 3; k++) {
      if (float(k) >= uShOn) break;
      mat4 M = k == 0 ? uShMat0 : k == 1 ? uShMat1 : uShMat2;
      vec3 p = (M * vec4(wp, 1.0)).xyz;
      if (p.x < 0.02 || p.x > 0.98 || p.y < 0.02 || p.y > 0.98 || p.z > 1.0) continue;
      float tex = k == 0 ? uShTexel.x : k == 1 ? uShTexel.y : uShTexel.z;
      float bias = 0.0006 * (1.0 + 2.5 * slope) * (k == 0 ? 1.0 : k == 1 ? 1.6 : 2.5);
      float r = uShSoft / uShSize * (k == 0 ? 1.0 : 0.6);
      float lit = k == 0 ? shTap(uShMap0, p, bias, r) : k == 1 ? shTap(uShMap1, p, bias, r) : shTap(uShMap2, p, bias, r);
      // Fade the last cascade out toward its edge.
      float edge = min(min(p.x, 1.0 - p.x), min(p.y, 1.0 - p.y));
      lit = mix(1.0, lit, smoothstep(0.02, 0.12, edge));
      return mix(1.0, lit, uShStrength);
    }
    return 1.0;
  }
`;

// Patch a MeshStandardMaterial (rocks) so its direct light is shadowed.
export function receiveShadows(mat) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, shadowUniforms);
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vShW;")
      .replace("#include <project_vertex>", "#include <project_vertex>\n vec4 shw = vec4(transformed, 1.0);\n #ifdef USE_INSTANCING\n shw = instanceMatrix * shw;\n #endif\n vShW = (modelMatrix * shw).xyz;");
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nvarying vec3 vShW;\n" + SHADOW_GLSL)
      .replace("#include <aomap_fragment>", "{ float shf = localShadow(vShW, 0.7); reflectedLight.directDiffuse *= shf; reflectedLight.directSpecular *= shf; }\n#include <aomap_fragment>");
  };
  mat.needsUpdate = true;
  return mat;
}

export class LocalShadows {
  constructor(renderer, scene) {
    this.renderer = renderer; this.scene = scene;
    this.targets = []; this.cams = []; this.frame = 0;
    this.depthMat = new THREE.ShaderMaterial({
      vertexShader: "void main() { vec4 p = vec4(position, 1.0);\n#ifdef USE_INSTANCING\n p = instanceMatrix * p;\n#endif\n gl_Position = projectionMatrix * modelViewMatrix * p; }",
      fragmentShader: "void main() { gl_FragColor = vec4(gl_FragCoord.z, 0.0, 0.0, 1.0); }",
      side: THREE.DoubleSide
    });
    this.cascades = 0; this.size = 0;
    this.stats = { ms: 0, calls: 0 };
    // Further caster scenes drawn with their own depth materials (instanced
    // vegetation positions its instances in its vertex shader).
    this.extra = [];
  }
  configure(cascades, size) {
    if (cascades === this.cascades && size === this.size) return;
    this.targets.forEach((t) => t.dispose());
    this.targets = []; this.cams = [];
    this.cascades = cascades; this.size = size;
    // Depth needs float precision; without float render targets, no shadows.
    if (cascades && !(this.renderer.capabilities.isWebGL2 && this.renderer.extensions.has("EXT_color_buffer_float"))) { this.cascades = 0; shadowUniforms.uShOn.value = 0; return; }
    const type = THREE.FloatType;
    shadowUniforms.uShSize.value = size;
    for (let k = 0; k < cascades; k++) {
      const t = new THREE.WebGLRenderTarget(size, size, { type, format: THREE.RedFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
      this.targets.push(t);
      const c = new THREE.OrthographicCamera(-HALF[k], HALF[k], HALF[k], -HALF[k], 1, 4 * HALF[k] + 20000);
      c.layers.set(CASTER_LAYER);
      this.cams.push(c);
      shadowUniforms["uShMap" + k].value = t.texture;
    }
    shadowUniforms.uShOn.value = 0;
  }
  // focus: render-space point to centre on; L: unit vector toward the Sun;
  // style: { soft, strength } for the current world. Returns false if off.
  update(focus, L, style, enabled) {
    if (!enabled || !this.cascades || !style) { shadowUniforms.uShOn.value = 0; return false; }
    const t0 = performance.now();
    this.frame++;
    const r = this.renderer, prevTarget = r.getRenderTarget(), prevOverride = this.scene.overrideMaterial;
    const prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
    this.scene.overrideMaterial = this.depthMat;
    r.setClearColor(0xffffff, 1);
    let calls = 0;
    const up = Math.abs(L.y) < 0.95 ? _Y : _X;
    for (let k = 0; k < this.cascades; k++) {
      // Near cascade every frame; farther ones every 2nd / 4th frame.
      if (k > 0 && this.frame % (k === 1 ? 2 : 4) !== k % 2) continue;
      const c = this.cams[k], half = HALF[k], dist = 2 * half + 10000;
      // Snap the focus to whole texels in light space so edges don't swim.
      const texel = (2 * half) / this.size;
      c.position.copy(focus).addScaledVector(L, dist);
      c.up.copy(up); c.lookAt(focus);
      c.updateMatrixWorld();
      const inv = _m.copy(c.matrixWorld).invert(), lf = _v.copy(focus).applyMatrix4(inv);
      const sx = Math.round(lf.x / texel) * texel - lf.x, sy = Math.round(lf.y / texel) * texel - lf.y;
      c.position.add(_a.set(sx, sy, 0).applyQuaternion(c.quaternion));
      c.updateMatrixWorld(); c.updateProjectionMatrix();
      r.setRenderTarget(this.targets[k]);
      r.clear(true, true, false);
      r.render(this.scene, c);
      calls += r.info.render.calls;
      if (this.extra.length) {
        const ac = r.autoClear; r.autoClear = false;
        for (const x of this.extra) { r.render(x, c); calls += r.info.render.calls; }
        r.autoClear = ac;
      }
      // world → [0,1] texture space and depth
      shadowUniforms["uShMat" + k].value.multiplyMatrices(_bias, c.projectionMatrix).multiply(c.matrixWorldInverse);
      shadowUniforms.uShTexel.value.setComponent(k, texel);
    }
    this.scene.overrideMaterial = prevOverride;
    r.setRenderTarget(prevTarget);
    r.setClearColor(prevClear, prevAlpha);
    shadowUniforms.uShOn.value = this.cascades;
    shadowUniforms.uShSoft.value = style.soft;
    shadowUniforms.uShStrength.value = style.strength;
    this.stats.ms = this.stats.ms * 0.9 + (performance.now() - t0) * 0.1;
    this.stats.calls = calls;
    return true;
  }
  dispose() { this.targets.forEach((t) => t.dispose()); this.depthMat.dispose(); shadowUniforms.uShOn.value = 0; }
}
const _Y = new THREE.Vector3(0, 1, 0), _X = new THREE.Vector3(1, 0, 0), _m = new THREE.Matrix4(), _v = new THREE.Vector3(), _a = new THREE.Vector3();
const _bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);

// Per world: filter width (texels) and how dark full shadow is (1 = only the
// sky's fill light remains).
export function shadowStyle(id, hasAtmo) {
  const S = { moon: [1, 1], mercury: [1, 1], mars: [3, 0.85], earth: [1.6, 0.8], venus: [7, 0.3], titan: [6, 0.4], pluto: [1.4, 0.95], triton: [1.4, 0.95] };
  const v = S[id] || (hasAtmo ? [2.5, 0.75] : [1, 1]);
  return { soft: v[0], strength: v[1] };
}
