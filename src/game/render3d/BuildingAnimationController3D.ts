import * as THREE from 'three';
import {
  WIND_TURBINE_RESPONSE_HALF_LIFE_MULTIPLIERS,
  WIND_TURBINE_ROTOR_SPIN_REFLECTS_ACTUAL_PRODUCTION,
  WIND_TURBINE_ROTOR_TIP_SPEED_RATIO,
  WIND_TURBINE_ROTOR_POTENTIAL_RAD_PER_SEC,
} from '../../config';
import {
  EXTRACTOR_ROTOR_RAD_PER_SEC_PER_METAL_RATE,
  METAL_EXTRACTOR_ROTOR_SPIN_MULTIPLIER,
  EXTRACTOR_ROTOR_SPIN_REFLECTS_ACTUAL_PRODUCTION,
  EXTRACTOR_ROTOR_POTENTIAL_RAD_PER_SEC,
} from '@/resourceConfig';
import type { MetalDeposit } from '../../metalDepositConfig';
import type { ClientViewState } from '../network/ClientViewState';
import { halfLifeBlend } from '../math/halfLife';
import { IndexedEntityIdMap } from '../network/IndexedEntityIdCollections';
import { lerp, lerpAngle } from '../math';
import type { Entity, EntityId } from '../sim/types';
import {
  applySolarCollectorPetalPose,
} from './SolarCollectorMesh3D';
import type {
  ConstructionEmitterRig,
} from './ConstructionEmitterMesh3D';
import type { EntityMesh } from './EntityMesh3D';
import type { ConstructionVisualController3D } from './ConstructionVisualController3D';
import type { ResourcePylonFlowController3D } from './ResourcePylonFlowController3D';
import type { ExtractorBladeAnim } from './MetalExtractorMesh3D';
import {
  addAnimatedBuildingEntry,
  clearAnimatedBuildingEntries,
  removeAnimatedBuildingEntry,
  updateAnimatedBuildingQueue,
  type AnimatedBuildingEntry,
} from './BuildingAnimationLists3D';
import {
  BuildingResourcePylonAnimator3D,
} from './BuildingResourcePylonAnimator3D';
import { windRotorAngularSpeed } from './WindKinematics3D';

// Open/close pose transitions are discrete local state changes, not snapshot
// rotation fields. One fixed progress duration makes closing the exact reverse
// of opening, including the symmetric pose easing in SolarCollectorMesh3D.
const SOLAR_PETAL_TRANSITION_DURATION_SEC = 0.6;
const RADAR_HEAD_RAD_PER_SEC = 0.55;
const RADAR_SWEEP_RAD_PER_SEC = 1.8;
const EXTRACTOR_ROTOR_SPEED_RESPONSE_HALF_LIFE_SEC = 0.08;
const RADAR_SPEED_RESPONSE_HALF_LIFE_SEC = 0.08;
const WIND_DIRECTION_RESPONSE_HALF_LIFE_SEC = 0.08;
const WIND_SPEED_RESPONSE_HALF_LIFE_SEC = 0.08;
/** Per-frame blend toward the building's target open/closed pose
 *  (wind nacelle pitch + blade fold, extractor blade fold). Matches the
 *  solar petal animator's feel — smooth but not laggy. */
const BUILDING_FORTIFY_ANIM_ALPHA = 0.12;
const _extractorBladeQuat = new THREE.Quaternion();
const _extractorBladePos = new THREE.Vector3();
const _extractorBladeScale = new THREE.Vector3();
const _windBladeQuat = new THREE.Quaternion();

const FACTORY_ANIMATION_IDLE_EPSILON = 0.001;
const BUILDING_RIG_IDLE_EPSILON = 0.001;

