// The way in and out: the helmet transition, the loading sequence, and the
// return to the portfolio. Small on purpose — the simulator itself (main.js
// and everything under it) is only fetched once this starts.
//
// hooks (from the portfolio's hero scene):
//   from:     { x, y } screen position of the helmet's visor
//   setVisor: (0..1) visor emissive boost
//   setZoom:  (0..1) camera push toward the visor
//   onClosed: called when the portfolio is fully restored

const CSS_URL = new URL("./space.css", import.meta.url).href;
let active = false;

export function isActive() { return active; }

export async function launch(hooks) {
  if (active) return;
  active = true;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const scrollY = window.scrollY;
  const prevOverflow = document.documentElement.style.overflow;
  document.documentElement.style.overflow = "hidden";
  await ensureCss();

  const ov = document.createElement("div");
  ov.className = "sx-transition" + (reduced ? " is-reduced" : "");
  ov.style.setProperty("--cx", hooks.from.x + "px");
  ov.style.setProperty("--cy", hooks.from.y + "px");
  ov.innerHTML = '<div class="sx-dark"></div><canvas></canvas><div class="sx-boot" role="status" aria-live="polite"></div><div class="sx-skip">Click or press any key to skip</div>';
  document.body.appendChild(ov);
  const cv = ov.querySelector("canvas");
  const boot = ov.querySelector(".sx-boot");
  const LINES = ["INITIALIZING NAVIGATION SYSTEMS", "CALIBRATING STELLAR DATABASE", "GENERATING LOCAL SECTOR", "NAVIGATION ONLINE"];
  const lines = LINES.map((t) => { const d = document.createElement("div"); d.textContent = t; boot.appendChild(d); return d; });
  let step = 0;
  const advance = (k) => {
    while (step < k) {
      lines[step].classList.add("is-on");
      if (step > 0) lines[step - 1].classList.add("is-done");
      step++;
    }
    if (step === LINES.length) lines[step - 1].classList.add("is-final");
  };

  // Stars rushing out of the visor, inside a circle that grows to fill the screen.
  const ctx = cv.getContext("2d");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const resize = () => { cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; };
  resize();
  const stars = Array.from({ length: reduced ? 0 : 420 }, () => ({ a: Math.random() * Math.PI * 2, r: Math.random() * 0.15, v: 0.15 + Math.random() * 0.85, b: 0.4 + Math.random() * 0.6 }));
  let skip = false;
  const onSkip = () => { skip = true; };
  ov.addEventListener("click", onSkip);
  window.addEventListener("keydown", onSkip);

  const t0 = performance.now();
  const DUR = reduced ? 400 : 2100;
  let animDone = false, raf = 0;
  const ease = (x) => x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
  const draw = (now) => {
    let t = (now - t0) / DUR;
    if (skip) t = Math.max(t, 1);
    const k = Math.min(1, t);
    hooks.setVisor(Math.min(1, k * 2.2));
    if (!reduced) hooks.setZoom(ease(Math.min(1, k * 1.25)));
    if (k > 0.05) ov.classList.add("is-dark");
    if (!reduced) {
      const W = cv.width, H = cv.height;
      const cx = hooks.from.x * dpr, cy = hooks.from.y * dpr;
      const open = Math.max(0, (k - 0.35) / 0.65);
      const R = 30 * dpr + ease(open) * Math.hypot(W, H);
      ctx.clearRect(0, 0, W, H);
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = "rgba(0,0,0," + Math.min(1, open * 1.6 + 0.2) + ")";
      ctx.fillRect(0, 0, W, H);
      const speed = 0.4 + k * 2.4;
      for (const s of stars) {
        s.r += s.v * 0.004 * speed;
        if (s.r > 1.2) s.r = Math.random() * 0.05;
        const L = Math.hypot(W, H) * 0.6;
        const x1 = cx + Math.cos(s.a) * s.r * L, y1 = cy + Math.sin(s.a) * s.r * L;
        const x0 = cx + Math.cos(s.a) * Math.max(0, s.r - 0.02 * speed) * L, y0 = cy + Math.sin(s.a) * Math.max(0, s.r - 0.02 * speed) * L;
        ctx.strokeStyle = "rgba(220,232,255," + (s.b * Math.min(1, s.r * 6)) + ")";
        ctx.lineWidth = dpr * (0.6 + s.r);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
      ctx.restore();
    } else {
      ctx.fillStyle = "#000"; ctx.globalAlpha = k; ctx.fillRect(0, 0, cv.width, cv.height); ctx.globalAlpha = 1;
    }
    if (k >= 1) animDone = true;
    raf = requestAnimationFrame(draw);
  };
  raf = requestAnimationFrame(draw);
  advance(1);

  let sim = null;
  const finishExit = async () => {
    // Back out through the visor.
    ov.classList.remove("is-dark");
    ov.style.pointerEvents = "none";
    boot.innerHTML = "";
    ov.querySelector(".sx-skip").remove();
    const s0 = performance.now(), D = reduced ? 250 : 900;
    await new Promise((resolve) => {
      const back = (now) => {
        const k = Math.min(1, (now - s0) / D);
        hooks.setZoom(1 - ease(k));
        hooks.setVisor(1 - k);
        ctx.clearRect(0, 0, cv.width, cv.height);
        ctx.fillStyle = "rgba(0,0,0," + (1 - k) + ")";
        ctx.fillRect(0, 0, cv.width, cv.height);
        if (k < 1) requestAnimationFrame(back); else resolve();
      };
      requestAnimationFrame(back);
    });
    ov.remove();
    document.documentElement.style.overflow = prevOverflow;
    window.scrollTo(0, scrollY);
    const l = document.querySelector("link[data-sx-css]");
    if (l) l.remove();
    active = false;
    hooks.onClosed();
  };
  const exit = () => {
    // Fade the simulator to black, tear it down, then reverse the transition.
    cancelAnimationFrame(raf);
    ov.style.display = "";
    ov.style.opacity = "1";
    ov.classList.add("is-dark");
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, cv.width, cv.height);
    if (sim) sim.root.classList.remove("is-on");
    setTimeout(() => { if (sim) sim.dispose(); sim = null; finishExit(); }, reduced ? 50 : 450);
  };

  try {
    const main = await import("./main.js");
    sim = await main.create({
      onProgress: (p) => { if (p === "catalogs") advance(2); if (p === "universe") advance(3); },
      onExit: exit
    });
    sim.warm();
    advance(4);
    await new Promise((r) => { const wait = () => (animDone ? r() : setTimeout(wait, 50)); wait(); });
    await new Promise((r) => setTimeout(r, skip ? 120 : 520));
    cancelAnimationFrame(raf);
    ov.removeEventListener("click", onSkip);
    window.removeEventListener("keydown", onSkip);
    sim.reveal();
    ov.style.transition = "opacity 0.6s ease";
    ov.style.opacity = "0";
    setTimeout(() => { ov.style.display = "none"; }, 650);
  } catch (err) {
    console.error("[space] failed to start", err);
    cancelAnimationFrame(raf);
    ov.removeEventListener("click", onSkip);
    window.removeEventListener("keydown", onSkip);
    if (sim) { try { sim.dispose(); } catch (e) { /* ignore */ } sim = null; }
    boot.innerHTML = '<div class="is-on">NAVIGATION OFFLINE</div><div class="is-on" style="letter-spacing:0.04em;opacity:.7">The simulator couldn\'t start in this browser.</div>';
    const b = document.createElement("button");
    b.type = "button"; b.className = "sx-btn sx-exit"; b.textContent = "Return to portfolio";
    b.style.marginTop = "14px";
    boot.appendChild(b);
    b.addEventListener("click", (e) => { e.stopPropagation(); finishExit(); }, { once: true });
  }
}

function ensureCss() {
  if (document.querySelector("link[data-sx-css]")) return Promise.resolve();
  return new Promise((resolve) => {
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = CSS_URL; l.dataset.sxCss = "1";
    l.onload = () => resolve(); l.onerror = () => resolve();
    document.head.appendChild(l);
  });
}
