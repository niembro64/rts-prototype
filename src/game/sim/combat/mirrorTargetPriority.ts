import type { Entity, Turret } from '../types';

export type MirrorTargetTurretPick = {
  turret: Turret;
  index: number;
  score: number;
};

/** Lexicographic encoding: threat tier dominates, DPS breaks ties.
 *  TIER_WEIGHT must exceed any plausible sustained DPS so the tier
 *  ordering is never crossed; DPS_CAP keeps the encoded score safely
 *  inside one tier band even for outlier weapons. */
const TIER_WEIGHT = 1_000_000;
const DPS_CAP = TIER_WEIGHT - 1;

/** Sustained DPS for a turret based on its compiled shot config and
 *  cooldown. Beams sustain their authored `dps` continuously; lasers
 *  pulse for `duration` out of every `cooldown` window; projectile
 *  shots deliver `explosion.damage` per `cooldown` ms. Force shots
 *  and turrets without a damaging shot return 0 and are filtered out. */
function turretDps(turret: Turret): number {
  const shot = turret.config.shot;
  if (!shot) return 0;
  if (shot.type === 'beam') return shot.dps;
  if (shot.type === 'laser') {
    const period = Math.max(shot.duration, turret.config.cooldown);
    return period > 0 ? (shot.dps * shot.duration) / period : 0;
  }
  if (shot.type === 'projectile' || shot.type === 'rocket') {
    const damage = shot.explosion?.damage ?? 0;
    return turret.config.cooldown > 0
      ? (damage * 1000) / turret.config.cooldown
      : 0;
  }
  return 0;
}

function threatTier(turret: Turret, ourUnitId: number): number {
  if (turret.target === ourUnitId && turret.state !== 'idle') return 3;
  if (turret.state === 'engaged') return 2;
  return 1;
}

export function scoreMirrorTargetTurret(turret: Turret, ourUnitId: number): number {
  if (turret.config.passive) return 0;
  if (turret.config.visualOnly) return 0;
  if (turret.config.isManualFire) return 0;
  const dps = turretDps(turret);
  if (dps <= 0) return 0;
  return threatTier(turret, ourUnitId) * TIER_WEIGHT + Math.min(dps, DPS_CAP);
}

export function pickMirrorTargetTurret(
  target: Entity,
  ourUnitId: number,
): MirrorTargetTurretPick | null {
  const turrets = target.combat?.turrets;
  if (!turrets) return null;
  let best: MirrorTargetTurretPick | null = null;
  for (let ti = 0; ti < turrets.length; ti++) {
    const turret = turrets[ti];
    const score = scoreMirrorTargetTurret(turret, ourUnitId);
    if (score <= 0) continue;
    if (best === null || score > best.score) {
      best = { turret, index: ti, score };
    }
  }
  return best;
}

export function getMirrorTargetScore(target: Entity, ourUnitId: number): number {
  return pickMirrorTargetTurret(target, ourUnitId)?.score ?? 0;
}
