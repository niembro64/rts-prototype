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

type Label = {
  sprite: THREE.Sprite;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  material: THREE.SpriteMaterial;
  /** Last-baked text. The canvas re-paints only when this changes. */
  lastText: string;
  /** Last-baked canvas dimensions in pixels. The sprite's world width
   *  is `(canvasW / canvasH) × worldHeight`, so character proportions
   *  stay uniform regardless of text length. */
  lastCanvasW: number;
  lastCanvasH: number;
};

export class NameLabel3D {
  /** Module-shared scratch vector reused for every frustum probe so
   *  the per-frame loop allocates nothing. */
  private static readonly _probeVec = new THREE.Vector3();

  private parent: THREE.Group;
  /** Pool grows on demand. Each label keeps its sprite parented to
   *  `parent` for the life of the renderer — endFrame just hides the
   *  unused tail, beginFrame doesn't tear down sprites. */
  private pool: Label[] = [];

  /** Per-frame cursor — same pattern as HealthBar3D. */
  private _used = 0;
  private _seenEntityFrame = new Map<EntityId, number>();
  private _frameToken = 0;
  private _frustum: THREE.Frustum | null = null;

  constructor(parent: THREE.Group) {
    this.parent = parent;
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
    const worldWidth = (label.lastCanvasW / label.lastCanvasH) * worldHeight;
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
    for (let i = this._used; i < this.pool.length; i++) {
      this.pool[i].sprite.visible = false;
    }
    this._frustum = null;
  }

  destroy(): void {
    for (const label of this.pool) {
      this.parent.remove(label.sprite);
      label.texture.dispose();
      label.material.dispose();
    }
    this.pool.length = 0;
    this._seenEntityFrame.clear();
  }

  // ── internals ──

  private acquire(i: number): Label {
    let label = this.pool[i];
    if (!label) {
      // Initial canvas size is provisional — the first repaint will
      // resize to fit the actual text. Setting some non-zero starter
      // dimensions keeps Three's CanvasTexture happy on first upload.
      const canvas = document.createElement('canvas');
      canvas.width = STYLE.canvasMinWidth;
      canvas.height = CANVAS_HEIGHT_PX;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('NameLabel3D: 2d canvas context unavailable');
      const texture = new THREE.CanvasTexture(canvas);
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: true,
      });
      const sprite = new THREE.Sprite(material);
      this.parent.add(sprite);
      label = {
        sprite, canvas, ctx, texture, material,
        lastText: '',
        lastCanvasW: canvas.width,
        lastCanvasH: canvas.height,
      };
      this.pool.push(label);
    }
    label.sprite.visible = true;
    return label;
  }

  private repaintIfChanged(label: Label, text: string): void {
    if (label.lastText === text) return;
    label.lastText = text;
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
    label.texture.needsUpdate = true;
    label.lastCanvasW = newW;
    label.lastCanvasH = newH;
  }
}
