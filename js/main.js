import * as THREE from "three"; // resolved via the import map in index.html
import { GLTFLoader } from "https://cdn.jsdelivr.net/npm/three@0.128.0/examples/jsm/loaders/GLTFLoader.js";
// Real bloom for the 3D source (see "Bloom" section below) — same three@0.128.0
// version as GLTFLoader above, official examples/jsm addons, not something we wrote.
import { EffectComposer } from "https://cdn.jsdelivr.net/npm/three@0.128.0/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "https://cdn.jsdelivr.net/npm/three@0.128.0/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "https://cdn.jsdelivr.net/npm/three@0.128.0/examples/jsm/postprocessing/UnrealBloomPass.js";
import GUI from "https://cdn.jsdelivr.net/npm/lil-gui@0.19/dist/lil-gui.esm.js";
import { loadMSDFAtlas } from "./msdfAtlas.js";
import { generateBlueNoiseCanvas } from "./blueNoise.js";
// scrambleText.js (phase-a GSAP scramble module) isn't wired in here — see
// index.html's comment near the bottom for how to re-enable it.
// magnetism.js (DOM "magnetic hover" technique, for real idea-shape elements
// on the live page) also isn't wired in here — see index.html's comment near
// the bottom. This sandbox's own take on "magnetism" is "Source magnetism"
// below, which pulls the rendered 3D source itself instead of needing
// placeholder DOM boxes.

// ---------------------------------------------------------------------------
// Mode enum — keep in sync with shaders/main.frag.glsl's uMode branches.
// ---------------------------------------------------------------------------
const MODES = {
  "ASCII (MSDF)": 0,
  "Bayer 4x4": 1,
  "Bayer 8x8": 2,
  "Bayer 16x16": 3,
  "Blue Noise": 4,
  "IGN": 5,
  "Random (baseline)": 6,
  // Direct quantized luminance -> dot size, no Bayer/blue-noise threshold at
  // all — see this mode's branch in main.frag.glsl for why it exists
  // alongside the ordered-dithering modes above rather than replacing them.
  "Smooth Dot": 7,
};

// ---------------------------------------------------------------------------
// Mode "families" — a purely-UI grouping for the tab bar built in
// buildModeTabBar() (see the "Effect" folder below). MODES/uMode above stays
// the single source of truth for what actually renders; this just groups
// those 8 values into 3 tabs so the Effect folder reads as "pick a family,
// then (only for Dither) pick which of the 6 algorithms" instead of one flat
// 8-item dropdown — same information, friendlier information architecture.
// ---------------------------------------------------------------------------
const MODE_FAMILIES = {
  "ASCII (MSDF)": "ASCII",
  "Smooth Dot": "Smooth Dot",
  "Bayer 4x4": "Dither",
  "Bayer 8x8": "Dither",
  "Bayer 16x16": "Dither",
  "Blue Noise": "Dither",
  "IGN": "Dither",
  "Random (baseline)": "Dither",
};
const DITHER_ALGORITHMS = ["Bayer 4x4", "Bayer 8x8", "Bayer 16x16", "Blue Noise", "IGN", "Random (baseline)"];
// Representative mode to jump to when a family tab is clicked directly
// (as opposed to picking a specific algorithm from the Dither sub-select).
const FAMILY_DEFAULT_MODE = {
  "ASCII": "ASCII (MSDF)",
  "Dither": "Bayer 8x8",
  "Smooth Dot": "Smooth Dot",
};

// ---------------------------------------------------------------------------
// "Preview frame" (Look & Output -> Preview frame) — PREVIEW ONLY. Deliberately
// scoped down from a full Unicorn-Studio-style artboard/export system (that
// would mean decoupling the render target's resolution from the browser
// window and rebuilding Capture/Record around fixed output sizes — a real
// production-export pipeline, which is Unicorn's job, not this sandbox's).
// This just overlays a guide rect matching a target aspect ratio so
// Scale/Position framing can be sanity-checked against it before moving
// settings over to Unicorn for the actual capture. Sizes mirror the presets
// Unicorn's own artboard picker offers, so what you frame here lines up with
// what you'll pick over there.
const PREVIEW_FRAME_PRESETS = {
  "Off": null,
  "Square (1080×1080)": [1080, 1080],
  "Window (1512×863)": [1512, 863],
  "iPhone 14 Pro Max (430×932)": [430, 932],
  "iPad Pro 11\" (834×1194)": [834, 1194],
  "MacBook Pro (1440×900)": [1440, 900],
};

// ---------------------------------------------------------------------------
// Renderer / display scene (a single full-screen quad running main.frag.glsl)
// ---------------------------------------------------------------------------
const canvas = document.getElementById("gl-canvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
// Transparent clear globally — the main canvas is always 100% overpainted by
// the ASCII/dither full-screen quad regardless of this, so it's only the
// OFFSCREEN renderTarget render (sourceScene, see below) that actually cares:
// clearing to alpha 0 there means uSource's alpha channel is a real "did a
// mesh pixel land here" mask (1 = model, 0 = empty background) instead of
// relying on scene.background's flat clear COLOR as a luminance proxy for
// "background," which mouse influence/trail could nudge across a glyph/dot
// bucket boundary — see main.frag.glsl's uSourceIsMasked comment.
renderer.setClearColor(0x000000, 0);

const displayScene = new THREE.Scene();
const displayCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

// ---------------------------------------------------------------------------
// Source scene (video / image / procedural spark / uploaded glb) — rendered
// to a WebGLRenderTarget for the 3D cases, or just used directly as a texture
// for video/image. Either way, uSource in the shader only ever sees "a
// texture" — this is the "unify every source" pipeline decision from spec.
// ---------------------------------------------------------------------------
const sourceScene = new THREE.Scene();
// No scene.background color — left transparent so the renderTarget's alpha
// channel is a genuine "is there a mesh pixel here" mask (see the renderer's
// setClearColor(0x000000, 0) above + uSourceIsMasked in main.frag.glsl).
const sourceCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
sourceCamera.position.set(0, 0, 4.5);

let renderTarget = new THREE.WebGLRenderTarget(1024, 1024, {
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  format: THREE.RGBAFormat,
});

// ---------------------------------------------------------------------------
// Bloom — real soft light-bleed around bright/emissive parts of the 3D
// source (e.g. a glowing .glb accent, like a star), instead of the shader's
// old per-cell "Glow" brighten (a flat emissive boost on hot ASCII/dither
// cells with zero spatial spread — see main.frag.glsl's outColor glow term).
// That per-cell version is KEPT as-is for video/image sources (no 3D scene
// to bloom there), but for spark/glb sources this gives the same "Glow"
// slider (params.glow) actual neighbor-bleeding blur.
//
// Rendered as a SEPARATE pass from the main renderTarget above rather than
// bolted onto it, on purpose: UnrealBloomPass's internal composite doesn't
// reliably preserve the original alpha channel (it's built for opaque game
// scenes, not for carrying an "is there real content here" mask through). If
// we bloomed renderTarget directly, the alpha-based content-mask that fixed
// the background-noise bug (see uSourceIsMasked in main.frag.glsl) would
// break again — background pixels touched by bloom's blur would read as
// non-zero alpha and get treated as real content.
//
// So: renderTarget stays exactly as before (correct, un-bloomed alpha for
// masking); bloomComposer renders the SAME scene into its own target, and
// only its RGB is sampled (via uBloomTex) and additively mixed into srcColor
// in the shader, BEFORE luminance/glyph mapping — so the glow genuinely
// lightens neighboring cells' density instead of just recoloring cells that
// were already going to be dense/sparse anyway.
//
// `renderer` (THREE.WebGLRenderer) is already declared above this point —
// see the top of this file.
const bloomComposer = new EffectComposer(renderer);
bloomComposer.renderToScreen = false;
bloomComposer.addPass(new RenderPass(sourceScene, sourceCamera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(1024, 1024),
  0,    // strength — driven live from params.glow in tick(), see below
  0.4,  // radius
  0.85  // luminance threshold — only genuinely bright/emissive pixels (like the star) bloom, not the mid-gray hand
);
bloomComposer.addPass(bloomPass);
// 1x1 black fallback so uBloomTex contributes nothing for video/image
// sources (no 3D scene to bloom there — see tick()'s branch below).
const blackBloomTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
blackBloomTex.needsUpdate = true;

// ---------------------------------------------------------------------------
// Cursor trail — a decaying accumulation buffer, ping-ponged between two
// render targets every frame (ping-pong = one holds "last frame", the other
// gets written to as "this frame", then they swap roles). Sized to match the
// canvas's aspect ratio (capped for performance) so uv coordinates line up
// directly with the main pass — see shaders/trail.frag.glsl for the actual
// decay+stamp logic, and resize()/tick() below for how these get updated.
// ---------------------------------------------------------------------------
const trailScene = new THREE.Scene();
let trailRTA = new THREE.WebGLRenderTarget(512, 512, {
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  format: THREE.RGBAFormat,
});
let trailRTB = trailRTA.clone();
let trailMaterial = null; // created in boot() once trail.frag.glsl is fetched
let trailQuad = null;

const ambient = new THREE.AmbientLight(0xffffff, 0.5);
const key = new THREE.DirectionalLight(0xffffff, 1.0);
key.position.set(2, 3, 4);
sourceScene.add(ambient, key);

// procedural default mesh — a simple stand-in 3D asset so the tool works
// with zero uploads. Swap for the real hero model via the GLB upload control.
//
// Shape: a clean 4-sided pyramid (THREE.ConeGeometry with radialSegments=4 —
// the standard way to get a square-based pyramid instead of a round cone).
// flatShading keeps the facets crisp/angular rather than smoothed. Rotated
// 45° on Y so a flat face points toward the camera instead of an edge.
// Overall on-canvas size is controlled separately by params.scale (see "3D
// Transform" GUI + tick()), not by scaling up the geometry itself.
function buildProceduralSpark() {
  const geo = new THREE.ConeGeometry(0.72, 1.25, 4);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.1, flatShading: true });
  const pyramid = new THREE.Mesh(geo, mat);
  pyramid.rotation.y = Math.PI / 4;
  return pyramid;
}

