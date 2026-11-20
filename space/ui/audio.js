// Optional ambient soundscape: a low, slowly breathing drone and an engine
// rumble synthesised with Web Audio — no files, nothing autoplayed. Space is
// silent; this is presentation only, and it starts muted (♪ toggles it).

export class Ambient {
  constructor() { this.ctx = null; this.on = false; }
  start() {
    if (this.on) return;
    try {
      this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) { return; }
    const c = this.ctx;
    if (c.state === "suspended") c.resume();
    this.master = c.createGain();
    this.master.gain.value = 0;
    this.master.gain.linearRampToValueAtTime(0.07, c.currentTime + 2.5);
    const lp = c.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 420; lp.Q.value = 0.6;
    lp.connect(this.master); this.master.connect(c.destination);
    this.nodes = [];
    for (const [f, g] of [[55, 0.5], [55.4, 0.4], [82.4, 0.22], [110.2, 0.12]]) {
      const o = c.createOscillator(); o.type = "sine"; o.frequency.value = f;
      const gg = c.createGain(); gg.gain.value = g;
      const lfo = c.createOscillator(); lfo.frequency.value = 0.03 + Math.random() * 0.05;
      const lg = c.createGain(); lg.gain.value = g * 0.4;
      lfo.connect(lg); lg.connect(gg.gain);
      o.connect(gg); gg.connect(lp);
      o.start(); lfo.start();
      this.nodes.push(o, lfo);
    }
    // Engine: looping noise through a low-pass whose cutoff and level follow
    // the thrust (see setEngine). Its own gain, straight to the output.
    const buf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate), ch = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < ch.length; i++) { last = last * 0.97 + (Math.random() * 2 - 1) * 0.03; ch[i] = last * 6; }   // brown-ish noise
    const src = c.createBufferSource(); src.buffer = buf; src.loop = true;
    this.engLp = c.createBiquadFilter(); this.engLp.type = "lowpass"; this.engLp.frequency.value = 120;
    this.engGain = c.createGain(); this.engGain.gain.value = 0;
    src.connect(this.engLp); this.engLp.connect(this.engGain); this.engGain.connect(c.destination);
    src.start();
    this.nodes.push(src);
    this.engOut = this.engGain;
    this.on = true;
  }
  // thrust 0…1; air 0…1 (how much atmosphere carries the sound). In vacuum
  // only a faint hum through the hull remains — space itself is silent.
  setEngine(thrust, air) {
    if (!this.on || !this.engGain) return;
    const t = this.ctx.currentTime, th = Math.max(0, Math.min(1, thrust));
    this.engGain.gain.setTargetAtTime(0.35 * th * (0.12 + 0.88 * air), t, 0.12);
    this.engLp.frequency.setTargetAtTime(90 + 520 * th * (0.3 + 0.7 * air), t, 0.15);
  }
  stop() {
    if (!this.on || !this.ctx) return;
    const c = this.ctx, nodes = this.nodes, m = this.master;
    m.gain.cancelScheduledValues(c.currentTime);
    m.gain.setValueAtTime(m.gain.value, c.currentTime);
    m.gain.linearRampToValueAtTime(0, c.currentTime + 0.8);
    const eng = this.engOut;
    if (eng) { eng.gain.cancelScheduledValues(c.currentTime); eng.gain.setValueAtTime(eng.gain.value, c.currentTime); eng.gain.linearRampToValueAtTime(0, c.currentTime + 0.8); }
    this.engGain = null;
    setTimeout(() => { nodes.forEach((n) => { try { n.stop(); } catch (e) { /* already stopped */ } }); m.disconnect(); if (eng) eng.disconnect(); }, 900);
    this.on = false;
  }
  dispose() {
    this.stop();
    const c = this.ctx;
    if (c) setTimeout(() => c.close && c.close(), 1000);
    this.ctx = null;
  }
}
