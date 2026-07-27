export const INSTANCED_COLOR_ALPHA_PARTICLE_VERTEX_SHADER = `
attribute float aAlpha;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

export const INSTANCED_COLOR_ALPHA_PARTICLE_FRAGMENT_SHADER = `
varying float vAlpha;
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, vAlpha);
}
`;

// Alpha-only variant for pools whose color rides a uniform (or a custom
// fragment shader) instead of a per-instance aColor attribute.
export const INSTANCED_ALPHA_PARTICLE_VERTEX_SHADER = `
attribute float aAlpha;
varying float vAlpha;
void main() {
  vAlpha = aAlpha;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;