let sourceObject = buildProceduralSpark();
sourceScene.add(sourceObject);

let videoEl = null;
let imageTexture = null;
let currentSourceType = "spark"; // 'spark' | 'glb' | 'video' | 'image'
// source's native (width/height) aspect ratio — feeds uSourceAspect so the
// shader can "cover"-fit instead of stretching an uploaded video/image to
// whatever the canvas's aspect ratio happens to be. 3D sources are always
// 1.0 because their render target is square (see resize()).
let currentSourceAspect = 1.0;
// the source's own "natural" fit scale — 1.0 for the procedural spark
// (already sized reasonably in buildProceduralSpark), or the auto-fit factor
// computed for an uploaded .glb so arbitrary model sizes land in frame. The
// "Scale" GUI slider (params.scale) multiplies on TOP of this in tick(),
// rather than replacing it, so uploads still fit sanely regardless of slider value.
let sourceBaseScale = 1.0;
// Raw (UNSCALED) local-space offset from the source's own origin to its
// bounding-box center — (0, 0) for the procedural spark (built symmetric
// around its own origin already), or computed per-upload for a .glb. Kept
// separate from sourceObject.position/scale rather than baked into position
// once at load time, because tick() sets position.x/y and scale every
// single frame from params.posX/posY/scale — a one-time position offset
// computed at load gets silently overwritten the very next frame. See the
// centering math in tick() below for how this actually gets applied.
let sourceCenterOffset = new THREE.Vector2(0, 0);

function clearSourceObject() {
  if (sourceObject) {
    sourceScene.remove(sourceObject);
    sourceObject.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose?.();
    });
    sourceObject = null;
  }
}

// Every setSourceX below takes an optional `onReady` callback, called once
// the switch has actually taken effect (immediately for spark/video, after
// the async load for image/glb) — this is what lets undo/redo (see "Undo /
// redo" section) apply the REST of a restored snapshot's values only once
// the source itself is ready, instead of racing an async texture/model load.
// Each one also calls pushHistory() itself at that same point, so a real user
// action (clicking "reset to spark", uploading a file) and a history restore
// both go through the exact same "source is ready" moment — pushHistory()
// simply no-ops during a restore (see isRestoringHistory).

function setSourceSpark(onReady) {
  clearSourceObject();
  sourceObject = buildProceduralSpark();
  sourceScene.add(sourceObject);
  currentSourceType = "spark";
  currentSourceAspect = 1.0;
  sourceBaseScale = 1.0;
  sourceCenterOffset.set(0, 0); // pyramid geometry is already centered on its own origin
  pushHistory();
  onReady?.();
}

function setSourceGLB(url, onReady) {
  const loader = new GLTFLoader();
  loader.load(
    url,
    (gltf) => {
      clearSourceObject();
      sourceObject = gltf.scene;
      // normalize scale/position so arbitrary uploads roughly fill the frame —
      // stored as sourceBaseScale rather than applied directly, so the
      // "Scale" GUI slider still multiplies on top of it in tick().
      const box = new THREE.Box3().setFromObject(sourceObject);
      const size = new THREE.Vector3();
      box.getSize(size);
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      sourceBaseScale = 2.2 / maxDim;
      // RAW local-space center — deliberately NOT multiplied by sourceBaseScale
      // and NOT applied to .position here (previous version did both, and got
      // silently overwritten by tick()'s per-frame position.x/y assignment
      // anyway — see sourceCenterOffset's declaration comment above). Most
      // uploaded character/prop models have their origin at the feet or at
      // world origin, not their geometric center, so without this the model
      // renders off-center (often cropped) the moment params.scale isn't
      // exactly 1.0 — which it isn't by default (0.7).
      const center = new THREE.Vector3();
      box.getCenter(center);
      sourceCenterOffset.set(center.x, center.y);
      sourceScene.add(sourceObject);
      currentSourceType = "glb";
      currentSourceAspect = 1.0;
      lastGlbUrl = url;
      pushHistory();
      onReady?.();
    },
    undefined,
    (err) => console.error("[main] GLB load failed:", err)
  );
}

function setSourceVideo(url, onReady) {
  if (videoEl) {
    videoEl.pause();
    videoEl.remove();
  }
  videoEl = document.createElement("video");
  videoEl.src = url;
  videoEl.loop = params.videoLoop;
  videoEl.muted = true;
  videoEl.playsInline = true;
  videoEl.addEventListener("loadedmetadata", () => {
    currentSourceAspect = videoEl.videoWidth / videoEl.videoHeight;
    // duration is only known once metadata loads — extend the seek slider's
    // range to match (it starts at a 0..1 placeholder before any video exists).
    videoTimeController?.max(videoEl.duration || 1);
  });
  // keep the Play/Pause button's label honest regardless of WHY playback
  // state changed — our own button, the video ending without loop, etc.
  videoEl.addEventListener("play", () => playPauseController?.name("❚❚ Pause video"));
  videoEl.addEventListener("pause", () => playPauseController?.name("▶ Play video"));
  videoEl.play();
  params.videoTime = 0;
  currentSourceType = "video";
  lastVideoUrl = url;
  pushHistory();
  onReady?.();
}

function toggleVideoPlayPause() {
  if (!videoEl) return;
  if (videoEl.paused) videoEl.play();
  else videoEl.pause();
}

function seekVideo(seconds) {
  if (!videoEl) return;
  videoEl.currentTime = seconds;
}

function setSourceImage(url, onReady) {
  new THREE.TextureLoader().load(url, (tex) => {
    imageTexture = tex;
    currentSourceAspect = tex.image.width / tex.image.height;
    currentSourceType = "image";
    lastImageUrl = url;
    pushHistory();
    onReady?.();
  });
}

// ---------------------------------------------------------------------------
// Presets — save/load full param snapshots so you can flip between different
// "experiments" (mode/color/mouse/3D combos) on the SAME canvas to compare,
// instead of re-dialing every slider from memory each time.
//
// Backed by a shared server-side store (api/presets.js + Upstash Redis) rather
// than localStorage — a preset anyone on the team saves shows up for
// everyone else too, since this is meant to be a shared team tool, not a
// private one. See README "Live / shared preset library" for setup +
// trade-offs (no auth, last-write-wins). Export/Import to a .json file still
// works on top of this, for archiving a specific set or moving it elsewhere.
// ---------------------------------------------------------------------------
const PRESETS_API_URL = "/api/presets";
const NO_PRESETS_LABEL = "— none saved —";

