import { ENTITY_CHANGED_TURRETS } from '@/types/network';
import { getSimWasm } from '../sim-wasm/init';
import {
  checkProjectileCollisions,
  emitLaserStopsForEntity,
  emitLaserStopsForTarget,
  emitShieldStopsForEntity,
  fireTurrets,
  registerPackedProjectile,
  resetLaserSoundState,
  resetShieldBuffers,
  resetShieldSoundState,
  type DeathContext,
  type SimEvent,
  unregisterPackedProjectile,
  updateLaserSounds,
  updateProjectiles,
  updateShieldSounds,
  updateShieldState,
  updateTargetingAndFiringState,
  updateTurretRotation,
} from './combat';
import {
  stampCombatTargetingPool,
  stampShieldSurfacePool,
} from './combat/targetingInputStamping';
import type { DamageSystem } from './damage';
import type { ForceAccumulator } from './ForceAccumulator';
import type { SimulationDeathExplosionPlanner } from './SimulationDeathExplosionPlanner';
import {
  safeVelocityUpdates,
  type SimulationEventQueues,
} from './SimulationEventQueues';
import { spatialGrid } from './SpatialGrid';
import type { EntityId } from './types';
import type { WorldState } from './WorldState';

type SimEventCallback = ((event: SimEvent) => void) | null;
type UnitDeathCallback = (
  (deadUnitIds: EntityId[], deathContexts: Map<EntityId, DeathContext> | null) => void
) | null;
type BuildingDeathCallback = ((deadBuildingIds: EntityId[]) => void) | null;

export class SimulationCombatController {
  private readonly world: WorldState;
  private readonly damageSystem: DamageSystem;
  private readonly forceAccumulator: ForceAccumulator;
  private readonly eventQueues: SimulationEventQueues;
  private readonly deathExplosionPlanner: SimulationDeathExplosionPlanner;
  private readonly deadUnitIdsBuf: EntityId[] = [];
  private readonly deadBuildingIdsBuf: EntityId[] = [];

  constructor(
    world: WorldState,
    damageSystem: DamageSystem,
    forceAccumulator: ForceAccumulator,
    eventQueues: SimulationEventQueues,
    deathExplosionPlanner: SimulationDeathExplosionPlanner,
  ) {
    this.world = world;
    this.damageSystem = damageSystem;
    this.forceAccumulator = forceAccumulator;
    this.eventQueues = eventQueues;
    this.deathExplosionPlanner = deathExplosionPlanner;
  }

  update(
    dtMs: number,
    onSimEvent: SimEventCallback,
    onUnitDeath: UnitDeathCallback,
    onBuildingDeath: BuildingDeathCallback,
  ): void {
    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('SimulationCombatController.update: sim-wasm is not initialized');
    }
    sim.deathExplosionPlannerReset();

    // AIM-08.5 — rebuild targeting slabs before the FSM. The targeting
    // pass mutates the slab through Rust transition kernels and writes
    // those results back to JS turrets for the remaining consumers.
    // The shield surface pool is NOT restamped here: it still holds the
    // end-of-previous-tick stamp (made after updateShieldState below),
    // which is exactly the one-tick-stale envelope the FSM's shield
    // clearance gates are documented to read. Sight-toggle gating lives
    // in the kernels (shield_obstruction_active + shape toggles), not
    // in slab emptiness.
    stampCombatTargetingPool(this.world);
    // Update targeting and firing state. Cooldown timers now step inside
    // the scheduled Rust targeting batch and write back through the
    // transitional slab -> JS turret copy.
    const activeCombatUnits = updateTargetingAndFiringState(this.world, dtMs);

    // Update laser sounds based on targeting state (every frame)
    if (this.world.getBeamUnits().length > 0) {
      this.emitSimEvents(updateLaserSounds(this.world), onSimEvent);
    }

    // Update turret rotation (before firing, so weapons fire in turret direction)
    updateTurretRotation(this.world, dtMs, activeCombatUnits);

    // Update shield state before projectile emission. Aimed tube shields
    // are one turret with two emissions: the physical tube and the
    // sprayed payload both derive from the same engaged lock this tick.
    const shieldUnits = this.world.turretShieldSpheresEnabled
      ? this.world.getShieldUnits()
      : undefined;
    if (shieldUnits && shieldUnits.length > 0) {
      updateShieldState(this.world, dtMs);
    } else {
      resetShieldBuffers();
    }

    // The single per-tick shield surface stamp. Placed right after
    // updateShieldState so beam tracing, projectile reflection, and fog
    // sightlines later this tick read current-tick physical surfaces,
    // while next tick's FSM clearance gates read it one tick stale —
    // the same envelopes the old pre-FSM + pre-projectile double stamp
    // provided. Physical surfaces are always stamped; whether targeting
    // treats them as lock blockers is the kernels' flag-gated decision.
    stampShieldSurfacePool(this.world);

    // Update shield sounds based on the just-written transition progress.
    if (shieldUnits && shieldUnits.length > 0) {
      this.emitSimEvents(updateShieldSounds(shieldUnits), onSimEvent);
    }

    // Fire weapons and create projectiles (with recoil force for projectiles)
    const fireResult = fireTurrets(this.world, dtMs, this.forceAccumulator, activeCombatUnits);
    fireResult.projectiles.sort((a, b) => a.id - b.id);
    fireResult.spawnEvents.sort((a, b) => a.id - b.id);
    for (const proj of fireResult.projectiles) {
      this.world.addEntity(proj);
      registerPackedProjectile(proj);
    }

    // Collect projectile spawn events
    for (const event of fireResult.spawnEvents) {
      this.eventQueues.projectileSpawns.push(event);
    }

    // Emit fire audio events
    this.emitSimEvents(fireResult.events, onSimEvent);

