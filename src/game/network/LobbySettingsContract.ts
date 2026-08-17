import type { LobbySettings } from '@/types/network';
import { isLiquidSurfaceMode, isTerrainSurfaceMode } from '@/types/worldSurfaceMode';

const NUMERIC_FIELDS = [
  'centerMagnitude',
  'dividersMagnitude',
  'perimeterMagnitude',
  'terrainDTerrain',
  'plateauWallSlopeDegrees',
  'metalDepositStep',
  'terrainDetail',
  'mapWidthLandCells',
  'mapLengthLandCells',
  'entityCountCap',
  'converterTax',
] as const satisfies readonly (keyof LobbySettings)[];

/** Network messages carry exactly one complete lobby-settings contract. Missing
 * or malformed fields are protocol errors; they are never reconstructed from
 * local preferences or defaults. */
export function assertCurrentLobbySettings(
  value: unknown,
  context = 'lobby settings',
): asserts value is LobbySettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`[${context}] expected the current settings object`);
  }
  const settings = value as Record<string, unknown>;
  for (let i = 0; i < NUMERIC_FIELDS.length; i++) {
    const field = NUMERIC_FIELDS[i];
    if (typeof settings[field] !== 'number' || !Number.isFinite(settings[field])) {
      throw new Error(`[${context}] missing or invalid ${field}`);
    }
  }
  if ((settings.mapWidthLandCells as number) <= 0 || (settings.mapLengthLandCells as number) <= 0) {
    throw new Error(`[${context}] map dimensions must be positive`);
  }
  if ((settings.entityCountCap as number) <= 0) {
    throw new Error(`[${context}] entityCountCap must be positive`);
  }
  if (typeof settings.slowDownAtFinalWaypoint !== 'boolean') {
    throw new Error(`[${context}] missing or invalid slowDownAtFinalWaypoint`);
  }
  if (!isTerrainSurfaceMode(settings.terrainSurfaceMode)) {
    throw new Error(`[${context}] missing or invalid terrainSurfaceMode`);
  }
  if (!isLiquidSurfaceMode(settings.liquidSurfaceMode)) {
    throw new Error(`[${context}] missing or invalid liquidSurfaceMode`);
  }
}
