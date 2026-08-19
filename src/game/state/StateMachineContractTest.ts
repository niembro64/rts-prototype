/**
 * The guarantees the rest of the codebase leans on when it replaces a pile of
 * booleans with a declared machine: undeclared moves are refused, and a
 * refusal never changes state.
 */

import { createStateMachine } from './StateMachine';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[state-machine] ${message}`);
}

type Light = 'red' | 'green' | 'yellow';
type Tick = 'go' | 'slow' | 'stop' | 'bogus';

export function runStateMachineContractTest(): void {
  const seen: string[] = [];
  const machine = createStateMachine<Light, Tick>({
    name: 'light',
    initial: 'red',
    transitions: {
      red: { go: 'green' },
      green: { slow: 'yellow' },
      yellow: { stop: 'red' },
    },
    onTransition: (change) => seen.push(`${change.from}-${change.event}->${change.to}`),
  });

  assert(machine.state === 'red', 'starts in the declared initial state');

  // A declared edge moves and reports that it moved.
  assert(machine.send('go') === true, 'a legal event transitions');
  assert(machine.state === 'green', 'and lands on the declared target');

  // An undeclared edge is refused, and refusal leaves the state untouched —
  // this is the property that lets callers stop latching every path by hand.
  assert(machine.send('stop') === false, 'an event not legal here is refused');
  assert(machine.state === 'green', 'a refused event must not change state');
  assert(machine.send('bogus') === false, 'an event declared nowhere is refused');
  assert(machine.state === 'green', 'and still must not change state');

  // Repeats are refused for the same reason, which is how "fire once" is
  // expressed without a separate boolean guarding the call site.
  assert(machine.send('go') === false, 'repeating a consumed event is refused');

  assert(machine.can('slow') === true, 'can() agrees with the table');
  assert(machine.can('go') === false, 'can() refuses what send() would refuse');

  assert(machine.is('green') === true, 'is() matches the current state');
  assert(machine.is('red', 'yellow') === false, 'is() rejects other states');

  machine.send('slow');
  machine.send('stop');
  assert(machine.state === 'red', 'a full declared cycle returns to the start');
  assert(
    seen.join(',') === 'red-go->green,green-slow->yellow,yellow-stop->red',
    `only accepted transitions fire the hook: ${seen.join(',')}`,
  );

  // reset() rebuilds rather than travels an edge, so it fires no hook.
  const before = seen.length;
  machine.send('go');
  machine.reset();
  assert(machine.state === 'red', 'reset returns to the initial state');
  assert(seen.length === before + 1, 'reset does not fire the transition hook');

  console.log('[contract] state machine OK');
}
