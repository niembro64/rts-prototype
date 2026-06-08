import { buildBuildingDeathEvent, buildUnitDeathEvent } from './combat/damageHelpers';
import {
  emitLaserStopsForEntity,
  emitLaserStopsForTarget,
  emitShieldStopsForEntity,
} from './combat';
import type { DeathContext } from './combat';
import type { Entity, EntityId } from './types';
import { spatialGrid } from './SpatialGrid';
import type { WorldState } from './WorldState';
import { SimulationDeathCleanupClassifier } from './SimulationDeathCleanupClassifier';
import type { SimulationDeathExplosionPlanner } from './SimulationDeathExplosionPlanner';
import type { SimulationEventQueues } from './SimulationEventQueues';

export class SimulationDeadEntityCleanup {
  private readonly world: WorldState;
  private readonly eventQueues: SimulationEventQueues;
  private readonly deathExplosionPlanner: SimulationDeathExplosionPlanner;
  private readonly deathCleanupClassifier: SimulationDeathCleanupClassifier;
  private readonly deathCheckIds: EntityId[] = [];
  private readonly deadUnitIds: EntityId[] = [];
  private readonly deadBuildingIds: EntityId[] = [];
  private readonly deadUnitIdSet = new Set<EntityId>();
  private readonly deadBuildingIdSet = new Set<EntityId>();
  private readonly deadTurretIdSet = new Set<EntityId>();
  private readonly syntheticDeathEventIds = new Set<EntityId>();
  private readonly deathContexts = new Map<EntityId, DeathContext>();

  constructor(
    world: WorldState,
    eventQueues: SimulationEventQueues,
    deathExplosionPlanner: SimulationDeathExplosionPlanner,
  ) {
    this.world = world;
    this.eventQueues = eventQueues;
    this.deathExplosionPlanner = deathExplosionPlanner;
    this.deathCleanupClassifier = new SimulationDeathCleanupClassifier(world);
  }

  run(
    onUnitDeath: ((deadUnitIds: EntityId[], deathContexts: Map<EntityId, DeathContext> | null) => void) | null,
    onBuildingDeath: ((deadBuildingIds: EntityId[]) => void) | null,
  ): void {
    const deathCheckIds = this.deathCheckIds;
    const deadUnitIds = this.deadUnitIds;
    const deadBuildingIds = this.deadBuildingIds;
    deadUnitIds.length = 0;
    deadBuildingIds.length = 0;
    this.world.drainPendingDeathCheckIds(deathCheckIds);
    if (deathCheckIds.length === 0) return;

    this.deathCleanupClassifier.classify(deathCheckIds, deadUnitIds, deadBuildingIds);
    deathCheckIds.length = 0;
    this.planSyntheticDeaths(deadUnitIds, deadBuildingIds);
    this.removeDeadUnits(deadUnitIds, onUnitDeath);
    this.removeDeadBuildings(deadBuildingIds, onBuildingDeath);
  }

  reset(): void {
    this.deathCheckIds.length = 0;
    this.deadUnitIds.length = 0;
    this.deadBuildingIds.length = 0;
    this.deadUnitIdSet.clear();
    this.deadBuildingIdSet.clear();
    this.deadTurretIdSet.clear();
    this.syntheticDeathEventIds.clear();
    this.deathContexts.clear();
  }

  private planSyntheticDeaths(deadUnitIds: EntityId[], deadBuildingIds: EntityId[]): void {
    if (deadUnitIds.length === 0 && deadBuildingIds.length === 0) return;
    const deadUnitSet = this.deadUnitIdSet;
    const deadBuildingSet = this.deadBuildingIdSet;
    const deadTurretSet = this.deadTurretIdSet;
    const syntheticDeathEventIds = this.syntheticDeathEventIds;
    const deathContexts = this.deathContexts;
    deadUnitSet.clear();
    deadBuildingSet.clear();
    deadTurretSet.clear();
    syntheticDeathEventIds.clear();
    deathContexts.clear();
    for (const id of deadUnitIds) {
      deadUnitSet.add(id);
      syntheticDeathEventIds.add(id);
    }
    for (const id of deadBuildingIds) {
      deadBuildingSet.add(id);
      syntheticDeathEventIds.add(id);
    }
    this.deathExplosionPlanner.detonate(
      deadUnitSet,
      deadBuildingSet,
      deadTurretSet,
      this.eventQueues.simEvents,
      deathContexts,
    );
    deadUnitIds.length = 0;
    deadBuildingIds.length = 0;
    for (const id of deadUnitSet) deadUnitIds.push(id);
    for (const id of deadBuildingSet) deadBuildingIds.push(id);
  }

  private removeDeadUnits(
    deadUnitIds: EntityId[],
    onUnitDeath: ((deadUnitIds: EntityId[], deathContexts: Map<EntityId, DeathContext> | null) => void) | null,
  ): void {
    if (deadUnitIds.length === 0) return;
    for (const id of deadUnitIds) {
      const entity = this.world.getEntity(id);
      if (entity) {
        this.emitStopsForDeadUnit(entity, id);
        if (this.syntheticDeathEventIds.has(id)) this.emitSyntheticDeathEvent(entity);
      }
      spatialGrid.removeUnit(id);
    }
    if (onUnitDeath !== null) onUnitDeath(deadUnitIds, null);
    for (const id of deadUnitIds) this.world.removeEntity(id);
  }

  private removeDeadBuildings(
    deadBuildingIds: EntityId[],
    onBuildingDeath: ((deadBuildingIds: EntityId[]) => void) | null,
  ): void {
    if (deadBuildingIds.length === 0) return;
    for (const id of deadBuildingIds) {
      const building = this.world.getEntity(id);
      if (building && this.syntheticDeathEventIds.has(id)) this.emitSyntheticDeathEvent(building);
      spatialGrid.removeBuilding(id);
    }
    if (onBuildingDeath !== null) onBuildingDeath(deadBuildingIds);
    for (const id of deadBuildingIds) this.world.removeEntity(id);
  }

  private emitStopsForDeadUnit(entity: Entity, id: EntityId): void {
    for (const evt of emitLaserStopsForEntity(entity)) this.eventQueues.simEvents.push(evt);
    for (const evt of emitLaserStopsForTarget(this.world, id)) this.eventQueues.simEvents.push(evt);
    for (const evt of emitShieldStopsForEntity(entity)) this.eventQueues.simEvents.push(evt);
  }

  private emitSyntheticDeathEvent(entity: Entity): void {
    if (entity.unit) {
      this.eventQueues.simEvents.push(
        buildUnitDeathEvent(entity, entity.id, entity.unit.unitBlueprintId ?? '', undefined, 'unit'),
      );
    } else if (entity.building) {
      this.eventQueues.simEvents.push(
        buildBuildingDeathEvent(entity, entity.id, entity.buildingBlueprintId ?? '', 'building'),
      );
    }
  }
}
