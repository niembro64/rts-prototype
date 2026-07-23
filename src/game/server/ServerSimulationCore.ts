import type { TerrainBuildabilityGrid, TerrainTileMap } from '@/types/terrain';
import { ENTITY_CHANGED_POS, ENTITY_CHANGED_ROT, ENTITY_CHANGED_VEL } from '../../types/network';
import type { Command, CommandQueue } from '../sim/commands';
import type { DeathContext } from '../sim/combat';
import {
  ENTITY_SLOT_BUILD_FLAG_COMPLETE,
  ENTITY_SLOT_BUILD_FLAG_GHOST,
  ENTITY_SLOT_BUILD_FLAG_HAS_BUILDABLE,
  ENTITY_SLOT_BUILD_FLAG_INTERRUPTED,
  entitySlotRegistry,
  type EntityStateViews,
} from '../sim/EntitySlotRegistry';
import { spatialGrid } from '../sim/SpatialGrid';
import type { Simulation } from '../sim/Simulation';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import type { WorldState } from '../sim/WorldState';
import {
  hashCanonicalServerState,
  type CanonicalServerStateHash,
} from '../architecture/CanonicalStateHash';
import { FactoryConstructionTurretSystem } from './FactoryConstructionTurretSystem';
import type { PhysicsEngine3D } from './PhysicsEngine3D';
import type { BootstrappedServerWorld } from './ServerBootstrap';
import { UnitForceSystem } from './UnitForceSystem';
import { computeHostEffectiveMass, createPhysicsBodyForUnit } from './unitPhysicsBody';
import { finalizePendingProjectileLaunchVelocities } from '../sim/combat/projectileSystem';
import { isBuildInProgress } from '../sim/buildableHelpers';
import { getSimWasm } from '../sim-wasm/init';
import { applyEntityHoldPose } from '../sim/entityHolds';
import type { PresentationFrameEvent, SurfaceLiftProbeDebugFrame } from '@/types/game';

type ServerSimulationCoreOptions = {
  onGameOver?: (winnerId: PlayerId) => void;
};

export class ServerSimulationCore {
  readonly physics: PhysicsEngine3D;
  readonly world: WorldState;
  readonly simulation: Simulation;
  readonly commandQueue: CommandQueue;
  readonly playerIds: PlayerId[];
  readonly backgroundMode: boolean;
  readonly backgroundAllowedUnitBlueprintIds: Set<string>;
  readonly backgroundAllowedBuildingBlueprintIds: Set<string>;
  readonly terrainTileMap: TerrainTileMap;
  readonly terrainBuildabilityGrid: TerrainBuildabilityGrid;

  private readonly unitForceSystem: UnitForceSystem;
  private readonly factoryConstructionTurretSystem: FactoryConstructionTurretSystem;
  private physicsSyncEntitySlotsBuf = new Uint32Array(1024);
  private readonly onGameOver: ((winnerId: PlayerId) => void) | undefined;
  private isGameOver = false;
  private disposed = false;
  private readonly presentationFrameListeners = new Set<(event: PresentationFrameEvent) => void>();

  constructor(
    boot: BootstrappedServerWorld,
    options: ServerSimulationCoreOptions = {},
  ) {
    this.physics = boot.physics;
    this.world = boot.world;
    this.simulation = boot.simulation;
    this.commandQueue = boot.commandQueue;
    this.playerIds = boot.playerIds;
    this.backgroundMode = boot.backgroundMode;
    this.backgroundAllowedUnitBlueprintIds = boot.backgroundAllowedUnitBlueprintIds;
    this.backgroundAllowedBuildingBlueprintIds = boot.backgroundAllowedBuildingBlueprintIds;
    this.terrainTileMap = boot.terrainTileMap;
    this.terrainBuildabilityGrid = boot.terrainBuildabilityGrid;
    this.onGameOver = options.onGameOver;

    this.unitForceSystem = new UnitForceSystem(this.world, this.simulation, this.physics);
    this.factoryConstructionTurretSystem = new FactoryConstructionTurretSystem(this.world);
    this.setupSimulationCallbacks();
  }

