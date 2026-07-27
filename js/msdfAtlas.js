// Loads the pre-baked MSDF atlas (assets/msdf/atlas.png + atlas.json) and
// converts its BMFont-style glyph list into the flat (u0,v0,u1,v1) rect array
// the shader expects, IN CHARSET ORDER (so index == density rank).
//
// Why pre-baked instead of baking in-browser at load time: the browser-only
// WASM/Worker baking path (via @zappar/msdf-generator) needs a same-origin
// Worker, which breaks under file:// and most CDN setups. Baking once with
// Node (see tools/msdf-bake/) and shipping atlas.png+atlas.json is simpler
// and more reliable for a handoff artifact. Re-bake with a different font or
// charset any time — see tools/msdf-bake/README.md.

import * as THREE from "three"; // resolved via the import map in index.html

const CHARSET = "@%#*+=-:. "; // locked charset, dense -> sparse (matches Framer AsciiVideo recipe)

export async function loadMSDFAtlas(basePath = "./assets/msdf/") {
  const [json, texture] = await Promise.all([
    fetch(`${basePath}atlas.json`).then((r) => {
      if (!r.ok) throw new Error(`atlas.json fetch failed: ${r.status}`);
      return r.json();
    }),
    new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(
        `${basePath}atlas.png`,
        (tex) => resolve(tex),
        undefined,
        (err) => reject(err)
      );
    }),
  ]);

  texture.flipY = true; // THREE flips by default; atlas.json coords assume top-left origin, matched below
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  const scaleW = json.common.scaleW;
  const scaleH = json.common.scaleH;

  // index chars by the literal character so we can re-order to CHARSET order
  // regardless of the order msdf-bmfont wrote them in.
  const byChar = new Map(json.chars.map((c) => [String.fromCodePoint(c.id), c]));

  const glyphRects = []; // flat array of THREE.Vector4, one per CHARSET position
  for (const ch of CHARSET) {
    const c = byChar.get(ch);
    if (!c) {
      console.warn(`[msdfAtlas] charset has "${ch}" but atlas.json doesn't — falling back to blank`);
      glyphRects.push(new THREE.Vector4(0, 0, 0, 0));
      continue;
    }
    const u0 = c.x / scaleW;
    const v0 = 1.0 - c.y / scaleH; // flip V: atlas.json is top-left origin, texture sampling here is bottom-left (v grows up)
    const u1 = (c.x + c.width) / scaleW;
    const v1 = 1.0 - (c.y + c.height) / scaleH;
    // rect stored as (u0, v_bottom, u1, v_top) so mix(rect.xy, rect.zw, cellUv) in the
    // shader walks top-to-bottom of the glyph as cellUv.y goes 0 -> 1
    glyphRects.push(new THREE.Vector4(u0, v1, u1, v0));
  }

  return {
    texture,
    glyphRects,
    glyphCount: CHARSET.length,
    charset: CHARSET,
    distanceRange: json.distanceField.distanceRange,
    raw: json,
  };
}

export { CHARSET };
