// Standalone Node MSDF atlas baker.
// Uses @zappar/msdf-generator's WASM module directly (bypassing its
// browser-only Worker/comlink wrapper, which this sandbox can't run headless).
// The core generator class below is copied verbatim from the package's
// dist/worker.js (MIT), with ONE patch: the browser-only `new ImageData(...)`
// call is replaced with a plain {data,width,height} object since Node has no
// ImageData global.

import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import createMSDFGenModule from "./msdfgen_wasm.mjs";

// ---- MSDFGenerator (copied from @zappar/msdf-generator dist/worker.js) ----
class MSDFGenerator {
  module;
  font = null;
  constructor(wasmModule) {
    this.module = wasmModule;
  }
  async loadFont(fontData) {
    this.font = new this.module.Font();
    const vec = new this.module.VectorUnsignedChar();
    for (let i = 0; i < fontData.length; i++) {
      vec.push_back(fontData[i]);
    }
    const success = this.font.loadFromMemory(vec);
    vec.delete();
    if (!success) throw new Error("Failed to load font from memory");
  }
  generateAtlas(options) {
    if (!this.font) throw new Error("No font loaded");
    const {
      charset,
      fontSize = 48,
      textureSize = [512, 512],
      fieldRange = 4,
      padding = 4,
      fixOverlaps = true,
    } = options;
    const metrics = this.font.getMetrics();
    const info = this.getFontProperties();
    const scale = fontSize / metrics.emSize;
    const baseline = metrics.ascender * scale;
    const pad = Math.floor(fieldRange / 2);
    const chars = Array.from(new Set(charset));
    const glyphs = [];
    let atlasX = 0;
    let atlasY = 0;
    let rowHeight = 0;
    const texture = new Uint8ClampedArray(textureSize[0] * textureSize[1] * 4);
    for (let i = 0; i < chars.length; i++) {
      const char = chars[i];
      const unicode = char.codePointAt(0);
      const shape = this.font.getGlyphShape(unicode);
      const pixelLeft = Math.floor(shape.left * scale);
      const pixelBottom = Math.floor(shape.bottom * scale);
      const pixelRight = Math.ceil(shape.right * scale);
      const pixelTop = Math.ceil(shape.top * scale);
      const glyphWidth = pixelRight - pixelLeft + pad * 2;
      const glyphHeight = pixelTop - pixelBottom + pad * 2;
      if (atlasX + glyphWidth > textureSize[0]) {
        atlasX = 0;
        atlasY += rowHeight + padding;
        rowHeight = 0;
      }
      const shapeWidth = shape.right - shape.left;
      const shapeHeight = shape.top - shape.bottom;
      const msdfScale = scale;
      const translateX = 0.5 * (glyphWidth / msdfScale - shapeWidth) - shape.left;
      const rawTranslateY = 0.5 * (glyphHeight / msdfScale - shapeHeight) - shape.bottom;
      const translateY = Math.round(rawTranslateY * msdfScale) / msdfScale;
      const result = fixOverlaps
        ? this.font.generateMSDFWithOverlapFix(
            unicode, glyphWidth, glyphHeight, fieldRange, translateX, translateY, msdfScale
          )
        : this.font.generateMSDF(
            unicode, glyphWidth, glyphHeight, fieldRange, translateX, translateY, msdfScale
          );
      for (let py = 0; py < glyphHeight; py++) {
        for (let px = 0; px < glyphWidth; px++) {
          const srcIdx = (py * glyphWidth + px) * 3;
          const dstIdx = ((atlasY + py) * textureSize[0] + (atlasX + px)) * 4;
          texture[dstIdx + 0] = result.data.get(srcIdx + 0) ?? 0;
          texture[dstIdx + 1] = result.data.get(srcIdx + 1) ?? 0;
          texture[dstIdx + 2] = result.data.get(srcIdx + 2) ?? 0;
          texture[dstIdx + 3] = 255;
        }
      }
      result.data.delete();
      glyphs.push({
        unicode, char,
        atlasPosition: [atlasX, atlasY],
        atlasSize: [glyphWidth, glyphHeight],
        bounds: { left: pixelLeft, bottom: pixelBottom, right: pixelRight, top: pixelTop },
        advance: shape.advance * scale,
        xoffset: pixelLeft - pad,
        yoffset: baseline - pixelTop - pad,
      });
      atlasX += glyphWidth + padding;
      rowHeight = Math.max(rowHeight, glyphHeight);
    }
    const kerning = [];
    for (let i = 0; i < chars.length; i++) {
      for (let j = 0; j < chars.length; j++) {
        const first = chars[i].codePointAt(0);
        const second = chars[j].codePointAt(0);
        const amount = this.font.getKerning(first, second) * scale;
        if (amount !== 0) kerning.push({ first: chars[i], second: chars[j], amount });
      }
    }
    return {
      // PATCHED: plain object instead of `new ImageData(...)` (no DOM in Node)
      texture: { data: texture, width: textureSize[0], height: textureSize[1] },
      glyphs,
      metrics: {
        emSize: metrics.emSize,
        ascender: metrics.ascender * scale,
        descender: metrics.descender * scale,
        lineHeight: metrics.lineHeight * scale,
      },
      info, kerning, textureSize, fieldRange,
    };
  }
  getFontProperties() {
    if (!this.font) throw new Error("No font loaded");
    const props = this.font.getFontProperties();
    return { ...props, name: String(props.name) };
  }
  exportJSON(options, pageFilename) {
    const { atlas, fontSize = 48 } = options;
    const pad = Math.floor(atlas.fieldRange / 2);
    return {
      pages: [pageFilename || "atlas.png"],
      chars: atlas.glyphs.map((g, index) => ({
        id: g.unicode, index, char: g.char,
        width: g.atlasSize[0], height: g.atlasSize[1],
        xoffset: g.xoffset, yoffset: g.yoffset, xadvance: g.advance,
        chnl: 15, x: g.atlasPosition[0], y: g.atlasPosition[1], page: 0,
      })),
      info: {
        face: atlas.info.name, size: fontSize,
        bold: atlas.info.bold ? 1 : 0, italic: atlas.info.italic ? 1 : 0,
        charset: atlas.glyphs.map((g) => g.char),
        unicode: 1, stretchH: 100, smooth: 1, aa: 1,
        padding: [pad, pad, pad, pad], spacing: [0, 0], outline: 0,
      },
      common: {
        lineHeight: atlas.metrics.lineHeight, base: atlas.metrics.ascender,
        scaleW: atlas.textureSize[0], scaleH: atlas.textureSize[1],
        pages: 1, packed: 0, alphaChnl: 0, redChnl: 0, greenChnl: 0, blueChnl: 0,
      },
      distanceField: { fieldType: "msdf", distanceRange: atlas.fieldRange },
      kernings: atlas.kerning.map((k) => ({
        first: k.first.codePointAt(0), second: k.second.codePointAt(0), amount: k.amount,
      })),
    };
  }
  dispose() {
    if (this.font) { this.font.delete(); this.font = null; }
  }
}