    for (const unit of activeCombatUnits) {
      this.world.markSnapshotDirty(unit.id, ENTITY_CHANGED_TURRETS);
    }

    // Update projectile positions and remove orphaned beams (from dead units)
    if (this.world.getProjectiles().length > 0) {
      this.updateProjectileCombat(dtMs, onSimEvent, onUnitDeath, onBuildingDeath);
    }
  }

  reset(): void {
    this.deadUnitIdsBuf.length = 0;
    this.deadBuildingIdsBuf.length = 0;
    resetShieldBuffers();
    resetLaserSoundState();
    resetShieldSoundState();
  }

  private updateProjectileCombat(
    dtMs: number,
    onSimEvent: SimEventCallback,
    onUnitDeath: UnitDeathCallback,
    onBuildingDeath: BuildingDeathCallback,
  ): void {
    const updateResult = updateProjectiles(this.world, dtMs, this.damageSystem);
    updateResult.orphanedIds.sort((a, b) => a - b);
    updateResult.despawnEvents.sort((a, b) => a.id - b.id);
    for (const id of updateResult.orphanedIds) {
      unregisterPackedProjectile(id);
      spatialGrid.removeProjectile(id);
      this.world.removeEntity(id);
    }
    for (const event of updateResult.despawnEvents) {
      unregisterPackedProjectile(event.id);
      spatialGrid.removeProjectile(event.id);
      this.eventQueues.projectileDespawns.push(event);
    }
    // Collect homing projectile velocity updates
    for (const event of safeVelocityUpdates(updateResult.velocityUpdates)) {
      this.eventQueues.projectileVelocityUpdates.set(event.id, event);
    }

    // Refresh projectile broadphase after integration. The frame-level
    // spatial update ran before combat, so projectile-vs-projectile
    // hitbox checks need the post-move positions here.
    spatialGrid.updateProjectiles(this.world.getTravelingProjectiles());

    // Check projectile collisions and get dead units
    const collisionResult = checkProjectileCollisions(
      this.world,
      dtMs,
      this.damageSystem,
      this.forceAccumulator,
    );

    // Add submunition / cluster projectiles spawned at explosion points,
    // and mirror their spawn events to the network queue so clients see
    // them the same way they see any freshly-fired round.
    collisionResult.newProjectiles.sort((a, b) => a.id - b.id);
    collisionResult.spawnEvents.sort((a, b) => a.id - b.id);
    for (const proj of collisionResult.newProjectiles) {
      this.world.addEntity(proj);
      registerPackedProjectile(proj);
    }
    for (const event of collisionResult.spawnEvents) {
      this.eventQueues.projectileSpawns.push(event);
    }

    // Collect projectile despawn events from collisions
    collisionResult.despawnEvents.sort((a, b) => a.id - b.id);
    for (const event of collisionResult.despawnEvents) {
      unregisterPackedProjectile(event.id);
      spatialGrid.removeProjectile(event.id);
      this.eventQueues.projectileDespawns.push(event);
    }
    for (const event of safeVelocityUpdates(collisionResult.velocityUpdates)) {
      this.eventQueues.projectileVelocityUpdates.set(event.id, event);
    }

    this.deathExplosionPlanner.detonate(
      collisionResult.deadUnitIds,
      collisionResult.deadBuildingIds,
      collisionResult.events,
      collisionResult.deathContexts,
    );

    // Emit hit/death audio events
    this.emitSimEvents(collisionResult.events, onSimEvent);

    // Remove dead entities from spatial grid and notify callbacks
    this.removeCollisionDeadUnits(
      collisionResult.deadUnitIds,
      collisionResult.deathContexts,
      onUnitDeath,
    );
    this.removeCollisionDeadBuildings(collisionResult.deadBuildingIds, onBuildingDeath);
  }

  private removeCollisionDeadUnits(
    deadUnitIds: Set<EntityId>,
    deathContexts: Map<EntityId, DeathContext>,
    onUnitDeath: UnitDeathCallback,
  ): void {
    if (deadUnitIds.size === 0) return;
    const buf = this.deadUnitIdsBuf;
    buf.length = 0;
    for (const id of [...deadUnitIds].sort((a, b) => a - b)) {
      const entity = this.world.getEntity(id);
      if (entity) {
        // Emit laserStop for the dying entity's own beam weapons
        for (const evt of emitLaserStopsForEntity(entity)) {
          this.eventQueues.simEvents.push(evt);
        }
        // Emit laserStop for any beam weapons across the world targeting this entity
        for (const evt of emitLaserStopsForTarget(this.world, id)) {
          this.eventQueues.simEvents.push(evt);
        }
        // Emit shieldStop for the dying entity's shield weapons
        for (const evt of emitShieldStopsForEntity(entity)) {
          this.eventQueues.simEvents.push(evt);
        }
      }
      spatialGrid.removeUnit(id);
      buf.push(id);
    }
    if (onUnitDeath !== null) onUnitDeath(buf, deathContexts);
  }

  private removeCollisionDeadBuildings(
    deadBuildingIds: Set<EntityId>,
    onBuildingDeath: BuildingDeathCallback,
  ): void {
    if (deadBuildingIds.size === 0) return;
    const buf = this.deadBuildingIdsBuf;
    buf.length = 0;
    for (const id of [...deadBuildingIds].sort((a, b) => a - b)) {
      spatialGrid.removeBuilding(id);
      buf.push(id);
    }
    if (onBuildingDeath !== null) onBuildingDeath(buf);
  }

  private emitSimEvents(events: readonly SimEvent[], onSimEvent: SimEventCallback): void {
    for (const event of events) {
      if (onSimEvent !== null) onSimEvent(event);
      this.eventQueues.simEvents.push(event);
    }
  }
}
