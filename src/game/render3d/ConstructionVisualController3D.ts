import * as THREE from 'three';
import {
  BUILD_RATE_DISPLAY_EMA_HALF_LIFE_SEC,
  BUILD_RATE_DISPLAY_EMA_MODE,
  BUILD_RATE_EMA_HALF_LIFE_SEC,
  BUILD_RATE_EMA_MODE,
} from '@/shellConfig';
import { CONSTRUCTION_TOWER_SPIN_CONFIG } from '@/constructionVisualConfig';
import { getRotationVelEmaMode } from '@/clientBarConfig';
import {
  RESOURCE_FLOW_INBOUND,
  RESOURCE_FLOW_OUTBOUND,
  RESOURCE_KIND_ENERGY,
  RESOURCE_KIND_METAL,
  type ResourceFlowDirectionCode,
  type ResourceKindCode,
} from '@/types/network';
import type { ClientResourcePylonFlow, ClientViewState } from '../network/ClientViewState';
import { halfLifeBlend } from '../network/driftEma';
import { IndexedEntityIdMap } from '../network/IndexedEntityIdCollections';
import { getUnitBlueprint } from '../sim/blueprints';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import { NO_ENTITY_ID } from '../sim/types';
import { isBuildInProgress } from '../sim/buildableHelpers';
import { getBuilderConstructionRate } from '../sim/builderBuildRoster';
import {
  getFactoryBuildSpot,
  type FactoryBuildSpot,
} from '../sim/factoryConstructionSite';
import type {
  ConstructionEmitterRig,
  ConstructionTowerOrbitPart,
  ConstructionTowerResource,
  ResourcePylonDirection,
  ResourcePylonRig,
} from './ConstructionEmitterMesh3D';
import { visualAnimBlend } from './visualAnimationEma';
import { ResourcePylonFlowController3D } from './ResourcePylonFlowController3D';

type ConstructionTowerSpinRig = {
  towerOrbitParts: ConstructionTowerOrbitPart[];
  towerSpinAmount: number;
  displayTowerSpinAmount: number;
  towerSpinPhase: number;
  pylons: ResourcePylonRig[];
};

function resourceNameFromCode(resource: ResourceKindCode): ConstructionTowerResource | null {
  if (resource === RESOURCE_KIND_ENERGY) return 'energy';
  if (resource === RESOURCE_KIND_METAL) return 'metal';
  return null;
}

function pylonDirectionFromCode(direction: ResourceFlowDirectionCode): ResourcePylonDirection {
  return direction === RESOURCE_FLOW_INBOUND ? 'inbound' : 'outbound';
}

function normalizeBuilderPylonRate(amountPerSecond: number, fullRate: number): number {
  if (!Number.isFinite(amountPerSecond) || amountPerSecond <= 0) return 0;
  if (!Number.isFinite(fullRate) || fullRate <= 0) return 1;
  return Math.max(0, Math.min(1, amountPerSecond / fullRate));
}

export class ConstructionVisualController3D {
  private clientViewState: ClientViewState;
  private readonly resourcePylonFlows: ResourcePylonFlowController3D;
  private _resourceEndpointWorld = new THREE.Vector3();
  private factoryConstructionTargetBySource = new IndexedEntityIdMap<EntityId>();
  private _factoryBuildSpot: FactoryBuildSpot = {
    x: 0,
    y: 0,
    localX: 0,
    localY: 0,
    dirX: 0,
    dirY: 0,
    offset: 0,
  };

  constructor(
    clientViewState: ClientViewState,
    resourcePylonFlows: ResourcePylonFlowController3D,
  ) {
    this.clientViewState = clientViewState;
    this.resourcePylonFlows = resourcePylonFlows;
  }

  destroy(): void {
    this.factoryConstructionTargetBySource.clear();
  }

