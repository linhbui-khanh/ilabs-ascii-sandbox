// Generates a tileable blue-noise-ish threshold texture on a <canvas>,
// entirely procedurally — no downloaded asset needed.
//
// Technique: white noise, minus a blurred copy of itself (a crude high-pass),
// then histogram-equalized so the result has a flat, uniform distribution of
// threshold values. This isn't a true void-and-cluster blue noise (that needs
// an offline optimizer), but it suppresses low-frequency clumping the same
// way blue noise does, which is the part that visibly matters for dithering.
// Good enough for a sandbox; swap in a real precomputed blue-noise PNG for
// production if you want the textbook version.

export function generateBlueNoiseCanvas(size = 64, blurRadius = 2) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  // 1) white noise, tileable (wrap-around indexing)
  const white = new Float32Array(size * size);
  for (let i = 0; i < white.length; i++) white[i] = Math.random();

  // 2) box-blur pass (wrap-around, so the result tiles cleanly)
  const blurred = new Float32Array(size * size);
  const r = blurRadius;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const sx = (x + dx + size) % size;
          const sy = (y + dy + size) % size;
          sum += white[sy * size + sx];
          count++;
        }
      }
      blurred[y * size + x] = sum / count;
    }
  }

  // 3) high-pass = white - blurred, then rank-order (histogram equalize)
  const highpass = new Float32Array(size * size);
  for (let i = 0; i < highpass.length; i++) highpass[i] = white[i] - blurred[i];

  const order = Array.from(highpass.keys()).sort((a, b) => highpass[a] - highpass[b]);
  const equalized = new Float32Array(size * size);
  for (let rank = 0; rank < order.length; rank++) {
    equalized[order[rank]] = rank / (order.length - 1);
  }

  const imgData = ctx.createImageData(size, size);
  for (let i = 0; i < equalized.length; i++) {
    const v = Math.round(equalized[i] * 255);
    imgData.data[i * 4 + 0] = v;
    imgData.data[i * 4 + 1] = v;
    imgData.data[i * 4 + 2] = v;
    imgData.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);

  return canvas;
}
