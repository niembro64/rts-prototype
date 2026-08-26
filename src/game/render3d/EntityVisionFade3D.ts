// EntityVisionFade3D — the one presentation flow for an entity crossing
// the local team's vision boundary. Units, buildings, their MIN-rung glyphs
// and the anonymous contact blips all read the same two durations from
// visionConfig.json, which is what makes the tiers cross-fade instead of
// overlapping: the blip's fall is the model's rise and vice versa.
//
//   enters vision  → rises 0 → 1 over VISION_FADE_IN_MS, keyed on the FIRST
//                    sighting at any detail rung (a glyph fades in like a
//                    model; a later LOD promotion never re-fades)
//   leaves vision  → the last drawn representation is retained and falls
//                    1 → 0 over VISION_FADE_OUT_MS, coasting on its last
//                    presented velocity. It is presentation only: the entity
//                    has already left the client store, so nothing can hover,
//                    select, bar, print or shadow it, and it never moves past
//                    what that one short interval extrapolates.
//   re-sighted mid fade-out → the rise resumes from the alpha the fall
//                    reached, so a unit skirmishing the rim never pops.
//
// Confirmed deaths are a different flow (EntityFade3D DyingMeshFade over the
// death duration with debris scatter) and never use these clocks.

import { VISION_FADE_IN_MS, VISION_FADE_OUT_MS } from '@/visionConfig';
import { finiteOrZero } from '../math';
import type { EntityId, PlayerId } from '../sim/types';
import { IndexedEntityIdMap } from '../network/IndexedEntityIdCollections';
import type { EntityDeathRenderablePart3D, EntityDeathPartDelta3D } from './EntityDeathDisassembly3D';
import type { EntityMesh } from './EntityMesh3D';

/** Per-entity fade-IN clock. Keyed by entity id so it survives mesh
 *  rebuilds (LOD / owner recolor) and only resets when the id truly leaves
 *  the live set, so re-entering vision fades in afresh. */
export class VisionFadeInClock3D {
  private readonly elapsed = new IndexedEntityIdMap<number>();
  private enabled = true;

  constructor(private readonly durationMs: number = VISION_FADE_IN_MS) {}

  get size(): number {
    return this.elapsed.size;
  }

  /** TIME fades off (the DISTANCE vision-fade mode): every query reads 1
   *  and nothing is tracked, so switching back on starts every id afresh. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.elapsed.clear();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  has(id: EntityId): boolean {
    return this.elapsed.has(id);
  }

  /** First sighting starts the rise at zero; an already-tracked id is
   *  untouched. Call on every row (glyph or model) so the clock is keyed on
   *  sighting, never on which representation happened to be built. */
  ensure(id: EntityId): void {
    if (!this.enabled) return;
    if (!this.elapsed.has(id)) this.elapsed.set(id, 0);
  }

  /** Resume the rise from a given alpha — the model was re-sighted while
   *  its fade-out was still running, so it continues from where that left
   *  off instead of restarting from invisible. */
  seedFromAlpha(id: EntityId, alpha: number): void {
    if (!this.enabled) return;
    const clamped = Math.min(1, Math.max(0, finiteOrZero(alpha)));
    this.elapsed.set(id, clamped * this.durationMs);
  }

  /** Advance one id by `dtMs` and return its alpha. Seeds an untracked id
   *  at zero. Units call this for every row every frame. */
  advance(id: EntityId, dtMs: number): number {
    if (!this.enabled || this.durationMs <= 0) return 1;
    const prev = this.elapsed.get(id);
    if (prev === this.durationMs) return 1;
    const next = Math.min((prev ?? 0) + Math.max(0, dtMs), this.durationMs);
    this.elapsed.set(id, next);
    return next / this.durationMs;
  }

  /** Advance every id still rising and report each new alpha. Buildings use
   *  this because their rows are submitted only when dirty, so the clock
   *  cannot ride the row loop. Ids already at one are skipped. */
  advanceAll(dtMs: number, onRise: (id: EntityId, alpha: number) => void): void {
    if (!this.enabled || this.elapsed.size === 0) return;
    if (this.durationMs <= 0) {
      for (const [id, prev] of this.elapsed) {
        if (prev === this.durationMs) continue;
        this.elapsed.set(id, this.durationMs);
        onRise(id, 1);
      }
      return;
    }
    for (const [id, prev] of this.elapsed) {
      if (prev === this.durationMs) continue;
      const next = Math.min(prev + Math.max(0, dtMs), this.durationMs);
      this.elapsed.set(id, next);
      onRise(id, next / this.durationMs);
    }
  }

  /** Current alpha without advancing. An id this clock has never sighted
   *  has nothing to fade and reads as fully visible. */
  alphaOf(id: EntityId): number {
    if (!this.enabled || this.durationMs <= 0) return 1;
    const elapsed = this.elapsed.get(id);
    if (elapsed === undefined) return 1;
    return Math.min(elapsed, this.durationMs) / this.durationMs;
  }

  forget(id: EntityId): void {
    this.elapsed.delete(id);
  }

  clear(): void {
    this.elapsed.clear();
  }
}

export type VanishingVelocity3D = Readonly<{
  /** Render-axis velocity in world units per second (x, up, z). */
  x: number;
  y: number;
  z: number;
}>;

type VanishingMotionState3D = {
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  rendererParts: readonly EntityDeathRenderablePart3D[];
};

/**
 * Inertial continuation for a full model that just left vision: the retained
 * visual coasts at its last presented linear velocity for the fade-out
 * interval. No tumble, no scatter — a quiet exit, not a death.
 */
