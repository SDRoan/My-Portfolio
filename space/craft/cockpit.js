// The interceptor's cockpit interior, built in the same frame as the hull so
// the pilot's eye sits inside the canopy you see from outside.
//
// Geometry (metres, craft frame, forward −Z): the pilot sits on the deck under
// the bubble canopy with the eye at (0, 1.52, −6.2), about 18 cm below the
// glass. In front: a glare shield over three instrument screens on an
// instrument panel; a holographic HUD combiner above it; side consoles with a
// throttle lever; a centre stick; the seat behind; the canopy's inner frame.
//
// The screens are CanvasTextures redrawn at most ~8 times a second and only
// when their content changes.

import * as THREE from "three";

export const EYE = new THREE.Vector3(0, 1.52, -6.2);
// HUD combiner size and distance ahead of the eye (m). The ladder is drawn
// conformal: a line at angle θ from the boresight sits HUD_DIST·tan θ from the
// centre, so the HUD horizon lies on the real one (±9.8° fits on the glass).
const HUD_W = 0.4, HUD_H = 0.26, HUD_DIST = 0.75;

class Screen {
  constructor(w, h, pxW, pxH, additive) {
    this.c = document.createElement("canvas");
    this.c.width = pxW; this.c.height = pxH;
    this.g = this.c.getContext("2d");
    this.tex = new THREE.CanvasTexture(this.c);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    // "overlay": a transparent canvas drawn over the view (the HUD).
    this.mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: !!additive, depthWrite: !additive, toneMapped: false,
      blending: additive === true ? THREE.AdditiveBlending : THREE.NormalBlending });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), this.mat);
    this.key = "";
  }
  // draw(fn) only repaints when `key` (a summary of the content) changes.
  draw(key, fn) {
    if (key === this.key) return;
    this.key = key;
    fn(this.g, this.c.width, this.c.height);
    this.tex.needsUpdate = true;
  }
  dispose() { this.tex.dispose(); this.mat.dispose(); this.mesh.geometry.dispose(); }
}

