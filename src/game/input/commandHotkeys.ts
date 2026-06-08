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
  | 'combat.attackArea'
  | 'combat.attackGround'
  | 'combat.guard'
  | 'combat.reclaim'
  | 'combat.repairArea'
  | 'combat.ping'
  | 'combat.towerTargetSet'
  | 'combat.towerTargetClear';

export type CommandHotkeyPresetId = 'prototype' | 'bar-grid' | 'bar-legacy';

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

export const COMMAND_HOTKEY_STORAGE_KEY = 'budget-annihilation.commandHotkeyPreset';
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
  'combat.attackArea',
  'combat.attackGround',
  'combat.guard',
  'combat.reclaim',
  'combat.repairArea',
  'combat.ping',
  'combat.towerTargetSet',
  'combat.towerTargetClear',
];

export const COMMAND_HOTKEY_PRESET_IDS: readonly CommandHotkeyPresetId[] = [
  'prototype',
  'bar-grid',
  'bar-legacy',
];

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

export const COMMAND_HOTKEY_PRESETS: Readonly<Record<CommandHotkeyPresetId, CommandHotkeyPreset>> = {
  prototype: commandPreset({
    'waypoint.move': [key('M', 'm', { shift: 'any' })],
    'waypoint.fight': [key('F', 'f', { shift: 'any' })],
    'waypoint.patrol': [key('H', 'h', { shift: 'any' })],
    'command.stop': [key('S', 's', { shift: 'any' })],
    'command.wait': [key('W', 'w', { shift: 'any' })],
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
    'combat.attackArea': [key('A', 'a', { shift: 'any' })],
    'combat.attackGround': [key('T', 't', { shift: 'any' })],
    'combat.guard': [key('G', 'g', { shift: 'any' })],
    'combat.reclaim': [key('C', 'c', { shift: 'any' })],
    'combat.repairArea': [key('R', 'r', { shift: 'any' })],
    'combat.ping': [key('P', 'p', { shift: 'any' })],
    'combat.towerTargetSet': [key('L', 'l', { shift: 'any' })],
    'combat.towerTargetClear': [key('J', 'j', { shift: 'any' })],
  }),
  'bar-grid': commandPreset({
    'waypoint.move': [code('M', 'KeyM', { shift: 'any' })],
    'waypoint.fight': [code('F', 'KeyF', { shift: 'any' })],
    'waypoint.patrol': [code('H', 'KeyH', { shift: 'any' })],
    'command.stop': [code('G', 'KeyG', { shift: 'any' })],
    'command.wait': [code('Y', 'KeyY', { shift: 'any' })],
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
    'combat.attackArea': [code('Ctrl+A', 'KeyA', { ctrl: true, shift: 'any' })],
    'combat.attackGround': [code('Alt+T', 'KeyT', { alt: true, shift: 'any' })],
    'combat.guard': [code('O', 'KeyO', { shift: 'any' })],
    'combat.reclaim': [code('E', 'KeyE', { shift: 'any' })],
    'combat.repairArea': [code('R', 'KeyR', { shift: 'any' })],
    'combat.ping': [code('`', 'Backquote', { shift: 'any' })],
    'combat.towerTargetSet': [code('S', 'KeyS', { shift: 'any' })],
    'combat.towerTargetClear': [code('Ctrl+S', 'KeyS', { ctrl: true, shift: 'any' })],
  }),
  'bar-legacy': commandPreset({
    'waypoint.move': [code('M', 'KeyM', { shift: 'any' })],
    'waypoint.fight': [code('F', 'KeyF', { shift: 'any' })],
    'waypoint.patrol': [code('P', 'KeyP', { shift: 'any' })],
    'command.stop': [code('S', 'KeyS', { shift: 'any' })],
    'command.wait': [code('W', 'KeyW', { shift: 'any' })],
    'command.skipCurrent': [code('N', 'KeyN', { shift: 'any' })],
    'command.undoQueue': [code('Ctrl+N', 'KeyN', { ctrl: true })],
    'command.clearQueue': [code('Ctrl+Shift+N', 'KeyN', { ctrl: true, shift: true })],
    'command.fireToggle': [code('L', 'KeyL', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'command.buildingActive': [code('X', 'KeyX', { shift: 'any' })],
    'command.selfDestruct': [code('Ctrl+D', 'KeyD', { ctrl: true, shift: 'any' })],
    'command.scan': [code('F4', 'F4', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'command.buildCycle': [code('B', 'KeyB', { shift: 'any' })],
    'command.dgun': [code('D', 'KeyD', { shift: 'any' })],
    'command.selectCommander': [
      code('Ctrl+C', 'KeyC', { ctrl: true, shift: 'any' }),
      key('Tab', 'tab', { shift: 'any' }),
    ],
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
    'combat.attackArea': [code('Alt+A', 'KeyA', { alt: true, shift: 'any' })],
    'combat.attackGround': [code('T', 'KeyT', { shift: 'any' })],
    'combat.guard': [code('G', 'KeyG', { shift: 'any' })],
    'combat.reclaim': [code('E', 'KeyE', { shift: 'any' })],
    'combat.repairArea': [code('R', 'KeyR', { shift: 'any' })],
    'combat.ping': [code('`', 'Backquote', { shift: 'any' })],
    'combat.towerTargetSet': [code('Alt+Y', 'KeyY', { alt: true, shift: 'any' })],
    'combat.towerTargetClear': [code('J', 'KeyJ', { shift: 'any' })],
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

export function commandHotkeyLabel(
  commandId: CommandHotkeyId,
  presetId: CommandHotkeyPresetId = getActiveCommandHotkeyPresetId(),
): string {
  const firstBinding = COMMAND_HOTKEY_PRESETS[presetId][commandId][0];
  return bindingLabel(firstBinding);
}

export function commandHotkeyLabels(
  commandId: CommandHotkeyId,
  presetId: CommandHotkeyPresetId = getActiveCommandHotkeyPresetId(),
): string[] {
  return COMMAND_HOTKEY_PRESETS[presetId][commandId].map(bindingLabel);
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
  const preset = COMMAND_HOTKEY_PRESETS[presetId];
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
  const preset = COMMAND_HOTKEY_PRESETS[presetId];
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
  const preset = COMMAND_HOTKEY_PRESETS[presetId];
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
