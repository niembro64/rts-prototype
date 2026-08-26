import type { EntityId } from './types';
import { NO_ENTITY_ID } from './types';
import type { WorldState } from './WorldState';
import { getBuildingBlueprint, getUnitBlueprint } from './blueprints';
import { getBuildingCombatCenterZ } from './buildingAnchors';
import { DamageSystem, type AreaDamageSource } from './damage';
import { collectKillsAndDeathContexts } from './combat/damageHelpers';
import type { DeathContext, SimEvent } from './combat';
import type { ForceAccumulator } from './ForceAccumulator';
import { getSimWasm, type SimWasm } from '../sim-wasm/init';
import { MAX_DEATH_EXPLOSIONS_PER_TICK } from '../../config';

const EMPTY_DEATH_EXPLOSION_EXCLUDES = new Set<EntityId>();
function cloneDeathExplosionBlast(blast: DeathExplosionBlast): DeathExplosionBlast {
  return {
    radius: blast.radius,
    force: blast.force,
    damage: blast.damage,
    sourceKey: blast.sourceKey,
    sourceType: blast.sourceType,
    sourceEntityId: blast.sourceEntityId,
    center: { x: blast.center.x, y: blast.center.y, z: blast.center.z },
  };
}

const DEATH_EXPLOSION_WORK_KIND_UNIT = 1;
const DEATH_EXPLOSION_WORK_KIND_BUILDING = 2;

type DeathExplosionBlast = {
  radius: number;
  force: number;
  damage: number;
  sourceKey: string;
  sourceType: 'turret' | 'unit' | 'building' | 'system';
  sourceEntityId: EntityId;
  center: { x: number; y: number; z: number };
};

export class SimulationDeathExplosionPlanner {
  private deathExplosionUnitIdsBuf = new Int32Array(0);
  private deathExplosionBuildingIdsBuf = new Int32Array(0);
  private deathExplosionWorkEntityIdBuf = new Int32Array(1);
  private deathExplosionWorkKindBuf = new Uint8Array(1);
  private deathExplosionBlastScratch: DeathExplosionBlast = {
    radius: 0,
    force: 0,
    damage: 0,
    sourceKey: '',
    sourceType: 'system',
    sourceEntityId: NO_ENTITY_ID,
    center: { x: 0, y: 0, z: 0 },
  };
  private deathExplosionAreaDamageScratch: AreaDamageSource = {
    type: 'area',
    sourceEntityId: NO_ENTITY_ID,
    // Death blasts are neutral for broadphase filtering: they hit
    // friend and foe. Kill credit still resolves through sourceEntityId.
    ownerId: 0,
    damage: 0,
    excludeEntities: EMPTY_DEATH_EXPLOSION_EXCLUDES,
    center: this.deathExplosionBlastScratch.center,
    radius: 0,
    knockbackForce: 0,
  };

  /** Blasts resolved (radius, force, damage, centre, provenance captured
   *  while the dying entity still existed) but deferred past this tick's
   *  detonation cap, in breadth-first chain order. Drained FIFO at the head
   *  of the next tick's detonate() before that tick's own deaths. Derived
   *  lockstep state: never serialized, identical on every peer. */
  private pendingBlasts: DeathExplosionBlast[] = [];
  private pendingHead = 0;
  private budgetTick = -1;
  private budgetUsed = 0;

  constructor(
    private readonly world: WorldState,
    private readonly damageSystem: DamageSystem,
    private readonly forceAccumulator: ForceAccumulator,
  ) {}

  reset(): void {
    this.pendingBlasts.length = 0;
    this.pendingHead = 0;
    this.budgetTick = -1;
    this.budgetUsed = 0;
  }

  /** Blasts still waiting for a later tick (diagnostics / tests). */
  getPendingBlastCount(): number {
    return this.pendingBlasts.length - this.pendingHead;
  }

