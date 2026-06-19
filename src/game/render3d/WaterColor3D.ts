import * as THREE from 'three';
import { WATER_RENDER_CONFIG } from '../../config';

type Rgb01 = {
  r: number;
  g: number;
  b: number;
};

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function hexToLinearRgb(hex: number): Rgb01 {
  const color = new THREE.Color(hex);
  return { r: color.r, g: color.g, b: color.b };
}

function scaleRgb(color: Rgb01, scale: number): Rgb01 {
  return {
    r: color.r * scale,
    g: color.g * scale,
    b: color.b * scale,
  };
}

function rrtAndOdtFit(color: Rgb01): Rgb01 {
  const fit = (v: number): number => {
    const a = v * (v + 0.0245786) - 0.000090537;
    const b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return a / b;
  };
  return {
    r: fit(color.r),
    g: fit(color.g),
    b: fit(color.b),
  };
}

function applyAcesFilmicToneMapping(color: Rgb01): Rgb01 {
  const exposed = scaleRgb(color, 1 / 0.6);
  const acesIn = {
    r: 0.59719 * exposed.r + 0.35458 * exposed.g + 0.04823 * exposed.b,
    g: 0.07600 * exposed.r + 0.90834 * exposed.g + 0.01566 * exposed.b,
    b: 0.02840 * exposed.r + 0.13383 * exposed.g + 0.83777 * exposed.b,
  };
  const fit = rrtAndOdtFit(acesIn);
  return {
    r: clamp01(1.60475 * fit.r - 0.53108 * fit.g - 0.07367 * fit.b),
    g: clamp01(-0.10208 * fit.r + 1.10813 * fit.g - 0.00605 * fit.b),
    b: clamp01(-0.00327 * fit.r - 0.07276 * fit.g + 1.07602 * fit.b),
  };
}

function linearToOutputRgb(color: Rgb01): Rgb01 {
  const output = new THREE.Color(color.r, color.g, color.b).convertLinearToSRGB();
  return {
    r: clamp01(output.r),
    g: clamp01(output.g),
    b: clamp01(output.b),
  };
}

function builtInMaterialOutputRgb(linearColor: Rgb01): Rgb01 {
  return linearToOutputRgb(applyAcesFilmicToneMapping(linearColor));
}

function quantizeOutputRgb(color: Rgb01): Rgb01 {
  return {
    r: Math.round(clamp01(color.r) * 255) / 255,
    g: Math.round(clamp01(color.g) * 255) / 255,
    b: Math.round(clamp01(color.b) * 255) / 255,
  };
}

function outputRgbToLinearRgb(color: Rgb01): Rgb01 {
  const linear = new THREE.Color().setRGB(color.r, color.g, color.b, THREE.SRGBColorSpace);
  return { r: linear.r, g: linear.g, b: linear.b };
}

function rgb01ToLinearColor(color: Rgb01): THREE.Color {
  return new THREE.Color().setRGB(color.r, color.g, color.b);
}

// The water surface material receives this linear color before Three's common
// tone-mapping and output-color conversion.
const WATER_SURFACE_LINEAR_RGB = hexToLinearRgb(WATER_RENDER_CONFIG.color);
export const WATER_SURFACE_LINEAR_COLOR = rgb01ToLinearColor(WATER_SURFACE_LINEAR_RGB);

// Final visible water target, snapped to the 8-bit framebuffer grid.
const WATER_SURFACE_OUTPUT_RGB = quantizeOutputRgb(
  builtInMaterialOutputRgb(WATER_SURFACE_LINEAR_RGB),
);

// Custom shaders keep attributes in linear working RGB and include
// <colorspace_fragment>, so this is the attribute color that resolves to the
// same 8-bit visible water target.
export const WATER_SURFACE_OUTPUT_LINEAR_RGB = outputRgbToLinearRgb(WATER_SURFACE_OUTPUT_RGB);