  stepFixedTick(dtMs: number, orderedCommandsForThisTick: readonly Command[] = []): void {
    for (const command of orderedCommandsForThisTick) {
      this.commandQueue.enqueue(command);
    }

    const dtSec = dtMs / 1000;
    this.repairInvalidEntityPoses();
    this.simulation.update(dtMs);
    this.factoryConstructionTurretSystem.update(dtSec);
    this.unitForceSystem.applyForces(dtSec);
    this.physics.step(dtSec, this.simulation.getWindState());
    this.repairInvalidEntityPoses();
    this.syncFromPhysics();
    finalizePendingProjectileLaunchVelocities(this.world, dtMs);
    const sim = getSimWasm();
    if (sim !== undefined) {
      const tick = this.world.getTick();
      sim.presentation.captureTick(tick);
      if (this.presentationFrameListeners.size > 0) {
        const event: PresentationFrameEvent = {
          tick,
          capturedAtMs: performance.now(),
        };
        for (const listener of this.presentationFrameListeners) listener(event);
      }
    }
  }

  addPresentationFrameListener(
    listener: (event: PresentationFrameEvent) => void,
  ): () => void {
    this.presentationFrameListeners.add(listener);
    return () => this.presentationFrameListeners.delete(listener);
  }

  setSurfaceLiftProbeDebugEntityIds(entityIds: readonly EntityId[]): void {
    this.unitForceSystem.setSurfaceLiftProbeDebugEntityIds(entityIds);
  }

  getSurfaceLiftProbeDebugFrame(entityId: EntityId): SurfaceLiftProbeDebugFrame | undefined {
    return this.unitForceSystem.getSurfaceLiftProbeDebugFrame(entityId);
  }

  getCanonicalStateHash(): CanonicalServerStateHash {
    return hashCanonicalServerState(this);
  }

  clearPendingCommandsAndStepBuffers(): void {
    this.commandQueue.clear();
  }

  resetSessionState(): void {
    this.unitForceSystem.setSurfaceLiftProbeDebugEntityIds([]);
    this.simulation.resetSessionState();
    this.factoryConstructionTurretSystem.reset();
  }

  detachSimulationCallbacks(): void {
    this.world.onEntityRemoving = null;
    this.world.onHostMassChanged = null;
    this.simulation.onUnitDeath = null;
    this.simulation.onUnitSpawn = null;
    this.simulation.onBuildingSpawn = null;
    this.simulation.onBuildingDeath = null;
    this.simulation.onSimEvent = null;
    this.simulation.onGameOver = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unitForceSystem.setSurfaceLiftProbeDebugEntityIds([]);
    this.presentationFrameListeners.clear();
    getSimWasm()?.presentation.clear();
    this.physics.dispose();
  }

  private setupSimulationCallbacks(): void {
    this.world.onEntityRemoving = (entity: Entity) => {
      const bodySlot = entity.body;
      if (bodySlot === null) return;
      const body = bodySlot.physicsBody;
      this.physics.removeBody(body);
      entity.body = null;
    };

    this.world.onHostMassChanged = (host: Entity) => {
      const bodyRef = host.body;
      if (bodyRef === null || host.unit === null) return;
      this.physics.setBodyEffectiveMass(bodyRef.physicsBody, computeHostEffectiveMass(host));
    };

    this.simulation.onUnitDeath = (
      deadUnitIds: EntityId[],
      _deathContexts: Map<EntityId, DeathContext> | null,
    ) => {
      for (const id of deadUnitIds) {
        this.world.removeEntity(id);
      }
    };

    this.simulation.onBuildingDeath = (deadBuildingIds: EntityId[]) => {
      const constructionSystem = this.simulation.getConstructionSystem();
      for (const id of deadBuildingIds) {
        const entity = this.world.getEntity(id);
        if (entity) {
          constructionSystem.onBuildingDestroyed(this.world, entity);
        }
        this.world.removeEntity(id);
      }
    };

    this.simulation.onUnitSpawn = (newUnits: Entity[]) => {
      for (const entity of newUnits) {
        createPhysicsBodyForUnit(this.world, this.physics, entity, {
          ignoreOverlappingBuildings: true,
          overlapPadding: undefined,
        });
      }
    };

    this.simulation.onBuildingSpawn = (newBuildings: Entity[]) => {
      for (const entity of newBuildings) {
        if (entity.building === null || entity.body !== null) continue;
        // A hovering building (the fabricator torus) is intangible at ground
        // level: it gets NO collision body, so units walk freely underneath and
        // released shells fall through it under normal physics. Its footprint
        // is still reserved + it stays selectable/targetable via the entity
        // spatial grid.
        if (entity.building.hovering) continue;
        const baseZ = entity.transform.z - entity.building.depth / 2;
        const body = this.physics.createBuildingBody(
          entity.transform.x,
          entity.transform.y,
          entity.building.width,
          entity.building.height,
          entity.building.depth,
          baseZ,
          entity.building.supportSurface,
          `building_${entity.id}`,
          entity.id,
        );
        entity.body = { physicsBody: body };
        this.world.refreshEntitySlotState(entity);
      }
    };

    if (!this.backgroundMode) {
      this.simulation.onGameOver = (winnerId: PlayerId) => {
        if (this.isGameOver) return;
        this.isGameOver = true;
        this.onGameOver?.(winnerId);
      };
    }
  }

