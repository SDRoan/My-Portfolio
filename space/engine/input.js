// Keyboard, mouse and touch, with every listener tied to one AbortController
// so leaving the simulator removes them all at once.
//
// Keys are ignored while focus is in a text field, so typing in search never
// flies the camera. Left-drag looks around; a click without a drag selects.
// Pointer lock is optional (M), and Esc always releases it.

export class Input {
  constructor(el) {
    this.el = el;
    this.ac = new AbortController();
    this.keys = new Set();
    this.look = { dx: 0, dy: 0 };
    this.wheel = 0;
    this.locked = false;
    this.handlers = {};          // key → callback for one-shot actions
    this.onClick = null;
    this.onEscape = null;
    this.touchMove = { x: 0, y: 0 };   // virtual stick, −1..1
    this.touchLift = 0;
    const sig = { signal: this.ac.signal };

    window.addEventListener("keydown", (e) => {
      if (isTyping(e)) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (k === "Escape") { if (this.onEscape) this.onEscape(); return; }
      // Ctrl is the precision modifier. Browsers won't let a page block
      // Ctrl+W (close tab) on Windows/Linux, so while Ctrl is held a
      // leave-page confirmation guards against closing by accident.
      if (k === "Control") { this.keys.add("Control"); this.guard(true); return; }
      if (e.metaKey) return;
      if (e.ctrlKey && !FLIGHT_KEYS.has(k)) return;
      if (!e.ctrlKey && this.handlers[k] && !e.repeat) { e.preventDefault(); this.handlers[k](e); return; }
      if (FLIGHT_KEYS.has(k) || k === "Shift" || k === "Alt") { this.keys.add(k); e.preventDefault(); }
    }, sig);
    window.addEventListener("keyup", (e) => {
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      this.keys.delete(k);
      if (k === "Shift") this.keys.delete("Shift");
      if (k === "Control") this.guard(false);
    }, sig);
    window.addEventListener("blur", () => { this.keys.clear(); this.guard(false); }, sig);
    this.onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = ""; };

    let down = null;
    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") return;
      if (e.button !== 0 && e.button !== 2) return;
      down = { x: e.clientX, y: e.clientY, moved: 0, button: e.button };
      el.setPointerCapture(e.pointerId);
    }, sig);
    el.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch") return;
      if (this.locked) { this.look.dx += e.movementX; this.look.dy += e.movementY; return; }
      if (!down) return;
      down.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
      this.look.dx += e.movementX; this.look.dy += e.movementY;
    }, sig);
    el.addEventListener("pointerup", (e) => {
      if (e.pointerType === "touch") return;
      if (down && down.moved < 5 && down.button === 0 && this.onClick) this.onClick(e.clientX, e.clientY);
      if (this.locked && this.onClick && e.button === 0) this.onClick(window.innerWidth / 2, window.innerHeight / 2);
      down = null;
    }, sig);
    el.addEventListener("contextmenu", (e) => e.preventDefault(), sig);
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.wheel += Math.sign(e.deltaY);
    }, { signal: this.ac.signal, passive: false });
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === el;
    }, sig);

    // Touch: one finger on the view looks; a tap selects. The virtual stick
    // and buttons live in the HUD and write touchMove / touchLift directly.
    let t0 = null;
    el.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      t0 = { x: t.clientX, y: t.clientY, lx: t.clientX, ly: t.clientY, moved: 0, at: performance.now() };
    }, { signal: this.ac.signal, passive: true });
    el.addEventListener("touchmove", (e) => {
      if (!t0 || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - t0.lx, dy = t.clientY - t0.ly;
      t0.lx = t.clientX; t0.ly = t.clientY;
      t0.moved += Math.abs(dx) + Math.abs(dy);
      this.look.dx += dx * 1.4; this.look.dy += dy * 1.4;
      e.preventDefault();
    }, { signal: this.ac.signal, passive: false });
    el.addEventListener("touchend", () => {
      if (t0 && t0.moved < 8 && performance.now() - t0.at < 400 && this.onClick) this.onClick(t0.x, t0.y);
      t0 = null;
    }, sig);
  }
  on(key, fn) { this.handlers[key] = fn; }
  guard(on) {
    if (on && !this.guarded) { window.addEventListener("beforeunload", this.onBeforeUnload); this.guarded = true; }
    if (!on && this.guarded) { window.removeEventListener("beforeunload", this.onBeforeUnload); this.guarded = false; }
  }
  down(k) { return this.keys.has(k); }
  takeLook() { const l = { dx: this.look.dx, dy: this.look.dy }; this.look.dx = 0; this.look.dy = 0; return l; }
  takeWheel() { const w = this.wheel; this.wheel = 0; return w; }
  toggleLock() {
    if (this.locked) document.exitPointerLock();
    else if (this.el.requestPointerLock) {
      try { const p = this.el.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* not available */ }
    }
  }
  releaseLock() { if (document.pointerLockElement) document.exitPointerLock(); }
  dispose() { this.guard(false); this.releaseLock(); this.ac.abort(); this.keys.clear(); }
}

const FLIGHT_KEYS = new Set(["w", "a", "s", "d", "q", "e", "z", "x", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}
