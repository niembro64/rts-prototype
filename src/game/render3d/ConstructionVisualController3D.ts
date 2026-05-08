import * as THREE from 'three';
import type { ConcreteGraphicsQuality } from '@/types/graphics';
import type { SprayTarget } from '@/types/ui';
import {
  BUILD_BUBBLE_RADIUS_PUSH_MULT,
  BUILD_RATE_DISPLAY_EMA_HALF_LIFE_SEC,
  BUILD_RATE_DISPLAY_EMA_MODE,
  BUILD_RATE_EMA_HALF_LIFE_SEC,
  BUILD_RATE_EMA_MODE,
  SHELL_BAR_COLORS,
} from '@/shellConfig';
import { CONSTRUCTION_TOWER_SPIN_CONFIG } from '@/constructionVisualConfig';
import { getDriftMode } from '@/clientBarConfig';
import type { ClientViewState } from '../network/ClientViewState';
import { halfLifeBlend, getDriftPreset } from '../network/driftEma';
import { getTransformCosSin } from '../math';
import { getUnitBlueprint } from '../sim/blueprints';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import {
  getFactoryBuildSpot,
  getFactoryConstructionRadius,
  type FactoryBuildSpot,
} from '../sim/factoryConstructionSite';
import type { FactoryConstructionRig } from './BuildingShape3D';
import type { ConstructionEmitterRig, ConstructionTowerOrbitPart } from './ConstructionEmitterMesh3D';
import { buildingTierAtLeast } from './RenderTier3D';
import { hexStringToRgb } from './colorUtils';

type ConstructionTowerSpinRig = {
  towerOrbitParts: ConstructionTowerOrbitPart[];
  towerSpinAmount: number;
  displayTowerSpinAmount: number;
  towerSpinPhase: number;
  pylonTopsLocal: THREE.Vector3[];
  pylonTopBaseLocals: THREE.Vector3[];
};

const RESOURCE_SPRAY_COLORS = [
  hexStringToRgb(SHELL_BAR_COLORS.energy),
  hexStringToRgb(SHELL_BAR_COLORS.mana),
  hexStringToRgb(SHELL_BAR_COLORS.metal),
] as const;

export class ConstructionVisualController3D {
  private clientViewState: ClientViewState;
  private factorySprayTargets: SprayTarget[] = [];
  private factorySprayTargetPool: SprayTarget[] = [];
  private _factorySprayTargetLocal = new THREE.Vector3();
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