  /** Blasts detonated on `tick` (diagnostics / tests). */
  getDetonationsOnTick(tick: number): number {
    return tick === this.budgetTick ? this.budgetUsed : 0;
  }

  detonate(
    deadUnitIds: Set<EntityId>,
    deadBuildingIds: Set<EntityId>,
    audioEvents: SimEvent[],
    deathContexts: Map<EntityId, DeathContext>,
  ): void {
    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('SimulationDeathExplosionPlanner.detonate: sim-wasm is not initialized');
    }

    this.seed(sim, deadUnitIds, deadBuildingIds);
    const tick = this.world.getTick();
    if (tick !== this.budgetTick) {
      this.budgetTick = tick;
      this.budgetUsed = 0;
    }
    const cap = MAX_DEATH_EXPLOSIONS_PER_TICK;
    // 1) Blasts carried over from earlier ticks go first, in the order the
    //    chain produced them; their kills chain onto this tick's planner.
    while (this.pendingHead < this.pendingBlasts.length && this.budgetUsed < cap) {
      const blast = this.pendingBlasts[this.pendingHead++];
      this.budgetUsed++;
      this.applyBlast(sim, blast, deadUnitIds, deadBuildingIds, audioEvents, deathContexts);
    }
    if (this.pendingHead >= this.pendingBlasts.length) {
      this.pendingBlasts.length = 0;
      this.pendingHead = 0;
    }
    // 2) This tick's chain. Every row is resolved NOW (the entity is still
    //    in the world); rows past the cap are copied into the carry queue.
    for (;;) {
      const next = sim.deathExplosionPlannerNext(
        this.deathExplosionWorkEntityIdBuf,
        this.deathExplosionWorkKindBuf,
      );
      if (next === 0) break;
      if (next !== 1) {
        throw new Error(`SimulationDeathExplosionPlanner.detonate: invalid planner result ${next}`);
      }
      const id = this.deathExplosionWorkEntityIdBuf[0];
      const workKind = this.deathExplosionWorkKindBuf[0];
      if (
        workKind !== DEATH_EXPLOSION_WORK_KIND_UNIT &&
        workKind !== DEATH_EXPLOSION_WORK_KIND_BUILDING
      ) {
        throw new Error(`SimulationDeathExplosionPlanner.detonate: invalid planner work kind ${workKind}`);
      }
      const blast = this.deathExplosionBlastScratch;
      if (
        !this.writeEntityDeathExplosion(id, blast) ||
        blast.radius <= 0 ||
        (blast.damage <= 0 && blast.force <= 0)
      ) {
        continue;
      }
      if (this.budgetUsed >= cap) {
        this.pendingBlasts.push(cloneDeathExplosionBlast(blast));
        continue;
      }
      this.budgetUsed++;
      this.applyBlast(sim, blast, deadUnitIds, deadBuildingIds, audioEvents, deathContexts);
    }
  }

  private applyBlast(
    sim: SimWasm,
    blast: DeathExplosionBlast,
    deadUnitIds: Set<EntityId>,
    deadBuildingIds: Set<EntityId>,
    audioEvents: SimEvent[],
    deathContexts: Map<EntityId, DeathContext>,
  ): void {
    const areaDamage = this.deathExplosionAreaDamageScratch;
    areaDamage.sourceEntityId = blast.sourceEntityId;
    areaDamage.damage = blast.damage;
    areaDamage.radius = blast.radius;
    areaDamage.knockbackForce = blast.force;
    areaDamage.center = blast.center;
    const result = this.damageSystem.applyDeathExplosionDamage(areaDamage);
    this.forceAccumulator.addKnockbackForces(result.knockbacks);
    collectKillsAndDeathContexts(
      result,
      this.world,
      blast.sourceKey,
      blast.sourceType,
      deadUnitIds,
      deadBuildingIds,
      audioEvents,
      deathContexts,
      blast.sourceEntityId,
    );
    this.appendKills(
      sim,
      result.killedUnitIds,
      result.killedBuildingIds,
    );
  }

  private ensureIdCapacity(unitCount: number, buildingCount: number): void {
    if (unitCount > this.deathExplosionUnitIdsBuf.length) {
      let next = Math.max(16, this.deathExplosionUnitIdsBuf.length);
      while (next < unitCount) next *= 2;
      this.deathExplosionUnitIdsBuf = new Int32Array(next);
    }
    if (buildingCount > this.deathExplosionBuildingIdsBuf.length) {
      let next = Math.max(16, this.deathExplosionBuildingIdsBuf.length);
      while (next < buildingCount) next *= 2;
      this.deathExplosionBuildingIdsBuf = new Int32Array(next);
    }
  }

  private packIds(
    ids: Set<EntityId>,
    out: Int32Array,
  ): number {
    let count = 0;
    for (const id of ids) out[count++] = id;
    out.subarray(0, count).sort();
    return count;
  }

  private seed(
    sim: SimWasm,
    deadUnitIds: Set<EntityId>,
    deadBuildingIds: Set<EntityId>,
  ): void {
    this.ensureIdCapacity(deadUnitIds.size, deadBuildingIds.size);
    const unitCount = this.packIds(deadUnitIds, this.deathExplosionUnitIdsBuf);
    const buildingCount = this.packIds(deadBuildingIds, this.deathExplosionBuildingIdsBuf);
    sim.deathExplosionPlannerSeed(
      this.deathExplosionUnitIdsBuf.subarray(0, unitCount),
      this.deathExplosionBuildingIdsBuf.subarray(0, buildingCount),
    );
  }

  private appendKills(
    sim: SimWasm,
    killedUnitIds: Set<EntityId>,
    killedBuildingIds: Set<EntityId>,
  ): void {
    this.ensureIdCapacity(killedUnitIds.size, killedBuildingIds.size);
    const unitCount = this.packIds(killedUnitIds, this.deathExplosionUnitIdsBuf);
    const buildingCount = this.packIds(killedBuildingIds, this.deathExplosionBuildingIdsBuf);
    sim.deathExplosionPlannerAppendKills(
      this.deathExplosionUnitIdsBuf.subarray(0, unitCount),
      this.deathExplosionBuildingIdsBuf.subarray(0, buildingCount),
    );
  }

  private writeEntityDeathExplosion(
    id: EntityId,
    out: DeathExplosionBlast,
  ): boolean {
    const entity = this.world.getEntity(id);
    if (entity === undefined) {
      return false;
    }
    if (entity.unit !== null) {
      const unitBlueprintId = entity.unit.unitBlueprintId;
      const blast = getUnitBlueprint(unitBlueprintId).base.deathExplosion;
      out.radius = blast.radius;
      out.force = blast.force;
      out.damage = blast.damage;
      out.sourceKey = unitBlueprintId;
      out.sourceType = 'unit';
      out.sourceEntityId = entity.id;
      out.center.x = entity.transform.x;
      out.center.y = entity.transform.y;
      out.center.z = entity.transform.z;
      return true;
    }
    if (entity.building !== null && entity.buildingBlueprintId !== null) {
      const buildingBlueprintId = entity.buildingBlueprintId;
      const blast = getBuildingBlueprint(buildingBlueprintId).base.deathExplosion;
      out.radius = blast.radius;
      out.force = blast.force;
      out.damage = blast.damage;
      out.sourceKey = buildingBlueprintId;
      out.sourceType = 'building';
      out.sourceEntityId = entity.id;
      out.center.x = entity.transform.x;
      out.center.y = entity.transform.y;
      // Hovering buildings die at their floating combat center — units
      // sheltering underneath must not eat a ground-level blast (grounded
      // buildings: combat center == transform.z, unchanged).
      out.center.z = getBuildingCombatCenterZ(entity);
      return true;
    }
    return false;
  }
}
