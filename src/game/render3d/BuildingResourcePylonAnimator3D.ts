import type * as THREE from 'three';
import {
  BUILD_RATE_EMA_HALF_LIFE_SEC,
  BUILD_RATE_EMA_MODE,
} from '@/shellConfig';
import {
  RESOURCE_KIND_ENERGY,
  RESOURCE_KIND_METAL,
  type ResourceKindCode,
} from '@/types/network';
import { WIND_SPEED_MAX } from '../../config';
import type { MetalDeposit } from '../../metalDepositConfig';
import { halfLifeBlend } from '../network/driftEma';
import { IndexedEntityIdMap } from '../network/IndexedEntityIdCollections';
import type { ClientViewState } from '../network/ClientViewState';
import type { Entity, EntityId } from '../sim/types';
import { getBuildingConfig } from '../sim/buildConfigs';
import { isMetalExtractorBlueprintId } from '../../types/buildingTypes';
import type { ResourcePylonRig } from './ConstructionEmitterMesh3D';
import type { EntityMesh } from './EntityMesh3D';
import {
  addActiveAnimatedBuildingEntry,
  addAnimatedBuildingEntry,
  clearAnimatedBuildingEntries,
  removeAnimatedBuildingEntry,
  type AnimatedBuildingEntry,
} from './BuildingAnimationLists3D';
import { BuildingResourcePylonSources3D } from './BuildingResourcePylonSources3D';
import type { ResourcePylonFlowController3D } from './ResourcePylonFlowController3D';

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

function resourcePylonRateFraction(signedRate: number, inverseFullRate: number): number {
  if (signedRate === 0 || inverseFullRate <= 0) return 0;
  return Math.max(0, Math.min(1, Math.abs(signedRate) * inverseFullRate));
}

function applyResourcePylonDirection(pylon: ResourcePylonRig | undefined, signedRate: number): void {
  if (!pylon || signedRate === 0) return;
  pylon.direction = signedRate > 0 ? 'outbound' : 'inbound';
}

type ResourcePylonHostDescriptor = {
  key: string;
  resource: ResourceKindCode;
  emitMode: 'world' | 'relationshipOnly';
  getPylon: (mesh: EntityMesh) => ResourcePylonRig | undefined;
  getInverseFullRate: (entity: Entity) => number;
  getAvailability: (entry: AnimatedBuildingEntry, open: boolean) => number;
  writeWorldEndpoint?: (entry: AnimatedBuildingEntry, pylon: ResourcePylonRig) => THREE.Vector3 | null;
};

type ResourcePylonTipRelationshipDescriptor = {
  key: string;
  resourceA: ResourceKindCode;
  resourceB: ResourceKindCode;
  getPylonA: (mesh: EntityMesh) => ResourcePylonRig | undefined;
  getPylonB: (mesh: EntityMesh) => ResourcePylonRig | undefined;
};

export class BuildingResourcePylonAnimator3D {
  private readonly clientViewState: ClientViewState;
  private readonly resourcePylonFlows: ResourcePylonFlowController3D;
  private readonly pylonSources: BuildingResourcePylonSources3D;
  private readonly getWindCloseAmount: (id: EntityId, open: boolean) => number;
  private readonly getExtractorCloseAmount: (id: EntityId, open: boolean) => number;
  private readonly pylonDescriptors: readonly ResourcePylonHostDescriptor[];
  private readonly tipRelationshipDescriptors: readonly ResourcePylonTipRelationshipDescriptor[];
  private resourcePylonBuildings: AnimatedBuildingEntry[] = [];
  private resourcePylonBuildingIndexById = new IndexedEntityIdMap<number>();
  private activeResourcePylonBuildings: AnimatedBuildingEntry[] = [];
  private activeResourcePylonBuildingIndexById = new IndexedEntityIdMap<number>();

  constructor(
    clientViewState: ClientViewState,
    resourcePylonFlows: ResourcePylonFlowController3D,
    metalDeposits: readonly MetalDeposit[],
    getWindCloseAmount: (id: EntityId, open: boolean) => number,
    getExtractorCloseAmount: (id: EntityId, open: boolean) => number,
  ) {
    this.clientViewState = clientViewState;
    this.resourcePylonFlows = resourcePylonFlows;
    this.pylonSources = new BuildingResourcePylonSources3D(clientViewState, metalDeposits);
    this.getWindCloseAmount = getWindCloseAmount;
    this.getExtractorCloseAmount = getExtractorCloseAmount;
    this.pylonDescriptors = this.createPylonDescriptors();
    this.tipRelationshipDescriptors = this.createTipRelationshipDescriptors();
  }

