# ASCII / Glyph-Dither Shader Sandbox

A learning + dev-handoff sandbox for real-time ASCII (MSDF font-atlas) and
glyph/dot dithering shaders, built for the ILABS hero-section ASCII effect
work. **This is not the production implementation** — it's a standalone tool
for understanding the technique and handing working code to a developer who
will port the relevant pieces into the live Webflow site.

## Working conventions

- **Bug fixes / tweaks within the already-agreed direction**: fix and ship
  directly — this has been the working pattern throughout the project (dot
  flicker, accent-threshold checkering, density-gamma, Smooth Dot mode, etc.
  were all diagnosed, fixed, committed, and reported after the fact).
- **Scope/architecture-level questions** — "should this tool grow capability
  X," "should we duplicate/match something [reference tool] does," "which of
  these approaches" — are a different category: give a direct recommendation
  and flag the couple of decisions that change scope/effort, then WAIT for
  explicit go-ahead before writing any code. Don't implement speculatively.
  (Established 2026-07-28 re: whether to add a Unicorn-Studio-style
  artboard/size-preset system to this sandbox.)

## Running it

Any static file server works — the app fetches shader source and the MSDF
atlas via `fetch()`, so it won't run from a bare `file://` URL (browsers block
`fetch` of local files under `file://`). From this folder:

```bash
npx serve .
# then open whatever URL it prints (usually http://localhost:3000)
```

