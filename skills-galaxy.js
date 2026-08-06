(function () {
  const canvas = document.getElementById("skills-page-galaxy");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const TAU = Math.PI * 2;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const colors = [
    [124, 196, 255],
    [167, 139, 250],
    [110, 231, 168],
    [251, 191, 114],
    [244, 143, 177],
  ];

  let width = 1;
  let height = 1;
  let dpr = 1;
  let centerX = 0;
  let centerY = 0;
  let stars = [];
  let galaxy = [];
  let mouseX = 0;
  let mouseY = 0;
  let rotation = 0;
  let lastTime = 0;

  function random(min, max) {
    return min + Math.random() * (max - min);
  }

  function rgba(color, alpha) {
    return "rgba(" + color[0] + "," + color[1] + "," + color[2] + "," + alpha + ")";
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = canvas.clientWidth || window.innerWidth;
    height = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    centerX = width * 0.5;
    centerY = height * 0.53;

    const compact = width < 680;
    const starCount = compact ? 180 : 360;
    const galaxyCount = compact ? 820 : 1500;

    stars = Array.from({ length: starCount }, function () {
      const depth = Math.pow(Math.random(), 2.5);
      return {
        x: Math.random() * width,
        y: Math.random() * height,
        r: random(0.35, 1.35 + depth * 1.4),
        a: random(0.16, 0.78),
        phase: Math.random() * TAU,
        speed: random(0.45, 1.45),
      };
    });

    galaxy = Array.from({ length: galaxyCount }, function (_, index) {
      const arm = index % 4;
      const radius = 0.035 + Math.pow(Math.random(), 0.68) * 0.88;
      const armAngle = (arm / 4) * TAU + Math.log(radius + 0.08) * 2.65;
      const scatter = random(-0.18, 0.18) + random(-0.35, 0.35) * radius;
      const color = colors[(arm + Math.floor(radius * 7)) % colors.length];
      return {
        radius: radius,
        angle: armAngle + scatter,
        size: random(0.45, 1.8) * (1.12 - radius * 0.38),
        alpha: random(0.12, 0.64) * (1.05 - radius * 0.55),
        color: color,
        phase: Math.random() * TAU,
      };
    });

    if (reducedMotion) draw(performance.now());
  }

  function drawBackground(time) {
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#03050c";
    ctx.fillRect(0, 0, width, height);

    const glow = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, Math.max(width, height) * 0.72);
    glow.addColorStop(0, "rgba(77, 157, 255, 0.16)");
    glow.addColorStop(0.34, "rgba(9, 20, 44, 0.24)");
    glow.addColorStop(1, "rgba(3, 5, 12, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);

    ctx.globalCompositeOperation = "lighter";
    stars.forEach(function (star) {
      const twinkle = reducedMotion ? 1 : 0.58 + Math.sin(time * 0.0011 * star.speed + star.phase) * 0.42;
      ctx.fillStyle = "rgba(231, 241, 255," + (star.a * twinkle).toFixed(3) + ")";
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.r, 0, TAU);
      ctx.fill();
    });
  }

  function drawGalaxy(time) {
    const driftX = mouseX * 18;
    const driftY = mouseY * 10;
    const radiusBase = Math.min(width, height) * (width < 680 ? 0.34 : 0.42);
    const tilt = width < 680 ? 0.5 : 0.42;

    ctx.globalCompositeOperation = "lighter";

    galaxy.forEach(function (point) {
      const pulse = reducedMotion ? 1 : 0.72 + Math.sin(time * 0.0013 + point.phase) * 0.28;
      const angle = point.angle + rotation + point.radius * 0.42;
      const radius = point.radius * radiusBase;
      const x = centerX + driftX + Math.cos(angle) * radius;
      const y = centerY + driftY + Math.sin(angle) * radius * tilt;
      const alpha = Math.max(0, point.alpha * pulse);

      ctx.fillStyle = rgba(point.color, alpha);
      ctx.beginPath();
      ctx.arc(x, y, point.size, 0, TAU);
      ctx.fill();
    });

    const coreRadius = radiusBase * 0.28;
    const core = ctx.createRadialGradient(centerX + driftX, centerY + driftY, 0, centerX + driftX, centerY + driftY, coreRadius);
    core.addColorStop(0, "rgba(255, 246, 214, 0.96)");
    core.addColorStop(0.25, "rgba(255, 194, 118, 0.46)");
    core.addColorStop(0.58, "rgba(125, 211, 252, 0.16)");
    core.addColorStop(1, "rgba(3, 5, 12, 0)");
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(centerX + driftX, centerY + driftY, coreRadius, 0, TAU);
    ctx.fill();
  }

  function draw(time) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawBackground(time);
    drawGalaxy(time);
  }

  function frame(time) {
    const dt = Math.min(34, time - lastTime || 16.7);
    lastTime = time;
    rotation += dt * 0.000035;
    draw(time);
    requestAnimationFrame(frame);
  }

  window.addEventListener("resize", resize);
  window.addEventListener("pointermove", function (event) {
    mouseX = (event.clientX / Math.max(1, width) - 0.5) * 2;
    mouseY = (event.clientY / Math.max(1, height) - 0.5) * 2;
    if (reducedMotion) draw(performance.now());
  }, { passive: true });

  resize();
  if (!reducedMotion) requestAnimationFrame(frame);
})();
