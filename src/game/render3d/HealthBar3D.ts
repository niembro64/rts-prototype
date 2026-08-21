// HealthBar3D — billboarded HP bars in the 3D scene.
//
// One pooled THREE.Sprite per visible bar. Each sprite has a tiny
// CanvasTexture that's rebaked only when the displayed ratio
// changes — every other frame the per-sprite work is
// just a position update. Sprites auto-billboard (they always face
// the camera) and pass through the depth buffer like any other
// scene mesh, so a unit on the far side of a hill has its bar
// naturally clipped — no separate occlusion test, no SVG overlay,
// no per-unit raycast on the CPU.
//
// HEALTH is the only lane. The per-entity energy/metal construction
// bars were removed deliberately: entity-level resource readouts are
// gone from the game, and the player-level economy HUD is the one
// place resources are shown.

import * as THREE from 'three';
import {
  CanvasSpritePool,
  type CanvasSpritePoolTelemetry,
  type CanvasSpriteSlot,
} from './CanvasSpritePool';
import { FADE_CULL_ALPHA, type HudFade } from './HudFade';
import {
  growFloat32Array,
  growFloat64Array,
} from './RenderUtils';
import {
  SHELL_BAR_BG_COLOR,
  SHELL_BAR_BG_ALPHA,
  SHELL_BAR_FG_ALPHA,
  SHELL_BAR_WORLD_HEIGHT,
  SHELL_BAR_CANVAS_WIDTH,
  SHELL_BAR_CANVAS_HEIGHT,
  SHELL_BAR_HIDE_AT_FULL,
} from '@/shellConfig';

// Bars are world-scaled (they foreshorten with zoom) and fade out by
// camera distance — the "BAR" model. Visuals live in @/shellConfig;
// vertical placement lives in the unit/building blueprint `hud` blocks
// read by HudAnchor.
const STYLE = {
  worldHeight: SHELL_BAR_WORLD_HEIGHT,
  bgColor: SHELL_BAR_BG_COLOR,
  bgAlpha: SHELL_BAR_BG_ALPHA,
  fgAlpha: SHELL_BAR_FG_ALPHA,
  hideAtFull: SHELL_BAR_HIDE_AT_FULL,
  canvasWidth: SHELL_BAR_CANVAS_WIDTH,
  canvasHeight: SHELL_BAR_CANVAS_HEIGHT,
};

const BODY_HUD_PACKET_INITIAL_CAP = 1024;
const HEALTH_BAR_MAX_RETAINED_SPRITES = 768;
const HEALTH_BAR_SHRINK_COOLDOWN_FRAMES = 90;
const HEALTH_BAR_SHRINK_BATCH_SIZE = 128;

export class BodyHudRenderPacket3D {
  ids: Float64Array = new Float64Array(BODY_HUD_PACKET_INITIAL_CAP);
  x: Float32Array = new Float32Array(BODY_HUD_PACKET_INITIAL_CAP);
  y: Float32Array = new Float32Array(BODY_HUD_PACKET_INITIAL_CAP);
  z: Float32Array = new Float32Array(BODY_HUD_PACKET_INITIAL_CAP);
  width: Float32Array = new Float32Array(BODY_HUD_PACKET_INITIAL_CAP);
  healthRatio: Float32Array = new Float32Array(BODY_HUD_PACKET_INITIAL_CAP);
  count = 0;

  reset(): void {
    this.count = 0;
  }

  /** One row = one visible HEALTH bar. Visibility is the pusher's decision
   *  (per-type toggle, selection mode, not-full rule, hover) — a row that
   *  reaches the packet always draws. */
  pushRow(
    entityId: number,
    x: number,
    y: number,
    z: number,
    width: number,
    healthRatio: number,
  ): void {
    const cursor = this.count;
    this.ensureCapacity(cursor + 1);
    this.ids[cursor] = entityId;
    this.x[cursor] = x;
    this.y[cursor] = y;
    this.z[cursor] = z;
    this.width[cursor] = width;
    this.healthRatio[cursor] = Math.max(0, Math.min(1, healthRatio));
    this.count = cursor + 1;
  }

