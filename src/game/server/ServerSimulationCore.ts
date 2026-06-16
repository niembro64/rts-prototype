import type { TerrainBuildabilityGrid, TerrainTileMap } from '@/types/terrain';
import { ENTITY_CHANGED_POS, ENTITY_CHANGED_VEL } from '../../types/network';
import type { Command, CommandQueue } from '../sim/commands';
import type { DeathContext } from '../sim/combat';
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

export type ServerSimulationCoreOptions = {
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
  readonly backgroundAllowedTowerBlueprintIds: Set<string>;
  readonly terrainTileMap: TerrainTileMap;
  readonly terrainBuildabilityGrid: TerrainBuildabilityGrid;

  private readonly unitForceSystem: UnitForceSystem;
  private readonly factoryConstructionTurretSystem: FactoryConstructionTurretSystem;
  private readonly physicsSyncUnitIdsBuf: EntityId[] = [];
  private readonly onGameOver: ((winnerId: PlayerId) => void) | undefined;
  private isGameOver = false;
  private disposed = false;

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
    this.backgroundAllowedTowerBlueprintIds = boot.backgroundAllowedTowerBlueprintIds;
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
  }

  getCanonicalStateHash(): CanonicalServerStateHash {
    return hashCanonicalServerState(this);
  }

  clearPendingCommandsAndStepBuffers(): void {
    this.commandQueue.clear();
    this.physicsSyncUnitIdsBuf.length = 0;
  }

  resetSessionState(): void {
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
    const ids = this.physicsSyncUnitIdsBuf;
    ids.length = 0;
    this.physics.collectLastStepEntityIds(ids);
    for (let i = 0; i < ids.length; i++) {
      const entity = this.world.getEntity(ids[i]);
      if (entity === undefined) continue;
      const bodySlot = entity.body;
      if (bodySlot === null) continue;
      const body = bodySlot.physicsBody;
      if (!hasFiniteBodyKinematics(body)) {
        this.repairInvalidUnitBody(entity);
        continue;
      }
      entity.transform.x = body.x;
      entity.transform.y = body.y;
      entity.transform.z = body.z;
      if (entity.unit !== null) {
        entity.unit.velocityX = body.vx;
        entity.unit.velocityY = body.vy;
        entity.unit.velocityZ = body.vz;
        this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_POS | ENTITY_CHANGED_VEL);
      } else if (entity.building !== null) {
        spatialGrid.addBuilding(entity);
        this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_POS);
      }
    }
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
      : groundZ + unit.bodyCenterHeight;
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
  return (
    Number.isFinite(body.x) &&
    Number.isFinite(body.y) &&
    Number.isFinite(body.z) &&
    Number.isFinite(body.vx) &&
    Number.isFinite(body.vy) &&
    Number.isFinite(body.vz)
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
