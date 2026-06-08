export type CommandHotkeyId =
  | 'waypoint.move'
  | 'waypoint.fight'
  | 'waypoint.patrol'
  | 'command.stop'
  | 'command.wait'
  | 'command.skipCurrent'
  | 'command.undoQueue'
  | 'command.clearQueue'
  | 'command.fireToggle'
  | 'command.buildingActive'
  | 'command.selfDestruct'
  | 'command.scan'
  | 'command.buildCycle'
  | 'command.dgun'
  | 'command.selectCommander'
  | 'factoryPreset.load1'
  | 'factoryPreset.load2'
  | 'factoryPreset.load3'
  | 'factoryPreset.load4'
  | 'factoryPreset.save1'
  | 'factoryPreset.save2'
  | 'factoryPreset.save3'
  | 'factoryPreset.save4'
  | 'build.slot1'
  | 'build.slot2'
  | 'build.slot3'
  | 'build.slot4'
  | 'select.allUnits'
  | 'select.matching'
  | 'select.matchingInView'
  | 'select.previous'
  | 'select.idleBuilders'
  | 'select.waitingUnits'
  | 'select.sameTypeOnly'
  | 'select.mobileOnly'
  | 'select.invert'
  | 'select.split'
  | 'select.loop'
  | 'combat.attack'
  | 'combat.attackLine'
  | 'combat.attackArea'
  | 'combat.attackGround'
  | 'combat.guard'
  | 'combat.reclaim'
  | 'combat.repairArea'
  | 'combat.ping'
  | 'combat.towerTargetSet'
  | 'combat.towerTargetClear'
  | 'ui.optionsMenu'
  | 'ui.chat'
  | 'ui.mapDraw'
  | 'ui.mapLabel'
  | 'ui.mapErase';

export type BuiltInCommandHotkeyPresetId = 'prototype' | 'bar-grid' | 'bar-legacy';
export type CommandHotkeyPresetId = BuiltInCommandHotkeyPresetId | 'custom';

type ModifierMatch = boolean | 'any';

export type CommandKeyChord = {
  key?: string;
  code?: string;
  ctrl?: ModifierMatch;
  shift?: ModifierMatch;
  alt?: ModifierMatch;
  meta?: ModifierMatch;
  label: string;
};

export type CommandHotkeyBinding = readonly CommandKeyChord[];
export type CommandHotkeyPreset = Readonly<Record<CommandHotkeyId, readonly CommandHotkeyBinding[]>>;
type ChordOptions = Partial<Omit<CommandKeyChord, 'key' | 'code' | 'label'>>;
type CustomCommandHotkeyOverrides = Partial<Record<CommandHotkeyId, CommandHotkeyBinding>>;

export const COMMAND_HOTKEY_STORAGE_KEY = 'budget-annihilation.commandHotkeyPreset';
export const COMMAND_HOTKEY_CUSTOM_STORAGE_KEY = 'budget-annihilation.customCommandHotkeys';
export const DEFAULT_COMMAND_HOTKEY_PRESET: CommandHotkeyPresetId = 'prototype';

export const COMMAND_HOTKEY_IDS: readonly CommandHotkeyId[] = [
  'waypoint.move',
  'waypoint.fight',
  'waypoint.patrol',
  'command.stop',
  'command.wait',
  'command.skipCurrent',
  'command.undoQueue',
  'command.clearQueue',
  'command.fireToggle',
  'command.buildingActive',
  'command.selfDestruct',
  'command.scan',
  'command.buildCycle',
  'command.dgun',
  'command.selectCommander',
  'factoryPreset.load1',
  'factoryPreset.load2',
  'factoryPreset.load3',
  'factoryPreset.load4',
  'factoryPreset.save1',
  'factoryPreset.save2',
  'factoryPreset.save3',
  'factoryPreset.save4',
  'build.slot1',
  'build.slot2',
  'build.slot3',
  'build.slot4',
  'select.allUnits',
  'select.matching',
  'select.matchingInView',
  'select.previous',
  'select.idleBuilders',
  'select.waitingUnits',
  'select.sameTypeOnly',
  'select.mobileOnly',
  'select.invert',
  'select.split',
  'select.loop',
  'combat.attack',
  'combat.attackLine',
  'combat.attackArea',
  'combat.attackGround',
  'combat.guard',
  'combat.reclaim',
  'combat.repairArea',
  'combat.ping',
  'combat.towerTargetSet',
  'combat.towerTargetClear',
  'ui.optionsMenu',
  'ui.chat',
  'ui.mapDraw',
  'ui.mapLabel',
  'ui.mapErase',
];

export const COMMAND_HOTKEY_PRESET_IDS: readonly CommandHotkeyPresetId[] = [
  'prototype',
  'bar-grid',
  'bar-legacy',
  'custom',
];

