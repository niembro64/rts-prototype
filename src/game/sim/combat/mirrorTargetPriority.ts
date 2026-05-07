import type { Entity, Turret } from '../types';
import { isLineShot } from '../types';

export type MirrorLineTurretPick = {
  turret: Turret;
  index: number;
  score: number;
};

function lineWeaponPriority(turret: Turret): number {
  const shot = turret.config.shot;
  if (!isLineShot(shot)) return 0;
  return Math.max(0, turret.config.mirrorReflectPriority ?? 0);
}

function threatTier(turret: Turret, ourUnitId: number): number {
  if (turret.target === ourUnitId && turret.state !== 'idle') return 3;
  if (turret.state === 'engaged') return 2;
  return 1;
}

export function scoreMirrorLineTurret(turret: Turret, ourUnitId: number): number {
  if (turret.config.passive) return 0;
  if (!isLineShot(turret.config.shot)) return 0;
  return threatTier(turret, ourUnitId) * 100 + lineWeaponPriority(turret);
}

export function pickMirrorLineTurret(
  target: Entity,
  ourUnitId: number,
): MirrorLineTurretPick | null {
  const turrets = target.combat?.turrets;
  if (!turrets) return null;
  let best: MirrorLineTurretPick | null = null;
  for (let ti = 0; ti < turrets.length; ti++) {
    const turret = turrets[ti];
    const score = scoreMirrorLineTurret(turret, ourUnitId);
    if (score <= 0) continue;
    if (best === null || score > best.score) {
      best = { turret, index: ti, score };
    }
  }
  return best;
}

export function getMirrorLineTargetScore(target: Entity, ourUnitId: number): number {
  return pickMirrorLineTurret(target, ourUnitId)?.score ?? 0;
}
