import { ENTITY_CHANGED_ACTIONS } from '@/types/network';
import { isBuildBlockingActivation, isBuildInProgress } from './buildableHelpers';
import { getEntityTargetPoint } from './buildingAnchors';
import { setUnitActions } from './unitActions';
import type { Entity, EntityId, UnitAction } from './types';
import type { WorldState } from './WorldState';

export const BAR_IDLE_BUILDER_AUTO_REPAIR_POLL_TICKS = 30;

const BAR_RECLAIM_BLACKLIST_DURATION_TICKS = 60 * BAR_IDLE_BUILDER_AUTO_REPAIR_POLL_TICKS;

type HomePosition = {
  x: number;
  y: number;
  z: number;
};

type ActiveRepair = HomePosition & {
  targetId: EntityId;
};

export class SimulationIdleBuilderAutoRepair {
  private readonly world: WorldState;
  private readonly idleBuilders: Map<EntityId, HomePosition> = new Map();
  private readonly activeRepairs: Map<EntityId, ActiveRepair> = new Map();
  private readonly activeReclaimers: Map<EntityId, EntityId> = new Map();
  private readonly reclaimBlacklist: Map<EntityId, number> = new Map();

  constructor(world: WorldState) {
    this.world = world;
  }

  update(tick: number): void {
    if (tick % BAR_IDLE_BUILDER_AUTO_REPAIR_POLL_TICKS !== 0) return;

    this.pruneReclaimBlacklist(tick);
    this.refreshActiveReclaimers(tick);
    this.monitorActiveRepairs();
    this.refreshIdleBuilders();
    this.assignIdleRepairs();
  }

  reset(): void {
    this.idleBuilders.clear();
    this.activeRepairs.clear();
    this.activeReclaimers.clear();
    this.reclaimBlacklist.clear();
  }

  private pruneReclaimBlacklist(tick: number): void {
    for (const [targetId, expiryTick] of this.reclaimBlacklist) {
      if (tick >= expiryTick) this.reclaimBlacklist.delete(targetId);
    }
  }

  private refreshActiveReclaimers(tick: number): void {
    const seenReclaimers = new Set<EntityId>();
    const units = this.world.getUnits();
    for (let i = 0; i < units.length; i++) {
      const entity = units[i];
      const action = entity.unit?.actions[0];
      if (action === undefined || action.type !== 'reclaim' || action.targetId === undefined) continue;
      seenReclaimers.add(entity.id);
      const previousTargetId = this.activeReclaimers.get(entity.id);
      if (previousTargetId !== undefined && previousTargetId !== action.targetId) {
        this.stopTrackingReclaimer(entity.id, tick);
      }
      this.activeReclaimers.set(entity.id, action.targetId);
      this.reclaimBlacklist.set(action.targetId, Infinity);
    }

    for (const reclaimerId of Array.from(this.activeReclaimers.keys())) {
      if (!seenReclaimers.has(reclaimerId)) {
        this.stopTrackingReclaimer(reclaimerId, tick);
      }
    }
  }

  private stopTrackingReclaimer(reclaimerId: EntityId, tick: number): void {
    const targetId = this.activeReclaimers.get(reclaimerId);
    if (targetId === undefined) return;
    this.activeReclaimers.delete(reclaimerId);
    if (!this.hasActiveReclaimerForTarget(targetId)) {
      this.reclaimBlacklist.set(targetId, tick + BAR_RECLAIM_BLACKLIST_DURATION_TICKS);
    }
  }

  private hasActiveReclaimerForTarget(targetId: EntityId): boolean {
    for (const activeTargetId of this.activeReclaimers.values()) {
      if (activeTargetId === targetId) return true;
    }
    return false;
  }

  private monitorActiveRepairs(): void {
    for (const [builderId, info] of Array.from(this.activeRepairs)) {
      const builder = this.world.getEntity(builderId);
      if (!this.isEligibleMobileBuilder(builder)) {
        this.activeRepairs.delete(builderId);
        continue;
      }

      const target = this.world.getEntity(info.targetId);
      if (
        target === undefined ||
        target.unit === null ||
        target.unit.hp <= 0 ||
        this.reclaimBlacklist.has(info.targetId) ||
        builder.unit.wantCloak
      ) {
        this.sendHome(builder, info);
        continue;
      }

      if (target.unit.hp >= target.unit.maxHp) {
        this.sendHome(builder, info);
        continue;
      }

      if (!this.targetWithinLeash(builder, target, info)) {
        this.sendHome(builder, info);
        continue;
      }

      const head = builder.unit.actions[0];
      if (head === undefined || head.type !== 'repair' || head.targetId !== info.targetId) {
        this.activeRepairs.delete(builderId);
      }
    }
  }

