// Locomotion3D — thin dispatcher over the per-locomotion-type rig
// modules (LegRig3D, FlipperRig3D, TreadRig3D, WheelRig3D, HoverRig3D,
// FlyingRig3D, SwimRig3D). Each rig owns its build,
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
import { getChassisLiftY } from '../math/BodyDimensions';
import type { LegInstancedRenderer } from './LegInstancedRenderer';
import {
  type LegMesh,
  type LegStateSnapshot,
  applyLegState as applyLegStateImpl,
  buildLegs,
  captureLegState as captureLegStateImpl,
  fadeLegSlots,
  freeLegSlots,
  translateLegSlots,
  updateLegs,
} from './LegRig3D';
import {
  type TreadMesh,
  buildTreads,
  updateTreads,
} from './TreadRig3D';
import {
  type WheelMesh,
  buildWheels,
  updateWheels,
} from './WheelRig3D';
import {
  type HoverMesh,
  buildAlbatrosHoverFans,
  buildHoverFans,
  setHoverFanAnimationTime,
  updateHoverFans,
} from './HoverRig3D';
import {
  type FlyingMesh,
  buildFlyingRig,
  updateFlyingRig,
} from './FlyingRig3D';
import {
  type FlipperMesh,
  buildFlippers,
  updateFlippers,
} from './FlipperRig3D';
import {
  type SwimMesh,
  buildSwimRig,
  updateSwimRig,
} from './SwimRig3D';
import type { SmokePuffEmitter } from './SmokeTrail3D';
import type { FlyingSmokeUseId, HoverSmokeUseId } from '@/smokeConfig';
import type {
  AirborneEmitterBatch3D,
  AirborneEmitterParentPose3D,
} from './AirborneEmitterBatch3D';
import { featureVisibleAtDetail, geometryTierForDetail } from './EntityDetailLevel3D';
import type { LocomotionRenderPose } from './LocomotionRigShared3D';
import type { RollingContactState } from './LocomotionRigShared3D';

export type Locomotion3DMesh =
  | TreadMesh
  | WheelMesh
  | LegMesh
  | FlipperMesh
  | HoverMesh
  | FlyingMesh
  | SwimMesh
  | undefined;

