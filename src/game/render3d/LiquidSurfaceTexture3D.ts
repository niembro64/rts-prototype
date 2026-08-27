// One small, deterministic texture generator for both horizontal liquid
// surfaces. Water and lava share the same seamless flow field so they read as
// two materials occupying the same physical kind of surface; contrast and
// channel grading give each material its own visual weight.

import * as THREE from 'three';

export type LiquidSurfaceTextureMode = 'water' | 'lava';

export type LiquidSurfaceTextureSpec = Readonly<{
  resolution: number;
  contrast: number;
}>;

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function byte(value: number): number {
  return Math.round(clampUnit(value) * 255);
}

/** Build one tileable RGB multiplier. Alpha stays fully opaque: the owning
 * material's authored opacity is the sole see-through control for water. */
export function createLiquidSurfaceTexture3D(
  mode: LiquidSurfaceTextureMode,
  spec: LiquidSurfaceTextureSpec,
): THREE.DataTexture {
  const pixels = spec.resolution;
  const data = new Uint8Array(pixels * pixels * 4);
  const tau = Math.PI * 2;

  for (let y = 0; y < pixels; y++) {
    const v = (y / pixels) * tau;
    for (let x = 0; x < pixels; x++) {
      const u = (x / pixels) * tau;
      // Integer-frequency periodic terms remain seamless on both axes. The
      // nested sines bend the bands into flow lines without hash-noise grit.
      const broadA = Math.sin(u * 2 + Math.sin(v * 3) * 0.82);
      const broadB = Math.sin(v * 3 - Math.sin(u * 2) * 0.68);
      const crossing = Math.sin(u * 5 - v * 4 + Math.sin(u + v) * 0.55);
      const field = clampUnit(0.5 + broadA * 0.22 + broadB * 0.18 + crossing * 0.10);
      const ridge = Math.pow(field, mode === 'water' ? 2.7 : 1.35);
      const offset = (y * pixels + x) * 4;

      if (mode === 'water') {
        // Eight percent contrast is deliberately quiet. It gives the plane a
        // readable flow direction while leaving material alpha—and therefore
        // everything beneath the water—untouched.
        const shade = 1 - spec.contrast * (0.18 + ridge * 0.82);
        data[offset] = byte(shade * 0.985);
        data[offset + 1] = byte(shade * 0.995);
        data[offset + 2] = byte(shade);
      } else {
        // Lava spends the same field as dark moving crust around bright veins.
        // A multiplicative map never raises the authored emissive color, so
        // the existing tone-mapped heat ceiling remains intact.
        const crust = Math.pow(1 - field, 0.72);
        const shade = 1 - spec.contrast * crust;
        data[offset] = byte(shade);
        data[offset + 1] = byte(shade * (0.72 + ridge * 0.28));
        data[offset + 2] = byte(shade * (0.50 + ridge * 0.50));
      }
      data[offset + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, pixels, pixels, THREE.RGBAFormat);
  texture.name = `LiquidSurfaceTexture:${mode}`;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}
