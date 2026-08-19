import type { LobbySettings } from '@/types/network';
import { assertCurrentLobbySettings } from './LobbySettingsContract';

const CURRENT_SETTINGS: LobbySettings = {
  centerMagnitude: 0,
  dividersMagnitude: 0,
  perimeterMagnitude: 0,
  terrainDTerrain: 0,
  plateauWallSlopeDegrees: 85,
  metalDepositStep: 0,
  terrainDetail: 4,
  mapWidthLandCells: 20,
  mapLengthLandCells: 20,
  entityCountCap: 729,
  allyTeamCount: 2,
  pathfindingCellConsolidationMultiplier: 3,
  simulationTickRateHz: 20,
  converterTax: 0.1,
  slowDownAtFinalWaypoint: true,
  metalCoverage: 'more',
  liquidSurfaceMode: 'water',
};

function assertRejected(value: unknown, label: string): void {
  let rejected = false;
  try {
    assertCurrentLobbySettings(value, 'contract test');
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(`[lobby settings contract] ${label} must be rejected`);
}

export function runLobbySettingsContractTest(): void {
  assertCurrentLobbySettings(CURRENT_SETTINGS, 'contract test');
  for (const simulationTickRateHz of [1, 5, 10, 15, 20, 30, 45, 60]) {
    assertCurrentLobbySettings(
      { ...CURRENT_SETTINGS, simulationTickRateHz },
      'contract test supported simulation tick rate',
    );
  }
  const missingTerrainDetail = { ...CURRENT_SETTINGS } as Partial<LobbySettings>;
  delete missingTerrainDetail.terrainDetail;
  assertRejected(missingTerrainDetail, 'an incomplete settings packet');
  assertRejected(
    { ...CURRENT_SETTINGS, slowDownAtFinalWaypoint: undefined },
    'an obsolete packet without slowDownAtFinalWaypoint',
  );
  assertRejected(
    { ...CURRENT_SETTINGS, metalCoverage: 'unknown' },
    'an unsupported metalCoverage',
  );
  assertRejected(
    { ...CURRENT_SETTINGS, pathfindingCellConsolidationMultiplier: 6 },
    'an unsupported pathfinding-cell multiplier',
  );
  assertRejected(
    { ...CURRENT_SETTINGS, simulationTickRateHz: 25 },
    'an unsupported simulation tick rate',
  );
}
