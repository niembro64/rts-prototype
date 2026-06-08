import {
  BUILD_RATE_EMA_HALF_LIFE_SEC,
  BUILD_RATE_EMA_MODE,
} from '@/shellConfig';
import {
  RESOURCE_KIND_ENERGY,
  RESOURCE_KIND_METAL,
} from '@/types/network';
import { WIND_SPEED_MAX } from '../../config';
import type { MetalDeposit } from '../../metalDepositConfig';
import { halfLifeBlend } from '../network/driftEma';
import type { ClientViewState } from '../network/ClientViewState';
import type { Entity, EntityId } from '../sim/types';
import { getBuildingConfig } from '../sim/buildConfigs';
import { isMetalExtractorBlueprintId } from '../../types/buildingTypes';
import type { ConstructionVisualController3D } from './ConstructionVisualController3D';
import type { ResourcePylonRig } from './ConstructionEmitterMesh3D';
import type { EntityMesh } from './EntityMesh3D';
import {
  addActiveAnimatedBuildingEntry,
  addResourcePylonBuildingEntry,
  clearAnimatedBuildingEntries,
  removeAnimatedBuildingEntry,
  type ResourcePylonBuildingEntry,
  type ResourcePylonBuildingKind,
} from './BuildingAnimationLists3D';
import { BuildingResourcePylonSources3D } from './BuildingResourcePylonSources3D';

function extractorInverseBaseProduction(entity: Entity): number {
  if (!isMetalExtractorBlueprintId(entity.buildingBlueprintId)) return 0;
  const base = getBuildingConfig(entity.buildingBlueprintId).metalProduction ?? 0;
  return base > 0 ? 1 / base : 0;
}
const INV_SOLAR_BASE_PRODUCTION = (() => {
  const base = getBuildingConfig('buildingSolar').energyProduction ?? 0;
  return base > 0 ? 1 / base : 0;
})();
const INV_WIND_MAX_PRODUCTION = (() => {
  const base = getBuildingConfig('buildingWind').energyProduction ?? 0;
  const maxRate = base * WIND_SPEED_MAX;
  return maxRate > 0 ? 1 / maxRate : 0;
})();
const INV_CONVERTER_BASE_RATE = (() => {
  const base = getBuildingConfig('buildingResourceConverter').conversionRate ?? 0;
  return base > 0 ? 1 / base : 0;
})();

const RESOURCE_PYLON_IDLE_EPSILON = 0.001;

export function resourcePylonRateFraction(signedRate: number, inverseFullRate: number): number {
  if (signedRate === 0 || inverseFullRate <= 0) return 0;
  return Math.max(0, Math.min(1, Math.abs(signedRate) * inverseFullRate));
}

function applyResourcePylonDirection(pylon: ResourcePylonRig | undefined, signedRate: number): void {
  if (!pylon || signedRate === 0) return;
  pylon.direction = signedRate > 0 ? 'outbound' : 'inbound';
}

export class BuildingResourcePylonAnimator3D {
  private readonly clientViewState: ClientViewState;
  private readonly constructionVisuals: ConstructionVisualController3D;
  private readonly pylonSources: BuildingResourcePylonSources3D;
  private readonly getWindCloseAmount: (id: EntityId, open: boolean) => number;
  private readonly getExtractorCloseAmount: (id: EntityId, open: boolean) => number;
  private resourcePylonBuildings: ResourcePylonBuildingEntry[] = [];
  private resourcePylonBuildingIndexById = new Map<EntityId, number>();
  private activeResourcePylonBuildings: ResourcePylonBuildingEntry[] = [];
  private activeResourcePylonBuildingIndexById = new Map<EntityId, number>();

  constructor(
    clientViewState: ClientViewState,
    constructionVisuals: ConstructionVisualController3D,
    metalDeposits: readonly MetalDeposit[],
    getWindCloseAmount: (id: EntityId, open: boolean) => number,
    getExtractorCloseAmount: (id: EntityId, open: boolean) => number,
  ) {
    this.clientViewState = clientViewState;
    this.constructionVisuals = constructionVisuals;
    this.pylonSources = new BuildingResourcePylonSources3D(clientViewState, metalDeposits);
    this.getWindCloseAmount = getWindCloseAmount;
    this.getExtractorCloseAmount = getExtractorCloseAmount;
  }

