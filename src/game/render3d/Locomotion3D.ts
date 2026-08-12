// Locomotion3D — thin dispatcher over the per-locomotion-type rig
// modules (CrawlerRig3D, AmphibianRig3D, TankRig3D, RoverRig3D, DroneRig3D,
// AirframeRig3D, SubmarineRig3D). Each rig owns its build,
// update, and (for legs) state-snapshot logic. This file only:
//   - exposes the discriminated `Locomotion3DMesh` union,
//   - dispatches to the correct rig at build / update / destroy time,
//   - resolves chassis-lift from the unit blueprint,
//   - re-exports the leg state-snapshot helpers and TREAD_HEIGHT for
//     external consumers.
//
// Anything that mixed mesh construction, animation, terrain sampling,
// and rig state in one file lives in the rig modules now;
// LocomotionRigShared3D holds the cross-rig helpers (chassis→world
// transform, rolling-contact state, IK).

import type * as THREE from 'three';
import type { Entity, PlayerId } from '../sim/types';
import { getUnitBlueprint } from '../sim/blueprints';
import type { UnitBlueprint } from '@/types/blueprints';
import type { GraphicsConfig } from '@/types/graphics';
import { getBodyTopY, getChassisLiftY } from '../math/BodyDimensions';
import type { LegInstancedRenderer } from './LegInstancedRenderer';
import { LEG_CHARTS } from './SurfaceChart3D';
import {
  type CrawlerMesh,
  type LegStateSnapshot,
  applyLegState as applyLegStateImpl,
  buildCrawler,
  captureLegState as captureLegStateImpl,
  fadeLegSlots,
  freeLegSlots,
  updateCrawler,
} from './CrawlerRig3D';
import {
  type TankMesh,
  buildTank,
  updateTank,
} from './TankRig3D';
import {
  type RoverMesh,
  buildRover,
  updateRover,
} from './RoverRig3D';
import {
  type DroneMesh,
  buildDroneFans,
  getDroneFanVisualRootY,
  setDroneFanAnimationTime,
  updateDroneFans,
} from './DroneRig3D';
import {
  type AirframeMesh,
  buildAirframeRig,
  updateAirframeRig,
} from './AirframeRig3D';
import {
  type AmphibianMesh,
  buildAmphibian,
  updateAmphibian,
} from './AmphibianRig3D';
import {
  buildBotRig,
  poseBotRigAtRest,
  updateBotRig,
  type BotMesh,
} from './BotRig3D';
import {
  type SubmarineMesh,
  buildSubmarineRig,
  updateSubmarineRig,
} from './SubmarineRig3D';
import type { SmokePuffEmitter } from './SmokeTrail3D';
import type { AirframeSmokeUseId, DroneSmokeUseId } from '@/smokeConfig';
import type {
  AirborneEmitterBatch3D,
  AirborneEmitterParentPose3D,
} from './AirborneEmitterBatch3D';
import { featureVisibleAtDetail, geometryTierForDetail } from './EntityDetailLevel3D';
import type { LocomotionRenderPose } from './LocomotionRigShared3D';
import type { RollingContactState } from './LocomotionRigShared3D';

export type Locomotion3DMesh =
  | TankMesh
  | RoverMesh
  | CrawlerMesh
  | BotMesh
  | AmphibianMesh
  | DroneMesh
  | AirframeMesh
  | SubmarineMesh
  | undefined;

export type { LegStateSnapshot };
export { setDroneFanAnimationTime };

type RollingContactSnapshot = Readonly<{
  worldX: number;
  worldZ: number;
  initialized: boolean;
  phase: number;
}>;

/**
 * Geometry-tier rebuild state. It deliberately contains presentation state
 * only: changing High/Medium/Low swaps meshes while rolling phase, suspension,
 * gait and articulated poses continue from the previous frame.
 */
