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
import { getEntityHudAnchorY, getEntityHudBarsBaseGapPx } from './HudAnchor';
import type { HudScreenSpace } from './HudScreenSpace';
import { CanvasSpritePool, type CanvasSpriteSlot } from './CanvasSpritePool';
import { SHELL_BAR_PX_HEIGHT } from '@/shellConfig';
import {
  ENTITY_HUD_BAR_STACK_GAP_PX,
  ENTITY_HUD_BAR_STACK_ROWS,
  ENTITY_HUD_NAME_GAP_ABOVE_BARS_PX,
} from '@/config';
import {
  NAME_LABEL_PX_HEIGHT,
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
  pxHeight: NAME_LABEL_PX_HEIGHT,
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

const HUD_BAR_STACK_ROWS = Math.max(1, Math.floor(ENTITY_HUD_BAR_STACK_ROWS));
/** Screen-pixels from the bottom bar's bottom edge (the per-blueprint
 *  base gap) up to the name's center: the full fixed bar stack, the
 *  name gap, then half the name height. Fixed-rows so the name doesn't
 *  reflow when resource build bars appear/disappear beneath it. */
const NAME_CENTER_ABOVE_BASE_PX =
  HUD_BAR_STACK_ROWS * SHELL_BAR_PX_HEIGHT +
  (HUD_BAR_STACK_ROWS - 1) * ENTITY_HUD_BAR_STACK_GAP_PX +
  ENTITY_HUD_NAME_GAP_ABOVE_BARS_PX +
  NAME_LABEL_PX_HEIGHT / 2;

type LabelState = {
  /** Last-baked text. The canvas re-paints only when this changes. */
  lastText: string;
  /** Last-baked canvas dimensions in pixels. The sprite's on-screen
   *  width is `(canvasW / canvasH) × pxHeight`, so character proportions
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
  /** Pool grows on demand. Each label keeps its sprite parented to
   *  `parent` for the life of the renderer — endFrame just hides the
   *  unused tail, beginFrame doesn't tear down sprites. */
  private pool: CanvasSpritePool<LabelState, [string]>;

  /** Per-frame cursor — same pattern as HealthBar3D. */
  private _used = 0;
  private _seenEntityFrame = new Map<EntityId, number>();
  private _frameToken = 0;
  private _frustum: THREE.Frustum | null = null;
  /** Per-frame screen-space scaler, set by beginFrame. */
  private _screen: HudScreenSpace | null = null;

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
  beginFrame(screen: HudScreenSpace, frustum?: THREE.Frustum): void {
    this._used = 0;
    this._frameToken = (this._frameToken + 1) & 0x3fffffff;
    // Clear the per-frame dedup map each frame so it stays bounded to
    // entities actually drawn this frame. Previously it only cleared on
    // the ~185-day token rollover, so it retained an entry for every
    // entity id that ever rendered a label.
    this._seenEntityFrame.clear();
    this._screen = screen;
    this._frustum = frustum ?? null;
  }

  /** Emit (or update) a label for `entity` reading `text`. `text` may
   *  be null / empty — that's a no-op so callers can run a uniform
   *  per-entity loop and let the resolver decide whether each entity
   *  gets a label. */
  perEntity(entity: Entity, text: string | null): void {
    if (!text || text.length === 0) return;
    const screen = this._screen;
    if (!screen) return;
    if (this._seenEntityFrame.get(entity.id) === this._frameToken) return;
    this._seenEntityFrame.set(entity.id, this._frameToken);

    if (!entity.unit && !entity.building) return;

    const anchorX = entity.transform.x;
    const anchorY = getEntityHudAnchorY(entity);
    const anchorZ = entity.transform.y;
    const centerPx = getEntityHudBarsBaseGapPx(entity) + NAME_CENTER_ABOVE_BASE_PX;

    const label = this.acquire(this._used++);
    this.repaintIfChanged(label, text);

    // Sprite aspect = canvas aspect, so text proportions stay uniform:
    // short names render small, long names long, each character the same
    // on-screen height across all labels.
    const widthPx = (label.state.lastCanvasW / label.state.lastCanvasH) * STYLE.pxHeight;
    screen.placeSprite(
      label.sprite,
      anchorX,
      anchorY,
      anchorZ,
      centerPx,
      widthPx,
      STYLE.pxHeight,
    );
    label.sprite.visible = this._frustum
      ? this._frustum.containsPoint(label.sprite.position)
      : true;
  }

  /** Hide trailing pool entries past the live prefix. */
  endFrame(): void {
    this.pool.hideUnused(this._used);
    this._frustum = null;
    this._screen = null;
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
