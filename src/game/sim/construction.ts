import type { WorldState } from './WorldState';
import type { TerrainBuildabilityGrid } from '@/types/terrain';
import type { Entity, EntityId, PlayerId, BuildingBlueprintId } from './types';
import { getBuildingConfig } from './buildConfigs';
import { BuildingGrid, BUILD_GRID_CELL_SIZE, getRotatedGridFootprint } from './buildGrid';
import { computeFactoryWaypoint } from './spawn';
import { getBuildingPlacementDiagnosticsForGrid } from './buildPlacementValidation';
import {
  REAL_BATTLE_FACTORY_WAYPOINT_DISTANCE,
  REAL_BATTLE_FACTORY_WAYPOINT_TYPE,
} from '../../config';
import { ENTITY_CHANGED_ACTIONS } from '../../types/network';
import { removeCompletedBuildingEffects } from './buildingCompletion';
import { isBuildTargetInRange } from './builderRange';
import { createBuildable, isBuildInProgress } from './buildableHelpers';
import { applyBuildingBlueprintRuntime } from './buildingEntityRuntime';
import { applyCompletedBuildingEffects } from './buildingCompletion';
import { initializeConstructionPieceHealth } from './constructionLifecycle';
import { entityCanBuild, resolveStructureSpawnCapability } from './hostCapabilities';
import {
  assignEmitterSpawnTask,
  completeEmitterSpawnTask,
  findMountedEmitter,
} from './emitterTasks';
import { isMetalExtractorBlueprintId } from '../../types/buildingTypes';
import {
  canBuilderUpgradeMetalExtractor,
  isUpgradeableMetalExtractorTarget,
  METAL_EXTRACTOR_T1_BLUEPRINT_ID,
  METAL_EXTRACTOR_T2_BLUEPRINT_ID,
} from './metalExtractorUpgrade';
import {
  getBuildingPlacementBaseZ,
  buildingIgnoresTerrainForPlacement,
  getHighestBuildFootprintGroundZ,
} from './buildingPlacementPolicy';

type StartBuildingOptions = {
  skipBuilderAuthorization: boolean;
  /** Bootstrap-only escape hatch for authored prebuilt infrastructure on
   *  otherwise unbuildable terrain. Bounds and occupancy still apply. */
  ignoreTerrainForPlacement: boolean;
};

const DEFAULT_START_BUILDING_OPTIONS: StartBuildingOptions = {
  skipBuilderAuthorization: false,
  ignoreTerrainForPlacement: false,
};

// Construction system - authoritative building placement and footprint grid.
// Runtime resource/HP/completion semantics live in constructionLifecycle.ts.
export class ConstructionSystem {
  private buildingGrid: BuildingGrid;
  private readonly mapWidth: number;
  private readonly mapHeight: number;
  private readonly terrainBuildabilityGrid: TerrainBuildabilityGrid | null;

  constructor(
    mapWidth: number,
    mapHeight: number,
    terrainBuildabilityGrid: TerrainBuildabilityGrid | null = null,
  ) {
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
    this.terrainBuildabilityGrid = terrainBuildabilityGrid;
    this.buildingGrid = new BuildingGrid(mapWidth, mapHeight);
  }

  // Get the building grid
  getGrid(): BuildingGrid {
    return this.buildingGrid;
  }

  private isCellOccupied(gridX: number, gridY: number): boolean {
    const cell = this.buildingGrid.getCell(gridX, gridY);
    return cell !== undefined && cell.occupied === true;
  }

