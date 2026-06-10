import {
  CONTROL_GROUP_FOCUS_DOUBLE_TAP_MS,
  cameraKeyboardActionForKey,
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

type KeyboardActionFixture = Parameters<typeof cameraKeyboardActionForKey>[0];

function makeKey(overrides: Partial<KeyboardActionFixture>): KeyboardActionFixture {
  return {
    code: 'ArrowUp',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
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

  assertContract(
    cameraKeyboardActionForKey(makeKey({ code: 'ArrowUp' }))?.mode === 'pan',
    'plain arrows must pan the camera',
  );
  assertContract(
    cameraKeyboardActionForKey(makeKey({ code: 'ArrowLeft', ctrlKey: true }))?.mode === 'height-pan',
    'Ctrl + arrows must height-pan the camera',
  );
  assertContract(
    cameraKeyboardActionForKey(makeKey({ code: 'ArrowRight', altKey: true }))?.mode === 'orbit',
    'Alt + arrows must orbit the camera',
  );
  assertContract(
    cameraKeyboardActionForKey(makeKey({ code: 'Numpad9', shiftKey: true }))?.fine === true,
    'Shift + keyboard camera input must use fine control',
  );
  assertContract(
    cameraKeyboardActionForKey(makeKey({ code: 'ArrowDown', metaKey: true })) === null,
    'Meta + arrows must stay out of keyboard camera handling',
  );
}