// everything worth saving as part of an "experiment" — deliberately excludes
// function fields (upload/export/snapshot/preset triggers) and
// params.videoTime (playback position, not a setting).
const PRESET_KEYS = [
  "mode", "cellSize", "invert", "colorMode", "fgColor", "bgColor", "accentColor",
  "accentThreshold", "ditherScale", "dotLevels", "brightness", "contrast", "blur", "glow",
  "previewFrame",
  "mouseRadius", "mouseStrength", "mouseSmoothing", "trailEnabled", "trailDecay",
  "trailStrength", "magnetEnabled", "magnetRadius", "magnetStrength",
  "autoRotate", "scale", "posX", "posY", "rotX", "rotY", "rotZ",
  "imageScale", "imageOffsetX", "imageOffsetY",
  "videoLoop", "includeGIF",
];

// set once the GUI is built (see boot()) — maps each PRESET_KEYS name to its
// real lil-gui controller, so loading a preset calls .setValue() on the
// controller (firing onChange, updating uniforms/materials) instead of just
// silently overwriting `params` with no visual effect.
let controllerMap = {};
let activePresetController = null; // the "Load experiment" dropdown — its choices get refreshed on save/delete/import

// last-known-good copy of the server's preset store — read synchronously by
// the "Load experiment" dropdown's onChange (see GUI setup below) so picking
// a preset doesn't need its own network round-trip; kept fresh by every
// loadPresetStore()/savePresetStore() call and the manual "Refresh presets"
// button.
let presetStoreCache = {};

async function loadPresetStore() {
  try {
    const res = await fetch(PRESETS_API_URL);
    if (!res.ok) throw new Error(`GET ${PRESETS_API_URL} -> ${res.status}`);
    presetStoreCache = await res.json();
  } catch (err) {
    console.error("[main] failed to load shared presets, falling back to last-known copy:", err);
    // presetStoreCache already holds whatever we last successfully fetched
    // (or {} on first load) — a transient network blip shouldn't wipe the
    // dropdown out from under you.
  }
  return presetStoreCache;
}
async function savePresetStore(store) {
  presetStoreCache = store; // update the local cache immediately (optimistic)
  try {
    const res = await fetch(PRESETS_API_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(store),
    });
    if (!res.ok) throw new Error(`PUT ${PRESETS_API_URL} -> ${res.status}`);
  } catch (err) {
    console.error("[main] failed to save shared presets:", err);
    window.alert("Couldn't reach the shared preset store — your change is only visible in this tab until it saves successfully. Check the console / README 'Live / shared preset library'.");
  }
}
function serializeCurrentParams() {
  const snap = {};
  for (const key of PRESET_KEYS) snap[key] = params[key];
  return snap;
}
function applyPresetValues(values) {
  for (const key of PRESET_KEYS) {
    if (!(key in values)) continue;
    const controller = controllerMap[key];
    if (controller) controller.setValue(values[key]);
    else params[key] = values[key];
  }
}
// OptionController.options() updates an existing dropdown's choices IN PLACE
// (checked against lil-gui's source — the base Controller.options() destroys
// and recreates the controller, but OptionController overrides it to just
// swap _values/_names and re-render, so this is safe to call repeatedly
// without the row jumping around or losing its GUI position).
async function refreshPresetOptions(selectName) {
  const store = await loadPresetStore();
  const names = Object.keys(store);
  activePresetController.options(names.length ? names : [NO_PRESETS_LABEL]);
  params.activePreset = selectName && names.includes(selectName) ? selectName : (names[0] ?? NO_PRESETS_LABEL);
  activePresetController.updateDisplay();
}
async function saveCurrentAsPreset() {
  const store = await loadPresetStore();
  const name = (params.presetName || "").trim() || `Experiment ${Object.keys(store).length + 1}`;
  if (store[name] && !window.confirm(`"${name}" already exists — overwrite it?`)) return;
  store[name] = serializeCurrentParams();
  await savePresetStore(store);
  params.presetName = "";
  await refreshPresetOptions(name);
}
async function deleteActivePreset() {
  const name = params.activePreset;
  if (!name || name === NO_PRESETS_LABEL) return;
  const store = await loadPresetStore();
  delete store[name];
  await savePresetStore(store);
  await refreshPresetOptions();
}
async function exportPresetsToFile() {
  const store = await loadPresetStore();
  const blob = new Blob([JSON.stringify(store, null, 2)], { type: "application/json" });
  downloadBlob(blob, "ascii-sandbox-presets.json");
}
function importPresetsFromFile(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const incoming = JSON.parse(reader.result);
      const store = { ...(await loadPresetStore()), ...incoming }; // same-name entries in the imported file win
      await savePresetStore(store);
      await refreshPresetOptions();
    } catch (err) {
      console.error("[main] failed to import presets:", err);
      window.alert("Couldn't read that file as a presets JSON export.");
    }
  };
  reader.readAsText(file);
}

// ---------------------------------------------------------------------------
// Undo / redo — every tweak (any slider/color/toggle/dropdown finishing a
// change, or switching source: procedural/video/image/.glb) pushes a
// snapshot onto a linear history stack. Ctrl/Cmd+Z steps back, Ctrl/Cmd+Shift+Z
// (or Ctrl/Cmd+Y) steps forward — same convention as most desktop apps.
// Deliberately separate from Presets above: presets are named snapshots you
// keep on purpose; this is an automatic, unnamed trail of every step you
// took to get here.
//
// How it hooks into lil-gui without touching every single .add(...).onChange(...)
// call: each root GUI instance's `.onFinishChange(cb)` bubbles up from EVERY
// descendant controller in THAT instance (confirmed against lil-gui 0.19's source —
// Controller._callOnFinishChange() walks up via `this.parent._callOnFinishChange()`)
// the moment a user interaction actually finishes (slider release, color
// picker close, checkbox/dropdown click, text field blur) — but critically,
// programmatic `.setValue()` calls (which is how applyPresetValues() restores
// a snapshot, or loads a preset) only fire the plain onChange, never
// onFinishChange. So: real user edits push history automatically via this one
// root hook; restoring a snapshot never re-triggers it. Source switches
// (spark/video/image/.glb) are FunctionController buttons, which don't fire
// onFinishChange at all even on click — those call pushHistory() themselves
// directly (see setSourceSpark/Video/Image/GLB above).
// ---------------------------------------------------------------------------
const HISTORY_LIMIT = 100; // cap so a long tweaking session doesn't grow this unbounded
let historyStack = [];
let historyIndex = -1; // points at the snapshot currently on screen
let isRestoringHistory = false; // guards undo/redo's own state changes from re-triggering a push
let undoController = null;
let redoController = null;
// object URLs from the last-uploaded file of each type — kept alive (never
// revoked) for the whole session specifically so undo/redo can switch BACK
// to an earlier upload without re-prompting a file picker. Trade-off: a long
// session with several large uploads holds all of them in memory at once —
// acceptable for a dev sandbox, see README "Known limitations".
let lastVideoUrl = null;
let lastImageUrl = null;
let lastGlbUrl = null;

function currentActiveSourceUrl() {
  return currentSourceType === "video" ? lastVideoUrl
    : currentSourceType === "image" ? lastImageUrl
    : currentSourceType === "glb" ? lastGlbUrl
    : null;
}
function captureSnapshot() {
  return {
    values: serializeCurrentParams(), // reuses the Presets helper — same set of tunable params
    sourceType: currentSourceType,
    sourceUrl: currentActiveSourceUrl(),
  };
}
function pushHistory() {
  if (isRestoringHistory) return;
  const snap = captureSnapshot();
  const top = historyStack[historyIndex];
  // skip no-op pushes (e.g. blurring the "New preset name" text field fires
  // onFinishChange too, but changes nothing about the canvas) — cheap since
  // snapshots are small, flat objects.
  if (top && JSON.stringify(top) === JSON.stringify(snap)) return;
  historyStack = historyStack.slice(0, historyIndex + 1); // drop any redo branch we're diverging from
  historyStack.push(snap);
  if (historyStack.length > HISTORY_LIMIT) historyStack.shift();
  historyIndex = historyStack.length - 1;
  updateUndoRedoLabels();
}
function updateUndoRedoLabels() {
  if (!undoController || !redoController) return;
  undoController.name(`↩ Undo (${historyIndex})`).disable(historyIndex <= 0);
  redoController.name(`↪ Redo (${historyStack.length - 1 - historyIndex})`).disable(historyIndex >= historyStack.length - 1);
}
function restoreSnapshot(snap) {
  isRestoringHistory = true;
  const finish = () => {
    applyPresetValues(snap.values);
    isRestoringHistory = false;
  };
  const needsSourceSwitch = snap.sourceType !== currentSourceType || snap.sourceUrl !== currentActiveSourceUrl();
  if (!needsSourceSwitch) {
    finish();
    return;
  }
  if (snap.sourceType === "spark") setSourceSpark(finish);
  else if (snap.sourceType === "video" && snap.sourceUrl) setSourceVideo(snap.sourceUrl, finish);
  else if (snap.sourceType === "image" && snap.sourceUrl) setSourceImage(snap.sourceUrl, finish);
  else if (snap.sourceType === "glb" && snap.sourceUrl) setSourceGLB(snap.sourceUrl, finish);
  else finish();
}
function undo() {
  if (historyIndex <= 0) return;
  historyIndex--;
  restoreSnapshot(historyStack[historyIndex]);
  updateUndoRedoLabels();
}
function redo() {
  if (historyIndex >= historyStack.length - 1) return;
  historyIndex++;
  restoreSnapshot(historyStack[historyIndex]);
  updateUndoRedoLabels();
}
// Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y = redo. Skipped while a
// real text field has focus (the "New preset name" field, or a lil-gui
// number/color controller's text entry) so native browser undo inside that
// field keeps working as expected instead of being hijacked.
window.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const key = e.key.toLowerCase();
  const isRedo = key === "y" || (key === "z" && e.shiftKey);
  const isUndo = key === "z" && !e.shiftKey;
  if (!isRedo && !isUndo) return;
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;
  e.preventDefault();
  if (isRedo) redo();
  else undo();
});

