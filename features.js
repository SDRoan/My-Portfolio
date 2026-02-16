(function () {
  function initFeatures() {
    initCopyEmail();
    initBackToTop();
  }

  function initCopyEmail() {
    document.querySelectorAll("[data-copy-email]").forEach(function (el) {
      el.addEventListener("click", function (e) {
        const email = el.getAttribute("data-copy-email") || (el.getAttribute("href") || "").replace("mailto:", "") || el.textContent.trim();
        if (!email) return;

        e.preventDefault();
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(email).then(function () {
            showToast("Email copied to clipboard!");
          });
        } else {
          showToast("Email: " + email);
        }
      });
    });
  }

  function showToast(msg) {
    const existing = document.getElementById("copy-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.id = "copy-toast";
    toast.className = "toast";
    toast.textContent = msg;
    document.body.appendChild(toast);

    requestAnimationFrame(function () {
      toast.classList.add("toast--visible");
    });

    setTimeout(function () {
      toast.classList.remove("toast--visible");
      setTimeout(function () {
        toast.remove();
      }, 300);
    }, 2000);
  }

  function initBackToTop() {
    const btn = document.getElementById("back-to-top");
    if (!btn) return;

    function updateVisibility() {
      if (window.scrollY > 400) {
        btn.classList.add("back-to-top--visible");
      } else {
        btn.classList.remove("back-to-top--visible");
      }
    }

    window.addEventListener("scroll", updateVisibility, { passive: true });
    updateVisibility();

    btn.addEventListener("click", function () {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initFeatures);
  } else {
    initFeatures();
  }
})();
