// HealthBar3D — billboarded HP / build-progress bars in the 3D scene.
//
// One pooled THREE.Sprite per visible bar. Each sprite has a tiny
// CanvasTexture that's rebaked only when the displayed ratio or
// color mode changes — every other frame the per-sprite work is
// just a position update. Sprites auto-billboard (they always face
// the camera) and pass through the depth buffer like any other
// scene mesh, so a unit on the far side of a hill has its bar
// naturally clipped — no separate occlusion test, no SVG overlay,
// no per-unit raycast on the CPU.

import * as THREE from 'three';
import type { Entity } from '../sim/types';
import { getBuildingHudTopY, getUnitHudTopY } from './HudAnchor';

const STYLE = {
  /** Height of the bar in world units. The bar's WIDTH is keyed to
   *  the entity's render radius so a bigger unit gets a bigger bar
   *  — same convention the old SVG overlay used in screen space. */
  worldHeight: 4,
  /** Distance above the entity's top in world units where the bar
   *  centerline sits. */
  worldOffsetAbove: 12,
  bgColor: '#333333',
  bgAlpha: 0.8,
  fgColorHigh: '#44dd44',
  fgColorLow: '#ff4444',
  fgColorBuild: '#4488ff',
  fgAlpha: 0.9,
  /** Below this HP fraction, switch to the low-health color. */
  lowThreshold: 0.3,
  /** Hide the bar entirely at full HP. */
  hideAtFull: true,
  /** Texture canvas resolution. 128×16 keeps the per-sprite memory
   *  small while remaining crisp at typical zooms. */
  canvasWidth: 128,
  canvasHeight: 16,
};

type BarMode = 'healthHigh' | 'healthLow' | 'build';

type Bar = {
  sprite: THREE.Sprite;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  material: THREE.SpriteMaterial;
  /** Last-baked ratio. The canvas is only repainted when this
   *  changes by more than one texture pixel — one HP point of
   *  variation produces no work most frames. */
  lastRatioPx: number;
  lastMode: BarMode | null;
};

export class HealthBar3D {
  /** Module-shared scratch vector reused by every frustum probe so
   *  the per-frame loop allocates nothing. */
  private static readonly _probeVec = new THREE.Vector3();

  private parent: THREE.Group;
  private pool: Bar[] = [];

  constructor(parent: THREE.Group) {
    this.parent = parent;
  }

  /** Acquire (or grow) a pool slot and ensure its sprite is visible. */
  private acquire(i: number): Bar {
    let bar = this.pool[i];
    if (!bar) {
      const canvas = document.createElement('canvas');
      canvas.width = STYLE.canvasWidth;
      canvas.height = STYLE.canvasHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('HealthBar3D: 2d canvas context unavailable');
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
      bar = { sprite, canvas, ctx, texture, material, lastRatioPx: -1, lastMode: null };
      this.pool.push(bar);
    }
    bar.sprite.visible = true;
    return bar;
  }

  /** Repaint the canvas if (mode, ratio) changed; otherwise no-op. */
  private repaintIfChanged(bar: Bar, ratio: number, mode: BarMode): void {
    const ratioPx = Math.round(ratio * STYLE.canvasWidth);
    if (bar.lastRatioPx === ratioPx && bar.lastMode === mode) return;
    bar.lastRatioPx = ratioPx;
    bar.lastMode = mode;
    const ctx = bar.ctx;
    const w = STYLE.canvasWidth;
    const h = STYLE.canvasHeight;
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = STYLE.bgAlpha;
    ctx.fillStyle = STYLE.bgColor;
    ctx.fillRect(0, 0, w, h);
    const fg =
      mode === 'build' ? STYLE.fgColorBuild :
      mode === 'healthLow' ? STYLE.fgColorLow :
      STYLE.fgColorHigh;
    ctx.globalAlpha = STYLE.fgAlpha;
    ctx.fillStyle = fg;
    ctx.fillRect(0, 0, ratioPx, h);
    ctx.globalAlpha = 1;
    bar.texture.needsUpdate = true;
  }

  /** Frame-state cursor. The fused-iteration entry points (beginFrame /
   *  perUnit / perBuilding / endFrame) advance this in sequence, so
   *  callers walking units + buildings together can interleave the
   *  per-entity calls in any order they like. The legacy `update`
   *  wrapper still exists for callers that want the all-in-one form. */
  private _used = 0;
  /** Optional frustum reference set per frame by the caller — null
   *  disables sprite-visibility frustum culling (every visible bar
   *  draws). Stored on the instance so perUnit / perBuilding don't
   *  have to re-thread it through arguments. */
  private _frustum: THREE.Frustum | null = null;

