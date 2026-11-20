// An original launch pad, placed at real coordinates on Earth.
//
// The site is the area of Kennedy Space Center's Launch Complex 39A
// (28.6084° N, 80.6043° W) — real geography under it (ETOPO 2022 elevation,
// Blue Marble imagery), but the pad itself is an original, futuristic design:
// a visualisation around real coordinates, not a reconstruction of any
// NASA facility.
//
// Local frame (metres): +X east, +Y up (the surface normal), −Z north.
// Placed every frame relative to the camera, like everything else.

import * as THREE from "three";
import { sub, compress, UPos } from "../engine/coords.js";
import { dirFromLatLon } from "../universe/surfaces.js";

export const SITE = { lat: 28.6084, lon: -80.6043, name: "Cape Canaveral region", padTop: 2.2 };

export class LaunchSite {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.owned = [];
    const own = (o) => { this.owned.push(o); return o; };
    const concrete = own(new THREE.MeshStandardMaterial({ color: 0x6c6d69, roughness: 0.92, metalness: 0.02 }));
    const apron = own(new THREE.MeshStandardMaterial({ color: 0x444543, roughness: 0.95 }));
    const steel = own(new THREE.MeshStandardMaterial({ color: 0x9aa1a8, metalness: 0.7, roughness: 0.4 }));
    const dark = own(new THREE.MeshStandardMaterial({ color: 0x24282d, metalness: 0.4, roughness: 0.6 }));
    const mark = own(new THREE.MeshBasicMaterial({ color: new THREE.Color(0xd8e8f0).multiplyScalar(0.9) }));
    const lamp = own(new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff1d6).multiplyScalar(2.2), toneMapped: false }));
    const cyan = own(new THREE.MeshBasicMaterial({ color: new THREE.Color(0x3fd4ff).multiplyScalar(1.3), toneMapped: false }));
    const add = (geo, mat, x, y, z, rx = 0, ry = 0) => {
      own(geo);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z); m.rotation.set(rx, ry, 0);
      this.group.add(m);
      return m;
    };
    // Apron and a raised hexagonal pad with a flame trench cut across it.
    add(new THREE.CylinderGeometry(110, 115, 3, 48), apron, 0, -0.3, 0);
    add(new THREE.CylinderGeometry(34, 36, 3.4, 6), concrete, 0, 0.5, 0, 0, Math.PI / 6);
    add(new THREE.BoxGeometry(6, 0.4, 72), dark, 0, 2.05, 0);
    // Landing markings: an outer ring and a cross.
    const ring = add(new THREE.RingGeometry(22, 23, 64), mark, 0, SITE.padTop + 0.02, 0, -Math.PI / 2);
    ring.renderOrder = 1;
    add(new THREE.PlaneGeometry(1, 30), mark, 0, SITE.padTop + 0.02, 0, -Math.PI / 2);
    add(new THREE.PlaneGeometry(30, 1), mark, 0, SITE.padTop + 0.02, 0, -Math.PI / 2);
    // Edge lights around the pad (cyan) — beacons for the landing camera.
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      add(new THREE.SphereGeometry(0.35, 8, 6), cyan, Math.cos(a) * 31, SITE.padTop + 0.3, Math.sin(a) * 31);
    }
    // Four light masts.
    for (const [x, z] of [[-70, -70], [70, -70], [-70, 70], [70, 70]]) {
      add(new THREE.CylinderGeometry(0.5, 0.8, 34, 8), steel, x, 17, z);
      add(new THREE.BoxGeometry(5, 1.6, 1.2), dark, x, 34, z, 0, Math.atan2(x, z));
      add(new THREE.BoxGeometry(4.4, 1.0, 0.3), lamp, x - Math.sign(x) * 0.6, 34, z - Math.sign(z) * 0.6, 0, Math.atan2(x, z));
    }
    // A service tower north of the pad: an open lattice-like frame of beams.
    // (Not west: the craft stands facing east, and the chase camera sits west.)
    const tx = 0, tz = -60, H = 46;
    for (const [dx, dz] of [[-4, -4], [4, -4], [-4, 4], [4, 4]]) add(new THREE.BoxGeometry(0.9, H, 0.9), steel, tx + dx, H / 2, tz + dz);
    for (let y = 6; y < H; y += 8) {
      add(new THREE.BoxGeometry(9, 0.6, 0.6), steel, tx, y, tz - 4); add(new THREE.BoxGeometry(9, 0.6, 0.6), steel, tx, y, tz + 4);
      add(new THREE.BoxGeometry(0.6, 0.6, 9), steel, tx - 4, y, tz); add(new THREE.BoxGeometry(0.6, 0.6, 9), steel, tx + 4, y, tz);
    }
    add(new THREE.BoxGeometry(10, 3, 10), dark, tx, H + 1.5, tz);
    add(new THREE.SphereGeometry(0.6, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff3030 }), tx, H + 3.6, tz);
    // Dust kicked up by the engines when the craft is close to the pad.
    const N = 700;
    const pos = new Float32Array(N * 3), seed = new Float32Array(N);
    for (let i = 0; i < N; i++) seed[i] = Math.random();
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    this.dustMat = new THREE.ShaderMaterial({
      uniforms: { uT: { value: 0 }, uI: { value: 0 }, uCenter: { value: new THREE.Vector3() } },
      vertexShader: "#include <common>\n#include <logdepthbuf_pars_vertex>\nattribute float aSeed; uniform float uT, uI; uniform vec3 uCenter; varying float vA;\n" +
        "void main(){ float a = aSeed * 6.2831853 * 37.0; float life = fract(uT * (0.25 + aSeed * 0.3) + aSeed);\n" +
        " float r = 4.0 + life * (30.0 + aSeed * 40.0); vec3 p = uCenter + vec3(cos(a) * r, 0.5 + life * life * (6.0 + aSeed * 10.0), sin(a) * r);\n" +
        " vA = uI * (1.0 - life) * (0.4 + 0.6 * aSeed); vec4 mv = modelViewMatrix * vec4(p, 1.0);\n" +
        " gl_PointSize = clamp(420.0 * (1.0 + life * 2.0) / max(-mv.z, 1.0), 2.0, 64.0); gl_Position = projectionMatrix * mv;\n#include <logdepthbuf_vertex>\n}",
      fragmentShader: "#include <logdepthbuf_pars_fragment>\nvarying float vA; void main(){\n#include <logdepthbuf_fragment>\n vec2 q = gl_PointCoord * 2.0 - 1.0; float r = dot(q, q); if (r > 1.0) discard; gl_FragColor = vec4(vec3(0.78, 0.74, 0.68), vA * (1.0 - r) * (1.0 - r) * 0.22); }",
      transparent: true, depthWrite: false
    });
    this.dust = new THREE.Points(g, this.dustMat);
    this.dust.frustumCulled = false;
    this.group.add(this.dust);
    own(g); own(this.dustMat);
    this.group.visible = false;
    this.group.traverse((o) => { if (o.isMesh) o.layers.enable(3); });   // shadow casters (render/shadows.js)
    scene.add(this.group);
    this.upos = new UPos();
    this.quat = new THREE.Quaternion();
  }

  // The pad's place on the Earth for this frame. Returns its world frame.
  locate(earth) {
    const surf = earth.getSurface();
    const d = dirFromLatLon(SITE.lat, SITE.lon);
    const ground = surf.groundRadius(d[0], d[1], d[2]);      // graded ground, under the pad
    // Body-local east, up, north at the site.
    const up = new THREE.Vector3(...d);
    const east = new THREE.Vector3(-Math.sin(SITE.lon * Math.PI / 180), 0, -Math.cos(SITE.lon * Math.PI / 180));
    const north = new THREE.Vector3().crossVectors(up, east);
    this.frame = { upLocal: up.clone(), eastLocal: east.clone() };
    const local = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(east, up, north.clone().negate()));
    this.quat.copy(earth.quat).multiply(local);
    const c = up.clone().multiplyScalar(ground).applyQuaternion(earth.quat);
    this.upos.set(earth.pos).add(c.x, c.y, c.z);
    this.ground = ground;
    return { upos: this.upos, quat: this.quat, up: up.applyQuaternion(earth.quat), east: east.applyQuaternion(earth.quat), north: north.applyQuaternion(earth.quat) };
  }
  // World point at local (x east, y up, z south) metres from the pad centre.
  point(x, y, z) {
    const v = new THREE.Vector3(x, y, z).applyQuaternion(this.quat);
    return this.upos.clone().add(v.x, v.y, v.z);
  }

  update(cam, dust, t) {
    const rel = sub(this.upos, cam);
    const D = Math.hypot(rel[0], rel[1], rel[2]);
    this.group.visible = D < 3e5;
    if (!this.group.visible) return;
    const s = compress(D);
    this.group.position.set(rel[0] * s, rel[1] * s, rel[2] * s);
    this.group.quaternion.copy(this.quat);
    this.group.scale.setScalar(s);
    this.dustMat.uniforms.uT.value = t;
    this.dustMat.uniforms.uI.value = dust;
    this.dust.visible = dust > 0.01;
  }
  dispose() { this.owned.forEach((o) => o.dispose && o.dispose()); this.scene.remove(this.group); }
}
