export function smootherstep(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}
