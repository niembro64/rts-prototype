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
import { getBuildingHudTopY, getUnitHudTopY } from './HudAnchor';

/** Visual constants. Kept local rather than in shellConfig because the
 *  label is a generic naming surface, not a shell-specific affordance —
 *  it shows on completed commanders too. */
const STYLE = {
  /** World-space height of the label's bounding box (used for sprite
   *  Y-extent). Width is data-driven from the rendered text length. */
  worldHeight: 8,
  /** Distance above the entity's HUD top in world units. Sits ABOVE
   *  the bar stack (HP + 3 resource bars) so a fresh shell shows
   *  bars + name without stacking math. */
  worldOffsetAbove: 28,
  /** Texture canvas size — wide enough for ~24 chars at the chosen
   *  font, kept square-ish for a compact GPU footprint. */
  canvasWidth: 256,
  canvasHeight: 32,
  /** Font: pixel-aligned, no anti-aliasing fuzz. Drawn at 2× canvas
   *  size for retina-clean edges; the sprite scale handles world fit. */
  fontPx: 22,
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  fillColor: '#ffffff',
  strokeColor: '#000000',
  strokeWidthPx: 4,
  /** Constant world-space width per character. Sprite scale.x is
   *  `chars × widthPerChar` so the label keeps the text crisp at any
   *  zoom — billboard sprites pixelate when scaled past their texture
   *  resolution, so we set a sensible cap rather than reading the
   *  measured pixel width back out of the canvas every frame. */
  worldWidthPerChar: 5,
};

type Label = {
  sprite: THREE.Sprite;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  material: THREE.SpriteMaterial;
  /** Last-baked text. The canvas re-paints only when this changes.
   *  Same memoization trick HealthBar3D uses on its (mode, ratioPx). */
  lastText: string;
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
      ? getUnitHudTopY(entity) + STYLE.worldOffsetAbove
      : getBuildingHudTopY(entity) + STYLE.worldOffsetAbove;
    const worldZ = entity.transform.y;

    const label = this.acquire(this._used++);
    this.repaintIfChanged(label, text);

    const worldWidth = Math.max(
      STYLE.worldWidthPerChar * 4,
      STYLE.worldWidthPerChar * text.length,
    );
    label.sprite.scale.set(worldWidth, STYLE.worldHeight, 1);
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
      const canvas = document.createElement('canvas');
      canvas.width = STYLE.canvasWidth;
      canvas.height = STYLE.canvasHeight;
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
      label = { sprite, canvas, ctx, texture, material, lastText: '' };
      this.pool.push(label);
    }
    label.sprite.visible = true;
    return label;
  }

  private repaintIfChanged(label: Label, text: string): void {
    if (label.lastText === text) return;
    label.lastText = text;
    const ctx = label.ctx;
    const w = STYLE.canvasWidth;
    const h = STYLE.canvasHeight;
    ctx.clearRect(0, 0, w, h);
    ctx.font = `bold ${STYLE.fontPx}px ${STYLE.fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = STYLE.strokeWidthPx;
    ctx.strokeStyle = STYLE.strokeColor;
    ctx.fillStyle = STYLE.fillColor;
    ctx.strokeText(text, w / 2, h / 2);
    ctx.fillText(text, w / 2, h / 2);
    label.texture.needsUpdate = true;
  }
}
