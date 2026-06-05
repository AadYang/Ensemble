// 01-rain background. Canvas covers the viewport, fixed-position. Digits
// fall in cyan (matching the app accent). Head of each stream is brighter,
// trail fades behind. Listens to window resize.
//
// Pacing knobs (the page felt too frantic at default):
//   FRAME_MS: minimum time between paints. 60ms ≈ ~16fps — slow enough that
//             the eye reads the digits, fast enough to look alive.
//   STEP:     pixels advanced per frame, expressed as a fraction of COL.
//             At STEP=0.5 + FRAME_MS=60 the effective rain is ~135 px/s.
//
// Per-cell paint cost is two fillText calls (head + one fading trailing
// char). The trailing tail effect is created by overlaying a translucent
// bg-color rect each frame.

(function () {
  const canvas = document.getElementById("matrix-bg");
  if (!canvas) return;
  const ctx = canvas.getContext("2d", { alpha: true });
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  const COL = 18;
  const FONT = "14px ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
  const ACCENT = "rgba(0, 217, 255,";
  const HEAD = "rgba(180, 245, 255,";
  const STEP = 0.5; // fraction of COL advanced per frame
  const FRAME_MS = 60; // min interval between paints (~16fps)

  let cols = 0;
  let drops = [];
  let lastPaint = 0;

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = w * DPR;
    canvas.height = h * DPR;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.font = FONT;
    cols = Math.floor(w / COL);
    // Each column has a random starting offset so the rain isn't synchronized.
    drops = Array.from({ length: cols }, () => Math.random() * -h);
  }
  resize();
  window.addEventListener("resize", resize);

  function step(now) {
    rafId = requestAnimationFrame(step);
    if (now - lastPaint < FRAME_MS) return;
    lastPaint = now;

    // Soft-fade prior frame to create the trailing tail effect. Lower alpha
    // means longer-lasting trails — bumped from 0.10 to 0.06 to compensate
    // for the slower frame rate (otherwise heads would look isolated).
    ctx.fillStyle = "rgba(10, 14, 20, 0.06)";
    ctx.fillRect(0, 0, canvas.width / DPR, canvas.height / DPR);

    for (let i = 0; i < cols; i++) {
      const ch = Math.random() < 0.5 ? "0" : "1";
      const x = i * COL + 2;
      const y = drops[i];
      // Head: brighter
      ctx.fillStyle = HEAD + "0.85)";
      ctx.fillText(ch, x, y);
      // One fading trail char above the head — keeps the rain readable
      // without becoming visually noisy.
      ctx.fillStyle = ACCENT + "0.45)";
      ctx.fillText(Math.random() < 0.5 ? "0" : "1", x, y - COL);

      drops[i] += COL * STEP;
      if (drops[i] > canvas.height / DPR + Math.random() * 240) {
        drops[i] = -Math.random() * 240;
      }
    }
  }
  let rafId = requestAnimationFrame(step);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      cancelAnimationFrame(rafId);
    } else {
      lastPaint = 0;
      rafId = requestAnimationFrame(step);
    }
  });
})();