  // Start a new building construction
  startBuilding(
    world: WorldState,
    buildingBlueprintId: BuildingBlueprintId,
    gridX: number,
    gridY: number,
    playerId: PlayerId,
    builderId: EntityId,
    rotation = 0,
    options: StartBuildingOptions = DEFAULT_START_BUILDING_OPTIONS,
  ): Entity | null {
    const builderEntity = world.getEntity(builderId);
    if (!options.skipBuilderAuthorization && !entityCanBuild(builderEntity, buildingBlueprintId)) return null;
    const spawnCapability = options.skipBuilderAuthorization
      ? null
      : resolveStructureSpawnCapability(builderEntity, buildingBlueprintId);
    const spawnEmitter = builderEntity !== undefined && spawnCapability !== null
      ? findMountedEmitter(builderEntity, spawnCapability.mountId)
      : null;
    if (!options.skipBuilderAuthorization && spawnEmitter === null) return null;
    const producesNanoframe = spawnCapability?.producesNanoframe ?? true;
    const config = getBuildingConfig(buildingBlueprintId);
    const footprint = getRotatedGridFootprint(config.gridWidth, config.gridHeight, rotation);
    const placementFootprint = getRotatedGridFootprint(
      config.placementGridWidth,
      config.placementGridHeight,
      rotation,
    );

    const diagnostics = getBuildingPlacementDiagnosticsForGrid(
      buildingBlueprintId,
      gridX,
      gridY,
      world.mapWidth,
      world.mapHeight,
      world.metalDeposits,
      (gx, gy) => this.isCellOccupied(gx, gy),
      this.terrainBuildabilityGrid,
      rotation,
      {
        includeMetalDiagnostics: false,
        ignoreTerrain: options.ignoreTerrainForPlacement,
      },
    );
    if (!diagnostics.canPlace) {
      return null;
    }

    // Get world position for building center
    const worldPos = { x: diagnostics.x, y: diagnostics.y };
    const baseZ = getBuildingPlacementBaseZ(
      config.hovering,
      worldPos.x,
      worldPos.y,
      (x, y) => world.getGroundZ(x, y),
      (x, y) => world.getTerrainBedZ(x, y),
    );
    if (
      spawnEmitter !== null &&
      spawnCapability !== null &&
      !assignEmitterSpawnTask(spawnEmitter, {
        blueprintKind: 'structure',
        blueprintId: buildingBlueprintId,
        completion: producesNanoframe ? 'nanoframe' : 'complete',
        placement: {
          kind: 'point',
          x: worldPos.x,
          y: worldPos.y,
          z: baseZ,
          rotation,
        },
      })
    ) {
      return null;
    }

    // Extractors can be placed ANYWHERE that satisfies the normal
    // building placement rules — there's no longer a "must overlap
    // a deposit" gate. When the extractor finishes building,
    // applyCompletedBuildingEffects computes metal/sec directly from
    // the number of generated metal cells under this fixed footprint.
    // No production work happens at startBuilding — those fields stay
    // zero / empty until completion.

    const physicalSize = {
      width: footprint.gridWidth * BUILD_GRID_CELL_SIZE,
      height: footprint.gridHeight * BUILD_GRID_CELL_SIZE,
      depth: config.gridDepth * BUILD_GRID_CELL_SIZE,
    };

    const entity = world.createBuilding(
      worldPos.x,
      worldPos.y,
      physicalSize.width,
      physicalSize.height,
      physicalSize.depth,
      playerId,
      rotation,
    );
    entity.transform.z = baseZ + physicalSize.depth / 2;
    if (buildingIgnoresTerrainForPlacement(buildingBlueprintId)) {
      const baselineZ = getHighestBuildFootprintGroundZ(
        gridX,
        gridY,
        placementFootprint.gridWidth,
        placementFootprint.gridHeight,
        (x, y) => world.getGroundZ(x, y),
      );
      entity.transform.z = baselineZ + physicalSize.depth / 2;
    }

    // Add buildable component — paid starts at zero on every axis;
    // resources flow in from the player's stockpile until each axis
    // reaches required.
    entity.buildable = producesNanoframe ? createBuildable(config.cost) : null;

    // Allocate turret sub-entity ids up front so the finished building's
    // weapons can lock on and fire. Turrets with id === NO_ENTITY_ID are
    // not materialized; combat is still suppressed while the shell
    // is under construction via the isEntityActive() / BUILDABLE_COMPLETE
    // gate, but on completion the turrets already hold real ids — matching
    // pre-placed buildings (placeCompleteBuilding).
    applyBuildingBlueprintRuntime(entity, buildingBlueprintId, {
      allocateEntityId: () => world.generateEntityId(),
    });
    if (isMetalExtractorBlueprintId(buildingBlueprintId)) {
      // Inactive at construction start. The completion handler runs
      // computeExtractorMetalCoverage fills `coveredDepositIds` and sets
      // `metalExtractionRate` from the number of metal cells under this
      // fixed build footprint.
      entity.coveredDepositIds = [];
      entity.metalExtractionRate = 0;
    }

    if (entity.building) {
      entity.building.maxHp = config.hp;
    }
    if (producesNanoframe) {
      initializeConstructionPieceHealth(entity, world);
    } else if (entity.building !== null) {
      entity.building.hp = entity.building.maxHp;
    }

    // Add factory component if it's a factory
    if (buildingBlueprintId === 'towerFabricator') {
      const wp = computeFactoryWaypoint(
        worldPos.x,
        worldPos.y,
        world.mapWidth,
        world.mapHeight,
        REAL_BATTLE_FACTORY_WAYPOINT_DISTANCE,
      );
      entity.factory = {
        selectedUnitBlueprintId: null,
        lowPriority: true,
        carrierSpawnEnabled: true,
        moveState: 'holdPosition',
        airIdleState: 'land',
        repeatProduction: false,
        paused: false,
        productionQueue: [],
        productionQuotas: {},
        productionQuotaCounts: {},
        resumeRepeatUnitBlueprintId: null,
        currentShellId: null,
        currentBuildProgress: 0,
        defaultWaypoints: null,
        rallyX: wp.x,
        rallyY: wp.y,
        rallyZ: null,
        rallyType: REAL_BATTLE_FACTORY_WAYPOINT_TYPE,
        // BAR cmd_factory_guard_pref.lua enables Factory Guard by default
        // on factories that can produce constructors.
        guardTargetId: entity.id,
        isProducing: false,
        energyRateFraction: 0,
        metalRateFraction: 0,
      };
    }

    // Register the placement footprint. Only the centered physical rect
    // blocks movement; any clearance ring beyond it (wind turbine blade
    // sweep) reserves construction cells without becoming a wall. A hovering
    // building (the fabricator torus) reserves its footprint but does NOT block
    // movement, so units path/walk freely underneath as if it weren't there.
    const isHovering = config.hovering;
    const pathTopZ = config.supportSurface.kind === 'boxTop'
      ? config.supportSurface.topZ
      : config.gridDepth * BUILD_GRID_CELL_SIZE;
    this.buildingGrid.place(
      gridX,
      gridY,
      placementFootprint.gridWidth,
      placementFootprint.gridHeight,
      entity.id,
      playerId,
      !isHovering,
      footprint.gridWidth,
      footprint.gridHeight,
      pathTopZ,
    );

    // Add to world
    world.addEntity(entity);
    if (!producesNanoframe) applyCompletedBuildingEffects(world, entity);
    if (spawnEmitter !== null) completeEmitterSpawnTask(spawnEmitter, entity.id);

    // The builder's spawn turret is what brought this nanoframe into
    // existence: flash a brief init beam from it to the new shell.
    if (builderEntity !== undefined) {
      world.registerSpawnBeam(entity.id, builderId);
    }

    // Assign builder (only for non-commanders - commanders use their own action queue)
    const builder = builderEntity;
    if (
      producesNanoframe &&
      builder !== undefined &&
      builder.builder !== null &&
      builder.commander === null
    ) {
      builder.builder.currentBuildTarget = entity.id;
      world.markSnapshotDirty(builder.id, ENTITY_CHANGED_ACTIONS);
    }

    return entity;
  }