  /** Drop the cached factory→build-target association for a source entity
   *  when its mesh is removed (e.g. a factory dies mid-build). Called from
   *  the renderer entity-removal path, matching how barrelSpinState and
   *  turretBeamAimCache are pruned. Without this the map grows unbounded by
   *  factory count, since resolveFactoryConstructionTarget only self-prunes
   *  while it is still being called for that source. */
  unregister(entityId: EntityId): void {
    this.factoryConstructionTargetBySource.delete(entityId);
  }

  /** Drive a builder-unit's construction emitter (commander, future
   *  construction aircraft, anything with a `builder` component). The
   *  rate is inferred from the build target's paid-resource deltas
   *  against the unit's per-tick construction cap. */
  updateBuilderConstructionEmitter(
    rig: ConstructionEmitterRig,
    builderUnit: Entity,
    dtMs: number,
  ): void {
    const dtSec = dtMs / 1000;
    const halfLife = BUILD_RATE_EMA_HALF_LIFE_SEC[BUILD_RATE_EMA_MODE];
    const rateAlpha = halfLifeBlend(dtSec, halfLife);

    const builder = builderUnit.builder;
    const targetId = builder?.currentBuildTarget ?? NO_ENTITY_ID;
    const flows = this.clientViewState.getResourcePylonFlows(builderUnit.id);
    const fullRate = builder !== null ? getBuilderConstructionRate(builderUnit) : 0;
    let aggregateEnergy = 0;
    let aggregateMetal = 0;
    for (let i = 0; i < flows.length; i++) {
      const flow = flows[i];
      const resource = resourceNameFromCode(flow.resource);
      if (resource === null) continue;
      const normalized = normalizeBuilderPylonRate(flow.amountPerSecond, fullRate);
      if (resource === 'energy') aggregateEnergy += normalized;
      else aggregateMetal += normalized;
    }
    const hasResourceFlows = aggregateEnergy > 0 || aggregateMetal > 0;
    let targetRateE = Math.min(1, aggregateEnergy);
    let targetRateT = Math.min(1, aggregateMetal);
    // Absolute spend (resources/second) for the no-flow fallback path,
    // recovered from the build target's paid-resource deltas. Ball density
    // tracks this, not the builder's per-tick construction cap.
    const fallbackAbsRates = { energy: 0, metal: 0 };

    if (!hasResourceFlows && targetId !== NO_ENTITY_ID && builder && dtSec > 0) {
      const target = this.clientViewState.getEntity(targetId);
      const buildable = target?.buildable;
      if (target && isBuildInProgress(buildable)) {
        if (rig.lastPaidTargetId !== targetId) {
          rig.lastPaid.energy = buildable.paid.energy;
          rig.lastPaid.metal = buildable.paid.metal;
          rig.lastPaidTargetId = targetId;
        }
        const dE = Math.max(0, buildable.paid.energy - rig.lastPaid.energy);
        const dT = Math.max(0, buildable.paid.metal - rig.lastPaid.metal);
        rig.lastPaid.energy = buildable.paid.energy;
        rig.lastPaid.metal = buildable.paid.metal;
        fallbackAbsRates.energy = dE / dtSec;
        fallbackAbsRates.metal = dT / dtSec;

        const cap = fullRate * dtSec;
        if (cap > 0) {
          targetRateE = Math.max(0, Math.min(1, dE / cap));
          targetRateT = Math.max(0, Math.min(1, dT / cap));
        }
      }
    } else {
      rig.lastPaidTargetId = null;
    }

    this.updateConstructionTowerSpin(rig, targetRateE + targetRateT, dtSec);
    this.blendSmoothedRates(rig.smoothedRates, targetRateE, targetRateT, rateAlpha);
    this.blendDisplaySmoothedRates(rig.displaySmoothedRates, rig.smoothedRates, dtSec);
    this.syncPylonDisplayRates(rig);

    if (!builderUnit.ownership) return;
    rig.group.updateWorldMatrix(true, false);

    if (hasResourceFlows) {
      this.emitBuilderResourceFlowSprays(
        rig,
        rig.group,
        builderUnit.id,
        builderUnit.ownership.playerId,
        flows,
        aggregateEnergy,
        aggregateMetal,
        fullRate,
      );
      return;
    }

    if (targetId !== NO_ENTITY_ID) {
      const target = this.clientViewState.getEntity(targetId);
      if (!target) return;
      let halfHeight = 8;
      let sphereRadius = 12;
      const b = target.building;
      if (b) {
        halfHeight = b.depth * 0.5;
        sphereRadius = Math.hypot(b.width, b.height, b.depth) * 0.5;
      } else if (target.unit) {
        halfHeight = target.unit.radius.other;
        sphereRadius = target.unit.radius.other;
      }
      this._resourceEndpointWorld.set(
        target.transform.x,
        target.transform.z + halfHeight,
        target.transform.y,
      );
      this.emitPylonResourceSprays(
        rig,
        rig.group,
        builderUnit.id,
        builderUnit.ownership.playerId,
        target.id,
        this._resourceEndpointWorld,
        sphereRadius,
        fallbackAbsRates,
        'outbound',
      );
    }
  }

