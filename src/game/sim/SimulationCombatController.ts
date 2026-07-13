import { ENTITY_CHANGED_TURRETS } from '@/types/network';
import {
  resetTurretSnapshotDirtyCache,
  turretSnapshotRowsChangedSinceLastSample,
} from '../network/turretSnapshotDirty';
import { getSimWasm } from '../sim-wasm/init';
import {
  checkProjectileCollisions,
  emitLaserStopsForEntity,
  emitLaserStopsForTargetRefs,
  emitShieldStopsForEntity,
  fireTurrets,
  getLaserStopRefsForTargets,
  hasPendingProjectileLaunchVelocityFinalization,
  registerPackedProjectile,
  resetLaserSoundState,
  resetShieldBuffers,
  resetShieldSoundState,
  type DeathContext,
  type ProjectileUpdatePhaseTimings,
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
  clearCombatTargetingStampQueues,
  stampCombatTargetingPool,
  stampShieldSurfacePool,
} from './combat/targetingInputStamping';
import type { ProjectileCollisionPhaseTimings } from './combat/ProjectileCollisionHandler';
import type { DamageSystem } from './damage';
import type { ForceAccumulator } from './ForceAccumulator';
import type { SimulationDeathExplosionPlanner } from './SimulationDeathExplosionPlanner';
import {
  safeVelocityUpdates,
  type SimulationEventQueues,
} from './SimulationEventQueues';
import { spatialGrid } from './SpatialGrid';
import type { EntityId } from './types';
import type { WindState } from './wind';
import type { WorldState } from './WorldState';

type SimEventCallback = ((event: SimEvent) => void) | null;
type UnitDeathCallback = (
  (deadUnitIds: EntityId[], deathContexts: Map<EntityId, DeathContext> | null) => void
) | null;
type BuildingDeathCallback = ((deadBuildingIds: EntityId[]) => void) | null;

export type SimulationCombatPhaseTimings = {
  readonly resetPlannerMs: number;
  readonly stampTargetingMs: number;
  readonly targetingFiringMs: number;
  readonly laserSoundsMs: number;
  readonly turretRotationMs: number;
  readonly shieldStateMs: number;
  readonly shieldSurfaceStampMs: number;
  readonly shieldSoundsMs: number;
  readonly fireTurretsMs: number;
  readonly projectileSpawnEventsMs: number;
  readonly turretDirtyMs: number;
  readonly updateProjectilesMs: number;
  readonly projectilePackedPrepMs: number;
  readonly projectilePackedIntegrateMs: number;
  readonly projectilePackedScatterMs: number;
  readonly projectileTravelingPackMs: number;
  readonly projectileHomingGuidanceMs: number;
  readonly projectileTravelingIntegrateMs: number;
  readonly projectileTravelingScatterMs: number;
  readonly projectileLineProjectilesMs: number;
  readonly projectileLineBeamPathMs: number;
  readonly projectileLineBeamFusedMs: number;
  readonly projectileLineBeamBodyMs: number;
  readonly projectileLineBeamReflectorMs: number;
  readonly projectileLineBeamGroundMs: number;
  readonly projectileLineBeamProjectileMs: number;
  readonly projectileEventCullMs: number;
  readonly projectileSpatialRefreshMs: number;
  readonly projectileCollisionsMs: number;
  readonly collisionSetupMs: number;
  readonly collisionLoopMs: number;
  readonly collisionHitboxSweepMs: number;
  readonly collisionBeamDamageMs: number;
  readonly collisionDgunDamageMs: number;
  readonly collisionTerminalPlanMs: number;
  readonly collisionSplashDamageMs: number;
  readonly collisionKilledProjectileDetonationMs: number;
  readonly collisionSubmunitionSpawnMs: number;
  readonly collisionFinalRemovalMs: number;
  readonly collisionProjectileEventsMs: number;
  readonly deathExplosionMs: number;
  readonly collisionRemovalMs: number;
  readonly totalMs: number;
};

type ProjectileUpdatePhaseTimingKey =
  | 'projectilePackedPrepMs'
  | 'projectilePackedIntegrateMs'
  | 'projectilePackedScatterMs'
  | 'projectileTravelingPackMs'
  | 'projectileHomingGuidanceMs'
  | 'projectileTravelingIntegrateMs'
  | 'projectileTravelingScatterMs'
  | 'projectileLineProjectilesMs'
  | 'projectileLineBeamPathMs'
  | 'projectileLineBeamFusedMs'
  | 'projectileLineBeamBodyMs'
  | 'projectileLineBeamReflectorMs'
  | 'projectileLineBeamGroundMs'
  | 'projectileLineBeamProjectileMs';