  private syncFromPhysics(): void {
    let slotCount = this.physics.collectLastStepEntitySlotsFromState(
      this.physicsSyncEntitySlotsBuf,
    );
    if (slotCount < 0) {
      this.ensurePhysicsSyncEntitySlotCapacity(-slotCount);
      slotCount = this.physics.collectLastStepEntitySlotsFromState(
        this.physicsSyncEntitySlotsBuf,
      );
    }
    const entityStateViews = entitySlotRegistry.getViews();
    const bodyPool = getSimWasm()?.pool;
    bodyPool?.refreshViews();
    for (let i = 0; i < slotCount; i++) {
      const entitySlot = this.physicsSyncEntitySlotsBuf[i];
      const entity = entitySlotRegistry.resolveSlot(entitySlot);
      if (entity === undefined) continue;
      const bodyRef = entity.body;
      if (bodyRef === null) continue;
      const body = bodyRef.physicsBody;
      const hasEntityState =
        entityStateViews !== null &&
        entitySlot >= 0 &&
        entitySlot < entityStateViews.capacity &&
        entityStateViews.entityId[entitySlot] === entity.id;
      const bodySlot = hasEntityState ? entityStateViews.bodySlot[entitySlot] : -1;
      const useBodyPool =
        bodyPool !== undefined &&
        bodySlot >= 0 &&
        bodySlot < bodyPool.capacity &&
        body.slot === bodySlot;
      let x = useBodyPool ? bodyPool.posX[bodySlot] : body.x;
      let y = useBodyPool ? bodyPool.posY[bodySlot] : body.y;
      let z = useBodyPool ? bodyPool.posZ[bodySlot] : body.z;
      let vx = useBodyPool ? bodyPool.velX[bodySlot] : body.vx;
      let vy = useBodyPool ? bodyPool.velY[bodySlot] : body.vy;
      let vz = useBodyPool ? bodyPool.velZ[bodySlot] : body.vz;
      if (!hasFiniteKinematicsValues(x, y, z, vx, vy, vz)) {
        this.repairInvalidUnitBody(entity);
        continue;
      }
      // Held entities are pinned by the generic hold relation. Production
      // shells use this while being built; transports can use the same relation
      // for cargo. The relation owns X/Y/Z pose, velocity inheritance, and
      // release semantics instead of burying those policies in Buildable.
      const buildFlags = hasEntityState ? entityStateViews.buildFlags[entitySlot] : 0;
      const buildInProgress = hasEntityState
        ? (
            (buildFlags & ENTITY_SLOT_BUILD_FLAG_HAS_BUILDABLE) !== 0 &&
            (buildFlags & (
              ENTITY_SLOT_BUILD_FLAG_COMPLETE |
              ENTITY_SLOT_BUILD_FLAG_GHOST |
              ENTITY_SLOT_BUILD_FLAG_INTERRUPTED
            )) === 0
          )
        : isBuildInProgress(entity.buildable);
      const previousRotation = entity.transform.rotation;
      if (entity.heldBy !== null && applyEntityHoldPose(this.world, entity)) {
        x = entity.transform.x;
        y = entity.transform.y;
        z = entity.transform.z;
        vx = entity.unit?.velocityX ?? 0;
        vy = entity.unit?.velocityY ?? 0;
        vz = entity.unit?.velocityZ ?? 0;
        if (useBodyPool) {
          bodyPool.posX[bodySlot] = x;
          bodyPool.posY[bodySlot] = y;
          bodyPool.posZ[bodySlot] = z;
          bodyPool.velX[bodySlot] = vx;
          bodyPool.velY[bodySlot] = vy;
          bodyPool.velZ[bodySlot] = vz;
        } else {
          body.x = x;
          body.y = y;
          body.z = z;
          body.vx = vx;
          body.vy = vy;
          body.vz = vz;
        }
        if (entity.transform.rotation !== previousRotation) {
          this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ROT);
        }
      } else if (buildInProgress && entity.buildable !== null) {
        x = entity.transform.x;
        y = entity.transform.y;
        vx = 0;
        vy = 0;
        if (useBodyPool) {
          bodyPool.posX[bodySlot] = x;
          bodyPool.posY[bodySlot] = y;
          bodyPool.posZ[bodySlot] = z;
          bodyPool.velX[bodySlot] = vx;
          bodyPool.velY[bodySlot] = vy;
          bodyPool.velZ[bodySlot] = vz;
        } else {
          body.x = x;
          body.y = y;
          body.z = z;
          body.vx = vx;
          body.vy = vy;
          body.vz = vz;
        }
      }
      entity.transform.x = x;
      entity.transform.y = y;
      entity.transform.z = z;
      if (entity.unit !== null) {
        entity.unit.velocityX = vx;
        entity.unit.velocityY = vy;
        entity.unit.velocityZ = vz;
      } else if (entity.building !== null) {
        spatialGrid.addBuilding(entity);
      }
    }

