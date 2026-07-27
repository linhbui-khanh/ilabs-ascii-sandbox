// Phase (a) of the scramble-text spec: plain DOM text (headline/CTA),
// scrambled on hover via GSAP's ScrambleTextPlugin. This is deliberately
// separate from the shader — real text, real accessibility, real SEO.
// Phase (b) (per-glyph scramble driven by cursor proximity, integrated into
// the ASCII shader itself) is a later/advanced step — see README "Next steps".
//
// GSAP's Club plugins (including ScrambleTextPlugin) became free for
// everyone when Webflow acquired GSAP (April 30, 2025), so this CDN import
// works with no license key.

export function initScrambleText(selector = "[data-scramble]") {
  if (!window.gsap || !window.ScrambleTextPlugin) {
    console.warn("[scrambleText] GSAP or ScrambleTextPlugin not loaded yet — check script tags in index.html");
    return;
  }
  gsap.registerPlugin(ScrambleTextPlugin);

  const els = document.querySelectorAll(selector);
  els.forEach((el) => {
    const original = el.textContent;
    let tween = null;

    el.addEventListener("mouseenter", () => {
      if (tween) tween.kill();
      tween = gsap.to(el, {
        duration: 0.6,
        scrambleText: {
          text: original,
          chars: "@%#*+=-:.", // reuse the same glyph set as the shader mode, for visual consistency
          revealDelay: 0.1,
          speed: 0.4,
        },
      });
    });

    el.addEventListener("mouseleave", () => {
      if (tween) tween.kill();
      tween = gsap.to(el, {
        duration: 0.4,
        scrambleText: {
          text: original,
          chars: "@%#*+=-:.",
          speed: 0.5,
        },
      });
    });
  });

  return els.length;
}