// ---------------------------------------------------------------------------
// Params (single source of truth for lil-gui + shader uniforms)
// ---------------------------------------------------------------------------
const params = {
  mode: "ASCII (MSDF)",
  cellSize: 14,
  invert: false,
  colorMode: "Grayscale", // "Grayscale" | "RGB"
  // dark shape on a light cream background, matching the actual ILABS hero
  // key visual (Concept A/Flat) — not the dark-bg/light-fg theme this sandbox
  // started with.
  fgColor: "#141413",
  bgColor: "#F8F8F6",
  accentColor: "#ff451a",
  accentThreshold: 0.82,
  ditherScale: 1.0,
  dotLevels: 8, // "Smooth Dot" mode (see MODES) — number of discrete dot-size steps
  brightness: 1.0,
  contrast: 1.0,
  blur: 0, // px, pre-blur on the source before density/coverage math
  glow: 0, // 0..1, emissive boost on hot cells — see shader comment (not true bloom)
  previewFrame: "Off", // see PREVIEW_FRAME_PRESETS — visual guide overlay only, no render/export change
  mouseRadius: 0.07,
  mouseStrength: 0.8,
  mouseSmoothing: 0.18, // 0..1, per-frame lerp factor at 60fps — lower = smoother/laggier, 1 = instant/snappy
  trailEnabled: true,
  trailDecay: 0.94, // per-frame multiplier on the previous trail — lower = faster fade
  trailStrength: 0.35, // how much "heat" each frame's stamp adds
  // "magnet" — dots/glyphs visually shift toward the cursor within a radius,
  // independent of mouseRadius/Strength above (that pair only recolors/tints;
  // this one is a positional pull) — see shader comment + README "Magnet
  // dots/glyphs" for the capped-within-the-cell trade-off.
  magnetEnabled: false,
  magnetRadius: 0.12,
  magnetStrength: 0.7,
  autoRotate: true,
  scale: 0.7, // multiplies sourceBaseScale — default <1 so the spark reads smaller/tighter in frame
  posX: 0,
  posY: 0,
  rotX: 0, // degrees
  rotY: 0, // degrees
  rotZ: 0, // degrees
  // "Image/Video Framing" — 2D-source equivalent of the 3D Transform block
  // above (image/video sources have no Object3D to move, so this is a UV
  // zoom/pan instead — see uImageScale/uImageOffset in main.frag.glsl).
  // 1.0/(0,0) is the identity transform: unchanged from before this existed.
  imageScale: 1.0,
  imageOffsetX: 0,
  imageOffsetY: 0,
  videoLoop: true,
  videoTime: 0, // seconds — kept in sync FROM videoEl.currentTime in tick() via lil-gui's .listen()
  togglePlayPause: () => toggleVideoPlayPause(),
  uploadMedia: () => mediaInput.click(),
  resetToSpark: () => setSourceSpark(),
  exportAtlasPNG: () => downloadURL("./assets/msdf/atlas.png", "atlas.png"),
  exportAtlasJSON: () => downloadURL("./assets/msdf/atlas.json", "atlas.json"),
  snapshotPNG: () => snapshotImage("image/png", "ascii-snapshot.png"),
  snapshotWebP: () => snapshotImage("image/webp", "ascii-snapshot.webp"),
  includeGIF: false, // GIF encoding is CPU-heavy — off by default, opt in per recording
  toggleRecording: () => toggleRecording(),
  undo: () => undo(),
  redo: () => redo(),
  presetName: "", // text field for naming the NEXT save — see "Presets" section above
  activePreset: NO_PRESETS_LABEL,
  savePreset: () => saveCurrentAsPreset(),
  deletePreset: () => deleteActivePreset(),
  exportPresets: () => exportPresetsToFile(),
  importPresets: () => presetInput.click(),
  refreshPresets: () => refreshPresetOptions(params.activePreset),
};

function downloadURL(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  downloadURL(url, filename);
  // give the download a tick to start before revoking
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---------------------------------------------------------------------------
// Export: still snapshots (PNG/WebP) + realtime capture (WebM/MP4 via
// MediaRecorder, optional GIF via gif.js)
// ---------------------------------------------------------------------------

function snapshotImage(mimeType, filename) {
  canvas.toBlob((blob) => {
    if (blob) downloadBlob(blob, filename);
  }, mimeType, 0.95);
}

// gif.js's worker is loaded via `new Worker(workerScriptUrl)` internally,
// which the browser refuses to do across origins (same restriction that
// broke @zappar/msdf-generator's Worker for MSDF baking — see
// tools/msdf-bake/README for that story). Fix: fetch the worker script
// ourselves and hand gif.js a same-origin blob: URL instead of the raw CDN
// URL. Cached after the first recording so repeat recordings don't re-fetch.
let gifWorkerBlobUrlPromise = null;
function getGifWorkerBlobUrl() {
  if (!gifWorkerBlobUrlPromise) {
    gifWorkerBlobUrlPromise = fetch("https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js")
      .then((r) => r.text())
      .then((text) => URL.createObjectURL(new Blob([text], { type: "application/javascript" })));
  }
  return gifWorkerBlobUrlPromise;
}

function pickVideoMimeType() {
  // Chromium (Chrome/Brave) only ships a software VP8/VP9+Opus WebM encoder
  // by default — MP4/H.264 via MediaRecorder only works if the OS exposes a
  // hardware encoder, which is inconsistent across machines. So: try MP4
  // opportunistically, but WebM is the format this is actually guaranteed to
  // produce. If you need a guaranteed .mp4 for a client deliverable, convert
  // the .webm afterward (e.g. with ffmpeg) rather than relying on this.
  const candidates = [
    "video/mp4;codecs=avc1",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  for (const t of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

// MediaRecorder's own default bitrate (roughly ~2.5 Mbps regardless of
// resolution) is tuned for typical camera footage, not this kind of
// high-frequency content — every glyph edge and dither dot is exactly the
// fine detail lossy video compression eats first, so recordings came out
// visibly soft/blocky compared to what's on screen. Scale bitrate to the
// ACTUAL capture resolution instead of a fixed number (canvas.width/height
// are the real backing-store pixel dimensions, already accounting for
// devicePixelRatio), at roughly 0.3 bits per pixel per frame — comfortably
// above typical streaming presets, appropriate for a short review/dev-handoff
// clip where file size isn't the constraint. Clamped so a huge retina canvas
// doesn't demand an unreasonable bitrate, and a small window still gets a
// reasonable floor.
function pickVideoBitsPerSecond(fps) {
  const bitsPerPixelPerFrame = 0.3;
  const raw = canvas.width * canvas.height * fps * bitsPerPixelPerFrame;
  return Math.round(Math.min(50_000_000, Math.max(8_000_000, raw)));
}

let isRecording = false;
let mediaRecorder = null;
let recordedChunks = [];
let recordingMimeType = "";
let gifInstance = null;
let gifCaptureTimer = null;
let recordButtonController = null; // set once the GUI is built, so we can rename it live
let playPauseController = null; // same pattern, for the video Play/Pause button
let videoTimeController = null; // the seek slider — its .max() gets updated once video duration is known

async function startRecording() {
  if (isRecording) return;
  isRecording = true;
  recordButtonController?.name("■ Stop & Save Recording");

  recordedChunks = [];
  recordingMimeType = pickVideoMimeType();
  const captureFps = 30;
  const stream = canvas.captureStream(captureFps);
  mediaRecorder = new MediaRecorder(stream, {
    ...(recordingMimeType ? { mimeType: recordingMimeType } : {}),
    videoBitsPerSecond: pickVideoBitsPerSecond(captureFps),
  });
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size) recordedChunks.push(e.data);
  };
  mediaRecorder.start();

  if (params.includeGIF && window.GIF) {
    const workerScript = await getGifWorkerBlobUrl();
    gifInstance = new window.GIF({
      workers: 2,
      quality: 10,
      workerScript,
      width: canvas.width,
      height: canvas.height,
    });
    const gifFps = 12; // kept modest — gif.js encoding cost scales with frame count
    gifCaptureTimer = setInterval(() => {
      gifInstance.addFrame(canvas, { copy: true, delay: 1000 / gifFps });
    }, 1000 / gifFps);
  }
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  recordButtonController?.name("● Start Recording");

  mediaRecorder.onstop = () => {
    const isMp4 = recordingMimeType.includes("mp4");
    const blob = new Blob(recordedChunks, { type: recordingMimeType || "video/webm" });
    downloadBlob(blob, `ascii-capture.${isMp4 ? "mp4" : "webm"}`);
  };
  mediaRecorder.stop();

  if (gifCaptureTimer) {
    clearInterval(gifCaptureTimer);
    gifCaptureTimer = null;
    gifInstance.on("finished", (blob) => downloadBlob(blob, "ascii-capture.gif"));
    gifInstance.render();
  }
}

function toggleRecording() {
  if (isRecording) stopRecording();
  else startRecording();
}

// One combined file picker instead of a separate button/input per source
// type (image/video/.glb) — matches the single "Upload Media" pattern from
// tools like DITHR rather than three disconnected buttons. routeUploadedFile()
// below sorts the picked file to the right setSourceX by extension/MIME.
const mediaInput = document.getElementById("media-input");
const presetInput = document.getElementById("preset-input");

// Extension-first for .glb/.gltf: browsers don't reliably set a MIME type
// for that format (file.type is often just "" depending on OS file
// associations), whereas image/video MIME prefixes ARE reliable, so those
// are checked by file.type instead.
function routeUploadedFile(file) {
  const name = file.name.toLowerCase();
  const url = URL.createObjectURL(file);
  if (name.endsWith(".glb") || name.endsWith(".gltf")) {
    setSourceGLB(url);
  } else if (file.type.startsWith("video/")) {
    setSourceVideo(url);
  } else if (file.type.startsWith("image/")) {
    setSourceImage(url);
  } else {
    URL.revokeObjectURL(url); // nothing is going to use it
    window.alert(
      `Không nhận ra loại file "${file.name}"${file.type ? ` (${file.type})` : ""}.\n` +
      `Hỗ trợ: ảnh, video, hoặc .glb/.gltf.`
    );
  }
}

// Clears the input's value after reading the file — without this, the
// browser won't fire 'change' again if you pick the EXACT SAME file a
// second time (its value string hasn't changed from the input's own point
// of view), which reads as "upload is broken" the moment you re-test with
// the same sample asset.
mediaInput.addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (f) routeUploadedFile(f);
  mediaInput.value = "";
});
presetInput.addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (f) importPresetsFromFile(f);
  presetInput.value = ""; // clear so importing the same filename again still fires 'change'
});

