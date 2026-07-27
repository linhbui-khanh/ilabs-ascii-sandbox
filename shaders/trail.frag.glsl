// ============================================================================
// Cursor trail — decaying accumulation pass
// ----------------------------------------------------------------------------
// Runs as its OWN full-screen pass, ping-ponged between two render targets
// (trailRTA/trailRTB in main.js), completely separate from the main
// ASCII/dither pass. Each frame:
//   1. read the previous frame's trail texture, fade it by uDecay
//   2. additively stamp a soft circular blob at the current cursor position
//   3. write the result out — this becomes "previous frame" next time
//
// The main shader (main.frag.glsl) then just samples the latest result as
// uTrailTex and blends it into its own `influence` — it has no idea this
// decay/stamp logic exists, keeping the two passes cleanly separated.
// ============================================================================

precision highp float;

varying vec2 vUv;

uniform sampler2D uPrevTrail;
uniform vec2  uMouse;         // smoothed cursor position, uv space (see main.js)
uniform float uMouseRadius;   // same radius as the live influence circle, for a consistent stamp size
uniform float uCanvasAspect;  // width/height — same aspect-correction as main.frag.glsl
uniform float uDecay;         // 0..1 per-frame multiplier — lower = faster fade
uniform float uStampStrength; // 0..1 — how "hot" each stamp adds per frame

void main() {
  vec3 prev = texture2D(uPrevTrail, vUv).rgb * uDecay;

  vec2 delta = vUv - uMouse;
  delta.x *= uCanvasAspect; // same oval-fix as the main shader — keep the stamp circular
  float dist = length(delta);
  float stamp = smoothstep(uMouseRadius, 0.0, dist) * uStampStrength;

  vec3 outColor = clamp(prev + vec3(stamp), 0.0, 1.0);
  gl_FragColor = vec4(outColor, 1.0);
}