function worldHasHostileCombatTargets(world: WorldState): boolean {
  const targets = world.getCombatTargetEntities();
  let firstTeamId = -1;
  for (let i = 0; i < targets.length; i++) {
    const ownership = targets[i].ownership;
    if (ownership === null) return true;
    const teamId = world.getTeamId(ownership.playerId);
    if (firstTeamId < 0) {
      firstTeamId = teamId;
    } else if (teamId !== firstTeamId) {
      return true;
    }
  }
  return false;
}

function createEmptyProjectileCollisionPhaseTimings(): ProjectileCollisionPhaseTimings {
  return {
    collisionSetupMs: 0,
    collisionLoopMs: 0,
    collisionHitboxSweepMs: 0,
    collisionBeamDamageMs: 0,
    collisionDgunDamageMs: 0,
    collisionTerminalPlanMs: 0,
    collisionSplashDamageMs: 0,
    collisionKilledProjectileDetonationMs: 0,
    collisionSubmunitionSpawnMs: 0,
    collisionFinalRemovalMs: 0,
  };
}

function createEmptyProjectileUpdatePhaseTimings(): ProjectileUpdatePhaseTimings {
  return {
    projectilePackedPrepMs: 0,
    projectilePackedIntegrateMs: 0,
    projectilePackedScatterMs: 0,
    projectileTravelingPackMs: 0,
    projectileHomingGuidanceMs: 0,
    projectileTravelingIntegrateMs: 0,
    projectileTravelingScatterMs: 0,
    projectileLineProjectilesMs: 0,
    projectileLineBeamPathMs: 0,
    projectileLineBeamFusedMs: 0,
    projectileLineBeamBodyMs: 0,
    projectileLineBeamReflectorMs: 0,
    projectileLineBeamGroundMs: 0,
    projectileLineBeamProjectileMs: 0,
  };
}

