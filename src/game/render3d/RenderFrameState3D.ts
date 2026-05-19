// Per-frame graphics state for the 3D renderer.
//
// This snapshots the single active graphics config plus camera view data
// needed by renderers. It does not resolve camera-distance object tiers.

import type * as THREE from 'three';
import { getGraphicsConfig } from '@/clientBarConfig';
import type { GraphicsConfig } from '@/types/graphics';

/** Stringified graphics key covering every GraphicsConfig axis that affects 3D
 *  geometry (not just runtime transforms). Two meshes share a key iff they
 *  were built against equivalent graphics settings. */
export function graphicsKey(gfx: GraphicsConfig): string {
  return [
    gfx.tier,
    gfx.unitRenderMode,
    gfx.unitShape,
    gfx.legs,
    gfx.treadsAnimated ? 'tw' : 'ts',
    gfx.chassisDetail ? 'cd' : '-',
    gfx.turretStyle,
    gfx.forceTurretStyle,
    gfx.paletteShading ? 'ps' : '-',
    // MED+ flag controlling animated accents that cost setup (e.g. mirror
    // sparkles). In key so toggling the graphics tier rebuilds affected meshes.
    gfx.barrelSpin ? 'bs' : '-',
    // MAX-only intensifier (e.g. secondary mirror glint). Same reason.
    gfx.beamGlow ? 'bg' : '-',
  ].join('|');
}

/** Current graphics snapshot: read once per frame, not per draw. */
export type RenderFrameState3D = {
  gfx: GraphicsConfig;
  key: string;
  view: RenderViewState3D;
};

export type RenderViewState3D = {
  viewportHeightPx: number;
  cameraX: number;
  cameraY: number;
  cameraZ: number;
  forwardX: number;
  forwardY: number;
  forwardZ: number;
  fovYRad: number;
};

const DEFAULT_RENDER_VIEW: RenderViewState3D = {
  viewportHeightPx: 1,
  cameraX: 0,
  cameraY: 0,
  cameraZ: 0,
  forwardX: 0,
  forwardY: 0,
  forwardZ: -1,
  fovYRad: Math.PI / 4,
};

export function snapshotRenderFrameState(
  camera?: THREE.PerspectiveCamera,
  viewportHeightPx: number = 1,
): RenderFrameState3D {
  const gfx = getGraphicsConfig();
  let view = DEFAULT_RENDER_VIEW;
  if (camera) {
    const me = camera.matrixWorld.elements;
    view = {
      viewportHeightPx: Math.max(1, viewportHeightPx),
      cameraX: camera.position.x,
      cameraY: camera.position.y,
      cameraZ: camera.position.z,
      forwardX: -me[8],
      forwardY: -me[9],
      forwardZ: -me[10],
      fovYRad: (camera.fov * Math.PI) / 180,
    };
  }
  return { gfx, key: graphicsKey(gfx), view };
}
