import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PlayerId } from '../src/types/sim';
import type { BattleManifestSettings } from '../src/types/network';
import {
  buildBattleManifest,
  hashBattleManifest,
} from '../src/game/network/BattleManifest';
import { createEmptyCommandBundle } from '../src/game/network/commandBundleCodec';
import { initSimWasm } from '../src/game/sim-wasm/init';

const PLAYER_IDS = [1, 2] as const satisfies readonly PlayerId[];

const SETTINGS: BattleManifestSettings = {
  centerMagnitude: 0,
  dividersMagnitude: 0,
  terrainMapShape: 'circle',
  terrainDTerrain: null,
  metalDepositStep: null,
  mapWidthLandCells: 7,
  mapLengthLandCells: 7,
  fogOfWarEnabled: false,
  converterTax: null,
};

const EXPECTED_HASHES = {
  initial: 'fnv1a64:98b0139a11bb4c1a',
  afterTick1: 'fnv1a64:c422dac498573ff3',
  afterTick2: 'fnv1a64:ae77aa4fd8721d83',
};

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const manifest = buildBattleManifest({
  gameId: 'sim-runtime-probe',
  roomCode: 'RT-09',
  hostPlayerId: 1,
  playerIds: PLAYER_IDS,
  players: [
    { playerId: 1, name: 'Runtime P1', isHost: true },
    { playerId: 2, name: 'Runtime P2', isHost: false },
  ],
  settings: SETTINGS,
  mapSeed: 9001,
  initialRngSeed: 1234,
});

const wasmBytes = await readFile(
  resolve(process.cwd(), 'src/game/sim-wasm/pkg/rts_sim_wasm_bg.wasm'),
);
const wasm = await initSimWasm(wasmBytes);

function runScenario() {
  const runtime = wasm.createRuntimeFromManifest(manifest);
  try {
    assert(runtime.tick === 0, 'runtime starts at tick 0');
    assert(
      runtime.manifestHash === hashBattleManifest(manifest),
      'runtime manifest hash matches TypeScript manifest hash',
    );
    runtime.installBootstrapWorld({
      mapWidth: 1400,
      mapHeight: 1400,
      nextEntityId: 3,
      playerIds: [...PLAYER_IDS],
      playerSlots: manifest.playerSlots.map((slot) => ({
        playerId: slot.playerId,
        teamId: slot.teamId,
      })),
      entities: [
        {
          id: 1,
          type: 'unit',
          unitType: 'commander',
          playerId: 1,
          x: 350,
          y: 350,
          z: 42,
          rotation: 0.5,
          hp: 500,
          maxHp: 500,
        },
        {
          id: 2,
          type: 'unit',
          unitType: 'commander',
          playerId: 2,
          x: 1050,
          y: 1050,
          z: 42,
          rotation: -2.5,
          hp: 500,
          maxHp: 500,
        },
      ],
      metalDeposits: [],
    });
    const bootstrap = runtime.readBootstrapWorld();
    assert(bootstrap.protocol === 'ba-rust-bootstrap-world-v1', 'bootstrap protocol is set');
    assert(bootstrap.entities.length === 2, 'bootstrap projection reports commander entities');
    assert(bootstrap.nextEntityId === 3, 'bootstrap projection reports next entity id');

    const initial = runtime.worldHash();

    runtime.enqueueCommandBundle(createEmptyCommandBundle(0, 1, 0));
    runtime.enqueueCommandBundle(createEmptyCommandBundle(0, 2, 0));
    assert(runtime.advanceOneTick() === 1, 'advanceOneTick returns the next tick');
    const afterTick1 = runtime.worldHash();

    runtime.enqueueCommandBundle(createEmptyCommandBundle(1, 1, 1));
    runtime.enqueueCommandBundle(createEmptyCommandBundle(1, 2, 1));
    assert(runtime.advanceOneTick() === 2, 'second advance reaches tick 2');
    const afterTick2 = runtime.worldHash();

    const packet = runtime.readRenderPacket();
    assert(packet.protocol === 'ba-rust-render-packet-v1', 'render packet protocol is set');
    assert(packet.tick === 2, 'render packet reports current runtime tick');
    assert(packet.entities.length === 0, 'minimal runtime render packet has no entities');

    const diagnostics = runtime.readDiagnostics();
    assert(diagnostics.protocol === 'ba-rust-sim-runtime-v1', 'diagnostics protocol is set');
    assert(diagnostics.tick === 2, 'diagnostics report current runtime tick');
    assert(diagnostics.playerCount === PLAYER_IDS.length, 'diagnostics report player count');
    assert(diagnostics.bootstrapInstalled === true, 'diagnostics report bootstrap install');
    assert(diagnostics.bootstrapEntityCount === 2, 'diagnostics report bootstrap entity count');
    assert(diagnostics.appliedBundleCount === 4, 'diagnostics report applied bundles');
    assert(diagnostics.pendingBundleCount === 0, 'all probe bundles have been applied');

    return { initial, afterTick1, afterTick2 };
  } finally {
    runtime.free();
  }
}

const first = runScenario();
const second = runScenario();
assert(
  JSON.stringify(first) === JSON.stringify(second),
  'same manifest and bundle sequence produce stable runtime hashes',
);

assert(first.initial === EXPECTED_HASHES.initial, `initial hash changed: ${first.initial}`);
assert(first.afterTick1 === EXPECTED_HASHES.afterTick1, `tick 1 hash changed: ${first.afterTick1}`);
assert(first.afterTick2 === EXPECTED_HASHES.afterTick2, `tick 2 hash changed: ${first.afterTick2}`);

console.log(
  `sim runtime probe ok: ${first.initial} -> ${first.afterTick1} -> ${first.afterTick2}`,
);
