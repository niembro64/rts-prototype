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
import { getEntityHudAnchorY, getEntityHudBarsBaseGapPx } from './HudAnchor';
import type { HudScreenSpace } from './HudScreenSpace';
import { getResourceFillRatio } from '../sim/buildableHelpers';
import type { Buildable } from '../sim/types';
import { ENTITY_HUD_BAR_STACK_GAP_PX } from '@/config';
import { CanvasSpritePool, type CanvasSpriteSlot } from './CanvasSpritePool';
import {
  SHELL_BAR_COLORS,
  SHELL_BAR_BG_COLOR,
  SHELL_BAR_BG_ALPHA,
  SHELL_BAR_FG_ALPHA,
  SHELL_BAR_PX_HEIGHT,
  SHELL_BAR_PX_WIDTH,
  SHELL_BAR_CANVAS_WIDTH,
  SHELL_BAR_CANVAS_HEIGHT,
  SHELL_BAR_HIDE_AT_FULL,
  HP_BAR_COLOR_HIGH,
  HP_BAR_COLOR_LOW,
  HP_BAR_COLOR_BUILD,
  HP_BAR_LOW_THRESHOLD,
} from '@/shellConfig';

// Bar visuals live in @/shellConfig; sizes + gaps are SCREEN pixels and
// HudScreenSpace rescales each sprite per frame so they're zoom-invariant.
// The vertical anchor + per-blueprint base gap come from HudAnchor.
const STYLE = {
  pxHeight: SHELL_BAR_PX_HEIGHT,
  pxWidth: SHELL_BAR_PX_WIDTH,
  bgColor: SHELL_BAR_BG_COLOR,
  bgAlpha: SHELL_BAR_BG_ALPHA,
  fgColorHigh: HP_BAR_COLOR_HIGH,
  fgColorLow: HP_BAR_COLOR_LOW,
  fgColorBuild: HP_BAR_COLOR_BUILD,
  fgColorEnergy: SHELL_BAR_COLORS.energy,
  fgColorMetal: SHELL_BAR_COLORS.metal,
  fgAlpha: SHELL_BAR_FG_ALPHA,
  stackGapPx: ENTITY_HUD_BAR_STACK_GAP_PX,
  lowThreshold: HP_BAR_LOW_THRESHOLD,
  hideAtFull: SHELL_BAR_HIDE_AT_FULL,
  canvasWidth: SHELL_BAR_CANVAS_WIDTH,
  canvasHeight: SHELL_BAR_CANVAS_HEIGHT,
};

type BarMode =
  | 'healthHigh'
  | 'healthLow'
  | 'build'
  | 'energyBar'
  | 'metalBar';

type BarState = {
  /** Last-baked ratio. The canvas is only repainted when this
   *  changes by more than one texture pixel — one HP point of
   *  variation produces no work most frames. */
  lastRatioPx: number;
  lastMode: BarMode | null;
};

type Bar = CanvasSpriteSlot<BarState>;

function repaintBar(bar: Bar, ratio: number, mode: BarMode): boolean {
  const ratioPx = Math.round(ratio * STYLE.canvasWidth);
  if (bar.state.lastRatioPx === ratioPx && bar.state.lastMode === mode) return false;
  bar.state.lastRatioPx = ratioPx;
  bar.state.lastMode = mode;
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
    mode === 'metalBar' ? STYLE.fgColorMetal :
    STYLE.fgColorHigh;
  ctx.globalAlpha = STYLE.fgAlpha;
  ctx.fillStyle = fg;
  ctx.fillRect(0, 0, ratioPx, h);
  ctx.globalAlpha = 1;
  return true;
}

export class HealthBar3D {
  private pool: CanvasSpritePool<BarState, [number, BarMode]>;

  constructor(parent: THREE.Group) {
    this.pool = new CanvasSpritePool<BarState, [number, BarMode]>({
      parent,
      canvasWidth: STYLE.canvasWidth,
      canvasHeight: STYLE.canvasHeight,
      debugName: 'HealthBar3D',
      makeState: () => ({ lastRatioPx: -1, lastMode: null }),
      repaint: repaintBar,
    });
  }

  /** Acquire (or grow) a pool slot and ensure its sprite is visible. */
  private acquire(i: number): Bar {
    return this.pool.acquire(i);
  }

