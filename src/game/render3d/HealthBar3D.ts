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
import type { Entity, Turret } from '../sim/types';
import {
  getBuildingHudBarsY,
  getUnitHudBarsY,
  getTurretHudBarsY,
  getLocomotionHudBarsY,
  getShotHudBarsY,
} from './HudAnchor';
import {
  getResourceFillRatio,
  getPieceFillRatio,
  getConstructionPieceRecord,
  isBuildInProgress,
} from '../sim/buildableHelpers';
import { getTurretHeadRadius } from '../math';
import type { Buildable, ConstructionPieceBuildRecord } from '../sim/types';
import { ENTITY_HUD_BAR_STACK_GAP } from '@/config';
import { CanvasSpritePool, type CanvasSpriteSlot } from './CanvasSpritePool';
import { FADE_CULL_ALPHA, type HudFade } from './HudFade';
import {
  SHELL_BAR_COLORS,
  SHELL_BAR_BG_COLOR,
  SHELL_BAR_BG_ALPHA,
  SHELL_BAR_FG_ALPHA,
  SHELL_BAR_WORLD_HEIGHT,
  SHELL_BAR_CANVAS_WIDTH,
  SHELL_BAR_CANVAS_HEIGHT,
  SHELL_BAR_HIDE_AT_FULL,
  HP_BAR_COLOR_BUILD,
} from '@/shellConfig';

// Bars are world-scaled (they foreshorten with zoom) and fade out by
// camera distance — the "BAR" model. Visuals live in @/shellConfig;
// vertical placement lives in the unit/building blueprint `hud` blocks
// read by HudAnchor.
const STYLE = {
  worldHeight: SHELL_BAR_WORLD_HEIGHT,
  bgColor: SHELL_BAR_BG_COLOR,
  bgAlpha: SHELL_BAR_BG_ALPHA,
  fgColorBuild: HP_BAR_COLOR_BUILD,
  fgColorEnergy: SHELL_BAR_COLORS.energy,
  fgColorMetal: SHELL_BAR_COLORS.metal,
  fgAlpha: SHELL_BAR_FG_ALPHA,
  worldStackGap: ENTITY_HUD_BAR_STACK_GAP,
  hideAtFull: SHELL_BAR_HIDE_AT_FULL,
  canvasWidth: SHELL_BAR_CANVAS_WIDTH,
  canvasHeight: SHELL_BAR_CANVAS_HEIGHT,
};

type BarMode =
  | 'health'
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

// Packed per-piece dedup keys. A host's body bar + N turret bars + the
// locomotion bar all share one host entity id, so a single id-keyed
// dedup map would let the body call suppress every sub-piece. Pack the
// piece identity into the key: hostId * 256 + pieceTag. Tag 0 = body,
// tag 1 = locomotion, tags 16.. = turret index (matching the
// TurretMountCache3D packTurretMountKey scheme, offset to avoid
// colliding with body/loco low tags).
export const PIECE_TAG_BODY = 0;
export const PIECE_TAG_LOCOMOTION = 1;
export const PIECE_TAG_TURRET_BASE = 16;

/** Tag for turret index `i`. Offset past the body/loco low tags so
 *  turret tags never collide with them; mirrors the
 *  TurretMountCache3D packTurretMountKey idea (id * 256 + slot). */
export function turretPieceTag(turretIdx: number): number {
  return PIECE_TAG_TURRET_BASE + (turretIdx & 0xff);
}

export function packPieceKey(hostId: number, pieceTag: number): number {
  return hostId * 256 + (pieceTag & 0xff);
}

/** BAR-style HP color: red (0) → green (1), then normalize the brighter
 *  channel to full so mid-health reads as vivid yellow/orange instead of
 *  a muddy half-mix (mirrors BAR's bitColorCorrect). */
function healthGradientColor(ratio: number): string {
  const r = 1 - ratio;
  const g = ratio;
  const m = Math.max(r, g, 1e-4);
  const R = Math.round((r / m) * 255);
  const G = Math.round((g / m) * 255);
  return `rgb(${R}, ${G}, 0)`;
}

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
    mode === 'health' ? healthGradientColor(ratio) :
    mode === 'build' ? STYLE.fgColorBuild :
    mode === 'energyBar' ? STYLE.fgColorEnergy :
    STYLE.fgColorMetal;
  ctx.globalAlpha = STYLE.fgAlpha;
  ctx.fillStyle = fg;
  ctx.fillRect(0, 0, ratioPx, h);
  ctx.globalAlpha = 1;
  return true;
}

