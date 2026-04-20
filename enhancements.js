(function () {
  function initScrollReveal() {
    document.querySelectorAll(".project-card").forEach(function (el, i) {
      el.style.setProperty("--i", i);
    });
    document.querySelectorAll(".timeline-item").forEach(function (el, i) {
      el.style.setProperty("--i", i);
    });
    document.querySelectorAll(".skill-card").forEach(function (el, i) {
      el.style.setProperty("--i", i);
    });
    const els = document.querySelectorAll(
      ".section-header, .project-card, .timeline-item, .skill-card, .about-card, .contact-card, .section.muted"
    );
    const observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("revealed");
          }
        });
      },
      { threshold: 0.08, rootMargin: "0px 0px -30px 0px" }
    );
    els.forEach(function (el) {
      el.classList.add("scroll-reveal");
      observer.observe(el);
    });
  }

  function initBackgroundMusic() {
    if (document.getElementById("bg-audio")) return;

    const audio = document.createElement("audio");
    audio.id = "bg-audio";
    audio.src = "bg-music.mp3";
    audio.loop = true;
    audio.preload = "auto";
    audio.volume = 0.6;
    audio.setAttribute("playsinline", "");
    document.body.appendChild(audio);

    const savedTime = parseFloat(sessionStorage.getItem("bg-audio-time") || "0");
    if (!isNaN(savedTime) && savedTime > 0 && savedTime < 230) {
      audio.currentTime = savedTime;
    }
    const savedMuted = sessionStorage.getItem("bg-audio-muted") === "1";

    const btn = document.createElement("button");
    btn.id = "bg-audio-toggle";
    btn.type = "button";
    btn.setAttribute("aria-label", "Toggle background music");
    btn.style.cssText = [
      "position:fixed",
      "bottom:20px",
      "right:20px",
      "width:42px",
      "height:42px",
      "border-radius:50%",
      "border:1px solid rgba(255,255,255,0.22)",
      "background:rgba(10,10,14,0.55)",
      "color:rgba(255,255,255,0.85)",
      "padding:0",
      "cursor:pointer",
      "z-index:9999",
      "backdrop-filter:blur(12px) saturate(140%)",
      "-webkit-backdrop-filter:blur(12px) saturate(140%)",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "transition:transform 0.18s ease, background 0.18s ease, border-color 0.18s ease",
      "box-shadow:0 1px 0 rgba(255,255,255,0.06) inset, 0 8px 24px rgba(0,0,0,0.4)",
    ].join(";");
    btn.onmouseenter = () => {
      btn.style.transform = "scale(1.08)";
      btn.style.borderColor = "rgba(255,255,255,0.45)";
    };
    btn.onmouseleave = () => {
      btn.style.transform = "scale(1)";
      btn.style.borderColor = "rgba(255,255,255,0.22)";
    };
    document.body.appendChild(btn);

    const ICON_ON =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M11 5 6 9H2v6h4l5 4V5Z"/>' +
      '<path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>' +
      '<path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>' +
      "</svg>";
    const ICON_OFF =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M11 5 6 9H2v6h4l5 4V5Z"/>' +
      '<line x1="22" x2="16" y1="9" y2="15"/>' +
      '<line x1="16" x2="22" y1="9" y2="15"/>' +
      "</svg>";

    function render() {
      btn.innerHTML = audio.paused || audio.muted ? ICON_OFF : ICON_ON;
    }

    audio.muted = savedMuted;
    const initial = audio.play();
    if (initial && typeof initial.then === "function") {
      initial.catch(() => {
        audio.muted = true;
        audio.play().catch(() => {});
      }).finally(render);
    } else {
      render();
    }

    const unlock = () => {
      if (!savedMuted && audio.muted) audio.muted = false;
      audio.play().catch(() => {}).finally(render);
    };
    ["pointerdown", "click", "touchstart", "keydown", "scroll", "wheel"].forEach((ev) => {
      window.addEventListener(ev, unlock, { passive: true, capture: true });
      document.addEventListener(ev, unlock, { passive: true, capture: true });
    });

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      audio.muted = !audio.muted;
      sessionStorage.setItem("bg-audio-muted", audio.muted ? "1" : "0");
      if (!audio.muted && audio.paused) audio.play().catch(() => {});
      render();
    });

    audio.addEventListener("play", render);
    audio.addEventListener("pause", render);

    setInterval(() => {
      if (!audio.paused) sessionStorage.setItem("bg-audio-time", String(audio.currentTime));
    }, 1000);
    window.addEventListener("pagehide", () => {
      sessionStorage.setItem("bg-audio-time", String(audio.currentTime));
    });

    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      initScrollReveal();
      initBackgroundMusic();
    });
  } else {
    initScrollReveal();
    initBackgroundMusic();
  }
})();
