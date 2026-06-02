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
import type { Entity } from '../sim/types';
import { getBuildingHudNameY, getUnitHudNameY } from './HudAnchor';
import { CanvasSpritePool, type CanvasSpriteSlot } from './CanvasSpritePool';
import { FADE_CULL_ALPHA, type HudFade } from './HudFade';
import { PIECE_TAG_BODY, PIECE_TAG_TURRET_BASE, packPieceKey } from './HealthBar3D';
import {
  buildingBlueprintIdToCode,
  shotBlueprintIdToCode,
  turretBlueprintIdToCode,
  unitBlueprintIdToCode,
} from '@/types/network';
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
  NAME_LABEL_OWNER_FILL_COLOR,
  NAME_LABEL_OWNER_STROKE_COLOR,
  NAME_LABEL_OWNER_WORLD_HEIGHT,
} from '@/nameLabelConfig';
import { GAME_DIAGNOSTICS } from '../diagnostics';

// Local short-name alias for the imported config — keeps call sites
// terse while every tunable lives in @/nameLabelConfig.
const STYLE = {
  worldHeight: NAME_LABEL_WORLD_HEIGHT,
  ownerWorldHeight: NAME_LABEL_OWNER_WORLD_HEIGHT,
  fontPx: NAME_LABEL_FONT_PX,
  fontFamily: NAME_LABEL_FONT_FAMILY,
  fillColor: NAME_LABEL_FILL_COLOR,
  strokeColor: NAME_LABEL_STROKE_COLOR,
  ownerFillColor: NAME_LABEL_OWNER_FILL_COLOR,
  ownerStrokeColor: NAME_LABEL_OWNER_STROKE_COLOR,
  strokeWidthPx: NAME_LABEL_STROKE_WIDTH_PX,
  canvasPadX: NAME_LABEL_CANVAS_PAD_X,
  canvasPadY: NAME_LABEL_CANVAS_PAD_Y,
  canvasMinWidth: NAME_LABEL_CANVAS_MIN_WIDTH,
};

const FONT_STRING = `bold ${STYLE.fontPx}px ${STYLE.fontFamily}`;
const CANVAS_HEIGHT_PX = STYLE.fontPx + 2 * STYLE.canvasPadY;
export const PIECE_TAG_COMMANDER_OWNER_NAME = 2;
const LABEL_IDENTITY_TRACE_FRAMES = 120;
const LABEL_IDENTITY_PRUNE_INTERVAL_FRAMES = 180;
const LABEL_IDENTITY_PRUNE_AFTER_FRAMES = 600;

export type NameLabelTone = 'blueprint' | 'owner';
const PIECE_NAME_PACKET_INITIAL_CAP = 512;
const NAME_LABEL_TONE_BLUEPRINT = 0;
const NAME_LABEL_TONE_OWNER = 1;

export class PieceNameRenderPacket3D {
  hostIds: Float64Array = new Float64Array(PIECE_NAME_PACKET_INITIAL_CAP);
  pieceTags: Uint16Array = new Uint16Array(PIECE_NAME_PACKET_INITIAL_CAP);
  x: Float32Array = new Float32Array(PIECE_NAME_PACKET_INITIAL_CAP);
  y: Float32Array = new Float32Array(PIECE_NAME_PACKET_INITIAL_CAP);
  z: Float32Array = new Float32Array(PIECE_NAME_PACKET_INITIAL_CAP);
  tones: Uint8Array = new Uint8Array(PIECE_NAME_PACKET_INITIAL_CAP);
  texts: string[] = [];
  count = 0;

  reset(): void {
    this.count = 0;
    this.texts.length = 0;
  }

  push(
    hostId: number,
    pieceTag: number,
    x: number,
    y: number,
    z: number,
    text: string,
    tone: NameLabelTone = 'blueprint',
  ): void {
    if (text.length === 0) return;
    const cursor = this.count;
    this.ensureCapacity(cursor + 1);
    this.hostIds[cursor] = hostId;
    this.pieceTags[cursor] = pieceTag;
    this.x[cursor] = x;
    this.y[cursor] = y;
    this.z[cursor] = z;
    this.tones[cursor] = tone === 'owner'
      ? NAME_LABEL_TONE_OWNER
      : NAME_LABEL_TONE_BLUEPRINT;
    this.texts[cursor] = text;
    this.count = cursor + 1;
  }

