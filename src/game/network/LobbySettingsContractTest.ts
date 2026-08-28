import type { LobbySettings } from '@/types/network';
import { assertCurrentLobbySettings } from './LobbySettingsContract';
import { MAX_LOBBY_NAME_LENGTH } from './lobbyName';

const CURRENT_SETTINGS: LobbySettings = {
  lobbyName: 'Test lobby',
  centerMagnitude: 0,
  ringMagnitude: 0,
  dividersMagnitude: 0,
  perimeterMagnitude: 0,
  terrainPrecedence: 'perimeter-precedence',
  terrainDTerrain: 0,
  plateauWallSlopeDegrees: 85,
  metalDepositStep: 0,
  terrainDetail: 4,
  mapWidthLandCells: 20,
  mapLengthLandCells: 20,
  entityCountCap: 729,
  allyTeamCount: 2,
  simulationTickRateHz: 20,
  converterTax: 0.1,
  slowDownAtFinalWaypoint: true,
  pathfindingConsidersUnits: true,
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
  // An unnamed lobby is the common case, not an error: the directory falls
  // back to the host's name.
  assertCurrentLobbySettings(
    { ...CURRENT_SETTINGS, lobbyName: '' },
    'contract test unnamed lobby',
  );
  assertCurrentLobbySettings(
    { ...CURRENT_SETTINGS, liquidSurfaceMode: 'none' },
    'contract test drained liquid mode',
  );
  const missingLobbyName = { ...CURRENT_SETTINGS } as Partial<LobbySettings>;
  delete missingLobbyName.lobbyName;
  assertRejected(missingLobbyName, 'a packet without lobbyName');
  assertRejected(
    { ...CURRENT_SETTINGS, lobbyName: 'x'.repeat(MAX_LOBBY_NAME_LENGTH + 1) },
    'a lobbyName past the length ceiling',
  );
  const missingTerrainDetail = { ...CURRENT_SETTINGS } as Partial<LobbySettings>;
  delete missingTerrainDetail.terrainDetail;
  assertRejected(missingTerrainDetail, 'an incomplete settings packet');
  assertRejected(
    { ...CURRENT_SETTINGS, slowDownAtFinalWaypoint: undefined },
    'an obsolete packet without slowDownAtFinalWaypoint',
  );
  assertRejected(
    { ...CURRENT_SETTINGS, pathfindingConsidersUnits: undefined },
    'an obsolete packet without pathfindingConsidersUnits',
  );
  assertRejected(
    { ...CURRENT_SETTINGS, metalCoverage: 'unknown' },
    'an unsupported metalCoverage',
  );
  assertRejected(
    { ...CURRENT_SETTINGS, liquidSurfaceMode: 'unknown' },
    'an unsupported liquidSurfaceMode',
  );
  assertRejected(
    { ...CURRENT_SETTINGS, terrainPrecedence: undefined },
    'an obsolete packet without terrainPrecedence',
  );
  assertRejected(
    { ...CURRENT_SETTINGS, terrainPrecedence: 'perimeter' },
    'an unsupported terrainPrecedence',
  );
  assertRejected(
    { ...CURRENT_SETTINGS, simulationTickRateHz: 25 },
    'an unsupported simulation tick rate',
  );
}