export class HealthBar3D {
  /** Module-shared scratch vector reused by every frustum probe so
   *  the per-frame loop allocates nothing. */
  private static readonly _probeVec = new THREE.Vector3();

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
  /** Per-frame camera-distance fade, set by beginFrame. Drives the
   *  zoom-out fade + cull and per-sprite opacity. */
  private _fade: HudFade | null = null;

  /** Fused-iteration entry: reset frame state. Caller follows with a
   *  series of perUnit / perBuilding calls and finishes with endFrame. */
  beginFrame(fade: HudFade, frustum?: THREE.Frustum): void {
    this._used = 0;
    this._frameToken = (this._frameToken + 1) & 0x3fffffff;
    // Clear the per-frame dedup map each frame so it stays bounded to
    // entities actually drawn this frame. Previously it only cleared on
    // the ~185-day token rollover, so it retained an entry for every
    // entity id that ever rendered a bar.
    this._seenEntityFrame.clear();
    this._fade = fade;
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
    alpha: number,
  ): void {
    const bar = this.acquire(this._used++);
    this.repaintIfChanged(bar, ratio, mode);
    const yOffset = stackIndex * (STYLE.worldHeight + STYLE.worldStackGap);
    bar.sprite.scale.set(worldWidth, STYLE.worldHeight, 1);
    bar.sprite.position.set(worldX, worldBaseY + yOffset, worldZ);
    bar.material.opacity = alpha;
    if (this._frustum) {
      const probe = HealthBar3D._probeVec;
      probe.set(worldX, worldBaseY + yOffset, worldZ);
      bar.sprite.visible = this._frustum.containsPoint(probe);
    } else {
      bar.sprite.visible = true;
    }
  }

  /** Stack the per-resource bars on top of the HP bar when a
   *  buildable is in progress. Construction uses a fixed three-row
   *  layout until completion so full resource rows do not disappear
   *  and visually reflow the remaining bars. Order from the bottom:
   *  HP, energy, metal. Returns the next stack index. */
  private placeResourceBars(
    buildable: Buildable,
    worldX: number,
    worldBaseY: number,
    worldZ: number,
    worldWidth: number,
    stackStart: number,
    alpha: number,
  ): number {
    let stack = stackStart;
    const e = getResourceFillRatio(buildable, 'energy');
    this.placeBar(e, 'energyBar', worldX, worldBaseY, worldZ, worldWidth, stack, alpha);
    stack++;
    const t = getResourceFillRatio(buildable, 'metal');
    this.placeBar(t, 'metalBar', worldX, worldBaseY, worldZ, worldWidth, stack, alpha);
    stack++;
    return stack;
  }

  /** Fused-iteration entry: process one unit's BODY bars. Caller's
   *  outer loop walks the HUD entity list once and dispatches here (and
   *  to other per-unit renderers like ShieldRenderer3D).
   *
   *  `showHealth` / `showResources` are the orchestrator's per-element
   *  config decision (per-type toggle + selection mode + not-full rule
   *  already applied). `forceVisible` (hover) forces the HEALTH bar on
   *  regardless of the not-full rule, matching the legacy behavior. */
  perUnit(
    u: Entity,
    forceVisible = false,
    showHealth = true,
    showResources = true,
  ): void {
    if (!u.unit) return;
    const key = packPieceKey(u.id, PIECE_TAG_BODY);
    if (this._seenEntityFrame.get(key) === this._frameToken) return;
    const unit = u.unit;
    const hp = unit.hp;
    const maxHp = unit.maxHp;
    const buildable = isBuildInProgress(u.buildable)
      ? u.buildable
      : null;
    const showHp = maxHp > 0 && (showHealth || forceVisible)
      && (buildable !== null || hp > 0);
    const showRes = showResources && buildable !== null;
    if (!showHp && !showRes) return;
    this._seenEntityFrame.set(key, this._frameToken);
    const worldX = u.transform.x;
    const worldY = getUnitHudBarsY(u);
    const worldZ = u.transform.y;
    const alpha = this._fade ? this._fade.alphaAt(worldX, worldY, worldZ) : 1;
    if (alpha <= FADE_CULL_ALPHA) return;
    const worldWidth = unit.radius.visual * 2;
    let stack = 0;
    if (showHp) {
      const ratio = Math.max(0, Math.min(1, hp / maxHp));
      this.placeBar(ratio, 'health', worldX, worldY, worldZ, worldWidth, stack, alpha);
      stack++;
    }
    if (showRes && buildable) {
      this.placeResourceBars(buildable, worldX, worldY, worldZ, worldWidth, stack, alpha);
    }
  }