  startMetalExtractorUpgrade(
    world: WorldState,
    targetId: EntityId,
    playerId: PlayerId,
    builderId: EntityId,
  ): Entity | null {
    const builderEntity = world.getEntity(builderId);
    if (builderEntity?.ownership?.playerId !== playerId) return null;
    if (!canBuilderUpgradeMetalExtractor(builderEntity)) return null;
    const target = world.getEntity(targetId);
    if (!isUpgradeableMetalExtractorTarget(target, playerId)) return null;
    const targetGrid = this.getEntityBuildingGrid(target);
    if (targetGrid === null) return null;

    const t1Config = getBuildingConfig(METAL_EXTRACTOR_T1_BLUEPRINT_ID);
    const t2Config = getBuildingConfig(METAL_EXTRACTOR_T2_BLUEPRINT_ID);
    const rotation = target.transform.rotation;
    const t1Footprint = getRotatedGridFootprint(t1Config.gridWidth, t1Config.gridHeight, rotation);
    const t2Footprint = getRotatedGridFootprint(t2Config.gridWidth, t2Config.gridHeight, rotation);
    const t1Placement = getRotatedGridFootprint(t1Config.placementGridWidth, t1Config.placementGridHeight, rotation);
    const t2Placement = getRotatedGridFootprint(t2Config.placementGridWidth, t2Config.placementGridHeight, rotation);
    if (
      t1Footprint.gridWidth !== t2Footprint.gridWidth ||
      t1Footprint.gridHeight !== t2Footprint.gridHeight ||
      t1Placement.gridWidth !== t2Placement.gridWidth ||
      t1Placement.gridHeight !== t2Placement.gridHeight
    ) {
      return null;
    }

    const diagnostics = getBuildingPlacementDiagnosticsForGrid(
      METAL_EXTRACTOR_T2_BLUEPRINT_ID,
      targetGrid.gridX,
      targetGrid.gridY,
      world.mapWidth,
      world.mapHeight,
      world.metalDeposits,
      (gx, gy) => this.isCellOccupiedByOtherEntity(gx, gy, target.id),
      this.terrainBuildabilityGrid,
      rotation,
      { includeMetalDiagnostics: false, ignoreTerrain: false },
    );
    if (!diagnostics.canPlace) return null;

    this.onBuildingDestroyed(world, target);
    world.removeEntity(target.id);

    return this.startBuilding(
      world,
      METAL_EXTRACTOR_T2_BLUEPRINT_ID,
      targetGrid.gridX,
      targetGrid.gridY,
      playerId,
      builderId,
      rotation,
      {
        skipBuilderAuthorization: true,
        ignoreTerrainForPlacement: false,
      },
    );
  }

