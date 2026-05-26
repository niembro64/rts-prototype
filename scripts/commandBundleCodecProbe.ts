import { encode as msgpackEncode } from '@msgpack/msgpack';
import type { Command } from '../src/types/commands';
import { COMMAND_TYPE_IDS, commandTypeFromId, commandTypeToId } from '../src/types/commands';
import {
  CommandBundleDuplicateGuard,
  createCommandBundle,
  createEmptyCommandBundle,
  decodeCommandBundle,
  decodeCommandBundleOnce,
  encodeCommandBundle,
  orderedCommandsFromBundles,
} from '../src/game/network/commandBundleCodec';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertThrows(fn: () => void, label: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, `${label} did not throw`);
}

function assertJsonEqual(actual: unknown, expected: unknown, label: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  assert(
    actualJson === expectedJson,
    `${label} mismatch\nactual:   ${actualJson}\nexpected: ${expectedJson}`,
  );
}

for (const type of Object.keys(COMMAND_TYPE_IDS) as Array<keyof typeof COMMAND_TYPE_IDS>) {
  const id = commandTypeToId(type);
  assert(commandTypeFromId(id) === type, `command type id mismatch for ${type}`);
}

const empty = createEmptyCommandBundle(120, 1, 7);
assertJsonEqual(
  decodeCommandBundle(encodeCommandBundle(empty)),
  empty,
  'empty bundle round trip',
);

const move: Command = {
  type: 'move',
  tick: 120,
  entityIds: [10, 12],
  individualTargets: [
    { x: 100, y: 200 },
    { x: 120, y: 220, z: 30 },
  ],
  waypointType: 'move',
  queue: true,
};
const bundle = createCommandBundle({
  targetTick: 120,
  peerId: 2,
  seq: 9,
  commands: [move],
});
assertJsonEqual(
  decodeCommandBundle(encodeCommandBundle(bundle)),
  bundle,
  'move bundle round trip',
);

assertThrows(
  () => decodeCommandBundle(msgpackEncode([999, 120, 1, 1, 0, []])),
  'schema rejection',
);
assertThrows(
  () => decodeCommandBundle(msgpackEncode([1, 120, 1, 1, 1, [[999, []]]])),
  'unknown command id rejection',
);
assertThrows(
  () => decodeCommandBundle(msgpackEncode([1, 120, 1, 1, 1, [[COMMAND_TYPE_IDS.move, []]]])),
  'payload slot rejection',
);

const guard = new CommandBundleDuplicateGuard();
decodeCommandBundleOnce(encodeCommandBundle(bundle), guard);
assertThrows(
  () => decodeCommandBundleOnce(encodeCommandBundle(bundle), guard),
  'duplicate bundle rejection',
);

function ping(marker: number, peerId: number, seq: number, tick = 120) {
  return createCommandBundle({
    targetTick: tick,
    peerId,
    seq,
    commands: [{
      type: 'ping',
      tick,
      targetX: marker,
      targetY: 0,
    }],
  });
}

const orderedMarkers = orderedCommandsFromBundles([
  ping(30, 3, 0, 121),
  ping(20, 2, 1),
  ping(10, 1, 99),
  ping(21, 2, 2),
]).map((command) => command.type === 'ping' ? command.targetX : -1);
assertJsonEqual(orderedMarkers, [10, 20, 21, 30], 'arrival-independent order');

console.log('command bundle codec probe passed');