export class Cockpit {
  // canopyAt(z) → the glass cross-section { w, base, h } at station z.
  constructor(parent, canopyGeo, canopyAt) {
    this.group = new THREE.Group();
    this.owned = [];
    const own = (o) => { this.owned.push(o); return o; };
    const M = {
      shell: own(new THREE.MeshStandardMaterial({ color: 0x23272e, metalness: 0.3, roughness: 0.75, side: THREE.DoubleSide })),
      panel: own(new THREE.MeshStandardMaterial({ color: 0x343a43, metalness: 0.35, roughness: 0.6 })),
      dark: own(new THREE.MeshStandardMaterial({ color: 0x101317, metalness: 0.2, roughness: 0.85 })),
      frame: own(new THREE.MeshStandardMaterial({ color: 0x5d6570, metalness: 0.7, roughness: 0.35 })),
      seat: own(new THREE.MeshStandardMaterial({ color: 0x1a1d22, metalness: 0.1, roughness: 0.9 })),
      glow: own(new THREE.MeshBasicMaterial({ color: new THREE.Color(0x3fd4ff).multiplyScalar(0.9), toneMapped: false })),
      warm: own(new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffd28a).multiplyScalar(0.8), toneMapped: false }))
    };
    const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
      own(geo);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
      this.group.add(m);
      return m;
    };
    // Cockpit deck and side walls up to the sill.
    add(new THREE.PlaneGeometry(1.3, 3.0), M.shell, 0, 0.9, -6.4, -Math.PI / 2);
    for (const s of [-1, 1]) add(new THREE.PlaneGeometry(3.0, 0.22), M.shell, s * 0.66, 0.98, -6.4, 0, s * Math.PI / 2);
    // Seat: cushion, back and headrest behind the eye.
    add(new THREE.BoxGeometry(0.52, 0.1, 0.5), M.seat, 0, 1.0, -5.95);
    add(new THREE.BoxGeometry(0.52, 0.62, 0.1), M.seat, 0, 1.33, -5.62, -0.2);
    add(new THREE.BoxGeometry(0.3, 0.16, 0.12), M.seat, 0, 1.6, -5.55, -0.2);
    // Instrument panel: a console body, its angled face, and a glare shield.
    add(new THREE.BoxGeometry(1.14, 0.42, 0.5), M.panel, 0, 1.1, -7.35);
    add(new THREE.BoxGeometry(1.14, 0.3, 0.06), M.panel, 0, 1.22, -7.08, -0.5);
    add(new THREE.BoxGeometry(1.18, 0.035, 0.34), M.dark, 0, 1.39, -7.2, 0.08);
    // Centre console between the knees.
    add(new THREE.BoxGeometry(0.24, 0.3, 0.6), M.panel, 0, 1.05, -6.75);
    // Side consoles along the sills, with a throttle on the left.
    for (const s of [-1, 1]) {
      add(new THREE.BoxGeometry(0.18, 0.09, 1.3), M.panel, s * 0.52, 1.13, -6.1);
      for (let k = 0; k < 4; k++) add(new THREE.BoxGeometry(0.03, 0.01, 0.05), k % 2 ? M.glow : M.warm, s * (0.48 + (k % 2) * 0.07), 1.18, -6.5 + Math.floor(k / 2) * 0.16);
    }
    this.throttle = add(new THREE.BoxGeometry(0.04, 0.12, 0.05), M.frame, -0.52, 1.24, -5.95);
    // Centre stick with grip.
    this.stick = new THREE.Group();
    const shaft = add(new THREE.CylinderGeometry(0.016, 0.022, 0.34, 10), M.frame, 0, 0.17, 0);
    const grip = add(new THREE.BoxGeometry(0.05, 0.09, 0.045), M.dark, 0, 0.37, 0);
    this.group.remove(shaft, grip);
    this.stick.add(shaft, grip);
    this.stick.position.set(0, 0.92, -6.48);
    this.group.add(this.stick);
    // Canopy frame, just inside the glass: the windscreen bow ahead (its
    // crown ~5° below the eye line, framing the view over the glare shield),
    // the hoop behind the head, and the sills.
    const arch = (z, r) => {
      const c = canopyAt(z), pts = [];
      for (let i = 0; i <= 16; i++) { const a = (i / 16) * Math.PI; pts.push(new THREE.Vector3(Math.cos(a) * c.w * 0.96, c.base + Math.sin(a) * c.h * 0.96, z)); }
      return add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 32, r, 6, false), M.frame, 0, 0, 0);
    };
    arch(-7.6, 0.03);
    arch(-5.75, 0.022);
    for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.05, 0.05, 3.4), M.frame, s * 0.68, 1.02, -6.6);
    // A faint inner reflection on the canopy glass.
    this.innerGlass = new THREE.Mesh(canopyGeo, own(new THREE.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.05, side: THREE.BackSide, depthWrite: false })));
    this.innerGlass.scale.setScalar(0.995);
    this.group.add(this.innerGlass);

    // Instrument screens on the dashboard face (tilted toward the pilot).
    this.screens = {
      nav: new Screen(0.34, 0.2, 384, 226), flight: new Screen(0.34, 0.2, 384, 226), ship: new Screen(0.34, 0.2, 384, 226)
    };
    [["nav", -0.38], ["flight", 0], ["ship", 0.38]].forEach(([k, x]) => {
      const m = this.screens[k].mesh;
      m.position.set(x, 1.225, -7.045); m.rotation.x = -0.5;
      this.group.add(m);
    });
    // HUD combiner: an additive projection above the glare shield, square to
    // the eye line and centred on it, so its symbology can be conformal.
    this.hud = new Screen(HUD_W, HUD_H, 640, 418, "overlay");
    this.hud.mesh.position.set(0, EYE.y, EYE.z - HUD_DIST);
    this.group.add(this.hud.mesh);
    // Soft instrument light so the interior stays readable at night.
    this.light = new THREE.PointLight(0x7fd8ff, 0.9, 2.5, 2);
    this.light.position.set(0, 1.38, -6.7);
    this.group.add(this.light);
    parent.add(this.group);
  }

  // Stick and throttle follow the pilot's inputs.
  animate(pitch, yaw, roll, throttle) {
    this.stick.rotation.set(-pitch * 0.35, 0, -(roll + yaw) * 0.3);
    this.throttle.position.z = -6.1 - throttle * 0.12;
  }

  // s: { nav:{…}, flight:{…}, ship:{…}, hud:{…} } — strings and numbers.
  update(s) {
    const head = (g, w, h, title) => {
      g.fillStyle = "#060b12"; g.fillRect(0, 0, w, h);
      g.strokeStyle = "rgba(63,212,255,0.45)"; g.lineWidth = 2; g.strokeRect(3, 3, w - 6, h - 6);
      g.fillStyle = "#3fd4ff"; g.font = "600 20px ui-monospace, Menlo, monospace"; g.fillText(title, 14, 30);
      g.fillStyle = "rgba(63,212,255,0.3)"; g.fillRect(14, 38, w - 28, 1);
    };
    const rows = (g, list, y0 = 66) => {
      g.font = "17px ui-monospace, Menlo, monospace";
      list.forEach(([k, v], i) => {
        g.fillStyle = "rgba(170,200,230,0.75)"; g.fillText(k, 14, y0 + i * 30);
        g.fillStyle = "#e8f3ff"; g.textAlign = "right"; g.fillText(v, 370, y0 + i * 30); g.textAlign = "left";
      });
    };
    const scr = this.screens;
    const navRows = [["BODY", s.nav.body], ["TARGET", s.nav.target], ["DIST", s.nav.dist], ["LAT", s.nav.lat], ["LON", s.nav.lon]];
    scr.nav.draw(JSON.stringify(navRows), (g, w, h) => { head(g, w, h, "NAVIGATION"); rows(g, navRows); });
    const fl = [["SPEED", s.flight.speed], ["ALT", s.flight.alt], ["V/S", s.flight.vs], ["THRUST", s.flight.thrust], ["REGIME", s.flight.regime]];
    scr.flight.draw(JSON.stringify(fl), (g, w, h) => { head(g, w, h, "FLIGHT"); rows(g, fl); });
    const sh = [["ENGINES", s.ship.engines], ["VIEW", s.ship.view], ["GEAR", s.ship.gear], ["MEDIUM", s.ship.medium], ["GRAVITY", s.ship.gravity]];
    scr.ship.draw(JSON.stringify(sh), (g, w, h) => { head(g, w, h, "SHIP"); rows(g, sh); });
    this.drawHud(s.hud);
  }

  drawHud(H) {
    const key = [H.heading, H.pitch, H.roll, H.speed, H.alt, H.target, H.dist, H.landing].map((v) => (typeof v === "number" ? v.toFixed(1) : v)).join("|");
    this.hud.draw(key, (g, w, h) => {
      g.clearRect(0, 0, w, h);
      const cx = w / 2, cy = h / 2;
      // A dark halo under every line and glyph keeps the symbology readable
      // against a bright daytime sky as well as against space.
      g.shadowColor = "rgba(0,10,16,1)"; g.shadowBlur = 6;
      g.strokeStyle = "rgba(110,255,215,0.95)"; g.fillStyle = "rgba(150,255,225,1)";
      g.lineWidth = 2.5; g.font = "600 20px ui-monospace, Menlo, monospace"; g.textAlign = "center";
      // Horizon and pitch ladder against the true horizon of the nearest body.
      if (H.pitch !== null) {
        g.save(); g.translate(cx, cy); g.rotate(-H.roll * Math.PI / 180);
        const pxTan = HUD_DIST * h / HUD_H, D = Math.PI / 180;
        for (let p = -90; p <= 90; p += 5) {
          const a = (H.pitch - p) * D;
          if (Math.abs(a) > 1.2) continue;
          const y = Math.tan(a) * pxTan;
          if (Math.abs(y) > h / 2 - 24) continue;
          const half = p === 0 ? 240 : p % 10 ? 34 : 60;
          g.globalAlpha = p === 0 ? 0.95 : 0.6;
          g.setLineDash(p < 0 ? [8, 6] : []);       // below the horizon: dashed
          g.beginPath(); g.moveTo(-half, y); g.lineTo(-22, y); g.moveTo(22, y); g.lineTo(half, y); g.stroke();
          if (p && p % 10 === 0) { g.fillText(String(Math.abs(p)), -half - 20, y + 6); g.fillText(String(Math.abs(p)), half + 20, y + 6); }
        }
        g.setLineDash([]);
        g.restore(); g.globalAlpha = 1;
      }
      // Boresight.
      g.beginPath(); g.arc(cx, cy, 10, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.moveTo(cx - 28, cy); g.lineTo(cx - 14, cy); g.moveTo(cx + 14, cy); g.lineTo(cx + 28, cy); g.stroke();
      // Heading tape.
      if (H.heading !== null) {
        g.textAlign = "center"; g.fillText("HDG " + String(Math.round(H.heading)).padStart(3, "0"), cx, 28);
      }
      g.textAlign = "left"; g.fillText(H.speed, 16, cy + 6);
      g.textAlign = "right"; g.fillText(H.alt, w - 16, cy + 6);
      g.textAlign = "center";
      if (H.target) g.fillText(H.target + "  " + H.dist, cx, h - 46);
      if (H.landing) { g.fillStyle = H.landing.indexOf("UNSAFE") >= 0 ? "rgba(255,170,90,0.95)" : "rgba(140,255,180,0.95)"; g.fillText(H.landing, cx, h - 18); }
      if (H.roll !== null) { g.fillStyle = "rgba(160,245,255,0.7)"; g.font = "15px ui-monospace, Menlo, monospace"; g.fillText("ROLL " + Math.round(H.roll) + "°   PITCH " + Math.round(H.pitch) + "°", cx, 52); }
    });
  }

  dispose() {
    Object.values(this.screens).forEach((s) => s.dispose());
    this.hud.dispose();
    this.owned.forEach((o) => o.dispose && o.dispose());
    this.group.removeFromParent();
  }
}