  private ensureCapacity(required: number): void {
    if (required <= this.hostIds.length) return;
    let nextCapacity = this.hostIds.length;
    while (nextCapacity < required) nextCapacity *= 2;
    this.hostIds = growFloat64(this.hostIds, nextCapacity);
    this.pieceTags = growUint16(this.pieceTags, nextCapacity);
    this.x = growFloat32(this.x, nextCapacity);
    this.y = growFloat32(this.y, nextCapacity);
    this.z = growFloat32(this.z, nextCapacity);
    this.tones = growUint8(this.tones, nextCapacity);
  }
}

function growFloat32(source: Float32Array, nextCapacity: number): Float32Array {
  const next = new Float32Array(nextCapacity);
  next.set(source);
  return next;
}

function growFloat64(source: Float64Array, nextCapacity: number): Float64Array {
  const next = new Float64Array(nextCapacity);
  next.set(source);
  return next;
}

function growUint8(source: Uint8Array, nextCapacity: number): Uint8Array {
  const next = new Uint8Array(nextCapacity);
  next.set(source);
  return next;
}

function growUint16(source: Uint16Array, nextCapacity: number): Uint16Array {
  const next = new Uint16Array(nextCapacity);
  next.set(source);
  return next;
}

function toneFromPacketCode(code: number): NameLabelTone {
  return code === NAME_LABEL_TONE_OWNER ? 'owner' : 'blueprint';
}

type LabelIdentitySnapshot = {
  frame: number;
  key: number;
  entityId: number;
  entityType: string;
  pieceTag: number;
  pieceKind: string;
  text: string;
  identityKey: string;
  playerId: number | null;
  unitBlueprintId: string | null;
  unitBlueprintCode: number | null;
  buildingBlueprintId: string | null;
  buildingBlueprintCode: number | null;
  turretIndex: number | null;
  turretBlueprintId: string | null;
  turretBlueprintCode: number | null;
  shotBlueprintId: string | null;
  shotBlueprintCode: number | null;
};

type LabelIdentityRecord = {
  text: string;
  identityKey: string;
  lastSeenFrame: number;
  traceFramesRemaining: number;
  snapshot: LabelIdentitySnapshot;
};

function fillColorForTone(tone: NameLabelTone): string {
  return tone === 'owner' ? STYLE.ownerFillColor : STYLE.fillColor;
}

function strokeColorForTone(tone: NameLabelTone): string {
  return tone === 'owner' ? STYLE.ownerStrokeColor : STYLE.strokeColor;
}

function worldHeightForTone(tone: NameLabelTone): number {
  return tone === 'owner' ? STYLE.ownerWorldHeight : STYLE.worldHeight;
}

function labelIdentitySnapshot(
  entity: Entity,
  key: number,
  pieceTag: number,
  text: string,
  frame: number,
): LabelIdentitySnapshot {
  const unitBlueprintId = entity.unit?.unitBlueprintId ?? null;
  const buildingBlueprintId = entity.buildingBlueprintId ?? null;
  let pieceKind = pieceTag === PIECE_TAG_BODY ? 'body' : `piece:${pieceTag}`;
  let turretIndex: number | null = null;
  let turretBlueprintId: string | null = null;
  let shotBlueprintId: string | null = entity.projectile?.shotBlueprintId ?? null;

  if (pieceTag >= PIECE_TAG_TURRET_BASE && pieceTag < PIECE_TAG_TURRET_BASE + 256) {
    turretIndex = pieceTag - PIECE_TAG_TURRET_BASE;
    turretBlueprintId = entity.combat?.turrets[turretIndex]?.config.turretBlueprintId ?? null;
    pieceKind = 'turret';
  } else if (entity.projectile !== null) {
    pieceKind = 'shot';
  }

  const identityKey = [
    entity.type,
    pieceKind,
    unitBlueprintId ?? '',
    buildingBlueprintId ?? '',
    turretIndex ?? '',
    turretBlueprintId ?? '',
    shotBlueprintId ?? '',
  ].join('|');

  return {
    frame,
    key,
    entityId: entity.id,
    entityType: entity.type,
    pieceTag,
    pieceKind,
    text,
    identityKey,
    playerId: entity.ownership?.playerId ?? null,
    unitBlueprintId,
    unitBlueprintCode: unitBlueprintId !== null ? unitBlueprintIdToCode(unitBlueprintId) : null,
    buildingBlueprintId,
    buildingBlueprintCode: buildingBlueprintId !== null ? buildingBlueprintIdToCode(buildingBlueprintId) : null,
    turretIndex,
    turretBlueprintId,
    turretBlueprintCode: turretBlueprintId !== null ? turretBlueprintIdToCode(turretBlueprintId) : null,
    shotBlueprintId,
    shotBlueprintCode: shotBlueprintId !== null ? shotBlueprintIdToCode(shotBlueprintId) : null,
  };
}