  /** Fused-iteration entry: process one building's BODY bars. */
  perBuilding(
    b: Entity,
    forceVisible = false,
    showHealth = true,
    showResources = true,
  ): void {
    if (!b.building) return;
    const key = packPieceKey(b.id, PIECE_TAG_BODY);
    if (this._seenEntityFrame.get(key) === this._frameToken) return;
    const hp = b.building.hp;
    const maxHp = b.building.maxHp;
    const buildable = isBuildInProgress(b.buildable)
      ? b.buildable
      : null;
    const showHp = maxHp > 0 && (showHealth || forceVisible)
      && (buildable !== null || hp > 0);
    const showRes = showResources && buildable !== null;
    if (!showHp && !showRes) return;
    this._seenEntityFrame.set(key, this._frameToken);
    const worldX = b.transform.x;
    const worldY = getBuildingHudBarsY(b);
    const worldZ = b.transform.y;
    const alpha = this._fade ? this._fade.alphaAt(worldX, worldY, worldZ) : 1;
    if (alpha <= FADE_CULL_ALPHA) return;
    const worldWidth = b.building.width;
    let stack = 0;
    if (showHp) {
      // HP is its own thing — a red→green gradient by ratio, never the
      // resource 'build' color. The resource bars are the build progress.
      const ratio = Math.max(0, Math.min(1, hp / maxHp));
      this.placeBar(ratio, 'health', worldX, worldY, worldZ, worldWidth, stack, alpha);
      stack++;
    }
    if (showRes && buildable) {
      this.placeResourceBars(buildable, worldX, worldY, worldZ, worldWidth, stack, alpha);
    }
  }

  /** Place a piece's energy/metal bars from its construction record's
   *  paid/required (absent → not building → skipped by the caller).
   *  Mirrors `placeResourceBars` but reads the per-piece ledger. */
  private placePieceResourceBars(
    piece: ConstructionPieceBuildRecord,
    worldX: number,
    worldBaseY: number,
    worldZ: number,
    worldWidth: number,
    stackStart: number,
    alpha: number,
  ): void {
    let stack = stackStart;
    this.placeBar(
      getPieceFillRatio(piece, 'energy'),
      'energyBar', worldX, worldBaseY, worldZ, worldWidth, stack, alpha,
    );
    stack++;
    this.placeBar(
      getPieceFillRatio(piece, 'metal'),
      'metalBar', worldX, worldBaseY, worldZ, worldWidth, stack, alpha,
    );
  }

  /** Fused-iteration entry: one turret's HP (+ resource) bars at its
   *  live world mount anchor. `mountWorld` is the TurretMountCache3D
   *  entry (transform.x = world X, .y = world Y/north, .z = world up).
   *  Resource bars come from the host's matching construction piece
   *  record (only present while building). */
  perTurret(
    host: Entity,
    turretIdx: number,
    mountWorld: { x: number; y: number; z: number },
    forceVisible: boolean,
    showHealth: boolean,
    showResources: boolean,
  ): void {
    const turret: Turret | undefined = host.combat?.turrets[turretIdx];
    if (!turret) return;
    const key = packPieceKey(host.id, turretPieceTag(turretIdx));
    if (this._seenEntityFrame.get(key) === this._frameToken) return;
    const hp = turret.hp;
    const maxHp = turret.maxHp;
    const piece = showResources
      ? getConstructionPieceRecord(host, 'turret', turret.mountIndex)
      : null;
    const showHp = maxHp > 0 && (showHealth || forceVisible) && hp > 0;
    const showRes = piece !== null;
    if (!showHp && !showRes) return;
    // Cull before acquiring a pool slot — the pool grows monotonically.
    const worldX = mountWorld.x;
    const worldY = getTurretHudBarsY(mountWorld.z, turret.config);
    const worldZ = mountWorld.y;
    const alpha = this._fade ? this._fade.alphaAt(worldX, worldY, worldZ) : 1;
    if (alpha <= FADE_CULL_ALPHA) return;
    this._seenEntityFrame.set(key, this._frameToken);
    const worldWidth = getTurretHeadRadius(turret.config) * 2;
    let stack = 0;
    if (showHp) {
      const ratio = Math.max(0, Math.min(1, hp / maxHp));
      this.placeBar(ratio, 'health', worldX, worldY, worldZ, worldWidth, stack, alpha);
      stack++;
    }
    if (showRes && piece) {
      this.placePieceResourceBars(piece, worldX, worldY, worldZ, worldWidth, stack, alpha);
    }
  }