  /** Repaint the canvas if (mode, ratio) changed; otherwise no-op. */
  private repaintIfChanged(bar: Bar, ratio: number, mode: BarMode): void {
    this.pool.repaintIfChanged(bar, ratio, mode);
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
  /** Per-frame screen-space scaler, set by beginFrame. Drives the
   *  zoom-invariant pixel size + pixel offset of every bar. */
  private _screen: HudScreenSpace | null = null;

  /** Fused-iteration entry: reset frame state. Caller follows with a
   *  series of perUnit / perBuilding calls and finishes with endFrame. */
  beginFrame(screen: HudScreenSpace, frustum?: THREE.Frustum): void {
    this._used = 0;
    this._frameToken = (this._frameToken + 1) & 0x3fffffff;
    // Clear the per-frame dedup map each frame so it stays bounded to
    // entities actually drawn this frame. Previously it only cleared on
    // the ~185-day token rollover, so it retained an entry for every
    // entity id that ever rendered a bar.
    this._seenEntityFrame.clear();
    this._screen = screen;
    this._frustum = frustum ?? null;
  }

  /** Place a single bar `stackIndex` rows up the stack (0 = bottom row)
   *  above the entity's world anchor. Size + the vertical gap are in
   *  screen pixels, converted to world space at the anchor's depth so
   *  they're constant on screen at any zoom. */
  private placeBar(
    ratio: number,
    mode: BarMode,
    anchorX: number,
    anchorY: number,
    anchorZ: number,
    baseGapPx: number,
    stackIndex: number,
  ): void {
    const screen = this._screen;
    if (!screen) return;
    const bar = this.acquire(this._used++);
    this.repaintIfChanged(bar, ratio, mode);
    const centerPx =
      baseGapPx +
      STYLE.pxHeight / 2 +
      stackIndex * (STYLE.pxHeight + STYLE.stackGapPx);
    screen.placeSprite(
      bar.sprite,
      anchorX,
      anchorY,
      anchorZ,
      centerPx,
      STYLE.pxWidth,
      STYLE.pxHeight,
    );
    bar.sprite.visible = this._frustum
      ? this._frustum.containsPoint(bar.sprite.position)
      : true;
  }

  /** Stack the per-resource bars on top of the HP bar when a
   *  buildable is in progress. Construction uses a fixed three-row
   *  layout until completion so full resource rows do not disappear
   *  and visually reflow the remaining bars. Order from the bottom:
   *  HP, energy, metal. Returns the next stack index. */
  private placeResourceBars(
    buildable: Buildable,
    anchorX: number,
    anchorY: number,
    anchorZ: number,
    baseGapPx: number,
    stackStart: number,
  ): number {
    let stack = stackStart;
    const e = getResourceFillRatio(buildable, 'energy');
    this.placeBar(e, 'energyBar', anchorX, anchorY, anchorZ, baseGapPx, stack);
    stack++;
    const t = getResourceFillRatio(buildable, 'metal');
    this.placeBar(t, 'metalBar', anchorX, anchorY, anchorZ, baseGapPx, stack);
    stack++;
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
    const showHp = maxHp > 0 && (
      buildable
        ? true
        : hp > 0 && (forceVisible || !STYLE.hideAtFull || hp < maxHp)
    );
    if (!showHp && !buildable) return;
    this._seenEntityFrame.set(u.id, this._frameToken);
    const anchorX = u.transform.x;
    const anchorY = getEntityHudAnchorY(u);
    const anchorZ = u.transform.y;
    const baseGapPx = getEntityHudBarsBaseGapPx(u);
    let stack = 0;
    if (showHp) {
      const ratio = Math.max(0, Math.min(1, hp / maxHp));
      const mode: BarMode = ratio < STYLE.lowThreshold ? 'healthLow' : 'healthHigh';
      this.placeBar(ratio, mode, anchorX, anchorY, anchorZ, baseGapPx, stack);
      stack++;
    }
    if (buildable) {
      this.placeResourceBars(buildable, anchorX, anchorY, anchorZ, baseGapPx, stack);
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
    const showHp = maxHp > 0 && (
      buildable
        ? true
        : hp > 0 && (forceVisible || !STYLE.hideAtFull || hp < maxHp)
    );
    if (!showHp && !buildable) return;
    this._seenEntityFrame.set(b.id, this._frameToken);
    const anchorX = b.transform.x;
    const anchorY = getEntityHudAnchorY(b);
    const anchorZ = b.transform.y;
    const baseGapPx = getEntityHudBarsBaseGapPx(b);
    let stack = 0;
    if (showHp) {
      // HP is its own thing — green/red by ratio, never the legacy
      // single-bar 'build' color. The user wants the resource
      // bars to be the "build progress", not a combined ratio.
      const ratio = Math.max(0, Math.min(1, hp / maxHp));
      const mode: BarMode = ratio < STYLE.lowThreshold ? 'healthLow' : 'healthHigh';
      this.placeBar(ratio, mode, anchorX, anchorY, anchorZ, baseGapPx, stack);
      stack++;
    }
    if (buildable) {
      this.placeResourceBars(buildable, anchorX, anchorY, anchorZ, baseGapPx, stack);
    }
  }

  /** Fused-iteration entry: hide trailing pool entries past the live
   *  prefix. Sprites stay in the pool ready for the next frame. */
  endFrame(): void {
    this.pool.hideUnused(this._used);
    this._frustum = null;
    this._screen = null;
  }

  destroy(): void {
    this.pool.destroy();
  }
}