**Use `npx serve .`, not `python3 -m http.server`, if you have Node available.**
Some Python installs (notably on macOS) serve `.js` files with the wrong MIME
type (`application/octet-stream` instead of `text/javascript`), which the
browser refuses to run as an ES module (`type="module"` scripts require the
correct MIME type per spec) — the whole app fails to boot with a blank page
and a "Failed to load module script" console error. `serve` (and most other
dev servers — Vite, Webflow's local preview, etc.) get this right.

**`npx serve .` doesn't run `api/presets.js`** — everything except Presets
works fine this way. Presets need the real deploy (or `vercel dev` locally)
— see "Live / shared preset library" below.

### Troubleshooting: "Failed to resolve module specifier 'three'"

If you see this in the console, your `index.html` is missing (or has an
outdated) `<script type="importmap">` block. The official `GLTFLoader.js`
example (straight from the `three@0.128.0` npm package, not something custom
here) imports Three via the bare specifier `import ... from "three"` instead
of a URL — browsers can only resolve that through an import map. The current
`index.html` already includes one mapping `"three"` to the same CDN URL used
everywhere else; if you copy `main.js`/`msdfAtlas.js` into a different host
page, bring the import map with them.

## What's in here

```
index.html              page shell — canvas, import map, CDN script tags (pure canvas, no DOM demo elements)
api/presets.js          Vercel Serverless Function — shared preset store (GET/PUT), backed by Upstash Redis
package.json            just declares @upstash/redis (the one dependency api/presets.js needs) — no build step
js/main.js               Three.js scene, source pipeline, GUI wiring, render loop
js/msdfAtlas.js           loads assets/msdf/atlas.png + atlas.json, converts to shader-ready glyph rects
js/blueNoise.js           procedural blue-noise-ish texture generator (no downloaded asset needed)
js/magnetism.js           UNWIRED reference code — DOM "magnetic hover" technique for the real idea-shape elements on the live Webflow hero (see below)
js/scrambleText.js        GSAP ScrambleTextPlugin hook for real DOM headline/CTA text — built, not currently wired in (see "Scramble text" below)
shaders/quad.vert.glsl    full-screen quad vertex shader (unchanged regardless of mode)
shaders/main.frag.glsl    the actual effect — ASCII (MSDF) + 6 dithering modes, mode-switchable
shaders/trail.frag.glsl   cursor trail decay+stamp pass (separate ping-ponged render target, see "Cursor trail" below)
assets/msdf/atlas.png     pre-baked JetBrains Mono MSDF atlas (256×256, charset "@%#*+=-:. ")
assets/msdf/atlas.json    BMFont-style glyph metrics for the atlas above
tools/msdf-bake/          standalone Node script to re-bake the atlas with a different font/charset
```

## Architecture — "everything is a texture"

The shader (`main.frag.glsl`) never knows whether the pixels it's reading came
from a video, an image, or a 3D scene. `main.js` unifies all three sources
into one texture before the shader ever runs:

- **Video / Image**: used directly as a `THREE.VideoTexture` / loaded texture.
- **3D (procedural spark or uploaded `.glb`)**: rendered into an offscreen
  `THREE.WebGLRenderTarget` every frame; the render target's texture is what
  the shader samples. This is the standard "render-to-texture" pattern — same
  idea as a post-processing pass, just handwritten instead of using
  `EffectComposer`.

`uSource` in the shader always points at whichever of these is currently
active (swapped in `main.js`'s `tick()` loop based on `currentSourceType`).

**Cover-fit, not stretch:** an uploaded video/image almost never matches the
canvas's aspect ratio, so the shader remaps the sampling UV with `coverUv()`
(CSS `object-fit: cover` equivalent — scale + crop, never squash) using
`uSourceAspect` (the source's real width/height ratio, updated in `main.js`
from `video.videoWidth/videoHeight` or the loaded image's natural size; 3D
sources are always `1.0` since their render target is square).

### Background masking: alpha, not luminance

The 3D render target is a square texture but the model only fills a small
part of it — most of the frame is empty space around the pyramid/`.glb`.
Early on that empty space was given a flat near-black `scene.background`
color, and the shader treated "near-zero luminance" as "this is empty
background, don't draw ASCII/dither ink here." That heuristic broke once
mouse interaction (influence + cursor trail) could nudge that already-low
luminance around: the charset/dither ramp only has ~10 discrete buckets, so
even a small nudge was enough to flip which glyph/dot a background cell
landed on, scattering visibly different characters across what should've
been a clean backdrop the moment you moved the cursor near it (and briefly,
a solid dot-matrix blob right at the cursor position, since that's exactly
where influence is strongest).

The fix: `sourceScene` has no `background` color at all anymore, and the
renderer is cleared fully transparent (`renderer.setClearColor(0x000000, 0)`)
before rendering it to the render target. That makes the render target's
**alpha channel** a real "did a mesh pixel actually land here" mask — 1.0 on
the model, 0.0 on genuinely empty space — completely independent of
luminance, and therefore immune to anything (mouse influence, trail, any
future effect) that nudges luminance near a bucket boundary. The shader reads
this as `uSourceIsMasked` (1.0 for the 3D-rendered sources, 0.0 for
video/image — those have no "empty" region, the whole frame IS content) and
multiplies it straight into the final glyph/dot coverage and glow terms, so
masked-out background is hard-forced to flat `uBgColor` no matter what got
computed upstream.

**Known edge case:** if an uploaded `.glb` itself uses a genuinely
transparent/translucent material (glass, etc.), its own alpha will read as
partial "background" here too, fading that part toward `uBgColor` instead of
rendering as ink — this pipeline was designed around opaque hero-asset
geometry, not preserving material transparency through the ASCII/dither
conversion. Flag it if you need a transparent-material upload to render
fully solid.

### Video playback controls

In the **Source** folder: **▶/❚❚ Play/Pause video**, **Loop video**, and a
**Seek (s)** slider — these only do anything once a video is actually
uploaded (`toggleVideoPlayPause()`/`seekVideo()` in `main.js` no-op if
`videoEl` doesn't exist yet).

The seek slider uses lil-gui's `.listen()`, which is the key to making a
scrub slider work without fighting itself: `tick()` writes
`params.videoTime = videoEl.currentTime` every frame so the slider's handle
visually tracks playback, and `.listen()` refreshes that display **without**
firing the slider's own `onChange` — so `onChange`'s `seekVideo(v)` only ever
fires from an actual user drag, not from our own per-frame position update.
Without `.listen()` you'd have to choose between the slider not moving during
playback, or every automatic position update re-triggering a seek.

The Play/Pause button's label is driven by the video element's own `play`/
`pause` events (not by which code called `.play()`/`.pause()`), so it stays
correct even if playback stops for a reason other than the button itself
(video ending without loop, etc). The slider's `max` is a `0..1` placeholder
until `loadedmetadata` fires and `videoTimeController.max(videoEl.duration)`
extends it to the real clip length.

## The shader: two families, one mode switch

`uMode` (int, 0–6) picks the technique. Both families share the same grid
setup: the screen is divided into `uCellSize`-px cells, and **one luminance
value is sampled from the center of each cell** — this is what makes the
output read as ASCII/dithering instead of a blurred video.

| uMode | Technique | Notes |
|---|---|---|
| 0 | ASCII (MSDF) | samples the MSDF atlas per glyph, anti-aliased edges at any scale |
| 1 | Bayer 4×4 | ordered dithering, computed in-shader, no texture |
| 2 | Bayer 8×8 | ” |
| 3 | Bayer 16×16 | ” |
| 4 | Blue Noise | precomputed texture (`blueNoise.js`), `uDitherScale` controls tiling |
| 5 | IGN | Interleaved Gradient Noise — cheap procedural stand-in for blue noise |
| 6 | Random | deliberately bad baseline, for comparing against the others |

### ASCII / MSDF mode specifics

- The atlas was baked for the locked charset `"@%#*+=-:. "` (10 glyphs, dense
  → sparse, matching the already-locked Framer `AsciiVideo` recipe).
- `uGlyphRects[16]` holds each glyph's atlas UV rect (`u0,v0,u1,v1`), in
  charset order — index 0 is `@` (densest ink), index 9 is space (blank).
  Only the first `uGlyphCount` (10) entries are real; the rest are zero-padded
  because GLSL ES 1.00 array uniforms need a fixed compile-time size.
- `sampleMSDFGlyph()` does the actual MSDF math: sample the atlas, take
  `median(r,g,b) - 0.5` as a signed distance, then `screenPxRange` converts
  that into a screen-space anti-aliasing width. The `uCellSize / 32.0` scale
  factor is an approximation (the atlas was baked at font-size 64px) — if you
  need pixel-perfect edges at very large or very small cell sizes, pass the
  glyph's actual atlas pixel size as a uniform and compute the exact ratio
  instead. Good enough for sandbox/comparison purposes as-is.

### Dithering mode specifics

- Bayer matrices are computed recursively in-shader (`bayer2` → `bayer4` →
  `bayer8` → `bayer16`), no texture needed.
- Blue Noise uses a texture generated at load time by `blueNoise.js` — see
  that file's comment for the exact technique (white noise minus its own
  blur, then histogram-equalized). It's a reasonable stand-in, not a true
  void-and-cluster blue noise; swap in a real precomputed blue-noise PNG if
  you need the textbook version for production.
- IGN and Random are both single-formula, no texture, standard real-time
  noise functions.
- All 6 modes render as a "dot" (circular coverage inside the cell, radius
  driven by luminance) rather than a flat on/off fill — reads closer to a
  halftone than a checkerboard.

**Removed: Scramble reveal on source load.** Every cell used to cycle through
a random glyph/dot and settle into the real image over `revealDuration`
seconds whenever a source (re-)loaded, staggered per-cell via
`cellRevealSeed * uRevealStagger` so the settle swept across the grid instead
of crossfading uniformly. Pulled out (along with `revealEnabled`/
`revealDuration`/`revealStagger`, `uRevealProgress`/`uRevealStagger`, and the
"Scramble reveal on load" GUI controls) because the result didn't read as the
intended decode/materialize effect. Sources now just pop in directly, same as
before this was added.

## Magnet dots/glyphs (Mouse interaction folder)

Hovering the cursor over the source visually pulls nearby dots/glyphs toward
it — a per-cell positional "magnet," separate from **Radius**/**Strength**
above (those recolor/brighten; this shifts where the dot/glyph actually
renders). Direction is computed in pixel space (isotropic, since cells are
always pixel-square regardless of canvas aspect) then applied as an offset
in cell-local uv units, for the ASCII branch by shifting where inside the
glyph's MSDF atlas rect gets sampled (clamped so it can't bleed into a
neighboring glyph's own atlas territory), and for dithering by shifting the
dot's effective center before measuring distance for its radius.

**Trade-off worth knowing:** the offset is capped at 0.45 of a cell — this
is a within-cell displacement, not a full cross-cell particle scatter. Each
fragment only ever evaluates its own cell in isolation, so a dot pushed
further than that would just clip at the cell's edge instead of visually
"arriving" in the neighboring cell (which has no idea a neighbor's dot is
encroaching on it). Reading as a strong magnetic lean near the cursor is the
goal here, not literal dots-flying-across-the-grid — that would need a
proper neighbor-search scatter (each fragment checking a 3×3 neighborhood of
cells for whose magnetized dot might land on it), a meaningfully bigger
shader — ask if you actually need that version.

**Magnetize dots/glyphs** (off by default) / **Magnet radius** / **Magnet
strength**, in the **Mouse interaction** folder.

`js/magnetism.js` (the classic DOM "magnetic hover" technique — element eases
toward the cursor within a proximity radius) is kept in the project as
unwired reference code for the *real* idea-shape elements on the live
Webflow hero, where it's the right tool (they're actual DOM/CSS elements, not
a rendered shader source). It's dependency-free (no GSAP), uses its own
`requestAnimationFrame` loop with the same frame-rate-independent lerp shape
as the rest of this sandbox, and exposes `initMagnetism(selector, options)` →
`{setRadius, setStrength, setEase, setEnabled}`. To try it on this page,
add elements with a `.magnetic` class and call `initMagnetism(".magnetic")`
from `main.js` — see the comment near the bottom of `index.html`.

**Removed, then redesigned (2026-07-28):** Cursor parallax tilt and Source
magnetism (both in the old 3D Transform folder) were originally pulled out
for feeling like jitter rather than an intentional reaction to the cursor —
see git history for that first attempt. Re-explored after seeing efecto.app's
"Interactivity" panel (Position/Rotation/Light + Momentum/Spring physics +
Mouse axes) — the actual fix wasn't "add it back," it was replacing the old
raw per-frame lerp with a real spring-damper, which is what was missing the
first time. See "3D Object interactivity" below for the current version.

## 3D Object interactivity (Mouse interaction → 3D Object tab)

Mouse-driven Position/Rotation/Light on the 3D source (spark/`.glb` only —
video/image sources aren't affected). One shared mass-spring-damper
(`interactSpringPos`/`interactSpringVel` in `main.js`) simulates a single
reactive 2D point — the mouse's offset from canvas center, -1..1 per axis —
and Position/Rotation/Light are just per-channel strength multipliers reading
off that *same* spring point, matching how efecto's panel has one Momentum/
Spring pair shared across all three channels rather than three separate
physics systems:

- **Position** — world-space offset added on top of the manual Position X/Y
  sliders (additive, not replacing — capped at 0.5 world units at
  strength=100).
- **Rotation** — tilt added on top of the manual Rotation X/Y sliders (and
  auto-rotate, if on) — mouse Y drives tilt around X, mouse X drives tilt
  around Y, capped at 25° at strength=100.
- **Light** — shifts the scene's key `DirectionalLight` position around its
  fixed rest pose (`KEY_LIGHT_REST`, the light's original (2,3,4)); doesn't
  touch the ambient light.
- **Momentum** — maps to the spring's *damping ratio*, inverted: higher
  Momentum = lower damping = more overshoot/bounce before it settles. At 0 the
  spring is overdamped (heavy, no bounce); near 100 it's underdamped (bouncy,
  can overshoot past the target before settling).
- **Spring** — maps to the spring's *stiffness*: higher = snappier/faster
  response to the cursor, lower = more lag before it starts moving.
- **Mouse axes** (`X only` / `Y only` / `Both`) — gates which axis of the
  shared spring's target actually moves; the other axis's target is forced to
  0, so the spring settles that axis back to center regardless of where the
  cursor is.

Moving the cursor off the canvas (`pointerleave`) resets the raw pointer
target back to center (0.5, 0.5) rather than freezing at its last position —
without this the spring would just hold whatever offset the cursor last had,
never settling back to rest. Physics are re-tuned live every frame from
`params.interactMomentum`/`interactSpring`, so dragging either slider
mid-interaction changes the feel immediately, no restart needed.

**Why one shared spring instead of three independent ones:** simpler to
reason about and tune (one Momentum/Spring pair to feel out instead of
three), and it's what the reference panel does — Position/Rotation/Light in
efecto read as "taps" on one physical reaction, not three unrelated
reactions that happen to share a name.

## Color mode + filters

**Color mode** (`uColorMode`, in the Color folder): `Grayscale` colors every
glyph/dot with the fixed `uFgColor` (current behavior); `RGB` tints each
glyph/dot with the **actual sampled source color** instead — same
density/coverage math either way, just a different tint source. The accent
threshold still recolors the brightest cells in both modes, since it's driven
by luminance, which stays meaningful for full-color source too.

**Removed: Tint 3D source with accent.** This used to force the procedural
pyramid's / uploaded `.glb`'s material color to always match the Accent
picker (visible only in RGB color mode). Pulled out along with parallax
tilt / source magnetism above — didn't earn its keep. The 3D source now
always renders with its own native material color(s)/texture.

**Filters** (new GUI folder), applied to the source color *before* the
luminance/coverage math — so they actually change glyph density and dot size,
not just the final tint:

- **Brightness** / **Contrast** — exact, standard multiply / pivot-around-0.5
  math. No caveats.
- **Blur** — a cheap 9-tap tent blur in texture space (`sampleSourceBlurred()`
  in the shader), not a true multi-pass gaussian blur. It's a pre-filter on
  the *source* to soften grainy/noisy video before it drives density — good
  enough for that job, but don't expect a smooth photographic blur look.
- **Glow** — an emissive brighten of cells already past the accent threshold
  (`outColor += uAccentColor * uGlowStrength * ...`). **This is not real
  bloom** — there's no bright-pass + blur + composite across neighboring
  cells, so it won't bleed light into the dark cells next to a bright one.
  It reads as "glow" on the cell itself, which is enough for a sandbox
  control, but if you need actual light bleed for production, that's a
  separate multi-pass effect (e.g. three.js's `UnrealBloomPass` via
  `EffectComposer`) applied on top of this shader's output, not a shader
  tweak in-place.

## Undo / redo

Two buttons at the very top of the panel — **↩ Undo** / **↪ Redo**, outside
any folder so they're always visible — plus **Ctrl/Cmd+Z** (undo) and
**Ctrl/Cmd+Shift+Z** or **Ctrl/Cmd+Y** (redo), same convention as most
desktop apps. Shortcuts are skipped while a real text field has focus (the
preset-name field, or a lil-gui number/color's text entry) so native browser
undo inside that field still works.

Covers virtually every action: any slider drag, color pick, checkbox,
dropdown (mode, color mode, **and** loading a preset), and switching source
(procedural pyramid / uploaded video / image / `.glb`) each push one step
onto a linear history stack (capped at 100 steps). Making a new change after
undoing some steps drops the old "redo" branch, same as any text editor.

This is deliberately separate from **Presets** above: presets are named
snapshots you save on purpose to keep long-term; undo/redo is an automatic,
unnamed trail of every step you took to get here in THIS session (not
persisted — reloading the page clears it, unlike presets which live in
`localStorage`).

**How it's wired (relevant if you're porting this pattern elsewhere):**
lil-gui's root `gui.onFinishChange(callback)` bubbles up from every
descendant controller the moment a real user interaction finishes (slider
release, color picker close, checkbox/dropdown click, text blur) — so one
call at the root automatically covers every control without touching each
individual `.add(...).onChange(...)` site. Critically, this only fires on
REAL user interaction, not on programmatic `.setValue()` calls — which is
exactly how loading a preset or restoring a history snapshot applies its
~30 values without each one re-triggering a spurious history push. Source
switches are `FunctionController` buttons, which don't fire `onFinishChange`
at all even on click (checked directly against lil-gui 0.19's source) — those
call `pushHistory()` explicitly instead, from inside `setSourceSpark` /
`setSourceVideo` / `setSourceImage` / `setSourceGLB` in `main.js`.

## Presets — save/load experiments to compare

Dialing in a look (mode + color + mouse + 3D transform, all at once) is easy
to lose track of once you've tried five variations. The **Presets (compare
experiments)** folder — first in the panel, since "load a saved combo" is
naturally the first move when comparing — snapshots every tunable param
(`PRESET_KEYS` in `main.js`; excludes upload/export buttons and the live
video scrub position, which aren't "settings") under a name you choose:

- **New preset name** + **💾 Save current as preset** — saves the CURRENT
  live state. Leave the name blank and it auto-numbers itself
  ("Experiment 1", "Experiment 2", ...). Saving over an existing name asks
  to confirm first.
- **Load experiment** (dropdown) — switch between saved snapshots on the
  same canvas to A/B compare. Selecting one calls `.setValue()` on every
  affected control (not just overwriting `params` silently), so every
  uniform/material updates exactly as if you'd dragged each slider by hand.
- **🗑 Delete selected** — removes whichever name is currently selected.
- **🔄 Refresh presets** — re-fetches the shared store, so you pick up a
  preset a teammate just saved without reloading the whole page.
- **⬇ Export all (.json)** / **⬆ Import (.json)** — the whole set of saved
  presets as one file, still useful for archiving a specific set or seeding
  a fresh deploy. Importing merges into whatever's already saved; same-name
  entries in the imported file win.

**Shared, not per-browser:** presets are stored server-side (`api/presets.js`
+ Upstash Redis — see "Live / shared preset library" below), not `localStorage`.
A preset one person saves shows up for everyone else on the team hitting the
same deployed URL, since this is meant to be a shared tool. Running it
locally via `npx serve .` (no Vercel dev server) will fail to save/load
presets — see the setup section below for `vercel dev`.

## Live / shared preset library (Vercel deploy)

Deploying this is just "push a static site" — there's no build step, and
`api/presets.js` is a single Vercel Serverless Function, auto-detected by
Vercel with no extra config. What you need to set up once:

1. **Push this folder to a GitHub repo** (if it isn't already), then in the
   Vercel dashboard: **Add New → Project → Import** that repo. Framework
   preset: "Other" (no build command needed — it's static files + `/api`).
2. **Provision Upstash Redis**: in the new project → **Storage** tab →
   **Create Database** (or **Browse Storage**) → under **Marketplace
   Database Providers**, pick **Upstash** ("Serverless DB: Redis, Vector,
   Queue, Search") — NOT the "Redis" tile (that's a separate Redis Cloud
   integration with different setup). Vercel's own native "KV" product was
   retired in December 2024; Upstash is its direct successor and kept the
   exact same env var names for drop-in compatibility. Create the database,
   then connect it to this project when prompted — Vercel auto-injects the
   `KV_REST_API_URL` / `KV_REST_API_TOKEN` env vars that `api/presets.js`
   reads via `@upstash/redis`'s `Redis.fromEnv()`. You don't set these by
   hand.
3. **Redeploy** (Vercel → Deployments → ⋯ → Redeploy) after connecting
   Upstash, so the new env vars actually reach the function.
4. Share the deployment URL with the team. That's it — no accounts, no
   login, everyone hits the same shared preset store.

**Local development against the shared store:** `npx serve .` serves the
static files but has no `/api` route, so Presets will fail with the "Couldn't
reach the shared preset store" alert (everything else in the tool works
fine offline). Use `npx vercel dev` instead (from the Vercel CLI, `npm i -g
vercel`, then `vercel link` once to connect this folder to the Vercel
project) to run both the static site AND `api/presets.js` locally against
the real Upstash store.

**Known trade-offs (fine for an internal team tool, worth knowing):**

- **No authentication** — anyone with the deployed URL can read/write the
  shared preset store via `/api/presets` directly, not just through the GUI.
  Don't put anything sensitive in a preset name. If you need real access
  control, put the whole Vercel deployment behind Vercel's built-in
  password/SSO protection (Project Settings → Deployment Protection) rather
  than trying to gate the API alone.
- **Last-write-wins, no conflict resolution** — Save/Delete replaces the
  whole store wholesale (`redis.set` overwrites everything). Two people saving
  at almost the exact same moment can clobber each other's unrelated
  changes. Not a real risk in practice for occasional preset saves, but
  don't expect proper merge behavior.
- **One shared list, no per-person scoping** — there's no login, so there's
  no concept of "my presets" vs "the team's presets." Everyone sees and can
  delete everything. Fine for a small trusted team; if that becomes a
  problem, that's the point where this needs real auth + per-user rows, not
  a bigger version of this same approach.

## Preview frame (framing guide, not export)

**Preview frame** dropdown, top-level on the Look & Output panel (next to
Capture/Record) — overlays a dashed-border guide rect matching a target
aspect ratio, with everything outside it dimmed. Presets mirror what Unicorn
Studio's own artboard picker offers (Square 1080×1080, Window 1512×863,
iPhone 14 Pro Max, iPad Pro 11", MacBook Pro), so you can sanity-check
Scale/Position framing against the SAME sizes before moving settings over to
Unicorn for the real capture.

Deliberately scoped down from a full artboard/export system, decided
2026-07-28: this is a **pure DOM overlay** (`#preview-frame` in `index.html`,
sized by `updatePreviewFrame()` in `main.js`) that never touches
`uResolution`, the renderer, or `renderTarget` — the canvas keeps rendering
full-bleed exactly as before, and Capture/Record output is completely
unaffected by whatever the dropdown is set to. Building an actual
fixed-resolution export pipeline (decoupling render size from the browser
window, so Capture/Record produce pixel-exact 1080×1080 etc. files) was
explicitly ruled out as scope creep — that's a real production-export
capability Unicorn already owns; this sandbox's job is tuning parameters,
not becoming a second export pipeline. If pixel-exact fixed-size export ever
becomes a real need, that's a materially bigger change (see "Working
conventions" above) and should be discussed as its own decision, not bolted
onto this preview feature.

## Export

Three independent things. **📸 Capture (PNG)** and **● Start Recording** sit
at the root of the Look & Output panel (not inside a folder) — see "The
lil-gui panel" below for why; the other two live in the **Export settings**
folder:

- **📸 Capture (PNG)** (root-level) / **Save snapshot (WebP)** (Export
  settings folder, alternate format) — instant single-frame capture via
  `canvas.toBlob()`. Works regardless of source type, no recording needed.
- **● Start Recording / ■ Stop & Save Recording** (root-level) — a single
  toggle button (there's no unified "play" state across video/image/3D
  sources in this tool, so this is a dedicated record control rather than
  literally repurposing video playback). Captures the canvas live via
  `canvas.captureStream()` + `MediaRecorder`, and downloads the result the
  moment you stop.
- **Also capture GIF** (Export settings folder, off by default) — runs a
  second, independent capture in parallel using `gif.js`, sampling frames at
  12fps. Off by default because GIF encoding is CPU-heavy and scales with
  clip length; turn it on only when you actually want a GIF out of a given
  recording.

### Video format reality check: WebM is the reliable one, not MP4

Chromium (Chrome/Brave) ships a software WebM encoder (VP8/VP9 + Opus) by
default. `MediaRecorder`'s MP4/H.264 output only works if the OS exposes a
hardware encoder to the browser — inconsistent across machines, and not
something this code can guarantee. `pickVideoMimeType()` in `main.js` tries
MP4 first via `MediaRecorder.isTypeSupported()` and only falls back to WebM
if that fails, so you'll get MP4 for free on machines where it works — but
**don't rely on MP4 being the output**. If you need a guaranteed `.mp4` for a
client deliverable, the reliable path is: record the WebM here, then convert
it afterward (`ffmpeg -i in.webm out.mp4`, or any online converter) — not
trying to force MediaRecorder into MP4.

### Recording quality: bitrate is now scaled to resolution, not the browser default

`MediaRecorder` without an explicit bitrate defaults to roughly ~2.5 Mbps
regardless of canvas resolution — tuned for typical camera footage, not this
kind of high-frequency content. Every glyph edge and dither dot is exactly
the fine detail lossy video compression eats first, so recordings came out
visibly soft/blocky compared to what's on screen. `pickVideoBitsPerSecond()`
in `main.js` now scales bitrate to the actual capture resolution (roughly
0.3 bits/pixel/frame, clamped to 8–50 Mbps) instead of relying on the
browser's default — noticeably crisper output, at the cost of a larger file
(fine for a short review/dev-handoff clip; lower the multiplier in
`pickVideoBitsPerSecond()` if file size becomes a problem for longer clips).

### Recordings won't Trim in QuickTime Player — this is a MediaRecorder limitation, not a bug you can fix client-side

`MediaRecorder` streams output live as it records ("fragmented" muxing) —
even when it hands you a real `.mp4`, the file's internal structure isn't
the same as one exported by a normal video editor: no single, complete
sample table at the front of the file the way QuickTime expects for its
non-destructive Trim tool (⌘T). The file plays back fine (that's why you can
judge quality by eye) but QuickTime's Trim handles rely on that upfront
index, which a live-muxed recording doesn't have — this is true of
MediaRecorder output in every browser, not something a client-side JS tweak
can fix. WebM has the same problem plus QuickTime doesn't understand WebM's
container at all.

**Fix: re-mux or re-encode with `ffmpeg` before trimming/editing.** Which
command depends on what `pickVideoMimeType()` actually gave you:

```bash
# if the file is already .mp4 (H.264) — fast, lossless remux, just rebuilds
# a proper index/moov atom so QuickTime (and any other editor) can Trim it:
ffmpeg -i ascii-capture.mp4 -c copy -movflags +faststart ascii-capture-fixed.mp4

# if the file is .webm (VP8/VP9) — MP4 can't contain those codecs, so this
# has to actually re-encode to H.264 (not just remux); -crf 16 is
# visually-near-lossless, matching the higher recording bitrate above:
ffmpeg -i ascii-capture.webm -c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p -movflags +faststart ascii-capture.mp4
```

Either command produces a normal, fully Trim-able QuickTime/Final Cut/Premiere-
ready file. Do this once as a cleanup pass on whatever you actually intend to
hand off or edit further — don't rely on the raw recording being edit-ready.

### GIF export and the same cross-origin Worker problem as MSDF baking

`gif.js` spins up its own Web Worker internally via
`new Worker(options.workerScript)`. Passing it the raw jsdelivr CDN URL
directly would fail — browsers block a classic (non-module) Worker script
loaded cross-origin, the exact same restriction that broke
`@zappar/msdf-generator`'s Worker during MSDF atlas baking (see the
"Re-baking the MSDF atlas" section below). The fix here is the same shape:
`getGifWorkerBlobUrl()` in `main.js` `fetch()`s `gif.worker.js`'s source as
text, wraps it in a same-origin `blob:` URL via `URL.createObjectURL()`, and
hands *that* to `gif.js` instead of the CDN URL. Cached after first use so
repeat recordings don't re-fetch it.

## Mouse interactivity

`uMouse` (normalized UV, already Y-flipped in `main.js` to match `vUv`'s
bottom-left origin) plus `uMouseRadius`/`uMouseStrength` drive a soft-falloff
`influence` value per pixel. Currently this nudges local luminance/brightness
and blends toward `uAccentColor` near the cursor — extend this in
`main.frag.glsl`'s `influence` usage if you want mouse proximity to also
affect cell size, glyph choice, or add a scramble/flicker.

### The oval bug (fixed) — why circular falloffs need aspect correction

`distance(vUv, uMouse)` looks correct but isn't: `vUv` is 0..1 on *both* axes
regardless of the canvas's actual aspect ratio, so equal UV deltas on x vs. y
cover different pixel counts whenever the canvas isn't square — a "circular"
falloff computed this way renders as an oval, stretched along whichever axis
is longer in pixels. The fix (`main.frag.glsl`, right before the `influence`
calc): scale `mouseDelta.x` by `canvasAspect` before taking `length()`, so
equal-pixel-distance points produce equal corrected-UV distance regardless of
canvas shape. The trail pass (`trail.frag.glsl`) does the same correction via
its own `uCanvasAspect` uniform, kept in sync in `resize()`.

### Cursor smoothing (easing)

The shader never sees the raw pointer position. `main.js` keeps two Vector2s:
`mouseUv` (raw, updated instantly on `pointermove`) and `smoothMouseUv` (what
`uMouse` actually binds to), and every frame in `tick()` eases the latter
toward the former:

```js
const lerpT = 1 - Math.pow(1 - params.mouseSmoothing, dt * 60);
smoothMouseUv.x += (mouseUv.x - smoothMouseUv.x) * lerpT;
smoothMouseUv.y += (mouseUv.y - smoothMouseUv.y) * lerpT;
```

This is frame-rate independent (normalized against a 60fps reference via
`dt * 60`), so it feels the same at 30fps or 144fps. **Cursor smoothing** in
the GUI is `params.mouseSmoothing` — lower = laggier/smoother follow, `1` =
instant/snappy (matches the old behavior).

### Cursor trail (decaying accumulation buffer)

The reference the "Awwwards feeling" ask was based on (an agency site where
dots stay lit briefly after the cursor passes, then fade) needs more than a
single instantaneous distance check — cells need to *remember* recent cursor
proximity. That's a second, fully separate render pass:

- `trailRTA` / `trailRTB` — two `WebGLRenderTarget`s ping-ponged every frame
  (one holds "last frame's trail", the other gets written to as "this
  frame's trail", then they swap roles). Sized to match the canvas's aspect
  ratio (capped at 640px on the long side — it's just a soft blob + decay,
  doesn't need high resolution), kept in sync in `resize()`.
- `shaders/trail.frag.glsl` — the pass that runs into whichever target isn't
  "current": read the previous trail, multiply by `uDecay` (fade), then
  additively stamp a soft circle at the (smoothed) cursor position sized by
  the same `uMouseRadius` as the live influence circle, for a consistent feel.
- `main.frag.glsl` samples the result as `uTrailTex` and takes
  `max(instantInfluence, trailHeat)` — instantaneous proximity and lingering
  trail combine without double-brightening on top of each other.
- **Enable trail** / **Trail decay** / **Trail strength** in the GUI.
  Disabling doesn't hard-cut the trail — it zeroes the stamp so any existing
  glow fades out per the decay rate instead of vanishing.

## Scramble text — two-phase plan

**Phase (a), built but not wired into this view:** `js/scrambleText.js` hovers
real DOM text (headline/CTA) through GSAP's `ScrambleTextPlugin`. The demo
headline was removed from `index.html` to keep this a pure canvas/shader
sandbox — to bring the scramble-text demo back, add a `[data-scramble]`
element plus the two `gsap-trial` `<script>` tags and an
`initScrambleText()` call in `main.js` (the exact snippet is commented at the
bottom of `index.html`). Keeping real DOM text (not shader-drawn text) matters
for accessibility/SEO — the scramble is a decoration, not a replacement for
the content.

**Phase (b), not yet built:** per-glyph scramble driven by cursor proximity,
integrated into the ASCII shader itself (glyphs near the cursor cycle through
random charset entries before settling). If you build this, the natural hook
point is inside the `uMode == 0` branch of `main.frag.glsl` — bias
`glyphIndexFromLuminance`'s result with a time+distance-seeded random index
when `influence` is high, then ease back to the real index.

### Important note on GSAP ScrambleTextPlugin licensing

`ScrambleTextPlugin` is a GSAP "Club/Bonus" plugin. Its `.d.ts` type
declaration ships in the public `gsap` npm package, but **the actual runtime
JS does not** — confirmed by inspecting the published package tarball
directly. The publicly CDN-hosted build that includes the real plugin code is
`gsap-trial` (GreenSock/Webflow's own official evaluation package — this is
the standard way the community loads Club plugins from a public CDN, and
what `index.html` uses here):

```html
<script src="https://cdn.jsdelivr.net/npm/gsap-trial@3.13.0/dist/gsap.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/gsap-trial@3.13.0/dist/ScrambleTextPlugin.min.js"></script>
```

Use the **same version** for both files (core + plugin) to avoid a mismatch.
Before shipping this to production, confirm with GreenSock/Webflow's current
licensing terms whether `gsap-trial` is appropriate for production use, or
whether your Webflow plan already includes a licensed Club-plugin bundle.

## The lil-gui panel — two docked panels, not one

Originally a single column with 9 folders stacked top to bottom — functional,
but it read as one undifferentiated wall of controls with no sense of "what
kind of decision am I making right now." Split into two panels docked to
opposite edges, grouped by what you're actually deciding, not just
alphabetically or by when the feature was added:

**Left — "Session"** (what you're looking at, and where you are in your own
workflow — set up once per pass, or touched occasionally to branch/compare):

- **↩ Undo** / **↪ Redo** — top-level, outside any folder (see "Undo / redo"
  above)
- **Presets (compare experiments)** — save/load/export named param snapshots
  (see "Presets" above)
- **Source** — switch between the procedural pyramid, an uploaded
  video/image/`.glb`, and 3D auto-rotate toggle
- **3D Transform** — scale, position X/Y, rotation X/Y/Z (cursor parallax
  tilt and source magnetism were removed — see "Magnet dots/glyphs" section
  above)
- **Image/Video Framing** — scale + position X/Y for image/video sources
  (added 2026-07-28: `coverUv()` always crops an uploaded image/video to
  fill the frame with no way to zoom out, so this adds a UV zoom/pan on top
  — 1.0/(0,0) matches the old always-fill behavior exactly. Scale below 1.0
  reveals real background around the source (via `uImageOffset`/
  `inFrameBounds` gating `contentMask` in `main.frag.glsl`), not a
  clamped/stretched texture edge. This is the 2D-source equivalent of "3D
  Transform" above — image/video sources have no Object3D to move, so it's
  a plain UV transform instead of a real scene-graph transform)

**Right — "Look & Output"** (how it renders, and getting it out — where you
actually spend most of a tuning session):

- **📸 Capture (PNG)** / **● Start Recording** — top-level, outside any
  folder. Promoted here (instead of living inside the Export folder) to
  mirror how Efecto and most premium editors separate ACTIONS you take once
  you're happy from SETTINGS you tune repeatedly — these are the actual
  triggers, always one click away without opening a folder.
- **Effect** — Mode tab bar (ASCII / Dither / Smooth Dot, see "GUI reskin"
  below), cell size, invert, blue-noise scale, dot levels (scramble reveal on
  load and idle shimmer were both removed — see Known limitations)
- **Color** — color mode, background/foreground/accent + accent luminance
  threshold
- **Filters** — brightness/contrast/blur/glow (see "Color mode + filters"
  above)
- **Mouse interaction** — same tab-bar pattern as Effect/Mode (generalized
  into reusable `.gui-tabbar`/`.gui-tab` CSS, see "GUI reskin" below), split
  into two tabs: **Dots / Glyphs** (radius/strength/smoothing/trail/magnet —
  see "Cursor smoothing", "Cursor trail", and "Magnet dots/glyphs" above) and
  **3D Object** (Position/Rotation/Light/Momentum/Spring/Mouse axes — see "3D
  Object interactivity" above). Built on real lil-gui sub-folders
  (`dotsFolder`/`interactFolder`), toggled via their own `.show()`/`.hide()`
  rather than per-controller-row visibility, since a whole folder's worth of
  controls moves together
- **Export settings** — WebP snapshot format + "Also capture GIF" toggle
  only; the PNG capture/record triggers themselves live at the panel root
  above, not here (see "Export" above)
- **Dev handoff** — re-download the current MSDF atlas files

The two rows are grouped by decision type rather than an even folder split,
so neither panel ends up dramatically taller than the other on a typical
viewport (row counts have shifted some as controls were added/removed since
the initial split).

**How it's built:** two independent root `GUI` instances (`guiSession` /
`guiLook` in `main.js`), each mounted into its own fixed-position container
div (`#gui-left` / `#gui-right` in `index.html`) via lil-gui's `container`
constructor option — passing `container` skips lil-gui's own default
top-right `position: fixed` auto-placement entirely, so the two container
divs' CSS controls the docking instead. Both panels register their own
`.onFinishChange()` into the same `pushHistory()` (see "Undo / redo"), and
`controllerMap` (used to replay presets/undo snapshots through real GUI
controllers) is built from both panels' `controllersRecursive()` merged
together. lil-gui has no native file-picker control, so the **Upload Media**
button triggers a hidden `<input type="file">` (`#media-input` in
`index.html`, `accept="video/*,image/*,.glb,.gltf"`) — one combined picker
instead of a separate button per source type, matching the single
"Upload Media" pattern from tools like DITHR rather than three disconnected
buttons. `routeUploadedFile()` in `main.js` sorts the picked file to
`setSourceVideo`/`Image`/`GLB`: `.glb`/`.gltf` is detected by file
**extension** (browsers don't reliably set a MIME type for that format);
image/video are detected by `file.type`'s MIME prefix (that IS reliable for
those). An unrecognized file shows an alert rather than failing silently.
OBJ/STL aren't wired in — this project only ever built a GLTFLoader path —
adding them would mean pulling in three's `OBJLoader`/`STLLoader` the same
way; ask if you need those formats too. The input resets its own `.value`
after reading the file, since otherwise the browser won't fire `change`
again if you pick the exact same file a second time.

## GUI reskin + Mode tab bar (2026-07-28)

Two changes shipped together after weighing options against efecto.app's UI
(see "Working conventions" — this was a Tier 1 scope call, confirmed before
any code was written):

**1. Visual reskin.** CSS-only, layered on lil-gui's own theming API (the
`--background-color`/`--widget-color`/etc. custom properties, see
`index.html`'s `.lil-gui` rule) plus a few targeted rules for things lil-gui
doesn't expose a variable for:
- Boolean controllers (Invert, Enable trail, Auto-rotate, ...) render as
  iOS-style toggle switches instead of lil-gui's default checkbox — still a
  real `<input type="checkbox">` underneath, purely `appearance: none` +
  `::before` for the knob, so state/onChange/presets/undo-redo are untouched.
- Folder titles ("Effect", "Color", "Filters", ...) softened from a filled bar
  into a quiet uppercase label; the two root panel titles ("Session" / "Look
  & Output") stay a bit bolder since they're the top-level sections.
- Slightly larger type (11px → 12px), rounder corners on selects/sliders/
  buttons, a touch more row padding.
- Kept the tool's own brand accent (`--accent`, `#ff451a`) for "on"/active
  states rather than cloning efecto's monochrome look — same interaction
  patterns, our own identity.
- Explicitly out of scope: a media library/asset browser, account/avatar UI,
  cloud-sync icon — ruled out when this was scoped, not omitted by accident.

**2. Mode tab bar.** The single 8-item "Mode" dropdown in the Effect folder
read as one flat list with no sense of "what kind of effect am I even in."
Replaced (visually) with 3 tabs — **ASCII** / **Dither** / **Smooth Dot** —
plus a secondary dropdown that only appears under the Dither tab, listing its
6 algorithms (Bayer 4x4/8x8/16x16, Blue Noise, IGN, Random).

Implementation, `js/main.js`'s `buildModeTabBar()`: the real `mode` lil-gui
controller is NOT replaced — it's kept fully alive (still driving
`uniforms.uMode`, still in `controllerMap` for presets/undo-redo) and just
visually hidden (`.gui-row-hidden`). The tab bar and dither `<select>` are
plain DOM elements inserted right after its row; clicking a tab or picking an
algorithm calls `modeController.setValue(...)`, which is the same "change the
mode" code path as the old dropdown — so no logic duplication. `syncModeUI()`
re-reads `MODE_FAMILIES[params.mode]` to highlight the right tab, show/hide
the dither sub-select, and show/hide the two mode-specific rows ("Blue noise
scale" only for Blue Noise, "Dot levels" only for Smooth Dot). It's called
from the mode controller's own `onChange`, which fires no matter what changed
`params.mode` — tab click, dither sub-select, preset load, or undo/redo — so
there's one sync path instead of one per trigger. Tab/select clicks also
explicitly call `pushHistory()` rather than assuming `setValue()` bubbles into
`guiLook.onFinishChange()` (untested assumption otherwise, and undo-history
gaps are cheap to prevent but annoying to debug after the fact).

The `.gui-tabbar`/`.gui-tab`/`.gui-row-hidden` CSS classes (originally named
`.mode-*`) were generalized the same day this shipped, once "Mouse
interaction" needed the identical tab-bar treatment — see
`buildMouseInteractionTabBar()` and "3D Object interactivity" above. That
second use case is simpler: it toggles two whole lil-gui sub-folders via
their own `.show()`/`.hide()` instead of individual controller rows, since a
folder's contents always move as a unit.

**3. Scrollbar removal.** `#gui-left`/`#gui-right` keep `overflow-y: auto`
(so the panels still scroll when taller than a shrunk browser window) but
hide the scrollbar's own track/thumb chrome (`scrollbar-width: none` +
`::-webkit-scrollbar { display: none }`) — a visible OS scrollbar riding the
panel edge read as an unfinished/default-browser element next to the rest of
this reskin.

**Not yet browser-verified.** Chrome automation runs against the user's real
browser, which can't reach this sandbox's local filesystem — testing this
needs either a push + Vercel redeploy, or `npx serve .` run directly on your
own machine (not from this environment). Reviewed via `node --check`, a CSS
brace-balance check, and re-tracing every DOM selector (`.controller`,
`.controller.boolean`, `modeController.domElement`, `dotsFolder`/
`interactFolder`'s `.children`) against the live DOM dump captured earlier in
this session — but please eyeball it once deployed.

## Re-baking the MSDF atlas (`tools/msdf-bake/`)

You do not need this to run the sandbox — `assets/msdf/atlas.png` +
`atlas.json` are already baked and checked in. Re-bake only if you want a
different font, charset, resolution, or distance field range.

```bash
cd tools/msdf-bake
npm install
node bake.mjs <font.ttf> <charset.txt> <outDir> [fontSize] [texW,texH] [fieldRange]
# example (regenerates what's already in assets/msdf/):
node bake.mjs JetBrainsMono-Bold.ttf charset.txt ../../assets/msdf 64 256,256 4
```

**Why this exists as a Node script instead of using `@zappar/msdf-generator`
directly in the browser:** that package's public API wraps a WASM module in a
`Worker` (via `comlink`), which requires the worker script to be same-origin
— it breaks under `file://` and most CDN setups without extra bundler
config. `bake.mjs` sidesteps this entirely by calling the package's
underlying WASM module directly in Node (no Worker, no comlink), copied from
its `dist/worker.js` source (MIT-licensed) with one patch: the browser-only
`new ImageData(...)` call is replaced with a plain `{data,width,height}`
object, since Node has no `ImageData` global. The result is PNG-encoded with
`pngjs` (pure JS, no native deps — matters here since this sandbox has no
compiler toolchain for native addons).

**Why the font file is a `.ttf` and not the more common `.woff`/`.woff2`:**
`msdfgen` (via `stb_truetype`/FreeType-style parsing) reads raw SFNT tables
directly and doesn't understand WOFF's compressed container format. The
bundled `JetBrainsMono-Bold.ttf` was produced by decompressing the official
JetBrains Mono WOFF2 with the `wawoff2` npm package. If you swap fonts, make
sure you're feeding `bake.mjs` a real `.ttf`/`.otf`, not a `.woff`/`.woff2`.

`charset.txt` is the locked charset `@%#*+=-:. ` (with a trailing space,
matching the Framer `AsciiVideo` recipe already in production) — edit it if
you want to test a different glyph ramp; the shader/`msdfAtlas.js` will
automatically follow whatever's in `atlas.json`.

## Known limitations / next steps

- Rotation (`rotX/Y/Z` + auto-rotate) spins the model around its OWN origin,
  not its bounding-box center — for most uploaded character/prop models
  (origin at the feet, or at world origin) this means it visually orbits
  around that point rather than spinning in place. Centering (position) is
  correct regardless — see `sourceCenterOffset` in `main.js` — but true
  rotate-around-center would need the same offset applied before rotation,
  not just before scale. Not fixed yet since it's more noticeable on tall/
  offset-origin uploads than on the default pyramid or typical hero assets.
- Uploaded `.glb` models with genuinely transparent/translucent materials
  will have that transparency read as "empty background" by the alpha
  content-mask and fade toward `uBgColor` instead of rendering as ink — see
  "Background masking: alpha, not luminance" above.
- `screenPxRange` in the MSDF sampler is an approximation, not derived from
  each glyph's actual atlas pixel size (see note above).
- Blue Noise is a histogram-equalized high-pass approximation, not true
  void-and-cluster blue noise.
- Per-glyph cursor-proximity scramble (phase b of the scramble-text spec) is
  designed but not implemented — see "Scramble text" above for the hook point.
- **Dot flicker on video sources (Bayer/blue-noise/IGN/Random modes).** Real
  video has a little frame-to-frame luminance jitter even on a static-looking
  shot (sensor/codec noise). The dithering branch used a hard `step(threshold,
  l)` to decide each cell's on/off — any cell whose luminance sat near its own
  per-cell threshold flipped fully on↔off every time that jitter crossed the
  line, visible as scattered per-dot sparkle inside the subject (confirmed by
  diffing consecutive frames: zero change in flat/background regions, noise
  concentrated only in the dithered content). Fixed by widening that to a
  narrow `smoothstep(threshold - 0.035, threshold + 0.035, l)` band in
  `main.frag.glsl`, so a threshold-crossing fades the dot in/out over a couple
  of frames instead of popping — same underlying source noise, much less
  perceptible. If it's still visible on very noisy footage, the next lever is
  pre-blurring the source more (`Blur` slider) or a proper temporal fix
  (exponential-moving-average the per-cell luminance across frames via a
  ping-pong accumulation buffer, same pattern as the cursor trail buffer) —
  not implemented since the smoothstep band was enough for the reported case.
- No mobile/touch testing done yet — `pointermove` is wired, but touch
  devices won't have a persistent "hover" position; decide on a touch
  fallback (e.g. last-touch-point with a timeout) before shipping.
- 3D source render target is capped at 2048px and re-sized on window resize —
  fine for a sandbox, but check GPU cost before using a large render target
  in production on lower-end devices.
- "Glow" is an emissive approximation, not true multi-pass bloom (see "Color
  mode + filters" above) — upgrade to `UnrealBloomPass`/`EffectComposer` if
  you need real light bleed.
- Recording only reliably guarantees WebM output; MP4 depends on the host
  OS's encoder and GIF export is CPU-heavy for long clips (see "Export"
  above). Bitrate is now scaled to resolution for noticeably better quality,
  but raw recordings still won't Trim in QuickTime Player until you run them
  through the `ffmpeg` remux/re-encode command in "Export" — that's an
  inherent limitation of `MediaRecorder`'s live-muxed output, not something
  fixable client-side.
- Presets live in `localStorage`, scoped to this browser/machine/origin —
  clearing site data wipes them, and they don't sync anywhere (see "Presets"
  above). Export before relying on them long-term.
- Undo/redo history is in-memory only (not persisted — reload clears it),
  capped at 100 steps, and keeps every uploaded video/image/.glb's object URL
  alive for the whole session so it can switch back to an earlier upload
  without re-prompting a file picker — a long session with several large
  uploads holds all of them in memory at once (see "Undo / redo" above).
