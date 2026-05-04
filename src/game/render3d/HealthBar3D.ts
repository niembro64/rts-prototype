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
import { getResourceFillRatio } from '../sim/buildableHelpers';
import type { Buildable } from '../sim/types';

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
  /** Per-resource build-bar tints. Each of the three resources fills
   *  independently, so the user can see at a glance which axis is
   *  starved (the slow bar). */
  fgColorEnergy: '#f5d442',
  fgColorMana: '#7ad7ff',
  fgColorMetal: '#d09060',
  fgAlpha: 0.9,
  /** Vertical separation between stacked bars (HP + 3 resource bars
   *  during construction). Just above STYLE.worldHeight so they don't
   *  visually merge. */
  worldStackGap: 5,
  /** Below this HP fraction, switch to the low-health color. */
  lowThreshold: 0.3,
  /** Hide the bar entirely at full HP. */
  hideAtFull: true,
  /** Texture canvas resolution. 128×16 keeps the per-sprite memory
   *  small while remaining crisp at typical zooms. */
  canvasWidth: 128,
  canvasHeight: 16,
};

type BarMode =
  | 'healthHigh'
  | 'healthLow'
  | 'build'
  | 'energyBar'
  | 'manaBar'
  | 'metalBar';

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
      mode === 'energyBar' ? STYLE.fgColorEnergy :
      mode === 'manaBar' ? STYLE.fgColorMana :
      mode === 'metalBar' ? STYLE.fgColorMetal :
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
  private _seenEntityFrame = new Map<number, number>();
  private _frameToken = 0;
  /** Optional frustum reference set per frame by the caller — null
   *  disables sprite-visibility frustum culling (every visible bar
   *  draws). Stored on the instance so perUnit / perBuilding don't
   *  have to re-thread it through arguments. */
  private _frustum: THREE.Frustum | null = null;

  /** Fused-iteration entry: reset frame state. Caller follows with a
   *  series of perUnit / perBuilding calls and finishes with endFrame. */
  beginFrame(frustum?: THREE.Frustum): void {
    this._used = 0;
    this._frameToken = (this._frameToken + 1) & 0x3fffffff;
    if (this._frameToken === 0) {
      this._seenEntityFrame.clear();
      this._frameToken = 1;
    }
    this._frustum = frustum ?? null;
  }

  /** Place a single bar at a given world position with `stackIndex`
   *  vertical offset (0 = bottom row). Returns true if drawn. */
  private placeBar(
    ratio: number,
    mode: BarMode,
    worldX: number,
    worldBaseY: number,
    worldZ: number,
    worldWidth: number,
    stackIndex: number,
  ): void {
    const bar = this.acquire(this._used++);
    this.repaintIfChanged(bar, ratio, mode);
    const yOffset = stackIndex * (STYLE.worldHeight + STYLE.worldStackGap);
    bar.sprite.scale.set(worldWidth, STYLE.worldHeight, 1);
    bar.sprite.position.set(worldX, worldBaseY + yOffset, worldZ);
    if (this._frustum) {
      const probe = HealthBar3D._probeVec;
      probe.set(worldX, worldBaseY + yOffset, worldZ);
      bar.sprite.visible = this._frustum.containsPoint(probe);
    } else {
      bar.sprite.visible = true;
    }
  }

  /** Stack the three per-resource bars on top of the HP bar when a
   *  buildable is in progress. Each bar is shown ONLY if its value
   *  is below 100% — same rule as the legacy health bar. Order from
   *  the bottom: HP, energy, mana, metal. Returns the next stack
   *  index (1 + the highest index used). */
  private placeResourceBars(
    buildable: Buildable,
    worldX: number,
    worldBaseY: number,
    worldZ: number,
    worldWidth: number,
    stackStart: number,
  ): number {
    let stack = stackStart;
    const e = getResourceFillRatio(buildable, 'energy');
    if (e < 1) {
      this.placeBar(e, 'energyBar', worldX, worldBaseY, worldZ, worldWidth, stack);
      stack++;
    }
    const m = getResourceFillRatio(buildable, 'mana');
    if (m < 1) {
      this.placeBar(m, 'manaBar', worldX, worldBaseY, worldZ, worldWidth, stack);
      stack++;
    }
    const t = getResourceFillRatio(buildable, 'metal');
    if (t < 1) {
      this.placeBar(t, 'metalBar', worldX, worldBaseY, worldZ, worldWidth, stack);
      stack++;
    }
    return stack;
  }

  /** Fused-iteration entry: process one unit. Caller's outer loop
   *  walks `getUnits()` once and dispatches here (and to other
   *  per-unit renderers like ForceFieldRenderer3D). */
  perUnit(u: Entity, forceVisible = false): void {
    if (!u.unit) return;
    if (this._seenEntityFrame.get(u.id) === this._frameToken) return;
    const unit = u.unit;
    const hp = unit.hp;
    const maxHp = unit.maxHp;
    const buildable = u.buildable && !u.buildable.isComplete && !u.buildable.isGhost
      ? u.buildable
      : null;
    const showHp = hp > 0 && (forceVisible || !STYLE.hideAtFull || hp < maxHp);
    if (!showHp && !buildable) return;
    this._seenEntityFrame.set(u.id, this._frameToken);
    const worldX = u.transform.x;
    const worldY = getUnitHudTopY(u) + STYLE.worldOffsetAbove;
    const worldZ = u.transform.y;
    const worldWidth = unit.bodyRadius * 2;
    let stack = 0;
    if (showHp) {
      const ratio = Math.max(0, Math.min(1, hp / maxHp));
      const mode: BarMode = ratio < STYLE.lowThreshold ? 'healthLow' : 'healthHigh';
      this.placeBar(ratio, mode, worldX, worldY, worldZ, worldWidth, stack);
      stack++;
    }
    if (buildable) {
      this.placeResourceBars(buildable, worldX, worldY, worldZ, worldWidth, stack);
    }
  }

  /** Fused-iteration entry: process one building. */
  perBuilding(b: Entity, forceVisible = false): void {
    if (!b.building) return;
    if (this._seenEntityFrame.get(b.id) === this._frameToken) return;
    const hp = b.building.hp;
    const maxHp = b.building.maxHp;
    const buildable = b.buildable && !b.buildable.isComplete && !b.buildable.isGhost
      ? b.buildable
      : null;
    const showHp = hp > 0 && (forceVisible || !STYLE.hideAtFull || hp < maxHp);
    if (!showHp && !buildable) return;
    this._seenEntityFrame.set(b.id, this._frameToken);
    const worldX = b.transform.x;
    const worldY = getBuildingHudTopY(b) + STYLE.worldOffsetAbove;
    const worldZ = b.transform.y;
    const worldWidth = b.building.width;
    let stack = 0;
    if (showHp) {
      const ratio = Math.max(0, Math.min(1, hp / maxHp));
      const mode: BarMode = buildable
        ? 'build'
        : ratio < STYLE.lowThreshold
          ? 'healthLow'
          : 'healthHigh';
      this.placeBar(ratio, mode, worldX, worldY, worldZ, worldWidth, stack);
      stack++;
    }
    if (buildable) {
      this.placeResourceBars(buildable, worldX, worldY, worldZ, worldWidth, stack);
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