export class VanishingUnitMotion3D {
  private readonly states = new WeakMap<EntityMesh, VanishingMotionState3D>();
  private readonly delta: EntityDeathPartDelta3D = {
    dx: 0,
    dy: 0,
    dz: 0,
    drx: 0,
    dry: 0,
    drz: 0,
  };

  prepare(
    mesh: EntityMesh,
    velocity: VanishingVelocity3D,
    rendererParts: readonly EntityDeathRenderablePart3D[],
  ): void {
    this.states.set(mesh, {
      velocityX: finiteOrZero(velocity.x),
      velocityY: finiteOrZero(velocity.y),
      velocityZ: finiteOrZero(velocity.z),
      rendererParts,
    });
  }

  advance(mesh: EntityMesh, dtMs: number): void {
    const state = this.states.get(mesh);
    if (state === undefined || !Number.isFinite(dtMs) || dtMs <= 0) return;
    const dtSec = dtMs / 1000;
    const delta = this.delta;
    delta.dx = state.velocityX * dtSec;
    delta.dy = state.velocityY * dtSec;
    delta.dz = state.velocityZ * dtSec;

    // Ordinary meshes inherit the root translation. Renderer-owned instances
    // are world-parented, so apply the identical world delta to each handle.
    mesh.group.position.x += delta.dx;
    mesh.group.position.y += delta.dy;
    mesh.group.position.z += delta.dz;
    for (const part of state.rendererParts) part.applyDelta(delta);
  }

  forget(mesh: EntityMesh): void {
    this.states.delete(mesh);
  }
}

export type VanishingProxyPush3D = (
  simX: number,
  simY: number,
  simZ: number,
  radius: number,
  glyph: number,
  ownerId: PlayerId | undefined,
  alpha: number,
) => void;

type ProxyGhostRecord3D = {
  x: number;
  y: number;
  z: number;
  radius: number;
  glyph: number;
  ownerId: PlayerId | undefined;
  /** Sim-axis velocity in world units per second. */
  velX: number;
  velY: number;
  velZ: number;
  fade: number;
};

/**
 * Fade-out for entities whose last drawn representation was the MIN-rung
 * glyph (never built as a model, or parked behind the proxy at the moment
 * vision lapsed). The renderer notes every glyph row it draws; when the id
 * leaves the view the noted glyph keeps drawing, coasting and falling to
 * zero over the fade-out duration, so far-zoom armies stop sparkling at the
 * rim of vision.
 */
export class VanishingProxyGhosts3D {
  private readonly lastRows = new IndexedEntityIdMap<ProxyGhostRecord3D>();
  private readonly ghosts = new IndexedEntityIdMap<ProxyGhostRecord3D>();
  private enabled = true;

  constructor(private readonly durationMs: number = VISION_FADE_OUT_MS) {}

  get size(): number {
    return this.ghosts.size;
  }

  /** TIME fades off: glyphs leave instantly and no rows are noted. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.clear();
  }

  /** Remember where this id's glyph was drawn and how it was moving. */
  noteRow(
    id: EntityId,
    simX: number,
    simY: number,
    simZ: number,
    radius: number,
    glyph: number,
    ownerId: PlayerId | undefined,
    velX: number,
    velY: number,
    velZ: number,
  ): void {
    if (!this.enabled) return;
    let record = this.lastRows.get(id);
    if (record === undefined) {
      record = {
        x: 0, y: 0, z: 0, radius: 0, glyph: 0, ownerId: undefined,
        velX: 0, velY: 0, velZ: 0, fade: 1,
      };
      this.lastRows.set(id, record);
    }
    record.x = simX;
    record.y = simY;
    record.z = simZ;
    record.radius = radius;
    record.glyph = glyph;
    record.ownerId = ownerId;
    record.velX = finiteOrZero(velX);
    record.velY = finiteOrZero(velY);
    record.velZ = finiteOrZero(velZ);
  }

  /** The id left the view with the glyph as its last drawn form: keep that
   *  glyph fading. Returns false when no glyph row was ever noted for it. */
  begin(id: EntityId): boolean {
    const record = this.lastRows.get(id);
    if (record === undefined) return false;
    this.lastRows.delete(id);
    if (!this.enabled || this.durationMs <= 0) return false;
    record.fade = 1;
    this.ghosts.set(id, record);
    return true;
  }

  /** The id is live again. Drops its ghost and returns the alpha the ghost
   *  had reached (so the rise can resume there), or -1 when it had none. */
  recall(id: EntityId): number {
    const ghost = this.ghosts.get(id);
    if (ghost === undefined) return -1;
    this.ghosts.delete(id);
    return ghost.fade;
  }

  /** Drop everything noted for an id whose exit is handled elsewhere (a
   *  full model fade or a confirmed death). */
  forget(id: EntityId): void {
    this.lastRows.delete(id);
    this.ghosts.delete(id);
  }

  /** Advance every ghost by `dtMs`, pushing each surviving glyph. */
  update(dtMs: number, push: VanishingProxyPush3D): void {
    if (this.ghosts.size === 0) return;
    const dt = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
    const dtSec = dt / 1000;
    for (const [id, ghost] of this.ghosts) {
      ghost.fade -= dt / this.durationMs;
      if (ghost.fade <= 0) {
        this.ghosts.delete(id);
        continue;
      }
      ghost.x += ghost.velX * dtSec;
      ghost.y += ghost.velY * dtSec;
      ghost.z += ghost.velZ * dtSec;
      push(ghost.x, ghost.y, ghost.z, ghost.radius, ghost.glyph, ghost.ownerId, ghost.fade);
    }
  }

  clear(): void {
    this.lastRows.clear();
    this.ghosts.clear();
  }
}