// ---------------------------------------------------------------------------
// Mouse tracking
// ---------------------------------------------------------------------------
const mouseUv = new THREE.Vector2(0.5, 0.5); // raw, instant pointer position
// smoothed/eased position — what the shader actually reads (uMouse). Lerped
// toward mouseUv every frame in tick(); see params.mouseSmoothing.
const smoothMouseUv = new THREE.Vector2(0.5, 0.5);
canvas.addEventListener("pointermove", (e) => {
  const rect = canvas.getBoundingClientRect();
  mouseUv.x = (e.clientX - rect.left) / rect.width;
  mouseUv.y = 1.0 - (e.clientY - rect.top) / rect.height; // flip to match vUv (bottom-left origin)
});

// ---------------------------------------------------------------------------
// Boot: load the MSDF atlas, build the blue-noise texture, wire the display
// material, wire the GUI, start the render loop.
// ---------------------------------------------------------------------------
async function boot() {
  const atlas = await loadMSDFAtlas("./assets/msdf/");

  const blueNoiseCanvas = generateBlueNoiseCanvas(64, 2);
  const blueNoiseTex = new THREE.CanvasTexture(blueNoiseCanvas);
  blueNoiseTex.wrapS = THREE.RepeatWrapping;
  blueNoiseTex.wrapT = THREE.RepeatWrapping;
  blueNoiseTex.minFilter = THREE.NearestFilter;
  blueNoiseTex.magFilter = THREE.NearestFilter;

  const [vertSrc, fragSrc, trailFragSrc] = await Promise.all([
    fetch("./shaders/quad.vert.glsl").then((r) => r.text()),
    fetch("./shaders/main.frag.glsl").then((r) => r.text()),
    fetch("./shaders/trail.frag.glsl").then((r) => r.text()),
  ]);

  const uniforms = {
    uSource: { value: renderTarget.texture },
    uBloomTex: { value: blackBloomTex }, // real bloom RGB, additively mixed into srcColor — see Bloom section up top; black (no-op) until the first 3D-source frame renders it for real

    uResolution: { value: new THREE.Vector2(canvas.clientWidth, canvas.clientHeight) },
    uMode: { value: MODES[params.mode] },
    uCellSize: { value: params.cellSize },
    uInvert: { value: params.invert ? 1 : 0 },
    uFgColor: { value: new THREE.Color(params.fgColor) },
    uBgColor: { value: new THREE.Color(params.bgColor) },
    uAccentColor: { value: new THREE.Color(params.accentColor) },
    uAccentThreshold: { value: params.accentThreshold },
    uTime: { value: 0 },
    uMouse: { value: smoothMouseUv }, // eased position, not the raw pointer — see tick()
    uMouseRadius: { value: params.mouseRadius },
    uMouseStrength: { value: params.mouseStrength },
    uTrailTex: { value: trailRTA.texture },
    uMagnetEnabled: { value: params.magnetEnabled ? 1 : 0 },
    uMagnetRadius: { value: params.magnetRadius },
    uMagnetStrength: { value: params.magnetStrength },
    uAtlasTex: { value: atlas.texture },
    uGlyphRects: { value: atlas.glyphRects.concat(
      Array.from({ length: 16 - atlas.glyphRects.length }, () => new THREE.Vector4(0, 0, 0, 0))
    ) },
    uGlyphCount: { value: atlas.glyphCount },
    uAtlasPxRange: { value: atlas.distanceRange },
    uBlueNoiseTex: { value: blueNoiseTex },
    uDitherScale: { value: params.ditherScale },
    uDotLevels: { value: params.dotLevels },
    uSourceAspect: { value: currentSourceAspect },
    uImageScale: { value: params.imageScale },
    uImageOffset: { value: new THREE.Vector2(params.imageOffsetX, params.imageOffsetY) },
    // 1.0 for the 3D-rendered sources (spark/glb) — real alpha coverage from
    // the transparently-cleared render target; 0.0 for video/image, where
    // the whole frame is content and there's no "empty background" to mask.
    // Updated every frame in tick() based on currentSourceType.
    uSourceIsMasked: { value: 1 },
    uColorMode: { value: params.colorMode === "RGB" ? 1 : 0 },
    uBrightness: { value: params.brightness },
    uContrast: { value: params.contrast },
    uBlurAmount: { value: params.blur },
    uGlowStrength: { value: params.glow },
  };

  const displayMaterial = new THREE.ShaderMaterial({
    vertexShader: vertSrc,
    fragmentShader: fragSrc,
    uniforms,
  });

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), displayMaterial);
  displayScene.add(quad);

  // trail decay+stamp pass — its own tiny scene/material, see shaders/trail.frag.glsl
  trailMaterial = new THREE.ShaderMaterial({
    vertexShader: vertSrc, // same full-screen quad vertex shader, no changes needed
    fragmentShader: trailFragSrc,
    uniforms: {
      uPrevTrail: { value: trailRTA.texture },
      uMouse: { value: smoothMouseUv },
      uMouseRadius: { value: params.mouseRadius },
      uCanvasAspect: { value: 1 },
      uDecay: { value: params.trailDecay },
      uStampStrength: { value: params.trailStrength },
    },
  });
  trailQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), trailMaterial);
  trailScene.add(trailQuad);

  // -------------------------------------------------------------------------
  // GUI — split into two docked panels instead of one long scrolling column.
  // -------------------------------------------------------------------------
  // LEFT ("Session"): everything about WHAT you're looking at and WHERE you
  // are in your own workflow — undo/redo, saved experiments, source, 3D
  // pose. Touched at the start of a pass, or occasionally to branch/compare.
  //
  // RIGHT ("Look & Output"): everything about HOW it renders and getting it
  // out — mode/color/filters/mouse reactivity, then export/handoff. This is
  // the panel you sit in for most of a tuning session, so it's kept separate
  // from the setup/session controls rather than interleaved with them.
  //
  // Both are real root GUI instances (not folders of one shared GUI) mounted
  // into their own fixed-position container divs (#gui-left / #gui-right in
  // index.html) via lil-gui's `container` option, which is what lets two
  // panels dock to opposite edges instead of lil-gui's single default
  // top-right placement.
  const guiSession = new GUI({ container: document.getElementById("gui-left"), title: "Session" });
  const guiLook = new GUI({ container: document.getElementById("gui-right"), title: "Look & Output" });

  // top-level on the Session panel, outside any folder — undo/redo is used
  // far more often than any single folder's controls, so it stays visible
  // without opening anything.
  undoController = guiSession.add(params, "undo").name("↩ Undo");
  redoController = guiSession.add(params, "redo").name("↪ Redo");
  // Registering onFinishChange() at the root of EACH panel (not per
  // controller) is what makes every control in that panel automatically
  // push history — see the "Undo / redo" section higher up in this file for
  // why that works. Both panels feed the same pushHistory(), so it doesn't
  // matter which panel a change came from.
  guiSession.onFinishChange(() => pushHistory());
  guiLook.onFinishChange(() => pushHistory());

  // top-level on the Look & Output panel, outside any folder — mirrors how
  // Efecto (and most premium editors) separate ACTIONS you take once you're
  // happy (Capture, Record) from SETTINGS you tune repeatedly, and puts them
  // in the top toolbar rather than buried in a folder. Same idea here: these
  // two buttons are the actual triggers; format/quality nuance (WebP,
  // GIF capture) stays in the "Export settings" folder further down — see
  // README "The lil-gui panel".
  guiLook.add(params, "snapshotPNG").name("📸 Capture (PNG)");
  recordButtonController = guiLook.add(params, "toggleRecording").name("● Start Recording");
  // Preview-only guide overlay (see PREVIEW_FRAME_PRESETS + updatePreviewFrame
  // below) — placed right next to Capture/Record since it exists purely to
  // help frame a shot before capturing, not as a persistent "look" setting.
  guiLook.add(params, "previewFrame", Object.keys(PREVIEW_FRAME_PRESETS)).name("Preview frame").onChange(updatePreviewFrame);

  // placed first on the Session panel — "load a saved experiment" is
  // naturally the first move when you're comparing settings rather than
  // starting from scratch.
  const presetsFolder = guiSession.addFolder("Presets (compare experiments)");
  presetsFolder.add(params, "presetName").name("New preset name");
  presetsFolder.add(params, "savePreset").name("💾 Save current as preset");
  activePresetController = presetsFolder
    .add(params, "activePreset", [NO_PRESETS_LABEL])
    .name("Load experiment")
    .onChange((name) => {
      if (name === NO_PRESETS_LABEL) return;
      // reads the in-memory cache rather than re-fetching — refreshPresetOptions()
      // (which populated this exact dropdown) already just fetched the latest
      // store, so presetStoreCache is current as of the moment you opened it.
      if (presetStoreCache[name]) applyPresetValues(presetStoreCache[name]);
    });
  presetsFolder.add(params, "deletePreset").name("🗑 Delete selected");
  presetsFolder.add(params, "exportPresets").name("⬇ Export all (.json)");
  presetsFolder.add(params, "importPresets").name("⬆ Import (.json)");
  // shared store, not localStorage — a teammate can save a preset while you
  // have the tab open, and this is how you pick it up without a full reload.
  presetsFolder.add(params, "refreshPresets").name("🔄 Refresh presets");

  const sourceFolder = guiSession.addFolder("Source");
  // one combined picker instead of three separate upload buttons — routes to
  // setSourceVideo/Image/GLB by extension/MIME, see routeUploadedFile().
  sourceFolder.add(params, "uploadMedia").name("Upload Media (Image / Video / .glb)");
  sourceFolder.add(params, "resetToSpark").name("Use procedural shape (pyramid)");
  // neutral label until a video actually loads and fires its own play/pause
  // events (see setSourceVideo) — nothing to toggle yet on the default source.
  playPauseController = sourceFolder.add(params, "togglePlayPause").name("▶/❚❚ Play/Pause video");
  sourceFolder.add(params, "videoLoop").name("Loop video").onChange((v) => {
    if (videoEl) videoEl.loop = v;
  });
  // .listen() makes lil-gui poll params.videoTime every frame and refresh the
  // slider's displayed position WITHOUT firing onChange — so tick() writing
  // videoEl.currentTime into params.videoTime just updates the display, while
  // onChange below only fires from an actual user drag, which is what seeks.
  videoTimeController = sourceFolder
    .add(params, "videoTime", 0, 1, 0.01)
    .name("Seek (s)")
    .listen()
    .onChange((v) => seekVideo(v));
  sourceFolder.add(params, "autoRotate").name("Auto-rotate 3D source");

  // manual transform controls for the 3D source (procedural spark / uploaded
  // .glb) — applied every frame in tick(), see below. Position Z isn't
  // exposed: the GLB loader already centers depth automatically, and X/Y is
  // what actually matters for framing against the fixed camera.
  const transformFolder = guiSession.addFolder("3D Transform");
  transformFolder.add(params, "scale", 0.1, 2, 0.01).name("Scale");
  transformFolder.add(params, "posX", -2, 2, 0.01).name("Position X");
  transformFolder.add(params, "posY", -2, 2, 0.01).name("Position Y");
  transformFolder.add(params, "rotX", -180, 180, 1).name("Rotation X°");
  transformFolder.add(params, "rotY", -180, 180, 1).name("Rotation Y°");
  transformFolder.add(params, "rotZ", -180, 180, 1).name("Rotation Z°");

  // 2D-source equivalent of the folder above — image/video sources have no
  // Object3D to move, so this is a UV zoom/pan (see uImageScale/uImageOffset
  // in main.frag.glsl) rather than a real transform. Added because coverUv()
  // always crops-to-fill with no way to zoom out and see background around
  // an uploaded image/video — 1.0/(0,0) matches that old always-fill
  // behavior exactly, sliders are purely additive on top.
  const framingFolder = guiSession.addFolder("Image/Video Framing");
  framingFolder.add(params, "imageScale", 0.2, 3, 0.01).name("Scale").onChange((v) => {
    uniforms.uImageScale.value = v;
  });
  framingFolder.add(params, "imageOffsetX", -1, 1, 0.01).name("Position X").onChange((v) => {
    uniforms.uImageOffset.value.x = v;
  });
  framingFolder.add(params, "imageOffsetY", -1, 1, 0.01).name("Position Y").onChange((v) => {
    uniforms.uImageOffset.value.y = v;
  });

  const modeFolder = guiLook.addFolder("Effect");
  // kept as the real, functioning controller — still wired into
  // controllerMap/presets/undo-redo exactly as before. buildModeTabBar()
  // below hides its native <select> row and drives it via .setValue() from
  // a tab bar instead, so every existing code path keeps working untouched.
  const modeController = modeFolder.add(params, "mode", Object.keys(MODES)).name("Mode").onChange((v) => {
    uniforms.uMode.value = MODES[v];
    syncModeUI();
  });
  modeFolder.add(params, "cellSize", 4, 48, 1).name("Cell size (px)").onChange((v) => {
    uniforms.uCellSize.value = v;
  });
  modeFolder.add(params, "invert").name("Invert").onChange((v) => {
    uniforms.uInvert.value = v ? 1 : 0;
  });
  // both of the next two rows are mode-specific — only meaningful for one
  // mode/family each — so buildModeTabBar()'s syncModeUI() show/hides their
  // rows based on the active mode instead of leaving them always visible.
  const ditherScaleController = modeFolder.add(params, "ditherScale", 0.25, 4, 0.05).name("Blue noise scale").onChange((v) => {
    uniforms.uDitherScale.value = v;
  });
  const dotLevelsController = modeFolder.add(params, "dotLevels", 2, 16, 1).name("Dot levels (Smooth Dot)").onChange((v) => {
    uniforms.uDotLevels.value = v;
  });

  // -------------------------------------------------------------------------
  // Mode tab bar — a custom view layered on top of the real "Mode" controller
  // above, replacing one flat 8-item dropdown with 3 tabs (ASCII / Dither /
  // Smooth Dot) plus a secondary dropdown that only appears for Dither, to
  // pick which of its 6 algorithms is active. The controller stays the
  // single source of truth: every tab/select interaction below just calls
  // modeController.setValue(...), so presets, undo/redo, and the uMode
  // uniform wiring all keep working exactly as before, no matter which UI
  // path changed params.mode. syncModeUI() (called from modeController's own
  // onChange above) is what keeps the tab bar highlighting, the dither
  // sub-select's visibility/value, and the two mode-specific rows above in
  // sync — covering ALL paths that can change params.mode (tab bar clicks,
  // preset load, undo/redo), not just direct tab-bar interaction.
  // -------------------------------------------------------------------------
  let syncModeUI = () => {}; // replaced once buildModeTabBar() runs; see modeController.onChange above
  function buildModeTabBar() {
    const modeRow = modeController.domElement.closest(".controller");
    modeRow.classList.add("mode-row-hidden"); // controller stays alive/functional, just visually replaced

    const tabBar = document.createElement("div");
    tabBar.className = "mode-tabbar";
    const families = ["ASCII", "Dither", "Smooth Dot"];
    const tabButtons = {};
    families.forEach((family) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mode-tab";
      btn.textContent = family;
      btn.addEventListener("click", () => {
        const nextMode = MODE_FAMILIES[params.mode] === family ? params.mode : FAMILY_DEFAULT_MODE[family];
        modeController.setValue(nextMode); // -> uMode uniform + syncModeUI(), via the onChange above
        pushHistory(); // explicit call — don't rely on setValue() bubbling to guiLook.onFinishChange
      });
      tabButtons[family] = btn;
      tabBar.appendChild(btn);
    });

    const ditherSelect = document.createElement("select");
    ditherSelect.className = "mode-dither-select";
    DITHER_ALGORITHMS.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      ditherSelect.appendChild(opt);
    });
    ditherSelect.addEventListener("change", () => {
      modeController.setValue(ditherSelect.value);
      pushHistory();
    });

    modeRow.insertAdjacentElement("afterend", ditherSelect);
    modeRow.insertAdjacentElement("afterend", tabBar);

    syncModeUI = () => {
      const family = MODE_FAMILIES[params.mode];
      families.forEach((f) => tabButtons[f].classList.toggle("active", f === family));
      ditherSelect.style.display = family === "Dither" ? "block" : "none";
      if (family === "Dither") ditherSelect.value = params.mode;
      const ditherScaleRow = ditherScaleController.domElement.closest(".controller");
      const dotLevelsRow = dotLevelsController.domElement.closest(".controller");
      ditherScaleRow.classList.toggle("mode-row-hidden", params.mode !== "Blue Noise");
      dotLevelsRow.classList.toggle("mode-row-hidden", params.mode !== "Smooth Dot");
    };
    syncModeUI();
  }
  buildModeTabBar();

  const colorFolder = guiLook.addFolder("Color");
  colorFolder.add(params, "colorMode", ["Grayscale", "RGB"]).name("Color mode").onChange((v) => {
    uniforms.uColorMode.value = v === "RGB" ? 1 : 0;
  });
  colorFolder.addColor(params, "bgColor").name("Background").onChange((v) => uniforms.uBgColor.value.set(v));
  colorFolder.addColor(params, "fgColor").name("Foreground (Grayscale mode)").onChange((v) => uniforms.uFgColor.value.set(v));
  colorFolder.addColor(params, "accentColor").name("Accent").onChange((v) => {
    uniforms.uAccentColor.value.set(v);
  });
  colorFolder.add(params, "accentThreshold", 0, 1, 0.01).name("Accent threshold").onChange((v) => {
    uniforms.uAccentThreshold.value = v;
  });

  const filterFolder = guiLook.addFolder("Filters");
  filterFolder.add(params, "brightness", 0, 2, 0.01).name("Brightness").onChange((v) => {
    uniforms.uBrightness.value = v;
  });
  filterFolder.add(params, "contrast", 0, 2, 0.01).name("Contrast").onChange((v) => {
    uniforms.uContrast.value = v;
  });
  filterFolder.add(params, "blur", 0, 10, 0.1).name("Blur (px)").onChange((v) => {
    uniforms.uBlurAmount.value = v;
  });
  filterFolder.add(params, "glow", 0, 1, 0.01).name("Glow").onChange((v) => {
    uniforms.uGlowStrength.value = v;
  });

  const mouseFolder = guiLook.addFolder("Mouse interaction");
  mouseFolder.add(params, "mouseRadius", 0.02, 0.6, 0.01).name("Radius").onChange((v) => {
    uniforms.uMouseRadius.value = v;
    trailMaterial.uniforms.uMouseRadius.value = v; // trail stamp uses the same radius, for a consistent circle size
  });
  mouseFolder.add(params, "mouseStrength", 0, 1, 0.01).name("Strength").onChange((v) => {
    uniforms.uMouseStrength.value = v;
  });
  mouseFolder.add(params, "mouseSmoothing", 0.02, 1, 0.01).name("Cursor smoothing").onChange((v) => {
    // no uniform to update — read directly from params in tick()'s lerp
  });
  mouseFolder.add(params, "trailEnabled").name("Enable trail");
  mouseFolder.add(params, "trailDecay", 0.5, 0.99, 0.001).name("Trail decay").onChange((v) => {
    trailMaterial.uniforms.uDecay.value = v;
  });
  mouseFolder.add(params, "trailStrength", 0, 1, 0.01).name("Trail strength").onChange((v) => {
    trailMaterial.uniforms.uStampStrength.value = v;
  });
  // "Magnet" — dots/glyphs visually shift toward the cursor within a radius,
  // independent of Radius/Strength above (those only recolor/tint; this is a
  // positional pull). Capped within each cell — see shader comment + README
  // "Magnet dots/glyphs" for that trade-off.
  mouseFolder.add(params, "magnetEnabled").name("Magnetize dots/glyphs").onChange((v) => {
    uniforms.uMagnetEnabled.value = v ? 1 : 0;
  });
  mouseFolder.add(params, "magnetRadius", 0.02, 0.6, 0.01).name("Magnet radius").onChange((v) => {
    uniforms.uMagnetRadius.value = v;
  });
  mouseFolder.add(params, "magnetStrength", 0, 1, 0.01).name("Magnet strength").onChange((v) => {
    uniforms.uMagnetStrength.value = v;
  });

  // secondary export settings only — the actual Capture/Record trigger
  // buttons are promoted to the root of this panel (see top of this
  // function), not duplicated here.
  const exportFolder = guiLook.addFolder("Export settings");
  exportFolder.add(params, "snapshotWebP").name("Save snapshot (WebP)");
  exportFolder.add(params, "includeGIF").name("Also capture GIF (slower)");

  const handoffFolder = guiLook.addFolder("Dev handoff");
  handoffFolder.add(params, "exportAtlasPNG").name("Download atlas.png");
  handoffFolder.add(params, "exportAtlasJSON").name("Download atlas.json");

  // controllerMap must be built AFTER every folder in BOTH panels exists,
  // since it walks each panel's whole tree — this is what makes loading a
  // preset actually push values through each control's real onChange
  // (updating uniforms and materials), instead of just overwriting `params`
  // with no visual effect.
  [...guiSession.controllersRecursive(), ...guiLook.controllersRecursive()].forEach((c) => {
    controllerMap[c.property] = c;
  });
  await refreshPresetOptions(params.activePreset); // pick up anything the team has already saved

  // seed undo history with the boot-time default state, so the very first
  // undo after one tweak correctly returns to "how it looked before you
  // touched anything" instead of an undefined empty state.
  historyStack = [captureSnapshot()];
  historyIndex = 0;
  updateUndoRedoLabels();

  // -------------------------------------------------------------------------
  // Preview frame — see PREVIEW_FRAME_PRESETS above for what this is/isn't
  // (a framing guide, not a render/export change). Pure DOM overlay sizing;
  // never touches uResolution/renderer/renderTarget, so it can't affect the
  // actual shader output or Capture/Record in any way.
  // -------------------------------------------------------------------------
  const previewFrameEl = document.getElementById("preview-frame");
  const previewFrameLabelEl = document.getElementById("preview-frame-label");
  function updatePreviewFrame() {
    const target = PREVIEW_FRAME_PRESETS[params.previewFrame];
    if (!target) {
      previewFrameEl.style.display = "none";
      return;
    }
    const [targetW, targetH] = target;
    const targetAspect = targetW / targetH;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    // "contain" fit — as large as possible within the viewport without
    // exceeding it on either axis, preserving the preset's aspect ratio.
    // Same idea as CSS object-fit: contain / the shader's own coverUv(),
    // just sizing a DOM rect instead of remapping a UV.
    let frameW = viewportW;
    let frameH = frameW / targetAspect;
    if (frameH > viewportH) {
      frameH = viewportH;
      frameW = frameH * targetAspect;
    }
    // small margin so the dashed border reads as a floating frame rather
    // than a stroke sitting flush on the browser edge.
    const margin = 24;
    frameW = Math.max(40, frameW - margin * 2);
    frameH = Math.max(40, frameH - margin * 2);
    previewFrameEl.style.width = `${frameW}px`;
    previewFrameEl.style.height = `${frameH}px`;
    previewFrameEl.style.left = `${(viewportW - frameW) / 2}px`;
    previewFrameEl.style.top = `${(viewportH - frameH) / 2}px`;
    previewFrameEl.style.display = "block";
    previewFrameLabelEl.textContent = `${targetW}×${targetH}`;
  }

  // -------------------------------------------------------------------------
  // Resize handling
  // -------------------------------------------------------------------------
  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    uniforms.uResolution.value.set(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
    sourceCamera.aspect = 1; // render target is always square; source scene composition doesn't depend on canvas AR
    sourceCamera.updateProjectionMatrix();
    const rtSize = Math.min(2048, Math.max(256, Math.floor(Math.max(w, h) * renderer.getPixelRatio())));
    if (renderTarget.width !== rtSize) {
      renderTarget.setSize(rtSize, rtSize);
      bloomComposer.setSize(rtSize, rtSize);
    }

    // trail buffers: match the CANVAS's aspect ratio (not square, unlike the
    // 3D render target above) so its uv coordinates line up directly with
    // the main pass's vUv — capped modestly since it's just a soft blob +
    // decay, not something that needs high resolution.
    const canvasAspect = w / h;
    const trailLongSide = 640;
    const trailW = Math.round(canvasAspect >= 1 ? trailLongSide : trailLongSide * canvasAspect);
    const trailH = Math.round(canvasAspect >= 1 ? trailLongSide / canvasAspect : trailLongSide);
    if (trailRTA.width !== trailW || trailRTA.height !== trailH) {
      trailRTA.setSize(trailW, trailH);
      trailRTB.setSize(trailW, trailH);
    }
    if (trailMaterial) trailMaterial.uniforms.uCanvasAspect.value = canvasAspect;

    updatePreviewFrame();
  }
  window.addEventListener("resize", resize);
  resize();

  // -------------------------------------------------------------------------
  // Render loop
  // -------------------------------------------------------------------------
  const clock = new THREE.Clock();
  let elapsed = 0;
  function tick() {
    const dt = clock.getDelta(); // only called once per frame — accumulate our own elapsed time from it,
    elapsed += dt;               // rather than also calling clock.getElapsedTime() (which double-consumes the clock)
    const t = elapsed;
    uniforms.uTime.value = t;
    uniforms.uSourceAspect.value = currentSourceAspect;

    // ease the reactive point toward the raw pointer instead of snapping to
    // it — frame-rate independent so it feels the same at 30fps or 144fps.
    // mouseSmoothing is "how much to close the gap per ~1/60s tick"; higher
    // = snappier, lower = laggier/smoother trailing feel.
    const lerpT = 1 - Math.pow(1 - params.mouseSmoothing, dt * 60);
    smoothMouseUv.x += (mouseUv.x - smoothMouseUv.x) * lerpT;
    smoothMouseUv.y += (mouseUv.y - smoothMouseUv.y) * lerpT;

    // cursor trail: decay the previous frame + stamp the (smoothed) cursor
    // position, ping-ponging between trailRTA/trailRTB. Stamp strength is
    // zeroed when disabled rather than skipping the pass entirely, so
    // toggling it off lets any existing trail fade out naturally instead of
    // hard-cutting.
    trailMaterial.uniforms.uPrevTrail.value = trailRTA.texture;
    trailMaterial.uniforms.uStampStrength.value = params.trailEnabled ? params.trailStrength : 0;
    renderer.setRenderTarget(trailRTB);
    renderer.render(trailScene, displayCamera);
    renderer.setRenderTarget(null);
    [trailRTA, trailRTB] = [trailRTB, trailRTA]; // swap: trailRTA now holds this frame's result
    uniforms.uTrailTex.value = trailRTA.texture;

    // real alpha-coverage masking only makes sense for the 3D-rendered
    // sources (transparent-cleared render target) — see uSourceIsMasked
    // comment in main.frag.glsl and the renderer.setClearColor() call above.
    uniforms.uSourceIsMasked.value = (currentSourceType === "spark" || currentSourceType === "glb") ? 1 : 0;

    if (currentSourceType === "spark" || currentSourceType === "glb") {
      if (sourceObject) {
        const rotXBase = THREE.MathUtils.degToRad(params.rotX);
        const rotYBase = THREE.MathUtils.degToRad(params.rotY);
        const rotZBase = THREE.MathUtils.degToRad(params.rotZ);
        // manual sliders set the base pose; auto-rotate (when on) ADDS motion
        // on top instead of overriding the sliders, so you can dial in an
        // angle and still see it move.
        sourceObject.rotation.set(
          rotXBase + (params.autoRotate ? Math.sin(t * 0.3) * 0.2 : 0),
          rotYBase + (params.autoRotate ? t * 0.4 : 0),
          rotZBase
        );

        // Centering math recomputed every frame (not baked in once at load
        // time) so it stays correct as params.scale changes — sourceObject's
        // world position for its own bounding-box center works out to
        // position + scale*sourceCenterOffset, so we solve for the position
        // that puts that center at (params.posX, params.posY) instead of at
        // wherever the model's own origin happens to be. See
        // sourceCenterOffset's declaration comment for why this can't just
        // be set once in setSourceGLB() the way an earlier version tried.
        const effectiveScale = sourceBaseScale * params.scale;
        sourceObject.position.x = params.posX - sourceCenterOffset.x * effectiveScale;
        sourceObject.position.y = params.posY - sourceCenterOffset.y * effectiveScale;
        sourceObject.scale.setScalar(effectiveScale);
      }
      renderer.setRenderTarget(renderTarget);
      renderer.render(sourceScene, sourceCamera);
      renderer.setRenderTarget(null);
      uniforms.uSource.value = renderTarget.texture;

      // Second render of the SAME scene through the bloom composer (see
      // "Bloom" section near the top of this file for why this is a
      // separate pass instead of bolting bloom onto renderTarget directly —
      // short version: preserves renderTarget's alpha content-mask). Skipped
      // entirely at glow=0 to save the extra render+blur passes when it's
      // not in use.
      if (params.glow > 0) {
        bloomPass.strength = params.glow * 2.5;
        bloomComposer.render();
        uniforms.uBloomTex.value = bloomComposer.readBuffer.texture;
      } else {
        uniforms.uBloomTex.value = blackBloomTex;
      }
    } else if (currentSourceType === "video" && videoEl) {
      uniforms.uBloomTex.value = blackBloomTex; // no 3D scene to bloom for video/image sources
      if (!uniforms.uSource.value.isVideoTexture) {
        uniforms.uSource.value = new THREE.VideoTexture(videoEl);
      }
      // drives the seek slider's display via .listen() — see the GUI setup
      // above for why this doesn't fight the user dragging the slider.
      params.videoTime = videoEl.currentTime;
    } else if (currentSourceType === "image" && imageTexture) {
      uniforms.uBloomTex.value = blackBloomTex; // no 3D scene to bloom for video/image sources
      uniforms.uSource.value = imageTexture;
    }

    renderer.render(displayScene, displayCamera);
    requestAnimationFrame(tick);
  }
  tick();
}

boot().catch((err) => {
  console.error("[main] boot failed:", err);
  const el = document.getElementById("boot-error");
  if (el) {
    el.style.display = "block";
    el.textContent = "Failed to start: " + err.message;
  }
});
