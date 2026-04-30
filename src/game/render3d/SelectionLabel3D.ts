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
import { getBuildingHudTopY, getUnitHudTopY } from './HudAnchor';

const STYLE = {
  /** Distance above the entity's top in world units where the label
   *  centerline sits. The collider radius / building half-depth is
   *  only a coarse "top" — visual elements like turrets, mirrors,
   *  legs, and roof structures often extend well above it, so the
   *  offset is generous enough to clear them and leave the HP bar
   *  visibly separated below the text. */
  worldOffsetAbove: 90,
  /** Logical font pixel size — drawn at this size in canvas CSS px
   *  and shown 1:1 in screen px (sprite uses sizeAttenuation: false).
   *  The canvas backing-store is oversampled by `devicePixelRatio`
   *  so the rendered glyphs stay crisp on hi-DPI displays. The
   *  previous baker drew at 40 px on a 64-tall canvas and then
   *  downsampled to 18 screen px — that 64→18 LinearFilter shrink
   *  is what produced the "Tick w" smear (sub-pixel artifacts where
   *  the right side of 'k' bleeds into the right padding). 1:1
   *  logical-to-screen mapping keeps glyphs tight and unambiguous. */
  fontSize: 18,
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  textColor: '#ffffff',
  bgColor: 'rgba(15, 18, 24, 0.78)',
  paddingX: 10,
  paddingY: 4,
  borderRadius: 4,
};

/** Backing-store oversample so the canvas bitmap matches device pixels.
 *  Capped at 3 (no benefit beyond — texture upload bandwidth grows
 *  quadratically). Computed once at module load: hot-DPR changes are
 *  rare enough that re-evaluating per-bake isn't worth the cost. */
const DPR = Math.max(1, Math.min(3, Math.floor(
  typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1,
)));

type Label = {
  sprite: THREE.Sprite;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  material: THREE.SpriteMaterial;
  /** Last text we baked, so we skip canvas work when it hasn't
   *  changed. */
  lastText: string | null;
  /** Cached CSS-pixel width of the last bake — drives sprite scale. */
  lastCssWidth: number;
  /** Cached CSS-pixel height of the last bake — drives sprite scale. */
  lastCssHeight: number;
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
      // Sized on first paint; backing-store dims set in repaintIfChanged.
      canvas.width = 1;
      canvas.height = 1;
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
      label = {
        sprite, canvas, ctx, texture, material,
        lastText: null, lastCssWidth: 1, lastCssHeight: 1,
      };
      this.pool.push(label);
    }
    label.sprite.visible = true;
    return label;
  }

  /** Repaint the label canvas if the text changed. Bakes at
   *  device-pixel resolution but works in CSS-pixel coordinates so
   *  the math stays simple and the on-screen size matches the
   *  declared `STYLE.fontSize` 1:1. */
  private repaintIfChanged(label: Label, text: string): void {
    if (label.lastText === text) return;
    label.lastText = text;

    const ctx = label.ctx;
    const canvas = label.canvas;
    const fontSpec = `${STYLE.fontSize}px ${STYLE.fontFamily}`;

    // Measure with the destination ctx. The canvas is about to be
    // resized, which wipes ctx state — we'll re-set after.
    ctx.font = fontSpec;
    const metrics = ctx.measureText(text);
    const textWidth = Math.ceil(metrics.width);

    const cssW = textWidth + 2 * STYLE.paddingX;
    const cssH = STYLE.fontSize + 2 * STYLE.paddingY;

    // Backing-store dims = CSS dims × DPR. Always reassign even if
    // the value matches — per HTML spec any assignment to canvas.
    // width/height resets the bitmap, which is the cheapest way to
    // guarantee no residual pixels from a prior bake leak through
    // (a previous bake at a wider canvas + a same-width new bake
    // could otherwise show stale glyphs along the right edge).
    canvas.width = cssW * DPR;
    canvas.height = cssH * DPR;

    // The resize zeroed ctx state — re-establish transform + style.
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.font = fontSpec;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Rounded background pill. `roundRect` is in modern Chromium /
    // Safari / Firefox; fall back to a square rect on the rare
    // engine that lacks it.
    ctx.fillStyle = STYLE.bgColor;
    const ctxAny = ctx as unknown as { roundRect?: (x: number, y: number, w: number, h: number, r: number) => void };
    if (typeof ctxAny.roundRect === 'function') {
      ctx.beginPath();
      ctxAny.roundRect(0, 0, cssW, cssH, STYLE.borderRadius);
      ctx.fill();
    } else {
      ctx.fillRect(0, 0, cssW, cssH);
    }

    ctx.fillStyle = STYLE.textColor;
    ctx.fillText(text, cssW / 2, cssH / 2);

    label.texture.needsUpdate = true;
    label.lastCssWidth = cssW;
    label.lastCssHeight = cssH;
  }

  update(
    selectedUnits: readonly Entity[],
    selectedBuildings: readonly Entity[],
    frustum?: THREE.Frustum,
    hoveredEntity?: Entity | null,
  ): void {
    // Single-select policy: name labels only show when ONE entity is
    // selected. With sizeAttenuation: false the sprite is a fixed
    // pixel size on screen, so multi-select clusters render their
    // labels stacked on top of each other in screen space — readable
    // for one unit, an unreadable pile for ten. Matches SC2 / AoE /
    // Total War convention: multi-select detail lives in the bottom
    // selection panel, not as floating text.
    const total = selectedUnits.length + selectedBuildings.length;
    const hoverBuilding = hoveredEntity?.building && hoveredEntity.building.hp > 0
      ? hoveredEntity
      : null;
    if (total !== 1 && !hoverBuilding) {
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
    if (total === 1) {
      for (const u of selectedUnits) {
        if (!u.unit || u.unit.hp <= 0) continue;
        const worldX = u.transform.x;
        const worldY = getUnitHudTopY(u) + STYLE.worldOffsetAbove;
        const worldZ = u.transform.y;
        const text = labelTextForUnit(u);
        const label = this.acquire(used++);
        this.repaintIfChanged(label, text);
        label.sprite.scale.set(
          label.lastCssWidth * pxToScale,
          label.lastCssHeight * pxToScale,
          1,
        );
        label.sprite.position.set(worldX, worldY, worldZ);
        if (frustum) {
          probe.set(worldX, worldY, worldZ);
          label.sprite.visible = frustum.containsPoint(probe);
        }
      }
    }

    const paintBuilding = (b: Entity): void => {
      if (!b.building || b.building.hp <= 0) return;
      const worldX = b.transform.x;
      const worldY = getBuildingHudTopY(b) + STYLE.worldOffsetAbove;
      const worldZ = b.transform.y;
      const text = labelTextForBuilding(b);
      const label = this.acquire(used++);
      this.repaintIfChanged(label, text);
      label.sprite.scale.set(
        label.lastCssWidth * pxToScale,
        label.lastCssHeight * pxToScale,
        1,
      );
      label.sprite.position.set(worldX, worldY, worldZ);
      if (frustum) {
        probe.set(worldX, worldY, worldZ);
        label.sprite.visible = frustum.containsPoint(probe);
      }
    };

    if (total === 1) {
      for (const b of selectedBuildings) {
        paintBuilding(b);
      }
    }

    if (hoverBuilding && !hoverBuilding.selectable?.selected) {
      paintBuilding(hoverBuilding);
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
