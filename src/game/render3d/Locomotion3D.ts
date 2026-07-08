// Locomotion3D — thin dispatcher over the per-locomotion-type rig
// modules (LegRig3D, TreadRig3D, WheelRig3D, HoverRig3D). Each rig owns its build,
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
import type { SmokePuffEmitter } from './SmokeTrail3D';
import type { FlyingSmokeUseId, HoverSmokeUseId } from '@/smokeConfig';
import type {
  AirborneEmitterBatch3D,
  AirborneEmitterParentPose3D,
} from './AirborneEmitterBatch3D';
import { featureVisibleAtDetail } from './EntityDetailLevel3D';

export type Locomotion3DMesh =
  | TreadMesh
  | WheelMesh
  | LegMesh
  | HoverMesh
  | FlyingMesh
  | undefined;

export type { LegStateSnapshot };
export { setHoverFanAnimationTime };

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
  worldGroup: THREE.Group,
  entity: Entity,
  unitRadius: number,
  ownerId: PlayerId | undefined,
  gfx: GraphicsConfig,
  detailLevel: number,
  mapWidth: number,
  mapHeight: number,
  legRenderer: LegInstancedRenderer,
): Locomotion3DMesh {
  if (!entity.unit) return undefined;
  let bp;
  try {
    bp = getUnitBlueprint(entity.unit.unitBlueprintId);
  } catch {
    return undefined;
  }
  const loc = bp.locomotion;
  if (!loc) return undefined;
  if (!featureVisibleAtDetail('locomotion', detailLevel)) return undefined;

  const geometryKey = geometryKeyFor(gfx);

  switch (loc.type) {
    case 'treads': {
      const mesh = buildTreads(unitGroup, unitRadius, loc.config, gfx.treadsAnimated, ownerId);
      mesh.geometryKey = geometryKey;
      return mesh;
    }
    case 'wheels': {
      const mesh = buildWheels(unitGroup, unitRadius, loc.config, ownerId);
      mesh.geometryKey = geometryKey;
      return mesh;
    }
    case 'legs': {
      const chassisLiftY = getChassisLift(bp, unitRadius);
      const mesh = buildLegs(
        worldGroup, entity, unitRadius, loc.config,
        gfx.legs, bp.bodyShape, chassisLiftY, bp.legAttachHeightFrac,
        mapWidth, mapHeight, legRenderer, ownerId,
      );
      if (mesh) mesh.geometryKey = geometryKey;
      return mesh;
    }
    case 'hover': {
      const buildHoverMesh = bp.unitBlueprintId === 'unitAlbatros'
        ? buildAlbatrosHoverFans
        : buildHoverFans;
      const mesh = buildHoverMesh(
        unitGroup,
        unitRadius,
        loc.config,
        hoverSmokeUseId(bp.unitBlueprintId),
        entity.id,
        ownerId,
      );
      mesh.geometryKey = geometryKey;
      return mesh;
    }
    case 'flying': {
      const mesh = buildFlyingRig(
        unitGroup,
        unitRadius,
        loc.config,
        flyingSmokeUseId(bp.unitBlueprintId),
        entity.id,
        ownerId,
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
      return updateWheels(mesh, entity, dtMs, mapWidth, mapHeight);
    case 'treads':
      return updateTreads(mesh, entity, dtMs, mapWidth, mapHeight);
    case 'legs':
      return updateLegs(mesh, entity, dtMs, mapWidth, mapHeight, legRenderer);
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
