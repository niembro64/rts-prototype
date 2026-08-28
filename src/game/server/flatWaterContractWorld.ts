import type { GameServerConfig } from '../../types/game';
import type { PlayerId } from '../../types/entityTypes';

/** Flat bare land ringed by a deep water perimeter — the standard
 *  featureless square world the budget / path / replay contracts boot:
 *  no center dome, no ring, no dividers, near-vertical plateau walls,
 *  no metal-deposit terracing. Tests override only what the scenario
 *  actually varies (seats, tick rate) and pick their own map size in
 *  land cells per side. */
export function flatWaterWorldConfig(
  landCellsPerSide: number,
  overrides: Partial<GameServerConfig> = {},
): GameServerConfig {
  return {
    playerIds: [1 as PlayerId, 2 as PlayerId],
    centerMagnitude: 0,
    ringMagnitude: 0,
    dividersMagnitude: 0,
    perimeterMagnitude: -800,
    terrainPrecedence: 'perimeter-precedence',
    terrainDTerrain: 0,
    plateauWallSlopeDegrees: 89,
    metalDepositStep: 0,
    terrainDetail: 1,
    mapWidthLandCells: landCellsPerSide,
    mapLengthLandCells: landCellsPerSide,
    converterTax: 0,
    ...overrides,
  };
}
