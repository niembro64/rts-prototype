import { CommandQueue, type Command } from '../src/game/sim/commands';
import { LockstepCommandScheduler } from '../src/game/sim/LockstepCommandScheduler';
import { COMMAND_SCHEMA_VERSION, type CommandBundle } from '../src/types/commands';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertJsonEqual(actual: unknown, expected: unknown, label: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  assert(
    actualJson === expectedJson,
    `${label} mismatch\nactual:   ${actualJson}\nexpected: ${expectedJson}`,
  );
}

function markers(commands: readonly Command[]): number[] {
  return commands.map((command) => command.type === 'ping' ? command.targetX : -1);
}

function ping(tick: number, marker: number): Command {
  return {
    type: 'ping',
    tick,
    targetX: marker,
    targetY: 0,
  };
}

function bundle(
  targetTick: number,
  peerId: number,
  seq: number,
  commands: readonly Command[] = [],
): CommandBundle {
  return {
    schemaVersion: COMMAND_SCHEMA_VERSION,
    targetTick,
    peerId,
    seq,
    commands: [...commands],
  };
}

const exactQueue = new CommandQueue();
exactQueue.enqueue(ping(4, 40));
exactQueue.enqueue(ping(5, 50));
assertJsonEqual(markers(exactQueue.getCommandsForTick(5)), [50], 'exact tick drain');
assert(exactQueue.getPendingCount() === 1, 'earlier command should stay pending');
assertJsonEqual(markers(exactQueue.getCommandsForTick(4)), [40], 'late command not promoted');

const stableQueue = new CommandQueue();
stableQueue.enqueue(ping(8, 10));
stableQueue.enqueue(ping(8, 11));
assertJsonEqual(markers(stableQueue.getCommandsForTick(8)), [10, 11], 'same-tick stable order');

const staleQueue = new CommandQueue();
staleQueue.enqueue(ping(2, 20));
staleQueue.enqueue(ping(3, 30));
assertJsonEqual(markers(staleQueue.dropCommandsBeforeTick(3)), [20], 'explicit stale drop');
assertJsonEqual(markers(staleQueue.getCommandsForTick(3)), [30], 'stale drop preserves target tick');

const scheduler = new LockstepCommandScheduler([2, 1]);
const scheduledQueue = new CommandQueue();
assert(
  scheduler.acceptBundle(bundle(10, 2, 0, [ping(10, 20)])).status === 'accepted',
  'peer 2 bundle accepted',
);
const stalled = scheduler.releaseTickToQueue(10, scheduledQueue);
assert(stalled.status === 'waiting', 'missing peer should stall release');
if (stalled.status === 'waiting') {
  assertJsonEqual(stalled.missingPeerIds, [1], 'missing peer list');
}
assert(scheduledQueue.getPendingCount() === 0, 'stalled tick should not enqueue commands');

const peerOneBundle = bundle(10, 1, 0, [ping(10, 10)]);
assert(scheduler.acceptBundle(peerOneBundle).status === 'accepted', 'peer 1 bundle accepted');
const duplicate = scheduler.acceptBundle(bundle(10, 1, 1, [ping(10, 99)]));
assert(duplicate.status === 'duplicate', 'duplicate peer/tick bundle rejected');

const ready = scheduler.releaseTickToQueue(10, scheduledQueue);
assert(ready.status === 'ready', 'complete tick should release');
if (ready.status === 'ready') {
  assertJsonEqual(markers(ready.commands), [10, 20], 'released command order');
}
assertJsonEqual(
  markers(scheduledQueue.getCommandsForTick(10)),
  [10, 20],
  'released bundles drain through exact queue',
);

assert(
  scheduler.acceptBundle(bundle(10, 2, 2)).status === 'late',
  'released tick rejects late bundle',
);
assert(
  scheduler.releaseTickToQueue(10, scheduledQueue).status === 'alreadyReleased',
  'released tick cannot release twice',
);
assert(
  scheduler.acceptBundle(bundle(11, 9, 0)).status === 'unknownPeer',
  'unknown peer rejected',
);
assert(
  scheduler.acceptBundle(bundle(11, 1, 0, [ping(12, 12)])).status === 'invalid',
  'command tick mismatch rejected',
);

console.log('command scheduler probe passed');
