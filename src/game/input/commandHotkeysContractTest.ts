import {
  COMMAND_HOTKEY_IDS,
  COMMAND_HOTKEY_PRESET_IDS,
  CommandHotkeySequenceResolver,
  commandHotkeyLabel,
  getCommandHotkeyPreset,
  getCommandHotkeyConflicts,
  resolveCommandHotkey,
} from './commandHotkeys';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[command hotkeys contract] ${message}`);
  }
}

function keyEvent(key: string, code: string): KeyboardEvent {
  return {
    key,
    code,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    timeStamp: 0,
  } as KeyboardEvent;
}

export function runCommandHotkeysContractTest(): void {
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
}
