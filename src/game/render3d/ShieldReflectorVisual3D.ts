import * as THREE from 'three';
import { SHIELD_VISUAL } from '../../config';
import { getPlayerPrimaryColor, type Entity } from '../sim/types';
import { REFLECTIVE_SHIELD_MATERIAL } from '../sim/blueprints/shieldMaterials';

// Materials Are Independent Of Shape: the shield surface is ONE material.
// The turretShieldSphere carries it as a sphere; the turretShieldPanel
// carries it as flat panels. Both render through the single shader + material
// factory below — the only difference is the instanced geometry feeding it.
// Per-instance `aColor` (team/config color) and `aAlpha` ride on
// InstancedBufferAttributes; the fragment is just `vec4(vColor, vAlpha)`.

// The authored material alpha IS the rendered surface alpha. No hidden
// renderer-side boost: shieldMaterials.json is the single knob, and both
// shapes (sphere bubble, flat panels) read it identically.
export const SHIELD_SURFACE_COLOR = REFLECTIVE_SHIELD_MATERIAL.visual.color;
export const SHIELD_SURFACE_OPACITY = Math.min(1, REFLECTIVE_SHIELD_MATERIAL.visual.alpha);

/** Color of the shield material at this surface — team color when the
 *  visual config is in player mode, else the authored fallback.
 *  Shape-independent: the sphere and the panels resolve their color
 *  through the same rule. */
export function resolveShieldSurfaceColor(entity: Entity): number {
  return SHIELD_VISUAL.colorMode === 'player' && entity.ownership
    ? getPlayerPrimaryColor(entity.ownership.playerId)
    : REFLECTIVE_SHIELD_MATERIAL.visual.color;
}

export const SHIELD_SURFACE_VS = `
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

export const SHIELD_SURFACE_FS = `
varying float vAlpha;
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, vAlpha);
}
`;

/** The one shield surface material. Both the sphere renderer and the
 *  flat-panel renderer build their instanced mesh on top of this — same
 *  shader, same blending, same depth/side params — so the two shapes are
 *  visually the same material and only differ in geometry. */
export function createShieldSurfaceMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: SHIELD_SURFACE_VS,
    fragmentShader: SHIELD_SURFACE_FS,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** Non-instanced fallback for the rare case where the shared panel instance
 *  pool is exhausted and panels render as per-unit meshes. Same shield
 *  surface color + opacity as the instanced material — it simply can't carry
 *  per-instance attributes, so it stays a plain MeshBasicMaterial. This is a
 *  rendering-infrastructure fallback, not a per-shape material branch. */
export function createShieldFallbackPanelMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: SHIELD_SURFACE_COLOR,
    transparent: true,
    opacity: SHIELD_SURFACE_OPACITY,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}
