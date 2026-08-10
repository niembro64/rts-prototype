// MapPresetLabel3D — the stock-preset caption painted flat on the ground
// just outside the map, at the (0, 0) corner (the near-left corner at the
// default camera yaw, where the camera sits on the -Z side looking toward
// +Z). It is map signage, not HUD: it lives in world space, so it is
// occluded by terrain and grows/shrinks with zoom like everything else.
//
// It appears ONLY while the battle bar matches a stock preset exactly —
// presetMapLabel broadcasts null the moment a knob drifts off, and null
// hides the mesh. One pooled canvas is repainted on change; there is no
// per-frame work at all (the mesh is static, so no update hook exists).

import * as THREE from 'three';
import { MAP_PRESET_LABEL_RENDER_CONFIG } from '@/config';
import { COLORS } from '@/colorsConfig';
import { NAME_LABEL_FONT_FAMILY } from '@/nameLabelConfig';
import { WATER_LEVEL } from '../sim/Terrain';
import type { MapPresetLabelLines, MapPresetLabelTarget } from './presetMapLabel';
import { TRANSPARENT_RENDER_ORDER_3D } from './TransparentRenderOrder3D';

const STYLE = {
  titleFontPx: MAP_PRESET_LABEL_RENDER_CONFIG.titleFontPx,
  infoFontPx: MAP_PRESET_LABEL_RENDER_CONFIG.infoFontPx,
  lineGapPx: MAP_PRESET_LABEL_RENDER_CONFIG.lineGapPx,
  canvasPadPx: MAP_PRESET_LABEL_RENDER_CONFIG.canvasPadPx,
  strokeWidthPx: MAP_PRESET_LABEL_RENDER_CONFIG.strokeWidthPx,
  blockHeightMapFraction: MAP_PRESET_LABEL_RENDER_CONFIG.blockHeightMapFraction,
  cornerMarginMapFraction: MAP_PRESET_LABEL_RENDER_CONFIG.cornerMarginMapFraction,
  groundLift: MAP_PRESET_LABEL_RENDER_CONFIG.groundLift,
  fillColor: COLORS.ui.mapPresetLabel.fillColor,
  strokeColor: COLORS.ui.mapPresetLabel.strokeColor,
};

function fontString(pixels: number): string {
  return `bold ${pixels}px ${NAME_LABEL_FONT_FAMILY}`;
}

function fontPxForLine(index: number): number {
  return index === 0 ? STYLE.titleFontPx : STYLE.infoFontPx;
}

/** Canvas height for `lines`: padding, the title row, then one gap +
 *  info row per remaining line. Exported for the contract test. */
export function mapPresetLabelCanvasHeight(lineCount: number): number {
  if (lineCount <= 0) return 0;
  let height = 2 * STYLE.canvasPadPx + STYLE.titleFontPx;
  for (let index = 1; index < lineCount; index++) {
    height += STYLE.lineGapPx + STYLE.infoFontPx;
  }
  return height;
}

export type MapPresetLabelPlacement = {
  readonly worldWidth: number;
  readonly worldHeight: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly centerZ: number;
};

/** Size the block from the canvas aspect and park it outside the map's
 *  (0, 0) corner: left edge flush with the map's x = 0 edge, first line
 *  one margin clear of the z = 0 edge, the whole block at z < 0 so it
 *  never overlaps the playable area. Pure so the contract test can hold
 *  that invariant without WebGL. */
export function resolveMapPresetLabelPlacement(
  mapAxis: number,
  canvasAspect: number,
): MapPresetLabelPlacement {
  const worldHeight = mapAxis * STYLE.blockHeightMapFraction;
  const worldWidth = canvasAspect * worldHeight;
  const margin = mapAxis * STYLE.cornerMarginMapFraction;
  return {
    worldWidth,
    worldHeight,
    centerX: worldWidth / 2,
    centerY: WATER_LEVEL + STYLE.groundLift,
    centerZ: -margin - worldHeight / 2,
  };
}