  private ensureCapacity(required: number): void {
    if (required <= this.ids.length) return;
    let nextCapacity = this.ids.length;
    while (nextCapacity < required) nextCapacity *= 2;
    this.ids = growFloat64Array(this.ids, nextCapacity);
    this.x = growFloat32Array(this.x, nextCapacity);
    this.y = growFloat32Array(this.y, nextCapacity);
    this.z = growFloat32Array(this.z, nextCapacity);
    this.width = growFloat32Array(this.width, nextCapacity);
    this.healthRatio = growFloat32Array(this.healthRatio, nextCapacity);
  }
}

type BarState = {
  /** Last-baked ratio. The canvas is only repainted when this
   *  changes by more than one texture pixel — one HP point of
   *  variation produces no work most frames. */
  lastRatioPx: number;
  lastX: number;
  lastY: number;
  lastZ: number;
  lastWidth: number;
  lastAlpha: number;
};

type Bar = CanvasSpriteSlot<BarState>;

// Packed per-piece dedup keys. A host's body bar + N turret bars + the
// turret bars all share one host entity id, so a single id-keyed
// dedup map would let the body call suppress every sub-piece. Pack the
// piece identity into the key: hostId * 256 + pieceTag. Tag 0 = body,
// tags 16.. = turret index (matching the TurretMountCache3D
// packTurretMountKey scheme, offset to avoid colliding with the body tag).
export const PIECE_TAG_BODY = 0;
export const PIECE_TAG_TURRET_BASE = 16;

