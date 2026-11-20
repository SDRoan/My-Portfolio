// Graphics presets, chosen automatically on first launch and overridable in
// settings. The choice (and other settings) persist in localStorage, which
// may be unavailable — every access is guarded.

export const PRESETS = {
  low: {
    label: "Low", pixelRatio: 1, bloom: false, mwParticles: 70000, galaxyParticles: 12000,
    sphereSeg: 48, terrainDepth: 9, chunkRes: 17, atmoSteps: 4, nebulaParticles: 1500,
    sectorRadius: [1, 1, 1], bump: false, procGalaxyCells: 2,
    // Surface: local shadow cascades (0 = off), shadow map size, rock density
    // factor, Earth map-tile reach factor, surface-worker job cap.
    shadowCascades: 0, shadowSize: 1024, rockDensity: 0.4, cityReach: 0.6
  },
  medium: {
    label: "Medium", pixelRatio: 1.25, bloom: true, mwParticles: 160000, galaxyParticles: 30000,
    sphereSeg: 64, terrainDepth: 12, chunkRes: 25, atmoSteps: 6, nebulaParticles: 3000,
    sectorRadius: [2, 1, 2], bump: true, procGalaxyCells: 2,
    shadowCascades: 1, shadowSize: 1024, rockDensity: 0.7, cityReach: 0.8
  },
  high: {
    label: "High", pixelRatio: 1.75, bloom: true, mwParticles: 300000, galaxyParticles: 60000,
    sphereSeg: 96, terrainDepth: 15, chunkRes: 33, atmoSteps: 8, nebulaParticles: 6000,
    sectorRadius: [2, 1, 2], bump: true, procGalaxyCells: 3,
    shadowCascades: 2, shadowSize: 2048, rockDensity: 1, cityReach: 1
  },
  ultra: {
    label: "Ultra", pixelRatio: 2, bloom: true, mwParticles: 500000, galaxyParticles: 120000,
    sphereSeg: 128, terrainDepth: 17, chunkRes: 33, atmoSteps: 12, nebulaParticles: 10000,
    sectorRadius: [3, 1, 2], bump: true, procGalaxyCells: 3,
    shadowCascades: 3, shadowSize: 2048, rockDensity: 1.25, cityReach: 1.2
  }
};

const KEY = "sx-settings-v1";

export function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (e) { s = {}; }
  return {
    quality: PRESETS[s.quality] ? s.quality : detectQuality(),
    reducedMotion: typeof s.reducedMotion === "boolean" ? s.reducedMotion
      : !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches),
    invertY: !!s.invertY,
    sensitivity: typeof s.sensitivity === "number" ? s.sensitivity : 1,
    muted: s.muted !== false,
    orbits: s.orbits === true,
    labels: s.labels !== false,
    autoQuality: s.autoQuality !== false,
    shake: s.shake !== false
  };
}
export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* storage unavailable */ }
}

export function detectQuality() {
  const touch = matchMedia("(pointer: coarse)").matches;
  const small = Math.min(screen.width, screen.height) < 700;
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4;
  if (touch && small) return cores >= 8 && mem >= 6 ? "medium" : "low";
  if (cores <= 4 || mem <= 4) return "medium";
  return "high";
}

// Watches frame times and steps quality down when a device can't keep up.
export class FrameMonitor {
  constructor() { this.samples = []; this.cooldown = 4; }
  push(dt) {
    this.samples.push(dt);
    if (this.samples.length > 120) this.samples.shift();
    this.cooldown -= dt;
  }
  // Returns "down" when sustained frame time is over ~45 ms (< 22 fps).
  verdict() {
    if (this.cooldown > 0 || this.samples.length < 120) return null;
    const avg = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
    if (avg > 0.045) { this.cooldown = 8; this.samples.length = 0; return "down"; }
    return null;
  }
}