export type { LegStateSnapshot };
export { setHoverFanAnimationTime };

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
      type: 'legs';
      legs: LegStateSnapshot;
      visualGrounded: boolean;
      poseInitialized: boolean;
      lastBaseX: number;
      lastBaseY: number;
      lastBaseZ: number;
    }
  | {
      type: 'wheels';
      contacts: RollingContactSnapshot[];
      mounts: Array<Readonly<{ lift: number; targetLift: number; angularVelocity: number }>>;
      rotations: number[];
    }
  | {
      type: 'treads';
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
      type: 'flippers';
      contact: RollingContactSnapshot;
      waterBlend: number;
      hingeQuaternions: Array<readonly [number, number, number, number]>;
    }
  | { type: 'hover'; clearance: number }
  | { type: 'flying' }
  | {
      type: 'swim';
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
    case 'legs':
      return {
        type: 'legs',
        legs: captureLegStateImpl(locomotion),
        visualGrounded: locomotion.visualGrounded,
        poseInitialized: locomotion.poseInitialized,
        lastBaseX: locomotion.lastBaseX,
        lastBaseY: locomotion.lastBaseY,
        lastBaseZ: locomotion.lastBaseZ,
      };
    case 'wheels':
      return {
        type: 'wheels',
        contacts: locomotion.wheelContacts.map(captureRollingContact),
        mounts: locomotion.wheelMounts.map((mount) => ({
          lift: mount.lift,
          targetLift: mount.targetLift,
          angularVelocity: mount.angularVelocity,
        })),
        rotations: locomotion.wheelMounts.map((mount) => mount.rotation),
      };
    case 'treads':
      return {
        type: 'treads',
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
    case 'flippers':
      return {
        type: 'flippers',
        contact: captureRollingContact(locomotion.contact),
        waterBlend: locomotion.waterBlend,
        hingeQuaternions: locomotion.panels.map((panel) => quaternionTuple(panel.hinge)),
      };
    case 'hover':
      return { type: 'hover', clearance: locomotion.clearance };
    case 'flying':
      return { type: 'flying' };
    case 'swim':
      return {
        type: 'swim',
        contact: captureRollingContact(locomotion.contact),
        hingeQuaternions: [
          ...locomotion.pectoralHinges.map(quaternionTuple),
          quaternionTuple(locomotion.tailHinge),
        ],
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
    case 'legs': {
      const state = snapshot as Extract<LocomotionStateSnapshot, { type: 'legs' }>;
      applyLegStateImpl(locomotion, state.legs);
      locomotion.visualGrounded = state.visualGrounded;
      locomotion.poseInitialized = state.poseInitialized;
      locomotion.lastBaseX = state.lastBaseX;
      locomotion.lastBaseY = state.lastBaseY;
      locomotion.lastBaseZ = state.lastBaseZ;
      return;
    }
    case 'wheels': {
      const state = snapshot as Extract<LocomotionStateSnapshot, { type: 'wheels' }>;
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
    case 'treads': {
      const state = snapshot as Extract<LocomotionStateSnapshot, { type: 'treads' }>;
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
    case 'flippers': {
      const state = snapshot as Extract<LocomotionStateSnapshot, { type: 'flippers' }>;
      applyRollingContact(locomotion.contact, state.contact);
      locomotion.waterBlend = state.waterBlend;
      for (let i = 0; i < locomotion.panels.length; i++) {
        const q = state.hingeQuaternions[i];
        if (q) locomotion.panels[i].hinge.quaternion.set(q[0], q[1], q[2], q[3]);
      }
      return;
    }
    case 'hover':
      locomotion.clearance = (snapshot as Extract<LocomotionStateSnapshot, { type: 'hover' }>).clearance;
      return;
    case 'flying':
      return;
    case 'swim': {
      const state = snapshot as Extract<LocomotionStateSnapshot, { type: 'swim' }>;
      applyRollingContact(locomotion.contact, state.contact);
      const hinges: THREE.Object3D[] = [...locomotion.pectoralHinges, locomotion.tailHinge];
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
 *  Runtime rule: the unit blueprint's `bodyCenterHeight` is the hard
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
  return `${gfx.legs}|${gfx.treadsAnimated ? 1 : 0}`;
}

function hoverSmokeUseId(unitBlueprintId: string): HoverSmokeUseId {
  if (unitBlueprintId === 'unitAlbatros') return 'locomotionAlbatrosHoverFans';
  if (unitBlueprintId === 'unitDragonfly') return 'locomotionDragonflyHovercraft';
  return 'locomotionHovercraft';
}

function flyingSmokeUseId(unitBlueprintId: string): FlyingSmokeUseId {
  if (unitBlueprintId === 'unitAlbatros') return 'locomotionAlbatrosFlying';
  return 'locomotionEagleFlying';
}

/** Capture per-leg state from a legged locomotion mesh into a plain
 *  array of POJOs the caller can stash across a tear-down/rebuild.
 *  Returns `undefined` for non-legged units (treads/wheels/none) so
 *  the caller can `if (snap)` cheaply. */
export function captureLegState(loc: Locomotion3DMesh): LegStateSnapshot | undefined {
  if (!loc || loc.type !== 'legs') return undefined;
  return captureLegStateImpl(loc);
}

/** Pour a captured snapshot back into a freshly-built legged mesh.
 *  No-op for non-legged units. */
export function applyLegState(loc: Locomotion3DMesh, snapshot: LegStateSnapshot): void {
  if (!loc || loc.type !== 'legs') return;
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
    case 'treads':
    case 'amphibious-treads': {
      const mesh = buildTreads(
        unitGroup, unitRadius, loc.config, gfx.treadsAnimated, ownerId, geometryTier,
      );
      mesh.geometryKey = geometryKey;
      return mesh;
    }
    case 'wheels': {
      const mesh = buildWheels(
        unitGroup, unitRadius, loc.config, ownerId, geometryTier,
      );
      mesh.geometryKey = geometryKey;
      return mesh;
    }
    case 'legs': {
      const chassisLiftY = getChassisLift(bp, unitRadius);
      const mesh = buildLegs(
        worldGroup, unitRadius, loc.config,
        gfx.legs, bp.bodyShape, chassisLiftY, bp.legAttachHeightFrac,
        legRenderer, ownerId,
        geometryTier,
      );
      if (mesh) mesh.geometryKey = geometryKey;
      return mesh;
    }
    case 'flippers': {
      const mesh = buildFlippers(
        unitGroup, unitRadius, loc.config, ownerId, geometryTier,
      );
      mesh.geometryKey = geometryKey;
      return mesh;
    }
    case 'hover': {
      const buildHoverMesh = bp.unitBlueprintId === 'unitAlbatros'
        ? buildAlbatrosHoverFans
        : buildHoverFans;
      const mesh = buildHoverMesh(
        airborneUnitGroup,
        unitRadius,
        loc.config,
        hoverSmokeUseId(bp.unitBlueprintId),
        entity.id,
        ownerId,
        geometryTier,
      );
      // Preserve the existing no-bank world pose while making the rig a
      // child of the body-center roll pivot. The lift group supplies
      // T(center) · R(bank); this offset supplies T(-center).
      mesh.group.position.y -= airborneLiftY;
      mesh.geometryKey = geometryKey;
      return mesh;
    }
    case 'flying':
    case 'dive': {
      const mesh = buildFlyingRig(
        airborneUnitGroup,
        unitRadius,
        loc.config,
        flyingSmokeUseId(bp.unitBlueprintId),
        entity.id,
        ownerId,
        geometryTier,
      );
      mesh.group.position.y -= airborneLiftY;
      mesh.geometryKey = geometryKey;
      return mesh;
    }
    case 'submarine': {
      const mesh = buildSwimRig(
        unitGroup, unitRadius, loc.config, ownerId, geometryTier,
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
  hoverSmokeEmitters?: SmokePuffEmitter[],
  airborneEmitters?: AirborneEmitterUpdate3D,
): boolean {
  if (!mesh) return false;
  switch (mesh.type) {
    case 'wheels':
      return updateWheels(mesh, entity, pose, dtMs, mapWidth, mapHeight);
    case 'treads':
      return updateTreads(mesh, entity, pose, dtMs, mapWidth, mapHeight);
    case 'legs':
      return updateLegs(mesh, entity, pose, dtMs, mapWidth, mapHeight, legRenderer);
    case 'flippers':
      return updateFlippers(mesh, pose, dtMs);
    case 'hover':
      return updateHoverFans(
        mesh,
        entity,
        dtMs,
        mapWidth,
        mapHeight,
        hoverSmokeEmitters,
        airborneEmitters?.batch,
        airborneEmitters?.pose,
      );
    case 'flying':
      return updateFlyingRig(
        mesh,
        entity,
        dtMs,
        hoverSmokeEmitters,
        airborneEmitters?.batch,
        airborneEmitters?.pose,
      );
    case 'swim':
      return updateSwimRig(mesh, pose, dtMs);
  }
}

export function fadeLocomotion(
  mesh: Locomotion3DMesh,
  fade: number,
  legRenderer: LegInstancedRenderer,
): void {
  if (!mesh || mesh.type !== 'legs') return;
  fadeLegSlots(mesh, legRenderer, fade);
}

export function translateLocomotion(
  mesh: Locomotion3DMesh,
  dx: number,
  dy: number,
  dz: number,
  legRenderer: LegInstancedRenderer,
): void {
  if (!mesh || mesh.type !== 'legs') return;
  translateLegSlots(mesh, legRenderer, dx, dy, dz);
}

export function destroyLocomotion(
  mesh: Locomotion3DMesh,
  legRenderer: LegInstancedRenderer,
): void {
  if (!mesh) return;
  // Free every leg slot (cylinder + joint + foot pad) back into the
  // shared pools so other units can reuse them. Treads / wheels just
  // drop their group from the scene graph.
  if (mesh.type === 'legs') {
    freeLegSlots(mesh, legRenderer);
  }
  mesh.group.parent?.remove(mesh.group);
}
