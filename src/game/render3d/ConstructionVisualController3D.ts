import * as THREE from 'three';
import type {
  PylonTubeBirthMode,
  PylonTubeFlow,
  PylonTubeFreeLeg,
  SprayTarget,
} from '@/types/ui';
import {
  BUILD_BUBBLE_RADIUS_COLLISION_MULT,
  BUILD_RATE_DISPLAY_EMA_HALF_LIFE_SEC,
  BUILD_RATE_DISPLAY_EMA_MODE,
  BUILD_RATE_EMA_HALF_LIFE_SEC,
  BUILD_RATE_EMA_MODE,
  SHELL_BAR_COLORS,
} from '@/shellConfig';
import { CONSTRUCTION_TOWER_SPIN_CONFIG } from '@/constructionVisualConfig';
import { ballSpawnRateForResourceRate } from '@/resourceConfig';
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
import { getUnitBlueprint } from '../sim/blueprints';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import { NO_ENTITY_ID } from '../sim/types';
import { isBuildInProgress } from '../sim/buildableHelpers';
import {
  getFactoryBuildSpot,
  getFactoryConstructionRadius,
  type FactoryBuildSpot,
} from '../sim/factoryConstructionSite';
import type { FactoryBuildSpotRig } from './BuildingShape3D';
import type {
  ConstructionEmitterRig,
  ConstructionTowerOrbitPart,
  ConstructionTowerResource,
  ResourcePylonDirection,
  ResourcePylonRig,
} from './ConstructionEmitterMesh3D';
import { hexStringToRgb } from './colorUtils';
import { visualAnimBlend } from './visualAnimationEma';

type ConstructionTowerSpinRig = {
  towerOrbitParts: ConstructionTowerOrbitPart[];
  towerSpinAmount: number;
  displayTowerSpinAmount: number;
  towerSpinPhase: number;
  pylons: ResourcePylonRig[];
};

const RESOURCE_SPRAY_COLORS = [
  hexStringToRgb(SHELL_BAR_COLORS.energy),
  hexStringToRgb(SHELL_BAR_COLORS.metal),
] as const;
const RESOURCE_SPRAY_COLOR_BY_RESOURCE: Record<ConstructionTowerResource, { r: number; g: number; b: number }> = {
  energy: RESOURCE_SPRAY_COLORS[0],
  metal: RESOURCE_SPRAY_COLORS[1],
};

function resourceNameFromCode(resource: ResourceKindCode): ConstructionTowerResource | null {
  if (resource === RESOURCE_KIND_ENERGY) return 'energy';
  if (resource === RESOURCE_KIND_METAL) return 'metal';
  return null;
}

function resourceCodeFromName(resource: ConstructionTowerResource): ResourceKindCode {
  return resource === 'energy' ? RESOURCE_KIND_ENERGY : RESOURCE_KIND_METAL;
}

function pylonDirectionFromCode(direction: ResourceFlowDirectionCode): ResourcePylonDirection {
  return direction === RESOURCE_FLOW_INBOUND ? 'inbound' : 'outbound';
}

function normalizeBuilderPylonRate(amountPerSecond: number, fullRate: number): number {
  if (!Number.isFinite(amountPerSecond) || amountPerSecond <= 0) return 0;
  if (!Number.isFinite(fullRate) || fullRate <= 0) return 1;
  return Math.max(0, Math.min(1, amountPerSecond / fullRate));
}

function pylonTubeFlowKey(
  sourceId: EntityId,
  targetId: EntityId,
  channel: number,
  direction: ResourcePylonDirection,
): string {
  return `${sourceId}:${targetId}:${channel}:${direction}`;
}

