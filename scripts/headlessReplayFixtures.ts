import type { Command, CommandBundle } from '../src/types/commands';
import type { BattleManifestSettings } from '../src/types/network';
import type { PlayerId } from '../src/types/sim';
import { buildBattleManifest } from '../src/game/network/BattleManifest';
import {
  createCommandBundle,
  createEmptyCommandBundle,
} from '../src/game/network/commandBundleCodec';
import type { HeadlessReplayFixture } from '../src/game/replay/HeadlessReplayRunner';
import { BUILD_GRID_CELL_SIZE } from '../src/game/sim/buildGrid';
import { getSpawnPositionForSeat } from '../src/game/sim/spawn';
import { LAND_CELL_SIZE } from '../src/mapSizeConfig';

type ScheduledCommands = {
  tick: number;
  peerId: PlayerId;
  commands: Command[];
};

const PLAYER_IDS = [1, 2] as const satisfies readonly PlayerId[];
const SMALL_MAP_LAND_CELLS = 7;

const BASE_SETTINGS: BattleManifestSettings = {
  centerMagnitude: 0,
  dividersMagnitude: 0,
  terrainMapShape: 'circle',
  terrainDTerrain: null,
  metalDepositStep: null,
  mapWidthLandCells: SMALL_MAP_LAND_CELLS,
  mapLengthLandCells: SMALL_MAP_LAND_CELLS,
  fogOfWarEnabled: true,
  converterTax: null,
};

function fixtureManifest(name: string, settings: BattleManifestSettings) {
  return buildBattleManifest({
    gameId: `headless-${name}`,
    roomCode: `HL-${name.toUpperCase()}`,
    hostPlayerId: 1,
    playerIds: PLAYER_IDS,
    players: [
      { playerId: 1, name: 'Replay P1', isHost: true },
      { playerId: 2, name: 'Replay P2', isHost: false },
    ],
    settings,
    mapSeed: name === 'smoke' ? 2002 : 1001,
    initialRngSeed: name === 'smoke' ? 3002 : 2001,
  });
}

function commandBundlesForTicks(
  ticks: number,
  scheduled: readonly ScheduledCommands[] = [],
): CommandBundle[] {
  const commandMap = new Map<string, Command[]>();
  for (const item of scheduled) {
    commandMap.set(`${item.tick}:${item.peerId}`, item.commands);
  }

  const bundles: CommandBundle[] = [];
  for (let tick = 0; tick < ticks; tick++) {
    for (const peerId of PLAYER_IDS) {
      const commands = commandMap.get(`${tick}:${peerId}`);
      bundles.push(commands === undefined
        ? createEmptyCommandBundle(tick, peerId, tick)
        : createCommandBundle({ targetTick: tick, peerId, seq: tick, commands }));
    }
  }
  return bundles;
}

function smokeCommands(): ScheduledCommands[] {
  const mapWidth = SMALL_MAP_LAND_CELLS * LAND_CELL_SIZE;
  const mapHeight = SMALL_MAP_LAND_CELLS * LAND_CELL_SIZE;
  const centerX = mapWidth / 2;
  const centerY = mapHeight / 2;
  const p1Spawn = getSpawnPositionForSeat(0, PLAYER_IDS.length, mapWidth, mapHeight);
  const buildX = p1Spawn.x + (centerX - p1Spawn.x) * 0.22;
  const buildY = p1Spawn.y + (centerY - p1Spawn.y) * 0.22;

  return [
    {
      tick: 1,
      peerId: 1,
      commands: [{
        type: 'scan',
        tick: 1,
        targetX: centerX,
        targetY: centerY,
        playerId: 1,
      }],
    },
    {
      tick: 2,
      peerId: 1,
      commands: [{
        type: 'fireDGun',
        tick: 2,
        commanderId: 1,
        targetX: centerX,
        targetY: centerY,
        targetZ: 0,
      }],
    },
    {
      tick: 3,
      peerId: 1,
      commands: [{
        type: 'startBuild',
        tick: 3,
        builderId: 1,
        buildingType: 'solar',
        gridX: Math.floor(buildX / BUILD_GRID_CELL_SIZE),
        gridY: Math.floor(buildY / BUILD_GRID_CELL_SIZE),
        queue: true,
      }],
    },
    {
      tick: 4,
      peerId: 1,
      commands: [{
        type: 'move',
        tick: 4,
        entityIds: [1],
        targetX: centerX,
        targetY: centerY,
        targetZ: 0,
        waypointType: 'fight',
        queue: true,
      }],
    },
    {
      tick: 4,
      peerId: 2,
      commands: [{
        type: 'move',
        tick: 4,
        entityIds: [2],
        targetX: centerX,
        targetY: centerY,
        targetZ: 0,
        waypointType: 'fight',
        queue: false,
      }],
    },
  ];
}

const smallTicks = 36;
const smokeTicks = 180;

export const HEADLESS_REPLAY_FIXTURES: HeadlessReplayFixture[] = [
  {
    name: 'small-idle',
    manifest: fixtureManifest('small', {
      ...BASE_SETTINGS,
      fogOfWarEnabled: false,
    }),
    ticks: smallTicks,
    commandBundles: commandBundlesForTicks(smallTicks),
    expectedHashes: [
      { tick: 1, hash: 'fnv1a64:741276d6404d1359' },
      { tick: 18, hash: 'fnv1a64:3639225c8404fc7d' },
      { tick: 36, hash: 'fnv1a64:41407aa6c87a9a24' },
    ],
  },
  {
    name: 'smoke-sim-systems',
    manifest: fixtureManifest('smoke', {
      ...BASE_SETTINGS,
      converterTax: 0.1,
    }),
    ticks: smokeTicks,
    commandBundles: commandBundlesForTicks(smokeTicks, smokeCommands()),
    expectedHashes: [
      { tick: 1, hash: 'fnv1a64:b3e391023a24f0d6' },
      { tick: 90, hash: 'fnv1a64:38062685175399a8' },
      { tick: 180, hash: 'fnv1a64:fdb9c522fbfa2470' },
    ],
  },
];