  /** Drive a factory's construction emitter (the tower/sprays
   *  rig mounted on the factory's construction pylons). The rate is
   *  read directly from the factory's per-resource transfer fractions.
   *  Spray target follows the live shell once resource flow identifies it,
   *  with the static center bay as a short-lived fallback. */
  updateFactoryConstructionEmitter(
    rig: ConstructionEmitterRig,
    e: Entity,
    detailsReady: boolean,
    dtMs: number,
  ): boolean {
    const factory = e.factory;
    const selectedUnitBlueprintId = factory?.selectedUnitBlueprintId;
    const active = detailsReady
      && !!factory
      && !!selectedUnitBlueprintId
      && factory.isProducing;
    // The emitter rig is part of the host turret mesh and should
    // materialize with the host. Only the spray/resource activity is gated
    // on the completed factory state.
    rig.group.visible = true;

    const dtSec = dtMs / 1000;
    const halfLife = BUILD_RATE_EMA_HALF_LIFE_SEC[BUILD_RATE_EMA_MODE];
    const rateAlpha = halfLifeBlend(dtSec, halfLife);
    const targetEnergy = active ? Math.max(0, Math.min(1, factory?.energyRateFraction ?? 0)) : 0;
    const targetMetal  = active ? Math.max(0, Math.min(1, factory?.metalRateFraction  ?? 0)) : 0;
    this.resetConstructionTowerSpin(rig);
    this.blendSmoothedRates(rig.smoothedRates, targetEnergy, targetMetal, rateAlpha);
    this.blendDisplaySmoothedRates(rig.displaySmoothedRates, rig.smoothedRates, dtSec);
    this.syncPylonDisplayRates(rig);
    const visualActive =
      active ||
      rig.smoothedRates.energy > 0.001 ||
      rig.smoothedRates.metal > 0.001 ||
      rig.displaySmoothedRates.energy > 0.001 ||
      rig.displaySmoothedRates.metal > 0.001;

    const canTrackBuildSpot = detailsReady
      && !!factory
      && !!selectedUnitBlueprintId
      && !!e.ownership;
    if (!canTrackBuildSpot) return visualActive;
    const ownership = e.ownership;
    if (!ownership) return visualActive;

    let buildSpotRadius = 12;
    if (selectedUnitBlueprintId) {
      try {
        buildSpotRadius = getUnitBlueprint(selectedUnitBlueprintId).radius.collision;
      } catch {
        // Unknown selection ids should not break rendering; keep the default.
      }
    }
    rig.group.updateWorldMatrix(true, false);
    let targetId = e.id;
    let targetRadius = buildSpotRadius;
    const shell = this.resolveFactoryConstructionTarget(e.id, ownership.playerId);
    if (shell !== null) {
      targetId = shell.id;
      targetRadius = this.writeEntityResourceEndpoint(shell, this._resourceEndpointWorld);
    } else {
      const buildSpot = getFactoryBuildSpot(e, buildSpotRadius, {
        mapWidth: this.clientViewState.getMapWidth(),
        mapHeight: this.clientViewState.getMapHeight(),
        clampRadius: null,
      }, this._factoryBuildSpot);
      this._resourceEndpointWorld.set(buildSpot.x, e.transform.z, buildSpot.y);
    }
    // Absolute construction spend (resources/second) for THIS factory, read
    // from the single resource-movement channel (factory build payments are
    // recorded with the factory as their source entity). Ball density tracks
    // this, not the factory's per-tick cap.
    const factoryAbsRates = {
      energy: Math.abs(this.clientViewState.getResourcePylonSignedRate(e.id, RESOURCE_KIND_ENERGY)),
      metal: Math.abs(this.clientViewState.getResourcePylonSignedRate(e.id, RESOURCE_KIND_METAL)),
    };
    this.emitPylonResourceSprays(
      rig,
      rig.group,
      e.id,
      ownership.playerId,
      targetId,
      this._resourceEndpointWorld,
      targetRadius,
      factoryAbsRates,
    );
    return visualActive;
  }

