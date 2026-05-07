import * as THREE from 'three';
import { getDriftMode } from '@/clientBarConfig';
import {
  BUILD_RATE_EMA_HALF_LIFE_SEC,
  BUILD_RATE_EMA_MODE,
} from '@/shellConfig';
import {
  WIND_SPEED_MAX,
  WIND_TURBINE_DRIFT_EMA_HALF_LIFE_MULTIPLIERS,
  WIND_TURBINE_ROTOR_RAD_PER_SEC_PER_WIND_SPEED,
} from '../../config';
import type { ClientViewState } from '../network/ClientViewState';
import { getDriftPreset, halfLifeBlend } from '../network/driftEma';
import { lerp, lerpAngle } from '../math';
import type { Entity, EntityId } from '../sim/types';
import { getBuildingConfig } from '../sim/buildConfigs';
import {
  writeSolarPetalMatrix,
  type SolarPetalAnimation,
} from './SolarCollectorMesh3D';
import type { ProductionRateIndicatorRig } from './ConstructionEmitterMesh3D';
import type { EntityMesh } from './EntityMesh3D';
import { buildingTierAtLeast } from './RenderTier3D';
import type { ConstructionVisualController3D } from './ConstructionVisualController3D';

const SOLAR_PETAL_ANIM_ALPHA = 0.16;
const EXTRACTOR_ROTOR_RAD_PER_SEC = 2.4;
const _solarPetalDirection = new THREE.Vector3();

/** Reciprocal of the extractor's configured ceiling rate, computed
 *  once at module load. The per-frame rotor loop multiplies by this
 *  instead of dividing each entity's `metalExtractionRate` by the
 *  base rate every frame. */
const INV_EXTRACTOR_BASE_PRODUCTION = (() => {
  const base = getBuildingConfig('extractor').metalProduction ?? 0;
  return base > 0 ? 1 / base : 0;
})();

export class BuildingAnimationController3D {
  private readonly clientViewState: ClientViewState;
  private readonly constructionVisuals: ConstructionVisualController3D;
  private solarBuildingIds: EntityId[] = [];
  private solarBuildingIdSet = new Set<EntityId>();
  private windBuildingIds: EntityId[] = [];
  private windBuildingIdSet = new Set<EntityId>();
  private extractorBuildingIds: EntityId[] = [];
  private extractorBuildingIdSet = new Set<EntityId>();
  private factoryBuildingIds: EntityId[] = [];
  private factoryBuildingIdSet = new Set<EntityId>();
  private windFanYaw: number | null = null;
  private windVisualSpeed: number | null = null;
  private windRotorPhase = 0;
  private windAnimLastMs = 0;
  /** Per-entity rotor phase. Each extractor advances its own counter
   *  by `dt × EXTRACTOR_ROTOR_RAD_PER_SEC × coverageFraction`, so an
   *  extractor sitting on bare ground (0 covered tiles) stays
   *  stationary while one fully covering a deposit spins at full
   *  speed. Indexed by entity id; entries get pruned when the
   *  extractor despawns. */
  private extractorRotorPhases = new Map<EntityId, number>();

  constructor(
    clientViewState: ClientViewState,
    constructionVisuals: ConstructionVisualController3D,
  ) {
    this.clientViewState = clientViewState;
    this.constructionVisuals = constructionVisuals;
  }

  register(entity: Entity, mesh: EntityMesh): void {
    const id = entity.id;
    if (entity.buildingType === 'solar' && mesh.buildingDetails) {
      this.addAnimatedBuilding(this.solarBuildingIds, this.solarBuildingIdSet, id);
    }
    if (mesh.windRig) {
      this.addAnimatedBuilding(this.windBuildingIds, this.windBuildingIdSet, id);
    }
    if (mesh.extractorRig) {
      this.addAnimatedBuilding(this.extractorBuildingIds, this.extractorBuildingIdSet, id);
    }
    if (mesh.factoryRig) {
      this.addAnimatedBuilding(this.factoryBuildingIds, this.factoryBuildingIdSet, id);
    }
  }

  unregister(id: EntityId): void {
    this.removeAnimatedBuilding(this.solarBuildingIds, this.solarBuildingIdSet, id);
    this.removeAnimatedBuilding(this.windBuildingIds, this.windBuildingIdSet, id);
    this.removeAnimatedBuilding(this.extractorBuildingIds, this.extractorBuildingIdSet, id);
    this.extractorRotorPhases.delete(id);
    this.removeAnimatedBuilding(this.factoryBuildingIds, this.factoryBuildingIdSet, id);
  }

