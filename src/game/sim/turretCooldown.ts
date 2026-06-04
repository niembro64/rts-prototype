import type { TurretCooldownConfig } from './types';

function clampDurationRandomness(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, 0.999);
}

export function getTurretCooldownDuration(cooldown: TurretCooldownConfig | null): number {
  if (cooldown === null || !Number.isFinite(cooldown.duration)) return 0;
  return Math.max(0, cooldown.duration);
}

export function rollTurretCooldownDuration(
  cooldown: TurretCooldownConfig | null,
  nextRandom: () => number,
): number {
  if (cooldown === null) return 0;

  const duration = getTurretCooldownDuration(cooldown);
  if (duration <= 0) return 0;

  const randomness = clampDurationRandomness(cooldown.durationRandomness);
  if (randomness <= 0) return duration;

  const rawRandom = nextRandom();
  const normalizedRandom = Number.isFinite(rawRandom) ? Math.max(0, Math.min(1, rawRandom)) : 0.5;
  const centeredRandom = normalizedRandom * 2 - 1;
  return duration * (1 + centeredRandom * randomness);
}