  /** Fused-iteration entry: reset frame state. Caller follows with a
   *  series of perUnit / perBuilding calls and finishes with endFrame. */
  beginFrame(frustum?: THREE.Frustum): void {
    this._used = 0;
    this._frustum = frustum ?? null;
  }

  /** Fused-iteration entry: process one unit. Caller's outer loop
   *  walks `getUnits()` once and dispatches here (and to other
   *  per-unit renderers like ForceFieldRenderer3D). */
  perUnit(u: Entity, forceVisible = false): void {
    if (!u.unit) return;
    const hp = u.unit.hp;
    const maxHp = u.unit.maxHp;
    if (hp <= 0 || (!forceVisible && STYLE.hideAtFull && hp >= maxHp)) return;
    const worldX = u.transform.x;
    const worldY = getUnitHudTopY(u) + STYLE.worldOffsetAbove;
    const worldZ = u.transform.y;
    const ratio = Math.max(0, Math.min(1, hp / maxHp));
    const mode: BarMode = ratio < STYLE.lowThreshold ? 'healthLow' : 'healthHigh';
    const bar = this.acquire(this._used++);
    this.repaintIfChanged(bar, ratio, mode);

    const worldWidth = u.unit.unitRadiusCollider.scale * 2;
    bar.sprite.scale.set(worldWidth, STYLE.worldHeight, 1);
    bar.sprite.position.set(worldX, worldY, worldZ);
    if (this._frustum) {
      const probe = HealthBar3D._probeVec;
      probe.set(worldX, worldY, worldZ);
      bar.sprite.visible = this._frustum.containsPoint(probe);
    } else {
      bar.sprite.visible = true;
    }
  }

  /** Fused-iteration entry: process one building. */
  perBuilding(b: Entity, forceVisible = false): void {
    if (!b.building) return;
    let ratio: number;
    let mode: BarMode;
    if (b.buildable && !b.buildable.isComplete) {
      ratio = Math.max(0, Math.min(1, b.buildable.buildProgress));
      mode = 'build';
    } else {
      const hp = b.building.hp;
      const maxHp = b.building.maxHp;
      if (hp <= 0 || (!forceVisible && STYLE.hideAtFull && hp >= maxHp)) return;
      ratio = Math.max(0, Math.min(1, hp / maxHp));
      mode = ratio < STYLE.lowThreshold ? 'healthLow' : 'healthHigh';
    }
    const worldX = b.transform.x;
    const worldY = getBuildingHudTopY(b) + STYLE.worldOffsetAbove;
    const worldZ = b.transform.y;
    const bar = this.acquire(this._used++);
    this.repaintIfChanged(bar, ratio, mode);

    const worldWidth = b.building.width;
    bar.sprite.scale.set(worldWidth, STYLE.worldHeight, 1);
    bar.sprite.position.set(worldX, worldY, worldZ);
    if (this._frustum) {
      const probe = HealthBar3D._probeVec;
      probe.set(worldX, worldY, worldZ);
      bar.sprite.visible = this._frustum.containsPoint(probe);
    } else {
      bar.sprite.visible = true;
    }
  }

  /** Fused-iteration entry: hide trailing pool entries past the live
   *  prefix. Sprites stay in the pool ready for the next frame. */
  endFrame(): void {
    for (let i = this._used; i < this.pool.length; i++) {
      this.pool[i].sprite.visible = false;
    }
    this._frustum = null;
  }

  /** Legacy all-in-one entry — calls the fused-iteration methods
   *  internally so the behaviour matches the begin/per/end path
   *  exactly. Kept for callers not yet migrated to the fused API. */
  update(
    units: readonly Entity[],
    buildings: readonly Entity[],
    frustum?: THREE.Frustum,
  ): void {
    this.beginFrame(frustum);
    for (const u of units) this.perUnit(u);
    for (const b of buildings) this.perBuilding(b);
    this.endFrame();
  }

  destroy(): void {
    for (const bar of this.pool) {
      this.parent.remove(bar.sprite);
      bar.texture.dispose();
      bar.material.dispose();
    }
    this.pool.length = 0;
  }
}
