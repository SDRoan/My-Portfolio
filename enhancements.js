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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initScrollReveal);
  } else {
    initScrollReveal();
  }
})();
