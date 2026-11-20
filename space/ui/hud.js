// The simulator's interface: HUD readouts, the info panel, search, help,
// settings, credits, toasts, labels, target brackets and touch controls.
// Plain DOM; every listener is tied to the simulator's AbortController.

import { RATES } from "../engine/time.js";
import { PRESETS } from "../engine/quality.js";
import { fmtDistance, fmtSpeed } from "../engine/coords.js";

const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
// The surface readout's short form: only these rows (click it for all).
const SURF_BRIEF = new Set(["Location", "Altitude", "Vertical speed", "Landing", "Tree (mapped)"]);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export class HUD {
  constructor(root, api, signal) {
    this.root = root; this.api = api; this.signal = signal;
    const on = (el, ev, fn) => el.addEventListener(ev, fn, { signal });
    this.on = on;

    root.appendChild(h("div", "sx-frame", "<i></i><i></i><i></i><i></i>"));
    this.labelLayer = root.appendChild(h("div", "sx-labels"));
    this.bracket = root.appendChild(h("div", "sx-bracket", "<i></i><i></i><i></i><i></i><b></b>"));
    this.edge = root.appendChild(h("div", "sx-edge"));
    this.cockpit = root.appendChild(h("div", "sx-cockpit", '<div class="sx-reticle"></div>'));

    const hud = root.appendChild(h("div", "sx-hud"));
    this.tl = hud.appendChild(h("div", "sx-tl", '<div class="sx-k">Location</div><div class="sx-loc"></div>'));
    this.tc = hud.appendChild(h("div", "sx-tc"));
    const tr = hud.appendChild(h("div", "sx-tr"));
    const btn = (label, title, cls) => { const b = tr.appendChild(h("button", "sx-btn " + (cls || ""), label)); b.type = "button"; b.title = title; b.setAttribute("aria-label", title); return b; };
    on(btn("Search", "Search (/)"), "click", () => this.openSearch());
    on(btn("Settings", "Settings", "sx-optional"), "click", () => this.toggleModal("settings"));
    on(btn("?", "Controls (H)"), "click", () => this.toggleModal("help"));
    on(btn("Credits", "Data sources and credits", "sx-optional"), "click", () => this.toggleModal("credits"));
    this.muteBtn = btn("♪", "Ambient sound on/off", "sx-optional");
    on(this.muteBtn, "click", () => api.onToggleSound());
    on(btn("Return to portfolio", "Return to portfolio", "sx-exit"), "click", () => api.onExit());

    this.bl = hud.appendChild(h("div", "sx-bl", '<div class="sx-k">View · C to change</div><div class="sx-mode"></div><div class="sx-k sx-regime"></div>'));
    on(this.bl, "click", () => api.onMode());
    this.bl.classList.add("sx-click");
    this.bc = hud.appendChild(h("div", "sx-bc",
      '<div class="sx-k">Speed</div><div class="sx-speed">0 m/s</div><div class="sx-k sx-warpnote"></div><div class="sx-scale"></div>' +
      '<div class="sx-hint">Drag to look · <kbd>WASD</kbd><kbd>QE</kbd> move · wheel speed · click select · <kbd>G</kbd> go · <kbd>H</kbd> help</div>'));
    this.scale = this.bc.querySelector(".sx-scale");
    for (let i = -12; i <= 12; i += 2) this.scale.appendChild(h("i"));
    this.br = hud.appendChild(h("div", "sx-br", '<div class="sx-k">Simulation time</div><div class="sx-v sx-time"></div><div class="sx-rates"></div>'));
    const rates = this.br.querySelector(".sx-rates");
    this.rateBtns = RATES.map((r, i) => {
      const b = rates.appendChild(h("button", "sx-btn", r.label));
      b.type = "button";
      on(b, "click", () => api.onRate(i));
      return b;
    });
    this.br.classList.add("sx-click");

    // Info panel.
    this.info = root.appendChild(h("aside", "sx-panel sx-info"));
    this.info.setAttribute("aria-live", "polite");

    // Search.
    this.search = root.appendChild(h("div", "sx-panel sx-search", '<input type="search" placeholder="Search planets, stars, exoplanets, galaxies, nebulae…" aria-label="Search the universe"><div class="sx-results"></div>'));
    this.input = this.search.querySelector("input");
    this.results = this.search.querySelector(".sx-results");
    let sel = 0, list = [];
    const render = () => {
      list = api.search(this.input.value);
      sel = 0;
      this.results.innerHTML = "";
      if (!list.length) { if (this.input.value.trim()) this.results.appendChild(h("div", "sx-empty", "No catalogued object matches.")); return; }
      list.forEach((r, i) => {
        const b = this.results.appendChild(h("button", "sx-result" + (i === 0 ? " is-active" : ""), "<b>" + esc(r.label) + "</b><span>" + esc(r.sub || "") + "</span>"));
        b.type = "button";
        on(b, "click", () => { this.closeSearch(); api.onSearchSelect(r.make()); });
      });
    };
    on(this.input, "input", render);
    on(this.input, "keydown", (e) => {
      if (e.key === "Escape") { e.stopPropagation(); this.closeSearch(); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        sel = Math.max(0, Math.min(list.length - 1, sel + (e.key === "ArrowDown" ? 1 : -1)));
        [...this.results.children].forEach((c, i) => c.classList.toggle("is-active", i === sel));
        const a = this.results.children[sel]; if (a && a.scrollIntoView) a.scrollIntoView({ block: "nearest" });
      }
      if (e.key === "Enter" && list[sel]) { this.closeSearch(); api.onSearchSelect(list[sel].make()); }
    });

    // Modals.
    this.modals = {
      help: root.appendChild(h("div", "sx-panel sx-modal", HELP_HTML)),
      settings: root.appendChild(h("div", "sx-panel sx-modal", "")),
      credits: root.appendChild(h("div", "sx-panel sx-modal", ""))
    };
    for (const k in this.modals) {
      this.modals[k].setAttribute("role", "dialog");
      this.modals[k].prepend(h("button", "sx-x", "×"));
      on(this.modals[k].querySelector(".sx-x"), "click", () => this.closeModals());
    }

    this.debugEl = root.appendChild(h("pre", "sx-debug"));
    // Launch sequence: stage caption and a skip control.
    this.launchEl = root.appendChild(h("div", "sx-launch", '<div class="sx-k">Launch · Cape Canaveral region</div><div class="sx-stage"></div><div class="sx-lbar"><i></i></div>'));
    this.skipBtn = this.launchEl.appendChild(h("button", "sx-btn sx-skip-launch", "Skip launch"));
    this.skipBtn.type = "button";
    on(this.skipBtn, "click", () => api.onSkipLaunch && api.onSkipLaunch());
    // Surface / landing panel and contextual actions.
    // Surface readout: a few small lines bottom-left; click for every detail.
    this.surfEl = root.appendChild(h("div", "sx-surf"));
    try { this.surfExpanded = localStorage.getItem("sx-surf-expanded") === "1"; } catch (e) { this.surfExpanded = false; }
    on(this.surfEl, "click", () => {
      this.surfExpanded = !this.surfExpanded;
      try { localStorage.setItem("sx-surf-expanded", this.surfExpanded ? "1" : "0"); } catch (e) { /* storage unavailable */ }
      this._surf = ""; if (this._surfArgs) this.setSurface(...this._surfArgs);
    });
    this.actionsEl = root.appendChild(h("div", "sx-actions-bar"));
    this._actions = "";
    this.toastEl = root.appendChild(h("div", "sx-toast"));
    this.msgEl = root.appendChild(h("div", "sx-msg"));
    this.buildTouch();
  }

  // ── readouts ──
  setLocation(lines) {
    const html = lines.map((l) => "<div>" + esc(l) + "</div>").join("");
    if (html !== this._loc) { this.tl.querySelector(".sx-loc").innerHTML = html; this._loc = html; }
  }
  setTarget(t, dist) {
    if (!t) { if (this._tid !== null) { this.tc.innerHTML = ""; this._tid = null; } return; }
    const head = '<div class="sx-k">Target</div><div class="sx-tname">' + esc(t.name) + '<span class="sx-chip ' + (t.real ? "real" : "proc") + '">' + (t.real ? "REAL" : "PROCEDURAL") + "</span></div>";
    const sub = '<div class="sx-tsub">' + esc(t.cls || "") + " · " + fmtDistance(dist) + "</div>";
    if (this._tid !== t.id) { this.tc.innerHTML = head + '<div class="sx-tsubwrap">' + sub + "</div>"; this._tid = t.id; }
    else this.tc.querySelector(".sx-tsubwrap").innerHTML = sub;
  }
  setSpeed(mps, regime, wheel, warp) {
    this.bc.querySelector(".sx-speed").textContent = fmtSpeed(mps);
    this.bc.querySelector(".sx-warpnote").textContent = warp ? "Warp navigation · simulation" : "";
    this.bl.querySelector(".sx-regime").textContent = regime;
    const bars = this.scale.children;
    for (let i = 0; i < bars.length; i++) bars[i].classList.toggle("on", -12 + i * 2 <= wheel);
  }
  setMode(m) {
    this.bl.querySelector(".sx-mode").textContent = "CAMERA: " + { free: "FREE OBSERVER", chase: "THIRD PERSON", cockpit: "COCKPIT" }[m];
    this.cockpit.classList.toggle("is-on", m === "cockpit");
  }
  setTime(label, rateIndex) {
    this.br.querySelector(".sx-time").textContent = label;
    this.rateBtns.forEach((b, i) => b.classList.toggle("is-on", i === rateIndex));
  }
  setSound(on) { this.muteBtn.classList.toggle("is-on", on); }
  setLaunch(state) {
    if (!state) { this.launchEl.classList.remove("is-on"); return; }
    this.launchEl.classList.add("is-on");
    this.launchEl.querySelector(".sx-stage").textContent = state.stage;
    this.launchEl.querySelector(".sx-lbar i").style.width = Math.round(state.progress * 100) + "%";
  }
  // rows: [[label, value], …] or null; title; tone: "warn" for unsafe states.
  setSurface(title, rows, note) {
    if (!title) { this.surfEl.classList.remove("is-open"); this._surf = ""; this._surfArgs = null; return; }
    this._surfArgs = [title, rows, note];
    const full = this.surfExpanded;
    if (!full) { rows = rows.filter((r) => SURF_BRIEF.has(r[0])); note = null; }
    this.surfEl.classList.toggle("is-full", full);
    const html = '<div class="sx-k">' + esc(title) + '<span class="sx-surf-more">' + (full ? " · less ▾" : " · details ▸") + "</span></div><table>" + rows.map((r) => '<tr' + (r[2] || r[3] ? ' class="' + [r[2], r[3]].filter(Boolean).join(" ") + '"' : "") + "><td>" + esc(r[0]) + "</td><td>" + esc(r[1]) + "</td></tr>").join("") + "</table>" +
      (note ? '<div class="sx-surf-note">' + esc(note) + "</div>" : "");
    if (html !== this._surf) { this.surfEl.innerHTML = html; this._surf = html; }
    this.surfEl.classList.add("is-open");
  }
  // actions: [{ label, key, run, tone }]
  setActions(actions) {
    const sig = actions.map((a) => a.label + a.key + (a.tone || "")).join("|");
    this._runs = actions;
    if (sig === this._actions) return;
    this._actions = sig;
    this.actionsEl.innerHTML = "";
    actions.forEach((a, i) => {
      const b = this.actionsEl.appendChild(h("button", "sx-btn sx-act" + (a.tone ? " " + a.tone : ""), esc(a.label) + (a.key ? ' <kbd>' + esc(a.key) + "</kbd>" : "")));
      b.type = "button";
      this.on(b, "click", () => { const r = this._runs[i]; if (r && r.run) r.run(); });
    });
  }
  setDebug(text) {
    this.debugEl.style.display = text ? "block" : "none";
    if (text) this.debugEl.textContent = text;
  }

  // Bracket on the selected target, or an arrow at the screen edge if off-screen.
  setBracket(p, r, label) {
    if (!p) { this.bracket.style.display = "none"; this.edge.style.display = "none"; return; }
    const w = this.root.clientWidth, hh = this.root.clientHeight;
    if (p.onScreen) {
      const s = Math.max(10, Math.min(r, 400));
      this.bracket.style.display = "block";
      this.bracket.style.left = p.x - s + "px"; this.bracket.style.top = p.y - s + "px";
      this.bracket.style.width = 2 * s + "px"; this.bracket.style.height = 2 * s + "px";
      this.bracket.querySelector("b").textContent = label;
      this.edge.style.display = "none";
    } else {
      this.bracket.style.display = "none";
      const cx = w / 2, cy = hh / 2;
      const ang = Math.atan2(p.dy, p.dx);
      const R = Math.min(w, hh) / 2 - 36;
      this.edge.style.display = "block";
      this.edge.style.left = cx + Math.cos(ang) * R + "px";
      this.edge.style.top = cy + Math.sin(ang) * R + "px";
      this.edge.style.transform = "translate(-50%, -50%) rotate(" + ang + "rad)";
    }
  }
  setLabels(items) {
    const L = this.labelLayer;
    while (L.children.length < items.length) L.appendChild(h("div", "sx-label"));
    for (let i = 0; i < L.children.length; i++) {
      const el = L.children[i];
      if (i >= items.length) { el.style.display = "none"; continue; }
      el.style.display = "block";
      el.style.left = items[i].x + "px"; el.style.top = items[i].y + "px";
      if (el.textContent !== items[i].text) el.textContent = items[i].text;
    }
  }

  // ── info panel ──
  showInfo(t, actions) {
    if (!t) { this.info.classList.remove("is-open"); this.infoTarget = null; return; }
    this.infoTarget = t;
    const d = t.info();
    const band = t.real ? '<div class="sx-band real">REAL · CATALOGUED</div>' : '<div class="sx-band proc">SIMULATED · PROCEDURAL</div>';
    this.info.innerHTML = '<button class="sx-x" aria-label="Close">×</button>' + band + "<h3>" + esc(t.name) + '</h3><div class="sx-cls">' + esc(t.cls || "") + "</div>" +
      "<table>" + d.rows.map((r) => "<tr><td>" + esc(r[0]) + "</td><td>" + esc(r[1]) + "</td></tr>").join("") + "</table>" +
      '<div class="sx-notes">' + (d.notes || []).map((n) => "<div>" + esc(n) + "</div>").join("") + "</div>" + '<div class="sx-actions"></div>';
    this.on(this.info.querySelector(".sx-x"), "click", () => this.showInfo(null));
    const act = this.info.querySelector(".sx-actions");
    const add = (label, fn) => { const b = act.appendChild(h("button", "sx-btn", label)); b.type = "button"; this.on(b, "click", fn); };
    add("Travel (G)", actions.travel);
    add("Focus (F)", actions.focus);
    if (t.renamable) add("Name it", actions.rename);
    this.info.classList.add("is-open");
  }

  // ── search ──
  openSearch() {
    this.closeModals();
    this.input.value = "";
    this.results.innerHTML = "";
    this.search.classList.add("is-open");
    this.api.onUiOpen();
    setTimeout(() => this.input.focus(), 0);
  }
  closeSearch() { this.search.classList.remove("is-open"); this.input.blur(); }
  get searchOpen() { return this.search.classList.contains("is-open"); }

  // ── modals ──
  toggleModal(k) {
    const open = !this.modals[k].classList.contains("is-open");
    this.closeModals();
    if (!open) return;
    if (k === "settings") this.renderSettings();
    if (k === "credits") this.renderCredits();
    this.modals[k].classList.add("is-open");
    this.api.onUiOpen();
  }
  closeModals() { for (const k in this.modals) this.modals[k].classList.remove("is-open"); }
  get anyOpen() { return this.searchOpen || Object.values(this.modals).some((m) => m.classList.contains("is-open")); }

  renderSettings() {
    const s = this.api.getSettings();
    const m = this.modals.settings;
    m.innerHTML = '<button class="sx-x" aria-label="Close">×</button><h2>Settings</h2>' +
      row("Graphics quality", '<select data-k="quality">' + Object.keys(PRESETS).map((k) => '<option value="' + k + '"' + (k === s.quality ? " selected" : "") + ">" + PRESETS[k].label + "</option>").join("") + "</select>") +
      row("Lower quality automatically if slow", chk("autoQuality", s.autoQuality)) +
      row("Reduced motion", chk("reducedMotion", s.reducedMotion)) +
      row("Camera shake (launch, cockpit head motion)", chk("shake", s.shake !== false)) +
      row("Invert vertical look", chk("invertY", s.invertY)) +
      row("Look sensitivity", '<input type="range" min="0.3" max="2.5" step="0.1" data-k="sensitivity" value="' + s.sensitivity + '">') +
      row("Orbit lines (O)", chk("orbits", s.orbits)) +
      row("Labels for nearby objects (K)", chk("labels", s.labels)) +
      row("Ambient sound", chk("sound", !s.muted)) +
      '<p style="margin-top:12px">Settings are kept in this browser only.</p>';
    this.on(m.querySelector(".sx-x"), "click", () => this.closeModals());
    m.querySelectorAll("[data-k]").forEach((el) => this.on(el, "change", () => {
      const k = el.dataset.k;
      const v = el.type === "checkbox" ? el.checked : el.type === "range" ? +el.value : el.value;
      this.api.onSetting(k, v);
    }));
  }
  renderCredits() {
    const m = this.modals.credits;
    const srcs = this.api.getSources();
    m.innerHTML = '<button class="sx-x" aria-label="Close">×</button><h2>Data sources &amp; credits</h2>' +
      "<p>Real objects are placed from public catalogues; everything else is generated deterministically and labelled <b style=\"color:#c9a7ff\">PROCEDURAL</b> wherever it appears. Nothing procedural is presented as a discovered object.</p>" +
      "<h4>Catalogues</h4><ul>" + srcs.map((s) => "<li>" + (s.url ? '<a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.name) + "</a>" : esc(s.name)) + (s.license ? " — " + esc(s.license) : "") + "</li>").join("") + "</ul>" +
      "<h4>Imagery</h4><ul><li>Planet, Moon, Earth and Sun maps: <a href=\"https://www.solarsystemscope.com/textures/\" target=\"_blank\" rel=\"noopener\">Solar System Scope</a>, CC BY 4.0, based on NASA mission data.</li></ul>" +
      "<h4>Spacecraft</h4><ul><li>An original interceptor, modelled in code for this simulator.</li></ul>" +
      "<h4>Software</h4><ul><li><a href=\"https://threejs.org\" target=\"_blank\" rel=\"noopener\">three.js</a> (MIT).</li></ul>" +
      "<h4>Approximations</h4><ul><li>Galaxy, nebula and cluster structures are procedural visualisations placed at catalogued positions and sizes.</li>" +
      "<li>Black-hole lensing and accretion discs are visual approximations, not general-relativistic renders.</li>" +
      "<li>Orbital phases of most moons and minor bodies are approximate.</li><li>Faster-than-light travel is a navigation convenience.</li></ul>" +
      "<p>An original simulator built for this portfolio — not affiliated with any other space software.</p>";
    this.on(m.querySelector(".sx-x"), "click", () => this.closeModals());
  }

  // ── notices ──
  toast(kicker, big, sub) {
    this.toastEl.innerHTML = '<div class="sx-k">' + esc(kicker) + '</div><div class="sx-big">' + esc(big) + '</div><div class="sx-tsub">' + esc(sub) + "</div>";
    this.toastEl.classList.add("is-on");
    clearTimeout(this._tt);
    this._tt = setTimeout(() => this.toastEl.classList.remove("is-on"), 4200);
  }
  message(text, ms = 2200) {
    this.msgEl.textContent = text;
    this.msgEl.classList.add("is-on");
    clearTimeout(this._mt);
    this._mt = setTimeout(() => this.msgEl.classList.remove("is-on"), ms);
  }

  // ── touch ──
  buildTouch() {
    const t = this.root.appendChild(h("div", "sx-touch"));
    const stick = t.appendChild(h("div", "sx-stick", "<i></i>"));
    const knob = stick.querySelector("i");
    let id = null;
    const set = (x, y) => {
      const r = stick.getBoundingClientRect();
      let dx = (x - (r.left + r.width / 2)) / (r.width / 2), dy = (y - (r.top + r.height / 2)) / (r.height / 2);
      const l = Math.hypot(dx, dy); if (l > 1) { dx /= l; dy /= l; }
      knob.style.transform = "translate(" + dx * 37 + "px," + dy * 37 + "px)";
      this.api.onStick(dx, -dy);
    };
    this.on(stick, "pointerdown", (e) => { id = e.pointerId; stick.setPointerCapture(id); set(e.clientX, e.clientY); });
    this.on(stick, "pointermove", (e) => { if (e.pointerId === id) set(e.clientX, e.clientY); });
    const end = () => { id = null; knob.style.transform = ""; this.api.onStick(0, 0); };
    this.on(stick, "pointerup", end); this.on(stick, "pointercancel", end);
    const pad = t.appendChild(h("div", "sx-tbtns"));
    const tb = (label, down, up) => {
      const b = pad.appendChild(h("button", "sx-btn", label)); b.type = "button";
      this.on(b, "pointerdown", (e) => { e.preventDefault(); down(); });
      if (up) { this.on(b, "pointerup", up); this.on(b, "pointercancel", up); this.on(b, "pointerleave", up); }
    };
    tb("Up", () => this.api.onLift(1), () => this.api.onLift(0));
    tb("Down", () => this.api.onLift(-1), () => this.api.onLift(0));
    tb("Faster", () => this.api.onWheel(-1));
    tb("Slower", () => this.api.onWheel(1));
    tb("Go", () => this.api.onTravel());
    tb("Mode", () => this.api.onMode());
  }
}

function row(label, control) { return '<div class="sx-row"><span>' + label + "</span>" + control + "</div>"; }
function chk(k, v) { return '<input type="checkbox" data-k="' + k + '"' + (v ? " checked" : "") + ">"; }

const HELP_HTML = `<h2>Controls</h2>
<h4>Look &amp; move</h4>
<div class="sx-keys">
<kbd>Drag</kbd><span>Look around (or <kbd>M</kbd> for mouse-look; <kbd>Esc</kbd> releases)</span>
<kbd>W</kbd> <kbd>S</kbd><span>Forward / back</span>
<kbd>A</kbd> <kbd>D</kbd><span>Left / right</span>
<kbd>Q</kbd> <kbd>E</kbd><span>Down / up</span>
<kbd>Z</kbd> <kbd>X</kbd><span>Roll</span>
<kbd>Arrows</kbd><span>Turn without the mouse</span>
<kbd>Wheel</kbd><span>Trim travel speed (it also adapts to the nearest surface)</span>
<kbd>Shift</kbd><span>Boost ×10</span>
<kbd>Ctrl</kbd> / <kbd>Alt</kbd><span>Precision ×0.1 (on Windows/Linux, Ctrl+W closes the tab — the page asks before leaving while Ctrl is held)</span>
<kbd>R</kbd><span>Stabilise: level the roll</span>
</div>
<h4>Navigate</h4>
<div class="sx-keys">
<kbd>Click</kbd><span>Select an object</span>
<kbd>G</kbd><span>Travel to the selected object (any movement key cancels)</span>
<kbd>F</kbd><span>Turn to face it</span>
<kbd>/</kbd><span>Search</span>
<kbd>I</kbd><span>Show or hide the info panel</span>
<kbd>C</kbd><span>Camera: third person → cockpit → free observer (the craft stays where it is)</span>
<kbd>O</kbd><span>Orbit lines</span>
<kbd>L</kbd><span>Landing assist (below 20 km over a solid body): levels the craft, slows the descent, lowers the gear</span>
<kbd>Enter</kbd><span>Exit the landed craft · on foot: <kbd>WASD</kbd> walk, <kbd>Shift</kbd> run, <kbd>Space</kbd> jump, <kbd>E</kbd> board when near</span>
<kbd>Space</kbd> / <kbd>Esc</kbd><span>Skip the launch</span>
<kbd>T</kbd><span>Surface map of the world you are at, with landmarks (click one to select it)</span>
<kbd>K</kbd><span>Labels</span>
<kbd>P</kbd><span>Pause time · <kbd>,</kbd> <kbd>.</kbd> slower / faster · <kbd>N</kbd> back to now</span>
<kbd>H</kbd><span>This help</span>
<kbd>F3</kbd><span>Developer overlay · <kbd>F4</kbd> level-of-detail colours · <kbd>F5</kbd> craft bounds &amp; anchors</span>
<kbd>Esc</kbd><span>Close panels · release mouse-look</span>
</div>
<p>Speeds above light speed are a navigation convenience for exploring, not physics.</p>`;
