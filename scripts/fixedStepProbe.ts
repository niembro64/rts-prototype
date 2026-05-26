import {
  FixedStepAccumulator,
  SIM_STEP_MS,
} from '../src/game/sim/fixedStep';

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

function runDeltas(deltas: readonly number[]): number[] {
  const accumulator = new FixedStepAccumulator();
  const simulatedSteps: number[] = [];
  for (const delta of deltas) {
    const steps = accumulator.consumeDeltaMs(delta);
    for (let i = 0; i < steps; i++) simulatedSteps.push(SIM_STEP_MS);
  }
  return simulatedSteps;
}

const oneSecondAt60Hz = Array.from({ length: 60 }, () => SIM_STEP_MS);
const oneSecondAt10Hz = Array.from({ length: 10 }, () => SIM_STEP_MS * 6);
const jitteredOneSecond = Array.from(
  { length: 60 },
  (_, index) => SIM_STEP_MS * (index % 2 === 0 ? 0.5 : 1.5),
);

const expected = oneSecondAt60Hz;
assertJsonEqual(runDeltas(oneSecondAt60Hz), expected, '60 Hz wall-clock run');
assertJsonEqual(runDeltas(oneSecondAt10Hz), expected, '10 Hz wall-clock run');
assertJsonEqual(runDeltas(jitteredOneSecond), expected, 'jittered wall-clock run');

const accumulator = new FixedStepAccumulator();
assert(accumulator.consumeDeltaMs(SIM_STEP_MS / 2) === 0, 'partial step should not advance');
assert(accumulator.getRemainderMs() > 0, 'partial step should keep remainder');
assert(accumulator.consumeDeltaMs(SIM_STEP_MS / 2) === 1, 'remainders should complete one step');
accumulator.reset();
assert(accumulator.getRemainderMs() === 0, 'reset clears remainder');

console.log('fixed step probe passed');