export type LocomotionStateSnapshot =
  | {
      type: 'crawler';
      legs: LegStateSnapshot;
      visualGrounded: boolean;
      poseInitialized: boolean;
      lastBaseX: number;
      lastBaseY: number;
      lastBaseZ: number;
    }
  | {
      type: 'bot';
      /** A tier rebuild must not restart the coupled biped cycle mid-stride. */
      contact: RollingContactSnapshot;
      gaitPhase: number;
      gaitDirection: -1 | 1;
      gait: number;
      upperBodyYaw: number;
      upperBodyWorldYaw: number | null;
      upperBodyYawVelocity: number;
    }
  | {
      type: 'rover';
      contacts: RollingContactSnapshot[];
      mounts: Array<Readonly<{ lift: number; targetLift: number; angularVelocity: number }>>;
      rotations: number[];
    }
  | {
      type: 'tank';
      contacts: RollingContactSnapshot[];
      sides: Array<Readonly<{
        lift: number;
        targetLift: number;
        beltPhase: number;
        beltVelocity: number;
        groupY: number;
        wheelRotation: number;
      }>>;
    }
  | {
      type: 'amphibian';
      contact: RollingContactSnapshot;
      waterBlend: number;
      hingeQuaternions: Array<readonly [number, number, number, number]>;
    }
  | { type: 'drone'; clearance: number }
  | { type: 'plane' | 'aerosub' }
  | {
      type: 'submarine';
      contact: RollingContactSnapshot;
      hingeQuaternions: Array<readonly [number, number, number, number]>;
    };

function captureRollingContact(state: RollingContactState): RollingContactSnapshot {
  return {
    worldX: state.worldX,
    worldZ: state.worldZ,
    initialized: state.initialized,
    phase: state.phase,
  };
}

function applyRollingContact(
  state: RollingContactState,
  snapshot: RollingContactSnapshot | undefined,
): void {
  if (snapshot === undefined) return;
  state.worldX = snapshot.worldX;
  state.worldZ = snapshot.worldZ;
  state.initialized = snapshot.initialized;
  state.phase = snapshot.phase;
}

function quaternionTuple(object: THREE.Object3D): readonly [number, number, number, number] {
  return [object.quaternion.x, object.quaternion.y, object.quaternion.z, object.quaternion.w];
}

/** Capture every mutable locomotion channel before a geometry-tier rebuild. */
export function captureLocomotionState(
  locomotion: Locomotion3DMesh,
): LocomotionStateSnapshot | undefined {
  if (!locomotion) return undefined;
  switch (locomotion.type) {
    case 'crawler':
      return {
        type: 'crawler',
        legs: captureLegStateImpl(locomotion),
        visualGrounded: locomotion.visualGrounded,
        poseInitialized: locomotion.poseInitialized,
        lastBaseX: locomotion.lastBaseX,
        lastBaseY: locomotion.lastBaseY,
        lastBaseZ: locomotion.lastBaseZ,
      };
    case 'bot':
      return {
        type: 'bot',
        contact: captureRollingContact(locomotion.contact),
        gaitPhase: locomotion.gaitPhase,
        gaitDirection: locomotion.gaitDirection,
        gait: locomotion.gait,
        upperBodyYaw: locomotion.upperBodyYaw,
        upperBodyWorldYaw: locomotion.upperBodyWorldYaw,
        upperBodyYawVelocity: locomotion.upperBodyYawVelocity,
      };
    case 'rover':
      return {
        type: 'rover',
        contacts: locomotion.wheelContacts.map(captureRollingContact),
        mounts: locomotion.wheelMounts.map((mount) => ({
          lift: mount.lift,
          targetLift: mount.targetLift,
          angularVelocity: mount.angularVelocity,
        })),
        rotations: locomotion.wheelMounts.map((mount) => mount.rotation),
      };
    case 'tank':
      return {
        type: 'tank',
        contacts: locomotion.treadContacts.map(captureRollingContact),
        sides: locomotion.sides.map((side) => ({
          lift: side.lift,
          targetLift: side.targetLift,
          beltPhase: side.beltPhase,
          beltVelocity: side.beltVelocity,
          groupY: side.group.position.y,
          wheelRotation: side.wheelRotation,
        })),
      };
    case 'amphibian':
      return {
        type: 'amphibian',
        contact: captureRollingContact(locomotion.contact),
        waterBlend: locomotion.waterBlend,
        hingeQuaternions: locomotion.panels.map((panel) => quaternionTuple(panel.hinge)),
      };
    case 'drone':
      return { type: 'drone', clearance: locomotion.clearance };
    case 'plane':
    case 'aerosub':
      return { type: locomotion.type };
    case 'submarine':
      return {
        type: 'submarine',
        contact: captureRollingContact(locomotion.contact),
        hingeQuaternions: locomotion.pectoralHinges.map(quaternionTuple),
      };
  }
}