  private updateConstructionTowerSpin(
    rig: ConstructionTowerSpinRig,
    resourceRateSum: number,
    dtSec: number,
  ): void {
    if (rig.towerOrbitParts.length === 0) return;
    const alpha = visualAnimBlend(
      getRotationVelEmaMode(),
      dtSec,
      CONSTRUCTION_TOWER_SPIN_CONFIG.driftHalfLifeMultiplier,
    );
    const target = Math.max(0, resourceRateSum);
    const amountBefore = rig.displayTowerSpinAmount;
    rig.towerSpinAmount += (target - rig.towerSpinAmount) * alpha;
    if (target === 0 && rig.towerSpinAmount < 0.001) {
      rig.towerSpinAmount = 0;
    }
    const displayAlpha = halfLifeBlend(
      dtSec,
      BUILD_RATE_DISPLAY_EMA_HALF_LIFE_SEC[BUILD_RATE_DISPLAY_EMA_MODE],
    );
    rig.displayTowerSpinAmount += (rig.towerSpinAmount - rig.displayTowerSpinAmount) * displayAlpha;
    if (rig.towerSpinAmount === 0 && rig.displayTowerSpinAmount < 0.001) {
      rig.displayTowerSpinAmount = 0;
    }
    if (rig.displayTowerSpinAmount > 0) {
      rig.towerSpinPhase =
        (rig.towerSpinPhase + dtSec * CONSTRUCTION_TOWER_SPIN_CONFIG.radPerSec * rig.displayTowerSpinAmount)
        % (Math.PI * 2);
    }
    if (amountBefore === 0 && rig.displayTowerSpinAmount === 0) return;
    const c = Math.cos(rig.towerSpinPhase);
    const s = Math.sin(rig.towerSpinPhase);
    for (let i = 0; i < rig.towerOrbitParts.length; i++) {
      const part = rig.towerOrbitParts[i];
      part.mesh.position.x = part.baseX * c - part.baseZ * s;
      part.mesh.position.z = part.baseX * s + part.baseZ * c;
      part.mesh.rotation.y = part.baseRotationY + rig.towerSpinPhase;
    }
    for (let i = 0; i < rig.pylons.length; i++) {
      const pylon = rig.pylons[i];
      const base = pylon.topBaseLocal;
      const current = pylon.topLocal;
      current.x = base.x * c - base.z * s;
      current.y = base.y;
      current.z = base.x * s + base.z * c;
      const rootBase = pylon.rootBaseLocal;
      const root = pylon.rootLocal;
      root.x = rootBase.x * c - rootBase.z * s;
      root.y = rootBase.y;
      root.z = rootBase.x * s + rootBase.z * c;
    }
  }

