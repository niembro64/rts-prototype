import { ENTITY_CHANGED_TURRETS } from '@/types/network';
import {
  resetTurretSnapshotDirtyCache,
  turretSnapshotRowsChangedSinceLastSample,
} from '../network/turretSnapshotDirty';
import { getSimWasm } from '../sim-wasm/init';
import {
  checkProjectileCollisions,
  collectTurretRotationUnits,
  emitLaserStopsForEntity,
  emitLaserStopsForTarget,
  emitShieldStopsForEntity,
  fireTurrets,
  hasPendingProjectileLaunchVelocityFinalization,
  registerPackedProjectile,
  resetLaserSoundState,
  resetShieldBuffers,
  resetShieldSoundState,
  type DeathContext,
  type ProjectileMotionUpdateEvent,
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
import { updateAuthoritativeHostAttachmentKinematics } from './combat/combatUtils';
import { SIM_TICK_INSTRUMENTATION } from '../perf/SimTickInstrumentation';
import type { DamageSystem } from './damage';
import type { ForceAccumulator } from './ForceAccumulator';
import type { SimulationDeathExplosionPlanner } from './SimulationDeathExplosionPlanner';
import type { SimulationEventQueues } from './SimulationEventQueues';
import { spatialGrid } from './SpatialGrid';
import type { EntityId } from './types';
import type { WindState } from './wind';
import type { WorldState } from './WorldState';

// Hoisted determinism-ordering comparators: these sorts run every tick,
// and an inline arrow would allocate a closure per call.
const byEntityIdField = (a: { id: number }, b: { id: number }): number => a.id - b.id;
const byNumberAscending = (a: number, b: number): number => a - b;

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
  private readonly projectileMotionEvents = new Map<EntityId, ProjectileMotionUpdateEvent>();

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
    wind: WindState,
    onSimEvent: SimEventCallback,
    onUnitDeath: UnitDeathCallback,
    onBuildingDeath: BuildingDeathCallback,
  ): void {
    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('SimulationCombatController.update: sim-wasm is not initialized');
    }
    sim.deathExplosionPlannerReset();

    const armedUnits = this.world.getArmedEntities();
    updateAuthoritativeHostAttachmentKinematics(
      armedUnits,
      this.world.getTick(),
      dtMs,
      'tickStart',
    );

    // AIM-08.5 — rebuild targeting slabs before the FSM. The targeting
    // pass mutates the slab through Rust transition kernels and writes
    // those results back to JS turrets for the remaining consumers.
    // The shield surface pool is NOT restamped here: it still holds the
    // end-of-previous-tick stamp (made after updateShieldState below),
    // which is exactly the one-tick-stale envelope the FSM's shield
    // clearance gates are documented to read. Sight-toggle gating lives
    // in the kernels (shield_obstruction_active + shape toggles), not
    // in slab emptiness.
    stampCombatTargetingPool(this.world, wind);
    SIM_TICK_INSTRUMENTATION.phase('combat.targetingStamp');
    // Update targeting and firing state. Cooldown timers now step inside
    // the scheduled Rust targeting batch and write back through the
    // transitional slab -> JS turret copy.
    const activeCombatUnits = updateTargetingAndFiringState(this.world, dtMs);
    SIM_TICK_INSTRUMENTATION.phase('combat.targetingFsm');

    // Update laser sounds based on targeting state (every frame)
    if (this.world.getBeamUnits().length > 0) {
      this.emitSimEvents(updateLaserSounds(this.world), onSimEvent);
    }
    SIM_TICK_INSTRUMENTATION.phase('combat.laserSounds');

    // QueryWork already arbitrated and stepped shared moving parents once at
    // the start of this fixed tick. Targeting above publishes weapon intent
    // for the next parent tick; solve weapon children in the current parent
    // frame without double-integrating a heavy torso.
    const turretRotationUnits = collectTurretRotationUnits(this.world, activeCombatUnits);
    updateTurretRotation(this.world, dtMs, turretRotationUnits);
    updateAuthoritativeHostAttachmentKinematics(
      armedUnits,
      this.world.getTick(),
      dtMs,
      'postAim',
    );
    SIM_TICK_INSTRUMENTATION.phase('combat.turretRotation');

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
    SIM_TICK_INSTRUMENTATION.phase('combat.shields');

    // Fire weapons and create projectiles (with recoil force for projectiles)
    const fireResult = fireTurrets(
      this.world,
      dtMs,
      this.damageSystem,
      this.forceAccumulator,
      activeCombatUnits,
    );
    fireResult.projectiles.sort(byEntityIdField);
    fireResult.spawnEvents.sort(byEntityIdField);
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

    // Host-piece servos keep settling after their weapon FSM goes idle, so
    // snapshot dirtiness must sample every armed host rather than only the
    // subset whose logical turret aim was active this tick.
    for (const unit of armedUnits) {
      if (turretSnapshotRowsChangedSinceLastSample(unit)) {
        this.world.markSnapshotDirty(unit.id, ENTITY_CHANGED_TURRETS);
      }
    }
    SIM_TICK_INSTRUMENTATION.phase('combat.fireTurrets');

    // Update projectile positions and remove orphaned beams (from dead units)
    if (this.world.getProjectiles().length > 0) {
      this.updateProjectileCombat(dtMs, wind, onSimEvent, onUnitDeath, onBuildingDeath);
    }
    SIM_TICK_INSTRUMENTATION.phase('combat.projectiles');
  }

  reset(): void {
    this.deadUnitIdsBuf.length = 0;
    this.deadBuildingIdsBuf.length = 0;
    this.projectileMotionEvents.clear();
    resetShieldBuffers();
    resetLaserSoundState();
    resetShieldSoundState();
    resetTurretSnapshotDirtyCache();
  }

  private updateProjectileCombat(
    dtMs: number,
    wind: WindState,
    onSimEvent: SimEventCallback,
    onUnitDeath: UnitDeathCallback,
    onBuildingDeath: BuildingDeathCallback,
  ): void {
    const updateResult = updateProjectiles(this.world, dtMs, this.damageSystem, wind);
    updateResult.orphanedIds.sort(byNumberAscending);
    updateResult.despawnEvents.sort(byEntityIdField);
    for (const id of updateResult.orphanedIds) {
      unregisterPackedProjectile(id);
      spatialGrid.removeProjectile(id);
      this.world.removeEntity(id);
    }
    for (const event of updateResult.despawnEvents) {
      unregisterPackedProjectile(event.id);
      spatialGrid.removeProjectile(event.id);
      this.eventQueues.projectileDespawns.push(event);
      this.projectileMotionEvents.delete(event.id);
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
      hasPendingProjectileLaunchVelocityFinalization,
    );

    // Add submunition / cluster projectiles spawned at explosion points,
    // and mirror their spawn events to the network queue so clients see
    // them the same way they see any freshly-fired round.
    collisionResult.newProjectiles.sort(byEntityIdField);
    collisionResult.spawnEvents.sort(byEntityIdField);
    for (const proj of collisionResult.newProjectiles) {
      this.world.addEntity(proj);
      registerPackedProjectile(proj);
    }
    for (const event of collisionResult.spawnEvents) {
      this.eventQueues.projectileSpawns.push(event);
    }

    // Collect projectile despawn events from collisions
    collisionResult.despawnEvents.sort(byEntityIdField);
    for (const event of collisionResult.despawnEvents) {
      unregisterPackedProjectile(event.id);
      spatialGrid.removeProjectile(event.id);
      this.eventQueues.projectileDespawns.push(event);
      this.projectileMotionEvents.delete(event.id);
    }

    // Lockstep presentation reads the final authoritative state after the
    // whole fixed tick, including reflections and collision-spawned shots.
    // Reuse one event object per live projectile to avoid per-tick object
    // churn while still coalescing by entity id in the presentation queue.
    for (const entity of this.world.getTravelingProjectiles()) {
      const projectile = entity.projectile;
      if (projectile === null) continue;
      let event = this.projectileMotionEvents.get(entity.id);
      if (event === undefined) {
        event = {
          id: entity.id,
          pos: { x: 0, y: 0, z: 0 },
          velocity: { x: 0, y: 0, z: 0 },
          rotation: 0,
          angularVelocity: 0,
          ownerId: projectile.ownerId,
        };
        this.projectileMotionEvents.set(entity.id, event);
      }
      event.pos.x = entity.transform.x;
      event.pos.y = entity.transform.y;
      event.pos.z = entity.transform.z;
      event.velocity.x = projectile.velocityX;
      event.velocity.y = projectile.velocityY;
      event.velocity.z = projectile.velocityZ;
      event.rotation = entity.transform.rotation;
      event.angularVelocity = projectile.angularVelocity;
      event.ownerId = projectile.ownerId;
      this.eventQueues.projectileMotionUpdates.set(entity.id, event);
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
    for (const id of deadUnitIds) buf.push(id);
    buf.sort(byNumberAscending);
    for (let i = 0; i < buf.length; i++) {
      const id = buf[i];
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
    for (const id of deadBuildingIds) buf.push(id);
    buf.sort(byNumberAscending);
    for (let i = 0; i < buf.length; i++) {
      const id = buf[i];
      spatialGrid.removeBuilding(id);
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
