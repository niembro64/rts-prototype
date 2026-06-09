import {
  COMMAND_HOTKEY_IDS,
  COMMAND_HOTKEY_PRESET_IDS,
  CommandHotkeySequenceResolver,
  commandHotkeyLabel,
  getCommandHotkeyPreset,
  getCommandHotkeyConflicts,
  resolveCommandHotkey,
} from './commandHotkeys';
import {
  clearQueueModifierState,
  queueModeForDragRelease,
  queueModeFromEvent,
  setQueueModifierKeyState,
} from './queueModifiers';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[command hotkeys contract] ${message}`);
  }
}

function keyEvent(
  key: string,
  code: string,
  modifiers: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>> = {},
): KeyboardEvent {
  return {
    key,
    code,
    ctrlKey: modifiers.ctrlKey ?? false,
    shiftKey: modifiers.shiftKey ?? false,
    altKey: modifiers.altKey ?? false,
    metaKey: modifiers.metaKey ?? false,
    timeStamp: 0,
  } as KeyboardEvent;
}

export function runCommandHotkeysContractTest(): void {
  clearQueueModifierState();
  for (const presetId of COMMAND_HOTKEY_PRESET_IDS) {
    const preset = getCommandHotkeyPreset(presetId);
    for (const commandId of COMMAND_HOTKEY_IDS) {
      const bindings = preset[commandId];
      assertContract(
        bindings.length > 0,
        `${presetId}.${commandId} must have at least one binding`,
      );
      assertContract(
        commandHotkeyLabel(commandId, presetId).length > 0,
        `${presetId}.${commandId} must have a visible label`,
      );
    }

    const conflicts = getCommandHotkeyConflicts(presetId);
    assertContract(
      conflicts.length === 0,
      `${presetId} has conflicting command hotkeys: ${
        conflicts.map((conflict) => `${conflict.signature} => ${conflict.commandIds.join(',')}`).join('; ')
      }`,
    );
  }

  const sequenceResolver = new CommandHotkeySequenceResolver();
  const firstFireToggleChord = sequenceResolver.resolve(keyEvent('l', 'KeyL'), 'bar-grid', 0);
  assertContract(
    firstFireToggleChord.commandId === null && firstFireToggleChord.pending,
    'bar-grid command.fireToggle first L should start a pending L L sequence',
  );
  const secondFireToggleChord = sequenceResolver.resolve(keyEvent('l', 'KeyL'), 'bar-grid', 100);
  assertContract(
    secondFireToggleChord.commandId === 'command.fireToggle' && !secondFireToggleChord.pending,
    'bar-grid command.fireToggle L L sequence should resolve on the second L',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('a', 'KeyA'), 'bar-grid') === 'combat.attack',
    'single-chord hotkey resolution should still resolve bar-grid A attack',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('a', 'KeyA'), 'bar-grid', 'buildMenu') === 'build.slot5',
    'build-menu hotkey resolution should resolve bar-grid A as build slot 5',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('q', 'KeyQ'), 'bar-grid', 'buildMenu') === 'build.slot9',
    'build-menu hotkey resolution should resolve bar-grid Q as build slot 9',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('t', 'KeyT'), 'bar-grid') === 'command.repeat',
    'bar-grid T should resolve repeat orders',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('p', 'KeyP'), 'bar-grid') === 'command.gatherWait',
    'bar-grid P should resolve gather wait',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('q', 'KeyQ', { ctrlKey: true }), 'bar-grid') === 'select.previous',
    'bar-grid Ctrl+Q should resolve previous selection',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('q', 'KeyQ', { altKey: true }), 'bar-grid') === 'select.mobileOnly',
    'bar-grid Alt+Q should resolve mobile-only selection',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('c', 'KeyC'), 'bar-grid') === 'combat.capture',
    'bar-grid C should resolve capture',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('d', 'KeyD', { altKey: true }), 'bar-grid') === 'combat.manualLaunch',
    'bar-grid Alt+D should resolve manual launch',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('r', 'KeyR', { ctrlKey: true, altKey: true }), 'bar-grid') === 'combat.resurrect',
    'bar-grid Ctrl+Alt+R should resolve resurrect',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('r', 'KeyR', { ctrlKey: true, shiftKey: true, altKey: true }), 'bar-grid') === 'combat.resurrectArea',
    'bar-grid Ctrl+Alt+Shift+R should resolve resurrect area',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('j', 'KeyJ'), 'bar-grid') === 'combat.loadTransport',
    'bar-grid J should resolve load transport',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('u', 'KeyU'), 'bar-grid') === 'combat.unloadTransport',
    'bar-grid U should resolve unload transport',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('r', 'KeyR', { ctrlKey: true }), 'bar-grid') === 'select.idleTransports',
    'bar-grid Ctrl+R should resolve idle transports',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('l', 'KeyL'), 'bar-legacy') === 'combat.loadTransport',
    'bar-legacy L should resolve load transport',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('u', 'KeyU'), 'bar-legacy') === 'combat.unloadTransport',
    'bar-legacy U should resolve unload transport',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('l', 'KeyL', { ctrlKey: true, altKey: true }), 'bar-legacy') === 'command.fireToggle',
    'bar-legacy Ctrl+Alt+L should resolve fire state without swallowing load transport',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('l', 'KeyL', { ctrlKey: true, shiftKey: true }), 'bar-legacy') === 'ui.mapLabel',
    'bar-legacy Ctrl+Shift+L should resolve map label without colliding with fire state',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('e', 'KeyE', { altKey: true }), 'prototype') === 'combat.capture',
    'prototype Alt+E should resolve capture without colliding with reclaim',
  );
  assertContract(
    resolveCommandHotkey(keyEvent(';', 'Semicolon'), 'bar-grid') === 'command.moveState',
    'bar-grid semicolon should resolve move state',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('m', 'KeyM', { ctrlKey: true, altKey: true }), 'bar-grid') === 'formation.assume',
    'bar-grid Ctrl+Alt+M should resolve assume formation',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('f', 'KeyF', { ctrlKey: true, altKey: true }), 'bar-grid') === 'formation.move',
    'bar-grid Ctrl+Alt+F should resolve move in formation',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('z', 'KeyZ', { altKey: true }), 'bar-grid') === 'build.spacingIncrease',
    'bar-grid Alt+Z should resolve build spacing increase',
  );
  assertContract(
    resolveCommandHotkey(keyEvent(']', 'BracketRight'), 'bar-grid') === 'build.rotateClockwise',
    'bar-grid ] should resolve build rotate clockwise',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('g', 'KeyG', { ctrlKey: true }), 'bar-grid') === 'command.factoryGuard',
    'bar-grid Ctrl+G should resolve factory guard',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('g', 'KeyG'), 'bar-grid', 'factory') === 'factory.stopProduction',
    'factory-scoped bar-grid G should resolve stop production',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('g', 'KeyG'), 'bar-grid') === 'command.stop',
    'global bar-grid G should still resolve unit stop',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('u', 'KeyU', { altKey: true }), 'bar-grid') === 'command.upgradeMexSelected',
    'bar-grid Alt+U should resolve selected metal extractor upgrade',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('u', 'KeyU', { ctrlKey: true, altKey: true }), 'bar-grid') === 'command.upgradeMexArea',
    'bar-grid Ctrl+Alt+U should resolve area metal extractor upgrade',
  );
  assertContract(
    queueModeFromEvent(keyEvent('w', 'KeyW')).queue === false,
    'plain command event must replace the active order',
  );
  assertContract(
    queueModeFromEvent(keyEvent('w', 'KeyW', { shiftKey: true })).queue === true,
    'shift command event must append to the queue',
  );
  const frontQueue = queueModeFromEvent(keyEvent('w', 'KeyW', { ctrlKey: true, shiftKey: true }));
  assertContract(
    frontQueue.queue === true && frontQueue.queueFront === true && frontQueue.queueInsertIndex === undefined,
    'ctrl/cmd+shift command event must insert after the active order',
  );
  const indexedQueue = queueModeFromEvent(keyEvent('w', 'KeyW', { altKey: true, shiftKey: true }));
  assertContract(
    indexedQueue.queue === true && indexedQueue.queueFront === false && indexedQueue.queueInsertIndex === 1,
    'alt+shift command event must insert at the first queued order slot',
  );
  const pickedQueue = queueModeFromEvent(keyEvent('w', 'KeyW', { shiftKey: true }), 3);
  assertContract(
    pickedQueue.queue === true && pickedQueue.queueFront === false && pickedQueue.queueInsertIndex === 3,
    'shift command event must use the selected queue insertion slot',
  );
  const pickedFrontQueue = queueModeFromEvent(keyEvent('w', 'KeyW', { ctrlKey: true, shiftKey: true }), 3);
  assertContract(
    pickedFrontQueue.queue === true &&
      pickedFrontQueue.queueFront === true &&
      pickedFrontQueue.queueInsertIndex === undefined,
    'ctrl/cmd+shift command event must override the selected queue insertion slot',
  );
  const queuedDragStart = queueModeFromEvent(keyEvent('w', 'KeyW', { shiftKey: true }), 4);
  const plainDragRelease = queueModeFromEvent(keyEvent('w', 'KeyW'));
  const preservedDragQueue = queueModeForDragRelease(queuedDragStart, plainDragRelease);
  assertContract(
    preservedDragQueue.queue === true &&
      preservedDragQueue.queueFront === false &&
      preservedDragQueue.queueInsertIndex === 4,
    'right-drag release must preserve queue mode captured at drag start',
  );
  const lateQueuedDragRelease = queueModeForDragRelease(
    plainDragRelease,
    queueModeFromEvent(keyEvent('w', 'KeyW', { ctrlKey: true, shiftKey: true }), 4),
  );
  assertContract(
    lateQueuedDragRelease.queue === true &&
      lateQueuedDragRelease.queueFront === true &&
      lateQueuedDragRelease.queueInsertIndex === undefined,
    'right-drag release must still allow shift queueing pressed before release',
  );
  setQueueModifierKeyState(keyEvent('Shift', 'ShiftLeft'), true);
  const trackedShiftQueue = queueModeFromEvent(keyEvent('w', 'KeyW'), 2);
  assertContract(
    trackedShiftQueue.queue === true &&
      trackedShiftQueue.queueFront === false &&
      trackedShiftQueue.queueInsertIndex === 2,
    'tracked shift key state must queue commands when pointer events omit shiftKey',
  );
  setQueueModifierKeyState(keyEvent('Shift', 'ShiftLeft'), false);
  assertContract(
    queueModeFromEvent(keyEvent('w', 'KeyW')).queue === false,
    'tracked shift keyup must stop queueing commands',
  );
  const modifierStateQueue = queueModeFromEvent({
    ...keyEvent('w', 'KeyW'),
    getModifierState: (keyArg: string) => keyArg === 'Shift',
  });
  assertContract(
    modifierStateQueue.queue === true,
    'browser modifier state must queue commands when shiftKey is false',
  );
  clearQueueModifierState();
}
