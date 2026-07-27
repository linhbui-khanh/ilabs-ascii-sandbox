// ============================================================================
// Cursor magnetism — DOM demo
// ----------------------------------------------------------------------------
// NOT a shader/canvas effect — this is the standard "magnetic hover" technique
// (element eases toward the cursor within a proximity radius, eases back to
// rest when the cursor leaves) applied to real DOM elements. It's built here
// as a demo against a few placeholder "idea-shape" boxes (see index.html)
// purely so there's working, tunable reference code to lift directly onto the
// REAL idea-shape elements on the live Webflow page — it has nothing to do
// with the ASCII/dither pipeline and doesn't touch WebGL at all.
//
// Dependency-free: no GSAP, no external lib. Uses its own rAF loop (not CSS
// transitions) so the easing behaves the same way the rest of this sandbox's
// mouse-driven effects do (frame-rate-independent lerp, same shape as
// main.js's cursor smoothing) rather than fighting a CSS transition's timing
// curve every time the target position changes.
// ============================================================================

export function initMagnetism(selector = ".magnetic", options = {}) {
  const state = {
    radius: options.radius ?? 130, // px — proximity within which an element starts pulling
    strength: options.strength ?? 0.35, // 0..1 — fraction of cursor offset the element follows
    ease: options.ease ?? 0.2, // 0..1 per-frame lerp factor at 60fps (see tickEase below)
    enabled: options.enabled ?? true,
  };

  const items = Array.from(document.querySelectorAll(selector)).map((el) => ({
    el,
    current: { x: 0, y: 0 },
    target: { x: 0, y: 0 },
  }));

  if (items.length === 0) {
    console.warn(`[magnetism] no elements matched "${selector}" — nothing to do`);
    return { setRadius() {}, setStrength() {}, setEase() {}, setEnabled() {} };
  }

  function onPointerMove(e) {
    if (!state.enabled) return;
    for (const item of items) {
      const rect = item.el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const dist = Math.hypot(dx, dy);
      if (dist < state.radius) {
        // falloff so it eases in near the edge of the radius rather than
        // snapping to full strength the instant the cursor crosses the line
        const falloff = 1 - dist / state.radius;
        item.target.x = dx * state.strength * falloff;
        item.target.y = dy * state.strength * falloff;
      } else {
        item.target.x = 0;
        item.target.y = 0;
      }
    }
  }
  window.addEventListener("pointermove", onPointerMove);

  let lastTime = performance.now();
  function tickEase(now) {
    const dt = Math.min((now - lastTime) / 1000, 0.1); // clamp so a tab switch doesn't cause a giant jump
    lastTime = now;
    const lerpT = 1 - Math.pow(1 - state.ease, dt * 60);
    for (const item of items) {
      item.current.x += (item.target.x - item.current.x) * lerpT;
      item.current.y += (item.target.y - item.current.y) * lerpT;
      item.el.style.transform = `translate(${item.current.x.toFixed(2)}px, ${item.current.y.toFixed(2)}px)`;
    }
    requestAnimationFrame(tickEase);
  }
  requestAnimationFrame(tickEase);

  return {
    setRadius: (v) => (state.radius = v),
    setStrength: (v) => (state.strength = v),
    setEase: (v) => (state.ease = v),
    setEnabled: (v) => {
      state.enabled = v;
      if (!v) for (const item of items) { item.target.x = 0; item.target.y = 0; }
    },
  };
}
