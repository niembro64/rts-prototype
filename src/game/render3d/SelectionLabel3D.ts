// SelectionLabel3D — billboarded text labels in the 3D scene.
//
// One pooled THREE.Sprite per selected entity. Each sprite has a
// CanvasTexture rendered with the entity's display name; the canvas
// is only redrawn when the text actually changes (which is "almost
// never" — selection labels mostly stay the same string for as long
// as the entity is alive). Sprites auto-billboard to the camera and
// share the depth buffer with the world geometry, so a label on a
// unit behind a hill is naturally hidden — no separate occlusion
// path, no SVG overlay.

import * as THREE from 'three';
import type { Entity } from '../sim/types';
import { labelTextForUnit, labelTextForBuilding } from '../uiLabels';

const STYLE = {
  /** Distance above the entity's top in world units where the label
   *  centerline sits. Above the HP bar so they don't overlap. */
  worldOffsetAbove: 26,
  /** Sprite height in world units; width is computed from the
   *  measured text width so wide labels read fully. */
  worldHeight: 8,
  /** Canvas resolution. The font fills the canvas height; width
   *  grows with measured text width (rounded up to a power of two
   *  is unnecessary for non-mipped textures). */
  canvasHeight: 64,
  fontSize: 40,
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  textColor: '#ffffff',
  bgColor: 'rgba(0, 0, 0, 0.55)',
  paddingX: 16,
};

type Label = {
  sprite: THREE.Sprite;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  material: THREE.SpriteMaterial;
  /** Last text we baked, so we skip canvas work when it hasn't
   *  changed. */
  lastText: string | null;
  /** Cached canvas width that produced lastText, so the world
   *  scale factor stays in sync without re-measuring. */
  lastCanvasWidth: number;
};

export class SelectionLabel3D {
  private parent: THREE.Group;
  private pool: Label[] = [];

  constructor(parent: THREE.Group) {
    this.parent = parent;
  }

  private acquire(i: number): Label {
    let label = this.pool[i];
    if (!label) {
      const canvas = document.createElement('canvas');
      canvas.height = STYLE.canvasHeight;
      canvas.width = 1; // sized on first paint
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('SelectionLabel3D: 2d canvas context unavailable');
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
      label = { sprite, canvas, ctx, texture, material, lastText: null, lastCanvasWidth: 1 };
      this.pool.push(label);
    }
    label.sprite.visible = true;
    return label;
  }

  /** Repaint the label canvas if the text changed. Returns the new
   *  canvas width so the caller can compute the sprite's world
   *  scale. */
  private repaintIfChanged(label: Label, text: string): number {
    if (label.lastText === text) return label.lastCanvasWidth;
    label.lastText = text;
    const ctx = label.ctx;
    // Use a temporary font setting on the bare context to measure
    // the text width before we know the final canvas size.
    ctx.font = `${STYLE.fontSize}px ${STYLE.fontFamily}`;
    const metrics = ctx.measureText(text);
    const textWidth = Math.ceil(metrics.width);
    const canvasWidth = textWidth + 2 * STYLE.paddingX;
    label.canvas.width = canvasWidth;
    label.canvas.height = STYLE.canvasHeight;
    // Resizing the canvas resets context state — re-set everything.
    ctx.font = `${STYLE.fontSize}px ${STYLE.fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = STYLE.bgColor;
    ctx.fillRect(0, 0, canvasWidth, STYLE.canvasHeight);
    ctx.fillStyle = STYLE.textColor;
    ctx.fillText(text, canvasWidth / 2, STYLE.canvasHeight / 2);
    label.texture.needsUpdate = true;
    label.lastCanvasWidth = canvasWidth;
    return canvasWidth;
  }

  update(
    selectedUnits: readonly Entity[],
    selectedBuildings: readonly Entity[],
  ): void {
    let used = 0;

    for (const u of selectedUnits) {
      if (!u.unit || u.unit.hp <= 0) continue;
      const text = labelTextForUnit(u);
      const label = this.acquire(used++);
      const canvasWidth = this.repaintIfChanged(label, text);
      // World height is fixed; world width scales with canvas aspect
      // so wide labels stay readable.
      const aspect = canvasWidth / STYLE.canvasHeight;
      const worldWidth = STYLE.worldHeight * aspect;
      label.sprite.scale.set(worldWidth, STYLE.worldHeight, 1);
      const radius = u.unit.unitRadiusCollider.scale;
      label.sprite.position.set(
        u.transform.x,
        u.transform.z + radius + STYLE.worldOffsetAbove,
        u.transform.y,
      );
    }

    for (const b of selectedBuildings) {
      if (!b.building || b.building.hp <= 0) continue;
      const text = labelTextForBuilding(b);
      const label = this.acquire(used++);
      const canvasWidth = this.repaintIfChanged(label, text);
      const aspect = canvasWidth / STYLE.canvasHeight;
      const worldWidth = STYLE.worldHeight * aspect;
      label.sprite.scale.set(worldWidth, STYLE.worldHeight, 1);
      const halfDepth = b.building.depth / 2;
      label.sprite.position.set(
        b.transform.x,
        b.transform.z + halfDepth + STYLE.worldOffsetAbove,
        b.transform.y,
      );
    }

    for (let i = used; i < this.pool.length; i++) {
      this.pool[i].sprite.visible = false;
    }
  }

  destroy(): void {
    for (const label of this.pool) {
      this.parent.remove(label.sprite);
      label.texture.dispose();
      label.material.dispose();
    }
    this.pool.length = 0;
  }
}