  private isCellOccupiedByOtherEntity(gridX: number, gridY: number, ignoredEntityId: EntityId): boolean {
    const cell = this.buildingGrid.getCell(gridX, gridY);
    return cell !== undefined && cell.occupied === true && cell.entityId !== ignoredEntityId;
  }

  private getEntityBuildingGrid(entity: Entity): { gridX: number; gridY: number } | null {
    if (entity.building === null || entity.buildingBlueprintId === null) return null;
    const config = getBuildingConfig(entity.buildingBlueprintId);
    // Placement-rect origin — the same grid coordinate space
    // startBuilding receives and reserves.
    const footprint = getRotatedGridFootprint(
      config.placementGridWidth,
      config.placementGridHeight,
      entity.transform.rotation,
    );
    const halfW = (footprint.gridWidth * BUILD_GRID_CELL_SIZE) / 2;
    const halfH = (footprint.gridHeight * BUILD_GRID_CELL_SIZE) / 2;
    return {
      gridX: Math.floor((entity.transform.x - halfW) / BUILD_GRID_CELL_SIZE + 1e-6),
      gridY: Math.floor((entity.transform.y - halfH) / BUILD_GRID_CELL_SIZE + 1e-6),
    };
  }

  getBuildingGridPosition(entity: Entity): { gridX: number; gridY: number } | null {
    return this.getEntityBuildingGrid(entity);
  }