    const syncedEntitySlots = this.physicsSyncEntitySlotsBuf.subarray(0, slotCount);
    let nativeSyncedMotion =
      this.physics.syncEntitySlotBodyMotionToEntityState(syncedEntitySlots) >= 0;
    if (!nativeSyncedMotion) {
      nativeSyncedMotion = this.physics.syncLastStepBodyMotionToEntityState() >= 0;
    }
    if (nativeSyncedMotion) return;

    for (let i = 0; i < slotCount; i++) {
      const entitySlot = this.physicsSyncEntitySlotsBuf[i];
      const entity = entitySlotRegistry.resolveSlot(entitySlot);
      if (entity === undefined || entity.body === null) continue;
      if (entity.unit !== null) {
        const dirtyFields = ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT | ENTITY_CHANGED_VEL;
        if (this.writeSyncedMotionToEntityState(entity, entitySlot, dirtyFields, entityStateViews)) {
          this.world.markSnapshotDirtyStateSynced(entity, dirtyFields);
        } else {
          this.world.markSnapshotDirty(entity.id, dirtyFields);
        }
      } else if (entity.building !== null) {
        const dirtyFields = ENTITY_CHANGED_POS;
        if (this.writeSyncedMotionToEntityState(entity, entitySlot, dirtyFields, entityStateViews)) {
          this.world.markSnapshotDirtyStateSynced(entity, dirtyFields);
        } else {
          this.world.markSnapshotDirty(entity.id, dirtyFields);
        }
      }
    }
  }

  private writeSyncedMotionToEntityState(
    entity: Entity,
    slot: number,
    dirtyFields: number,
    views: EntityStateViews | null,
  ): boolean {
    if (views === null) return false;
    if (slot < 0 || slot >= views.capacity || views.entityId[slot] !== entity.id) return false;

    if ((dirtyFields & ENTITY_CHANGED_POS) !== 0) {
      views.posX[slot] = entity.transform.x;
      views.posY[slot] = entity.transform.y;
      views.posZ[slot] = entity.transform.z;
    }
    if ((dirtyFields & ENTITY_CHANGED_ROT) !== 0) {
      views.rotation[slot] = entity.transform.rotation;
    }
    if ((dirtyFields & ENTITY_CHANGED_VEL) !== 0) {
      const unit = entity.unit;
      views.velX[slot] = unit !== null ? unit.velocityX : 0;
      views.velY[slot] = unit !== null ? unit.velocityY : 0;
      views.velZ[slot] = unit !== null ? unit.velocityZ : 0;
    }
    views.dirtyMask[slot] |= dirtyFields;
    return true;
  }

  private ensurePhysicsSyncEntitySlotCapacity(count: number): void {
    if (this.physicsSyncEntitySlotsBuf.length >= count) return;
    let cap = this.physicsSyncEntitySlotsBuf.length;
    while (cap < count) cap *= 2;
    this.physicsSyncEntitySlotsBuf = new Uint32Array(cap);
  }

  private repairInvalidUnitBody(entity: Entity): void {
    const body = entity.body?.physicsBody;
    if (body === undefined || entity.unit === null) return;
    const x = Number.isFinite(entity.transform.x)
      ? entity.transform.x
      : this.world.mapWidth / 2;
    const y = Number.isFinite(entity.transform.y)
      ? entity.transform.y
      : this.world.mapHeight / 2;
    const groundZ = this.world.getGroundZ(x, y);
    const z = Number.isFinite(entity.transform.z)
      ? entity.transform.z
      : groundZ + body.groundOffset;
    body.x = x;
    body.y = y;
    body.z = Number.isFinite(z) ? z : body.groundOffset;
    body.vx = 0;
    body.vy = 0;
    body.vz = 0;
    body.ax = 0;
    body.ay = 0;
    body.az = 0;
    body.groundLaunchAx = 0;
    body.groundLaunchAy = 0;
    body.groundLaunchAz = 0;
    body.sleepTicks = 0;
    entity.transform.x = body.x;
    entity.transform.y = body.y;
    entity.transform.z = body.z;
    if (!Number.isFinite(entity.transform.rotation)) {
      entity.transform.rotation = 0;
      entity.transform.rotCos = null;
      entity.transform.rotSin = null;
    }
    entity.unit.velocityX = 0;
    entity.unit.velocityY = 0;
    entity.unit.velocityZ = 0;
    this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_POS | ENTITY_CHANGED_VEL);
  }

  private repairInvalidEntityPoses(): void {
    const units = this.world.getUnits();
    for (let i = 0; i < units.length; i++) {
      const entity = units[i];
      const body = entity.body?.physicsBody;
      if (body !== undefined && !hasFiniteBodyKinematics(body)) {
        this.repairInvalidUnitBody(entity);
        continue;
      }
      if (hasFiniteEntityPose(entity)) continue;
      if (body !== undefined && hasFiniteBodyKinematics(body)) {
        this.syncUnitPoseFromBody(entity, body);
      } else {
        this.repairInvalidUnitTransform(entity);
      }
    }
  }

  private syncUnitPoseFromBody(
    entity: Entity,
    body: import('./PhysicsEngine3D').Body3D,
  ): void {
    if (entity.unit === null) return;
    entity.transform.x = body.x;
    entity.transform.y = body.y;
    entity.transform.z = body.z;
    if (!Number.isFinite(entity.transform.rotation)) {
      entity.transform.rotation = 0;
      entity.transform.rotCos = null;
      entity.transform.rotSin = null;
    }
    entity.unit.velocityX = body.vx;
    entity.unit.velocityY = body.vy;
    entity.unit.velocityZ = body.vz;
    this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_POS | ENTITY_CHANGED_VEL);
  }

  private repairInvalidUnitTransform(entity: Entity): void {
    const unit = entity.unit;
    if (unit === null) return;
    const x = Number.isFinite(entity.transform.x)
      ? entity.transform.x
      : this.world.mapWidth / 2;
    const y = Number.isFinite(entity.transform.y)
      ? entity.transform.y
      : this.world.mapHeight / 2;
    const groundZ = this.world.getGroundZ(x, y);
    entity.transform.x = x;
    entity.transform.y = y;
    entity.transform.z = Number.isFinite(entity.transform.z)
      ? entity.transform.z
      : groundZ + unit.supportPointOffsetZ;
    if (!Number.isFinite(entity.transform.rotation)) {
      entity.transform.rotation = 0;
      entity.transform.rotCos = null;
      entity.transform.rotSin = null;
    }
    unit.velocityX = Number.isFinite(unit.velocityX) ? unit.velocityX : 0;
    unit.velocityY = Number.isFinite(unit.velocityY) ? unit.velocityY : 0;
    unit.velocityZ = Number.isFinite(unit.velocityZ) ? unit.velocityZ : 0;
    this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_POS | ENTITY_CHANGED_VEL);
  }
}

function hasFiniteBodyKinematics(body: import('./PhysicsEngine3D').Body3D): boolean {
  return hasFiniteKinematicsValues(body.x, body.y, body.z, body.vx, body.vy, body.vz);
}

function hasFiniteKinematicsValues(
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
): boolean {
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Number.isFinite(z) &&
    Number.isFinite(vx) &&
    Number.isFinite(vy) &&
    Number.isFinite(vz)
  );
}

function hasFiniteEntityPose(entity: Entity): boolean {
  return (
    Number.isFinite(entity.transform.x) &&
    Number.isFinite(entity.transform.y) &&
    Number.isFinite(entity.transform.z) &&
    Number.isFinite(entity.transform.rotation)
  );
}
