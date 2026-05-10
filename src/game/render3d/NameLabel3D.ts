// NameLabel3D — billboarded text labels for naming entities in the 3D
// scene. Pool-of-sprites design mirrors HealthBar3D so the per-frame
// hot path is allocation-free: each visible label reuses a pooled
// THREE.Sprite with a tiny CanvasTexture, and the canvas is rebaked
// only when the displayed string changes.
//
// Public API matches HealthBar3D's fused-iteration shape:
//   beginFrame(frustum?) → perEntity(entity, label) ×N → endFrame()
//
// The caller is responsible for resolving "what label does this entity
// get?" via @/game/render3d/EntityName.resolveEntityDisplayName, so the
// label renderer stays oblivious to player rosters / AI personalities /
// future per-entity rename systems — it just paints the strings it's
// handed.

import * as THREE from 'three';
import type { Entity, EntityId } from '../sim/types';
import { getBuildingHudNameY, getUnitHudNameY } from './HudAnchor';
import { CanvasSpritePool, type CanvasSpriteSlot } from './CanvasSpritePool';
import {
  NAME_LABEL_WORLD_HEIGHT,
  NAME_LABEL_FONT_PX,
  NAME_LABEL_FONT_FAMILY,
  NAME_LABEL_FILL_COLOR,
  NAME_LABEL_STROKE_COLOR,
  NAME_LABEL_STROKE_WIDTH_PX,
  NAME_LABEL_CANVAS_PAD_X,
  NAME_LABEL_CANVAS_PAD_Y,
  NAME_LABEL_CANVAS_MIN_WIDTH,
} from '@/nameLabelConfig';

// Local short-name alias for the imported config — keeps call sites
// terse while every tunable lives in @/nameLabelConfig.
const STYLE = {
  worldHeight: NAME_LABEL_WORLD_HEIGHT,
  fontPx: NAME_LABEL_FONT_PX,
  fontFamily: NAME_LABEL_FONT_FAMILY,
  fillColor: NAME_LABEL_FILL_COLOR,
  strokeColor: NAME_LABEL_STROKE_COLOR,
  strokeWidthPx: NAME_LABEL_STROKE_WIDTH_PX,
  canvasPadX: NAME_LABEL_CANVAS_PAD_X,
  canvasPadY: NAME_LABEL_CANVAS_PAD_Y,
  canvasMinWidth: NAME_LABEL_CANVAS_MIN_WIDTH,
};

const FONT_STRING = `bold ${STYLE.fontPx}px ${STYLE.fontFamily}`;
const CANVAS_HEIGHT_PX = STYLE.fontPx + 2 * STYLE.canvasPadY;

type LabelState = {
  /** Last-baked text. The canvas re-paints only when this changes. */
  lastText: string;
  /** Last-baked canvas dimensions in pixels. The sprite's world width
   *  is `(canvasW / canvasH) × worldHeight`, so character proportions
   *  stay uniform regardless of text length. */
  lastCanvasW: number;
  lastCanvasH: number;
};

type Label = CanvasSpriteSlot<LabelState>;

function makeLabelState(slot: Pick<Label, 'canvas'>): LabelState {
  return {
    lastText: '',
    lastCanvasW: slot.canvas.width,
    lastCanvasH: slot.canvas.height,
  };
}

function repaintLabel(label: Label, text: string): boolean {
  if (label.state.lastText === text) return false;
  label.state.lastText = text;
  const ctx = label.ctx;
  const canvas = label.canvas;

  // Measure first (font must be set before measureText). Then resize
  // the canvas to fit the text exactly + padding. Resizing wipes the
  // canvas + all context state, so re-set context props after.
  ctx.font = FONT_STRING;
  const measured = Math.ceil(ctx.measureText(text).width);
  const newW = Math.max(STYLE.canvasMinWidth, measured + 2 * STYLE.canvasPadX);
  const newH = CANVAS_HEIGHT_PX;
  if (canvas.width !== newW) canvas.width = newW;
  if (canvas.height !== newH) canvas.height = newH;
  ctx.font = FONT_STRING;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = STYLE.strokeWidthPx;
  ctx.strokeStyle = STYLE.strokeColor;
  ctx.fillStyle = STYLE.fillColor;
  ctx.strokeText(text, newW / 2, newH / 2);
  ctx.fillText(text, newW / 2, newH / 2);
  label.state.lastCanvasW = newW;
  label.state.lastCanvasH = newH;
  return true;
}

