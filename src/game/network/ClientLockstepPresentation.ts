import { DEFAULT_SIMULATION_TICK_RATE_HZ } from '@/types/simulationTickRate';
import { entitySlotRegistry, ENTITY_SLOT_UNIT_MOTION_HAS_ANGULAR_VELOCITY, ENTITY_SLOT_UNIT_MOTION_HAS_ORIENTATION } from '../sim/EntitySlotRegistry';
import type { Entity } from '../sim/types';
import { getSimWasm } from '../sim-wasm/init';
import { reuseTypedArrayView } from '../memory/typedArrayView';

/**
 * Thin compatibility scatter around the Rust/WASM presentation history.
 * Rust owns both fixed-tick endpoints and every interpolation operation; this
 * class only maps visible client entities to authoritative stable slots and
 * writes the resulting pose into the existing renderer compatibility views.
 */
export class ClientLockstepPresentation {
  private readonly entities: Entity[] = [];
  /** Entities that take presentation interpolation, with their stable slots,
   *  cached against the client store's entity-set version so the per-frame
   *  walk over EVERY client entity (plus a Map slot lookup each) only runs
   *  when the entity set actually changed. */
  private readonly filtered: Entity[] = [];
  private readonly filteredSlots: number[] = [];
  private filteredSetVersion = -1;
  private slotInput = new Uint32Array(0);
  private poseOutput = new Float32Array(0);
  private turretOutput = new Float32Array(0);
  private latestTick = -1;
  private capturedAtMs = 0;
  private lastAlpha = 0;
  private fixedStepMs = 1000 / DEFAULT_SIMULATION_TICK_RATE_HZ;

  noteFixedTick(tick: number, capturedAtMs: number, rateHz: number): void {
    if (!Number.isFinite(tick) || tick < this.latestTick) return;
    this.latestTick = tick;
    this.capturedAtMs = Number.isFinite(capturedAtMs) ? capturedAtMs : performance.now();
    if (Number.isFinite(rateHz) && rateHz > 0) this.fixedStepMs = 1000 / rateHz;
    this.lastAlpha = 0;
  }

  reset(): void {
    this.entities.length = 0;
    this.filtered.length = 0;
    this.filteredSlots.length = 0;
    this.filteredSetVersion = -1;
    this.slotInput = new Uint32Array(0);
    this.poseOutput = new Float32Array(0);
    this.turretOutput = new Float32Array(0);
    this.latestTick = -1;
    this.capturedAtMs = 0;
    this.lastAlpha = 0;
    this.fixedStepMs = 1000 / DEFAULT_SIMULATION_TICK_RATE_HZ;
  }

