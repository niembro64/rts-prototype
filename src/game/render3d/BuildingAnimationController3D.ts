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
import type { MetalDeposit } from '../../metalDepositConfig';
import {
  RESOURCE_KIND_ENERGY,
  RESOURCE_KIND_METAL,
} from '@/types/network';
import type { ClientViewState } from '../network/ClientViewState';
import { halfLifeBlend } from '../network/driftEma';
import { lerp, lerpAngle } from '../math';
import type { Entity, EntityId } from '../sim/types';
import { getBuildingConfig } from '../sim/buildConfigs';
import { BUILD_GRID_CELL_SIZE } from '../sim/buildGrid';
import {
  getMetalDepositFootprintCoverage,
  type MetalDepositFootprintCell,
} from '../sim/metalDeposits';
import {
  writeSolarPetalMatrix,
  type SolarPetalAnimation,
} from './SolarCollectorMesh3D';
import type {
  ConstructionEmitterRig,
  ResourcePylonRig,
} from './ConstructionEmitterMesh3D';
import type { EntityMesh } from './EntityMesh3D';
import type { ConstructionVisualController3D } from './ConstructionVisualController3D';
import type { ExtractorBladeAnim } from './MetalExtractorMesh3D';
import { writeSunDirectionThree } from './SunLighting';
import { visualAnimBlend, visualAnimHalfLife } from './visualAnimationEma';

// Open/close pose transitions are discrete local state changes, not
// snapshot rotation fields. They intentionally keep fixed controller
// alphas instead of borrowing ROT POS as a courtesy binding.
const SOLAR_PETAL_ANIM_ALPHA = 0.16;
const EXTRACTOR_ROTOR_RAD_PER_SEC = 2.4;
const RADAR_HEAD_RAD_PER_SEC = 0.55;
const RADAR_SWEEP_RAD_PER_SEC = 1.8;
/** Slow idle drift so an inactive converter still reads as "alive". */
const CONVERTER_RING_IDLE_RAD_PER_SEC = 0.35;
/** Additional contribution at full conversion rate. The ring's spin
 *  signs the conversion direction; orbiter brightness comes for free
 *  because faster spin distributes the orbiter sphere over more frame
 *  positions. */
const CONVERTER_RING_FULL_RAD_PER_SEC = 2.1;
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
  const base = getBuildingConfig('buildingExtractor').metalProduction ?? 0;
  return base > 0 ? 1 / base : 0;
})();
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

function resourcePylonRateFraction(signedRate: number, inverseFullRate: number): number {
  if (signedRate === 0 || inverseFullRate <= 0) return 0;
  return Math.max(0, Math.min(1, Math.abs(signedRate) * inverseFullRate));
}

function applyResourcePylonDirection(pylon: ResourcePylonRig | undefined, signedRate: number): void {
  if (!pylon || signedRate === 0) return;
  pylon.direction = signedRate > 0 ? 'outbound' : 'inbound';
}

