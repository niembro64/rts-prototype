// Locomotion3D — thin dispatcher over the per-locomotion-type rig
// modules (LegRig3D, TreadRig3D, WheelRig3D). Each rig owns its build,
// update, and (for legs) state-snapshot logic. This file only:
//   - exposes the discriminated `Locomotion3DMesh` union,
//   - dispatches to the correct rig at build / update / destroy time,
//   - resolves chassis-lift from the unit blueprint,
//   - re-exports the leg LOD-snapshot helpers and TREAD_HEIGHT for
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
  freeLegSlots,
  updateLegs,
} from './LegRig3D';
import {
  type TreadMesh,
  TREAD_HEIGHT,
  buildTreads,
  updateTreads,
} from './TreadRig3D';
import {
  type WheelMesh,
  buildWheels,
  updateWheels,
} from './WheelRig3D';

export type Locomotion3DMesh = TreadMesh | WheelMesh | LegMesh | undefined;

export type { LegStateSnapshot };
export { TREAD_HEIGHT };

/** Vertical offset (world units) by which the unit's BODY (chassis,
 *  turrets, mirrors, force-field) sits above the ground plane.
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

export function lodKeyFor(gfx: GraphicsConfig): string {
  return `${gfx.legs}|${gfx.treadsAnimated ? 1 : 0}`;
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
  _pid: PlayerId | undefined,
  gfx: GraphicsConfig,
  mapWidth: number,
  mapHeight: number,
  legRenderer: LegInstancedRenderer,
): Locomotion3DMesh {
  if (!entity.unit) return undefined;
  let bp;
  try {
    bp = getUnitBlueprint(entity.unit.unitType);
  } catch {
    return undefined;
  }
  const loc = bp.locomotion;
  if (!loc) return undefined;

  const lodKey = lodKeyFor(gfx);

  switch (loc.type) {
    case 'treads': {
      const mesh = buildTreads(unitGroup, unitRadius, loc.config, gfx.treadsAnimated);
      mesh.lodKey = lodKey;
      return mesh;
    }
    case 'wheels': {
      const mesh = buildWheels(unitGroup, unitRadius, loc.config);
      mesh.lodKey = lodKey;
      return mesh;
    }
    case 'legs': {
      const chassisLiftY = getChassisLift(bp, unitRadius);
      const mesh = buildLegs(
        worldGroup, entity, unitRadius, loc.config,
        gfx.legs, bp.bodyShape, chassisLiftY, bp.legAttachHeightFrac,
        mapWidth, mapHeight, legRenderer,
      );
      if (mesh) mesh.lodKey = lodKey;
      return mesh;
    }
  }
}

/** Per-frame update — drives wheels/treads from per-contact ground
 *  motion, and advances each leg's snap-lerp physics + IK. */
export function updateLocomotion(
  mesh: Locomotion3DMesh,
  entity: Entity,
  dtMs: number,
  mapWidth: number,
  mapHeight: number,
  legRenderer: LegInstancedRenderer,
): void {
  if (!mesh) return;
  switch (mesh.type) {
    case 'wheels':
      updateWheels(mesh, entity);
      return;
    case 'treads':
      updateTreads(mesh, entity);
      return;
    case 'legs':
      updateLegs(mesh, entity, dtMs, mapWidth, mapHeight, legRenderer);
      return;
  }
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