  updateCommanderEmitter(
    rig: ConstructionEmitterRig,
    commander: Entity,
    tier: ConcreteGraphicsQuality,
    dtMs: number,
  ): void {
    const dtSec = dtMs / 1000;
    const halfLife = BUILD_RATE_EMA_HALF_LIFE_SEC[BUILD_RATE_EMA_MODE];
    const rateAlpha = halfLifeBlend(dtSec, halfLife);

    const targetId = commander.builder?.currentBuildTarget ?? null;
    let targetRateE = 0;
    let targetRateM = 0;
    let targetRateT = 0;
    if (targetId !== null && commander.builder && dtSec > 0) {
      const target = this.clientViewState.getEntity(targetId);
      const buildable = target?.buildable;
      if (target && buildable && !buildable.isComplete) {
        if (rig.lastPaidTargetId !== targetId) {
          rig.lastPaid.energy = buildable.paid.energy;
          rig.lastPaid.mana = buildable.paid.mana;
          rig.lastPaid.metal = buildable.paid.metal;
          rig.lastPaidTargetId = targetId;
        }
        const dE = Math.max(0, buildable.paid.energy - rig.lastPaid.energy);
        const dM = Math.max(0, buildable.paid.mana - rig.lastPaid.mana);
        const dT = Math.max(0, buildable.paid.metal - rig.lastPaid.metal);
        rig.lastPaid.energy = buildable.paid.energy;
        rig.lastPaid.mana = buildable.paid.mana;
        rig.lastPaid.metal = buildable.paid.metal;

        const cap = commander.builder.constructionRate * dtSec;
        if (cap > 0) {
          targetRateE = Math.max(0, Math.min(1, dE / cap));
          targetRateM = Math.max(0, Math.min(1, dM / cap));
          targetRateT = Math.max(0, Math.min(1, dT / cap));
        }
      }
    } else {
      rig.lastPaidTargetId = null;
    }

    this.updateConstructionTowerSpin(rig, targetRateE + targetRateM + targetRateT, dtSec);
    this.blendSmoothedRates(rig.smoothedRates, targetRateE, targetRateM, targetRateT, rateAlpha);
    this.blendDisplaySmoothedRates(rig.displaySmoothedRates, rig.smoothedRates, dtSec);
    this.applyShowerFromSmoothedRates(rig);

    if (
      buildingTierAtLeast(tier, 'high')
      && targetId !== null
      && commander.ownership
    ) {
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
        halfHeight = target.unit.radius.body;
        sphereRadius = target.unit.radius.body;
      }
      this._factorySprayTargetWorld.set(
        target.transform.x,
        target.transform.z + halfHeight,
        target.transform.y,
      );
      this.emitPylonResourceSprays(
        rig,
        rig.group,
        commander.id,
        commander.ownership.playerId,
        target.id,
        this._factorySprayTargetWorld,
        sphereRadius,
      );
    }
  }

  updateFactoryConstructionRig(
    rig: FactoryConstructionRig | undefined,
    e: Entity,
    tier: ConcreteGraphicsQuality,
    detailsReady: boolean,
    footprintW: number,
    footprintD: number,
    group: THREE.Group,
    dtMs: number,
    timeMs: number,
  ): void {
    if (!rig) return;

    const factory = e.factory;
    const queuedUnitType = factory?.buildQueue[0];
    const progress = Math.max(0, Math.min(1, factory?.currentBuildProgress ?? 0));
    const active = detailsReady
      && !!factory
      && !!queuedUnitType
      && factory.isProducing;
    rig.group.visible = buildingTierAtLeast(tier, 'medium');

    const dtSec = dtMs / 1000;
    const halfLife = BUILD_RATE_EMA_HALF_LIFE_SEC[BUILD_RATE_EMA_MODE];
    const rateAlpha = halfLifeBlend(dtSec, halfLife);
    const targetEnergy = active ? Math.max(0, Math.min(1, factory?.energyRateFraction ?? 0)) : 0;
    const targetMana   = active ? Math.max(0, Math.min(1, factory?.manaRateFraction   ?? 0)) : 0;
    const targetMetal  = active ? Math.max(0, Math.min(1, factory?.metalRateFraction  ?? 0)) : 0;
    this.updateConstructionTowerSpin(rig, targetEnergy + targetMana + targetMetal, dtSec);
    this.blendSmoothedRates(rig.smoothedRates, targetEnergy, targetMana, targetMetal, rateAlpha);
    this.blendDisplaySmoothedRates(rig.displaySmoothedRates, rig.smoothedRates, dtSec);

    if (!active) {
      rig.unitGhost.visible = false;
      rig.unitCore.visible = false;
      for (const spark of rig.sparks) spark.visible = false;
      this.applyShowerFromSmoothedRates(rig);
      return;
    }

    this.applyShowerFromSmoothedRates(rig);

    let blueprintRadius = Math.min(footprintW, footprintD) * 0.13;
    let buildSpotRadius = blueprintRadius;
    if (queuedUnitType) {
      try {
        const bp = getUnitBlueprint(queuedUnitType);
        blueprintRadius = bp.radius.body;
        buildSpotRadius = bp.radius.push;
      } catch {
        // Unknown queue ids should not break rendering; keep the generic bay ghost.
      }
    }

    const targetGhostRadius = Math.max(8, buildSpotRadius * BUILD_BUBBLE_RADIUS_PUSH_MULT);
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

    if (buildingTierAtLeast(tier, 'high') && e.ownership) {
      group.updateWorldMatrix(true, false);
      rig.group.updateWorldMatrix(true, false);
      this._factorySprayTargetLocal.set(localSpotX, centerY + radius * 0.06, localSpotZ);
      this._factorySprayTargetWorld
        .copy(this._factorySprayTargetLocal)
        .applyMatrix4(group.matrixWorld);
      this.emitPylonResourceSprays(
        rig,
        rig.group,
        e.id,
        e.ownership.playerId,
        e.id,
        this._factorySprayTargetWorld,
        radius,
      );
    }

    for (const spark of rig.sparks) spark.visible = false;
  }

  private acquireFactorySprayTarget(): SprayTarget {
    let target = this.factorySprayTargetPool.pop();
    if (!target) {
      target = {
        source: { id: 0, pos: { x: 0, y: 0 }, z: 0, playerId: 1 as PlayerId },
        target: { id: 0, pos: { x: 0, y: 0 }, z: 0, radius: 0 },
        type: 'build',
        intensity: 0,
      };
    }
    target.colorRGB = undefined;
    target.speed = undefined;
    target.particleRadius = undefined;
    this.factorySprayTargets.push(target);
    return target;
  }

  private updateConstructionTowerSpin(
    rig: ConstructionTowerSpinRig,
    resourceRateSum: number,
    dtSec: number,
  ): void {
    if (rig.towerOrbitParts.length === 0) return;
    const preset = getDriftPreset(getDriftMode());
    const alpha = halfLifeBlend(
      dtSec,
      preset.rotation.vel * CONSTRUCTION_TOWER_SPIN_CONFIG.driftHalfLifeMultiplier,
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
    for (let i = 0; i < rig.pylonTopsLocal.length && i < rig.pylonTopBaseLocals.length; i++) {
      const base = rig.pylonTopBaseLocals[i];
      const current = rig.pylonTopsLocal[i];
      current.x = base.x * c - base.z * s;
      current.y = base.y;
      current.z = base.x * s + base.z * c;
    }
  }

  private blendSmoothedRates(
    smoothed: { energy: number; mana: number; metal: number },
    targetEnergy: number,
    targetMana: number,
    targetMetal: number,
    alpha: number,
  ): void {
    smoothed.energy += (targetEnergy - smoothed.energy) * alpha;
    smoothed.mana   += (targetMana   - smoothed.mana)   * alpha;
    smoothed.metal  += (targetMetal  - smoothed.metal)  * alpha;
  }

  private blendDisplaySmoothedRates(
    display: { energy: number; mana: number; metal: number },
    smoothed: { energy: number; mana: number; metal: number },
    dtSec: number,
  ): void {
    const alpha = halfLifeBlend(
      dtSec,
      BUILD_RATE_DISPLAY_EMA_HALF_LIFE_SEC[BUILD_RATE_DISPLAY_EMA_MODE],
    );
    display.energy += (smoothed.energy - display.energy) * alpha;
    display.mana   += (smoothed.mana   - display.mana)   * alpha;
    display.metal  += (smoothed.metal  - display.metal)  * alpha;
  }

  private applyShowerFromSmoothedRates(rig: {
    showers: THREE.Mesh[];
    showerRadius: number;
    pylonHeight: number;
    pylonBaseY: number;
    displaySmoothedRates: { energy: number; mana: number; metal: number };
  }): void {
    const smoothed: readonly [number, number, number] = [
      rig.displaySmoothedRates.energy,
      rig.displaySmoothedRates.mana,
      rig.displaySmoothedRates.metal,
    ];
    for (let i = 0; i < rig.showers.length && i < 3; i++) {
      const shower = rig.showers[i];
      const r = smoothed[i];
      if (r < 0.01) {
        shower.visible = false;
        continue;
      }
      shower.visible = true;
      const h = rig.pylonHeight * r;
      shower.scale.set(rig.showerRadius * 2, h, rig.showerRadius * 2);
      shower.position.y = rig.pylonBaseY + h / 2;
    }
  }

  private emitPylonResourceSprays(
    rig: {
      pylonTopsLocal: THREE.Vector3[];
      sprayTravelSpeed: number;
      sprayParticleRadius: number;
      displaySmoothedRates: { energy: number; mana: number; metal: number };
    },
    group: THREE.Group,
    sourceId: EntityId,
    sourcePlayerId: PlayerId,
    targetId: EntityId,
    targetWorld: THREE.Vector3,
    targetRadius: number,
  ): void {
    const smoothed: readonly [number, number, number] = [
      rig.displaySmoothedRates.energy,
      rig.displaySmoothedRates.mana,
      rig.displaySmoothedRates.metal,
    ];
    for (let i = 0; i < rig.pylonTopsLocal.length && i < 3; i++) {
      const rate = smoothed[i];
      if (rate < 0.05) continue;
      this._factorySpraySourceWorld
        .copy(rig.pylonTopsLocal[i])
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
      spray.speed = rig.sprayTravelSpeed;
      spray.particleRadius = rig.sprayParticleRadius;
      spray.colorRGB = RESOURCE_SPRAY_COLORS[i];
    }
  }
}