function logLabelIdentityTrace(
  reason: string,
  previous: LabelIdentitySnapshot | null,
  current: LabelIdentitySnapshot,
): void {
  console.warn('[NameLabel3D] displayed blueprint-name label changed for a stable packed key', {
    reason,
    previous,
    current,
  });
}

type LabelState = {
  /** Last-baked text. The canvas re-paints only when this changes. */
  lastText: string;
  lastTone: NameLabelTone | null;
  /** Last-baked canvas dimensions in pixels. The sprite's world width
   *  is `(canvasW / canvasH) × worldHeight`, so character proportions
   *  stay uniform regardless of text length. */
  lastCanvasW: number;
  lastCanvasH: number;
};

type Label = CanvasSpriteSlot<LabelState>;

function makeLabelState(slot: Pick<Label, 'canvas'>): LabelState {
  return {
    lastText: '',
    lastTone: null,
    lastCanvasW: slot.canvas.width,
    lastCanvasH: slot.canvas.height,
  };
}

function repaintLabel(label: Label, text: string, tone: NameLabelTone): boolean {
  if (label.state.lastText === text && label.state.lastTone === tone) return false;
  label.state.lastText = text;
  label.state.lastTone = tone;
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
  ctx.strokeStyle = strokeColorForTone(tone);
  ctx.fillStyle = fillColorForTone(tone);
  ctx.strokeText(text, newW / 2, newH / 2);
  ctx.fillText(text, newW / 2, newH / 2);
  label.state.lastCanvasW = newW;
  label.state.lastCanvasH = newH;
  return true;
}

export class NameLabel3D {
  /** Module-shared scratch vector reused for every frustum probe so
   *  the per-frame loop allocates nothing. */
  private static readonly _probeVec = new THREE.Vector3();

  /** Pool grows on demand. Each label keeps its sprite parented to
   *  `parent` for the life of the renderer — endFrame just hides the
   *  unused tail, beginFrame doesn't tear down sprites. */
  private pool: CanvasSpritePool<LabelState, [string, NameLabelTone]>;

  /** Per-frame cursor — same pattern as HealthBar3D. Dedup is keyed by
   *  a PACKED piece key (hostId * 256 + pieceTag) so a host's body
   *  label doesn't suppress its turret / locomotion labels (they share
   *  one host id). */
  private _used = 0;
  private _seenEntityFrame = new Map<number, number>();
  private _frameToken = 0;
  private _frustum: THREE.Frustum | null = null;
  /** Per-frame camera-distance fade, set by beginFrame. */
  private _fade: HudFade | null = null;
  private _identityFrame = 0;
  private _identityPruneCountdown = LABEL_IDENTITY_PRUNE_INTERVAL_FRAMES;
  private readonly _labelIdentities = new Map<number, LabelIdentityRecord>();