  private resetConstructionTowerSpin(rig: ConstructionTowerSpinRig): void {
    if (
      rig.towerOrbitParts.length === 0 ||
      (
        rig.towerSpinPhase === 0 &&
        rig.towerSpinAmount === 0 &&
        rig.displayTowerSpinAmount === 0
      )
    ) {
      return;
    }
    rig.towerSpinPhase = 0;
    rig.towerSpinAmount = 0;
    rig.displayTowerSpinAmount = 0;
    for (let i = 0; i < rig.towerOrbitParts.length; i++) {
      const part = rig.towerOrbitParts[i];
      part.mesh.position.x = part.baseX;
      part.mesh.position.z = part.baseZ;
      part.mesh.rotation.y = part.baseRotationY;
    }
    for (let i = 0; i < rig.pylons.length; i++) {
      const pylon = rig.pylons[i];
      pylon.topLocal.copy(pylon.topBaseLocal);
      pylon.rootLocal.copy(pylon.rootBaseLocal);
    }
  }

  private blendSmoothedRates(
    smoothed: { energy: number; metal: number },
    targetEnergy: number,
    targetMetal: number,
    alpha: number,
  ): void {
    smoothed.energy += (targetEnergy - smoothed.energy) * alpha;
    smoothed.metal  += (targetMetal  - smoothed.metal)  * alpha;
  }

  private blendDisplaySmoothedRates(
    display: { energy: number; metal: number },
    smoothed: { energy: number; metal: number },
    dtSec: number,
  ): void {
    const alpha = halfLifeBlend(
      dtSec,
      BUILD_RATE_DISPLAY_EMA_HALF_LIFE_SEC[BUILD_RATE_DISPLAY_EMA_MODE],
    );
    display.energy += (smoothed.energy - display.energy) * alpha;
    display.metal  += (smoothed.metal  - display.metal)  * alpha;
  }

  private syncPylonDisplayRates(rig: {
    pylons: ResourcePylonRig[];
    displaySmoothedRates: { energy: number; metal: number };
  }): void {
    for (let i = 0; i < rig.pylons.length; i++) {
      const pylon = rig.pylons[i];
      pylon.displaySmoothedRate = rig.displaySmoothedRates[pylon.resource];
    }
  }

  private emitPylonResourceSprays(
    rig: {
      pylons: ResourcePylonRig[];
      displaySmoothedRates: { energy: number; metal: number };
    },
    group: THREE.Group,
    sourceId: EntityId,
    sourcePlayerId: PlayerId,
    targetId: EntityId,
    targetWorld: THREE.Vector3,
    targetRadius: number,
    absRateByResource: { energy: number; metal: number },
    direction: ResourcePylonDirection = 'outbound',
  ): void {
    for (let i = 0; i < rig.pylons.length; i++) {
      const pylon = rig.pylons[i];
      const rate = rig.displaySmoothedRates[pylon.resource];
      this.emitPylonResourceSpray(
        pylon,
        group,
        sourceId,
        sourcePlayerId,
        targetId,
        targetWorld,
        targetRadius,
        direction,
        rate,
        absRateByResource[pylon.resource],
        pylon.channel,
      );
    }
  }

