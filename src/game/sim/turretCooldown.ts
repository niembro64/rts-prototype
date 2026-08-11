import type { TurretCooldownConfig } from './types';

function clampDurationRandomness(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, 0.999);
}

/** Shared deterministic duration roll used by projectile cooldowns and beam
 * lifecycle windows. The caller owns the canonical RNG stream and decides
 * exactly which committed transition consumes a sample. */
export function rollDurationWithRandomness(
  duration: number,
  durationRandomness: number,
  nextRandom: () => number,
): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;

  const randomness = clampDurationRandomness(durationRandomness);
  if (randomness <= 0) return duration;

  const rawRandom = nextRandom();
  const normalizedRandom = Number.isFinite(rawRandom) ? Math.max(0, Math.min(1, rawRandom)) : 0.5;
  const centeredRandom = normalizedRandom * 2 - 1;
  return duration * (1 + centeredRandom * randomness);
}

export function getMaximumDurationWithRandomness(
  duration: number,
  durationRandomness: number,
): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return duration * (1 + clampDurationRandomness(durationRandomness));
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

  return rollDurationWithRandomness(
    getTurretCooldownDuration(cooldown),
    cooldown.durationRandomness,
    nextRandom,
  );
}