export class BuildingAnimationController3D {
  private readonly clientViewState: ClientViewState;
  private readonly constructionVisuals: ConstructionVisualController3D;
  private readonly resourcePylonAnimator: BuildingResourcePylonAnimator3D;
  private solarBuildings: AnimatedBuildingEntry[] = [];
  private solarBuildingIndexById = new IndexedEntityIdMap<number>();
  private activeSolarBuildings: AnimatedBuildingEntry[] = [];
  private activeSolarBuildingIndexById = new IndexedEntityIdMap<number>();
  private windBuildings: AnimatedBuildingEntry[] = [];
  private windBuildingIndexById = new IndexedEntityIdMap<number>();
  private activeWindBuildings: AnimatedBuildingEntry[] = [];
  private activeWindBuildingIndexById = new IndexedEntityIdMap<number>();
  private extractorBuildings: AnimatedBuildingEntry[] = [];
  private extractorBuildingIndexById = new IndexedEntityIdMap<number>();
  private activeExtractorBuildings: AnimatedBuildingEntry[] = [];
  private activeExtractorBuildingIndexById = new IndexedEntityIdMap<number>();
  private factoryBuildings: AnimatedBuildingEntry[] = [];
  private factoryBuildingIndexById = new IndexedEntityIdMap<number>();
  private activeFactoryBuildings: AnimatedBuildingEntry[] = [];
  private activeFactoryBuildingIndexById = new IndexedEntityIdMap<number>();
  private radarBuildings: AnimatedBuildingEntry[] = [];
  private radarBuildingIndexById = new IndexedEntityIdMap<number>();
  private activeRadarBuildings: AnimatedBuildingEntry[] = [];
  private activeRadarBuildingIndexById = new IndexedEntityIdMap<number>();
  private windFanYaw: number | null = null;
  private windFanPitch: number | null = null;
  private windVisualSpeed: number | null = null;
  /** Per-turbine phase lets differently sized future rotors obey the same
   *  tip-speed ratio without coupling their angular velocity. */
  private windRotorPhases = new IndexedEntityIdMap<number>();
  private windAnimLastMs = 0;
  /** Per-entity rotor phase. Each extractor advances its own counter
   *  from a locally smoothed angular speed, so an extractor on
   *  bare ground stays stationary while one fully covering a deposit
   *  spins at full speed. Indexed by entity id; entries get pruned
   *  when the extractor despawns. */
  private extractorRotorPhases = new IndexedEntityIdMap<number>();
  /** Local visual angular speed for extractor spin-up/spin-down. */
  private extractorRotorSpeeds = new IndexedEntityIdMap<number>();
  /** Per-entity "closed amount" for the extractor's blade fold (0 =
   *  spinning open, 1 = folded flat against the pyramid). Smoothed
   *  toward the server's open flag with BUILDING_FORTIFY_ANIM_ALPHA. */
  private extractorCloseAmounts = new IndexedEntityIdMap<number>();
  /** Last applied extractor rotor yaw. Kept monotonic in the negative
   *  spin direction so open/close transitions can pause at an aligned
   *  pose, but never visibly reverse. */
  private extractorRotorYaws = new IndexedEntityIdMap<number>();
  /** Per-entity "closed amount" for the wind turbine's stowed pose
   *  (nacelle tilts skyward + blades fold against the pole). */
  private windCloseAmounts = new IndexedEntityIdMap<number>();
  private windAppliedCloseAmounts = new IndexedEntityIdMap<number>();
  /** Local decorative angular speeds for the radar rig. */
  private radarHeadPhases = new IndexedEntityIdMap<number>();
  private radarSweepPhases = new IndexedEntityIdMap<number>();
  private radarHeadSpeeds = new IndexedEntityIdMap<number>();
  private radarSweepSpeeds = new IndexedEntityIdMap<number>();
  private extractorAppliedCloseAmounts = new IndexedEntityIdMap<number>();