  // Create a ghost preview for building placement
  createGhost(
    world: WorldState,
    buildingBlueprintId: BuildingBlueprintId,
    worldX: number,
    worldY: number,
    playerId: PlayerId
  ): Entity {
    const config = getBuildingConfig(buildingBlueprintId);

    // Snap by the placement footprint (the rect the real build would
    // reserve); the shared center is also the physical body center.
    const snapped = this.buildingGrid.snapToGrid(
      worldX,
      worldY,
      config.placementGridWidth,
      config.placementGridHeight,
    );
    const centerX = snapped.x + (config.placementGridWidth * BUILD_GRID_CELL_SIZE) / 2;
    const centerY = snapped.y + (config.placementGridHeight * BUILD_GRID_CELL_SIZE) / 2;

    // Create ghost entity
    const entity = world.createBuilding(
      centerX,
      centerY,
      config.gridWidth * BUILD_GRID_CELL_SIZE,
      config.gridHeight * BUILD_GRID_CELL_SIZE,
      config.gridDepth * BUILD_GRID_CELL_SIZE,
      playerId
    );
    const baseZ = getBuildingPlacementBaseZ(
      config.hovering,
      centerX,
      centerY,
      (x, y) => world.getGroundZ(x, y),
      (x, y) => world.getTerrainBedZ(x, y),
    );
    entity.transform.z = baseZ + entity.building!.depth / 2;
    if (buildingIgnoresTerrainForPlacement(buildingBlueprintId)) {
      const footprint = getRotatedGridFootprint(
        config.placementGridWidth,
        config.placementGridHeight,
        0,
      );
      const grid = this.buildingGrid.worldToGrid(snapped.x, snapped.y);
      const baselineZ = getHighestBuildFootprintGroundZ(
        grid.gx,
        grid.gy,
        footprint.gridWidth,
        footprint.gridHeight,
        (x, y) => world.getGroundZ(x, y),
      );
      entity.transform.z = baselineZ + entity.building!.depth / 2;
    }

    entity.buildable = createBuildable(config.cost, {
      paid: null,
      isGhost: true,
      healthBuildFraction: null,
    });

    applyBuildingBlueprintRuntime(entity, buildingBlueprintId);

    return entity;
  }

  // Check if a building can be placed at world coordinates
  canPlaceAt(worldX: number, worldY: number, buildingBlueprintId: BuildingBlueprintId): boolean {
    const config = getBuildingConfig(buildingBlueprintId);
    const snapped = this.buildingGrid.snapToGrid(
      worldX,
      worldY,
      config.placementGridWidth,
      config.placementGridHeight,
    );
    const gridX = Math.floor(snapped.x / BUILD_GRID_CELL_SIZE);
    const gridY = Math.floor(snapped.y / BUILD_GRID_CELL_SIZE);
    return getBuildingPlacementDiagnosticsForGrid(
      buildingBlueprintId,
      gridX,
      gridY,
      this.mapWidth,
      this.mapHeight,
      [],
      (gx, gy) => this.isCellOccupied(gx, gy),
      this.terrainBuildabilityGrid,
    ).canPlace;
  }

  // Handle building destruction
  onBuildingDestroyed(world: WorldState, entity: Entity): void {
    // Remove from grid
    this.buildingGrid.removeByEntityId(entity.id);

    removeCompletedBuildingEffects(world, entity);
  }

  // Assign a builder to a construction site
  assignBuilder(world: WorldState, builderId: EntityId, targetId: EntityId): boolean {
    const builder = world.getEntity(builderId);
    const target = world.getEntity(targetId);

    if (
      builder === undefined ||
      builder.builder === null ||
      target === undefined ||
      target.buildable === null
    ) {
      return false;
    }

    // Check if target is not complete
    if (!isBuildInProgress(target.buildable)) {
      return false;
    }

    if (!isBuildTargetInRange(builder, target)) {
      return false;
    }

    builder.builder.currentBuildTarget = targetId;
    world.markSnapshotDirty(builder.id, ENTITY_CHANGED_ACTIONS);
    return true;
  }

  // Get snap position for building placement
  getSnapPosition(worldX: number, worldY: number, buildingBlueprintId: BuildingBlueprintId): { x: number; y: number } {
    const config = getBuildingConfig(buildingBlueprintId);
    const snapped = this.buildingGrid.snapToGrid(
      worldX,
      worldY,
      config.placementGridWidth,
      config.placementGridHeight,
    );
    return {
      x: snapped.x + (config.placementGridWidth * BUILD_GRID_CELL_SIZE) / 2,
      y: snapped.y + (config.placementGridHeight * BUILD_GRID_CELL_SIZE) / 2,
    };
  }
}