/** Tag for turret index `i`. Offset past the body tag so
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

function repaintBar(bar: Bar, ratio: number): boolean {
  const ratioPx = Math.round(ratio * STYLE.canvasWidth);
  if (bar.state.lastRatioPx === ratioPx) return false;
  bar.state.lastRatioPx = ratioPx;
  const ctx = bar.ctx;
  const w = STYLE.canvasWidth;
  const h = STYLE.canvasHeight;
  ctx.clearRect(0, 0, w, h);
  ctx.globalAlpha = STYLE.bgAlpha;
  ctx.fillStyle = STYLE.bgColor;
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = STYLE.fgAlpha;
  ctx.fillStyle = healthGradientColor(ratio);
  ctx.fillRect(0, 0, ratioPx, h);
  ctx.globalAlpha = 1;
  return true;
}

export class HealthBar3D {
  /** Module-shared scratch vector reused by every frustum probe so
   *  the per-frame loop allocates nothing. */
  private static readonly _probeVec = new THREE.Vector3();

  private pool: CanvasSpritePool<BarState, [number]>;

  constructor(parent: THREE.Group) {
    this.pool = new CanvasSpritePool<BarState, [number]>({
      parent,
      canvasWidth: STYLE.canvasWidth,
      canvasHeight: STYLE.canvasHeight,
      debugName: 'HealthBar3D',
      maxRetainedSlots: HEALTH_BAR_MAX_RETAINED_SPRITES,
      emptyRetainedSlots: 0,
      shrinkCooldownFrames: HEALTH_BAR_SHRINK_COOLDOWN_FRAMES,
      shrinkBatchSize: HEALTH_BAR_SHRINK_BATCH_SIZE,
      showOnAcquire: false,
      makeState: () => ({
        lastRatioPx: -1,
        lastX: Number.NaN,
        lastY: Number.NaN,
        lastZ: Number.NaN,
        lastWidth: Number.NaN,
        lastAlpha: Number.NaN,
      }),
      repaint: repaintBar,
    });
  }

  getSpritePoolTelemetry(): CanvasSpritePoolTelemetry {
    return this.pool.getTelemetry();
  }

  /** Acquire (or grow) a pool slot and ensure its sprite is visible. */
  private acquire(i: number): Bar {
    return this.pool.acquire(i);
  }

  /** Repaint the canvas if the ratio changed; otherwise no-op. */
  private repaintIfChanged(bar: Bar, ratio: number): void {
    this.pool.repaintIfChanged(bar, ratio);
  }

  /** Frame-state cursor, advanced by beginFrame / processBodyHudPacket /
   *  endFrame in sequence. */
  private _used = 0;
  /** Optional frustum reference set per frame by the caller — null
   *  disables sprite-visibility frustum culling (every visible bar
   *  draws). */
  private _frustum: THREE.Frustum | null = null;
  /** Per-frame camera-distance fade, set by beginFrame. Drives the
   *  zoom-out fade + cull and per-sprite opacity. */
  private _fade: HudFade | null = null;

  /** Entities with an armed self-destruct countdown. Client-only
   *  presentation fed by selfDestructArmed/Disarmed SimEvents (see
   *  RtsScene3D); the hp bar of an armed entity flashes empty at
   *  ~3.3 Hz. Stale ids are harmless — an entity without a body-HUD
   *  row is never consulted. */
  private readonly selfDestructArmed = new Set<number>();

  setSelfDestructArmed(entityId: number, armed: boolean): void {
    if (armed) this.selfDestructArmed.add(entityId);
    else this.selfDestructArmed.delete(entityId);
  }

  /** Reset frame state; caller follows with processBodyHudPacket and
   *  finishes with endFrame. */
  beginFrame(fade: HudFade, frustum?: THREE.Frustum): void {
    this._used = 0;
    this._fade = fade;
    this._frustum = frustum ?? null;
  }

  /** Place a single bar at a given world position. */
  private placeBar(
    ratio: number,
    worldX: number,
    worldY: number,
    worldZ: number,
    worldWidth: number,
    alpha: number,
  ): void {
    const bar = this.acquire(this._used++);
    this.repaintIfChanged(bar, ratio);
    const state = bar.state;
    if (state.lastWidth !== worldWidth) {
      bar.sprite.scale.set(worldWidth, STYLE.worldHeight, 1);
      state.lastWidth = worldWidth;
    }
    if (state.lastX !== worldX || state.lastY !== worldY || state.lastZ !== worldZ) {
      bar.sprite.position.set(worldX, worldY, worldZ);
      state.lastX = worldX;
      state.lastY = worldY;
      state.lastZ = worldZ;
    }
    if (state.lastAlpha !== alpha) {
      bar.material.opacity = alpha;
      state.lastAlpha = alpha;
    }
    let visible = true;
    if (this._frustum) {
      const probe = HealthBar3D._probeVec;
      probe.set(worldX, worldY, worldZ);
      visible = this._frustum.containsPoint(probe);
    }
    if (bar.sprite.visible !== visible) bar.sprite.visible = visible;
  }

  processBodyHudPacket(packet: BodyHudRenderPacket3D): void {
    for (let row = 0; row < packet.count; row++) {
      this.perBodyHudRow(packet, row);
    }
  }

  private perBodyHudRow(packet: BodyHudRenderPacket3D, row: number): void {
    const worldX = packet.x[row];
    const worldY = packet.y[row];
    const worldZ = packet.z[row];
    const alpha = this._fade ? this._fade.alphaAt(worldX, worldY, worldZ) : 1;
    if (alpha <= FADE_CULL_ALPHA) return;
    let healthRatio = packet.healthRatio[row];
    if (
      this.selfDestructArmed.size > 0 &&
      this.selfDestructArmed.has(packet.ids[row]) &&
      Math.floor(performance.now() / 150) % 2 === 0
    ) {
      // Armed self-destruct: flash the hp bar empty (render-side
      // clock — pure presentation, nothing downstream reads it).
      healthRatio = 0;
    }
    this.placeBar(healthRatio, worldX, worldY, worldZ, packet.width[row], alpha);
  }

  /** Hide trailing pool entries past the live prefix. Sprites stay in
   *  the pool ready for the next frame. */
  endFrame(): void {
    this.pool.hideUnused(this._used);
    this._frustum = null;
    this._fade = null;
  }

  destroy(): void {
    this.pool.destroy();
  }
}