  constructor(
    clientViewState: ClientViewState,
    constructionVisuals: ConstructionVisualController3D,
    resourcePylonFlows: ResourcePylonFlowController3D,
    metalDeposits: readonly MetalDeposit[],
  ) {
    this.clientViewState = clientViewState;
    this.constructionVisuals = constructionVisuals;
    this.resourcePylonAnimator = new BuildingResourcePylonAnimator3D(
      clientViewState,
      resourcePylonFlows,
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
    this.resourcePylonAnimator.register(entity, mesh);
    if (mesh.isFactoryConstructionHost) {
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
    if (mesh.isFactoryConstructionHost) {
      const entry = addAnimatedBuildingEntry(
        this.factoryBuildings,
        this.factoryBuildingIndexById,
        entity,
        mesh,
      );
      this.updateFactoryAnimationQueue(entry);
    }
  }

  /** Detach the current mesh while retaining per-entity animation phase. */
  detach(id: EntityId): void {
    removeAnimatedBuildingEntry(this.solarBuildings, this.solarBuildingIndexById, id);
    removeAnimatedBuildingEntry(this.activeSolarBuildings, this.activeSolarBuildingIndexById, id);
    removeAnimatedBuildingEntry(this.windBuildings, this.windBuildingIndexById, id);
    removeAnimatedBuildingEntry(this.activeWindBuildings, this.activeWindBuildingIndexById, id);
    removeAnimatedBuildingEntry(this.extractorBuildings, this.extractorBuildingIndexById, id);
    removeAnimatedBuildingEntry(this.activeExtractorBuildings, this.activeExtractorBuildingIndexById, id);
    this.resourcePylonAnimator.unregister(id);
    removeAnimatedBuildingEntry(this.factoryBuildings, this.factoryBuildingIndexById, id);
    removeAnimatedBuildingEntry(this.activeFactoryBuildings, this.activeFactoryBuildingIndexById, id);
    removeAnimatedBuildingEntry(this.radarBuildings, this.radarBuildingIndexById, id);
    removeAnimatedBuildingEntry(this.activeRadarBuildings, this.activeRadarBuildingIndexById, id);
  }

  /** Full teardown: detach the mesh and forget all entity animation state. */
  unregister(id: EntityId): void {
    this.detach(id);
    this.constructionVisuals.unregister(id);
    this.extractorRotorPhases.delete(id);
    this.extractorRotorSpeeds.delete(id);
    this.extractorCloseAmounts.delete(id);
    this.extractorRotorYaws.delete(id);
    this.extractorAppliedCloseAmounts.delete(id);
    this.windCloseAmounts.delete(id);
    this.windAppliedCloseAmounts.delete(id);
    this.windRotorPhases.delete(id);
    this.radarHeadPhases.delete(id);
    this.radarSweepPhases.delete(id);
    this.radarHeadSpeeds.delete(id);
    this.radarSweepSpeeds.delete(id);
  }

  update(
    spinDt: number,
    currentDtMs: number,
    // Wall-clock animation time — currently unused since the factory
    // build-spot ghost orbs were retired, but kept on the building-
    // animation tick signature for time-driven animators.
    _timeMs: number,
  ): void {
    this.resourcePylonAnimator.refreshActiveQueue();
    this.updateActiveSolarAnimations(currentDtMs / 1000);

    this.updateActiveWindAnimations();
    this.updateActiveExtractorAnimations(spinDt);
    this.resourcePylonAnimator.updateActive(spinDt);

    for (let i = 0; i < this.activeFactoryBuildings.length;) {
      const entry = this.activeFactoryBuildings[i];
      const { entity, mesh } = entry;
      const detailsReady = mesh.buildingCachedDetailsReady === true;
      let emitterVisualActive = false;
      forEachConstructionEmitterRig(mesh, entity, (rig) => {
        if (this.constructionVisuals.updateFactoryConstructionEmitter(
          rig,
          entity,
          detailsReady,
          currentDtMs,
        )) {
          emitterVisualActive = true;
        }
      });
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
    this.windRotorPhases.clear();
    this.extractorAppliedCloseAmounts.clear();
    this.radarHeadPhases.clear();
    this.radarSweepPhases.clear();
    this.radarHeadSpeeds.clear();
    this.radarSweepSpeeds.clear();
    this.windFanYaw = null;
    this.windFanPitch = null;
    this.windVisualSpeed = null;
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

  private updateActiveSolarAnimations(deltaSec: number): void {
    for (let i = 0; i < this.activeSolarBuildings.length;) {
      const entry = this.activeSolarBuildings[i];
      const detailsReady = entry.mesh.buildingCachedDetailsReady === true;
      if (this.updateSolarCollectorAnimation(
        entry.mesh,
        entry.entity,
        detailsReady,
        deltaSec,
      )) {
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
    const appliedPose = entry.mesh.solarPetalPoseAmount;
    return appliedPose === undefined ||
      Math.abs(target - current) >= BUILDING_RIG_IDLE_EPSILON ||
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
    const dtSec = this.updateWindAnimationGlobals();
    for (let i = 0; i < this.activeWindBuildings.length;) {
      const entry = this.activeWindBuildings[i];
      if (this.updateWindAnimationEntry(entry, dtSec)) {
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

  private updateWindAnimationEntry(entry: AnimatedBuildingEntry, dtSec: number): boolean {
    const { id, entity, mesh } = entry;
    const open = entity.building?.activeState?.open !== false;
    const closeTarget = open ? 0 : 1;
    let close = this.windCloseAmounts.get(id) ?? closeTarget;
    close = Math.abs(closeTarget - close) < 0.002
      ? closeTarget
      : close + (closeTarget - close) * BUILDING_FORTIFY_ANIM_ALPHA;
    this.windCloseAmounts.set(id, close);
    const detailsReady = mesh.buildingCachedDetailsReady === true;
    const rig = mesh.windRig;
    let rotorPhase = this.windRotorPhases.get(id) ?? 0;
    if (rig && open && this.windVisualSpeed !== null) {
      const angularSpeed = WIND_TURBINE_ROTOR_SPIN_REFLECTS_ACTUAL_PRODUCTION
        ? windRotorAngularSpeed(
          this.windVisualSpeed,
          rig.rotorRadiusWorld,
          WIND_TURBINE_ROTOR_TIP_SPEED_RATIO,
        )
        : WIND_TURBINE_ROTOR_POTENTIAL_RAD_PER_SEC;
      rotorPhase += dtSec * angularSpeed;
      this.windRotorPhases.set(id, rotorPhase);
    }
    this.updateWindTurbineRig(mesh, detailsReady, close, rotorPhase);
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
    const rotorSpeedAlpha = halfLifeBlend(
      spinDt,
      EXTRACTOR_ROTOR_SPEED_RESPONSE_HALF_LIFE_SEC,
    );
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

    const actualRate = open ? (entity.metalExtractionRate ?? 0) : 0;
    let phase = this.extractorRotorPhases.get(id);
    if (phase === undefined) phase = id * 0.173;
    // ACTUAL mode (default): spin ∝ live metal throughput — an advanced
    // extractor pulling 5× turns 5× as fast, and one extracting nothing is
    // still. POTENTIAL mode: any deposit-covered extractor spins at a flat
    // rate (what it *could* extract), still zero off a deposit / when closed.
    const baseSpeed = EXTRACTOR_ROTOR_SPIN_REFLECTS_ACTUAL_PRODUCTION
      ? actualRate *
        EXTRACTOR_ROTOR_RAD_PER_SEC_PER_METAL_RATE *
        METAL_EXTRACTOR_ROTOR_SPIN_MULTIPLIER
      : (actualRate > 0 ? EXTRACTOR_ROTOR_POTENTIAL_RAD_PER_SEC : 0);
    const targetSpeed = baseSpeed * (1 - close);
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
    const radarSpeedAlpha = halfLifeBlend(
      spinDt,
      RADAR_SPEED_RESPONSE_HALF_LIFE_SEC,
    );
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
    let draining = false;
    forEachConstructionEmitterRig(entry.mesh, entry.entity, (rig) => {
      if (
        rig.smoothedRates.energy > FACTORY_ANIMATION_IDLE_EPSILON ||
        rig.smoothedRates.metal > FACTORY_ANIMATION_IDLE_EPSILON ||
        rig.displaySmoothedRates.energy > FACTORY_ANIMATION_IDLE_EPSILON ||
        rig.displaySmoothedRates.metal > FACTORY_ANIMATION_IDLE_EPSILON
      ) {
        draining = true;
      }
    });
    return draining;
  }

  private updateSolarCollectorAnimation(
    m: EntityMesh,
    e: Entity,
    detailsReady: boolean,
    deltaSec: number,
  ): boolean {
    if (e.buildingBlueprintId !== 'buildingSolar' || !m.buildingDetails) return false;
    if (!detailsReady) return this.solarAnimationNeedsFrame({ id: e.id, entity: e, mesh: m });
    const target = this.solarTargetAmount(e);
    const current = m.solarOpenAmount ?? target;
    const progressDelta = Number.isFinite(deltaSec)
      ? Math.max(0, deltaSec) / SOLAR_PETAL_TRANSITION_DURATION_SEC
      : 0;
    const next = target > current
      ? Math.min(target, current + progressDelta)
      : Math.max(target, current - progressDelta);
    m.solarOpenAmount = next;
    if (applySolarCollectorPetalPose(m.buildingDetails, next)) {
      m.solarPetalPoseAmount = next;
    }
    return Math.abs(target - next) >= BUILDING_RIG_IDLE_EPSILON;
  }

  private updateWindAnimationGlobals(): number {
    const wind = this.clientViewState.getServerMeta()?.wind;
    const now = performance.now();
    const dtSec = this.windAnimLastMs > 0 ? (now - this.windAnimLastMs) / 1000 : 0;
    this.windAnimLastMs = now;
    if (!wind) return 0;

    const targetYaw = Math.atan2(-wind.x, -wind.y);
    const horizontalSpeed = Math.hypot(wind.x, wind.y);
    const targetPitch = Math.atan2(wind.z, Math.max(1e-6, horizontalSpeed));
    const targetSpeed = wind.speed;
    if (
      this.windFanYaw === null ||
      this.windFanPitch === null ||
      this.windVisualSpeed === null ||
      dtSec <= 0
    ) {
      this.windFanYaw = targetYaw;
      this.windFanPitch = targetPitch;
      this.windVisualSpeed = targetSpeed;
    } else {
      this.windFanYaw = lerpAngle(
        this.windFanYaw,
        targetYaw,
        halfLifeBlend(
          dtSec,
          this.scaledWindTurbineHalfLife(
            WIND_DIRECTION_RESPONSE_HALF_LIFE_SEC,
            WIND_TURBINE_RESPONSE_HALF_LIFE_MULTIPLIERS.fanYaw,
          ),
        ),
      );
      this.windFanPitch = lerp(
        this.windFanPitch,
        targetPitch,
        halfLifeBlend(
          dtSec,
          this.scaledWindTurbineHalfLife(
            WIND_DIRECTION_RESPONSE_HALF_LIFE_SEC,
            WIND_TURBINE_RESPONSE_HALF_LIFE_MULTIPLIERS.fanYaw,
          ),
        ),
      );
      this.windVisualSpeed = lerp(
        this.windVisualSpeed,
        targetSpeed,
        halfLifeBlend(
          dtSec,
          this.scaledWindTurbineHalfLife(
            WIND_SPEED_RESPONSE_HALF_LIFE_SEC,
            WIND_TURBINE_RESPONSE_HALF_LIFE_MULTIPLIERS.bladeSpeed,
          ),
        ),
      );
    }
    return dtSec;
  }

  private scaledWindTurbineHalfLife(baseHalfLife: number, multiplier: number): number {
    if (baseHalfLife <= 0 || multiplier <= 0) return 0;
    return baseHalfLife * multiplier;
  }

  private updateWindTurbineRig(
    m: EntityMesh,
    detailsReady: boolean,
    closeAmount: number,
    rotorPhase: number,
  ): void {
    if (
      !m.windRig ||
      !detailsReady ||
      !m.windRig.root.visible ||
      this.windFanYaw === null ||
      this.windFanPitch === null
    ) return;
    // Root yaws into the incoming wind (open) but pitches up to
    // the stowed angle as the turbine closes. Yaw weight tapers to 0 in
    // the closed pose so the nacelle settles to a deterministic skyward
    // orientation instead of bobbing with the wind while folded.
    m.windRig.root.rotation.y = (this.windFanYaw - m.group.rotation.y) * (1 - closeAmount);
    m.windRig.root.rotation.x =
      this.windFanPitch * (1 - closeAmount) + m.windRig.closedPitch * closeAmount;
    // Spin only while the rotor is mostly extended. As the blades fold
    // toward the pole the rotor settles to a fixed rest phase so the
    // baked closed quaternions match exactly.
    m.windRig.rotor.rotation.z = rotorPhase * (1 - closeAmount);
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

/** Run `fn` over every construction-emitter rig mounted on this building. The
 *  fabricator carries TWO (its metal + energy construction pylons, each a
 *  single-resource rig); legacy single-emitter hosts carry one. Driving all of
 *  them keeps both pylons spinning + spraying their own resource. */
function forEachConstructionEmitterRig(
  mesh: EntityMesh,
  entity: Entity,
  fn: (rig: ConstructionEmitterRig) => void,
): void {
  const combatTurrets = entity.combat?.turrets;
  if (!combatTurrets) return;
  for (let i = 0; i < combatTurrets.length && i < mesh.turrets.length; i++) {
    if (combatTurrets[i].config.constructionEmitter) {
      const rig = mesh.turrets[i].constructionEmitter;
      if (rig) fn(rig);
    }
  }
}
