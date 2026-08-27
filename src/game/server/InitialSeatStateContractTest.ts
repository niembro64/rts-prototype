import type { GameServerConfig } from '@/types/game';
import type { PlayerId } from '../sim/types';
import type { WorldState } from '../sim/WorldState';
import {
  resolveBootstrapSeatSpawnGroups,
  resolveBootstrapSpawnRules,
  type ResolvedBootstrapConfig,
} from './ServerBootstrapPhases';
import {
  DEFAULT_BOT_INITIAL_STATE,
  DEFAULT_DEMO_INITIAL_STATE,
  DEFAULT_HUMAN_INITIAL_STATE,
} from '../sim/agentSeat';

function assertContract(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Initial seat state contract failed: ${message}`);
}

function resolveRules(
  config: GameServerConfig,
  backgroundMode: boolean,
) {
  const resolved = {
    playerIds: config.playerIds,
    backgroundMode,
  } as ResolvedBootstrapConfig;
  // Spawn-rule resolution only writes these fields when their corresponding
  // config overrides are present. Keeping the stub explicit makes that
  // boundary visible without booting terrain and physics for a routing test.
  const world = {
    entityCountCap: 4096,
    converterTax: 0,
  } as WorldState;
  return resolveBootstrapSpawnRules(config, world, resolved);
}

export function runInitialSeatStateContractTest(): void {
  const playerIds = [1, 2, 3].map((id) => id as PlayerId);

  assertContract(
    DEFAULT_HUMAN_INITIAL_STATE === 'commander' &&
      DEFAULT_BOT_INITIAL_STATE === 'baseBuildings' &&
      DEFAULT_DEMO_INITIAL_STATE === 'baseAndUnits',
    'lobby humans, lobby bots, and Demo must keep their requested defaults',
  );

  const explicitRules = resolveRules({
    playerIds,
    aiPlayerIds: [2 as PlayerId, 3 as PlayerId],
    baseSeatPlayerIds: [2 as PlayerId, 3 as PlayerId],
    baseAndUnitsSeatPlayerIds: [3 as PlayerId],
  }, false);
  const explicitGroups = resolveBootstrapSeatSpawnGroups(playerIds, explicitRules);
  assertContract(
    explicitGroups.commanderSeatPlayerIds.join(',') === '1',
    'Lone Commander seats must enter only the commander spawn pass',
  );
  assertContract(
    explicitGroups.baseSeatPlayerIds.join(',') === '2,3',
    'both base modes must enter the same complete base-building and extractor passes',
  );
  assertContract(
    explicitGroups.baseAndUnitsSeatPlayerIds.join(',') === '3',
    'only Base and Units seats may enter the opening-unit pass',
  );

  const demoRules = resolveRules({
    playerIds,
    backgroundMode: true,
    aiPlayerIds: [2 as PlayerId, 3 as PlayerId],
  }, true);
  assertContract(
    demoRules.baseSeatPlayerIds.join(',') === '1,2,3' &&
      demoRules.baseAndUnitsSeatPlayerIds.join(',') === '1,2,3',
    'an implicit Demo start must give the local human and every bot Base and Units',
  );

  const realRules = resolveRules({ playerIds }, false);
  assertContract(
    realRules.baseSeatPlayerIds.length === 0 &&
      realRules.baseAndUnitsSeatPlayerIds.length === 0,
    'an implicit real-battle start must keep every human at Lone Commander',
  );

  const legacyRules = resolveRules({
    playerIds,
    baseSeatPlayerIds: [2 as PlayerId],
  }, false);
  assertContract(
    legacyRules.baseAndUnitsSeatPlayerIds.join(',') === '2',
    'an old two-state caller must preserve the former full-base opening',
  );
}
