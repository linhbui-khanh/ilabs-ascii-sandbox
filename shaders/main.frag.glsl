// ============================================================================
// ASCII (MSDF glyph atlas) + glyph/dot dithering — single mode-switchable pass
// ----------------------------------------------------------------------------
// Everything renders off ONE source texture (uSource). That texture may have
// been filled by a <video>, an <img>, or a 3D scene rendered to a
// WebGLRenderTarget — the shader below never knows or cares which. That's the
// "unify every source into a texture first" pipeline decision from the spec.
//
// uMode selects the technique:
//   0 = ASCII (MSDF glyph atlas)
//   1 = Bayer 4x4
//   2 = Bayer 8x8
//   3 = Bayer 16x16
//   4 = Blue Noise (precomputed texture, uDitherScale controls tiling)
//   5 = IGN (Interleaved Gradient Noise, procedural, no texture)
//   6 = Random (deliberately bad baseline, for side-by-side comparison)
//   7 = Smooth Dot (direct quantized luminance -> dot size, NO per-cell
//       threshold at all — see that branch's comment for why this exists
//       as a separate mode instead of a tweak to the Bayer/blue-noise ones)
// ============================================================================

precision highp float;

varying vec2 vUv;

uniform sampler2D uSource;      // the unified source texture (video/image/3D RT)
// Real bloom RGB for 3D sources (see main.js's "Bloom" section for why this
// is a SEPARATE texture from uSource rather than baked into it: preserves
// uSource's alpha content-mask, which UnrealBloomPass's own composite
// doesn't reliably carry through). Black (all-zero, a no-op add) for
// video/image sources and whenever the Glow slider is at 0. Sampled and
// added to srcColor further down, BEFORE luminance/glyph mapping, so glow
// actually lightens/spreads into neighboring cells' density instead of just
// recoloring cells that were already going to be dense/sparse regardless.
uniform sampler2D uBloomTex;
uniform vec2  uResolution;      // canvas size in physical pixels

uniform int   uMode;
uniform float uCellSize;        // glyph / dot cell size, in pixels
uniform float uInvert;          // 0.0 or 1.0 — flips density mapping direction
uniform vec3  uFgColor;
uniform vec3  uBgColor;
uniform vec3  uAccentColor;
uniform float uAccentThreshold; // luminance above which accent starts blending in
uniform float uTime;

// mouse interactivity
uniform vec2  uMouse;           // normalized 0..1, uv space, y already flipped to match vUv
uniform float uMouseRadius;     // in uv units
uniform float uMouseStrength;   // 0..1

// "magnet" — dots/glyphs visually shift toward the cursor within
// uMagnetRadius, independent of the influence/tint calc above (that one
// recolors/brightens; this one is a purely positional pull). See
// README "Magnet dots/glyphs" for how the offset is computed and its
// capped-within-the-cell trade-off.
uniform float uMagnetEnabled;   // 0.0 or 1.0
uniform float uMagnetRadius;    // uv units, aspect-corrected same as uMouseRadius
uniform float uMagnetStrength;  // 0..1

// ASCII / MSDF atlas
uniform sampler2D uAtlasTex;
uniform vec4  uGlyphRects[16];  // (u0, v0, u1, v1) per glyph, in charset order (dense -> sparse)
uniform int   uGlyphCount;
uniform float uAtlasPxRange;    // distanceField.distanceRange from the baked atlas metadata

// dithering
uniform sampler2D uBlueNoiseTex;
uniform float uDitherScale;     // blue-noise tiling scale (runtime slider, replaces fixed 1x/2x/0.5x presets)
uniform float uDotLevels;       // "Smooth Dot" mode (uMode==7) — number of discrete dot-size steps

// source aspect ratio (source pixel width / height) — see coverUv() below.
// 1.0 for the 3D-rendered sources (their render target is always square).
uniform float uSourceAspect;

