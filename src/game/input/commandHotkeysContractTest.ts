import {
  COMMAND_HOTKEY_IDS,
  COMMAND_HOTKEY_PRESET_IDS,
  COMMAND_HOTKEY_PRESETS,
  commandHotkeyLabel,
  getCommandHotkeyConflicts,
} from './commandHotkeys';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[command hotkeys contract] ${message}`);
  }
}

export function runCommandHotkeysContractTest(): void {
  for (const presetId of COMMAND_HOTKEY_PRESET_IDS) {
    const preset = COMMAND_HOTKEY_PRESETS[presetId];
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
}
