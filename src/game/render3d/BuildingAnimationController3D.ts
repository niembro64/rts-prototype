import * as THREE from 'three';
import {
  getRotationPosEmaMode,
  getRotationVelEmaMode,
} from '@/clientBarConfig';
import {
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
import {
  writeSolarPetalMatrix,
  type SolarPetalAnimation,
} from './SolarCollectorMesh3D';
import type {
  ConstructionEmitterRig,
} from './ConstructionEmitterMesh3D';
import type { EntityMesh } from './EntityMesh3D';
import type { ConstructionVisualController3D } from './ConstructionVisualController3D';
import type { ExtractorBladeAnim } from './MetalExtractorMesh3D';
import { visualAnimBlend, visualAnimHalfLife } from './visualAnimationEma';
import {
  addAnimatedBuildingEntry,
  clearAnimatedBuildingEntries,
  removeAnimatedBuildingEntry,
  updateAnimatedBuildingQueue,
  type AnimatedBuildingEntry,
} from './BuildingAnimationLists3D';
import {
  BuildingResourcePylonAnimator3D,
  resourcePylonRateFraction,
} from './BuildingResourcePylonAnimator3D';

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
const INV_CONVERTER_BASE_RATE = (() => {
  const base = getBuildingConfig('buildingResourceConverter').conversionRate ?? 0;
  return base > 0 ? 1 / base : 0;
})();

const FACTORY_ANIMATION_IDLE_EPSILON = 0.001;
const BUILDING_RIG_IDLE_EPSILON = 0.001;

export class BuildingAnimationController3D {
  private readonly clientViewState: ClientViewState;
  private readonly constructionVisuals: ConstructionVisualController3D;
  private readonly resourcePylonAnimator: BuildingResourcePylonAnimator3D;
  private solarBuildings: AnimatedBuildingEntry[] = [];
  private solarBuildingIndexById = new Map<EntityId, number>();
  private activeSolarBuildings: AnimatedBuildingEntry[] = [];
  private activeSolarBuildingIndexById = new Map<EntityId, number>();
  private windBuildings: AnimatedBuildingEntry[] = [];
  private windBuildingIndexById = new Map<EntityId, number>();
  private activeWindBuildings: AnimatedBuildingEntry[] = [];
  private activeWindBuildingIndexById = new Map<EntityId, number>();
  private extractorBuildings: AnimatedBuildingEntry[] = [];
  private extractorBuildingIndexById = new Map<EntityId, number>();
  private activeExtractorBuildings: AnimatedBuildingEntry[] = [];
  private activeExtractorBuildingIndexById = new Map<EntityId, number>();
  private converterBuildings: AnimatedBuildingEntry[] = [];
  private converterBuildingIndexById = new Map<EntityId, number>();
  private activeConverterBuildings: AnimatedBuildingEntry[] = [];
  private activeConverterBuildingIndexById = new Map<EntityId, number>();
  private factoryBuildings: AnimatedBuildingEntry[] = [];
  private factoryBuildingIndexById = new Map<EntityId, number>();
  private activeFactoryBuildings: AnimatedBuildingEntry[] = [];
  private activeFactoryBuildingIndexById = new Map<EntityId, number>();
  private radarBuildings: AnimatedBuildingEntry[] = [];
  private radarBuildingIndexById = new Map<EntityId, number>();
  private activeRadarBuildings: AnimatedBuildingEntry[] = [];
  private activeRadarBuildingIndexById = new Map<EntityId, number>();
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
  private windAppliedCloseAmounts = new Map<EntityId, number>();
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
  private extractorAppliedCloseAmounts = new Map<EntityId, number>();

  constructor(
    clientViewState: ClientViewState,
    constructionVisuals: ConstructionVisualController3D,
    metalDeposits: readonly MetalDeposit[],
  ) {
    this.clientViewState = clientViewState;
    this.constructionVisuals = constructionVisuals;
    this.resourcePylonAnimator = new BuildingResourcePylonAnimator3D(
      clientViewState,
      constructionVisuals,
      metalDeposits,
      (id, open) => this.windCloseAmounts.get(id) ?? (open ? 0 : 1),
      (id, open) => this.extractorCloseAmounts.get(id) ?? (open ? 0 : 1),
    );
  }

  register(entity: Entity, mesh: EntityMesh): void {
    if (entity.buildingBlueprintId === 'buildingSolar' && mesh.buildingDetails) {
      const entry = addAnimatedBuildingEntry(this.solarBuildings, this.solarBuildingIndexById, entity, mesh);
      this.updateSolarAnimationQueue(entry);
    }
    if (mesh.windRig) {
      const entry = addAnimatedBuildingEntry(this.windBuildings, this.windBuildingIndexById, entity, mesh);
      this.updateWindAnimationQueue(entry);
    }
    if (mesh.extractorRig) {
      const entry = addAnimatedBuildingEntry(this.extractorBuildings, this.extractorBuildingIndexById, entity, mesh);
      this.updateExtractorAnimationQueue(entry);
    }
    if (mesh.converterRig) {
      const entry = addAnimatedBuildingEntry(this.converterBuildings, this.converterBuildingIndexById, entity, mesh);
      this.updateConverterAnimationQueue(entry);
    }
    this.resourcePylonAnimator.register(entity, mesh);
    if (mesh.factoryBuildSpotRig) {
      const entry = addAnimatedBuildingEntry(
        this.factoryBuildings,
        this.factoryBuildingIndexById,
        entity,
        mesh,
      );
      this.updateFactoryAnimationQueue(entry);
    }
    if (mesh.radarRig) {
      const entry = addAnimatedBuildingEntry(this.radarBuildings, this.radarBuildingIndexById, entity, mesh);
      this.updateRadarAnimationQueue(entry);
    }
  }

  sync(entity: Entity, mesh: EntityMesh): void {
    if (entity.buildingBlueprintId === 'buildingSolar' && mesh.buildingDetails) {
      const entry = addAnimatedBuildingEntry(this.solarBuildings, this.solarBuildingIndexById, entity, mesh);
      this.updateSolarAnimationQueue(entry);
    }
    if (mesh.converterRig) {
      const entry = addAnimatedBuildingEntry(this.converterBuildings, this.converterBuildingIndexById, entity, mesh);
      this.updateConverterAnimationQueue(entry);
    }
    if (mesh.windRig) {
      const entry = addAnimatedBuildingEntry(this.windBuildings, this.windBuildingIndexById, entity, mesh);
      this.updateWindAnimationQueue(entry);
    }
    if (mesh.extractorRig) {
      const entry = addAnimatedBuildingEntry(this.extractorBuildings, this.extractorBuildingIndexById, entity, mesh);
      this.updateExtractorAnimationQueue(entry);
    }
    if (mesh.radarRig) {
      const entry = addAnimatedBuildingEntry(this.radarBuildings, this.radarBuildingIndexById, entity, mesh);
      this.updateRadarAnimationQueue(entry);
    }
    if (mesh.factoryBuildSpotRig) {
      const entry = addAnimatedBuildingEntry(
        this.factoryBuildings,
        this.factoryBuildingIndexById,
        entity,
        mesh,
      );
      this.updateFactoryAnimationQueue(entry);
    }
  }

  unregister(id: EntityId): void {
    removeAnimatedBuildingEntry(this.solarBuildings, this.solarBuildingIndexById, id);
    removeAnimatedBuildingEntry(this.activeSolarBuildings, this.activeSolarBuildingIndexById, id);
    removeAnimatedBuildingEntry(this.windBuildings, this.windBuildingIndexById, id);
    removeAnimatedBuildingEntry(this.activeWindBuildings, this.activeWindBuildingIndexById, id);
    removeAnimatedBuildingEntry(this.extractorBuildings, this.extractorBuildingIndexById, id);
    removeAnimatedBuildingEntry(this.activeExtractorBuildings, this.activeExtractorBuildingIndexById, id);
    removeAnimatedBuildingEntry(this.converterBuildings, this.converterBuildingIndexById, id);
    removeAnimatedBuildingEntry(this.activeConverterBuildings, this.activeConverterBuildingIndexById, id);
    this.resourcePylonAnimator.unregister(id);
    this.extractorRotorPhases.delete(id);
    this.extractorRotorSpeeds.delete(id);
    this.extractorCloseAmounts.delete(id);
    this.extractorRotorYaws.delete(id);
    this.extractorAppliedCloseAmounts.delete(id);
    this.windCloseAmounts.delete(id);
    this.windAppliedCloseAmounts.delete(id);
    removeAnimatedBuildingEntry(this.factoryBuildings, this.factoryBuildingIndexById, id);
    removeAnimatedBuildingEntry(this.activeFactoryBuildings, this.activeFactoryBuildingIndexById, id);
    removeAnimatedBuildingEntry(this.radarBuildings, this.radarBuildingIndexById, id);
    removeAnimatedBuildingEntry(this.activeRadarBuildings, this.activeRadarBuildingIndexById, id);
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
    spinDt: number,
    currentDtMs: number,
    timeMs: number,
  ): void {
    this.resourcePylonAnimator.refreshActiveQueue();
    this.updateActiveSolarAnimations();

    this.updateActiveWindAnimations();
    this.updateActiveExtractorAnimations(spinDt);
    this.updateActiveConverterAnimations(spinDt, timeMs);
    this.resourcePylonAnimator.updateActive(spinDt);

    for (let i = 0; i < this.activeFactoryBuildings.length;) {
      const entry = this.activeFactoryBuildings[i];
      const { entity, mesh } = entry;
      const detailsReady = mesh.buildingCachedDetailsReady === true;
      const emitterRig = findConstructionEmitterRig(mesh, entity);
      let emitterVisualActive = false;
      if (emitterRig) {
        emitterVisualActive = this.constructionVisuals.updateFactoryConstructionEmitter(
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
      if (this.factoryBuildSpotActive(entry) || emitterVisualActive) {
        i++;
      } else {
        removeAnimatedBuildingEntry(
          this.activeFactoryBuildings,
          this.activeFactoryBuildingIndexById,
          entry.id,
        );
      }
    }

    this.updateActiveRadarAnimations(spinDt);
  }

  destroy(): void {
    clearAnimatedBuildingEntries(this.solarBuildings, this.solarBuildingIndexById);
    clearAnimatedBuildingEntries(this.activeSolarBuildings, this.activeSolarBuildingIndexById);
    clearAnimatedBuildingEntries(this.windBuildings, this.windBuildingIndexById);
    clearAnimatedBuildingEntries(this.activeWindBuildings, this.activeWindBuildingIndexById);
    clearAnimatedBuildingEntries(this.extractorBuildings, this.extractorBuildingIndexById);
    clearAnimatedBuildingEntries(this.activeExtractorBuildings, this.activeExtractorBuildingIndexById);
    clearAnimatedBuildingEntries(this.converterBuildings, this.converterBuildingIndexById);
    clearAnimatedBuildingEntries(this.activeConverterBuildings, this.activeConverterBuildingIndexById);
    this.resourcePylonAnimator.destroy();
    clearAnimatedBuildingEntries(this.factoryBuildings, this.factoryBuildingIndexById);
    clearAnimatedBuildingEntries(this.activeFactoryBuildings, this.activeFactoryBuildingIndexById);
    clearAnimatedBuildingEntries(this.radarBuildings, this.radarBuildingIndexById);
    clearAnimatedBuildingEntries(this.activeRadarBuildings, this.activeRadarBuildingIndexById);
    this.extractorRotorPhases.clear();
    this.extractorRotorSpeeds.clear();
    this.extractorCloseAmounts.clear();
    this.extractorRotorYaws.clear();
    this.windCloseAmounts.clear();
    this.windAppliedCloseAmounts.clear();
    this.extractorAppliedCloseAmounts.clear();
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

  private updateSolarAnimationQueue(entry: AnimatedBuildingEntry): void {
    updateAnimatedBuildingQueue(
      this.activeSolarBuildings,
      this.activeSolarBuildingIndexById,
      entry,
      this.solarAnimationNeedsFrame(entry),
    );
  }

  private updateActiveSolarAnimations(): void {
    for (let i = 0; i < this.activeSolarBuildings.length;) {
      const entry = this.activeSolarBuildings[i];
      const detailsReady = entry.mesh.buildingCachedDetailsReady === true;
      if (this.updateSolarCollectorAnimation(entry.mesh, entry.entity, detailsReady)) {
        i++;
      } else {
        removeAnimatedBuildingEntry(this.activeSolarBuildings, this.activeSolarBuildingIndexById, entry.id);
      }
    }
  }

  private solarAnimationNeedsFrame(entry: AnimatedBuildingEntry): boolean {
    if (entry.entity.buildingBlueprintId !== 'buildingSolar' || !entry.mesh.buildingDetails) return false;
    const target = this.solarTargetAmount(entry.entity);
    const current = entry.mesh.solarOpenAmount ?? target;
    const appliedPose = entry.mesh.solarPetalPoseAmount ?? 1;
    return Math.abs(target - current) >= BUILDING_RIG_IDLE_EPSILON ||
      Math.abs(target - appliedPose) >= BUILDING_RIG_IDLE_EPSILON;
  }

  private solarTargetAmount(entity: Entity): number {
    return entity.building?.activeState?.open === false ? 0 : 1;
  }

  private updateWindAnimationQueue(entry: AnimatedBuildingEntry): void {
    updateAnimatedBuildingQueue(
      this.activeWindBuildings,
      this.activeWindBuildingIndexById,
      entry,
      this.windAnimationNeedsFrame(entry),
    );
  }

  private updateActiveWindAnimations(): void {
    if (this.activeWindBuildings.length === 0) return;
    this.updateWindAnimationGlobals();
    for (let i = 0; i < this.activeWindBuildings.length;) {
      const entry = this.activeWindBuildings[i];
      if (this.updateWindAnimationEntry(entry)) {
        i++;
      } else {
        removeAnimatedBuildingEntry(this.activeWindBuildings, this.activeWindBuildingIndexById, entry.id);
      }
    }
  }

  private windAnimationNeedsFrame(entry: AnimatedBuildingEntry): boolean {
    if (!entry.mesh.windRig) return false;
    if (entry.entity.building?.activeState?.open !== false) return true;
    const appliedClose = this.windAppliedCloseAmounts.get(entry.id) ?? 0;
    return Math.abs(1 - appliedClose) >= BUILDING_RIG_IDLE_EPSILON;
  }

  private updateWindAnimationEntry(entry: AnimatedBuildingEntry): boolean {
    const { id, entity, mesh } = entry;
    const open = entity.building?.activeState?.open !== false;
    const closeTarget = open ? 0 : 1;
    let close = this.windCloseAmounts.get(id) ?? closeTarget;
    close = Math.abs(closeTarget - close) < 0.002
      ? closeTarget
      : close + (closeTarget - close) * BUILDING_FORTIFY_ANIM_ALPHA;
    this.windCloseAmounts.set(id, close);
    const detailsReady = mesh.buildingCachedDetailsReady === true;
    this.updateWindTurbineRig(mesh, detailsReady, close);
    if (detailsReady) this.windAppliedCloseAmounts.set(id, close);
    return this.windAnimationNeedsFrame(entry);
  }

  private updateExtractorAnimationQueue(entry: AnimatedBuildingEntry): void {
    updateAnimatedBuildingQueue(
      this.activeExtractorBuildings,
      this.activeExtractorBuildingIndexById,
      entry,
      this.extractorAnimationNeedsFrame(entry),
    );
  }

  private updateActiveExtractorAnimations(spinDt: number): void {
    if (this.activeExtractorBuildings.length === 0) return;
    const rotorSpeedAlpha = visualAnimBlend(getRotationVelEmaMode(), spinDt);
    for (let i = 0; i < this.activeExtractorBuildings.length;) {
      const entry = this.activeExtractorBuildings[i];
      if (this.updateExtractorAnimationEntry(entry, spinDt, rotorSpeedAlpha)) {
        i++;
      } else {
        removeAnimatedBuildingEntry(
          this.activeExtractorBuildings,
          this.activeExtractorBuildingIndexById,
          entry.id,
        );
      }
    }
  }

  private extractorAnimationNeedsFrame(entry: AnimatedBuildingEntry): boolean {
    if (!entry.mesh.extractorRig) return false;
    const open = entry.entity.building?.activeState?.open !== false;
    const closeTarget = open ? 0 : 1;
    const appliedClose = this.extractorAppliedCloseAmounts.get(entry.id) ?? 0;
    const speed = Math.abs(this.extractorRotorSpeeds.get(entry.id) ?? 0);
    const rate = open ? (entry.entity.metalExtractionRate ?? 0) : 0;
    return Math.abs(closeTarget - appliedClose) >= BUILDING_RIG_IDLE_EPSILON ||
      speed > BUILDING_RIG_IDLE_EPSILON ||
      rate > BUILDING_RIG_IDLE_EPSILON;
  }

  private updateExtractorAnimationEntry(
    entry: AnimatedBuildingEntry,
    spinDt: number,
    rotorSpeedAlpha: number,
  ): boolean {
    const { id, entity, mesh } = entry;
    const open = entity.building?.activeState?.open !== false;
    const closeTarget = open ? 0 : 1;
    let close = this.extractorCloseAmounts.get(id) ?? closeTarget;
    close = Math.abs(closeTarget - close) < 0.002
      ? closeTarget
      : close + (closeTarget - close) * BUILDING_FORTIFY_ANIM_ALPHA;
    this.extractorCloseAmounts.set(id, close);

    const rate = open ? (entity.metalExtractionRate ?? 0) : 0;
    const normalizedRate = rate * INV_EXTRACTOR_BASE_PRODUCTION;
    let phase = this.extractorRotorPhases.get(id);
    if (phase === undefined) phase = id * 0.173;
    const targetSpeed = EXTRACTOR_ROTOR_RAD_PER_SEC * normalizedRate * (1 - close);
    let speed = this.extractorRotorSpeeds.get(id) ?? 0;
    speed = lerp(speed, targetSpeed, rotorSpeedAlpha);
    if (targetSpeed === 0 && speed < BUILDING_RIG_IDLE_EPSILON) speed = 0;
    phase += spinDt * speed;

    const rig = mesh.extractorRig;
    const detailsReady = mesh.buildingCachedDetailsReady === true;
    if (rig && detailsReady) {
      const alignedPhase = getNextExtractorAlignedPhase(phase, Math.PI * 2);
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
      const previousYaw = this.extractorRotorYaws.get(id);
      if (previousYaw !== undefined && yaw > previousYaw) yaw = previousYaw;
      this.extractorRotorYaws.set(id, yaw);
      const rotors = rig.rotors;
      for (let r = 0; r < rotors.length; r++) {
        const rotor = rotors[r];
        rotor.rotation.y = yaw;
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
      this.extractorAppliedCloseAmounts.set(id, close);
    }
    this.extractorRotorPhases.set(id, phase);
    this.extractorRotorSpeeds.set(id, speed);
    return this.extractorAnimationNeedsFrame(entry);
  }

  private updateConverterAnimationQueue(entry: AnimatedBuildingEntry): void {
    updateAnimatedBuildingQueue(
      this.activeConverterBuildings,
      this.activeConverterBuildingIndexById,
      entry,
      this.converterAnimationNeedsFrame(entry),
    );
  }

  private updateActiveConverterAnimations(spinDt: number, timeMs: number): void {
    if (this.activeConverterBuildings.length === 0) return;
    const ringSpeedAlpha = visualAnimBlend(getRotationVelEmaMode(), spinDt);
    for (let i = 0; i < this.activeConverterBuildings.length;) {
      const entry = this.activeConverterBuildings[i];
      if (this.updateConverterRingAnimation(entry, ringSpeedAlpha, spinDt, timeMs)) {
        i++;
      } else {
        removeAnimatedBuildingEntry(
          this.activeConverterBuildings,
          this.activeConverterBuildingIndexById,
          entry.id,
        );
      }
    }
  }

  private converterAnimationNeedsFrame(entry: AnimatedBuildingEntry): boolean {
    if (!entry.mesh.converterRig) return false;
    if (entry.entity.building?.activeState?.open !== false) return true;
    return Math.abs(this.converterEnergyRingSpeeds.get(entry.id) ?? 0) > BUILDING_RIG_IDLE_EPSILON ||
      Math.abs(this.converterMetalRingSpeeds.get(entry.id) ?? 0) > BUILDING_RIG_IDLE_EPSILON ||
      Math.abs(this.converterAccentRingSpeeds.get(entry.id) ?? 0) > BUILDING_RIG_IDLE_EPSILON;
  }

  private updateConverterRingAnimation(
    entry: AnimatedBuildingEntry,
    ringSpeedAlpha: number,
    spinDt: number,
    timeMs: number,
  ): boolean {
    const { id, entity, mesh } = entry;
    const rig = mesh.converterRig;
    if (!rig) return false;
    const invBase = INV_CONVERTER_BASE_RATE;
    const energyRate = this.clientViewState.getResourcePylonSignedRate(id, RESOURCE_KIND_ENERGY);
    const metalRate = this.clientViewState.getResourcePylonSignedRate(id, RESOURCE_KIND_METAL);

    // Ring spin is signed by flow direction. Open converters keep a slow
    // idle drift; closed converters drain their local speeds to zero and
    // then leave the active queue.
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

    let energySpeed = lerp(
      this.converterEnergyRingSpeeds.get(id) ?? 0,
      energyTarget,
      ringSpeedAlpha,
    );
    let metalSpeed = lerp(
      this.converterMetalRingSpeeds.get(id) ?? 0,
      metalTarget,
      ringSpeedAlpha,
    );
    let accentSpeed = lerp(
      this.converterAccentRingSpeeds.get(id) ?? 0,
      accentTarget,
      ringSpeedAlpha,
    );
    if (!open) {
      if (Math.abs(energySpeed) < BUILDING_RIG_IDLE_EPSILON) energySpeed = 0;
      if (Math.abs(metalSpeed) < BUILDING_RIG_IDLE_EPSILON) metalSpeed = 0;
      if (Math.abs(accentSpeed) < BUILDING_RIG_IDLE_EPSILON) accentSpeed = 0;
    }
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

    rig.energyRing.rotation.z = energyPhase;
    rig.metalRing.rotation.z = metalPhase;
    rig.accentRing.rotation.z = accentPhase;

    const haloPulse = 1
      + 0.04 * Math.sin(timeMs * 0.0035 + seed)
      + 0.06 * Math.max(energyMag, metalMag);
    rig.coreHalo.scale.setScalar(rig.coreHaloBaseRadius * haloPulse);
    return this.converterAnimationNeedsFrame(entry);
  }

  private updateRadarAnimationQueue(entry: AnimatedBuildingEntry): void {
    updateAnimatedBuildingQueue(
      this.activeRadarBuildings,
      this.activeRadarBuildingIndexById,
      entry,
      this.radarAnimationNeedsFrame(entry),
    );
  }

  private updateActiveRadarAnimations(spinDt: number): void {
    if (this.activeRadarBuildings.length === 0) return;
    const radarSpeedAlpha = visualAnimBlend(getRotationVelEmaMode(), spinDt);
    for (let i = 0; i < this.activeRadarBuildings.length;) {
      const entry = this.activeRadarBuildings[i];
      if (this.updateRadarAnimationEntry(entry, radarSpeedAlpha, spinDt)) {
        i++;
      } else {
        removeAnimatedBuildingEntry(this.activeRadarBuildings, this.activeRadarBuildingIndexById, entry.id);
      }
    }
  }

  private radarAnimationNeedsFrame(entry: AnimatedBuildingEntry): boolean {
    if (!entry.mesh.radarRig) return false;
    if (entry.entity.building?.activeState?.open !== false) return true;
    return Math.abs(this.radarHeadSpeeds.get(entry.id) ?? 0) > BUILDING_RIG_IDLE_EPSILON ||
      Math.abs(this.radarSweepSpeeds.get(entry.id) ?? 0) > BUILDING_RIG_IDLE_EPSILON;
  }

  private updateRadarAnimationEntry(
    entry: AnimatedBuildingEntry,
    radarSpeedAlpha: number,
    spinDt: number,
  ): boolean {
    const { id, entity, mesh } = entry;
    const rig = mesh.radarRig;
    if (!rig) return false;
    if (mesh.buildingCachedDetailsReady !== true) return this.radarAnimationNeedsFrame(entry);
    const open = entity.building?.activeState?.open !== false;
    const seed = id * 0.137;
    let headSpeed = lerp(
      this.radarHeadSpeeds.get(id) ?? 0,
      open ? RADAR_HEAD_RAD_PER_SEC : 0,
      radarSpeedAlpha,
    );
    let sweepSpeed = lerp(
      this.radarSweepSpeeds.get(id) ?? 0,
      open ? -RADAR_SWEEP_RAD_PER_SEC : 0,
      radarSpeedAlpha,
    );
    if (!open) {
      if (Math.abs(headSpeed) < BUILDING_RIG_IDLE_EPSILON) headSpeed = 0;
      if (Math.abs(sweepSpeed) < BUILDING_RIG_IDLE_EPSILON) sweepSpeed = 0;
    }
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
    return this.radarAnimationNeedsFrame(entry);
  }

  private updateFactoryAnimationQueue(entry: AnimatedBuildingEntry): void {
    updateAnimatedBuildingQueue(
      this.activeFactoryBuildings,
      this.activeFactoryBuildingIndexById,
      entry,
      this.factoryAnimationNeedsFrame(entry),
    );
  }

  private factoryAnimationNeedsFrame(entry: AnimatedBuildingEntry): boolean {
    return this.factoryBuildSpotActive(entry) ||
      this.factoryConstructionEmitterDraining(entry);
  }

  private factoryBuildSpotActive(entry: AnimatedBuildingEntry): boolean {
    const { entity, mesh } = entry;
    const factory = entity.factory;
    return mesh.buildingCachedDetailsReady === true &&
      factory !== null &&
      !!factory.selectedUnitBlueprintId &&
      factory.isProducing;
  }

  private factoryConstructionEmitterDraining(entry: AnimatedBuildingEntry): boolean {
    const rig = findConstructionEmitterRig(entry.mesh, entry.entity);
    if (!rig) return false;
    return rig.smoothedRates.energy > FACTORY_ANIMATION_IDLE_EPSILON ||
      rig.smoothedRates.metal > FACTORY_ANIMATION_IDLE_EPSILON ||
      rig.displaySmoothedRates.energy > FACTORY_ANIMATION_IDLE_EPSILON ||
      rig.displaySmoothedRates.metal > FACTORY_ANIMATION_IDLE_EPSILON;
  }

  private updateSolarCollectorAnimation(
    m: EntityMesh,
    e: Entity,
    detailsReady: boolean,
  ): boolean {
    if (e.buildingBlueprintId !== 'buildingSolar' || !m.buildingDetails) return false;
    if (!detailsReady) return this.solarAnimationNeedsFrame({ id: e.id, entity: e, mesh: m });
    const target = this.solarTargetAmount(e);
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
    m.solarPetalPoseAmount = next;
    return Math.abs(target - next) >= BUILDING_RIG_IDLE_EPSILON;
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