  register(entity: Entity, mesh: EntityMesh): void {
    if (mesh.solarRig) {
      this.add('solar', entity, mesh);
    } else if (mesh.windRig) {
      this.add('wind', entity, mesh);
    } else if (mesh.extractorRig) {
      this.add('extractor', entity, mesh);
    } else if (mesh.converterRig) {
      this.add('converter', entity, mesh);
    }
  }

  unregister(id: EntityId): void {
    removeAnimatedBuildingEntry(this.resourcePylonBuildings, this.resourcePylonBuildingIndexById, id);
    removeAnimatedBuildingEntry(this.activeResourcePylonBuildings, this.activeResourcePylonBuildingIndexById, id);
    this.pylonSources.deleteExtractorDepositSource(id);
  }

  refreshActiveQueue(): void {
    const activeSourceIds = this.clientViewState.getResourcePylonSourceIds();
    for (let i = 0; i < activeSourceIds.length; i++) {
      const entryIndex = this.resourcePylonBuildingIndexById.get(activeSourceIds[i]);
      if (entryIndex === undefined) continue;
      addActiveAnimatedBuildingEntry(
        this.activeResourcePylonBuildings,
        this.activeResourcePylonBuildingIndexById,
        this.resourcePylonBuildings[entryIndex],
      );
    }
  }

  updateActive(spinDt: number): void {
    if (this.activeResourcePylonBuildings.length === 0) return;
    const rateAlpha = halfLifeBlend(spinDt, BUILD_RATE_EMA_HALF_LIFE_SEC[BUILD_RATE_EMA_MODE]);
    for (let i = 0; i < this.activeResourcePylonBuildings.length;) {
      const entry = this.activeResourcePylonBuildings[i];
      if (this.updateResourcePylonBuilding(entry, rateAlpha)) {
        i++;
      } else {
        removeAnimatedBuildingEntry(
          this.activeResourcePylonBuildings,
          this.activeResourcePylonBuildingIndexById,
          entry.id,
        );
      }
    }
  }

  destroy(): void {
    clearAnimatedBuildingEntries(this.resourcePylonBuildings, this.resourcePylonBuildingIndexById);
    clearAnimatedBuildingEntries(this.activeResourcePylonBuildings, this.activeResourcePylonBuildingIndexById);
    this.pylonSources.clear();
  }

  private add(
    kind: ResourcePylonBuildingKind,
    entity: Entity,
    mesh: EntityMesh,
  ): ResourcePylonBuildingEntry {
    return addResourcePylonBuildingEntry(
      this.resourcePylonBuildings,
      this.resourcePylonBuildingIndexById,
      kind,
      entity,
      mesh,
    );
  }

  private updateResourcePylonBuilding(
    entry: ResourcePylonBuildingEntry,
    rateAlpha: number,
  ): boolean {
    switch (entry.kind) {
      case 'solar':
        return this.updateSolarResourcePylon(entry, rateAlpha);
      case 'wind':
        return this.updateWindResourcePylon(entry, rateAlpha);
      case 'extractor':
        return this.updateExtractorResourcePylon(entry, rateAlpha);
      case 'converter':
        return this.updateConverterResourcePylons(entry, rateAlpha);
    }
  }

  private updateSolarResourcePylon(
    entry: ResourcePylonBuildingEntry,
    rateAlpha: number,
  ): boolean {
    const { id, entity, mesh } = entry;
    const pylon = mesh.solarRig?.pylon;
    if (!pylon) return false;
    const detailsReady = mesh.buildingCachedDetailsReady === true;
    const open = entity.building?.activeState?.open !== false;
    const signedRate = this.clientViewState.getResourcePylonSignedRate(id, RESOURCE_KIND_ENERGY);
    const targetRate = open ? resourcePylonRateFraction(signedRate, INV_SOLAR_BASE_PRODUCTION) : 0;
    applyResourcePylonDirection(pylon, signedRate);
    const sourceWorld = this.pylonSources.writeGroundBelowPylonSourceWorld(pylon, mesh.group, entity);
    this.constructionVisuals.updateAmbientResourcePylon(
      pylon,
      entity,
      mesh.group,
      targetRate,
      rateAlpha,
      detailsReady,
      detailsReady,
      sourceWorld,
    );
    return targetRate > RESOURCE_PYLON_IDLE_EPSILON || this.resourcePylonNeedsFrame(pylon);
  }

