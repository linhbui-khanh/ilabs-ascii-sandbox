// Full-screen quad vertex shader.
// Renders a single quad that covers the viewport; all real work happens
// per-pixel in the fragment shader. Nothing here needs to change if you
// port this to a different engine — it's the standard post-processing pass.

varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
