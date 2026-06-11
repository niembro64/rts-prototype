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
import {
  advanceStaticShieldHostReadiness,
  updateStaticShieldPanelEmissionState,
} from './combat/staticShield';
import type { DamageSystem } from './damage';
import type { ForceAccumulator } from './ForceAccumulator';
import type { SimulationDeathExplosionPlanner } from './SimulationDeathExplosionPlanner';
import {
  safeVelocityUpdates,
  type SimulationEventQueues,
} from './SimulationEventQueues';
import { spatialGrid } from './SpatialGrid';
import type { EntityId } from './types';
import { findShieldPanelTurret } from './shieldPanelRuntime';
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
  private readonly staticShieldReadinessIds = new Set<EntityId>();

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
    this.updateStaticShieldReadiness(dtMs);

    // AIM-08.2 — stamp the FF pool BEFORE the FSM so the shield
    // clearance kernels read the latest sphere list. The list is
    // produced by the previous tick's updateShieldState, so shield
    // sphere targeting has the same one-tick-stale envelope as
    // projectile collision.
    // One material, two shapes: a single pool holds both the sphere and the
    // flat-panel shield surfaces, both stamped here before the FSM/gate.
    stampShieldSurfacePool(this.world);
    // AIM-08.5 — rebuild targeting slabs before the FSM. The targeting
    // pass mutates the slab through Rust transition kernels and writes
    // those results back to JS turrets for the remaining consumers.
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

    // Update shield sounds based on the just-written transition progress.
    if (shieldUnits && shieldUnits.length > 0) {
      this.emitSimEvents(updateShieldSounds(shieldUnits), onSimEvent);
    }

    // Fire weapons and create projectiles (with recoil force for projectiles)
    const fireResult = fireTurrets(this.world, dtMs, this.forceAccumulator, activeCombatUnits);
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
    this.staticShieldReadinessIds.clear();
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

    // Projectile reflection queries use the same reflector slabs as
    // targeting, but need the post-rotation, post-shield-update
    // pose for this collision tick.
    stampShieldSurfacePool(this.world, { includeWhenSightDisabled: true });

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
    for (const proj of collisionResult.newProjectiles) {
      this.world.addEntity(proj);
      registerPackedProjectile(proj);
    }
    for (const event of collisionResult.spawnEvents) {
      this.eventQueues.projectileSpawns.push(event);
    }

    // Collect projectile despawn events from collisions
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
      collisionResult.deadTurretIds,
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

  private updateStaticShieldReadiness(dtMs: number): void {
    const seen = this.staticShieldReadinessIds;
    seen.clear();

    for (const unit of this.world.getShieldUnits()) {
      seen.add(unit.id);
      advanceStaticShieldHostReadiness(unit, dtMs);
    }

    for (const unit of this.world.getShieldPanelUnits()) {
      if (!seen.has(unit.id)) {
        seen.add(unit.id);
        advanceStaticShieldHostReadiness(unit, dtMs);
      }
      const panelRef = findShieldPanelTurret(unit);
      if (panelRef !== null) {
        updateStaticShieldPanelEmissionState(unit, panelRef.turret);
      }
    }
  }

  private removeCollisionDeadUnits(
    deadUnitIds: Set<EntityId>,
    deathContexts: Map<EntityId, DeathContext>,
    onUnitDeath: UnitDeathCallback,
  ): void {
    if (deadUnitIds.size === 0) return;
    const buf = this.deadUnitIdsBuf;
    buf.length = 0;
    for (const id of deadUnitIds) {
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
    for (const id of deadBuildingIds) {
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
