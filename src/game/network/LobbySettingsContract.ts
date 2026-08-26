import type { LobbySettings } from '@/types/network';
import { MAX_ALLY_TEAM_COUNT } from '../sim/teamRoster';
import { isLiquidSurfaceMode, isMetalCoverage } from '@/types/worldSurfaceMode';
import { isTerrainPrecedence } from '@/types/terrainPrecedence';
import { isSimulationTickRateHz } from '@/types/simulationTickRate';
import { MAX_LOBBY_NAME_LENGTH } from './lobbyName';

const NUMERIC_FIELDS = [
  'centerMagnitude',
  'ringMagnitude',
  'dividersMagnitude',
  'perimeterMagnitude',
  'terrainDTerrain',
  'plateauWallSlopeDegrees',
  'metalDepositStep',
  'terrainDetail',
  'mapWidthLandCells',
  'mapLengthLandCells',
  'entityCountCap',
  'allyTeamCount',
  'simulationTickRateHz',
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
  if (
    !Number.isInteger(settings.allyTeamCount) ||
    (settings.allyTeamCount as number) < 1 ||
    (settings.allyTeamCount as number) > MAX_ALLY_TEAM_COUNT
  ) {
    throw new Error(
      `[${context}] allyTeamCount must be an integer in 1..${MAX_ALLY_TEAM_COUNT}`,
    );
  }
  if (!isSimulationTickRateHz(settings.simulationTickRateHz)) {
    throw new Error(
      `[${context}] simulationTickRateHz must be one of 1, 5, 10, 15, 20, 30, 45, 60`,
    );
  }
  if (typeof settings.lobbyName !== 'string') {
    throw new Error(`[${context}] missing or invalid lobbyName`);
  }
  if ((settings.lobbyName as string).length > MAX_LOBBY_NAME_LENGTH) {
    throw new Error(
      `[${context}] lobbyName must be at most ${MAX_LOBBY_NAME_LENGTH} characters`,
    );
  }
  if (typeof settings.slowDownAtFinalWaypoint !== 'boolean') {
    throw new Error(`[${context}] missing or invalid slowDownAtFinalWaypoint`);
  }
  if (typeof settings.pathfindingConsidersUnits !== 'boolean') {
    throw new Error(`[${context}] missing or invalid pathfindingConsidersUnits`);
  }
  if (!isMetalCoverage(settings.metalCoverage)) {
    throw new Error(`[${context}] missing or invalid metalCoverage`);
  }
  if (!isLiquidSurfaceMode(settings.liquidSurfaceMode)) {
    throw new Error(`[${context}] missing or invalid liquidSurfaceMode`);
  }
  if (!isTerrainPrecedence(settings.terrainPrecedence)) {
    throw new Error(`[${context}] missing or invalid terrainPrecedence`);
  }
}