  constructor(parent: THREE.Group) {
    this.pool = new CanvasSpritePool<LabelState, [string, NameLabelTone]>({
      parent,
      // Initial canvas size is provisional; the first repaint resizes
      // to fit actual text. Non-zero starter dimensions keep Three's
      // CanvasTexture valid before the first upload.
      canvasWidth: STYLE.canvasMinWidth,
      canvasHeight: CANVAS_HEIGHT_PX,
      debugName: 'NameLabel3D',
      makeState: makeLabelState,
      repaint: repaintLabel,
    });
  }

  /** Reset frame state. Caller follows with a series of perEntity
   *  calls and finishes with endFrame. */
  beginFrame(fade: HudFade, frustum?: THREE.Frustum): void {
    this._used = 0;
    this._frameToken = (this._frameToken + 1) & 0x3fffffff;
    this._identityFrame++;
    // Clear the per-frame dedup map each frame so it stays bounded to
    // entities actually drawn this frame. Previously it only cleared on
    // the ~185-day token rollover, so it retained an entry for every
    // entity id that ever rendered a label.
    this._seenEntityFrame.clear();
    this._fade = fade;
    this._frustum = frustum ?? null;
  }

  /** Emit (or update) a label for `entity` reading `text`. `text` may
   *  be null / empty — that's a no-op so callers can run a uniform
   *  per-entity loop and let the resolver decide whether each entity
   *  gets a label. */
  perEntity(entity: Entity, text: string | null): void {
    if (!text || text.length === 0) return;
    const key = packPieceKey(entity.id, PIECE_TAG_BODY);
    if (this._seenEntityFrame.get(key) === this._frameToken) return;

    const isUnit = !!entity.unit;
    const isBuilding = !!entity.building;
    if (!isUnit && !isBuilding) return;

    const worldX = entity.transform.x;
    const worldY = isUnit
      ? getUnitHudNameY(entity)
      : getBuildingHudNameY(entity);
    const worldZ = entity.transform.y;
    const alpha = this._fade ? this._fade.alphaAt(worldX, worldY, worldZ) : 1;
    if (alpha <= FADE_CULL_ALPHA) return;

    this._seenEntityFrame.set(key, this._frameToken);
    if (this.place(text, worldX, worldY, worldZ, alpha, 'blueprint')) {
      this.recordDisplayedLabelIdentity(entity, key, PIECE_TAG_BODY, text, 'blueprint');
    }
  }

  /** Emit (or update) a label for a sub-piece (turret / locomotion /
   *  shot) of `host`. `pieceTag` distinguishes the piece within the
   *  host so the packed dedup key never collides with the host's body
   *  label or other pieces (see HealthBar3D piece tags). `anchorWorld`
   *  is the precomputed label world position. */
  perPieceName(
    host: Entity,
    pieceTag: number,
    anchorWorld: { x: number; y: number; z: number },
    text: string | null,
    tone: NameLabelTone = 'blueprint',
  ): void {
    if (!text || text.length === 0) return;
    const key = packPieceKey(host.id, pieceTag);
    if (this._seenEntityFrame.get(key) === this._frameToken) return;
    const { x: worldX, y: worldY, z: worldZ } = anchorWorld;
    const alpha = this._fade ? this._fade.alphaAt(worldX, worldY, worldZ) : 1;
    if (alpha <= FADE_CULL_ALPHA) return;
    this._seenEntityFrame.set(key, this._frameToken);
    if (this.place(text, worldX, worldY, worldZ, alpha, tone)) {
      this.recordDisplayedLabelIdentity(host, key, pieceTag, text, tone);
    }
  }

  processPieceNamePacket(packet: PieceNameRenderPacket3D): void {
    for (let row = 0; row < packet.count; row++) {
      this.perPackedPieceName(
        packet.hostIds[row],
        packet.pieceTags[row],
        packet.x[row],
        packet.y[row],
        packet.z[row],
        packet.texts[row],
        toneFromPacketCode(packet.tones[row]),
      );
    }
  }