export const COMMAND_HOTKEY_DISPLAY_LABELS: Readonly<Record<CommandHotkeyId, string>> = {
  'waypoint.move': 'Waypoint: Move',
  'waypoint.fight': 'Waypoint: Fight',
  'waypoint.patrol': 'Waypoint: Patrol',
  'command.stop': 'Stop',
  'command.wait': 'Wait',
  'command.skipCurrent': 'Skip Current Order',
  'command.undoQueue': 'Cancel Last Order',
  'command.clearQueue': 'Clear Orders',
  'command.fireToggle': 'Fire Toggle',
  'command.buildingActive': 'Building On/Off',
  'command.selfDestruct': 'Self Destruct',
  'command.scan': 'Scanner Sweep',
  'command.buildCycle': 'Cycle Build',
  'command.dgun': 'Commander DGun',
  'command.selectCommander': 'Select Commander',
  'factoryPreset.load1': 'Load Factory Preset 1',
  'factoryPreset.load2': 'Load Factory Preset 2',
  'factoryPreset.load3': 'Load Factory Preset 3',
  'factoryPreset.load4': 'Load Factory Preset 4',
  'factoryPreset.save1': 'Save Factory Preset 1',
  'factoryPreset.save2': 'Save Factory Preset 2',
  'factoryPreset.save3': 'Save Factory Preset 3',
  'factoryPreset.save4': 'Save Factory Preset 4',
  'build.slot1': 'Build Slot 1',
  'build.slot2': 'Build Slot 2',
  'build.slot3': 'Build Slot 3',
  'build.slot4': 'Build Slot 4',
  'select.allUnits': 'Select All Units',
  'select.matching': 'Select Matching',
  'select.matchingInView': 'Select Matching In View',
  'select.previous': 'Previous Selection',
  'select.idleBuilders': 'Idle Builders',
  'select.waitingUnits': 'Waiting Units',
  'select.sameTypeOnly': 'Keep Same Type',
  'select.mobileOnly': 'Keep Mobile',
  'select.invert': 'Invert Selection',
  'select.split': 'Split Selection',
  'select.loop': 'Loop Selection',
  'combat.attack': 'Attack',
  'combat.attackLine': 'Attack Line',
  'combat.attackArea': 'Attack Area',
  'combat.attackGround': 'Attack Ground',
  'combat.guard': 'Guard',
  'combat.reclaim': 'Reclaim',
  'combat.repairArea': 'Repair Area',
  'combat.ping': 'Ping',
  'combat.towerTargetSet': 'Tower Target',
  'combat.towerTargetClear': 'Clear Tower Target',
  'ui.optionsMenu': 'Options Menu',
  'ui.chat': 'Chat',
  'ui.mapDraw': 'Draw On Map',
  'ui.mapLabel': 'Draw Map Label',
  'ui.mapErase': 'Erase Map Drawings',
};

function key(label: string, keyValue: string, options: ChordOptions = {}): CommandHotkeyBinding {
  return [{ key: keyValue.toLowerCase(), label, ...options }];
}

function code(label: string, codeValue: string, options: ChordOptions = {}): CommandHotkeyBinding {
  return [{ code: codeValue, label, ...options }];
}

function sequence(...chords: CommandKeyChord[]): CommandHotkeyBinding {
  return chords;
}

function commandPreset(
  entries: Record<CommandHotkeyId, readonly CommandHotkeyBinding[]>,
): CommandHotkeyPreset {
  return entries;
}