  update(
    buildingMeshes: ReadonlyMap<EntityId, EntityMesh>,
    spinDt: number,
    currentDtMs: number,
    timeMs: number,
  ): void {
    if (this.solarBuildingIds.length > 0) {
      const rateAlpha = halfLifeBlend(spinDt, BUILD_RATE_EMA_HALF_LIFE_SEC[BUILD_RATE_EMA_MODE]);
      for (const id of this.solarBuildingIds) {
        const mesh = buildingMeshes.get(id);
        const entity = this.clientViewState.getEntity(id);
        if (!mesh || !entity) continue;
        this.updateSolarCollectorAnimation(mesh, entity, mesh.buildingCachedDetailsReady === true);
        const open = entity.building?.solar?.open !== false;
        this.applyProductionRateIndicator(
          mesh.solarRig?.rateIndicator,
          open ? 1 : 0,
          rateAlpha,
          mesh.buildingCachedDetailsReady === true
            && buildingTierAtLeast(mesh.buildingCachedGraphicsTier ?? 'min', 'low'),
        );
      }
    }

    if (this.windBuildingIds.length > 0) {
      this.updateWindAnimationGlobals();
      const wind = this.clientViewState.getServerMeta()?.wind;
      const rateAlpha = halfLifeBlend(spinDt, BUILD_RATE_EMA_HALF_LIFE_SEC[BUILD_RATE_EMA_MODE]);
      const normalizedWindRate = wind ? wind.speed / WIND_SPEED_MAX : 0;
      for (const id of this.windBuildingIds) {
        const mesh = buildingMeshes.get(id);
        if (!mesh) continue;
        this.updateWindTurbineRig(mesh, mesh.buildingCachedDetailsReady === true);
        this.applyProductionRateIndicator(
          mesh.windRig?.rateIndicator,
          normalizedWindRate,
          rateAlpha,
          mesh.buildingCachedDetailsReady === true
            && buildingTierAtLeast(mesh.buildingCachedGraphicsTier ?? 'min', 'low'),
        );
      }
    }

    if (this.extractorBuildingIds.length > 0) {
      // Each extractor advances its own rotor phase by dt × base ×
      // coverageFraction, so spin scales 1:1 with metal-per-second.
      // 0 covered tiles → stationary; full coverage → full base rate.
      const invBase = INV_EXTRACTOR_BASE_PRODUCTION;
      const dtRate = spinDt * EXTRACTOR_ROTOR_RAD_PER_SEC;
      const twoPi = Math.PI * 2;
      const phases = this.extractorRotorPhases;
      const rateAlpha = halfLifeBlend(spinDt, BUILD_RATE_EMA_HALF_LIFE_SEC[BUILD_RATE_EMA_MODE]);
      for (const id of this.extractorBuildingIds) {
        const mesh = buildingMeshes.get(id);
        const entity = this.clientViewState.getEntity(id);
        if (!mesh || !entity) continue;
        const rate = entity.metalExtractionRate ?? 0;
        const normalizedRate = rate * invBase;
        let phase = phases.get(id);
        if (phase === undefined) phase = id * 0.173; // first-frame jitter seed
        phase = (phase + dtRate * normalizedRate) % twoPi;
        phases.set(id, phase);
        // Inline the rig write. Every per-tier rotor in the rig
        // array gets the same yaw — only one is visible at a time
        // (tier-gated by detail.minTier/maxTier), so writing the
        // hidden one is just a property assign with no GPU work.
        const rig = mesh.extractorRig;
        if (rig && mesh.buildingCachedDetailsReady === true) {
          const yaw = -phase;
          const rotors = rig.rotors;
          for (let r = 0; r < rotors.length; r++) {
            rotors[r].rotation.y = yaw;
          }
        }
        this.applyProductionRateIndicator(
          rig?.rateIndicator,
          normalizedRate,
          rateAlpha,
          mesh.buildingCachedDetailsReady === true
            && buildingTierAtLeast(mesh.buildingCachedGraphicsTier ?? 'min', 'low'),
        );
      }
    }

    for (const id of this.factoryBuildingIds) {
      const mesh = buildingMeshes.get(id);
      const entity = this.clientViewState.getEntity(id);
      if (!mesh || !entity) continue;
      this.constructionVisuals.updateFactoryConstructionRig(
        mesh.factoryRig,
        entity,
        mesh.buildingCachedGraphicsTier ?? 'min',
        mesh.buildingCachedDetailsReady === true,
        mesh.buildingCachedWidth ?? entity.building?.width ?? 100,
        mesh.buildingCachedDepth ?? entity.building?.height ?? 100,
        mesh.group,
        currentDtMs,
        timeMs,
      );
    }
  }

  destroy(): void {
    this.solarBuildingIds.length = 0;
    this.solarBuildingIdSet.clear();
    this.windBuildingIds.length = 0;
    this.windBuildingIdSet.clear();
    this.extractorBuildingIds.length = 0;
    this.extractorBuildingIdSet.clear();
    this.factoryBuildingIds.length = 0;
    this.factoryBuildingIdSet.clear();
    this.extractorRotorPhases.clear();
    this.windFanYaw = null;
    this.windVisualSpeed = null;
    this.windRotorPhase = 0;
    this.windAnimLastMs = 0;
  }