  private emitBuilderResourceFlowSprays(
    rig: {
      pylons: ResourcePylonRig[];
      displaySmoothedRates: { energy: number; metal: number };
    },
    group: THREE.Group,
    sourceId: EntityId,
    sourcePlayerId: PlayerId,
    flows: readonly ClientResourcePylonFlow[],
    aggregateEnergy: number,
    aggregateMetal: number,
    fullRate: number,
  ): void {
    for (let i = 0; i < flows.length; i++) {
      const flow = flows[i];
      const resource = resourceNameFromCode(flow.resource);
      if (resource === null) continue;
      const aggregate = resource === 'energy' ? aggregateEnergy : aggregateMetal;
      if (aggregate <= 0) continue;
      const pylon = this.findResourcePylon(rig, resource);
      if (!pylon) continue;
      const normalized = normalizeBuilderPylonRate(flow.amountPerSecond, fullRate);
      if (normalized <= 0) continue;
      const rate = rig.displaySmoothedRates[resource] * Math.min(1, normalized / aggregate);

      const direction = pylonDirectionFromCode(flow.direction);
      pylon.direction = direction;
      let targetId = sourceId;
      let endpoint: THREE.Vector3 | null = null;
      let endpointRadius = pylon.flowRadius;
      if (flow.targetEntityId !== null) {
        const target = this.clientViewState.getEntity(flow.targetEntityId);
        if (target) {
          targetId = target.id;
          endpoint = this._resourceEndpointWorld;
          endpointRadius = this.writeEntityResourceEndpoint(target, endpoint);
        }
      }

      this.emitPylonResourceSpray(
        pylon,
        group,
        sourceId,
        sourcePlayerId,
        targetId,
        endpoint,
        endpointRadius,
        direction,
        rate,
        Math.max(0, flow.amountPerSecond),
        pylon.channel + (direction === 'inbound' ? 10 : 0),
      );
    }
  }

  private findResourcePylon(
    rig: { pylons: ResourcePylonRig[] },
    resource: ConstructionTowerResource,
  ): ResourcePylonRig | undefined {
    for (let i = 0; i < rig.pylons.length; i++) {
      const pylon = rig.pylons[i];
      if (pylon.resource === resource) return pylon;
    }
    return undefined;
  }

  private isFactoryConstructionTarget(entity: Entity | undefined, playerId: PlayerId): entity is Entity {
    return entity !== undefined
      && entity.unit !== null
      && entity.buildable !== null
      && isBuildInProgress(entity.buildable)
      && entity.ownership !== null
      && entity.ownership.playerId === playerId;
  }

  private resolveFactoryConstructionTarget(sourceId: EntityId, playerId: PlayerId): Entity | null {
    const flows = this.clientViewState.getResourcePylonFlows(sourceId);
    for (let i = 0; i < flows.length; i++) {
      const flow = flows[i];
      if (flow.direction !== RESOURCE_FLOW_OUTBOUND || flow.targetEntityId === null) continue;
      const target = this.clientViewState.getEntity(flow.targetEntityId);
      if (!this.isFactoryConstructionTarget(target, playerId)) continue;
      this.factoryConstructionTargetBySource.set(sourceId, target.id);
      return target;
    }

    const cachedTargetId = this.factoryConstructionTargetBySource.get(sourceId);
    if (cachedTargetId === undefined) return null;
    const cachedTarget = this.clientViewState.getEntity(cachedTargetId);
    if (this.isFactoryConstructionTarget(cachedTarget, playerId)) {
      return cachedTarget;
    }
    this.factoryConstructionTargetBySource.delete(sourceId);
    return null;
  }

  private writeEntityResourceEndpoint(entity: Entity, out: THREE.Vector3): number {
    let halfHeight = 8;
    let radius = 12;
    if (entity.building) {
      halfHeight = entity.building.depth * 0.5;
      radius = Math.hypot(entity.building.width, entity.building.height, entity.building.depth) * 0.5;
    } else if (entity.unit) {
      halfHeight = entity.unit.radius.other;
      radius = entity.unit.radius.other;
    }
    out.set(entity.transform.x, entity.transform.z + halfHeight, entity.transform.y);
    return Math.max(1, radius);
  }

  private emitPylonResourceSpray(
    pylon: ResourcePylonRig,
    group: THREE.Group,
    sourceId: EntityId,
    sourcePlayerId: PlayerId,
    targetId: EntityId,
    worldEndpoint: THREE.Vector3 | null,
    endpointRadius: number,
    direction: ResourcePylonDirection,
    rate: number,
    absRate: number,
    channel: number,
  ): void {
    this.resourcePylonFlows.emitResourcePylonFlow({
      pylon,
      group,
      hostId: sourceId,
      playerId: sourcePlayerId,
      targetId,
      worldEndpoint,
      endpointRadius,
      direction,
      rate,
      absRate,
      channel,
    });
  }
}