// Explicit "is there actually something rendered here" mask, read from
// uSource's ALPHA channel — 1.0 where the 3D scene actually drew a mesh
// pixel, 0.0 in the empty space around it (the render target is cleared
// fully transparent before drawing, see main.js). uSourceIsMasked gates
// whether that alpha is trusted at all: 1.0 for the 3D-rendered sources
// (spark/.glb), 0.0 for video/image (those have no meaningful "empty"
// region — the whole frame IS the source, so alpha is ignored and treated
// as fully "content" everywhere).
//
// This exists because LUMINANCE alone can't tell "empty background" apart
// from "legitimately near-black content" — the 3D scene's clear color is
// near-black, and mouse influence/cursor trail nudging that already-low
// luminance by even a little was enough to flip which (very narrow, ~10-step)
// ASCII/dither bucket a background cell landed in, scattering visibly
// different glyphs across what should be a perfectly clean backdrop. Gating
// on real alpha coverage instead of a luminance heuristic fixes this for
// good, regardless of what else (mouse, trail, any future effect) nudges
// luminance near the cursor.
uniform float uSourceIsMasked; // 0.0 or 1.0

// color mode + source filters
uniform int   uColorMode;   // 0 = Grayscale (fixed uFgColor), 1 = RGB (actual sampled source color)
uniform float uBrightness;  // multiplicative, 1.0 = unchanged
uniform float uContrast;    // pivots around 0.5, 1.0 = unchanged
uniform float uBlurAmount;  // pre-blur radius in source pixels, 0 = off (cheap 9-tap tent blur)
uniform float uGlowStrength; // 0..1 — see note above outColor glow term below

// cursor trail — a decaying accumulation buffer updated in a separate pass
// (see shaders/trail.frag.glsl + main.js's trailRTA/trailRTB ping-pong).
// Cells the cursor recently passed over stay "hot" for a bit and fade out,
// instead of the influence being purely instantaneous distance-to-cursor.
uniform sampler2D uTrailTex;

const float PI = 3.14159265359;