// ---------------------------- driver ----------------------------

async function main() {
  const [, , fontPath, charsetPath, outDir, fontSizeArg, texSizeArg, fieldRangeArg] = process.argv;
  if (!fontPath || !charsetPath || !outDir) {
    console.error("usage: node bake.mjs <font.ttf|otf> <charset.txt> <outDir> [fontSize] [texW,texH] [fieldRange]");
    process.exit(1);
  }
  const fontSize = fontSizeArg ? parseInt(fontSizeArg, 10) : 64;
  const [texW, texH] = (texSizeArg || "256,256").split(",").map((n) => parseInt(n, 10));
  const fieldRange = fieldRangeArg ? parseInt(fieldRangeArg, 10) : 4;

  const fontBuffer = new Uint8Array(fs.readFileSync(fontPath));
  const wasmBinary = fs.readFileSync(new URL("./msdfgen_wasm.wasm", import.meta.url));
  const charset = fs.readFileSync(charsetPath, "utf8").replace(/\r?\n/g, "");

  console.log(`[bake] font=${fontPath} charset=${JSON.stringify(charset)} size=${fontSize} tex=${texW}x${texH} range=${fieldRange}`);

  const wasmModule = await createMSDFGenModule({ wasmBinary: new Uint8Array(wasmBinary) });
  const gen = new MSDFGenerator(wasmModule);
  await gen.loadFont(fontBuffer);

  const atlasOptions = {
    charset,
    fontSize,
    textureSize: [texW, texH],
    fieldRange,
    padding: 4,
    fixOverlaps: true,
  };
  const atlas = gen.generateAtlas(atlasOptions);
  const json = gen.exportJSON({ atlas, fontSize }, "atlas.png");

  fs.mkdirSync(outDir, { recursive: true });

  const png = new PNG({ width: atlas.textureSize[0], height: atlas.textureSize[1] });
  png.data = Buffer.from(atlas.texture.data.buffer, atlas.texture.data.byteOffset, atlas.texture.data.byteLength);
  const pngPath = path.join(outDir, "atlas.png");
  fs.writeFileSync(pngPath, PNG.sync.write(png));

  const jsonPath = path.join(outDir, "atlas.json");
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2));

  console.log(`[bake] wrote ${pngPath}`);
  console.log(`[bake] wrote ${jsonPath}`);
  console.log(`[bake] glyphs: ${atlas.glyphs.map((g) => JSON.stringify(g.char)).join(" ")}`);

  gen.dispose();
}

main().catch((err) => {
  console.error("[bake] FAILED:", err);
  process.exit(1);
});