export class ConstructionVisualController3D {
  private clientViewState: ClientViewState;
  private factorySprayTargets: SprayTarget[] = [];
  private factorySprayTargetPool: SprayTarget[] = [];
  // Tube-leg bead columns for the orbiting construction-emitter pylons,
  // locked to each pylon's live root->tip axis (see PylonTubeFlowRenderer).
  private tubeFlows: PylonTubeFlow[] = [];
  private tubeFlowPool: PylonTubeFlow[] = [];
  private _factorySpraySourceWorld = new THREE.Vector3();
  private _factorySprayTargetWorld = new THREE.Vector3();
  private _factorySprayRootWorld = new THREE.Vector3();
  private factoryConstructionTargetBySource = new Map<EntityId, EntityId>();
  private _converterSourceRootWorld = new THREE.Vector3();
  private _converterSourceTipWorld = new THREE.Vector3();
  private _converterSinkTipWorld = new THREE.Vector3();
  private _converterSinkRootWorld = new THREE.Vector3();
  private _factoryBuildSpot: FactoryBuildSpot = {
    x: 0,
    y: 0,
    localX: 0,
    localY: 0,
    dirX: 0,
    dirY: 0,
    offset: 0,
  };

  constructor(clientViewState: ClientViewState) {
    this.clientViewState = clientViewState;
  }

  beginFrame(): void {
    for (let i = 0; i < this.factorySprayTargets.length; i++) {
      this.factorySprayTargetPool.push(this.factorySprayTargets[i]);
    }
    this.factorySprayTargets.length = 0;
    for (let i = 0; i < this.tubeFlows.length; i++) {
      this.tubeFlowPool.push(this.tubeFlows[i]);
    }
    this.tubeFlows.length = 0;
  }

  getFactorySprayTargets(): readonly SprayTarget[] {
    return this.factorySprayTargets;
  }

  getTubeFlows(): readonly PylonTubeFlow[] {
    return this.tubeFlows;
  }

  destroy(): void {
    this.factorySprayTargets.length = 0;
    this.factorySprayTargetPool.length = 0;
    this.factoryConstructionTargetBySource.clear();
    this.tubeFlows.length = 0;
    this.tubeFlowPool.length = 0;
  }