float luminance(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

// ---- Bayer matrices (computed, no texture needed) --------------------------

// Compact recursive Bayer construction (standard trick, e.g. used in most
// GLSL ordered-dithering references): each level folds the coarser matrix in
// at half resolution and adds the base 2x2 pattern on top. Returns values
// already normalized to [0, 1) — no extra scaling needed at the call site.
//
// NOTE: an earlier version of this file built the recursion by literally
// summing bayer2() at increasing integer weights (4, 16, 64, 256) without
// re-normalizing — that produced raw values far outside [0,1] once divided
// by a fixed constant, so `step(threshold, l)` was almost always false and
// large regions collapsed to solid on/off blocks instead of a fine dither
// (visible as chunky orange/black squares at Bayer 16x16). This version
// fixes that.
float bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x / 2.0 + a.y * a.y * 0.75);
}
float bayer4(vec2 a)  { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(vec2 a)  { return bayer4(0.5 * a) * 0.25 + bayer2(a); }
float bayer16(vec2 a) { return bayer8(0.5 * a) * 0.25 + bayer2(a); }

// ---- IGN (Interleaved Gradient Noise) --------------------------------------
// Cheap, single-formula, no texture — the common real-time stand-in for
// blue noise when you can't afford a texture sample or tiling artifacts.
float ign(vec2 fragCoord) {
  return fract(52.9829189 * fract(dot(fragCoord, vec2(0.06711056, 0.00583715))));
}

// ---- Random baseline (kept deliberately ugly for comparison) --------------
float randomNoise(vec2 fragCoord) {
  return fract(sin(dot(fragCoord, vec2(12.9898, 78.233))) * 43758.5453123);
}

// ---- MSDF sampling ----------------------------------------------------------
float median3(vec3 v) {
  return max(min(v.r, v.g), min(max(v.r, v.g), v.b));
}

// samples the glyph at `rect` (atlas UV rect) using `cellUv` (0..1 local
// coordinate inside the glyph cell), returns an anti-aliased glyph coverage.
float sampleMSDFGlyph(vec4 rect, vec2 cellUv) {
  vec2 atlasUv = mix(rect.xy, rect.zw, cellUv);
  vec3 msdfSample = texture2D(uAtlasTex, atlasUv).rgb;
  float sigDist = median3(msdfSample) - 0.5;
  // screenPxRange: how many screen pixels one unit of the encoded distance
  // field covers at the current cell size — keeps edges crisp at any scale.
  float screenPxRange = max(uAtlasPxRange * (uCellSize / 32.0), 1.0);
  float coverage = clamp(sigDist * screenPxRange + 0.5, 0.0, 1.0);
  return coverage;
}

int glyphIndexFromLuminance(float lum) {
  float l = uInvert > 0.5 ? 1.0 - lum : lum;
  // index 0 = densest glyph ('@'), last index = sparsest/blank — a BRIGHT
  // source pixel should land on a SPARSE glyph, so invert l when indexing.
  int idx = int(floor((1.0 - l) * float(uGlyphCount - 1) + 0.5));
  idx = idx < 0 ? 0 : (idx > uGlyphCount - 1 ? uGlyphCount - 1 : idx);
  return idx;
}

// CSS `object-fit: cover` equivalent — scales+crops the source UV so it
// fills the canvas without stretching, regardless of how the canvas aspect
// ratio compares to the source's native aspect ratio (video/image dimensions
// almost never match the canvas exactly, so this runs unconditionally).
vec2 coverUv(vec2 uv, float canvasAspect, float sourceAspect) {
  vec2 ratio = vec2(
    min(canvasAspect / sourceAspect, 1.0),
    min(sourceAspect / canvasAspect, 1.0)
  );
  return vec2(
    uv.x * ratio.x + (1.0 - ratio.x) * 0.5,
    uv.y * ratio.y + (1.0 - ratio.y) * 0.5
  );
}

// Cheap 9-tap tent blur in texture space (GLSL ES 1.00 has no array
// constructors, so the taps are unrolled by hand instead of looped over an
// array). This is a pre-filter on the SOURCE, not a true screen-space blur —
// good enough to soften grainy/noisy video before it drives glyph/dot
// density, at effectively zero extra cost (no separate render pass).
vec3 sampleSourceBlurred(vec2 uv, float amountPx) {
  if (amountPx <= 0.05) return texture2D(uSource, uv).rgb;
  vec2 texel = amountPx / uResolution;
  vec3 sum = texture2D(uSource, uv).rgb * 4.0;
  sum += texture2D(uSource, uv + vec2(texel.x, 0.0)).rgb;
  sum += texture2D(uSource, uv - vec2(texel.x, 0.0)).rgb;
  sum += texture2D(uSource, uv + vec2(0.0, texel.y)).rgb;
  sum += texture2D(uSource, uv - vec2(0.0, texel.y)).rgb;
  sum += texture2D(uSource, uv + texel).rgb;
  sum += texture2D(uSource, uv - texel).rgb;
  sum += texture2D(uSource, uv + vec2(texel.x, -texel.y)).rgb;
  sum += texture2D(uSource, uv + vec2(-texel.x, texel.y)).rgb;
  return sum / 12.0;
}

vec4 getGlyphRect(int idx) {
  // GLSL ES 1.0 (WebGL1/Three r128) can't index arrays with a non-constant
  // in some drivers, so unroll the lookup defensively.
  for (int i = 0; i < 16; i++) {
    if (i == idx) return uGlyphRects[i];
  }
  return uGlyphRects[0];
}

void main() {
  vec2 fragCoord = vUv * uResolution;
  float cell = max(uCellSize, 2.0);

  vec2 cellId = floor(fragCoord / cell);
  vec2 cellUv = fract(fragCoord / cell);
  vec2 cellCenterUv = (cellId * cell + cell * 0.5) / uResolution;

  // sample the source at the CENTER of the cell, not per-pixel, so every
  // glyph/dot in a cell shares one luminance value (this is what makes it
  // read as ASCII/dithering instead of a blurred video). coverUv() remaps
  // into the source's own aspect ratio first, so an uploaded video/image
  // fills the frame (crop, not squash) instead of stretching to the canvas.
  float canvasAspect = uResolution.x / uResolution.y;
  vec2 sampleUv = coverUv(cellCenterUv, canvasAspect, uSourceAspect);
  vec3 srcColor = sampleSourceBlurred(sampleUv, uBlurAmount);
  // Real bloom light-bleed (3D sources only, see uBloomTex comment above) —
  // added BEFORE brightness/contrast so those filters still apply uniformly
  // to the combined result, and before luminance/glyph mapping so a bright
  // glowing point genuinely lightens/spreads into neighboring cells instead
  // of only recoloring cells that were already going to read as dense/sparse.
  srcColor += texture2D(uBloomTex, sampleUv).rgb;

  // brightness/contrast, applied before the luminance/coverage math so they
  // actually affect glyph density and dot size, not just the final tint.
  srcColor = (srcColor - 0.5) * uContrast + 0.5;
  srcColor *= uBrightness;
  srcColor = clamp(srcColor, 0.0, 1.0);

  float lum = luminance(srcColor);

  // Real content mask (see uSourceIsMasked comment above) — a single,
  // UNBLURRED point-sample of uSource's alpha at the cell center, same
  // granularity as every other per-cell value here. For video/image this
  // is forced to 1.0 (mix toward 1.0 when uSourceIsMasked is 0) so nothing
  // changes for those sources; for the 3D-rendered sources it's the actual
  // "did a mesh pixel land here" coverage.
  float contentMask = mix(1.0, texture2D(uSource, sampleUv).a, uSourceIsMasked);

  // ---- mouse interactivity: local density/contrast boost near the cursor --
  // Aspect-correct the distance: vUv is 0..1 on BOTH axes regardless of the
  // canvas's actual aspect ratio, so a plain distance() between two uv points
  // is stretched into an oval whenever the canvas isn't square (equal uv
  // deltas on x vs y cover different pixel counts). Scaling delta.x by
  // canvasAspect first makes the falloff a true circle in screen pixels.
  vec2 mouseDelta = vUv - uMouse;
  mouseDelta.x *= canvasAspect;
  float dist = length(mouseDelta);
  float instantInfluence = 1.0 - smoothstep(0.0, max(uMouseRadius, 0.0001), dist);
  float trailHeat = texture2D(uTrailTex, vUv).r;
  // combine instantaneous proximity with the decaying trail buffer — whichever
  // is stronger wins, so a fresh trail doesn't get diluted by an already-fading one.
  float influence = max(instantInfluence, trailHeat) * uMouseStrength;

  // ---- magnet: pull this cell's dot/glyph toward the cursor ---------------
  // Direction is computed in PIXEL space (isotropic, since cells are always
  // pixel-square regardless of canvas aspect), then applied as an offset in
  // cell-LOCAL uv units (0..1 within the cell). Capped at 0.45 of a cell —
  // this is a within-cell displacement, not a full cross-cell particle
  // scatter: each fragment only ever evaluates its OWN cell, so a dot pushed
  // further than that would just clip at the cell edge instead of visually
  // "arriving" in the neighboring cell (which has no idea a neighbor's dot
  // is encroaching). Reads as a strong magnetic lean near the cursor without
  // the cost/complexity of a proper neighbor-search scatter — see README.
  vec2 magnetDeltaUv = cellCenterUv - uMouse;
  magnetDeltaUv.x *= canvasAspect;
  float magnetDist = length(magnetDeltaUv);
  float magnetFalloff = uMagnetEnabled * (1.0 - smoothstep(0.0, max(uMagnetRadius, 0.0001), magnetDist));
  vec2 cellCenterPx = cellId * cell + cell * 0.5;
  vec2 towardMousePx = (uMouse * uResolution) - cellCenterPx;
  float towardMouseLen = length(towardMousePx);
  vec2 magnetDir = towardMouseLen > 0.0001 ? towardMousePx / towardMouseLen : vec2(0.0);
  vec2 magnetOffset = magnetDir * magnetFalloff * uMagnetStrength * 0.45;

  vec3 outColor;

  if (uMode == 0) {
    // ---------------- ASCII / MSDF glyph mode ----------------
    // Two SEPARATE biases, not one — this is the fix for "mouse interaction
    // stops looking like ASCII": a single `lum + influence*0.35` term used
    // for glyph selection was strong enough that a sizeable chunk of the
    // influence radius (not just the exact cursor point) clamped to 1.0 —
    // every cell in that saturated zone then picked the SAME densest glyph
    // ('@') at ~full MSDF coverage. Tiling one repeated glyph edge-to-edge
    // reads as solid horizontal bars (the glyph's own vertical letterform
    // padding is the only gap left), not as ASCII, because all per-cell
    // luminance variation got flattened to the same ceiling value. Only the
    // outer ring of the influence circle (where the boost is too weak to
    // saturate) still showed distinct glyph shapes — matching the "ring of
    // dots, solid bars in the middle" look.
    //
    // Fix: keep glyph SELECTION reactive but too gentle to blow past 1.0 over
    // more than a pinpoint at the cursor, so per-cell variety survives across
    // the whole influence radius. Color/glow can still fully saturate near
    // the cursor — recoloring/brightening a cell doesn't erase its glyph
    // shape the way clamping the glyph INDEX itself does.
    float biasedLumForGlyph = clamp(lum + influence * 0.12, 0.0, 1.0);
    float biasedLumForAccent = clamp(lum + influence * 0.35, 0.0, 1.0);
    // Density gamma (<1 brightens midtones) — see the identical comment in
    // the dithering branch below for why this exists: a mid-lit 3D source
    // (fixed ambient+directional + AO vertex colors) rarely reads much past
    // ~0.4-0.5 luminance, which glyphIndexFromLuminance would otherwise read
    // as "should be a sparse glyph" almost everywhere. Applied only to the
    // glyph-selection input, not biasedLumForAccent, so the accent highlight
    // stays a tight highlight instead of spreading with it.
    float densityLumForGlyph = pow(biasedLumForGlyph, 0.6);
    int idx = glyphIndexFromLuminance(densityLumForGlyph);
    vec4 rect = getGlyphRect(idx);
    // magnet offset shifts WHERE inside the glyph atlas cell we sample from —
    // clamped so it can't sample past this glyph's own atlas rect into a
    // neighboring glyph's territory (see sampleMSDFGlyph's atlasUv mix).
    vec2 glyphSampleUv = clamp(cellUv - magnetOffset, 0.0, 1.0);
    float coverage = sampleMSDFGlyph(rect, glyphSampleUv);

    // Grayscale mode: every glyph is uFgColor (with the accent threshold
    // recoloring the brightest ones). RGB mode: each glyph is tinted with
    // the ACTUAL sampled source color instead — same glyph/density logic,
    // full color image. Accent-threshold recoloring still applies on top in
    // both modes (it's driven by luminance, which stays meaningful either way).
    vec3 baseFg = (uColorMode == 1) ? srcColor : uFgColor;
    // NOTE: this used to be `if (biasedLumForAccent > uAccentThreshold)` gating
    // a smoothstep(uAccentThreshold, 1.0, ...) mix — a HARD on/off gate right
    // at the threshold, before any blend even starts. Fine for a smooth,
    // low-frequency source, but a source with real per-cell luminance
    // variation near the threshold (e.g. a small emissive/AO-shaded shape
    // where neighboring cells' luminance hops back and forth across 0.82)
    // makes adjacent cells flip between 0% and a partial blend, reading as
    // scattered accent/non-accent speckle instead of a coherent tint. A
    // narrow symmetric band CENTERED on the threshold means neighboring
    // cells with similar luminance get similar blend amounts instead of a
    // step discontinuity right at the gate.
    float accentBlend = smoothstep(uAccentThreshold - 0.08, uAccentThreshold + 0.08, biasedLumForAccent);
    vec3 fg = mix(baseFg, uAccentColor, accentBlend);
    fg = mix(fg, uAccentColor, influence * 0.6);

    // contentMask forces genuinely empty background (3D sources only) to
    // flat uBgColor no matter what glyph got picked — see uSourceIsMasked.
    outColor = mix(uBgColor, fg, coverage * contentMask);
    // "Glow": a cheap emissive brighten of hot (near-accent-threshold) glyphs,
    // NOT a true spatial bloom (no blur/bleed into neighboring cells — a real
    // bloom pass would need an extra bright-pass + blur render target).
    // Good enough to read as "glow" in a sandbox; upgrade later if you want
    // actual light bleed.
    outColor += uAccentColor * uGlowStrength * smoothstep(uAccentThreshold - 0.15, 1.0, biasedLumForAccent) * coverage * contentMask;

  } else if (uMode == 7) {
    // ---------------- Smooth Dot (quantized, NO ordered-dither threshold) --
    // Every mode in the `else` branch below compares luminance against a
    // per-cell Bayer/blue-noise/IGN/random THRESHOLD — that's the definition
    // of ordered/stochastic dithering, but it also means a cell's dot size
    // depends partly on ITS OWN position in the threshold pattern, not just
    // on the source's luminance. In a genuinely solid-toned region that
    // shows up as a small percentage of cells reading a visibly different
    // (usually smaller) dot than their identical neighbors — see the
    // densityL/saturation-knee comments further down for the full story on
    // that class of bug. This mode sidesteps it entirely: dot size is a
    // direct, deterministic function of luminance, quantized into uDotLevels
    // discrete steps (like a halftone printing plate) — two cells sampling
    // the exact same luminance ALWAYS render the exact same dot, regardless
    // of where they sit on screen. Trade-off: no per-pixel dither
    // grain/texture — density changes are visible as distinct steps rather
    // than a stochastic blend — which is why this is an ADDITIONAL mode,
    // not a replacement for the Bayer/blue-noise ones below (those exist to
    // demonstrate true ordered dithering; this one exists for a guaranteed-
    // uniform halftone look).
    float biasedLumForDot = clamp(lum + influence * 0.12, 0.0, 1.0);
    float biasedLumForAccent = clamp(lum + influence * 0.35, 0.0, 1.0);
    float l = uInvert > 0.5 ? 1.0 - biasedLumForDot : biasedLumForDot;
    float lAccent = uInvert > 0.5 ? 1.0 - biasedLumForAccent : biasedLumForAccent;

    // Same gamma-lift reasoning as densityL in the Bayer branch below: a
    // mid-lit 3D source rarely reads much past ~0.5 luminance, so lifting it
    // here keeps the quantized steps from bunching up entirely in the
    // bottom half of the range.
    float lifted = pow(l, 0.6);
    float levels = max(uDotLevels, 2.0);
    float quantized = floor(lifted * levels + 0.5) / levels;
    float radius = mix(0.06, 0.48, quantized);

    // Cell-size-aware edge softness: a small on-screen cell (few px) gets a
    // softer dot edge so it doesn't alias into a hard jagged square; a large
    // cell gets a crisp edge so the halftone reads as deliberate circles
    // instead of a blurry blob — adapts to Cell size instead of using one
    // fixed edge width for every value.
    float edgeSoftness = mix(0.14, 0.035, smoothstep(6.0, 20.0, cell));
    float d = length(cellUv - 0.5 - magnetOffset);
    float dotCoverage = 1.0 - smoothstep(radius - edgeSoftness, radius, d);

    vec3 baseFg = (uColorMode == 1) ? srcColor : uFgColor;
    float accentBlend = smoothstep(uAccentThreshold - 0.08, uAccentThreshold + 0.08, lAccent);
    vec3 fg = mix(baseFg, uAccentColor, influence * 0.6);
    fg = mix(fg, uAccentColor, accentBlend);

    outColor = mix(uBgColor, fg, dotCoverage * contentMask);
    outColor += uAccentColor * uGlowStrength * smoothstep(uAccentThreshold - 0.15, 1.0, lAccent) * dotCoverage * contentMask;

  } else {
    // ---------------- dithering modes ----------------
    float threshold;
    if (uMode == 1) {
      threshold = bayer4(cellId);
    } else if (uMode == 2) {
      threshold = bayer8(cellId);
    } else if (uMode == 3) {
      threshold = bayer16(cellId);
    } else if (uMode == 4) {
      vec2 bnUv = (cellId * cell) / (uDitherScale * 64.0);
      threshold = texture2D(uBlueNoiseTex, bnUv).r;
    } else if (uMode == 5) {
      threshold = ign(cellId);
    } else {
      threshold = randomNoise(cellId + floor(uTime * 0.0)); // static; bump uTime factor to animate
    }

    // Same split as the ASCII branch above: a gentle bias drives dot
    // radius/on-off (so cells right at the cursor don't all clamp to the
    // same maxed-out radius and merge into a solid disc), a stronger one
    // drives accent color/glow (fine to fully saturate near the cursor).
    float biasedLumForDot = clamp(lum + influence * 0.12, 0.0, 1.0);
    float biasedLumForAccent = clamp(lum + influence * 0.35, 0.0, 1.0);
    float l = uInvert > 0.5 ? 1.0 - biasedLumForDot : biasedLumForDot;
    float lAccent = uInvert > 0.5 ? 1.0 - biasedLumForAccent : biasedLumForAccent;

    // dot-matrix look: within the cell, draw a circular dot whose radius is
    // driven by luminance vs. threshold, rather than a flat on/off fill —
    // reads closer to a halftone than a binary Bayer checkerboard.
    //
    // NOTE: this is a smoothstep BAND around the threshold, not step()'s hard
    // on/off. Real video always has a little frame-to-frame luminance jitter
    // (sensor/codec noise) even on a "static" held pose. With a hard step(),
    // any cell whose luminance sits near its own Bayer/blue-noise/IGN
    // threshold flips fully on <-> off every time that jitter crosses the
    // line — that's the per-dot "chớp chớp" flicker/sparkle scattered across
    // the subject (confirmed by diffing consecutive frames: near-zero change
    // in flat/background regions, sparse scattered flips only inside the
    // dithered content). A narrow transition band turns each flip into a
    // quick fade instead of a hard pop, which reads as far less noisy even
    // though the underlying source noise is unchanged. See README "Known
    // limitations — dot flicker on video sources".
    // Density gamma (<1 brightens midtones) — the dot on/off compare below
    // is a straight l-vs-Bayer/blue-noise-threshold test, and for a mid-lit
    // 3D source (fixed ambient(0.5)+directional(1.0) lighting on a ~0.5
    // albedo material, further darkened by the AO vertex-color bake) `l`
    // rarely gets much past ~0.4-0.5 across most of the surface. Since a
    // uniformly-distributed Bayer/blue-noise threshold is < l only ~40-50%
    // of the time at that level, roughly HALF the cells land "off" (zero
    // radius, i.e. pure background) even on what should read as a fairly
    // solid mid-tone — reported as "còn nhiều đốm trắng" (too much white
    // showing through what should be solid). Confirmed live: cranking the
    // Brightness slider to ~1.6 filled the coverage back in, but that also
    // pushes lAccent past uAccentThreshold across the same area, turning a
    // tight highlight into a blanket recolor. Applying the gamma HERE only
    // (not to lAccent below) fixes density without that side effect, as a
    // sensible out-of-the-box default — Brightness/Contrast still work on
    // top of this for further manual tuning per source.
    float densityL = pow(l, 0.6);
    // Saturating knee on top of the gamma above — without this, a REAL solid
    // fill (e.g. deep inside the procedural pyramid's front facet, a single
    // flat-shaded surface under uniform lighting) still shows a scattered
    // handful of visibly smaller/missing dots: reported as "các dot không
    // đều nhau" (the dots aren't uniform) with specific cells circled inside
    // an otherwise-uniform dense region. Cause: even after the gamma lift,
    // densityL asymptotically approaches but never quite reaches 1.0, and
    // Bayer/blue-noise thresholds are near-uniformly distributed over
    // 0..1 — so the small minority of cells whose OWN threshold happens to
    // land above densityL (the top ~10-15% of the 64-cell Bayer tile, when
    // densityL sits around 0.85-0.9) still read as partial/off, even though
    // every cell is sampling the exact same flat, evenly-lit color. Once
    // densityL is "clearly bright enough" (>= ~0.8), pushing it the rest of
    // the way to a hard 1.0 makes on/radius pass for every cell regardless
    // of its Bayer position, so a genuinely solid-toned region renders as a
    // uniform field of full-size dots instead of a dithered gradient — true
    // dithering (varied dot size) is preserved for l below that knee, where
    // the source is actually transitioning tone (real edges/shading/AO).
    densityL = max(densityL, smoothstep(0.55, 0.8, l));
    // Even with densityL pinned at a hard 1.0 above, a residual ~3% of cells
    // still read as a visibly smaller dot in a solid-toned region (confirmed
    // live: disabling mouse trail/strength entirely made zero difference to
    // where these sit, so it isn't cursor-trail related — it's deterministic
    // per-cell). Reason: Bayer 16x16 has thresholds up to ~0.996, and the
    // flicker-safe smoothstep BAND above (±0.035, from the very first fix
    // this session) is centered ON the threshold — so for a cell whose own
    // threshold sits within ~0.035 of the max (roughly the top 3% of the
    // tile), even densityL == 1.0 exactly still lands INSIDE that cell's
    // band rather than past its top edge, so `on` comes out partial instead
    // of a full 1.0. Explicitly forcing on = 1.0 once densityL has already
    // saturated (the >= 0.999 check below) closes that last gap without
    // touching the band's behavior for any cell that's still genuinely
    // dithering (densityL < 1).
    float on = densityL >= 0.999 ? 1.0 : smoothstep(threshold - 0.035, threshold + 0.035, densityL);
    float radius = mix(0.08, 0.46, densityL) * on;
    // magnet offset shifts the dot's effective center within the cell.
    float d = length(cellUv - 0.5 - magnetOffset);
    float dotCoverage = 1.0 - smoothstep(radius - 0.06, radius, d);

    vec3 baseFg = (uColorMode == 1) ? srcColor : uFgColor;
    // Same fix as the ASCII branch above: narrow symmetric band centered on
    // the threshold instead of a hard if-gate, so neighboring dots whose
    // luminance straddles uAccentThreshold blend smoothly instead of
    // flipping between 0% and partial accent — see that branch's comment
    // for the full "why" (checkered accent/non-accent speckle on sources
    // with real per-cell luminance variation near the threshold).
    float accentBlend = smoothstep(uAccentThreshold - 0.08, uAccentThreshold + 0.08, lAccent);
    vec3 fg = mix(baseFg, uAccentColor, influence * 0.6);
    fg = mix(fg, uAccentColor, accentBlend);

    // contentMask forces genuinely empty background (3D sources only) to
    // flat uBgColor no matter what dot got picked — see uSourceIsMasked.
    outColor = mix(uBgColor, fg, dotCoverage * contentMask);
    outColor += uAccentColor * uGlowStrength * smoothstep(uAccentThreshold - 0.15, 1.0, lAccent) * dotCoverage * contentMask;
  }

  gl_FragColor = vec4(outColor, 1.0);
}
