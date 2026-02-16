(function () {
  function initRotaryFollow() {
    document.querySelectorAll(".rotary-nav .de").forEach(function (dial) {
      const knob = dial.querySelector(".deneme");
      const dot = dial.querySelector(".den .dot");
      if (!knob) return;

      dial.addEventListener("mousemove", function (e) {
        const rect = dial.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dx = (e.clientX - cx) / (rect.width / 2);
        const dy = (e.clientY - cy) / (rect.height / 2);
        const mx = Math.max(-1, Math.min(1, dx));
        const my = Math.max(-1, Math.min(1, dy));
        knob.style.setProperty("--mx", mx);
        knob.style.setProperty("--my", my);
        if (dot) {
          const angleDeg = Math.atan2(e.clientY - cy, e.clientX - cx) * (180 / Math.PI);
          dot.style.transform = "rotate(" + angleDeg + "deg)";
        }
      });

      dial.addEventListener("mouseleave", function () {
        knob.style.setProperty("--mx", "0");
        knob.style.setProperty("--my", "0");
        if (dot) dot.style.removeProperty("transform");
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initRotaryFollow);
  } else {
    initRotaryFollow();
  }
})();
