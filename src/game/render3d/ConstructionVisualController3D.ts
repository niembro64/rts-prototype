import * as THREE from 'three';
import type { SprayTarget } from '@/types/ui';
import {
  BUILD_BUBBLE_RADIUS_COLLISION_MULT,
  BUILD_RATE_DISPLAY_EMA_HALF_LIFE_SEC,
  BUILD_RATE_DISPLAY_EMA_MODE,
  BUILD_RATE_EMA_HALF_LIFE_SEC,
  BUILD_RATE_EMA_MODE,
  SHELL_BAR_COLORS,
} from '@/shellConfig';
import { CONSTRUCTION_TOWER_SPIN_CONFIG } from '@/constructionVisualConfig';
import { getRotationVelEmaMode } from '@/clientBarConfig';
import type { ClientViewState } from '../network/ClientViewState';
import { halfLifeBlend } from '../network/driftEma';
import { getTransformCosSin } from '../math';
import { getUnitBlueprint } from '../sim/blueprints';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import { NO_ENTITY_ID } from '../sim/types';
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

export class ConstructionVisualController3D {
  private clientViewState: ClientViewState;
  private factorySprayTargets: SprayTarget[] = [];
  private factorySprayTargetPool: SprayTarget[] = [];
  private _factorySpraySourceWorld = new THREE.Vector3();
  private _factorySprayTargetWorld = new THREE.Vector3();
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
  }

  getFactorySprayTargets(): readonly SprayTarget[] {
    return this.factorySprayTargets;
  }

  destroy(): void {
    this.factorySprayTargets.length = 0;
    this.factorySprayTargetPool.length = 0;
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

    const targetId = builderUnit.builder?.currentBuildTarget ?? NO_ENTITY_ID;
    let targetRateE = 0;
    let targetRateT = 0;
    if (targetId !== NO_ENTITY_ID && builderUnit.builder && dtSec > 0) {
      const target = this.clientViewState.getEntity(targetId);
      const buildable = target?.buildable;
      if (target && buildable && !buildable.isComplete) {
        if (rig.lastPaidTargetId !== targetId) {
          rig.lastPaid.energy = buildable.paid.energy;
          rig.lastPaid.metal = buildable.paid.metal;
          rig.lastPaidTargetId = targetId;
        }
        const dE = Math.max(0, buildable.paid.energy - rig.lastPaid.energy);
        const dT = Math.max(0, buildable.paid.metal - rig.lastPaid.metal);
        rig.lastPaid.energy = buildable.paid.energy;
        rig.lastPaid.metal = buildable.paid.metal;

        const cap = builderUnit.builder.constructionRate * dtSec;
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
    this.applyShowerFromSmoothedRates(rig);

    if (targetId !== null && builderUnit.ownership) {
      const target = this.clientViewState.getEntity(targetId);
      if (!target) return;
      rig.group.updateWorldMatrix(true, false);
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
      );
    }
  }

  /** Drive a factory's construction emitter (the tower/showers/sprays
   *  rig mounted on the factory's `turretConstruction`). The rate is
   *  read directly from the factory's per-resource transfer fractions.
   *  Spray target is the factory's external build spot. */
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
    this.applyShowerFromSmoothedRates(rig);

    if (!active || !e.ownership) return;

    let buildSpotRadius = 12;
    if (selectedUnitBlueprintId) {
      try {
        buildSpotRadius = getUnitBlueprint(selectedUnitBlueprintId).radius.collision;
      } catch {
        // Unknown selection ids should not break rendering; keep the default.
      }
    }
    const buildSpot = getFactoryBuildSpot(e, buildSpotRadius, {
      mapWidth: this.clientViewState.getMapWidth(),
      mapHeight: this.clientViewState.getMapHeight(),
      clampRadius: null,
    }, this._factoryBuildSpot);
    rig.group.updateWorldMatrix(true, false);
    this._factorySprayTargetWorld.set(buildSpot.x, e.transform.z, buildSpot.y);
    this.emitPylonResourceSprays(
      rig,
      rig.group,
      e.id,
      e.ownership.playerId,
      e.id,
      this._factorySprayTargetWorld,
      buildSpotRadius,
    );
  }

  /** Drive the factory's "forming unit" visualizer at the build spot —
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
    const spotDx = buildSpot.x - e.transform.x;
    const spotDz = buildSpot.y - e.transform.y;
    const { cos, sin } = getTransformCosSin(e.transform);
    const localSpotX = cos * spotDx + sin * spotDz;
    const localSpotZ = -sin * spotDx + cos * spotDz;

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
  ): void {
    if (!pylon) return;
    const target = visible ? Math.max(0, Math.min(1, targetRate)) : 0;
    pylon.smoothedRate += (target - pylon.smoothedRate) * alpha;
    pylon.displaySmoothedRate = pylon.smoothedRate;
    this.applyResourcePylonShower(pylon);
    if (!emitBalls || !host.ownership || pylon.displaySmoothedRate < 0.05) return;

    group.updateWorldMatrix(true, false);
    this._factorySpraySourceWorld
      .copy(pylon.topLocal)
      .applyMatrix4(group.matrixWorld);
    const spray = this.acquireFactorySprayTarget();
    spray.source.id = host.id;
    spray.source.pos.x = this._factorySpraySourceWorld.x;
    spray.source.pos.y = this._factorySpraySourceWorld.z;
    spray.source.z = this._factorySpraySourceWorld.y;
    spray.source.playerId = host.ownership.playerId;
    spray.target.id = host.id;
    spray.target.pos.x = this._factorySpraySourceWorld.x;
    spray.target.pos.y = this._factorySpraySourceWorld.z;
    spray.target.z = this._factorySpraySourceWorld.y;
    spray.target.dim = undefined;
    spray.target.radius = pylon.flowRadius;
    spray.type = 'build';
    spray.intensity = Math.min(1, pylon.displaySmoothedRate);
    spray.channel = pylon.channel;
    spray.flow = pylon.direction === 'inbound' ? 'randomInbound' : 'randomOutbound';
    spray.flowRadius = pylon.flowRadius;
    spray.speed = pylon.sprayTravelSpeed;
    spray.particleRadius = pylon.sprayParticleRadius;
    spray.colorRGB = RESOURCE_SPRAY_COLOR_BY_RESOURCE[pylon.resource];
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
    target.speed = undefined;
    target.particleRadius = undefined;
    target.channel = 0;
    target.flow = 'direct';
    target.flowRadius = 0;
    this.factorySprayTargets.push(target);
    return target;
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

  private applyShowerFromSmoothedRates(rig: {
    pylons: ResourcePylonRig[];
    displaySmoothedRates: { energy: number; metal: number };
  }): void {
    for (let i = 0; i < rig.pylons.length; i++) {
      const pylon = rig.pylons[i];
      pylon.displaySmoothedRate = rig.displaySmoothedRates[pylon.resource];
      this.applyResourcePylonShower(pylon);
    }
  }

  private applyResourcePylonShower(pylon: ResourcePylonRig): void {
    const r = pylon.displaySmoothedRate;
    if (r < 0.01) {
      pylon.shower.visible = false;
      return;
    }
    pylon.shower.visible = true;
    const h = pylon.pylonHeight * r;
    pylon.shower.scale.set(pylon.showerRadius * 2, h, pylon.showerRadius * 2);
    pylon.shower.position.y = pylon.pylonBaseY + h / 2;
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
  ): void {
    for (let i = 0; i < rig.pylons.length; i++) {
      const pylon = rig.pylons[i];
      const rate = rig.displaySmoothedRates[pylon.resource];
      if (rate < 0.05) continue;
      this._factorySpraySourceWorld
        .copy(pylon.topLocal)
        .applyMatrix4(group.matrixWorld);
      const spray = this.acquireFactorySprayTarget();
      spray.source.id = sourceId;
      spray.source.pos.x = this._factorySpraySourceWorld.x;
      spray.source.pos.y = this._factorySpraySourceWorld.z;
      spray.source.z = this._factorySpraySourceWorld.y;
      spray.source.playerId = sourcePlayerId;
      spray.target.id = targetId;
      spray.target.pos.x = targetWorld.x;
      spray.target.pos.y = targetWorld.z;
      spray.target.z = targetWorld.y;
      spray.target.dim = undefined;
      spray.target.radius = targetRadius;
      spray.type = 'build';
      spray.intensity = Math.min(1, rate);
      spray.channel = pylon.channel;
      spray.flow = 'direct';
      spray.flowRadius = 0;
      spray.speed = pylon.sprayTravelSpeed;
      spray.particleRadius = pylon.sprayParticleRadius;
      spray.colorRGB = RESOURCE_SPRAY_COLOR_BY_RESOURCE[pylon.resource];
    }
  }
}