  /** Fused-iteration entry: one unit's locomotion HP (+ resource) bars,
   *  anchored LOW at the body base (below the body stack). */
  perLocomotion(
    host: Entity,
    forceVisible: boolean,
    showHealth: boolean,
    showResources: boolean,
  ): void {
    const loco = host.unit?.locomotion;
    if (!loco) return;
    const key = packPieceKey(host.id, PIECE_TAG_LOCOMOTION);
    if (this._seenEntityFrame.get(key) === this._frameToken) return;
    const hp = loco.hp;
    const maxHp = loco.maxHp;
    const piece = showResources
      ? getConstructionPieceRecord(host, 'locomotion', 0)
      : null;
    const showHp = maxHp > 0 && (showHealth || forceVisible) && hp > 0;
    const showRes = piece !== null;
    if (!showHp && !showRes) return;
    const worldX = host.transform.x;
    const worldY = getLocomotionHudBarsY(host);
    const worldZ = host.transform.y;
    const alpha = this._fade ? this._fade.alphaAt(worldX, worldY, worldZ) : 1;
    if (alpha <= FADE_CULL_ALPHA) return;
    this._seenEntityFrame.set(key, this._frameToken);
    const worldWidth = loco.radius.visual * 2;
    let stack = 0;
    if (showHp) {
      const ratio = Math.max(0, Math.min(1, hp / maxHp));
      this.placeBar(ratio, 'health', worldX, worldY, worldZ, worldWidth, stack, alpha);
      stack++;
    }
    if (showRes && piece) {
      this.placePieceResourceBars(piece, worldX, worldY, worldZ, worldWidth, stack, alpha);
    }
  }

  /** Fused-iteration entry: one projectile-kind shot's tiny HP bar
   *  (no resource bars). Anchored at the shot transform. */
  perShot(shot: Entity, forceVisible: boolean, showHealth: boolean): void {
    const proj = shot.projectile;
    if (!proj) return;
    const key = packPieceKey(shot.id, PIECE_TAG_BODY);
    if (this._seenEntityFrame.get(key) === this._frameToken) return;
    const hp = proj.hp;
    const maxHp = proj.maxHp;
    const showHp = maxHp > 0 && (showHealth || forceVisible) && hp > 0
      && (forceVisible || hp < maxHp);
    if (!showHp) return;
    const worldX = shot.transform.x;
    const worldY = getShotHudBarsY(shot);
    const worldZ = shot.transform.y;
    const alpha = this._fade ? this._fade.alphaAt(worldX, worldY, worldZ) : 1;
    if (alpha <= FADE_CULL_ALPHA) return;
    this._seenEntityFrame.set(key, this._frameToken);
    const worldWidth = proj.config.shotProfile.runtime.radius.visual * 2;
    const ratio = Math.max(0, Math.min(1, hp / maxHp));
    this.placeBar(ratio, 'health', worldX, worldY, worldZ, worldWidth, 0, alpha);
  }

  /** Fused-iteration entry: hide trailing pool entries past the live
   *  prefix. Sprites stay in the pool ready for the next frame. */
  endFrame(): void {
    this.pool.hideUnused(this._used);
    this._frustum = null;
    this._fade = null;
  }

  destroy(): void {
    this.pool.destroy();
  }
}
