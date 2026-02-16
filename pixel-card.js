(function () {
  function initPixelCard() {
    const card = document.getElementById("pixel-card");
    const pixelsContainer = document.getElementById("pixel-card-pixels");
    if (!card || !pixelsContainer) return;

    const cols = 16;
    const rows = 12;
    const cx = cols / 2;
    const cy = rows / 2;

    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const pixel = document.createElement("div");
        pixel.className = "pixel-card-pixel";
        const dx = j - cx;
        const dy = i - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const delay = dist * 25 + Math.random() * 30;
        pixel.style.setProperty("--delay", delay + "ms");
        pixelsContainer.appendChild(pixel);
      }
    }

    card.addEventListener("mouseenter", function () {
      pixelsContainer.classList.add("pixel-card-pixels--revealed");
    });
    card.addEventListener("mouseleave", function () {
      pixelsContainer.classList.remove("pixel-card-pixels--revealed");
    });

    setTimeout(function () {
      pixelsContainer.classList.add("pixel-card-pixels--revealed");
    }, 800);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initPixelCard);
  } else {
    initPixelCard();
  }
})();
