import { COLORS } from '@/colorsConfig';
import type { Entity, Turret, TurretState } from '../sim/types';
import { getPlayerColors } from '../sim/types';
import { CLIENT_RENDER_TURRET_STATE_ENGAGED } from './ClientRenderTurretStateSlab';

const SHIELD_SPHERE_TURRET_PULSE_PERIOD_MS = 900;

export function entityInstanceColorKey(entity: Entity): number {
  return entity.ownership?.playerId ?? -1;
}

export function entityInstanceColorHex(entity: Entity): number {
  const pid = entity.ownership?.playerId;
  return entityInstanceColorHexForPlayer(pid);
}

export function entityInstanceColorHexForPlayer(pid: number | undefined): number {
  return pid !== undefined ? getPlayerColors(pid).primary : COLORS.units.neutral.colorHex;
}

export function turretAccentColorHexForPlayer(playerId: number | undefined): number {
  const primary = playerId !== undefined
    ? getPlayerColors(playerId).primary
    : COLORS.units.neutral.colorHex;
  return blendHexTowardWhite(primary, 0.5);
}

export function entityTurretAccentColorHex(entity: Entity): number {
  return turretAccentColorHexForPlayer(entity.ownership?.playerId);
}

export function entityHeadOnlyTurretHeadColorHex(
  entity: Entity,
  turretState: TurretState | undefined,
): number {
  return turretState === 'engaged'
    ? entityTurretAccentColorHex(entity)
    : entityInstanceColorHex(entity);
}

export function entityHeadOnlyTurretHeadColorHexForStateCode(
  entity: Entity,
  stateCode: number,
): number {
  return stateCode === CLIENT_RENDER_TURRET_STATE_ENGAGED
    ? entityTurretAccentColorHex(entity)
    : entityInstanceColorHex(entity);
}

export function entityShieldSphereTurretHeadColorHex(
  entity: Entity,
  turret: Turret | undefined,
  timeMs: number,
): number {
  const primary = entityInstanceColorHex(entity);
  if (
    turret === undefined ||
    turret.config.shot?.type !== 'shield' ||
    turret.config.shot.barrier === undefined ||
    (turret.shield?.range ?? 0) <= 0
  ) {
    return primary;
  }
  const phase = (timeMs % SHIELD_SPHERE_TURRET_PULSE_PERIOD_MS) /
    SHIELD_SPHERE_TURRET_PULSE_PERIOD_MS;
  const towardWhite = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
  return blendHexTowardWhite(primary, towardWhite);
}

export function entityShieldSphereTurretHeadColorHexForRange(
  entity: Entity,
  hasShieldBarrier: boolean,
  shieldRange: number,
  timeMs: number,
): number {
  const primary = entityInstanceColorHex(entity);
  if (!hasShieldBarrier || shieldRange <= 0) return primary;
  const phase = (timeMs % SHIELD_SPHERE_TURRET_PULSE_PERIOD_MS) /
    SHIELD_SPHERE_TURRET_PULSE_PERIOD_MS;
  const towardWhite = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
  return blendHexTowardWhite(primary, towardWhite);
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
