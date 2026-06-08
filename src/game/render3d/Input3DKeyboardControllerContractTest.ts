import {
  CONTROL_GROUP_FOCUS_DOUBLE_TAP_MS,
  recordControlGroupRecallTap,
  resetControlGroupRecallTap,
  type ControlGroupRecallTapState,
} from './Input3DKeyboardController';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[input keyboard contract] ${message}`);
  }
}

function makeState(): ControlGroupRecallTapState {
  return {
    index: -1,
    timeMs: Number.NEGATIVE_INFINITY,
  };
}

export function runInput3DKeyboardControllerContractTest(): void {
  const state = makeState();

  assertContract(
    !recordControlGroupRecallTap(state, 1, 1000),
    'first control-group recall must not focus',
  );
  assertContract(
    recordControlGroupRecallTap(state, 1, 1000 + CONTROL_GROUP_FOCUS_DOUBLE_TAP_MS),
    'same-slot recall inside the double-tap window must focus',
  );
  assertContract(
    !recordControlGroupRecallTap(state, 2, 1200),
    'switching slots must start a new double-tap sequence',
  );
  assertContract(
    !recordControlGroupRecallTap(state, 2, 1200 + CONTROL_GROUP_FOCUS_DOUBLE_TAP_MS + 1),
    'same-slot recall after the double-tap window must not focus',
  );

  resetControlGroupRecallTap(state);
  assertContract(
    !recordControlGroupRecallTap(state, 2, 1300),
    'reset tap state must clear the pending focus sequence',
  );
}
