// Per-frame graphics state for the 3D renderer.
//
// This snapshots the single active graphics config plus camera view data
// needed by renderers.

import type * as THREE from 'three';
import { getGraphicsConfig } from '@/clientBarConfig';
import type { GraphicsConfig } from '@/types/graphics';

/** Stringified graphics key covering every GraphicsConfig axis that affects 3D
 *  geometry (not just runtime transforms). Two meshes share a key iff they
 *  were built against equivalent graphics settings. */
let lastGraphicsKeyConfig: GraphicsConfig | null = null;
let lastGraphicsKey = '';

function graphicsKey(gfx: GraphicsConfig): string {
  if (gfx === lastGraphicsKeyConfig) return lastGraphicsKey;
  lastGraphicsKeyConfig = gfx;
  lastGraphicsKey = `${gfx.unitShape}|${gfx.legs}|${
    gfx.treadsAnimated ? 'tw' : 'ts'
  }|${gfx.chassisDetail ? 'cd' : '-'}|${gfx.turretStyle}|${
    gfx.forceTurretStyle
  }|${gfx.paletteShading ? 'ps' : '-'}|${
    gfx.barrelSpin ? 'bs' : '-'
  }|${gfx.beamGlow ? 'bg' : '-'}`;
  return lastGraphicsKey;
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

function createRenderViewState(): RenderViewState3D {
  return { ...DEFAULT_RENDER_VIEW };
}

export function createRenderFrameState(): RenderFrameState3D {
  const gfx = getGraphicsConfig();
  return {
    gfx,
    key: graphicsKey(gfx),
    view: createRenderViewState(),
  };
}

export function snapshotRenderFrameState(
  camera?: THREE.PerspectiveCamera,
  viewportHeightPx: number = 1,
  out: RenderFrameState3D = createRenderFrameState(),
): RenderFrameState3D {
  const gfx = getGraphicsConfig();
  out.gfx = gfx;
  out.key = graphicsKey(gfx);
  const view = out.view;
  if (camera) {
    const me = camera.matrixWorld.elements;
    view.viewportHeightPx = Math.max(1, viewportHeightPx);
    view.cameraX = camera.position.x;
    view.cameraY = camera.position.y;
    view.cameraZ = camera.position.z;
    view.forwardX = -me[8];
    view.forwardY = -me[9];
    view.forwardZ = -me[10];
    view.fovYRad = (camera.fov * Math.PI) / 180;
  } else {
    view.viewportHeightPx = DEFAULT_RENDER_VIEW.viewportHeightPx;
    view.cameraX = DEFAULT_RENDER_VIEW.cameraX;
    view.cameraY = DEFAULT_RENDER_VIEW.cameraY;
    view.cameraZ = DEFAULT_RENDER_VIEW.cameraZ;
    view.forwardX = DEFAULT_RENDER_VIEW.forwardX;
    view.forwardY = DEFAULT_RENDER_VIEW.forwardY;
    view.forwardZ = DEFAULT_RENDER_VIEW.forwardZ;
    view.fovYRad = DEFAULT_RENDER_VIEW.fovYRad;
  }
  return out;
}