  private updateWindResourcePylon(
    entry: ResourcePylonBuildingEntry,
    rateAlpha: number,
  ): boolean {
    const { id, entity, mesh } = entry;
    const pylon = mesh.windRig?.pylon;
    if (!pylon) return false;
    const detailsReady = mesh.buildingCachedDetailsReady === true;
    const open = entity.building?.activeState?.open !== false;
    const close = this.getWindCloseAmount(id, open);
    const signedRate = this.clientViewState.getResourcePylonSignedRate(id, RESOURCE_KIND_ENERGY);
    const targetRate = resourcePylonRateFraction(signedRate, INV_WIND_MAX_PRODUCTION) * (1 - close);
    applyResourcePylonDirection(pylon, signedRate);
    this.constructionVisuals.updateAmbientResourcePylon(
      pylon,
      entity,
      mesh.group,
      targetRate,
      rateAlpha,
      detailsReady,
      detailsReady,
      this.pylonSources.writeWindPylonSourceWorld(pylon, mesh.group),
    );
    return targetRate > RESOURCE_PYLON_IDLE_EPSILON || this.resourcePylonNeedsFrame(pylon);
  }

  private updateExtractorResourcePylon(
    entry: ResourcePylonBuildingEntry,
    rateAlpha: number,
  ): boolean {
    const { id, entity, mesh } = entry;
    const pylon = mesh.extractorRig?.pylon;
    if (!pylon) return false;
    const detailsReady = mesh.buildingCachedDetailsReady === true;
    const open = entity.building?.activeState?.open !== false;
    const close = this.getExtractorCloseAmount(id, open);
    const signedRate = this.clientViewState.getResourcePylonSignedRate(id, RESOURCE_KIND_METAL);
    const targetRate = resourcePylonRateFraction(signedRate, extractorInverseBaseProduction(entity)) * (1 - close);
    applyResourcePylonDirection(pylon, signedRate);
    this.constructionVisuals.updateAmbientResourcePylon(
      pylon,
      entity,
      mesh.group,
      targetRate,
      rateAlpha,
      detailsReady,
      detailsReady,
      this.pylonSources.writeExtractorDepositSourceWorld(pylon, mesh.group, entity),
    );
    return targetRate > RESOURCE_PYLON_IDLE_EPSILON || this.resourcePylonNeedsFrame(pylon);
  }

  private updateConverterResourcePylons(
    entry: ResourcePylonBuildingEntry,
    rateAlpha: number,
  ): boolean {
    const { id, entity, mesh } = entry;
    const rig = mesh.converterRig;
    if (!rig) return false;
    const detailsReady = mesh.buildingCachedDetailsReady === true;
    const energyRate = this.clientViewState.getResourcePylonSignedRate(id, RESOURCE_KIND_ENERGY);
    const metalRate = this.clientViewState.getResourcePylonSignedRate(id, RESOURCE_KIND_METAL);
    const energyTarget = resourcePylonRateFraction(energyRate, INV_CONVERTER_BASE_RATE);
    const metalTarget = resourcePylonRateFraction(metalRate, INV_CONVERTER_BASE_RATE);
    applyResourcePylonDirection(rig.energyPylon, energyRate);
    applyResourcePylonDirection(rig.metalPylon, metalRate);
    this.constructionVisuals.updateAmbientResourcePylon(
      rig.energyPylon,
      entity,
      mesh.group,
      energyTarget,
      rateAlpha,
      detailsReady,
      false,
    );
    this.constructionVisuals.updateAmbientResourcePylon(
      rig.metalPylon,
      entity,
      mesh.group,
      metalTarget,
      rateAlpha,
      detailsReady,
      false,
    );
    this.constructionVisuals.emitConverterResourceTransfer(
      rig.energyPylon,
      rig.metalPylon,
      entity,
      mesh.group,
      energyRate,
      metalRate,
      detailsReady,
      detailsReady,
    );
    return energyTarget > RESOURCE_PYLON_IDLE_EPSILON ||
      metalTarget > RESOURCE_PYLON_IDLE_EPSILON ||
      this.resourcePylonNeedsFrame(rig.energyPylon) ||
      this.resourcePylonNeedsFrame(rig.metalPylon);
  }

  private resourcePylonNeedsFrame(pylon: ResourcePylonRig): boolean {
    if (
      pylon.smoothedRate > RESOURCE_PYLON_IDLE_EPSILON ||
      pylon.displaySmoothedRate > RESOURCE_PYLON_IDLE_EPSILON
    ) {
      return true;
    }
    pylon.smoothedRate = 0;
    pylon.displaySmoothedRate = 0;
    return false;
  }
}
