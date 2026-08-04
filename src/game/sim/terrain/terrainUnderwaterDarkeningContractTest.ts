import {
  TERRAIN_SUBMERGED_BRIGHTNESS,
  TERRAIN_SUBMERGED_FADE_END_HEIGHT,
  WATER_LEVEL,
  terrainUnderwaterBrightnessAtHeight,
} from './terrainConfig';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Terrain underwater darkening contract: ${message}`);
}

function closeEnough(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= 1e-9;
}

export function runTerrainUnderwaterDarkeningContractTest(): void {
  assert(WATER_LEVEL < TERRAIN_SUBMERGED_FADE_END_HEIGHT,
    'fade endpoint must be above the water surface');
  assert(closeEnough(terrainUnderwaterBrightnessAtHeight(WATER_LEVEL - 1000),
    TERRAIN_SUBMERGED_BRIGHTNESS), 'deep terrain must use uniform submerged brightness');
  assert(closeEnough(terrainUnderwaterBrightnessAtHeight(WATER_LEVEL),
    TERRAIN_SUBMERGED_BRIGHTNESS), 'water-surface terrain must use submerged brightness');
  assert(closeEnough(terrainUnderwaterBrightnessAtHeight(TERRAIN_SUBMERGED_FADE_END_HEIGHT), 1),
    'fade endpoint must restore normal brightness');
  assert(closeEnough(terrainUnderwaterBrightnessAtHeight(TERRAIN_SUBMERGED_FADE_END_HEIGHT + 1000), 1),
    'terrain above the fade endpoint must remain at normal brightness');

  const midpoint = (WATER_LEVEL + TERRAIN_SUBMERGED_FADE_END_HEIGHT) * 0.5;
  assert(closeEnough(terrainUnderwaterBrightnessAtHeight(midpoint),
    (TERRAIN_SUBMERGED_BRIGHTNESS + 1) * 0.5), 'midpoint must follow a half-cosine curve');

  let previous = TERRAIN_SUBMERGED_BRIGHTNESS;
  for (let step = 1; step <= 100; step++) {
    const height = WATER_LEVEL +
      (TERRAIN_SUBMERGED_FADE_END_HEIGHT - WATER_LEVEL) * step / 100;
    const brightness = terrainUnderwaterBrightnessAtHeight(height);
    assert(brightness >= previous, 'brightness curve must be monotonic');
    previous = brightness;
  }
}