export class MapPresetLabel3D implements MapPresetLabelTarget {
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly geometry = new THREE.PlaneGeometry(1, 1);
  private readonly material: THREE.MeshBasicMaterial;
  private readonly mesh: THREE.Mesh;
  private readonly mapAxis: number;
  private lastKey: string | null = null;
  private destroyed = false;

  constructor(
    parent: THREE.Object3D,
    renderer: THREE.WebGLRenderer,
    mapWidth: number,
    mapHeight: number,
  ) {
    this.mapAxis = Math.max(mapWidth, mapHeight);
    const ctx = this.canvas.getContext('2d');
    if (ctx === null) throw new Error('MapPresetLabel3D requires a 2D canvas context');
    this.ctx = ctx;
    // Non-zero starter dimensions keep the CanvasTexture valid before the
    // first paint; every paint resizes the canvas to fit its own text.
    this.canvas.width = 2;
    this.canvas.height = 2;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    // Whole-map zoom minifies this hard, so mipmaps + anisotropy are what
    // keep the caption from shimmering into noise as the camera pulls out.
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      // The quad lies in the ground plane, so the camera sees whichever
      // face the current pitch presents.
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'MapPresetLabel';
    // +X stays map +X (screen right at default yaw) and the plane's local
    // +Y maps to world +Z, so the first line reads across the map's near
    // edge with later lines stacked toward the camera.
    this.mesh.rotation.x = Math.PI / 2;
    this.mesh.renderOrder = TRANSPARENT_RENDER_ORDER_3D.aboveWaterEffects;
    this.mesh.visible = false;
    parent.add(this.mesh);
  }

  setMapPresetLabelLines(lines: MapPresetLabelLines): void {
    if (this.destroyed) return;
    const painted = lines?.filter((line) => line.length > 0) ?? [];
    const key = painted.length > 0 ? painted.join('\n') : null;
    if (key === this.lastKey) return;
    this.lastKey = key;
    if (key === null) {
      this.mesh.visible = false;
      return;
    }
    this.paint(painted);
    this.placeMesh();
    this.mesh.visible = true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.mesh.parent?.remove(this.mesh);
    this.texture.dispose();
    this.material.dispose();
    this.geometry.dispose();
  }

  // ── internals ──

  private paint(lines: readonly string[]): void {
    const ctx = this.ctx;
    // Measure first — the font must be set before measureText, and
    // resizing the canvas wipes both the pixels and the context state.
    let widest = 0;
    for (let index = 0; index < lines.length; index++) {
      ctx.font = fontString(fontPxForLine(index));
      widest = Math.max(widest, Math.ceil(ctx.measureText(lines[index]).width));
    }
    this.canvas.width = widest + 2 * STYLE.canvasPadPx;
    this.canvas.height = mapPresetLabelCanvasHeight(lines.length);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = STYLE.strokeColor;
    ctx.fillStyle = STYLE.fillColor;

    let cursorY = STYLE.canvasPadPx;
    for (let index = 0; index < lines.length; index++) {
      const fontPx = fontPxForLine(index);
      if (index > 0) cursorY += STYLE.lineGapPx;
      ctx.font = fontString(fontPx);
      // The outline scales with the row so info lines don't get swallowed
      // by a stroke authored for the title.
      ctx.lineWidth = STYLE.strokeWidthPx * (fontPx / STYLE.titleFontPx);
      ctx.strokeText(lines[index], STYLE.canvasPadPx, cursorY);
      ctx.fillText(lines[index], STYLE.canvasPadPx, cursorY);
      cursorY += fontPx;
    }
    this.texture.needsUpdate = true;
  }

  private placeMesh(): void {
    const placement = resolveMapPresetLabelPlacement(
      this.mapAxis,
      this.canvas.width / this.canvas.height,
    );
    this.mesh.scale.set(placement.worldWidth, placement.worldHeight, 1);
    this.mesh.position.set(placement.centerX, placement.centerY, placement.centerZ);
  }
}
