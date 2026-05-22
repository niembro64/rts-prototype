import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
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
  return pid !== undefined ? getPlayerColors(pid).primary : COLORS.units.neutral.colorHex;
}

export function turretAccentColorHexForPlayer(playerId: number | undefined): number {
  const primary = playerId !== undefined
    ? getPlayerColors(playerId).primary
    : COLORS.units.neutral.colorHex;
  return blendHexTowardWhite(primary, 0.5);
}

export function entityTurretAccentColorHex(entity: Entity): number {
  if (isConstructionShell(entity)) return SHELL_PALE_HEX;
  return turretAccentColorHexForPlayer(entity.ownership?.playerId);
}

export function setEntityInstanceColor(
  mesh: THREE.InstancedMesh,
  slot: number,
  entity: Entity,
  scratchColor: THREE.Color,
): void {
  mesh.setColorAt(slot, scratchColor.set(entityInstanceColorHex(entity)));
}

/** Lerp an RGB hex toward white by `t` in [0,1]. t=0 returns the input
 *  unchanged; t=1 returns pure white. Pure integer math, no allocation
 *  — safe to call per-frame from instance writers. */
export function blendHexTowardWhite(hex: number, t: number): number {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  const br = Math.round(r + (255 - r) * t);
  const bg = Math.round(g + (255 - g) * t);
  const bb = Math.round(b + (255 - b) * t);
  return (br << 16) | (bg << 8) | bb;
}
