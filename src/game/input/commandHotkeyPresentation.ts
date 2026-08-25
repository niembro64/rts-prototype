import type { CommandHotkeyPresetId } from './commandHotkeys';

/** User-facing names shared by every command-hotkey preset selector. */
export const COMMAND_HOTKEY_PRESET_LABELS: Readonly<Record<CommandHotkeyPresetId, string>> = {
  prototype: 'PROTO',
  'bar-grid': 'GRID',
  'bar-grid-60pct': 'GRID60',
  'bar-legacy': 'LEGACY',
  'bar-legacy-60pct': 'LEG60',
  custom: 'CUSTOM',
};

/** Explanations shared by the in-game editor and controls reference. */
export const COMMAND_HOTKEY_PRESET_DESCRIPTIONS: Readonly<Record<CommandHotkeyPresetId, string>> = {
  prototype: 'prototype defaults',
  'bar-grid': 'BAR grid subset',
  'bar-grid-60pct': 'BAR grid 60% subset',
  'bar-legacy': 'BAR legacy subset',
  'bar-legacy-60pct': 'BAR legacy 60% subset',
  custom: 'local custom bindings',
};
