import * as THREE from 'three';
import { BUILD_GRID_CELL_SIZE } from '../sim/buildGrid';
import { getBuildingConfig } from '../sim/buildConfigs';
import { isMetalExtractorBlueprintId } from '../../types/buildingTypes';
import {
  getMetalDepositFootprintCoverage,
  type MetalDepositFootprintCell,
} from '../sim/metalDeposits';
import type { Entity, EntityId } from '../sim/types';
import type { ClientViewState } from '../network/ClientViewState';
import type { MetalDeposit } from '../../metalDepositConfig';
import type { ResourcePylonRig } from './ConstructionEmitterMesh3D';

export class BuildingResourcePylonSources3D {
  private readonly extractorDepositSourceCache = new Map<EntityId, THREE.Vector3>();
  private readonly extractorCoverageCells: MetalDepositFootprintCell[] = [];
  private readonly pylonSourceWorld = new THREE.Vector3();
  private readonly pylonSourceDirection = new THREE.Vector3();

  constructor(
    private readonly clientViewState: ClientViewState,
    private readonly metalDeposits: readonly MetalDeposit[],
  ) {}

  deleteExtractorDepositSource(id: EntityId): void {
    this.extractorDepositSourceCache.delete(id);
  }

  clear(): void {
    this.extractorDepositSourceCache.clear();
    this.extractorCoverageCells.length = 0;
  }

  writeGroundBelowPylonSourceWorld(
    pylon: ResourcePylonRig,
    group: THREE.Group,
    entity: Entity,
  ): THREE.Vector3 {
    group.updateWorldMatrix(true, false);
    this.pylonSourceWorld
      .copy(pylon.topLocal)
      .applyMatrix4(group.matrixWorld);
    this.pylonSourceWorld.y = entity.transform.z + 1;
    return this.pylonSourceWorld;
  }

  writeWindPylonSourceWorld(
    pylon: ResourcePylonRig,
    group: THREE.Group,
  ): THREE.Vector3 | null {
    const wind = this.clientViewState.getServerMeta()?.wind;
    if (!wind) return null;
    const len = Math.hypot(wind.x, wind.y, wind.z);
    if (len < 1e-6) return null;
    // Aim the ray forward into the incoming wind, matching the turbine face.
    this.pylonSourceDirection.set(-wind.x / len, -wind.z / len, -wind.y / len);
    return this.writeDirectionalPylonSourceWorld(pylon, group, this.pylonSourceDirection);
  }

  writeExtractorDepositSourceWorld(
    pylon: ResourcePylonRig,
    group: THREE.Group,
    entity: Entity,
  ): THREE.Vector3 {
    const source = this.getExtractorDepositSource(entity);
    if (source) {
      this.pylonSourceWorld.set(source.x, 0, source.z);
    } else {
      group.updateWorldMatrix(true, false);
      this.pylonSourceWorld
        .copy(pylon.topLocal)
        .applyMatrix4(group.matrixWorld);
    }
    this.pylonSourceWorld.y = entity.transform.z + 1;
    return this.pylonSourceWorld;
  }

  private writeDirectionalPylonSourceWorld(
    pylon: ResourcePylonRig,
    group: THREE.Group,
    direction: THREE.Vector3,
  ): THREE.Vector3 {
    group.updateWorldMatrix(true, false);
    this.pylonSourceWorld
      .copy(pylon.topLocal)
      .applyMatrix4(group.matrixWorld)
      .addScaledVector(direction, Math.max(1, pylon.flowRadius));
    return this.pylonSourceWorld;
  }

  private getExtractorDepositSource(entity: Entity): THREE.Vector3 | null {
    if (!isMetalExtractorBlueprintId(entity.buildingBlueprintId)) return null;
    const cached = this.extractorDepositSourceCache.get(entity.id);
    if (cached) return cached;
    const cfg = getBuildingConfig(entity.buildingBlueprintId);
    const halfWidth = (cfg.gridWidth * BUILD_GRID_CELL_SIZE) / 2;
    const halfHeight = (cfg.gridHeight * BUILD_GRID_CELL_SIZE) / 2;
    const cells = this.extractorCoverageCells;
    getMetalDepositFootprintCoverage(
      this.metalDeposits,
      entity.transform.x,
      entity.transform.y,
      halfWidth,
      halfHeight,
      BUILD_GRID_CELL_SIZE,
      cells,
    );
    let x = 0;
    let y = 0;
    let count = 0;
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      if (!cell.covered) continue;
      x += cell.x;
      y += cell.y;
      count++;
    }
    if (count === 0) return null;
    const source = new THREE.Vector3(x / count, 0, y / count);
    this.extractorDepositSourceCache.set(entity.id, source);
    return source;
  }
}