  register(entity: Entity, mesh: EntityMesh): void {
    if (!this.hasResourcePylonHost(mesh)) return;
    this.add(entity, mesh);
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

  private add(entity: Entity, mesh: EntityMesh): AnimatedBuildingEntry {
    return addAnimatedBuildingEntry(
      this.resourcePylonBuildings,
      this.resourcePylonBuildingIndexById,
      entity,
      mesh,
    );
  }

  private createPylonDescriptors(): readonly ResourcePylonHostDescriptor[] {
    return [
      {
        key: 'solar.energy',
        resource: RESOURCE_KIND_ENERGY,
        emitMode: 'world',
        getPylon: (mesh) => mesh.solarRig?.pylon,
        getInverseFullRate: () => INV_SOLAR_BASE_PRODUCTION,
        getAvailability: (_entry, open) => open ? 1 : 0,
        writeWorldEndpoint: (entry, pylon) =>
          this.pylonSources.writeGroundBelowPylonSourceWorld(pylon, entry.mesh.group, entry.entity),
      },
      {
        key: 'wind.energy',
        resource: RESOURCE_KIND_ENERGY,
        emitMode: 'world',
        getPylon: (mesh) => mesh.windRig?.pylon,
        getInverseFullRate: () => INV_WIND_MAX_PRODUCTION,
        getAvailability: (entry, open) => 1 - this.getWindCloseAmount(entry.id, open),
        writeWorldEndpoint: (entry, pylon) =>
          this.pylonSources.writeWindPylonSourceWorld(pylon, entry.mesh.group),
      },
      {
        key: 'extractor.metal',
        resource: RESOURCE_KIND_METAL,
        emitMode: 'world',
        getPylon: (mesh) => mesh.extractorRig?.pylon,
        getInverseFullRate: (entity) => extractorInverseBaseProduction(entity),
        getAvailability: (entry, open) => 1 - this.getExtractorCloseAmount(entry.id, open),
        writeWorldEndpoint: (entry, pylon) =>
          this.pylonSources.writeExtractorDepositSourceWorld(pylon, entry.mesh.group, entry.entity),
      },
      {
        key: 'converter.energy',
        resource: RESOURCE_KIND_ENERGY,
        emitMode: 'relationshipOnly',
        getPylon: (mesh) => mesh.converterRig?.energyPylon,
        getInverseFullRate: () => INV_CONVERTER_BASE_RATE,
        getAvailability: (_entry, open) => open ? 1 : 0,
      },
      {
        key: 'converter.metal',
        resource: RESOURCE_KIND_METAL,
        emitMode: 'relationshipOnly',
        getPylon: (mesh) => mesh.converterRig?.metalPylon,
        getInverseFullRate: () => INV_CONVERTER_BASE_RATE,
        getAvailability: (_entry, open) => open ? 1 : 0,
      },
    ];
  }

  private createTipRelationshipDescriptors(): readonly ResourcePylonTipRelationshipDescriptor[] {
    return [
      {
        key: 'converter.taxedArc',
        resourceA: RESOURCE_KIND_ENERGY,
        resourceB: RESOURCE_KIND_METAL,
        getPylonA: (mesh) => mesh.converterRig?.energyPylon,
        getPylonB: (mesh) => mesh.converterRig?.metalPylon,
      },
    ];
  }

  private hasResourcePylonHost(mesh: EntityMesh): boolean {
    for (let i = 0; i < this.pylonDescriptors.length; i++) {
      if (this.pylonDescriptors[i].getPylon(mesh)) return true;
    }
    return false;
  }

  private updateResourcePylonBuilding(entry: AnimatedBuildingEntry, rateAlpha: number): boolean {
    const detailsReady = entry.mesh.buildingCachedDetailsReady === true;
    const open = entry.entity.building?.activeState?.open !== false;
    let active = false;
    for (let i = 0; i < this.pylonDescriptors.length; i++) {
      active = this.updateDeclaredPylon(entry, this.pylonDescriptors[i], rateAlpha, detailsReady, open) || active;
    }
    for (let i = 0; i < this.tipRelationshipDescriptors.length; i++) {
      active = this.emitTipRelationship(entry, this.tipRelationshipDescriptors[i], detailsReady) || active;
    }
    return active;
  }

  private updateDeclaredPylon(
    entry: AnimatedBuildingEntry,
    descriptor: ResourcePylonHostDescriptor,
    rateAlpha: number,
    detailsReady: boolean,
    open: boolean,
  ): boolean {
    const pylon = descriptor.getPylon(entry.mesh);
    if (!pylon) return false;
    const signedRate = this.clientViewState.getResourcePylonSignedRate(entry.id, descriptor.resource);
    const availability = Math.max(0, Math.min(1, descriptor.getAvailability(entry, open)));
    const targetRate = resourcePylonRateFraction(signedRate, descriptor.getInverseFullRate(entry.entity)) * availability;
    applyResourcePylonDirection(pylon, signedRate);
    if (descriptor.emitMode === 'world') {
      const worldEndpoint = detailsReady && descriptor.writeWorldEndpoint
        ? descriptor.writeWorldEndpoint(entry, pylon)
        : null;
      this.updatePylonFlow(
        entry,
        pylon,
        signedRate,
        targetRate,
        rateAlpha,
        detailsReady,
        detailsReady,
        worldEndpoint,
      );
    } else {
      this.smoothPylonRate(pylon, targetRate, rateAlpha, detailsReady);
    }
    return targetRate > RESOURCE_PYLON_IDLE_EPSILON || this.resourcePylonNeedsFrame(pylon);
  }

  private updatePylonFlow(
    entry: AnimatedBuildingEntry,
    pylon: ResourcePylonRig,
    signedRate: number,
    targetRate: number,
    rateAlpha: number,
    visible: boolean,
    emitBalls: boolean,
    worldEndpoint: THREE.Vector3 | null,
  ): void {
    this.smoothPylonRate(pylon, targetRate, rateAlpha, visible);
    const absRate = Math.abs(signedRate);
    const ownership = entry.entity.ownership;
    if (
      !emitBalls ||
      !ownership ||
      (pylon.displaySmoothedRate < RESOURCE_PYLON_IDLE_EPSILON && absRate <= 0)
    ) {
      return;
    }

    entry.mesh.group.updateWorldMatrix(true, false);
    this.resourcePylonFlows.emitResourcePylonFlow({
      pylon,
      group: entry.mesh.group,
      hostId: entry.id,
      playerId: ownership.playerId,
      targetId: entry.id,
      worldEndpoint,
      endpointRadius: pylon.flowRadius,
      direction: pylon.direction,
      rate: pylon.displaySmoothedRate,
      absRate,
      channel: pylon.channel,
    });
  }

  private smoothPylonRate(
    pylon: ResourcePylonRig,
    targetRate: number,
    rateAlpha: number,
    visible: boolean,
  ): void {
    const target = visible ? Math.max(0, Math.min(1, targetRate)) : 0;
    pylon.smoothedRate += (target - pylon.smoothedRate) * rateAlpha;
    pylon.displaySmoothedRate = pylon.smoothedRate;
  }

  private emitTipRelationship(
    entry: AnimatedBuildingEntry,
    descriptor: ResourcePylonTipRelationshipDescriptor,
    detailsReady: boolean,
  ): boolean {
    const pylonA = descriptor.getPylonA(entry.mesh);
    const pylonB = descriptor.getPylonB(entry.mesh);
    const ownership = entry.entity.ownership;
    if (!pylonA || !pylonB || !detailsReady || !ownership) return false;

    const rateA = this.clientViewState.getResourcePylonSignedRate(entry.id, descriptor.resourceA);
    const rateB = this.clientViewState.getResourcePylonSignedRate(entry.id, descriptor.resourceB);
    let sourcePylon: ResourcePylonRig;
    let sinkPylon: ResourcePylonRig;
    let sourceRate: number;
    let sinkRate: number;
    if (rateA > 0 && rateB < 0) {
      sourcePylon = pylonA;
      sinkPylon = pylonB;
      sourceRate = rateA;
      sinkRate = rateB;
    } else if (rateB > 0 && rateA < 0) {
      sourcePylon = pylonB;
      sinkPylon = pylonA;
      sourceRate = rateB;
      sinkRate = rateA;
    } else {
      return false;
    }

    this.resourcePylonFlows.emitTaxedArc({
      hostId: entry.id,
      playerId: ownership.playerId,
      sourcePylon,
      sinkPylon,
      group: entry.mesh.group,
      sourceRate: sourcePylon.displaySmoothedRate,
      sinkRate: sinkPylon.displaySmoothedRate,
      sourceAbsRate: Math.abs(sourceRate),
      sinkAbsRate: Math.abs(sinkRate),
    });
    return true;
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
