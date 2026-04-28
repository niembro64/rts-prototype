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
   *  centerline sits. The collider radius / building half-depth is
   *  only a coarse "top" — visual elements like turrets, mirrors,
   *  legs, and roof structures often extend well above it, so the
   *  offset is generous enough to clear them and leave the HP bar
   *  visibly separated below the text. */
  worldOffsetAbove: 90,
  /** TARGET pixel height of the label on screen, regardless of
   *  camera distance — sprites use sizeAttenuation: false so the
   *  text always reads at this size whether the unit is close or
   *  way out at the edge of the map. */
  pixelHeight: 18,
  /** Canvas resolution. The font fills the canvas height; width
   *  grows with the measured text width. With non-mipped textures
   *  there's no benefit to power-of-two sizing. */
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
  /** Module-shared scratch vector for per-frame frustum probes. */
  private static readonly _probeVec = new THREE.Vector3();

  private parent: THREE.Group;
  private camera: THREE.PerspectiveCamera;
  private getViewport: () => { width: number; height: number };
  private pool: Label[] = [];
  private hadVisible = false;

  constructor(
    parent: THREE.Group,
    camera: THREE.PerspectiveCamera,
    getViewport: () => { width: number; height: number },
  ) {
    this.parent = parent;
    this.camera = camera;
    this.getViewport = getViewport;
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
        sizeAttenuation: false,
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
    frustum?: THREE.Frustum,
  ): void {
    if (selectedUnits.length === 0 && selectedBuildings.length === 0) {
      if (this.hadVisible) {
        for (let i = 0; i < this.pool.length; i++) {
          this.pool[i].sprite.visible = false;
        }
        this.hadVisible = false;
      }
      return;
    }

    let used = 0;

    // For sprites with sizeAttenuation: false on a perspective
    // camera, the on-screen pixel size of a sprite equals
    //   scale * projection[1][1] * viewportHeight / 2
    // where projection[1][1] = 1 / tan(fovy/2). Solving for scale
    // (so that any pixel target → matching scale) yields the
    // pxToScale factor below; both axes use the same factor since
    // the projection's x scaling already accounts for aspect ratio
    // when sizeAttenuation is off.
    const vp = this.getViewport();
    const fovRad = this.camera.fov * Math.PI / 180;
    const pxToScale = vp.height > 0
      ? 2 * Math.tan(fovRad / 2) / vp.height
      : 0;
    const probe = SelectionLabel3D._probeVec;

    // Stable slot assignment: every selected entity gets its own
    // pool slot in iteration order, regardless of frustum visibility.
    // This is critical — if we skip out-of-frustum entities entirely
    // we'd reassign slots when units enter/leave the camera, and the
    // labels would visibly flip between entities (a Tick label
    // ending up briefly on a Commander, etc.) until the next text
    // repaint catches up. Frustum culling here is a per-sprite
    // visibility flag, not a slot-skip.
    for (const u of selectedUnits) {
      if (!u.unit || u.unit.hp <= 0) continue;
      const radius = u.unit.unitRadiusCollider.scale;
      const worldX = u.transform.x;
      const worldY = u.transform.z + radius + STYLE.worldOffsetAbove;
      const worldZ = u.transform.y;
      const text = labelTextForUnit(u);
      const label = this.acquire(used++);
      const canvasWidth = this.repaintIfChanged(label, text);
      const aspect = canvasWidth / STYLE.canvasHeight;
      const pxH = STYLE.pixelHeight;
      const pxW = pxH * aspect;
      label.sprite.scale.set(pxW * pxToScale, pxH * pxToScale, 1);
      label.sprite.position.set(worldX, worldY, worldZ);
      if (frustum) {
        probe.set(worldX, worldY, worldZ);
        label.sprite.visible = frustum.containsPoint(probe);
      }
    }

    for (const b of selectedBuildings) {
      if (!b.building || b.building.hp <= 0) continue;
      const halfDepth = b.building.depth / 2;
      const worldX = b.transform.x;
      const worldY = b.transform.z + halfDepth + STYLE.worldOffsetAbove;
      const worldZ = b.transform.y;
      const text = labelTextForBuilding(b);
      const label = this.acquire(used++);
      const canvasWidth = this.repaintIfChanged(label, text);
      const aspect = canvasWidth / STYLE.canvasHeight;
      const pxH = STYLE.pixelHeight;
      const pxW = pxH * aspect;
      label.sprite.scale.set(pxW * pxToScale, pxH * pxToScale, 1);
      label.sprite.position.set(worldX, worldY, worldZ);
      if (frustum) {
        probe.set(worldX, worldY, worldZ);
        label.sprite.visible = frustum.containsPoint(probe);
      }
    }

    for (let i = used; i < this.pool.length; i++) {
      this.pool[i].sprite.visible = false;
    }
    this.hadVisible = used > 0;
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
