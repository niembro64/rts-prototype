import * as THREE from 'three';
import {
  getRotationPosEmaMode,
  getRotationVelEmaMode,
} from '@/clientBarConfig';
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
import { DRIFT_CHANNEL_HALF_LIFE_SEC, halfLifeBlend } from '../network/driftEma';
import type { DriftChannelMode } from '@/types/client';

/** Visual animation half-life lookup — falls back to 'medium' for
 *  'ignore' (the snapshot-drift channel's 'ignore' is meaningless for
 *  decorative motion like wind-turbine fan smoothing). */
function visualAnimHalfLife(mode: DriftChannelMode): number {
  if (mode === 'ignore') return DRIFT_CHANNEL_HALF_LIFE_SEC.medium;
  return DRIFT_CHANNEL_HALF_LIFE_SEC[mode];
}
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
import type { ExtractorBladeAnim } from './MetalExtractorMesh3D';

const SOLAR_PETAL_ANIM_ALPHA = 0.16;
const EXTRACTOR_ROTOR_RAD_PER_SEC = 2.4;
/** Per-frame blend toward the building's target open/closed pose
 *  (wind nacelle pitch + blade fold, extractor blade fold). Matches the
 *  solar petal animator's feel — smooth but not laggy. */
const BUILDING_FORTIFY_ANIM_ALPHA = 0.12;
const _solarPetalDirection = new THREE.Vector3();
const _extractorBladeQuat = new THREE.Quaternion();
const _extractorBladePos = new THREE.Vector3();
const _extractorBladeScale = new THREE.Vector3();
const _windBladeQuat = new THREE.Quaternion();

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
  /** Per-entity "closed amount" for the extractor's blade fold (0 =
   *  spinning open, 1 = folded flat against the pyramid). Smoothed
   *  toward the server's open flag with BUILDING_FORTIFY_ANIM_ALPHA. */
  private extractorCloseAmounts = new Map<EntityId, number>();
  /** Per-entity "closed amount" for the wind turbine's stowed pose
   *  (nacelle tilts skyward + blades fold against the pole). */
  private windCloseAmounts = new Map<EntityId, number>();

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
    this.extractorCloseAmounts.delete(id);
    this.windCloseAmounts.delete(id);
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
        const open = entity.building?.activeState?.open !== false;
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
      const closeAmounts = this.windCloseAmounts;
      for (const id of this.windBuildingIds) {
        const mesh = buildingMeshes.get(id);
        const entity = this.clientViewState.getEntity(id);
        if (!mesh || !entity) continue;
        const open = entity.building?.activeState?.open !== false;
        const closeTarget = open ? 0 : 1;
        let close = closeAmounts.get(id) ?? closeTarget;
        close = Math.abs(closeTarget - close) < 0.002
          ? closeTarget
          : close + (closeTarget - close) * BUILDING_FORTIFY_ANIM_ALPHA;
        closeAmounts.set(id, close);

        this.updateWindTurbineRig(mesh, mesh.buildingCachedDetailsReady === true, close);
        this.applyProductionRateIndicator(
          mesh.windRig?.rateIndicator,
          // Closed turbines produce no energy — collapse the rate
          // indicator to match. The sim already filters them out of
          // WindPowerTracker, this just keeps the visual in sync.
          normalizedWindRate * (1 - close),
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
      // While the extractor is fortified (closed) we suspend spin
      // entirely — the blades have folded down against the pyramid
      // sides and are no longer producing.
      const invBase = INV_EXTRACTOR_BASE_PRODUCTION;
      const dtRate = spinDt * EXTRACTOR_ROTOR_RAD_PER_SEC;
      const twoPi = Math.PI * 2;
      const phases = this.extractorRotorPhases;
      const closeAmounts = this.extractorCloseAmounts;
      const rateAlpha = halfLifeBlend(spinDt, BUILD_RATE_EMA_HALF_LIFE_SEC[BUILD_RATE_EMA_MODE]);
      for (const id of this.extractorBuildingIds) {
        const mesh = buildingMeshes.get(id);
        const entity = this.clientViewState.getEntity(id);
        if (!mesh || !entity) continue;
        const open = entity.building?.activeState?.open !== false;
        // Smooth fold blend so toggling closed doesn't snap the blades.
        const closeTarget = open ? 0 : 1;
        let close = closeAmounts.get(id) ?? closeTarget;
        close = Math.abs(closeTarget - close) < 0.002
          ? closeTarget
          : close + (closeTarget - close) * BUILDING_FORTIFY_ANIM_ALPHA;
        closeAmounts.set(id, close);

        const rate = open ? (entity.metalExtractionRate ?? 0) : 0;
        const normalizedRate = rate * invBase;
        let phase = phases.get(id);
        if (phase === undefined) phase = id * 0.173; // first-frame jitter seed
        phase = (phase + dtRate * normalizedRate * (1 - close)) % twoPi;
        phases.set(id, phase);

        const rig = mesh.extractorRig;
        if (rig && mesh.buildingCachedDetailsReady === true) {
          // Spin only applies while the blades are mostly open; as they
          // fold the rotor settles to its rest yaw and the per-blade
          // closed-pose quaternion takes over.
          const yaw = -phase * (1 - close);
          const rotors = rig.rotors;
          for (let r = 0; r < rotors.length; r++) {
            const rotor = rotors[r];
            rotor.rotation.y = yaw;
            // Slerp each blade between its baked open and closed
            // transforms. The closed pose lays the blade flat against
            // one face of the hexagonal pyramid; six blades cover the
            // six faces. userData carries the precomputed endpoints —
            // including a closed scale that reshapes the blade from a
            // long paddle into a face-fitting panel.
            for (const child of rotor.children) {
              const anim = child.userData.extractorBlade as ExtractorBladeAnim | undefined;
              if (!anim) continue;
              _extractorBladeQuat.copy(anim.openQuat).slerp(anim.closedQuat, close);
              child.quaternion.copy(_extractorBladeQuat);
              _extractorBladePos.copy(anim.openPos).lerp(anim.closedPos, close);
              child.position.copy(_extractorBladePos);
              _extractorBladeScale.copy(anim.openScale).lerp(anim.closedScale, close);
              child.scale.copy(_extractorBladeScale);
            }
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
    this.extractorCloseAmounts.clear();
    this.windCloseAmounts.clear();
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
    const target = e.building?.activeState?.open === false ? 0 : 1;
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
      const rotPosHalfLife = visualAnimHalfLife(getRotationPosEmaMode());
      const rotVelHalfLife = visualAnimHalfLife(getRotationVelEmaMode());
      this.windFanYaw = lerpAngle(
        this.windFanYaw,
        targetYaw,
        halfLifeBlend(
          dtSec,
          this.scaledWindTurbineHalfLife(
            rotPosHalfLife,
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
            rotVelHalfLife,
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

  private updateWindTurbineRig(
    m: EntityMesh,
    detailsReady: boolean,
    closeAmount: number,
  ): void {
    if (!m.windRig || !detailsReady || !m.windRig.root.visible || this.windFanYaw === null) return;
    // Root yaws to follow the wind direction (open) but pitches up to
    // the stowed angle as the turbine closes. Yaw weight tapers to 0 in
    // the closed pose so the nacelle settles to a deterministic skyward
    // orientation instead of bobbing with the wind while folded.
    m.windRig.root.rotation.y = (this.windFanYaw - m.group.rotation.y) * (1 - closeAmount);
    m.windRig.root.rotation.x = m.windRig.closedPitch * closeAmount;
    // Spin only while the rotor is mostly extended. As the blades fold
    // toward the pole the rotor settles to a fixed rest phase so the
    // baked closed quaternions match exactly.
    m.windRig.rotor.rotation.z = this.windRotorPhase * (1 - closeAmount);
    // Slerp each blade between its baked open and closed quaternions.
    for (const child of m.windRig.rotor.children) {
      const anim = child.userData.windBlade as
        | { openQuat: THREE.Quaternion; closedQuat: THREE.Quaternion }
        | undefined;
      if (!anim) continue;
      _windBladeQuat.copy(anim.openQuat).slerp(anim.closedQuat, closeAmount);
      child.quaternion.copy(_windBladeQuat);
    }
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