/** Restore presentation state onto a newly built geometry tier. */
export function applyLocomotionState(
  locomotion: Locomotion3DMesh,
  snapshot: LocomotionStateSnapshot | undefined,
): void {
  if (!locomotion || snapshot === undefined || locomotion.type !== snapshot.type) return;
  switch (locomotion.type) {
    case 'crawler': {
      const state = snapshot as Extract<LocomotionStateSnapshot, { type: 'crawler' }>;
      applyLegStateImpl(locomotion, state.legs);
      locomotion.visualGrounded = state.visualGrounded;
      locomotion.poseInitialized = state.poseInitialized;
      locomotion.lastBaseX = state.lastBaseX;
      locomotion.lastBaseY = state.lastBaseY;
      locomotion.lastBaseZ = state.lastBaseZ;
      return;
    }
    case 'bot': {
      const state = snapshot as Extract<LocomotionStateSnapshot, { type: 'bot' }>;
      applyRollingContact(locomotion.contact, state.contact);
      locomotion.gaitPhase = state.gaitPhase;
      locomotion.gaitDirection = state.gaitDirection;
      locomotion.gait = state.gait;
      locomotion.upperBodyYaw = state.upperBodyYaw;
      locomotion.upperBodyWorldYaw = state.upperBodyWorldYaw;
      locomotion.upperBodyYawVelocity = state.upperBodyYawVelocity;
      locomotion.hips.rotation.y = -locomotion.upperBodyYaw;
      return;
    }
    case 'rover': {
      const state = snapshot as Extract<LocomotionStateSnapshot, { type: 'rover' }>;
      for (let i = 0; i < locomotion.wheelContacts.length; i++) {
        applyRollingContact(locomotion.wheelContacts[i], state.contacts[i]);
      }
      for (let i = 0; i < locomotion.wheelMounts.length; i++) {
        const saved = state.mounts[i];
        if (!saved) continue;
        const mount = locomotion.wheelMounts[i];
        mount.lift = saved.lift;
        mount.targetLift = saved.targetLift;
        mount.angularVelocity = saved.angularVelocity;
        mount.rotation = state.rotations[i] ?? 0;
        locomotion.wheelGroups[i].position.y = mount.wheelR + mount.lift;
        locomotion.wheels[i].rotation.y = locomotion.rotationAnimated
          ? mount.rotation
          : 0;
      }
      return;
    }
    case 'tank': {
      const state = snapshot as Extract<LocomotionStateSnapshot, { type: 'tank' }>;
      for (let i = 0; i < locomotion.treadContacts.length; i++) {
        applyRollingContact(locomotion.treadContacts[i], state.contacts[i]);
      }
      for (let i = 0; i < locomotion.sides.length; i++) {
        const saved = state.sides[i];
        if (!saved) continue;
        const side = locomotion.sides[i];
        side.lift = saved.lift;
        side.targetLift = saved.targetLift;
        side.beltPhase = saved.beltPhase;
        side.beltVelocity = saved.beltVelocity;
        side.wheelRotation = saved.wheelRotation;
        side.group.position.y = saved.groupY;
      }
      for (let i = 0; i < locomotion.wheels.length; i++) {
        locomotion.wheels[i].rotation.y = locomotion.sides[locomotion.wheelSide[i]]?.wheelRotation ?? 0;
      }
      return;
    }
    case 'amphibian': {
      const state = snapshot as Extract<LocomotionStateSnapshot, { type: 'amphibian' }>;
      applyRollingContact(locomotion.contact, state.contact);
      locomotion.waterBlend = state.waterBlend;
      for (let i = 0; i < locomotion.panels.length; i++) {
        const q = state.hingeQuaternions[i];
        if (q) locomotion.panels[i].hinge.quaternion.set(q[0], q[1], q[2], q[3]);
      }
      return;
    }
    case 'drone':
      locomotion.clearance = (snapshot as Extract<LocomotionStateSnapshot, { type: 'drone' }>).clearance;
      return;
    case 'plane':
    case 'aerosub':
      return;
    case 'submarine': {
      const state = snapshot as Extract<LocomotionStateSnapshot, { type: 'submarine' }>;
      applyRollingContact(locomotion.contact, state.contact);
      const hinges: THREE.Object3D[] = [...locomotion.pectoralHinges];
      for (let i = 0; i < hinges.length; i++) {
        const q = state.hingeQuaternions[i];
        if (q) hinges[i].quaternion.set(q[0], q[1], q[2], q[3]);
      }
      return;
    }
  }
}

export type AirborneEmitterUpdate3D = {
  batch: AirborneEmitterBatch3D;
  pose: AirborneEmitterParentPose3D;
};