  private addAnimatedBuilding(
    list: EntityId[],
    set: Set<EntityId>,
    id: EntityId,
  ): void {
    if (set.has(id)) return;
    set.add(id);
    list.push(id);
  }

  private removeAnimatedBuilding(
    list: EntityId[],
    set: Set<EntityId>,
    id: EntityId,
  ): void {
    if (!set.delete(id)) return;
    const idx = list.indexOf(id);
    if (idx >= 0) list.splice(idx, 1);
  }

  private updateSolarCollectorAnimation(
    m: EntityMesh,
    e: Entity,
    detailsReady: boolean,
  ): void {
    if (e.buildingType !== 'solar' || !m.buildingDetails || !detailsReady) return;
    const target = e.building?.solar?.open === false ? 0 : 1;
    const current = m.solarOpenAmount ?? target;
    const next = Math.abs(target - current) < 0.002
      ? target
      : current + (target - current) * SOLAR_PETAL_ANIM_ALPHA;
    m.solarOpenAmount = next;

    const t = next * next * (3 - 2 * next);
    for (const detail of m.buildingDetails) {
      if (
        detail.role !== 'solarLeaf' &&
        detail.role !== 'solarPanel' &&
        detail.role !== 'solarTeamAccent'
      ) continue;
      const anim = detail.mesh.userData.solarPetal as SolarPetalAnimation | undefined;
      if (!anim) continue;
      _solarPetalDirection
        .copy(anim.closedDirection)
        .lerp(anim.openDirection, t)
        .normalize();
      writeSolarPetalMatrix(
        detail.mesh.matrix,
        anim.width,
        anim.length,
        anim.hinge,
        anim.tangent,
        _solarPetalDirection,
        anim.inset,
        anim.normalOffset,
        anim.thickness,
        anim.panelSideHint,
      );
      detail.mesh.matrixWorldNeedsUpdate = true;
    }
  }

  private updateWindAnimationGlobals(): void {
    const wind = this.clientViewState.getServerMeta()?.wind;
    const now = performance.now();
    const dtSec = this.windAnimLastMs > 0 ? (now - this.windAnimLastMs) / 1000 : 0;
    this.windAnimLastMs = now;
    if (!wind) return;

    const targetYaw = Math.atan2(wind.x, wind.y);
    const targetSpeed = wind.speed;
    if (this.windFanYaw === null || this.windVisualSpeed === null || dtSec <= 0) {
      this.windFanYaw = targetYaw;
      this.windVisualSpeed = targetSpeed;
    } else {
      const preset = getDriftPreset(getDriftMode());
      this.windFanYaw = lerpAngle(
        this.windFanYaw,
        targetYaw,
        halfLifeBlend(
          dtSec,
          this.scaledWindTurbineHalfLife(
            preset.rotation.pos,
            WIND_TURBINE_DRIFT_EMA_HALF_LIFE_MULTIPLIERS.fanYaw,
          ),
        ),
      );
      this.windVisualSpeed = lerp(
        this.windVisualSpeed,
        targetSpeed,
        halfLifeBlend(
          dtSec,
          this.scaledWindTurbineHalfLife(
            preset.rotation.vel,
            WIND_TURBINE_DRIFT_EMA_HALF_LIFE_MULTIPLIERS.bladeSpeed,
          ),
        ),
      );
    }
    this.windRotorPhase += dtSec * this.windVisualSpeed * WIND_TURBINE_ROTOR_RAD_PER_SEC_PER_WIND_SPEED;
  }

  private scaledWindTurbineHalfLife(baseHalfLife: number, multiplier: number): number {
    if (baseHalfLife <= 0 || multiplier <= 0) return 0;
    return baseHalfLife * multiplier;
  }

  private updateWindTurbineRig(m: EntityMesh, detailsReady: boolean): void {
    if (!m.windRig || !detailsReady || !m.windRig.root.visible || this.windFanYaw === null) return;
    m.windRig.root.rotation.y = this.windFanYaw - m.group.rotation.y;
    m.windRig.rotor.rotation.z = this.windRotorPhase;
  }

  private applyProductionRateIndicator(
    rig: ProductionRateIndicatorRig | undefined,
    targetRate: number,
    alpha: number,
    visible: boolean,
  ): void {
    if (!rig) return;
    const target = visible ? Math.max(0, Math.min(1, targetRate)) : 0;
    rig.smoothedRate += (target - rig.smoothedRate) * alpha;
    if (!visible || rig.smoothedRate < 0.01) {
      rig.shower.visible = false;
      return;
    }
    rig.shower.visible = true;
    const h = rig.pylonHeight * rig.smoothedRate;
    rig.shower.scale.set(rig.showerRadius * 2, h, rig.showerRadius * 2);
    rig.shower.position.y = rig.pylonBaseY + h / 2;
  }
}