export class BuildingAnimationController3D {
  private readonly clientViewState: ClientViewState;
  private readonly constructionVisuals: ConstructionVisualController3D;
  private readonly metalDeposits: readonly MetalDeposit[];
  private solarBuildingIds: EntityId[] = [];
  private solarBuildingIdSet = new Set<EntityId>();
  private windBuildingIds: EntityId[] = [];
  private windBuildingIdSet = new Set<EntityId>();
  private extractorBuildingIds: EntityId[] = [];
  private extractorBuildingIdSet = new Set<EntityId>();
  private converterBuildingIds: EntityId[] = [];
  private converterBuildingIdSet = new Set<EntityId>();
  private factoryBuildingIds: EntityId[] = [];
  private factoryBuildingIdSet = new Set<EntityId>();
  private radarBuildingIds: EntityId[] = [];
  private radarBuildingIdSet = new Set<EntityId>();
  private windFanYaw: number | null = null;
  private windVisualSpeed: number | null = null;
  private windRotorPhase = 0;
  private windAnimLastMs = 0;
  /** Per-entity rotor phase. Each extractor advances its own counter
   *  from a ROT VEL-smoothed local angular speed, so an extractor on
   *  bare ground stays stationary while one fully covering a deposit
   *  spins at full speed. Indexed by entity id; entries get pruned
   *  when the extractor despawns. */
  private extractorRotorPhases = new Map<EntityId, number>();
  /** Courtesy ROT VEL binding for extractor rotor spin-up/spin-down.
   *  The value is a local visual angular speed, not snapshot drift. */
  private extractorRotorSpeeds = new Map<EntityId, number>();
  /** Per-entity "closed amount" for the extractor's blade fold (0 =
   *  spinning open, 1 = folded flat against the pyramid). Smoothed
   *  toward the server's open flag with BUILDING_FORTIFY_ANIM_ALPHA. */
  private extractorCloseAmounts = new Map<EntityId, number>();
  /** Last applied extractor rotor yaw. Kept monotonic in the negative
   *  spin direction so open/close transitions can pause at an aligned
   *  pose, but never visibly reverse. */
  private extractorRotorYaws = new Map<EntityId, number>();
  /** Per-entity "closed amount" for the wind turbine's stowed pose
   *  (nacelle tilts skyward + blades fold against the pole). */
  private windCloseAmounts = new Map<EntityId, number>();
  /** Courtesy ROT VEL binding for radar decorative angular speeds. */
  private radarHeadPhases = new Map<EntityId, number>();
  private radarSweepPhases = new Map<EntityId, number>();
  private radarHeadSpeeds = new Map<EntityId, number>();
  private radarSweepSpeeds = new Map<EntityId, number>();
  /** Per-converter ring phases (energy, metal, accent). Accumulated each
   *  frame from the matching speed map. */
  private converterEnergyRingPhases = new Map<EntityId, number>();
  private converterMetalRingPhases = new Map<EntityId, number>();
  private converterAccentRingPhases = new Map<EntityId, number>();
  /** Courtesy ROT VEL binding for converter ring spin-up/spin-down. */
  private converterEnergyRingSpeeds = new Map<EntityId, number>();
  private converterMetalRingSpeeds = new Map<EntityId, number>();
  private converterAccentRingSpeeds = new Map<EntityId, number>();
  private extractorDepositSourceCache = new Map<EntityId, THREE.Vector3>();
  private extractorCoverageCells: MetalDepositFootprintCell[] = [];
  private _pylonSourceWorld = new THREE.Vector3();
  private _pylonSourceDirection = new THREE.Vector3();

  constructor(
    clientViewState: ClientViewState,
    constructionVisuals: ConstructionVisualController3D,
    metalDeposits: readonly MetalDeposit[],
  ) {
    this.clientViewState = clientViewState;
    this.constructionVisuals = constructionVisuals;
    this.metalDeposits = metalDeposits;
  }

  register(entity: Entity, mesh: EntityMesh): void {
    const id = entity.id;
    if (entity.buildingBlueprintId === 'buildingSolar' && mesh.buildingDetails) {
      this.addAnimatedBuilding(this.solarBuildingIds, this.solarBuildingIdSet, id);
    }
    if (mesh.windRig) {
      this.addAnimatedBuilding(this.windBuildingIds, this.windBuildingIdSet, id);
    }
    if (mesh.extractorRig) {
      this.addAnimatedBuilding(this.extractorBuildingIds, this.extractorBuildingIdSet, id);
    }
    if (mesh.converterRig) {
      this.addAnimatedBuilding(this.converterBuildingIds, this.converterBuildingIdSet, id);
    }
    if (mesh.factoryBuildSpotRig) {
      this.addAnimatedBuilding(this.factoryBuildingIds, this.factoryBuildingIdSet, id);
    }
    if (mesh.radarRig) {
      this.addAnimatedBuilding(this.radarBuildingIds, this.radarBuildingIdSet, id);
    }
  }