/** Vertical offset (world units) by which the unit's BODY (chassis,
 *  turrets, mirrors, shield) sits above the ground plane.
 *
 *  Runtime rule: the unit blueprint's `supportPointOffsetZ` is the hard
 *  source of truth. Chassis lift is derived from it so visual body
 *  center, sim center, turret mounts, and locomotion attachment all
 *  live in the same terrain-up coordinate system.
 *
 *  Returned in WORLD UNITS — used as `liftGroup.position.y` in
 *  Render3DEntities. */
export function getChassisLift(blueprint: UnitBlueprint, unitRadius: number): number {
  return getChassisLiftY(blueprint, unitRadius);
}

function geometryKeyFor(gfx: GraphicsConfig): string {
  return gfx.legs;
}

function droneSmokeUseId(unitBlueprintId: string): DroneSmokeUseId {
  if (unitBlueprintId === 'unitAlbatros') return 'locomotionAlbatrosDroneFans';
  if (unitBlueprintId === 'unitDragonfly') return 'locomotionDragonflyDrone';
  return 'locomotionDuctedFan';
}

function airframeSmokeUseId(unitBlueprintId: string): AirframeSmokeUseId {
  if (unitBlueprintId === 'unitAlbatros') return 'locomotionAlbatrosAerosub';
  return 'locomotionEaglePlane';
}

/** Capture per-leg state from a legged locomotion mesh into a plain
 *  array of POJOs the caller can stash across a tear-down/rebuild.
 *  Returns `undefined` for non-legged units (treads/wheels/none) so
 *  the caller can `if (snap)` cheaply. */
export function captureLegState(loc: Locomotion3DMesh): LegStateSnapshot | undefined {
  if (!loc || loc.type !== 'crawler') return undefined;
  return captureLegStateImpl(loc);
}

/** Pour a captured snapshot back into a freshly-built legged mesh.
 *  No-op for non-legged units. */
export function applyLegState(loc: Locomotion3DMesh, snapshot: LegStateSnapshot): void {
  if (!loc || loc.type !== 'crawler') return;
  applyLegStateImpl(loc, snapshot);
}

export function buildLocomotion(
  unitGroup: THREE.Group,
  airborneUnitGroup: THREE.Group,
  airborneLiftY: number,
  worldGroup: THREE.Group,
  entity: Entity,
  unitRadius: number,
  ownerId: PlayerId | undefined,
  gfx: GraphicsConfig,
  detailLevel: number,
  legRenderer: LegInstancedRenderer,
): Locomotion3DMesh {
  if (!entity.unit) return undefined;
  let bp;
  try {
    bp = getUnitBlueprint(entity.unit.unitBlueprintId);
  } catch {
    return undefined;
  }
  const loc = bp.unitLocomotion;
  if (!loc) return undefined;
  if (!featureVisibleAtDetail('locomotion', detailLevel)) return undefined;

  const geometryKey = geometryKeyFor(gfx);
  const geometryTier = geometryTierForDetail(detailLevel);

  switch (loc.type) {
    case 'tank':
    case 'amphibious-tank': {
      const mesh = buildTank(
        unitGroup,
        unitRadius,
        loc.config,
        featureVisibleAtDetail('treadCleats', detailLevel),
        ownerId,
        geometryTier,
      );
      mesh.geometryKey = geometryKey;
      return mesh;
    }
    case 'rover': {
      const mesh = buildRover(
        unitGroup, unitRadius, loc.config, ownerId, geometryTier,
      );
      mesh.geometryKey = geometryKey;
      return mesh;
    }
    case 'crawler': {
      const chassisLiftY = getChassisLift(bp, unitRadius);
      const mesh = buildCrawler(
        worldGroup, unitRadius, loc.config,
        gfx.legs, chassisLiftY,
        legRenderer, ownerId,
        geometryTier,
        // Every walker's legs, not one blueprint's. A leg segment is a
        // hydraulic strut and a knuckle is a bolt boss whichever unit is
        // standing on it, so the chart comes from the ROLE — see the roster
        // assignment table in SurfaceChart3D.
        LEG_CHARTS,
      );
      if (mesh) mesh.geometryKey = geometryKey;
      return mesh;
    }
    case 'bot': {
      const mesh = buildBotRig(
        // The bot rig poses against the lifted root, so it must share
        // that root. Parenting it to the unlifted yaw group displaced every
        // limb by the chassis lift (eleven world units on Human).
        airborneUnitGroup, unitRadius, bp.mass,
        loc.physics.ground.maxPropulsiveForce,
        loc.config.legs, loc.config.arms,
        getChassisLift(bp, unitRadius), ownerId, geometryTier,
        bp.unitBlueprintId,
      );
      poseBotRigAtRest(mesh);
      mesh.geometryKey = geometryKey;
      return mesh;
    }
    case 'amphibian': {
      const mesh = buildAmphibian(
        unitGroup, unitRadius, loc.config, ownerId, geometryTier,
      );
      mesh.geometryKey = geometryKey;
      return mesh;
    }
    case 'drone': {
      const mesh = buildDroneFans(
        airborneUnitGroup,
        unitRadius,
        loc.config,
        droneSmokeUseId(bp.unitBlueprintId),
        entity.id,
        ownerId,
        geometryTier,
      );
      // Drone mounts remain authoritative blueprint data. Only their rendered
      // array is translated to an overhead plane, high enough that even a
      // tilted duct clears the visible body. The array remains a lift-group
      // child so it banks with the chassis it is visibly attached to.
      mesh.visualBaseY = getDroneFanVisualRootY(
        getBodyTopY(bp.bodyShape, unitRadius),
        unitRadius,
        loc.config,
      );
      mesh.group.position.y = mesh.visualBaseY;
      mesh.geometryKey = geometryKey;
      return mesh;
    }
    case 'plane':
    case 'aerosub': {
      const mesh = buildAirframeRig(
        airborneUnitGroup,
        unitRadius,
        loc.type,
        loc.config,
        airframeSmokeUseId(bp.unitBlueprintId),
        entity.id,
        ownerId,
        geometryTier,
      );
      mesh.group.position.y -= airborneLiftY;
      mesh.geometryKey = geometryKey;
      return mesh;
    }
    case 'submarine': {
      const mesh = buildSubmarineRig(
        unitGroup, unitRadius, loc.config, ownerId, geometryTier, entity.id,
      );
      mesh.geometryKey = geometryKey;
      return mesh;
    }
  }
}