export const COMMAND_HOTKEY_PRESETS: Readonly<Record<BuiltInCommandHotkeyPresetId, CommandHotkeyPreset>> = {
  prototype: commandPreset({
    'waypoint.move': [key('M', 'm', { shift: 'any' })],
    'waypoint.fight': [key('F', 'f', { shift: 'any' })],
    'waypoint.patrol': [key('H', 'h', { shift: 'any' })],
    'command.stop': [key('S', 's', { shift: 'any' })],
    'command.wait': [
      key('W', 'w', { shift: 'any' }),
      key('Ctrl+Shift+W', 'w', { ctrl: true, shift: true }),
    ],
    'command.skipCurrent': [key('N', 'n', { shift: 'any' })],
    'command.undoQueue': [key('U', 'u', { shift: 'any' })],
    'command.clearQueue': [key('X', 'x', { shift: 'any' })],
    'command.fireToggle': [key('E', 'e', { shift: 'any' })],
    'command.buildingActive': [key('O', 'o', { shift: 'any' })],
    'command.selfDestruct': [key('K', 'k', { shift: 'any' })],
    'command.scan': [key('Y', 'y', { shift: 'any' })],
    'command.buildCycle': [key('B', 'b', { shift: 'any' })],
    'command.dgun': [key('D', 'd', { shift: 'any' })],
    'command.selectCommander': [key('Tab', 'tab', { shift: 'any' })],
    'factoryPreset.load1': [code('Ctrl+Alt+Z', 'KeyZ', { ctrl: true, alt: true })],
    'factoryPreset.load2': [code('Ctrl+Alt+X', 'KeyX', { ctrl: true, alt: true })],
    'factoryPreset.load3': [code('Ctrl+Alt+C', 'KeyC', { ctrl: true, alt: true })],
    'factoryPreset.load4': [code('Ctrl+Alt+V', 'KeyV', { ctrl: true, alt: true })],
    'factoryPreset.save1': [code('Ctrl+Alt+Shift+Z', 'KeyZ', { ctrl: true, alt: true, shift: true })],
    'factoryPreset.save2': [code('Ctrl+Alt+Shift+X', 'KeyX', { ctrl: true, alt: true, shift: true })],
    'factoryPreset.save3': [code('Ctrl+Alt+Shift+C', 'KeyC', { ctrl: true, alt: true, shift: true })],
    'factoryPreset.save4': [code('Ctrl+Alt+Shift+V', 'KeyV', { ctrl: true, alt: true, shift: true })],
    'build.slot1': [code('1', 'Digit1', { shift: 'any' })],
    'build.slot2': [code('2', 'Digit2', { shift: 'any' })],
    'build.slot3': [code('3', 'Digit3', { shift: 'any' })],
    'build.slot4': [code('4', 'Digit4', { shift: 'any' })],
    'select.allUnits': [key('Ctrl+A', 'a', { ctrl: true })],
    'select.matching': [key('Ctrl+Z', 'z', { ctrl: true })],
    'select.matchingInView': [key('Alt+W', 'w', { alt: true })],
    'select.previous': [key('Alt+P', 'p', { alt: true })],
    'select.idleBuilders': [key('Ctrl+B', 'b', { ctrl: true })],
    'select.waitingUnits': [key('Ctrl+Y', 'y', { ctrl: true })],
    'select.sameTypeOnly': [key('Alt+Z', 'z', { alt: true })],
    'select.mobileOnly': [key('Alt+M', 'm', { alt: true })],
    'select.invert': [key('Alt+I', 'i', { alt: true })],
    'select.split': [key('Alt+S', 's', { alt: true })],
    'select.loop': [key('Alt+L', 'l', { alt: true })],
    'combat.attack': [key('V', 'v', { shift: 'any' })],
    'combat.attackLine': [key('Alt+V', 'v', { alt: true })],
    'combat.attackArea': [key('A', 'a', { shift: 'any' })],
    'combat.attackGround': [key('T', 't', { shift: 'any' })],
    'combat.guard': [key('G', 'g', { shift: 'any' })],
    'combat.reclaim': [key('C', 'c', { shift: 'any' })],
    'combat.repairArea': [key('R', 'r', { shift: 'any' })],
    'combat.ping': [key('P', 'p', { shift: 'any' })],
    'combat.towerTargetSet': [key('L', 'l', { shift: 'any' })],
    'combat.towerTargetClear': [key('J', 'j', { shift: 'any' })],
    'ui.optionsMenu': [code('F10', 'F10', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'ui.chat': [key('Enter', 'enter', { shift: 'any' })],
    'ui.mapDraw': [code('Ctrl+Shift+D', 'KeyD', { ctrl: true, shift: true })],
    'ui.mapLabel': [code('Ctrl+Shift+L', 'KeyL', { ctrl: true, shift: true })],
    'ui.mapErase': [code('Ctrl+Shift+E', 'KeyE', { ctrl: true, shift: true })],
  }),
  'bar-grid': commandPreset({
    'waypoint.move': [code('M', 'KeyM', { shift: 'any' })],
    'waypoint.fight': [code('F', 'KeyF', { shift: 'any' })],
    'waypoint.patrol': [code('H', 'KeyH', { shift: 'any' })],
    'command.stop': [code('G', 'KeyG', { shift: 'any' })],
    'command.wait': [
      code('Y', 'KeyY', { shift: 'any' }),
      code('Ctrl+Shift+Y', 'KeyY', { ctrl: true, shift: true }),
    ],
    'command.skipCurrent': [code('N', 'KeyN', { shift: 'any' })],
    'command.undoQueue': [code('Ctrl+N', 'KeyN', { ctrl: true })],
    'command.clearQueue': [code('Ctrl+Shift+N', 'KeyN', { ctrl: true, shift: true })],
    'command.fireToggle': [
      sequence(
        { code: 'KeyL', label: 'L' },
        { code: 'KeyL', label: 'L' },
      ),
      code('L', 'KeyL', { shift: 'any' }),
    ],
    'command.buildingActive': [
      sequence(
        { code: 'KeyB', label: 'B' },
        { code: 'KeyB', label: 'B' },
      ),
      code('B', 'KeyB', { shift: 'any' }),
    ],
    'command.selfDestruct': [code('Ctrl+B', 'KeyB', { ctrl: true, shift: 'any' })],
    'command.scan': [code('F7', 'F7', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'command.buildCycle': [code('Alt+B', 'KeyB', { alt: true, shift: 'any' })],
    'command.dgun': [code('D', 'KeyD', { shift: 'any' })],
    'command.selectCommander': [
      key('Tab', 'tab'),
      key('Shift+Tab', 'tab', { shift: true }),
    ],
    'factoryPreset.load1': [code('Ctrl+Alt+Z', 'KeyZ', { ctrl: true, alt: true })],
    'factoryPreset.load2': [code('Ctrl+Alt+X', 'KeyX', { ctrl: true, alt: true })],
    'factoryPreset.load3': [code('Ctrl+Alt+C', 'KeyC', { ctrl: true, alt: true })],
    'factoryPreset.load4': [code('Ctrl+Alt+V', 'KeyV', { ctrl: true, alt: true })],
    'factoryPreset.save1': [code('Ctrl+Alt+Shift+Z', 'KeyZ', { ctrl: true, alt: true, shift: true })],
    'factoryPreset.save2': [code('Ctrl+Alt+Shift+X', 'KeyX', { ctrl: true, alt: true, shift: true })],
    'factoryPreset.save3': [code('Ctrl+Alt+Shift+C', 'KeyC', { ctrl: true, alt: true, shift: true })],
    'factoryPreset.save4': [code('Ctrl+Alt+Shift+V', 'KeyV', { ctrl: true, alt: true, shift: true })],
    'build.slot1': [code('Z', 'KeyZ', { shift: 'any' })],
    'build.slot2': [code('X', 'KeyX', { shift: 'any' })],
    'build.slot3': [code('C', 'KeyC', { shift: 'any' })],
    'build.slot4': [code('V', 'KeyV', { shift: 'any' })],
    'select.allUnits': [code('Ctrl+E', 'KeyE', { ctrl: true })],
    'select.matching': [code('Ctrl+W', 'KeyW', { ctrl: true })],
    'select.matchingInView': [code('Alt+W', 'KeyW', { alt: true })],
    'select.previous': [code('Alt+P', 'KeyP', { alt: true })],
    'select.idleBuilders': [key('Ctrl+Tab', 'tab', { ctrl: true })],
    'select.waitingUnits': [code('Ctrl+Y', 'KeyY', { ctrl: true })],
    'select.sameTypeOnly': [code('Q', 'KeyQ', { shift: 'any' })],
    'select.mobileOnly': [code('Alt+M', 'KeyM', { alt: true })],
    'select.invert': [code('Alt+I', 'KeyI', { alt: true })],
    'select.split': [code('Alt+S', 'KeyS', { alt: true })],
    'select.loop': [code('Alt+L', 'KeyL', { alt: true })],
    'combat.attack': [code('A', 'KeyA', { shift: 'any' })],
    'combat.attackLine': [code('Ctrl+Alt+A', 'KeyA', { ctrl: true, alt: true, shift: 'any' })],
    'combat.attackArea': [code('Ctrl+A', 'KeyA', { ctrl: true, shift: 'any' })],
    'combat.attackGround': [code('Alt+T', 'KeyT', { alt: true, shift: 'any' })],
    'combat.guard': [code('O', 'KeyO', { shift: 'any' })],
    'combat.reclaim': [code('E', 'KeyE', { shift: 'any' })],
    'combat.repairArea': [code('R', 'KeyR', { shift: 'any' })],
    'combat.ping': [code('`', 'Backquote', { shift: 'any' })],
    'combat.towerTargetSet': [code('S', 'KeyS', { shift: 'any' })],
    'combat.towerTargetClear': [code('Ctrl+S', 'KeyS', { ctrl: true, shift: 'any' })],
    'ui.optionsMenu': [code('F10', 'F10', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'ui.chat': [key('Enter', 'enter', { shift: 'any' })],
    'ui.mapDraw': [code('Ctrl+Alt+D', 'KeyD', { ctrl: true, alt: true, shift: 'any' })],
    'ui.mapLabel': [code('Ctrl+Alt+L', 'KeyL', { ctrl: true, alt: true, shift: 'any' })],
    'ui.mapErase': [code('Ctrl+Alt+E', 'KeyE', { ctrl: true, alt: true, shift: 'any' })],
  }),
  'bar-legacy': commandPreset({
    'waypoint.move': [code('M', 'KeyM', { shift: 'any' })],
    'waypoint.fight': [code('F', 'KeyF', { shift: 'any' })],
    'waypoint.patrol': [code('P', 'KeyP', { shift: 'any' })],
    'command.stop': [code('S', 'KeyS', { shift: 'any' })],
    'command.wait': [
      code('W', 'KeyW', { shift: 'any' }),
      code('Ctrl+Shift+W', 'KeyW', { ctrl: true, shift: true }),
    ],
    'command.skipCurrent': [code('N', 'KeyN', { shift: 'any' })],
    'command.undoQueue': [code('Ctrl+N', 'KeyN', { ctrl: true })],
    'command.clearQueue': [code('Ctrl+Shift+N', 'KeyN', { ctrl: true, shift: true })],
    'command.fireToggle': [code('L', 'KeyL', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'command.buildingActive': [code('O', 'KeyO', { shift: 'any' })],
    'command.selfDestruct': [code('Ctrl+D', 'KeyD', { ctrl: true, shift: 'any' })],
    'command.scan': [code('F4', 'F4', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'command.buildCycle': [code('B', 'KeyB', { shift: 'any' })],
    'command.dgun': [code('D', 'KeyD', { shift: 'any' })],
    'command.selectCommander': [
      code('Ctrl+C', 'KeyC', { ctrl: true, shift: 'any' }),
      key('Tab', 'tab', { shift: 'any' }),
    ],
    'factoryPreset.load1': [code('Ctrl+Alt+Z', 'KeyZ', { ctrl: true, alt: true })],
    'factoryPreset.load2': [code('Ctrl+Alt+X', 'KeyX', { ctrl: true, alt: true })],
    'factoryPreset.load3': [code('Ctrl+Alt+C', 'KeyC', { ctrl: true, alt: true })],
    'factoryPreset.load4': [code('Ctrl+Alt+V', 'KeyV', { ctrl: true, alt: true })],
    'factoryPreset.save1': [code('Ctrl+Alt+Shift+Z', 'KeyZ', { ctrl: true, alt: true, shift: true })],
    'factoryPreset.save2': [code('Ctrl+Alt+Shift+X', 'KeyX', { ctrl: true, alt: true, shift: true })],
    'factoryPreset.save3': [code('Ctrl+Alt+Shift+C', 'KeyC', { ctrl: true, alt: true, shift: true })],
    'factoryPreset.save4': [code('Ctrl+Alt+Shift+V', 'KeyV', { ctrl: true, alt: true, shift: true })],
    'build.slot1': [code('Z', 'KeyZ', { shift: 'any' })],
    'build.slot2': [code('X', 'KeyX', { shift: 'any' })],
    'build.slot3': [code('C', 'KeyC', { shift: 'any' })],
    'build.slot4': [code('V', 'KeyV', { shift: 'any' })],
    'select.allUnits': [code('Ctrl+A', 'KeyA', { ctrl: true })],
    'select.matching': [code('Ctrl+Z', 'KeyZ', { ctrl: true })],
    'select.matchingInView': [code('Alt+W', 'KeyW', { alt: true })],
    'select.previous': [code('Alt+P', 'KeyP', { alt: true })],
    'select.idleBuilders': [code('Ctrl+B', 'KeyB', { ctrl: true })],
    'select.waitingUnits': [code('Ctrl+Y', 'KeyY', { ctrl: true })],
    'select.sameTypeOnly': [code('Ctrl+X', 'KeyX', { ctrl: true })],
    'select.mobileOnly': [code('Alt+M', 'KeyM', { alt: true })],
    'select.invert': [code('Alt+I', 'KeyI', { alt: true })],
    'select.split': [code('Alt+S', 'KeyS', { alt: true })],
    'select.loop': [code('Alt+L', 'KeyL', { alt: true })],
    'combat.attack': [code('A', 'KeyA', { shift: 'any' })],
    'combat.attackLine': [code('Ctrl+Alt+A', 'KeyA', { ctrl: true, alt: true, shift: 'any' })],
    'combat.attackArea': [code('Alt+A', 'KeyA', { alt: true, shift: 'any' })],
    'combat.attackGround': [code('T', 'KeyT', { shift: 'any' })],
    'combat.guard': [code('G', 'KeyG', { shift: 'any' })],
    'combat.reclaim': [code('E', 'KeyE', { shift: 'any' })],
    'combat.repairArea': [code('R', 'KeyR', { shift: 'any' })],
    'combat.ping': [code('`', 'Backquote', { shift: 'any' })],
    'combat.towerTargetSet': [code('Alt+Y', 'KeyY', { alt: true, shift: 'any' })],
    'combat.towerTargetClear': [code('J', 'KeyJ', { shift: 'any' })],
    'ui.optionsMenu': [code('F10', 'F10', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'ui.chat': [key('Enter', 'enter', { shift: 'any' })],
    'ui.mapDraw': [code('Ctrl+Alt+D', 'KeyD', { ctrl: true, alt: true, shift: 'any' })],
    'ui.mapLabel': [code('Ctrl+Alt+L', 'KeyL', { ctrl: true, alt: true, shift: 'any' })],
    'ui.mapErase': [code('Ctrl+Alt+E', 'KeyE', { ctrl: true, alt: true, shift: 'any' })],
  }),
};

export type CommandHotkeyConflict = {
  presetId: CommandHotkeyPresetId;
  signature: string;
  commandIds: CommandHotkeyId[];
};

export type CommandHotkeyResolution = {
  commandId: CommandHotkeyId | null;
  pending: boolean;
};

const COMMAND_HOTKEY_SEQUENCE_TIMEOUT_MS = 900;

type PendingCommandHotkeySequence = {
  presetId: CommandHotkeyPresetId;
  commandId: CommandHotkeyId;
  binding: CommandHotkeyBinding;
  nextChordIndex: number;
  expiresAtMs: number;
};

export function getActiveCommandHotkeyPresetId(): CommandHotkeyPresetId {
  if (typeof window === 'undefined') return DEFAULT_COMMAND_HOTKEY_PRESET;
  const stored = window.localStorage.getItem(COMMAND_HOTKEY_STORAGE_KEY);
  return isCommandHotkeyPresetId(stored) ? stored : DEFAULT_COMMAND_HOTKEY_PRESET;
}

export function setActiveCommandHotkeyPresetId(presetId: CommandHotkeyPresetId): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(COMMAND_HOTKEY_STORAGE_KEY, presetId);
}

export function isCommandHotkeyPresetId(value: unknown): value is CommandHotkeyPresetId {
  return COMMAND_HOTKEY_PRESET_IDS.includes(value as CommandHotkeyPresetId);
}

export function getCommandHotkeyPreset(presetId: CommandHotkeyPresetId): CommandHotkeyPreset {
  if (presetId !== 'custom') return COMMAND_HOTKEY_PRESETS[presetId];
  const overrides = loadCustomCommandHotkeyOverrides();
  const entries = {} as Record<CommandHotkeyId, readonly CommandHotkeyBinding[]>;
  for (const commandId of COMMAND_HOTKEY_IDS) {
    const override = overrides[commandId];
    entries[commandId] = override === undefined
      ? COMMAND_HOTKEY_PRESETS.prototype[commandId]
      : [override];
  }
  return commandPreset(entries);
}

export function createCommandHotkeyChordFromEvent(event: KeyboardEvent): CommandKeyChord | null {
  if (isModifierOnlyKey(event.key) || event.key === 'Escape') return null;
  const label = keyboardEventLabel(event);
  if (label === '') return null;
  const chord: CommandKeyChord = {
    code: event.code !== '' ? event.code : undefined,
    key: event.code === '' ? event.key.toLowerCase() : undefined,
    label,
  };
  if (event.ctrlKey) chord.ctrl = true;
  if (event.shiftKey) chord.shift = true;
  if (event.altKey) chord.alt = true;
  if (event.metaKey) chord.meta = true;
  return chord;
}

export function setCustomCommandHotkeyBinding(
  commandId: CommandHotkeyId,
  binding: CommandHotkeyBinding,
): void {
  if (typeof window === 'undefined') return;
  const overrides = loadCustomCommandHotkeyOverrides();
  overrides[commandId] = binding;
  saveCustomCommandHotkeyOverrides(overrides);
}

export function resetCustomCommandHotkeyBinding(commandId: CommandHotkeyId): void {
  if (typeof window === 'undefined') return;
  const overrides = loadCustomCommandHotkeyOverrides();
  delete overrides[commandId];
  saveCustomCommandHotkeyOverrides(overrides);
}

export function resetAllCustomCommandHotkeys(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(COMMAND_HOTKEY_CUSTOM_STORAGE_KEY);
}

export function commandHotkeyLabel(
  commandId: CommandHotkeyId,
  presetId: CommandHotkeyPresetId = getActiveCommandHotkeyPresetId(),
): string {
  const firstBinding = getCommandHotkeyPreset(presetId)[commandId][0];
  return bindingLabel(firstBinding);
}

export function commandHotkeyLabels(
  commandId: CommandHotkeyId,
  presetId: CommandHotkeyPresetId = getActiveCommandHotkeyPresetId(),
): string[] {
  return getCommandHotkeyPreset(presetId)[commandId].map(bindingLabel);
}

export function resolveCommandHotkey(
  event: KeyboardEvent,
  presetId: CommandHotkeyPresetId = getActiveCommandHotkeyPresetId(),
): CommandHotkeyId | null {
  return resolveSingleChordCommandHotkey(event, presetId);
}

export class CommandHotkeySequenceResolver {
  private pendingSequence: PendingCommandHotkeySequence | null = null;

  resolve(
    event: KeyboardEvent,
    presetId: CommandHotkeyPresetId = getActiveCommandHotkeyPresetId(),
    timeMs: number = event.timeStamp,
  ): CommandHotkeyResolution {
    const nowMs = Number.isFinite(timeMs) ? timeMs : 0;
    if (
      this.pendingSequence !== null &&
      (
        this.pendingSequence.presetId !== presetId ||
        nowMs > this.pendingSequence.expiresAtMs
      )
    ) {
      this.pendingSequence = null;
    }

    if (this.pendingSequence !== null) {
      const sequence = this.pendingSequence;
      if (keyChordMatchesEvent(sequence.binding[sequence.nextChordIndex], event)) {
        const nextChordIndex = sequence.nextChordIndex + 1;
        if (nextChordIndex >= sequence.binding.length) {
          const commandId = sequence.commandId;
          this.pendingSequence = null;
          return { commandId, pending: false };
        }
        this.pendingSequence = {
          ...sequence,
          nextChordIndex,
          expiresAtMs: nowMs + COMMAND_HOTKEY_SEQUENCE_TIMEOUT_MS,
        };
        return { commandId: null, pending: true };
      }
      this.pendingSequence = null;
    }

    const sequence = findMatchingSequenceStart(event, presetId);
    if (sequence !== null) {
      this.pendingSequence = {
        ...sequence,
        nextChordIndex: 1,
        expiresAtMs: nowMs + COMMAND_HOTKEY_SEQUENCE_TIMEOUT_MS,
      };
      return { commandId: null, pending: true };
    }

    return {
      commandId: resolveSingleChordCommandHotkey(event, presetId),
      pending: false,
    };
  }

  reset(): void {
    this.pendingSequence = null;
  }
}

function resolveSingleChordCommandHotkey(
  event: KeyboardEvent,
  presetId: CommandHotkeyPresetId,
): CommandHotkeyId | null {
  const preset = getCommandHotkeyPreset(presetId);
  for (const commandId of COMMAND_HOTKEY_IDS) {
    const bindings = preset[commandId];
    for (const binding of bindings) {
      if (binding.length === 1 && keyChordMatchesEvent(binding[0], event)) return commandId;
    }
  }
  return null;
}

function findMatchingSequenceStart(
  event: KeyboardEvent,
  presetId: CommandHotkeyPresetId,
): Omit<PendingCommandHotkeySequence, 'nextChordIndex' | 'expiresAtMs'> | null {
  const preset = getCommandHotkeyPreset(presetId);
  for (const commandId of COMMAND_HOTKEY_IDS) {
    const bindings = preset[commandId];
    for (const binding of bindings) {
      if (binding.length > 1 && keyChordMatchesEvent(binding[0], event)) {
        return { presetId, commandId, binding };
      }
    }
  }
  return null;
}

export function getCommandHotkeyConflicts(
  presetId: CommandHotkeyPresetId,
): CommandHotkeyConflict[] {
  const ownersBySignature = new Map<string, CommandHotkeyId[]>();
  const preset = getCommandHotkeyPreset(presetId);
  for (const commandId of COMMAND_HOTKEY_IDS) {
    for (const binding of preset[commandId]) {
      const signature = bindingSignature(binding);
      const owners = ownersBySignature.get(signature);
      if (owners) owners.push(commandId);
      else ownersBySignature.set(signature, [commandId]);
    }
  }

  const conflicts: CommandHotkeyConflict[] = [];
  for (const [signature, commandIds] of ownersBySignature) {
    const uniqueCommandIds = Array.from(new Set(commandIds));
    if (uniqueCommandIds.length > 1) {
      conflicts.push({ presetId, signature, commandIds: uniqueCommandIds });
    }
  }
  return conflicts;
}

function loadCustomCommandHotkeyOverrides(): CustomCommandHotkeyOverrides {
  if (typeof window === 'undefined') return {};
  let parsed: unknown;
  try {
    const raw = window.localStorage.getItem(COMMAND_HOTKEY_CUSTOM_STORAGE_KEY);
    if (raw === null) return {};
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: CustomCommandHotkeyOverrides = {};
  for (const commandId of COMMAND_HOTKEY_IDS) {
    const rawBinding = (parsed as Record<string, unknown>)[commandId];
    const binding = sanitizeCommandHotkeyBinding(rawBinding);
    if (binding !== null) out[commandId] = binding;
  }
  return out;
}

function saveCustomCommandHotkeyOverrides(overrides: CustomCommandHotkeyOverrides): void {
  const serializable: Record<string, CommandHotkeyBinding> = {};
  for (const commandId of COMMAND_HOTKEY_IDS) {
    const binding = overrides[commandId];
    if (binding !== undefined) serializable[commandId] = binding;
  }
  window.localStorage.setItem(COMMAND_HOTKEY_CUSTOM_STORAGE_KEY, JSON.stringify(serializable));
}

function sanitizeCommandHotkeyBinding(value: unknown): CommandHotkeyBinding | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const chords: CommandKeyChord[] = [];
  for (const rawChord of value) {
    const chord = sanitizeCommandKeyChord(rawChord);
    if (chord === null) return null;
    chords.push(chord);
  }
  return chords;
}

function sanitizeCommandKeyChord(value: unknown): CommandKeyChord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const keyValue = typeof raw.key === 'string' && raw.key !== '' ? raw.key : undefined;
  const codeValue = typeof raw.code === 'string' && raw.code !== '' ? raw.code : undefined;
  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  if ((keyValue === undefined && codeValue === undefined) || label === '') return null;
  const chord: CommandKeyChord = { label };
  if (keyValue !== undefined) chord.key = keyValue.toLowerCase();
  if (codeValue !== undefined) chord.code = codeValue;
  const ctrl = sanitizeModifierMatch(raw.ctrl);
  const shift = sanitizeModifierMatch(raw.shift);
  const alt = sanitizeModifierMatch(raw.alt);
  const meta = sanitizeModifierMatch(raw.meta);
  if (ctrl !== undefined) chord.ctrl = ctrl;
  if (shift !== undefined) chord.shift = shift;
  if (alt !== undefined) chord.alt = alt;
  if (meta !== undefined) chord.meta = meta;
  return chord;
}

function sanitizeModifierMatch(value: unknown): ModifierMatch | undefined {
  return value === true || value === false || value === 'any' ? value : undefined;
}

function keyboardEventLabel(event: KeyboardEvent): string {
  const keyLabel = displayKeyLabel(event.key, event.code);
  if (keyLabel === '') return '';
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.metaKey) parts.push('Cmd');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(keyLabel);
  return parts.join('+');
}

function displayKeyLabel(keyValue: string, codeValue: string): string {
  switch (keyValue) {
    case ' ':
      return 'Space';
    case 'ArrowUp':
      return 'Up';
    case 'ArrowDown':
      return 'Down';
    case 'ArrowLeft':
      return 'Left';
    case 'ArrowRight':
      return 'Right';
    case 'Dead':
    case 'Unidentified':
      return codeValue;
    default:
      break;
  }
  if (keyValue.length === 1) return keyValue.toUpperCase();
  if (/^F\d{1,2}$/.test(keyValue)) return keyValue;
  return keyValue;
}

function isModifierOnlyKey(keyValue: string): boolean {
  return keyValue === 'Control'
    || keyValue === 'Shift'
    || keyValue === 'Alt'
    || keyValue === 'Meta';
}

function bindingLabel(binding: CommandHotkeyBinding): string {
  return binding.map((chord) => chord.label).join(' ');
}

function bindingSignature(binding: CommandHotkeyBinding): string {
  return binding.map(chordSignature).join(',');
}

function chordSignature(chord: CommandKeyChord): string {
  const keyPart = chord.code ?? chord.key ?? '';
  return [
    modifierSignature('ctrl', chord.ctrl),
    modifierSignature('shift', chord.shift),
    modifierSignature('alt', chord.alt),
    modifierSignature('meta', chord.meta),
    keyPart.toLowerCase(),
  ].join('+');
}

function modifierSignature(name: string, expected: ModifierMatch | undefined): string {
  if (expected === 'any') return `${name}:any`;
  return `${name}:${expected === true ? '1' : '0'}`;
}

function keyChordMatchesEvent(chord: CommandKeyChord, event: KeyboardEvent): boolean {
  if (chord.code !== undefined && event.code !== chord.code) return false;
  if (chord.key !== undefined && event.key.toLowerCase() !== chord.key.toLowerCase()) return false;
  return modifierMatches(event.ctrlKey, chord.ctrl)
    && modifierMatches(event.shiftKey, chord.shift)
    && modifierMatches(event.altKey, chord.alt)
    && modifierMatches(event.metaKey, chord.meta);
}

function modifierMatches(actual: boolean, expected: ModifierMatch | undefined): boolean {
  if (expected === 'any') return true;
  return actual === (expected === true);
}