  private refreshIdleBuilders(): void {
    const builders = this.world.getBuilderUnits();
    for (let i = 0; i < builders.length; i++) {
      const builder = builders[i];
      if (!this.isEligibleMobileBuilder(builder)) {
        this.idleBuilders.delete(builder.id);
        this.activeRepairs.delete(builder.id);
        continue;
      }
      if (this.activeRepairs.has(builder.id)) {
        this.idleBuilders.delete(builder.id);
        continue;
      }
      if (builder.unit.actions.length === 0) {
        if (!this.idleBuilders.has(builder.id)) {
          this.idleBuilders.set(builder.id, {
            x: builder.transform.x,
            y: builder.transform.y,
            z: builder.transform.z,
          });
        }
      } else {
        this.idleBuilders.delete(builder.id);
      }
    }
  }

  private assignIdleRepairs(): void {
    if (this.idleBuilders.size === 0) return;
    const builders = this.world.getBuilderUnits();
    for (let i = 0; i < builders.length; i++) {
      const builder = builders[i];
      const home = this.idleBuilders.get(builder.id);
      if (home === undefined) continue;
      if (!this.isEligibleMobileBuilder(builder)) {
        this.idleBuilders.delete(builder.id);
        continue;
      }
      if (builder.unit.wantCloak || builder.unit.actions.length !== 0) {
        if (builder.unit.actions.length !== 0) this.idleBuilders.delete(builder.id);
        continue;
      }

      const target = this.findRepairTarget(builder, home);
      if (target === null) continue;
      const targetPoint = getEntityTargetPoint(target);
      const action: UnitAction = {
        type: 'repair',
        x: targetPoint.x,
        y: targetPoint.y,
        z: targetPoint.z,
        targetId: target.id,
      };
      setUnitActions(builder.unit, [action]);
      builder.unit.stuckTicks = 0;
      this.world.markSnapshotDirty(builder.id, ENTITY_CHANGED_ACTIONS);
      this.activeRepairs.set(builder.id, {
        targetId: target.id,
        x: home.x,
        y: home.y,
        z: home.z,
      });
      this.idleBuilders.delete(builder.id);
    }
  }

  private findRepairTarget(builder: Entity, home: HomePosition): Entity | null {
    const ownerId = builder.ownership?.playerId;
    if (ownerId === undefined) return null;
    const leash = this.getLeashRadius(builder);
    const damagedUnits = this.world.getDamagedUnits();
    let best: Entity | null = null;
    let bestDistSq = Infinity;
    for (let i = 0; i < damagedUnits.length; i++) {
      const candidate = damagedUnits[i];
      if (candidate.id === builder.id || candidate.unit === null) continue;
      if (candidate.unit.hp <= 0 || candidate.unit.hp >= candidate.unit.maxHp) continue;
      if (isBuildInProgress(candidate.buildable)) continue;
      if (this.reclaimBlacklist.has(candidate.id)) continue;
      const candidateOwnerId = candidate.ownership?.playerId;
      if (candidateOwnerId === undefined || !this.world.arePlayersAllied(ownerId, candidateOwnerId)) continue;
      const dx = candidate.transform.x - home.x;
      const dy = candidate.transform.y - home.y;
      const distSq = dx * dx + dy * dy;
      const effectiveLeash = leash + candidate.unit.radius.collision;
      if (distSq > effectiveLeash * effectiveLeash) continue;
      if (distSq < bestDistSq || (distSq === bestDistSq && best !== null && candidate.id < best.id)) {
        best = candidate;
        bestDistSq = distSq;
      }
    }
    return best;
  }

  private targetWithinLeash(builder: Entity, target: Entity, home: HomePosition): boolean {
    const targetUnit = target.unit;
    if (targetUnit === null) return false;
    const dx = target.transform.x - home.x;
    const dy = target.transform.y - home.y;
    const effectiveLeash = this.getLeashRadius(builder) + targetUnit.radius.collision;
    return dx * dx + dy * dy <= effectiveLeash * effectiveLeash;
  }

  private getLeashRadius(builder: Entity): number {
    const buildRange = builder.builder?.buildRange ?? 0;
    const moveState = builder.unit?.moveState;
    if (moveState === 'holdPosition') return buildRange;
    if (moveState === 'roam') return buildRange + 200;
    return buildRange + 100;
  }

  private sendHome(builder: Entity, info: HomePosition): void {
    if (builder.unit === null) return;
    setUnitActions(builder.unit, [{
      type: 'move',
      x: info.x,
      y: info.y,
      z: info.z,
    }]);
    builder.unit.stuckTicks = 0;
    this.activeRepairs.delete(builder.id);
    this.idleBuilders.delete(builder.id);
    this.world.markSnapshotDirty(builder.id, ENTITY_CHANGED_ACTIONS);
  }

  private isEligibleMobileBuilder(entity: Entity | undefined): entity is Entity & { unit: NonNullable<Entity['unit']> } {
    return !!(
      entity !== undefined &&
      entity.unit !== null &&
      entity.builder !== null &&
      entity.factory === null &&
      entity.ownership !== null &&
      entity.unit.hp > 0 &&
      !isBuildBlockingActivation(entity.buildable)
    );
  }
}