/** Per-frame update — drives wheels/treads from per-contact ground
 *  motion, and advances each leg's snap-lerp physics + IK. Returns
 *  true while this rig needs another visual frame without an external
 *  render dirty waking it. */
export function updateLocomotion(
  mesh: Locomotion3DMesh,
  entity: Entity,
  pose: LocomotionRenderPose,
  dtMs: number,
  mapWidth: number,
  mapHeight: number,
  legRenderer: LegInstancedRenderer,
  locomotionSmokeEmitters?: SmokePuffEmitter[],
  airborneEmitters?: AirborneEmitterUpdate3D,
): boolean {
  if (!mesh) return false;
  switch (mesh.type) {
    case 'rover':
      return updateRover(mesh, entity, pose, dtMs, mapWidth, mapHeight);
    case 'tank':
      return updateTank(mesh, entity, pose, dtMs, mapWidth, mapHeight);
    case 'crawler':
      return updateCrawler(mesh, entity, pose, dtMs, mapWidth, mapHeight, legRenderer);
    case 'bot':
      return updateBotRig(mesh, entity, pose, dtMs);
    case 'amphibian':
      return updateAmphibian(mesh, pose, dtMs);
    case 'drone':
      return updateDroneFans(
        mesh,
        entity,
        dtMs,
        mapWidth,
        mapHeight,
        locomotionSmokeEmitters,
        airborneEmitters?.batch,
        airborneEmitters?.pose,
      );
    case 'plane':
    case 'aerosub':
      return updateAirframeRig(
        mesh,
        entity,
        dtMs,
        locomotionSmokeEmitters,
        airborneEmitters?.batch,
        airborneEmitters?.pose,
      );
    case 'submarine':
      return updateSubmarineRig(mesh, pose, dtMs, locomotionSmokeEmitters);
  }
}

export function fadeLocomotion(
  mesh: Locomotion3DMesh,
  fade: number,
  legRenderer: LegInstancedRenderer,
): void {
  if (!mesh || mesh.type !== 'crawler') return;
  fadeLegSlots(mesh, legRenderer, fade);
}

export function destroyLocomotion(
  mesh: Locomotion3DMesh,
  legRenderer: LegInstancedRenderer,
): void {
  if (!mesh) return;
  // Free every leg slot (cylinder + joint + foot pad) back into the
  // shared pools so other units can reuse them. Treads / wheels just
  // drop their group from the scene graph.
  if (mesh.type === 'crawler') {
    freeLegSlots(mesh, legRenderer);
  }
  mesh.group.parent?.remove(mesh.group);
}