  apply(
    visibleEntities: Iterable<Entity>,
    entitySetVersion: number,
    nowMs = performance.now(),
  ): readonly Entity[] {
    const wasm = getSimWasm() ?? null;
    if (wasm === null || !wasm.presentation.hasHistory()) {
      this.entities.length = 0;
      return this.entities;
    }

    const filtered = this.filtered;
    const filteredSlots = this.filteredSlots;
    if (entitySetVersion !== this.filteredSetVersion) {
      filtered.length = 0;
      filteredSlots.length = 0;
      for (const entity of visibleEntities) {
        const hasMovingRoot = entity.unit !== null || entity.projectile !== null;
        const hasInterpolatedTurrets = (entity.combat?.turrets.length ?? 0) > 0;
        if (!hasMovingRoot && !hasInterpolatedTurrets) continue;
        // Beams/lasers are piecewise paths rather than root-body motion. Their
        // endpoint topology remains on the dedicated beam presentation path.
        if (entity.projectile !== null && entity.projectile.projectileType !== 'projectile') continue;
        const slot = entitySlotRegistry.getSlot(entity.id);
        if (slot < 0) continue;
        filtered.push(entity);
        filteredSlots.push(slot);
      }
      this.filteredSetVersion = entitySetVersion;
    }
    const count = filtered.length;
    const entities = this.entities;
    entities.length = 0;
    if (count === 0) return entities;

    const presentation = wasm.presentation;
    presentation.scratchEnsure(count);
    this.slotInput = reuseTypedArrayView(
      this.slotInput,
      wasm.memory.buffer,
      presentation.slotInputScratchPtr(),
      count,
      Uint32Array,
    );
    for (let i = 0; i < count; i++) {
      this.slotInput[i] = filteredSlots[i];
    }

    const elapsedMs = Math.max(0, nowMs - this.capturedAtMs);
    // One shared, monotonic render clock. Clamp instead of extrapolating:
    // rendering intentionally trails the newest authoritative state by at
    // most one fixed tick, exactly the trade Recoil makes for stable motion.
    const alpha = Math.max(this.lastAlpha, Math.min(1, elapsedMs / this.fixedStepMs));
    this.lastAlpha = alpha;
    presentation.interpolate(count, alpha);

    const poseStride = presentation.poseOutputStride;
    const turretStride = presentation.turretOutputStride;
    const maxTurrets = presentation.maxTurretsPerEntity;
    this.poseOutput = reuseTypedArrayView(
      this.poseOutput,
      wasm.memory.buffer,
      presentation.poseOutputScratchPtr(),
      count * poseStride,
      Float32Array,
    );
    this.turretOutput = reuseTypedArrayView(
      this.turretOutput,
      wasm.memory.buffer,
      presentation.turretOutputScratchPtr(),
      count * maxTurrets * turretStride,
      Float32Array,
    );

    for (let row = 0; row < count; row++) {
      const entity = filtered[row];
      const base = row * poseStride;
      if (this.poseOutput[base] === 0) continue;

      entity.transform.x = this.poseOutput[base + 1];
      entity.transform.y = this.poseOutput[base + 2];
      entity.transform.z = this.poseOutput[base + 3];
      entity.transform.rotation = this.poseOutput[base + 4];

      const unit = entity.unit;
      if (unit !== null) {
        unit.velocityX = this.poseOutput[base + 5];
        unit.velocityY = this.poseOutput[base + 6];
        unit.velocityZ = this.poseOutput[base + 7];
        unit.surfaceNormal.nx = this.poseOutput[base + 8];
        unit.surfaceNormal.ny = this.poseOutput[base + 9];
        unit.surfaceNormal.nz = this.poseOutput[base + 10];
        const motionFlags = this.poseOutput[base + 18] | 0;
        if ((motionFlags & ENTITY_SLOT_UNIT_MOTION_HAS_ORIENTATION) !== 0) {
          const orientation = unit.orientation ?? (unit.orientation = { x: 0, y: 0, z: 0, w: 1 });
          orientation.x = this.poseOutput[base + 11];
          orientation.y = this.poseOutput[base + 12];
          orientation.z = this.poseOutput[base + 13];
          orientation.w = this.poseOutput[base + 14];
        }
        if ((motionFlags & ENTITY_SLOT_UNIT_MOTION_HAS_ANGULAR_VELOCITY) !== 0) {
          const angular = unit.angularVelocity3 ?? (unit.angularVelocity3 = { x: 0, y: 0, z: 0 });
          angular.x = this.poseOutput[base + 15];
          angular.y = this.poseOutput[base + 16];
          angular.z = this.poseOutput[base + 17];
        }
      }

      const projectile = entity.projectile;
      if (projectile !== null) {
        projectile.velocityX = this.poseOutput[base + 5];
        projectile.velocityY = this.poseOutput[base + 6];
        projectile.velocityZ = this.poseOutput[base + 7];
      }

      const turrets = entity.combat?.turrets;
      if (turrets !== undefined) {
        const authoritativeCount = Math.min(
          turrets.length,
          maxTurrets,
          this.poseOutput[base + 19] | 0,
        );
        const turretRowBase = row * maxTurrets * turretStride;
        for (let turretIndex = 0; turretIndex < authoritativeCount; turretIndex++) {
          const turretBase = turretRowBase + turretIndex * turretStride;
          if (this.turretOutput[turretBase + 5] === 0) continue;
          const turret = turrets[turretIndex];
          turret.rotation = this.turretOutput[turretBase];
          turret.pitch = this.turretOutput[turretBase + 1];
          turret.angularVelocity = this.turretOutput[turretBase + 2];
          turret.pitchVelocity = this.turretOutput[turretBase + 3];
          turret.hostPieceYaw = this.turretOutput[turretBase + 6];
          turret.hostPieceYawVelocity = this.turretOutput[turretBase + 7];
        }
      }

      entities.push(entity);
    }
    return entities;
  }
}