export class SimulationCombatController {
  private readonly world: WorldState;
  private readonly damageSystem: DamageSystem;
  private readonly forceAccumulator: ForceAccumulator;
  private readonly eventQueues: SimulationEventQueues;
  private readonly deathExplosionPlanner: SimulationDeathExplosionPlanner;
  private readonly deadUnitIdsBuf: EntityId[] = [];
  private readonly deadBuildingIdsBuf: EntityId[] = [];
  private profiler: ((timings: SimulationCombatPhaseTimings) => void) | undefined;
  private hadHostileCombatTargetsLastTick = true;

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
    const profiler = this.profiler;
    if (profiler !== undefined) {
      this.updateProfiled(dtMs, wind, onSimEvent, onUnitDeath, onBuildingDeath, profiler);
      return;
    }

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
    if (this.shouldSkipCombatTargetingStamp()) {
      clearCombatTargetingStampQueues();
    } else {
      stampCombatTargetingPool(this.world, wind);
    }
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
      if (turretSnapshotRowsChangedSinceLastSample(unit)) {
        this.world.markSnapshotDirty(unit.id, ENTITY_CHANGED_TURRETS);
      }
    }

    // Update projectile positions and remove orphaned beams (from dead units)
    if (this.world.getProjectiles().length > 0) {
      this.updateProjectileCombat(dtMs, wind, onSimEvent, onUnitDeath, onBuildingDeath);
    }
  }

  setProfiler(profiler: ((timings: SimulationCombatPhaseTimings) => void) | undefined): void {
    this.profiler = profiler;
  }

  reset(): void {
    this.deadUnitIdsBuf.length = 0;
    this.deadBuildingIdsBuf.length = 0;
    resetShieldBuffers();
    resetLaserSoundState();
    resetShieldSoundState();
    resetTurretSnapshotDirtyCache();
    this.hadHostileCombatTargetsLastTick = true;
  }

  private shouldSkipCombatTargetingStamp(): boolean {
    if (this.world.getProjectiles().length > 0) return false;
    if (worldHasHostileCombatTargets(this.world)) {
      this.hadHostileCombatTargetsLastTick = true;
      return false;
    }
    if (this.hadHostileCombatTargetsLastTick) {
      this.hadHostileCombatTargetsLastTick = false;
      return false;
    }
    return true;
  }

  private updateProfiled(
    dtMs: number,
    wind: WindState,
    onSimEvent: SimEventCallback,
    onUnitDeath: UnitDeathCallback,
    onBuildingDeath: BuildingDeathCallback,
    profiler: (timings: SimulationCombatPhaseTimings) => void,
  ): void {
    const start = performance.now();
    let mark = start;

    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('SimulationCombatController.update: sim-wasm is not initialized');
    }
    sim.deathExplosionPlannerReset();
    let now = performance.now();
    const resetPlannerMs = now - mark;
    mark = now;

    if (this.shouldSkipCombatTargetingStamp()) {
      clearCombatTargetingStampQueues();
    } else {
      stampCombatTargetingPool(this.world, wind);
    }
    now = performance.now();
    const stampTargetingMs = now - mark;
    mark = now;

    const activeCombatUnits = updateTargetingAndFiringState(this.world, dtMs);
    now = performance.now();
    const targetingFiringMs = now - mark;
    mark = now;

    if (this.world.getBeamUnits().length > 0) {
      this.emitSimEvents(updateLaserSounds(this.world), onSimEvent);
    }
    now = performance.now();
    const laserSoundsMs = now - mark;
    mark = now;

    updateTurretRotation(this.world, dtMs, activeCombatUnits);
    now = performance.now();
    const turretRotationMs = now - mark;
    mark = now;

    const shieldUnits = this.world.turretShieldSpheresEnabled
      ? this.world.getShieldUnits()
      : undefined;
    if (shieldUnits && shieldUnits.length > 0) {
      updateShieldState(this.world, dtMs);
    } else {
      resetShieldBuffers();
    }
    now = performance.now();
    const shieldStateMs = now - mark;
    mark = now;

    stampShieldSurfacePool(this.world);
    now = performance.now();
    const shieldSurfaceStampMs = now - mark;
    mark = now;

    if (shieldUnits && shieldUnits.length > 0) {
      this.emitSimEvents(updateShieldSounds(shieldUnits), onSimEvent);
    }
    now = performance.now();
    const shieldSoundsMs = now - mark;
    mark = now;

    const fireResult = fireTurrets(this.world, dtMs, this.forceAccumulator, activeCombatUnits);
    fireResult.projectiles.sort((a, b) => a.id - b.id);
    fireResult.spawnEvents.sort((a, b) => a.id - b.id);
    now = performance.now();
    const fireTurretsMs = now - mark;
    mark = now;

    for (const proj of fireResult.projectiles) {
      this.world.addEntity(proj);
      registerPackedProjectile(proj);
    }
    for (const event of fireResult.spawnEvents) {
      this.eventQueues.projectileSpawns.push(event);
    }
    this.emitSimEvents(fireResult.events, onSimEvent);
    now = performance.now();
    const projectileSpawnEventsMs = now - mark;
    mark = now;

    for (const unit of activeCombatUnits) {
      if (turretSnapshotRowsChangedSinceLastSample(unit)) {
        this.world.markSnapshotDirty(unit.id, ENTITY_CHANGED_TURRETS);
      }
    }
    now = performance.now();
    const turretDirtyMs = now - mark;
    mark = now;

    let updateProjectilesMs = 0;
    let projectileUpdateDetails = createEmptyProjectileUpdatePhaseTimings();
    let projectileEventCullMs = 0;
    let projectileSpatialRefreshMs = 0;
    let projectileCollisionsMs = 0;
    let collisionDetails = createEmptyProjectileCollisionPhaseTimings();
    let collisionProjectileEventsMs = 0;
    let deathExplosionMs = 0;
    let collisionRemovalMs = 0;
    if (this.world.getProjectiles().length > 0) {
      const projectileTimings = this.updateProjectileCombatProfiled(
        dtMs,
        wind,
        onSimEvent,
        onUnitDeath,
        onBuildingDeath,
      );
      updateProjectilesMs = projectileTimings.updateProjectilesMs;
      projectileUpdateDetails = projectileTimings;
      projectileEventCullMs = projectileTimings.projectileEventCullMs;
      projectileSpatialRefreshMs = projectileTimings.projectileSpatialRefreshMs;
      projectileCollisionsMs = projectileTimings.projectileCollisionsMs;
      collisionDetails = projectileTimings;
      collisionProjectileEventsMs = projectileTimings.collisionProjectileEventsMs;
      deathExplosionMs = projectileTimings.deathExplosionMs;
      collisionRemovalMs = projectileTimings.collisionRemovalMs;
    }
    now = performance.now();

    profiler({
      resetPlannerMs,
      stampTargetingMs,
      targetingFiringMs,
      laserSoundsMs,
      turretRotationMs,
      shieldStateMs,
      shieldSurfaceStampMs,
      shieldSoundsMs,
      fireTurretsMs,
      projectileSpawnEventsMs,
      turretDirtyMs,
      updateProjectilesMs,
      ...projectileUpdateDetails,
      projectileEventCullMs,
      projectileSpatialRefreshMs,
      projectileCollisionsMs,
      ...collisionDetails,
      collisionProjectileEventsMs,
      deathExplosionMs,
      collisionRemovalMs,
      totalMs: now - start,
    });
  }

  private updateProjectileCombat(
    dtMs: number,
    wind: WindState,
    onSimEvent: SimEventCallback,
    onUnitDeath: UnitDeathCallback,
    onBuildingDeath: BuildingDeathCallback,
  ): void {
    const updateResult = updateProjectiles(this.world, dtMs, this.damageSystem, wind);
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
      hasPendingProjectileLaunchVelocityFinalization,
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

  private updateProjectileCombatProfiled(
    dtMs: number,
    wind: WindState,
    onSimEvent: SimEventCallback,
    onUnitDeath: UnitDeathCallback,
    onBuildingDeath: BuildingDeathCallback,
  ): Pick<
    SimulationCombatPhaseTimings,
    | 'updateProjectilesMs'
    | ProjectileUpdatePhaseTimingKey
    | 'projectileEventCullMs'
    | 'projectileSpatialRefreshMs'
    | 'projectileCollisionsMs'
    | keyof ProjectileCollisionPhaseTimings
    | 'collisionProjectileEventsMs'
    | 'deathExplosionMs'
    | 'collisionRemovalMs'
  > {
    let mark = performance.now();

    const projectileUpdateDetails = createEmptyProjectileUpdatePhaseTimings();
    const updateResult = updateProjectiles(
      this.world,
      dtMs,
      this.damageSystem,
      wind,
      projectileUpdateDetails,
    );
    let now = performance.now();
    const updateProjectilesMs = now - mark;
    mark = now;

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
    for (const event of safeVelocityUpdates(updateResult.velocityUpdates)) {
      this.eventQueues.projectileVelocityUpdates.set(event.id, event);
    }
    now = performance.now();
    const projectileEventCullMs = now - mark;
    mark = now;

    spatialGrid.updateProjectiles(this.world.getTravelingProjectiles());
    now = performance.now();
    const projectileSpatialRefreshMs = now - mark;
    mark = now;

    let collisionDetails = createEmptyProjectileCollisionPhaseTimings();
    const collisionResult = checkProjectileCollisions(
      this.world,
      dtMs,
      this.damageSystem,
      this.forceAccumulator,
      hasPendingProjectileLaunchVelocityFinalization,
      (timings) => {
        collisionDetails = timings;
      },
    );
    now = performance.now();
    const projectileCollisionsMs = now - mark;
    mark = now;

    collisionResult.newProjectiles.sort((a, b) => a.id - b.id);
    collisionResult.spawnEvents.sort((a, b) => a.id - b.id);
    for (const proj of collisionResult.newProjectiles) {
      this.world.addEntity(proj);
      registerPackedProjectile(proj);
    }
    for (const event of collisionResult.spawnEvents) {
      this.eventQueues.projectileSpawns.push(event);
    }
    collisionResult.despawnEvents.sort((a, b) => a.id - b.id);
    for (const event of collisionResult.despawnEvents) {
      unregisterPackedProjectile(event.id);
      spatialGrid.removeProjectile(event.id);
      this.eventQueues.projectileDespawns.push(event);
    }
    for (const event of safeVelocityUpdates(collisionResult.velocityUpdates)) {
      this.eventQueues.projectileVelocityUpdates.set(event.id, event);
    }
    now = performance.now();
    const collisionProjectileEventsMs = now - mark;
    mark = now;

    this.deathExplosionPlanner.detonate(
      collisionResult.deadUnitIds,
      collisionResult.deadBuildingIds,
      collisionResult.events,
      collisionResult.deathContexts,
    );
    now = performance.now();
    const deathExplosionMs = now - mark;
    mark = now;

    this.emitSimEvents(collisionResult.events, onSimEvent);
    this.removeCollisionDeadUnits(
      collisionResult.deadUnitIds,
      collisionResult.deathContexts,
      onUnitDeath,
    );
    this.removeCollisionDeadBuildings(collisionResult.deadBuildingIds, onBuildingDeath);
    now = performance.now();

    return {
      updateProjectilesMs,
      ...projectileUpdateDetails,
      projectileEventCullMs,
      projectileSpatialRefreshMs,
      projectileCollisionsMs,
      ...collisionDetails,
      collisionProjectileEventsMs,
      deathExplosionMs,
      collisionRemovalMs: now - mark,
    };
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
    buf.sort((a, b) => a - b);
    const beamTargetRefsById = getLaserStopRefsForTargets(this.world, buf);
    for (let i = 0; i < buf.length; i++) {
      const id = buf[i];
      const entity = this.world.getEntity(id);
      if (entity) {
        // Emit laserStop for the dying entity's own beam weapons
        for (const evt of emitLaserStopsForEntity(entity)) {
          this.eventQueues.simEvents.push(evt);
        }
        // Emit laserStop for any beam weapons across the world targeting this entity
        for (const evt of emitLaserStopsForTargetRefs(beamTargetRefsById.get(id))) {
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
    buf.sort((a, b) => a - b);
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
