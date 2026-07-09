import { deterministicMath as DMath } from '@/game/sim/deterministicMath';
import type { Entity, EntityHold, EntityHoldKind } from './types';
import { getUnitBodyCenterHeight, getUnitGroundZ } from './unitGeometry';
import type { WorldState } from './WorldState';

export type EntityHoldSpec = {
  kind: EntityHoldKind;
  slotIndex: number;
  localOffsetX: number;
  localOffsetY: number;
  localBaseZ: number;
  rotateWithHolder: boolean;
  inheritHolderRotation: boolean;
  worldRotation?: number | null;
  inheritHolderVelocity: boolean;
};

export type EntityHoldPose = {
  x: number;
  y: number;
  z: number;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  rotation: number;
};

export function holdEntity(holder: Entity, held: Entity, spec: EntityHoldSpec): EntityHold {
  const hold: EntityHold = {
    kind: spec.kind,
    holderId: holder.id,
    slotIndex: spec.slotIndex,
    localOffsetX: spec.localOffsetX,
    localOffsetY: spec.localOffsetY,
    localBaseZ: spec.localBaseZ,
    rotateWithHolder: spec.rotateWithHolder,
    inheritHolderRotation: spec.inheritHolderRotation,
    worldRotation: spec.worldRotation ?? null,
    inheritHolderVelocity: spec.inheritHolderVelocity,
  };
  held.heldBy = hold;
  return hold;
}

export function releaseEntityHold(held: Entity): void {
  held.heldBy = null;
}

export function resolveEntityHoldPose(
  world: Pick<WorldState, 'getEntity'>,
  held: Entity,
  out?: EntityHoldPose,
): EntityHoldPose | null {
  const hold = held.heldBy;
  if (hold === null) return null;
  const holder = world.getEntity(hold.holderId);
  if (holder === undefined) return null;

  let offsetX = hold.localOffsetX;
  let offsetY = hold.localOffsetY;
  if (hold.rotateWithHolder) {
    const cos = holder.transform.rotCos ?? DMath.cos(holder.transform.rotation);
    const sin = holder.transform.rotSin ?? DMath.sin(holder.transform.rotation);
    const rotatedX = cos * hold.localOffsetX - sin * hold.localOffsetY;
    const rotatedY = sin * hold.localOffsetX + cos * hold.localOffsetY;
    offsetX = rotatedX;
    offsetY = rotatedY;
  }

  const heldCenterOffsetZ = held.unit !== null
    ? getUnitBodyCenterHeight(held.unit)
    : held.building !== null
      ? held.building.depth / 2
      : 0;
  const pose = out ?? {
    x: 0,
    y: 0,
    z: 0,
    velocityX: 0,
    velocityY: 0,
    velocityZ: 0,
    rotation: 0,
  };
  pose.x = holder.transform.x + offsetX;
  pose.y = holder.transform.y + offsetY;
  pose.z = getUnitGroundZ(holder) + hold.localBaseZ + heldCenterOffsetZ;
  pose.rotation = hold.worldRotation !== null
    ? hold.worldRotation
    : hold.inheritHolderRotation ? holder.transform.rotation : held.transform.rotation;

  if (hold.inheritHolderVelocity && holder.unit !== null) {
    pose.velocityX = holder.unit.velocityX;
    pose.velocityY = holder.unit.velocityY;
    pose.velocityZ = holder.unit.velocityZ;
  } else {
    pose.velocityX = 0;
    pose.velocityY = 0;
    pose.velocityZ = 0;
  }
  return pose;
}

export function applyEntityHoldPose(world: Pick<WorldState, 'getEntity'>, held: Entity): boolean {
  const pose = resolveEntityHoldPose(world, held);
  if (pose === null) return false;
  held.transform.x = pose.x;
  held.transform.y = pose.y;
  held.transform.z = pose.z;
  held.transform.rotation = pose.rotation;
  held.transform.rotCos = null;
  held.transform.rotSin = null;
  if (held.unit !== null) {
    held.unit.velocityX = pose.velocityX;
    held.unit.velocityY = pose.velocityY;
    held.unit.velocityZ = pose.velocityZ;
  }
  return true;
}