  /** Publish one bead column for a pylon's tube leg, locked to its live
   *  world root/tip so it rides the orbiting construction tower. `up`
   *  means beads climb root->tip (consuming); otherwise they fall
   *  tip->root (producing). */
  private pushTubeFlow(
    key: string,
    pylon: ResourcePylonRig,
    root: THREE.Vector3,
    tip: THREE.Vector3,
    up: boolean,
    birthMode: PylonTubeBirthMode,
    intensity: number,
    ballSpawnRate: number | undefined,
    freeLeg: PylonTubeFreeLeg | undefined,
  ): void {
    let flow = this.tubeFlowPool.pop();
    if (!flow) {
      flow = {
        key: '',
        root: { x: 0, y: 0, z: 0 },
        tip: { x: 0, y: 0, z: 0 },
        up: true,
        birthMode: 'rate',
        intensity: 0,
        speed: 0,
        beadRadius: 0,
        colorRGB: { r: 0, g: 0, b: 0 },
      };
    }
    flow.key = key;
    flow.root.x = root.x; flow.root.y = root.y; flow.root.z = root.z;
    flow.tip.x = tip.x; flow.tip.y = tip.y; flow.tip.z = tip.z;
    flow.up = up;
    flow.birthMode = birthMode;
    flow.intensity = Math.min(1, intensity);
    flow.ballSpawnRate = ballSpawnRate;
    flow.speed = pylon.sprayTravelSpeed;
    flow.beadRadius = pylon.tubeBeadRadius;
    const color = RESOURCE_SPRAY_COLOR_BY_RESOURCE[pylon.resource];
    flow.colorRGB.r = color.r; flow.colorRGB.g = color.g; flow.colorRGB.b = color.b;
    if (freeLeg) {
      const out = flow.freeLeg ?? {
        sourceId: freeLeg.sourceId,
        sourcePlayerId: freeLeg.sourcePlayerId,
        target: { id: freeLeg.target.id, pos: { x: 0, y: 0 }, z: 0, radius: 0 },
        flow: freeLeg.flow,
        flowRadius: 0,
        channel: 0,
        speed: 0,
        particleRadius: 0,
        colorRGB: { r: 0, g: 0, b: 0 },
      };
      out.sourceId = freeLeg.sourceId;
      out.sourcePlayerId = freeLeg.sourcePlayerId;
      out.target.id = freeLeg.target.id;
      out.target.pos.x = freeLeg.target.pos.x;
      out.target.pos.y = freeLeg.target.pos.y;
      out.target.z = freeLeg.target.z;
      out.target.radius = freeLeg.target.radius;
      out.flow = freeLeg.flow;
      out.flowRadius = freeLeg.flowRadius;
      out.coneAngle = freeLeg.coneAngle;
      out.channel = freeLeg.channel;
      out.speed = freeLeg.speed;
      out.particleRadius = freeLeg.particleRadius;
      out.colorRGB.r = freeLeg.colorRGB.r;
      out.colorRGB.g = freeLeg.colorRGB.g;
      out.colorRGB.b = freeLeg.colorRGB.b;
      out.endColorRGB = freeLeg.endColorRGB;
      flow.freeLeg = out;
    } else {
      flow.freeLeg = undefined;
    }
    this.tubeFlows.push(flow);
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
    const fullRate = builder?.constructionRate ?? 0;
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

        const cap = builder.constructionRate * dtSec;
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
        halfHeight = target.unit.radius.visual;
        sphereRadius = target.unit.radius.visual;
      }
      this._factorySprayTargetWorld.set(
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
        this._factorySprayTargetWorld,
        sphereRadius,
        fallbackAbsRates,
        'outbound',
      );
    }
  }

  /** Drive a factory's construction emitter (the tower/sprays
   *  rig mounted on the factory's `turretConstruction`). The rate is
   *  read directly from the factory's per-resource transfer fractions.
   *  Spray target follows the live shell once resource flow identifies it,
   *  with the static center bay as a short-lived fallback. */
  updateFactoryConstructionEmitter(
    rig: ConstructionEmitterRig,
    e: Entity,
    detailsReady: boolean,
    dtMs: number,
  ): void {
    const factory = e.factory;
    const selectedUnitBlueprintId = factory?.selectedUnitBlueprintId;
    const active = detailsReady
      && !!factory
      && !!selectedUnitBlueprintId
      && factory.isProducing;
    rig.group.visible = detailsReady;

    const dtSec = dtMs / 1000;
    const halfLife = BUILD_RATE_EMA_HALF_LIFE_SEC[BUILD_RATE_EMA_MODE];
    const rateAlpha = halfLifeBlend(dtSec, halfLife);
    const targetEnergy = active ? Math.max(0, Math.min(1, factory?.energyRateFraction ?? 0)) : 0;
    const targetMetal  = active ? Math.max(0, Math.min(1, factory?.metalRateFraction  ?? 0)) : 0;
    this.updateConstructionTowerSpin(rig, targetEnergy + targetMetal, dtSec);
    this.blendSmoothedRates(rig.smoothedRates, targetEnergy, targetMetal, rateAlpha);
    this.blendDisplaySmoothedRates(rig.displaySmoothedRates, rig.smoothedRates, dtSec);
    this.syncPylonDisplayRates(rig);

    const canTrackBuildSpot = detailsReady
      && !!factory
      && !!selectedUnitBlueprintId
      && !!e.ownership;
    if (!canTrackBuildSpot) return;
    const ownership = e.ownership;
    if (!ownership) return;

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
      targetRadius = this.writeEntityResourceEndpoint(shell, this._factorySprayTargetWorld);
    } else {
      const buildSpot = getFactoryBuildSpot(e, buildSpotRadius, {
        mapWidth: this.clientViewState.getMapWidth(),
        mapHeight: this.clientViewState.getMapHeight(),
        clampRadius: null,
      }, this._factoryBuildSpot);
      this._factorySprayTargetWorld.set(buildSpot.x, e.transform.z, buildSpot.y);
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
      this._factorySprayTargetWorld,
      targetRadius,
      factoryAbsRates,
    );
  }

  /** Drive the factory's "forming unit" visualizer at the center build bay —
   *  ghost orb, core orb, sparks. This is the unit-being-assembled
   *  preview that's specific to factories (commanders/aircraft don't
   *  show a forming-unit shell, they spray at the buildable shell that
   *  already exists in the world). */
  updateFactoryBuildSpot(
    rig: FactoryBuildSpotRig | undefined,
    e: Entity,
    detailsReady: boolean,
    footprintW: number,
    footprintD: number,
    timeMs: number,
  ): void {
    if (!rig) return;

    const factory = e.factory;
    const selectedUnitBlueprintId = factory?.selectedUnitBlueprintId;
    const progress = Math.max(0, Math.min(1, factory?.currentBuildProgress ?? 0));
    const active = detailsReady
      && !!factory
      && !!selectedUnitBlueprintId
      && factory.isProducing;

    if (!active) {
      rig.unitGhost.visible = false;
      rig.unitCore.visible = false;
      for (const spark of rig.sparks) spark.visible = false;
      return;
    }

    let blueprintRadius = Math.min(footprintW, footprintD) * 0.13;
    let buildSpotRadius = blueprintRadius;
    if (selectedUnitBlueprintId) {
      try {
        const bp = getUnitBlueprint(selectedUnitBlueprintId);
        blueprintRadius = bp.radius.visual;
        buildSpotRadius = bp.radius.collision;
      } catch {
        // Unknown selection ids should not break rendering; keep the generic bay ghost.
      }
    }

    const targetGhostRadius = Math.max(8, buildSpotRadius * BUILD_BUBBLE_RADIUS_COLLISION_MULT);
    const easedProgress = progress * progress * (3 - 2 * progress);
    const ghostScaleProgress = 0.28 + easedProgress * 0.72;
    const timeSec = timeMs / 1000;
    const phase = timeSec * 4.7 + e.id * 0.19;
    const pulse = 1 + Math.sin(phase * 1.7) * 0.035;
    const ghostRadius = targetGhostRadius * ghostScaleProgress * pulse;
    const maxBayRadius = Math.max(
      12,
      Math.min(getFactoryConstructionRadius() * 0.34, blueprintRadius * 1.35),
    );
    const baseRadius = Math.max(8, Math.min(maxBayRadius, blueprintRadius * 1.15));
    const radius = baseRadius * (0.28 + easedProgress * 0.72);
    const centerY = Math.max(5, ghostRadius * 0.68);
    const buildSpot = getFactoryBuildSpot(e, buildSpotRadius, {
      mapWidth: this.clientViewState.getMapWidth(),
      mapHeight: this.clientViewState.getMapHeight(),
      clampRadius: null,
    }, this._factoryBuildSpot);
    const localSpotX = buildSpot.localX;
    const localSpotZ = buildSpot.localY;

    rig.unitGhost.visible = false;
    rig.unitGhost.position.set(localSpotX, centerY, localSpotZ);
    rig.unitGhost.scale.setScalar(ghostRadius);

    rig.unitCore.visible = false;
    rig.unitCore.position.set(localSpotX, centerY + radius * 0.08, localSpotZ);
    rig.unitCore.scale.setScalar(Math.max(3, radius * 0.18));

    for (const spark of rig.sparks) spark.visible = false;
  }

  updateAmbientResourcePylon(
    pylon: ResourcePylonRig | undefined,
    host: Entity,
    group: THREE.Group,
    targetRate: number,
    alpha: number,
    visible: boolean,
    emitBalls: boolean,
    worldEndpoint: THREE.Vector3 | null = null,
  ): void {
    if (!pylon) return;
    const target = visible ? Math.max(0, Math.min(1, targetRate)) : 0;
    pylon.smoothedRate += (target - pylon.smoothedRate) * alpha;
    pylon.displaySmoothedRate = pylon.smoothedRate;
    if (!emitBalls || !host.ownership || pylon.displaySmoothedRate < 0.05) return;

    group.updateWorldMatrix(true, false);
    this._factorySpraySourceWorld
      .copy(pylon.topLocal)
      .applyMatrix4(group.matrixWorld);
    this._factorySprayRootWorld
      .copy(pylon.rootLocal)
      .applyMatrix4(group.matrixWorld);
    const spray = this.acquireFactorySprayTarget();
    spray.source.id = host.id;
    spray.source.playerId = host.ownership.playerId;
    spray.target.id = host.id;
    spray.target.dim = undefined;
    spray.target.radius = pylon.flowRadius;
    spray.waypoint = {
      pos: { x: this._factorySpraySourceWorld.x, y: this._factorySpraySourceWorld.z },
      z: this._factorySpraySourceWorld.y,
    };
    // Conserved 3-leg stream through the tip (the waypoint, set above).
    // The tip is the cone apex; the world end disperses through the
    // pylon's ray + cone toward its lock-on spot (`worldEndpoint`).
    // Inbound: world cone -> tip -> root (gaining). Outbound: root ->
    // tip -> world cone (spending).
    if (pylon.direction === 'inbound') {
      spray.source.pos.x = this._factorySpraySourceWorld.x;
      spray.source.pos.y = this._factorySpraySourceWorld.z;
      spray.source.z = this._factorySpraySourceWorld.y;
      spray.flow = 'randomInbound';
      spray.target.pos.x = this._factorySprayRootWorld.x;
      spray.target.pos.y = this._factorySprayRootWorld.z;
      spray.target.z = this._factorySprayRootWorld.y;
    } else {
      spray.source.pos.x = this._factorySprayRootWorld.x;
      spray.source.pos.y = this._factorySprayRootWorld.z;
      spray.source.z = this._factorySprayRootWorld.y;
      spray.flow = 'randomOutbound';
      spray.target.pos.x = this._factorySpraySourceWorld.x;
      spray.target.pos.y = this._factorySpraySourceWorld.z;
      spray.target.z = this._factorySpraySourceWorld.y;
    }
    spray.type = 'build';
    spray.intensity = Math.min(1, pylon.displaySmoothedRate);
    spray.channel = pylon.channel;
    spray.flowRadius = pylon.flowRadius;
    spray.speed = pylon.sprayTravelSpeed;
    spray.particleRadius = pylon.sprayParticleRadius;
    spray.colorRGB = RESOURCE_SPRAY_COLOR_BY_RESOURCE[pylon.resource];
    // Aim the cone from the tip at the building's lock-on spot (sun/sky,
    // ground deposit, wind, etc.). No lock-on -> legacy sphere shell.
    if (worldEndpoint) {
      this.setSprayCone(spray, this._factorySpraySourceWorld, worldEndpoint, pylon.coneAngle);
    }
    // Ball density tracks this producer's absolute output (resources/second)
    // from the single resource-movement channel, not a normalized fraction.
    const ambientAbsRate = Math.abs(
      this.clientViewState.getResourcePylonSignedRate(host.id, resourceCodeFromName(pylon.resource)),
    );
    spray.ballSpawnRate = ballSpawnRateForResourceRate(ambientAbsRate);
  }

  emitConverterResourceTransfer(
    energyPylon: ResourcePylonRig,
    metalPylon: ResourcePylonRig,
    host: Entity,
    group: THREE.Group,
    energySignedRate: number,
    metalSignedRate: number,
    visible: boolean,
    emitBalls: boolean,
  ): void {
    if (!visible || !emitBalls || !host.ownership) return;

    let sourcePylon: ResourcePylonRig;
    let sinkPylon: ResourcePylonRig;
    if (energySignedRate > 0 && metalSignedRate < 0) {
      sourcePylon = energyPylon;
      sinkPylon = metalPylon;
    } else if (metalSignedRate > 0 && energySignedRate < 0) {
      sourcePylon = metalPylon;
      sinkPylon = energyPylon;
    } else {
      return;
    }

    const sourceRate = Math.max(0, sourcePylon.displaySmoothedRate);
    const sinkRate = Math.max(0, sinkPylon.displaySmoothedRate);
    const crossingRate = Math.min(sourceRate, sinkRate);
    const taxRate = Math.max(0, sourceRate - crossingRate);
    // Absolute consumed rate (resources/second) at the source tip, split by
    // the same crossing/tax ratio the normalized rates imply, so converter
    // ball density tracks real throughput rather than the converter's cap.
    const sourceAbs = Math.abs(sourcePylon === energyPylon ? energySignedRate : metalSignedRate);
    const crossingAbs = sourceRate > 0 ? sourceAbs * (crossingRate / sourceRate) : 0;
    const taxAbs = sourceRate > 0 ? sourceAbs * (taxRate / sourceRate) : 0;

    group.updateWorldMatrix(true, false);
    this.writePylonWorldEndpoints(
      sourcePylon,
      group,
      this._converterSourceRootWorld,
      this._converterSourceTipWorld,
    );
    this.writePylonWorldEndpoints(
      sinkPylon,
      group,
      this._converterSinkRootWorld,
      this._converterSinkTipWorld,
    );

    if (crossingRate >= 0.05) {
      const spray = this.acquireFactorySprayTarget();
      spray.source.id = host.id;
      spray.source.playerId = host.ownership.playerId;
      spray.source.pos.x = this._converterSourceRootWorld.x;
      spray.source.pos.y = this._converterSourceRootWorld.z;
      spray.source.z = this._converterSourceRootWorld.y;
      spray.target.id = host.id;
      spray.target.pos.x = this._converterSinkRootWorld.x;
      spray.target.pos.y = this._converterSinkRootWorld.z;
      spray.target.z = this._converterSinkRootWorld.y;
      spray.target.dim = undefined;
      spray.target.radius = 0;
      spray.waypoint = {
        pos: { x: this._converterSourceTipWorld.x, y: this._converterSourceTipWorld.z },
        z: this._converterSourceTipWorld.y,
      };
      spray.waypoint2 = {
        pos: { x: this._converterSinkTipWorld.x, y: this._converterSinkTipWorld.z },
        z: this._converterSinkTipWorld.y,
      };
      spray.type = 'build';
      spray.intensity = Math.min(1, crossingRate);
      spray.channel = 20 + sourcePylon.channel * 2 + sinkPylon.channel;
      spray.flow = 'direct';
      spray.flowRadius = 1;
      spray.speed = Math.max(sourcePylon.sprayTravelSpeed, sinkPylon.sprayTravelSpeed);
      spray.particleRadius = Math.max(sourcePylon.sprayParticleRadius, sinkPylon.sprayParticleRadius);
      spray.colorRGB = RESOURCE_SPRAY_COLOR_BY_RESOURCE[sourcePylon.resource];
      spray.endColorRGB = RESOURCE_SPRAY_COLOR_BY_RESOURCE[sinkPylon.resource];
      spray.ballSpawnRate = ballSpawnRateForResourceRate(crossingAbs);
    }

    if (taxRate >= 0.05) {
      const spray = this.acquireFactorySprayTarget();
      spray.source.id = host.id;
      spray.source.playerId = host.ownership.playerId;
      spray.source.pos.x = this._converterSourceRootWorld.x;
      spray.source.pos.y = this._converterSourceRootWorld.z;
      spray.source.z = this._converterSourceRootWorld.y;
      spray.target.id = host.id;
      spray.target.pos.x = this._converterSourceTipWorld.x;
      spray.target.pos.y = this._converterSourceTipWorld.z;
      spray.target.z = this._converterSourceTipWorld.y;
      spray.target.dim = undefined;
      spray.target.radius = sourcePylon.flowRadius;
      spray.waypoint = {
        pos: { x: this._converterSourceTipWorld.x, y: this._converterSourceTipWorld.z },
        z: this._converterSourceTipWorld.y,
      };
      spray.type = 'build';
      spray.intensity = Math.min(1, taxRate);
      spray.channel = 30 + sourcePylon.channel;
      spray.flow = 'randomOutbound';
      spray.flowRadius = sourcePylon.flowRadius;
      spray.speed = sourcePylon.sprayTravelSpeed;
      spray.particleRadius = sourcePylon.sprayParticleRadius;
      spray.colorRGB = RESOURCE_SPRAY_COLOR_BY_RESOURCE[sourcePylon.resource];
      spray.ballSpawnRate = ballSpawnRateForResourceRate(taxAbs);
      // The two converter pylons point at each other: the dispersing tax
      // sprays from the source tip in a π/4 cone aimed at the sink tip,
      // so the leaked fraction fans toward the receiving pylon and only
      // the crossing arc actually lands on it.
      this.setSprayCone(
        spray,
        this._converterSourceTipWorld,
        this._converterSinkTipWorld,
        sourcePylon.coneAngle,
      );
    }
  }

  private acquireFactorySprayTarget(): SprayTarget {
    let target = this.factorySprayTargetPool.pop();
    if (!target) {
      target = {
        source: { id: 0, pos: { x: 0, y: 0 }, z: 0, playerId: 1 as PlayerId },
        target: { id: 0, pos: { x: 0, y: 0 }, z: 0, radius: 0 },
        type: 'build',
        intensity: 0,
        channel: 0,
        flow: 'direct',
        flowRadius: 0,
      };
    }
    target.colorRGB = undefined;
    target.endColorRGB = undefined;
    target.endpointFade = undefined;
    target.pylonTubeHandoffKey = undefined;
    target.ballSpawnRate = undefined;
    target.waypoint = undefined;
    target.waypoint2 = undefined;
    target.speed = undefined;
    target.particleRadius = undefined;
    target.channel = 0;
    target.flow = 'direct';
    target.flowRadius = 0;
    // coneAxis stays a reusable object; coneAngle (undefined) is the gate.
    target.coneAngle = undefined;
    this.factorySprayTargets.push(target);
    return target;
  }

  private writePylonWorldEndpoints(
    pylon: ResourcePylonRig,
    group: THREE.Group,
    rootOut: THREE.Vector3,
    tipOut: THREE.Vector3,
  ): void {
    rootOut.copy(pylon.rootLocal).applyMatrix4(group.matrixWorld);
    tipOut.copy(pylon.topLocal).applyMatrix4(group.matrixWorld);
  }

  /** Aim a spray's dispersion cone: a ray from the pylon tip at the
   *  lock-on spot, dispersed within `coneAngle`. Both points are in
   *  render coords (x, y=up, z). Sets coneAxis/coneAngle and overrides
   *  flowRadius with the true tip->lock-on distance (the cone length).
   *  No lock-on (degenerate distance) clears the cone -> sphere fallback. */
  private setSprayCone(
    spray: SprayTarget,
    tip: THREE.Vector3,
    lockOn: THREE.Vector3,
    coneAngle: number,
  ): void {
    const dx = lockOn.x - tip.x;
    const dy = lockOn.y - tip.y;
    const dz = lockOn.z - tip.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) {
      spray.coneAngle = undefined;
      return;
    }
    const axis = spray.coneAxis ?? { x: 0, y: 0, z: 0 };
    axis.x = dx / len;
    axis.y = dy / len;
    axis.z = dz / len;
    spray.coneAxis = axis;
    spray.coneAngle = coneAngle;
    spray.flowRadius = len;
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
          endpoint = this._factorySprayTargetWorld;
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
      halfHeight = entity.unit.radius.visual;
      radius = entity.unit.radius.visual;
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
    // `rate` (cap-normalized, EMA-smoothed) still drives birth opacity;
    // `absRate` (resources/second) drives how many balls are born, so density
    // tracks absolute throughput rather than the cap. Keep publishing the tube
    // even at zero birth rate: in-flight beads need the live root/tip while the
    // visual pylon spin EMA settles.
    const ballSpawnRate = ballSpawnRateForResourceRate(absRate);
    pylon.direction = direction;
    // Live world endpoints — the construction tower orbits, so the tip
    // and root move every frame.
    const tip = this._factorySpraySourceWorld
      .copy(pylon.topLocal)
      .applyMatrix4(group.matrixWorld);
    const root = this._factorySprayRootWorld
      .copy(pylon.rootLocal)
      .applyMatrix4(group.matrixWorld);

    const flowKey = pylonTubeFlowKey(sourceId, targetId, channel, direction);
    const color = RESOURCE_SPRAY_COLOR_BY_RESOURCE[pylon.resource];

    let outboundFreeLeg: PylonTubeFreeLeg | undefined;
    if (direction === 'outbound') {
      outboundFreeLeg = {
        sourceId,
        sourcePlayerId,
        target: {
          id: targetId,
          // The lock-on spot: the build target when there is one, else
          // the tip itself. emitFreeLeg derives the cone axis from the
          // LIVE tip to this point each time a bead hands off.
          pos: {
            x: worldEndpoint ? worldEndpoint.x : tip.x,
            y: worldEndpoint ? worldEndpoint.z : tip.z,
          },
          z: worldEndpoint ? worldEndpoint.y : tip.y,
          radius: worldEndpoint ? endpointRadius : pylon.flowRadius,
        },
        // Always a cone from the tip: a tight π/8 cone aimed at the build
        // site when locked on, a bare sphere at the tip otherwise. This
        // is the same ray + cone model every pylon shares.
        flow: 'randomOutbound',
        flowRadius: pylon.flowRadius,
        coneAngle: worldEndpoint ? pylon.coneAngle : undefined,
        channel,
        speed: pylon.sprayTravelSpeed,
        particleRadius: pylon.sprayParticleRadius,
        colorRGB: color,
      };
    }

    // Tube leg: beads are persistent. Outbound births are rate-gated at
    // the root and hand off to one free-leg particle at the tip; inbound
    // beads are born only when a free-leg particle reaches the tip.
    this.pushTubeFlow(
      flowKey,
      pylon,
      root,
      tip,
      direction === 'outbound',
      direction === 'outbound' ? 'rate' : 'handoff',
      rate,
      // Outbound tubes are rate-gated at the root from the absolute rate;
      // inbound tube births arrive one-for-one from free-leg handoffs.
      direction === 'outbound' ? ballSpawnRate : undefined,
      outboundFreeLeg,
    );

    if (direction === 'outbound') return;

    // The world spray now carries only the FREE leg, anchored at the TIP
    // (no waypoint) — the bead column owns everything inside the tube, so
    // no free particle is ever in the bore.
    const spray = this.acquireFactorySprayTarget();
    spray.source.id = sourceId;
    spray.source.playerId = sourcePlayerId;
    spray.target.id = targetId;
    spray.target.dim = undefined;

    // Inbound only (outbound returned above). The free leg flies from the
    // world cone INTO the tip, which is both the cone apex and the
    // down-tube handoff point. Source anchors at the tip; the cone reaches
    // toward the lock-on spot (`worldEndpoint`, e.g. a reclaim target).
    spray.source.pos.x = tip.x;
    spray.source.pos.y = tip.z;
    spray.source.z = tip.y;
    spray.flow = 'randomInbound';
    spray.flowRadius = pylon.flowRadius;
    spray.target.pos.x = tip.x;
    spray.target.pos.y = tip.z;
    spray.target.z = tip.y;
    spray.target.radius = 0;
    if (worldEndpoint) {
      this.setSprayCone(spray, tip, worldEndpoint, pylon.coneAngle);
    }

    spray.type = 'build';
    spray.intensity = Math.min(1, rate);
    spray.channel = channel;
    spray.speed = pylon.sprayTravelSpeed;
    spray.particleRadius = pylon.sprayParticleRadius;
    spray.colorRGB = color;
    spray.endpointFade = 'start';
    spray.pylonTubeHandoffKey = flowKey;
    // Inbound free leg (world -> tip) is the rate-gate; each particle that
    // reaches the tip births one down-tube bead, so the tube stays 1:1.
    spray.ballSpawnRate = ballSpawnRate;
  }
}