export class NameLabel3D {
  /** Module-shared scratch vector reused for every frustum probe so
   *  the per-frame loop allocates nothing. */
  private static readonly _probeVec = new THREE.Vector3();

  /** Pool grows on demand. Each label keeps its sprite parented to
   *  `parent` for the life of the renderer — endFrame just hides the
   *  unused tail, beginFrame doesn't tear down sprites. */
  private pool: CanvasSpritePool<LabelState, [string]>;

  /** Per-frame cursor — same pattern as HealthBar3D. */
  private _used = 0;
  private _seenEntityFrame = new Map<EntityId, number>();
  private _frameToken = 0;
  private _frustum: THREE.Frustum | null = null;

  constructor(parent: THREE.Group) {
    this.pool = new CanvasSpritePool<LabelState, [string]>({
      parent,
      // Initial canvas size is provisional; the first repaint resizes
      // to fit actual text. Non-zero starter dimensions keep Three's
      // CanvasTexture valid before the first upload.
      canvasWidth: STYLE.canvasMinWidth,
      canvasHeight: CANVAS_HEIGHT_PX,
      debugName: 'NameLabel3D',
      makeState: makeLabelState,
      repaint: repaintLabel,
    });
  }

  /** Reset frame state. Caller follows with a series of perEntity
   *  calls and finishes with endFrame. */
  beginFrame(frustum?: THREE.Frustum): void {
    this._used = 0;
    this._frameToken = (this._frameToken + 1) & 0x3fffffff;
    if (this._frameToken === 0) {
      this._seenEntityFrame.clear();
      this._frameToken = 1;
    }
    this._frustum = frustum ?? null;
  }

  /** Emit (or update) a label for `entity` reading `text`. `text` may
   *  be null / empty — that's a no-op so callers can run a uniform
   *  per-entity loop and let the resolver decide whether each entity
   *  gets a label. */
  perEntity(entity: Entity, text: string | null): void {
    if (!text || text.length === 0) return;
    if (this._seenEntityFrame.get(entity.id) === this._frameToken) return;
    this._seenEntityFrame.set(entity.id, this._frameToken);

    const isUnit = !!entity.unit;
    const isBuilding = !!entity.building;
    if (!isUnit && !isBuilding) return;

    const worldX = entity.transform.x;
    const worldY = isUnit
      ? getUnitHudNameY(entity)
      : getBuildingHudNameY(entity);
    const worldZ = entity.transform.y;

    const label = this.acquire(this._used++);
    this.repaintIfChanged(label, text);

    // Sprite's world aspect = canvas aspect, so text proportions stay
    // uniform: short names render small, long names render long, and
    // each character claims the same world height across all labels.
    const worldHeight = STYLE.worldHeight;
    const worldWidth = (label.state.lastCanvasW / label.state.lastCanvasH) * worldHeight;
    label.sprite.scale.set(worldWidth, worldHeight, 1);
    label.sprite.position.set(worldX, worldY, worldZ);
    if (this._frustum) {
      const probe = NameLabel3D._probeVec;
      probe.set(worldX, worldY, worldZ);
      label.sprite.visible = this._frustum.containsPoint(probe);
    } else {
      label.sprite.visible = true;
    }
  }

  /** Hide trailing pool entries past the live prefix. */
  endFrame(): void {
    this.pool.hideUnused(this._used);
    this._frustum = null;
  }

  destroy(): void {
    this.pool.destroy();
    this._seenEntityFrame.clear();
  }

  // ── internals ──

  private acquire(i: number): Label {
    return this.pool.acquire(i);
  }

  private repaintIfChanged(label: Label, text: string): void {
    this.pool.repaintIfChanged(label, text);
  }
}
