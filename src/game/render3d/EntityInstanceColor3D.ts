import * as THREE from 'three';
import { SHELL_PALE_HEX } from '@/shellConfig';
import type { Entity } from '../sim/types';
import { getPlayerColors } from '../sim/types';

export function isConstructionShell(entity: Entity): boolean {
  return !!(entity.buildable && !entity.buildable.isComplete && !entity.buildable.isGhost);
}

export function entityInstanceColorKey(entity: Entity): number {
  const ownerKey = entity.ownership?.playerId ?? -1;
  return ownerKey * 2 + (isConstructionShell(entity) ? 1 : 0);
}

export function entityInstanceColorHex(entity: Entity): number {
  if (isConstructionShell(entity)) return SHELL_PALE_HEX;
  const pid = entity.ownership?.playerId;
  return pid !== undefined ? getPlayerColors(pid).primary : 0x888888;
}

export function setEntityInstanceColor(
  mesh: THREE.InstancedMesh,
  slot: number,
  entity: Entity,
  scratchColor: THREE.Color,
): void {
  mesh.setColorAt(slot, scratchColor.set(entityInstanceColorHex(entity)));
}