  private perPackedPieceName(
    hostId: number,
    pieceTag: number,
    worldX: number,
    worldY: number,
    worldZ: number,
    text: string | null,
    tone: NameLabelTone,
  ): void {
    if (!text || text.length === 0) return;
    const key = packPieceKey(hostId, pieceTag);
    if (this._seenEntityFrame.get(key) === this._frameToken) return;
    const alpha = this._fade ? this._fade.alphaAt(worldX, worldY, worldZ) : 1;
    if (alpha <= FADE_CULL_ALPHA) return;
    this._seenEntityFrame.set(key, this._frameToken);
    this.place(text, worldX, worldY, worldZ, alpha, tone);
  }

  /** Shared sprite placement: acquire a pool slot, repaint if the text
   *  changed, scale to the canvas aspect, and position + fade it. */
  private place(
    text: string,
    worldX: number,
    worldY: number,
    worldZ: number,
    alpha: number,
    tone: NameLabelTone,
  ): boolean {
    const label = this.acquire(this._used++);
    this.repaintIfChanged(label, text, tone);

    // Sprite's world aspect = canvas aspect, so text proportions stay
    // uniform: short names render small, long names render long, and
    // each character claims the same world height across all labels.
    const worldHeight = worldHeightForTone(tone);
    const worldWidth = (label.state.lastCanvasW / label.state.lastCanvasH) * worldHeight;
    label.sprite.scale.set(worldWidth, worldHeight, 1);
    label.sprite.position.set(worldX, worldY, worldZ);
    label.material.opacity = alpha;
    if (this._frustum) {
      const probe = NameLabel3D._probeVec;
      probe.set(worldX, worldY, worldZ);
      label.sprite.visible = this._frustum.containsPoint(probe);
    } else {
      label.sprite.visible = true;
    }
    return label.sprite.visible;
  }

  /** Hide trailing pool entries past the live prefix. */
  endFrame(): void {
    this.pool.hideUnused(this._used);
    this._frustum = null;
    this._fade = null;
    this.pruneLabelIdentities();
  }

  destroy(): void {
    this.pool.destroy();
    this._seenEntityFrame.clear();
    this._labelIdentities.clear();
  }

  // ── internals ──

  private acquire(i: number): Label {
    return this.pool.acquire(i);
  }

  private repaintIfChanged(label: Label, text: string, tone: NameLabelTone): void {
    this.pool.repaintIfChanged(label, text, tone);
  }

  private recordDisplayedLabelIdentity(
    entity: Entity,
    key: number,
    pieceTag: number,
    text: string,
    tone: NameLabelTone,
  ): void {
    if (!GAME_DIAGNOSTICS.nameLabelIdentityTrace) return;
    if (tone !== 'blueprint') return;
    const current = labelIdentitySnapshot(entity, key, pieceTag, text, this._identityFrame);
    const previous = this._labelIdentities.get(key);
    let traceFramesRemaining = previous?.traceFramesRemaining ?? 0;
    let reason: string | null = null;
    if (previous !== undefined) {
      if (previous.identityKey !== current.identityKey) {
        reason = 'identity-changed';
      } else if (previous.text !== current.text) {
        reason = 'text-changed';
      }
    }

    if (reason !== null) {
      traceFramesRemaining = Math.max(traceFramesRemaining, LABEL_IDENTITY_TRACE_FRAMES);
    }
    if (traceFramesRemaining > 0) {
      logLabelIdentityTrace(reason ?? 'trace', previous?.snapshot ?? null, current);
      traceFramesRemaining--;
    }

    this._labelIdentities.set(key, {
      text,
      identityKey: current.identityKey,
      lastSeenFrame: this._identityFrame,
      traceFramesRemaining,
      snapshot: current,
    });
  }

  private pruneLabelIdentities(): void {
    if (!GAME_DIAGNOSTICS.nameLabelIdentityTrace) return;
    this._identityPruneCountdown--;
    if (this._identityPruneCountdown > 0) return;
    this._identityPruneCountdown = LABEL_IDENTITY_PRUNE_INTERVAL_FRAMES;
    const pruneBeforeFrame = this._identityFrame - LABEL_IDENTITY_PRUNE_AFTER_FRAMES;
    for (const [key, record] of this._labelIdentities) {
      if (record.lastSeenFrame < pruneBeforeFrame) this._labelIdentities.delete(key);
    }
  }
}