  unregister(id: EntityId): void {
    this.removeAnimatedBuilding(this.solarBuildingIds, this.solarBuildingIdSet, id);
    this.removeAnimatedBuilding(this.windBuildingIds, this.windBuildingIdSet, id);
    this.removeAnimatedBuilding(this.extractorBuildingIds, this.extractorBuildingIdSet, id);
    this.removeAnimatedBuilding(this.converterBuildingIds, this.converterBuildingIdSet, id);
    this.extractorRotorPhases.delete(id);
    this.extractorRotorSpeeds.delete(id);
    this.extractorCloseAmounts.delete(id);
    this.extractorRotorYaws.delete(id);
    this.extractorDepositSourceCache.delete(id);
    this.windCloseAmounts.delete(id);
    this.removeAnimatedBuilding(this.factoryBuildingIds, this.factoryBuildingIdSet, id);
    this.removeAnimatedBuilding(this.radarBuildingIds, this.radarBuildingIdSet, id);
    this.radarHeadPhases.delete(id);
    this.radarSweepPhases.delete(id);
    this.radarHeadSpeeds.delete(id);
    this.radarSweepSpeeds.delete(id);
    this.converterEnergyRingPhases.delete(id);
    this.converterMetalRingPhases.delete(id);
    this.converterAccentRingPhases.delete(id);
    this.converterEnergyRingSpeeds.delete(id);
    this.converterMetalRingSpeeds.delete(id);
    this.converterAccentRingSpeeds.delete(id);
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
        const signedRate = this.clientViewState.getResourcePylonSignedRate(id, RESOURCE_KIND_ENERGY);
        const pylon = mesh.solarRig?.pylon;
        applyResourcePylonDirection(pylon, signedRate);
        const sourceWorld = pylon
          ? this.writeDirectionalPylonSourceWorld(pylon, mesh.group, writeSunDirectionThree(this._pylonSourceDirection))
          : null;
        this.constructionVisuals.updateAmbientResourcePylon(
          pylon,
          entity,
          mesh.group,
          open ? resourcePylonRateFraction(signedRate, INV_SOLAR_BASE_PRODUCTION) : 0,
          rateAlpha,
          mesh.buildingCachedDetailsReady === true,
          mesh.buildingCachedDetailsReady === true,
          sourceWorld,
        );
      }
    }

    if (this.windBuildingIds.length > 0) {
      this.updateWindAnimationGlobals();
      const rateAlpha = halfLifeBlend(spinDt, BUILD_RATE_EMA_HALF_LIFE_SEC[BUILD_RATE_EMA_MODE]);
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
        const signedRate = this.clientViewState.getResourcePylonSignedRate(id, RESOURCE_KIND_ENERGY);
        const pylon = mesh.windRig?.pylon;
        applyResourcePylonDirection(pylon, signedRate);
        const windSourceWorld = pylon
          ? this.writeWindPylonSourceWorld(pylon, mesh.group)
          : null;
        this.constructionVisuals.updateAmbientResourcePylon(
          pylon,
          entity,
          mesh.group,
          resourcePylonRateFraction(signedRate, INV_WIND_MAX_PRODUCTION) * (1 - close),
          rateAlpha,
          mesh.buildingCachedDetailsReady === true,
          mesh.buildingCachedDetailsReady === true,
          windSourceWorld,
        );
      }
    }

    if (this.extractorBuildingIds.length > 0) {
      // Each extractor EMA-blends its local rotor angular speed toward
      // base × coverageFraction, so spin scales 1:1 with
      // metal-per-second while still honoring the ROT VEL courtesy
      // binding.
      // 0 covered tiles → stationary; full coverage → full base rate.
      // While the extractor is fortified (closed) we suspend spin
      // entirely — the blades have folded down against the pyramid
      // sides and are no longer producing.
      const invBase = INV_EXTRACTOR_BASE_PRODUCTION;
      const twoPi = Math.PI * 2;
      const phases = this.extractorRotorPhases;
      const speeds = this.extractorRotorSpeeds;
      const closeAmounts = this.extractorCloseAmounts;
      const rotorYaws = this.extractorRotorYaws;
      const rateAlpha = halfLifeBlend(spinDt, BUILD_RATE_EMA_HALF_LIFE_SEC[BUILD_RATE_EMA_MODE]);
      const rotorSpeedAlpha = visualAnimBlend(getRotationVelEmaMode(), spinDt);
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
        const targetSpeed = EXTRACTOR_ROTOR_RAD_PER_SEC * normalizedRate * (1 - close);
        let speed = speeds.get(id) ?? 0;
        speed = lerp(speed, targetSpeed, rotorSpeedAlpha);
        if (targetSpeed === 0 && speed < 0.001) speed = 0;
        phase += spinDt * speed;

        const rig = mesh.extractorRig;
        if (rig && mesh.buildingCachedDetailsReady === true) {
          // The visual spin direction is negative yaw. When closing,
          // settle onto the next full-turn alignment in that direction
          // instead of the shortest path back to 0, which would reverse
          // for half the phase range. Once fully closed, snap the stored
          // phase to that aligned turn so opening resumes forward too.
          const alignedPhase = getNextExtractorAlignedPhase(phase, twoPi);
          const openYaw = -phase;
          const closedYaw = -alignedPhase;
          let yaw: number;
          if (open) {
            yaw = openYaw;
          } else {
            yaw = close >= 0.999
              ? closedYaw
              : openYaw + (closedYaw - openYaw) * close;
            if (close >= 0.999) phase = alignedPhase;
          }
          const previousYaw = rotorYaws.get(id);
          if (previousYaw !== undefined && yaw > previousYaw) yaw = previousYaw;
          rotorYaws.set(id, yaw);
          const rotors = rig.rotors;
          for (let r = 0; r < rotors.length; r++) {
            const rotor = rotors[r];
            rotor.rotation.y = yaw;
            // Slerp each blade between its baked open and closed
            // transforms. The closed pose lays the blade flat against
            // one face of the hexagonal pyramid; six blades cover the
            // six faces. userData carries the precomputed endpoints for
            // the exact extruded face-panel mesh.
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
        phases.set(id, phase);
        speeds.set(id, speed);
        const signedRate = this.clientViewState.getResourcePylonSignedRate(id, RESOURCE_KIND_METAL);
        applyResourcePylonDirection(rig?.pylon, signedRate);
        const depositSourceWorld = rig?.pylon
          ? this.writeExtractorDepositSourceWorld(rig.pylon, mesh.group, entity)
          : null;
        this.constructionVisuals.updateAmbientResourcePylon(
          rig?.pylon,
          entity,
          mesh.group,
          resourcePylonRateFraction(signedRate, invBase) * (1 - close),
          rateAlpha,
          mesh.buildingCachedDetailsReady === true,
          mesh.buildingCachedDetailsReady === true,
          depositSourceWorld,
        );
      }
    }

    if (this.converterBuildingIds.length > 0) {
      const rateAlpha = halfLifeBlend(spinDt, BUILD_RATE_EMA_HALF_LIFE_SEC[BUILD_RATE_EMA_MODE]);
      const ringSpeedAlpha = visualAnimBlend(getRotationVelEmaMode(), spinDt);
      const invBase = INV_CONVERTER_BASE_RATE;
      for (const id of this.converterBuildingIds) {
        const mesh = buildingMeshes.get(id);
        const entity = this.clientViewState.getEntity(id);
        const rig = mesh?.converterRig;
        if (!mesh || !entity || !rig) continue;
        const detailsReady = mesh.buildingCachedDetailsReady === true;
        const energyRate = this.clientViewState.getResourcePylonSignedRate(id, RESOURCE_KIND_ENERGY);
        const metalRate = this.clientViewState.getResourcePylonSignedRate(id, RESOURCE_KIND_METAL);
        applyResourcePylonDirection(rig.energyPylon, energyRate);
        applyResourcePylonDirection(rig.metalPylon, metalRate);
        this.constructionVisuals.updateAmbientResourcePylon(
          rig.energyPylon,
          entity,
          mesh.group,
          resourcePylonRateFraction(energyRate, invBase),
          rateAlpha,
          detailsReady,
          false,
        );
        this.constructionVisuals.updateAmbientResourcePylon(
          rig.metalPylon,
          entity,
          mesh.group,
          resourcePylonRateFraction(metalRate, invBase),
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

        // Ring spin: signed by flow direction so the player can read
        // which way the converter is running from the orbiter motion.
        // Speeds EMA toward target via ROT VEL mode so spin-up matches
        // every other decorative rotation in the game. A closed (OFF)
        // converter parks the rings (target 0) so the renderer's
        // open/closed pose tracks the same state that gates the
        // energy↔metal swap.
        const open = entity.building?.activeState?.open !== false;
        const energyMag = open ? resourcePylonRateFraction(energyRate, invBase) : 0;
        const metalMag = open ? resourcePylonRateFraction(metalRate, invBase) : 0;
        const energyDir = energyRate >= 0 ? 1 : -1;
        const metalDir = metalRate >= 0 ? 1 : -1;
        const energyTarget = open
          ? energyDir * (CONVERTER_RING_IDLE_RAD_PER_SEC + CONVERTER_RING_FULL_RAD_PER_SEC * energyMag)
          : 0;
        const metalTarget = open
          ? -metalDir * (CONVERTER_RING_IDLE_RAD_PER_SEC + CONVERTER_RING_FULL_RAD_PER_SEC * metalMag)
          : 0;
        const accentTarget = open
          ? (CONVERTER_RING_IDLE_RAD_PER_SEC * 0.6 + CONVERTER_RING_FULL_RAD_PER_SEC * 0.7 * Math.max(energyMag, metalMag))
          : 0;

        const energySpeed = lerp(
          this.converterEnergyRingSpeeds.get(id) ?? 0,
          energyTarget,
          ringSpeedAlpha,
        );
        const metalSpeed = lerp(
          this.converterMetalRingSpeeds.get(id) ?? 0,
          metalTarget,
          ringSpeedAlpha,
        );
        const accentSpeed = lerp(
          this.converterAccentRingSpeeds.get(id) ?? 0,
          accentTarget,
          ringSpeedAlpha,
        );
        this.converterEnergyRingSpeeds.set(id, energySpeed);
        this.converterMetalRingSpeeds.set(id, metalSpeed);
        this.converterAccentRingSpeeds.set(id, accentSpeed);

        const seed = id * 0.137;
        const energyPhase = (this.converterEnergyRingPhases.get(id) ?? seed) + spinDt * energySpeed;
        const metalPhase = (this.converterMetalRingPhases.get(id) ?? seed * 1.7) + spinDt * metalSpeed;
        const accentPhase = (this.converterAccentRingPhases.get(id) ?? seed * 0.6) + spinDt * accentSpeed;
        this.converterEnergyRingPhases.set(id, energyPhase);
        this.converterMetalRingPhases.set(id, metalPhase);
        this.converterAccentRingPhases.set(id, accentPhase);

        // After the static rotation.x (energy: π/2; accent: π/3), Euler
        // XYZ intrinsic order puts rotation.z spinning around the ring's
        // donut hole axis — exactly what we want for orbiters on the rim.
        rig.energyRing.rotation.z = energyPhase;
        rig.metalRing.rotation.z = metalPhase;
        rig.accentRing.rotation.z = accentPhase;

        // Soft halo pulse keyed to overall activity. Stays below ±10%
        // of the base radius so the silhouette doesn't visibly breathe.
        const haloPulse = 1
          + 0.04 * Math.sin(timeMs * 0.0035 + seed)
          + 0.06 * Math.max(energyMag, metalMag);
        rig.coreHalo.scale.setScalar(rig.coreHaloBaseRadius * haloPulse);
      }
    }

    for (const id of this.factoryBuildingIds) {
      const mesh = buildingMeshes.get(id);
      const entity = this.clientViewState.getEntity(id);
      if (!mesh || !entity) continue;
      const detailsReady = mesh.buildingCachedDetailsReady === true;
      const emitterRig = findConstructionEmitterRig(mesh, entity);
      if (emitterRig) {
        this.constructionVisuals.updateFactoryConstructionEmitter(
          emitterRig,
          entity,
          detailsReady,
          currentDtMs,
        );
      }
      this.constructionVisuals.updateFactoryBuildSpot(
        mesh.factoryBuildSpotRig,
        entity,
        detailsReady,
        mesh.buildingCachedWidth ?? entity.building?.width ?? 100,
        mesh.buildingCachedDepth ?? entity.building?.height ?? 100,
        timeMs,
      );
    }

    if (this.radarBuildingIds.length > 0) {
      const radarSpeedAlpha = visualAnimBlend(getRotationVelEmaMode(), spinDt);
      for (const id of this.radarBuildingIds) {
        const mesh = buildingMeshes.get(id);
        const entity = this.clientViewState.getEntity(id);
        const rig = mesh?.radarRig;
        if (!mesh || !rig || mesh.buildingCachedDetailsReady !== true) continue;
        // ON/OFF gate: a closed (OFF) radar stops spinning so the
        // renderer's open/closed pose tracks the same state that gates
        // sensor coverage (see design_philosophy.html "Producer
        // Buildings Are ON/OFF").
        const open = entity?.building?.activeState?.open !== false;
        const seed = id * 0.137;
        let headSpeed = this.radarHeadSpeeds.get(id) ?? 0;
        let sweepSpeed = this.radarSweepSpeeds.get(id) ?? 0;
        headSpeed = lerp(headSpeed, open ? RADAR_HEAD_RAD_PER_SEC : 0, radarSpeedAlpha);
        sweepSpeed = lerp(sweepSpeed, open ? -RADAR_SWEEP_RAD_PER_SEC : 0, radarSpeedAlpha);
        let headPhase = this.radarHeadPhases.get(id) ?? seed;
        let sweepPhase = this.radarSweepPhases.get(id) ?? seed * 2.7;
        headPhase += spinDt * headSpeed;
        sweepPhase += spinDt * sweepSpeed;
        this.radarHeadSpeeds.set(id, headSpeed);
        this.radarSweepSpeeds.set(id, sweepSpeed);
        this.radarHeadPhases.set(id, headPhase);
        this.radarSweepPhases.set(id, sweepPhase);
        rig.head.rotation.y = headPhase;
        rig.sweep.rotation.y = sweepPhase;
      }
    }
  }

  destroy(): void {
    this.solarBuildingIds.length = 0;
    this.solarBuildingIdSet.clear();
    this.windBuildingIds.length = 0;
    this.windBuildingIdSet.clear();
    this.extractorBuildingIds.length = 0;
    this.extractorBuildingIdSet.clear();
    this.converterBuildingIds.length = 0;
    this.converterBuildingIdSet.clear();
    this.factoryBuildingIds.length = 0;
    this.factoryBuildingIdSet.clear();
    this.radarBuildingIds.length = 0;
    this.radarBuildingIdSet.clear();
    this.extractorRotorPhases.clear();
    this.extractorRotorSpeeds.clear();
    this.extractorCloseAmounts.clear();
    this.extractorRotorYaws.clear();
    this.windCloseAmounts.clear();
    this.radarHeadPhases.clear();
    this.radarSweepPhases.clear();
    this.radarHeadSpeeds.clear();
    this.radarSweepSpeeds.clear();
    this.converterEnergyRingPhases.clear();
    this.converterMetalRingPhases.clear();
    this.converterAccentRingPhases.clear();
    this.converterEnergyRingSpeeds.clear();
    this.converterMetalRingSpeeds.clear();
    this.converterAccentRingSpeeds.clear();
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
    if (e.buildingBlueprintId !== 'buildingSolar' || !m.buildingDetails || !detailsReady) return;
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

  private writeDirectionalPylonSourceWorld(
    pylon: ResourcePylonRig,
    group: THREE.Group,
    direction: THREE.Vector3,
  ): THREE.Vector3 {
    group.updateWorldMatrix(true, false);
    this._pylonSourceWorld
      .copy(pylon.topLocal)
      .applyMatrix4(group.matrixWorld)
      .addScaledVector(direction, Math.max(1, pylon.flowRadius));
    return this._pylonSourceWorld;
  }

  private writeWindPylonSourceWorld(
    pylon: ResourcePylonRig,
    group: THREE.Group,
  ): THREE.Vector3 | null {
    const wind = this.clientViewState.getServerMeta()?.wind;
    if (!wind) return null;
    const len = Math.hypot(wind.x, wind.y);
    if (len < 1e-6) return null;
    this._pylonSourceDirection.set(-wind.x / len, 0, -wind.y / len);
    return this.writeDirectionalPylonSourceWorld(pylon, group, this._pylonSourceDirection);
  }

  private writeExtractorDepositSourceWorld(
    pylon: ResourcePylonRig,
    group: THREE.Group,
    entity: Entity,
  ): THREE.Vector3 {
    const source = this.getExtractorDepositSource(entity);
    if (source) {
      this._pylonSourceWorld.set(source.x, 0, source.z);
    } else {
      group.updateWorldMatrix(true, false);
      this._pylonSourceWorld
        .copy(pylon.topLocal)
        .applyMatrix4(group.matrixWorld);
    }
    this._pylonSourceWorld.y = entity.transform.z + 1;
    return this._pylonSourceWorld;
  }

  private getExtractorDepositSource(entity: Entity): THREE.Vector3 | null {
    if (entity.buildingBlueprintId !== 'buildingExtractor') return null;
    const cached = this.extractorDepositSourceCache.get(entity.id);
    if (cached) return cached;
    const cfg = getBuildingConfig('buildingExtractor');
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

}

function getNextExtractorAlignedPhase(phase: number, twoPi: number): number {
  if (!Number.isFinite(phase) || phase <= 0) return 0;
  const alignedTurn = Math.ceil((phase - 1e-6) / twoPi);
  return alignedTurn * twoPi;
}

/** Locate the construction emitter rig mounted on this building's
 *  `turretConstruction`. Buildings can only carry one (factories do today,
 *  cannon towers and the like don't), so the first match wins. */
function findConstructionEmitterRig(
  mesh: EntityMesh,
  entity: Entity,
): ConstructionEmitterRig | undefined {
  const combatTurrets = entity.combat?.turrets;
  if (!combatTurrets) return undefined;
  for (let i = 0; i < combatTurrets.length && i < mesh.turrets.length; i++) {
    if (combatTurrets[i].config.constructionEmitter) {
      return mesh.turrets[i].constructionEmitter;
    }
  }
  return undefined;
}
