export type CommandHotkeyId =
  | 'waypoint.move'
  | 'waypoint.fight'
  | 'waypoint.patrol'
  | 'formation.assume'
  | 'formation.move'
  | 'command.stop'
  | 'command.wait'
  | 'command.gatherWait'
  | 'command.repeat'
  | 'command.factoryGuard'
  | 'command.builderPriority'
  | 'command.carrierSpawn'
  | 'command.moveState'
  | 'command.trajectoryToggle'
  | 'command.cloak'
  | 'command.skipCurrent'
  | 'command.undoQueue'
  | 'command.clearQueue'
  | 'command.fireToggle'
  | 'command.buildingActive'
  | 'command.selfDestruct'
  | 'command.scan'
  | 'command.areaMex'
  | 'command.morph'
  | 'command.upgradeMexSelected'
  | 'command.upgradeMexArea'
  | 'command.buildCycle'
  | 'command.dgun'
  | 'command.selectCommander'
  | 'factoryPreset.load1'
  | 'factoryPreset.load2'
  | 'factoryPreset.load3'
  | 'factoryPreset.load4'
  | 'factoryPreset.load5'
  | 'factoryPreset.load6'
  | 'factoryPreset.load7'
  | 'factoryPreset.load8'
  | 'factoryPreset.load9'
  | 'factoryPreset.load10'
  | 'factoryPreset.save1'
  | 'factoryPreset.save2'
  | 'factoryPreset.save3'
  | 'factoryPreset.save4'
  | 'factoryPreset.save5'
  | 'factoryPreset.save6'
  | 'factoryPreset.save7'
  | 'factoryPreset.save8'
  | 'factoryPreset.save9'
  | 'factoryPreset.save10'
  | 'factory.stopProduction'
  | 'factory.queueMode'
  | 'factory.airIdleState'
  | 'build.slot1'
  | 'build.slot2'
  | 'build.slot3'
  | 'build.slot4'
  | 'build.slot5'
  | 'build.slot6'
  | 'build.slot7'
  | 'build.slot8'
  | 'build.slot9'
  | 'build.slot10'
  | 'build.slot11'
  | 'build.slot12'
  | 'build.spacingIncrease'
  | 'build.spacingDecrease'
  | 'build.rotateClockwise'
  | 'build.rotateCounterClockwise'
  | 'select.allUnits'
  | 'select.matching'
  | 'select.matchingInView'
  | 'select.previous'
  | 'select.previousNotInControlGroups'
  | 'select.previousNonBuildersNotInControlGroups'
  | 'select.groundWeaponUnits'
  | 'select.idleBuilders'
  | 'select.idleTransports'
  | 'select.waitingUnits'
  | 'select.sameTypeOnly'
  | 'select.mobileOnly'
  | 'select.damagedOnly'
  | 'select.invert'
  | 'select.split'
  | 'select.loop'
  | 'combat.attack'
  | 'combat.attackLine'
  | 'combat.attackArea'
  | 'combat.attackGround'
  | 'combat.guard'
  | 'combat.reclaim'
  | 'combat.capture'
  | 'combat.resurrect'
  | 'combat.resurrectArea'
  | 'combat.loadTransport'
  | 'combat.unloadTransport'
  | 'combat.manualLaunch'
  | 'combat.repair'
  | 'combat.restore'
  | 'combat.ping'
  | 'combat.towerTargetSet'
  | 'combat.towerTargetSetNoGround'
  | 'combat.towerTargetClear'
  | 'ui.pause'
  | 'ui.gameSpeedIncrease'
  | 'ui.gameSpeedDecrease'
  | 'ui.optionsMenu'
  | 'ui.showMapOverview'
  | 'ui.unitStats'
  | 'ui.customGameInfo'
  | 'ui.flipCameraYaw'
  | 'camera.toggleMode'
  | 'camera.fovDecrease'
  | 'camera.fovIncrease'
  | 'camera.viewRadiusIncrease'
  | 'camera.viewRadiusDecrease'
  | 'camera.viewTa'
  | 'camera.viewSpring'
  | 'ui.goToLastPing'
  | 'ui.toggleUiChrome'
  | 'ui.muteSound'
  | 'ui.volumeIncrease'
  | 'ui.volumeDecrease'
  | 'ui.captureScreenshot'
  | 'ui.toggleFullscreen'
  | 'ui.chat'
  | 'ui.mapDraw'
  | 'ui.mapLabel'
  | 'ui.mapErase'
  | 'ui.attackRangeCycleNext'
  | 'ui.attackRangeCyclePrevious'
  | 'ui.toggleLosMap'
  | 'ui.togglePathingMap'
  | 'ui.toggleMetalMap'
  | 'ui.toggleElevationMap'
  | 'camera.anchorFocus1'
  | 'camera.anchorFocus2'
  | 'camera.anchorFocus3'
  | 'camera.anchorFocus4'
  | 'camera.anchorSet1'
  | 'camera.anchorSet2'
  | 'camera.anchorSet3'
  | 'camera.anchorSet4';

export type BuiltInCommandHotkeyPresetId =
  | 'prototype'
  | 'bar-grid'
  | 'bar-grid-60pct'
  | 'bar-legacy'
  | 'bar-legacy-60pct';
export type CommandHotkeyPresetId = BuiltInCommandHotkeyPresetId | 'custom';
type CommandHotkeyScope = 'global' | 'buildMenu' | 'factory';

type ModifierMatch = boolean | 'any';

type CommandKeyChord = {
  key?: string;
  code?: string;
  ctrl?: ModifierMatch;
  shift?: ModifierMatch;
  alt?: ModifierMatch;
  meta?: ModifierMatch;
  label: string;
};

type CommandHotkeyBinding = readonly CommandKeyChord[];
type CommandHotkeyPreset = Readonly<Record<CommandHotkeyId, readonly CommandHotkeyBinding[]>>;
type ChordOptions = Partial<Omit<CommandKeyChord, 'key' | 'code' | 'label'>>;
type CustomCommandHotkeyOverrides = Partial<Record<CommandHotkeyId, CommandHotkeyBinding>>;

const COMMAND_HOTKEY_STORAGE_KEY = 'budget-annihilation.commandHotkeyPreset';
const COMMAND_HOTKEY_CUSTOM_STORAGE_KEY = 'budget-annihilation.customCommandHotkeys';
export const DEFAULT_COMMAND_HOTKEY_PRESET: CommandHotkeyPresetId = 'bar-grid';
export const BAR_MAP_DRAW_DOUBLE_TAP_MS = 500;

export const COMMAND_HOTKEY_IDS: readonly CommandHotkeyId[] = [
  'waypoint.move',
  'waypoint.fight',
  'waypoint.patrol',
  'formation.assume',
  'formation.move',
  'command.stop',
  'command.wait',
  'command.gatherWait',
  'command.repeat',
  'command.factoryGuard',
  'command.builderPriority',
  'command.carrierSpawn',
  'command.moveState',
  'command.trajectoryToggle',
  'command.cloak',
  'command.skipCurrent',
  'command.undoQueue',
  'command.clearQueue',
  'command.fireToggle',
  'command.buildingActive',
  'command.selfDestruct',
  'command.scan',
  'command.areaMex',
  'command.morph',
  'command.upgradeMexSelected',
  'command.upgradeMexArea',
  'command.buildCycle',
  'command.dgun',
  'command.selectCommander',
  'factoryPreset.load1',
  'factoryPreset.load2',
  'factoryPreset.load3',
  'factoryPreset.load4',
  'factoryPreset.load5',
  'factoryPreset.load6',
  'factoryPreset.load7',
  'factoryPreset.load8',
  'factoryPreset.load9',
  'factoryPreset.load10',
  'factoryPreset.save1',
  'factoryPreset.save2',
  'factoryPreset.save3',
  'factoryPreset.save4',
  'factoryPreset.save5',
  'factoryPreset.save6',
  'factoryPreset.save7',
  'factoryPreset.save8',
  'factoryPreset.save9',
  'factoryPreset.save10',
  'factory.stopProduction',
  'factory.queueMode',
  'factory.airIdleState',
  'build.slot1',
  'build.slot2',
  'build.slot3',
  'build.slot4',
  'build.slot5',
  'build.slot6',
  'build.slot7',
  'build.slot8',
  'build.slot9',
  'build.slot10',
  'build.slot11',
  'build.slot12',
  'build.spacingIncrease',
  'build.spacingDecrease',
  'build.rotateClockwise',
  'build.rotateCounterClockwise',
  'select.allUnits',
  'select.matching',
  'select.matchingInView',
  'select.previous',
  'select.previousNotInControlGroups',
  'select.previousNonBuildersNotInControlGroups',
  'select.groundWeaponUnits',
  'select.idleBuilders',
  'select.idleTransports',
  'select.waitingUnits',
  'select.sameTypeOnly',
  'select.mobileOnly',
  'select.damagedOnly',
  'select.invert',
  'select.split',
  'select.loop',
  'combat.attack',
  'combat.attackLine',
  'combat.attackArea',
  'combat.attackGround',
  'combat.guard',
  'combat.reclaim',
  'combat.capture',
  'combat.resurrect',
  'combat.resurrectArea',
  'combat.loadTransport',
  'combat.unloadTransport',
  'combat.manualLaunch',
  'combat.repair',
  'combat.restore',
  'combat.ping',
  'combat.towerTargetSet',
  'combat.towerTargetSetNoGround',
  'combat.towerTargetClear',
  'ui.pause',
  'ui.gameSpeedIncrease',
  'ui.gameSpeedDecrease',
  'ui.optionsMenu',
  'ui.showMapOverview',
  'ui.unitStats',
  'ui.customGameInfo',
  'ui.flipCameraYaw',
  'camera.toggleMode',
  'camera.fovDecrease',
  'camera.fovIncrease',
  'camera.viewRadiusIncrease',
  'camera.viewRadiusDecrease',
  'camera.viewTa',
  'camera.viewSpring',
  'ui.goToLastPing',
  'ui.toggleUiChrome',
  'ui.muteSound',
  'ui.volumeIncrease',
  'ui.volumeDecrease',
  'ui.captureScreenshot',
  'ui.toggleFullscreen',
  'ui.chat',
  'ui.mapDraw',
  'ui.mapLabel',
  'ui.mapErase',
  'ui.attackRangeCycleNext',
  'ui.attackRangeCyclePrevious',
  'ui.toggleLosMap',
  'ui.togglePathingMap',
  'ui.toggleMetalMap',
  'ui.toggleElevationMap',
  'camera.anchorFocus1',
  'camera.anchorFocus2',
  'camera.anchorFocus3',
  'camera.anchorFocus4',
  'camera.anchorSet1',
  'camera.anchorSet2',
  'camera.anchorSet3',
  'camera.anchorSet4',
];

export const COMMAND_HOTKEY_PRESET_IDS: readonly CommandHotkeyPresetId[] = [
  'prototype',
  'bar-grid',
  'bar-grid-60pct',
  'bar-legacy',
  'bar-legacy-60pct',
  'custom',
];

export function isBarGridCommandHotkeyPreset(presetId: CommandHotkeyPresetId): boolean {
  return presetId === 'bar-grid' || presetId === 'bar-grid-60pct';
}

export function isBarLegacyCommandHotkeyPreset(presetId: CommandHotkeyPresetId): boolean {
  return presetId === 'bar-legacy' || presetId === 'bar-legacy-60pct';
}

export function isBarCommandHotkeyPreset(presetId: CommandHotkeyPresetId): boolean {
  return isBarGridCommandHotkeyPreset(presetId) || isBarLegacyCommandHotkeyPreset(presetId);
}

export function hasBarFactoryPresetHotkeys(presetId: CommandHotkeyPresetId): boolean {
  return presetId === 'bar-grid' || presetId === 'bar-legacy';
}

type BarMapDrawKeyEvent = Pick<
  KeyboardEvent,
  'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'
>;

export function barMapDrawHotkeySignature(
  event: BarMapDrawKeyEvent,
  presetId: CommandHotkeyPresetId,
): string | null {
  if (presetId === 'bar-grid') {
    return isPlainCode(event, 'Backquote') ? 'bar-grid:Backquote' : null;
  }
  if (presetId === 'bar-grid-60pct') {
    return event.code === 'KeyQ' &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey &&
      event.metaKey
      ? 'bar-grid-60pct:Meta+KeyQ'
      : null;
  }
  if (presetId === 'bar-legacy') {
    if (isPlainCode(event, 'KeyQ')) return 'bar-legacy:KeyQ';
    return isPlainCode(event, 'Backquote') ? 'bar-legacy:Backquote' : null;
  }
  if (presetId === 'bar-legacy-60pct') {
    return isPlainCode(event, 'KeyQ') ? 'bar-legacy-60pct:KeyQ' : null;
  }
  return null;
}

export function barMapDrawCommandForTapCount(tapCount: number): Extract<CommandHotkeyId, 'ui.mapDraw' | 'ui.mapLabel'> {
  return tapCount >= 2 ? 'ui.mapLabel' : 'ui.mapDraw';
}

function isPlainCode(event: BarMapDrawKeyEvent, codeValue: string): boolean {
  return event.code === codeValue &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey;
}

export const COMMAND_HOTKEY_DISPLAY_LABELS: Readonly<Record<CommandHotkeyId, string>> = {
  'waypoint.move': 'Waypoint: Move',
  'waypoint.fight': 'Waypoint: Fight',
  'waypoint.patrol': 'Waypoint: Patrol',
  'formation.assume': 'Assume Formation',
  'formation.move': 'Move In Formation',
  'command.stop': 'Stop',
  'command.wait': 'Wait',
  'command.gatherWait': 'Gather Wait',
  'command.repeat': 'Repeat Orders',
  'command.factoryGuard': 'Factory Guard',
  'command.builderPriority': 'Builder Priority',
  'command.carrierSpawn': 'Carrier Spawning',
  'command.moveState': 'Move State',
  'command.trajectoryToggle': 'Trajectory Mode',
  'command.cloak': 'Cloak',
  'command.skipCurrent': 'Skip Current Order',
  'command.undoQueue': 'Cancel Last Order',
  'command.clearQueue': 'Clear Orders',
  'command.fireToggle': 'Fire State',
  'command.buildingActive': 'Building On/Off',
  'command.selfDestruct': 'Self Destruct',
  'command.scan': 'Scanner Sweep',
  'command.areaMex': 'Area Mex',
  'command.morph': 'Upgrade',
  'command.upgradeMexSelected': 'Upgrade Metal Extractor',
  'command.upgradeMexArea': 'Upgrade Metal Extractor Area',
  'command.buildCycle': 'Cycle Build',
  'command.dgun': 'Commander DGun',
  'command.selectCommander': 'Select Commander',
  'factoryPreset.load1': 'Load Factory Preset 0',
  'factoryPreset.load2': 'Load Factory Preset 1',
  'factoryPreset.load3': 'Load Factory Preset 2',
  'factoryPreset.load4': 'Load Factory Preset 3',
  'factoryPreset.load5': 'Load Factory Preset 4',
  'factoryPreset.load6': 'Load Factory Preset 5',
  'factoryPreset.load7': 'Load Factory Preset 6',
  'factoryPreset.load8': 'Load Factory Preset 7',
  'factoryPreset.load9': 'Load Factory Preset 8',
  'factoryPreset.load10': 'Load Factory Preset 9',
  'factoryPreset.save1': 'Save Factory Preset 0',
  'factoryPreset.save2': 'Save Factory Preset 1',
  'factoryPreset.save3': 'Save Factory Preset 2',
  'factoryPreset.save4': 'Save Factory Preset 3',
  'factoryPreset.save5': 'Save Factory Preset 4',
  'factoryPreset.save6': 'Save Factory Preset 5',
  'factoryPreset.save7': 'Save Factory Preset 6',
  'factoryPreset.save8': 'Save Factory Preset 7',
  'factoryPreset.save9': 'Save Factory Preset 8',
  'factoryPreset.save10': 'Save Factory Preset 9',
  'factory.stopProduction': 'Clear Queue',
  'factory.queueMode': 'Factory Queue Mode',
  'factory.airIdleState': 'Land At',
  'build.slot1': 'Build Slot 1',
  'build.slot2': 'Build Slot 2',
  'build.slot3': 'Build Slot 3',
  'build.slot4': 'Build Slot 4',
  'build.slot5': 'Build Slot 5',
  'build.slot6': 'Build Slot 6',
  'build.slot7': 'Build Slot 7',
  'build.slot8': 'Build Slot 8',
  'build.slot9': 'Build Slot 9',
  'build.slot10': 'Build Slot 10',
  'build.slot11': 'Build Slot 11',
  'build.slot12': 'Build Slot 12',
  'build.spacingIncrease': 'Build Spacing Increase',
  'build.spacingDecrease': 'Build Spacing Decrease',
  'build.rotateClockwise': 'Build Rotate Clockwise',
  'build.rotateCounterClockwise': 'Build Rotate Counterclockwise',
  'select.allUnits': 'Select All Units',
  'select.matching': 'Select Matching',
  'select.matchingInView': 'Select Matching In View',
  'select.previous': 'Previous Selection',
  'select.previousNotInControlGroups': 'Previous Selection Not Grouped',
  'select.previousNonBuildersNotInControlGroups': 'Previous Army Not Grouped',
  'select.groundWeaponUnits': 'Ground Weapon Units',
  'select.idleBuilders': 'Idle Builders',
  'select.idleTransports': 'Idle Transports',
  'select.waitingUnits': 'Waiting Units',
  'select.sameTypeOnly': 'Keep Same Type',
  'select.mobileOnly': 'Keep Mobile',
  'select.damagedOnly': 'Keep Damaged',
  'select.invert': 'Invert Selection',
  'select.split': 'Split Selection',
  'select.loop': 'Loop Selection',
  'combat.attack': 'Attack',
  'combat.attackLine': 'Attack Line',
  'combat.attackArea': 'Attack Area',
  'combat.attackGround': 'Attack Ground',
  'combat.guard': 'Guard',
  'combat.reclaim': 'Reclaim',
  'combat.capture': 'Capture',
  'combat.resurrect': 'Resurrect',
  'combat.resurrectArea': 'Resurrect Area',
  'combat.loadTransport': 'Load Transport',
  'combat.unloadTransport': 'Unload Transport',
  'combat.manualLaunch': 'Manual Launch',
  'combat.repair': 'Repair',
  'combat.restore': 'Restore',
  'combat.ping': 'Ping',
  'combat.towerTargetSet': 'Set Target',
  'combat.towerTargetSetNoGround': 'Set Target No Ground',
  'combat.towerTargetClear': 'Clear Tower Target',
  'ui.pause': 'Pause Game',
  'ui.gameSpeedIncrease': 'Increase Game Speed',
  'ui.gameSpeedDecrease': 'Decrease Game Speed',
  'ui.optionsMenu': 'Options Menu',
  'ui.showMapOverview': 'Map Overview',
  'ui.unitStats': 'Unit Stats (Hold)',
  'ui.customGameInfo': 'Game Info',
  'ui.flipCameraYaw': 'Flip Camera',
  'camera.toggleMode': 'Toggle Camera Mode',
  'camera.fovDecrease': 'Camera FOV Down',
  'camera.fovIncrease': 'Camera FOV Up',
  'camera.viewRadiusIncrease': 'Increase View Radius',
  'camera.viewRadiusDecrease': 'Decrease View Radius',
  'camera.viewTa': 'TA Camera View',
  'camera.viewSpring': 'Spring Camera View',
  'ui.goToLastPing': 'Last Message Position',
  'ui.toggleUiChrome': 'Toggle Interface',
  'ui.muteSound': 'Mute Sound',
  'ui.volumeIncrease': 'Volume Up',
  'ui.volumeDecrease': 'Volume Down',
  'ui.captureScreenshot': 'Screenshot',
  'ui.toggleFullscreen': 'Toggle Fullscreen',
  'ui.chat': 'Chat',
  'ui.mapDraw': 'Draw On Map',
  'ui.mapLabel': 'Draw Map Label',
  'ui.mapErase': 'Erase Map Drawings',
  'ui.attackRangeCycleNext': 'Attack Range Next',
  'ui.attackRangeCyclePrevious': 'Attack Range Previous',
  'ui.toggleLosMap': 'Toggle LOS Map',
  'ui.togglePathingMap': 'Toggle Pathing Map',
  'ui.toggleMetalMap': 'Toggle Metal Map',
  'ui.toggleElevationMap': 'Toggle Elevation Map',
  'camera.anchorFocus1': 'Focus Camera Anchor 1',
  'camera.anchorFocus2': 'Focus Camera Anchor 2',
  'camera.anchorFocus3': 'Focus Camera Anchor 3',
  'camera.anchorFocus4': 'Focus Camera Anchor 4',
  'camera.anchorSet1': 'Set Camera Anchor 1',
  'camera.anchorSet2': 'Set Camera Anchor 2',
  'camera.anchorSet3': 'Set Camera Anchor 3',
  'camera.anchorSet4': 'Set Camera Anchor 4',
};

function commandHotkeyScope(commandId: CommandHotkeyId): CommandHotkeyScope {
  if (
    commandId === 'factory.stopProduction' ||
    commandId === 'factory.queueMode' ||
    commandId === 'factory.airIdleState'
  ) return 'factory';
  return commandId.startsWith('build.slot') ? 'buildMenu' : 'global';
}

function key(label: string, keyValue: string, options: ChordOptions = {}): CommandHotkeyBinding {
  return [{ key: keyValue.toLowerCase(), label, ...options }];
}

function code(label: string, codeValue: string, options: ChordOptions = {}): CommandHotkeyBinding {
  return [{ code: codeValue, label, ...options }];
}

function sequence(...bindings: readonly CommandHotkeyBinding[]): CommandHotkeyBinding {
  const chords: CommandKeyChord[] = [];
  for (const binding of bindings) {
    for (const chord of binding) chords.push(chord);
  }
  return chords;
}

function commandPreset(
  entries: Record<CommandHotkeyId, readonly CommandHotkeyBinding[]>,
): CommandHotkeyPreset {
  return entries;
}

function withoutFactoryPresetBindings(preset: CommandHotkeyPreset): CommandHotkeyPreset {
  const entries = { ...preset } as Record<CommandHotkeyId, readonly CommandHotkeyBinding[]>;
  for (const commandId of COMMAND_HOTKEY_IDS) {
    if (commandId.startsWith('factoryPreset.')) entries[commandId] = [];
  }
  return commandPreset(entries);
}

function withCommandHotkeyOverrides(
  preset: CommandHotkeyPreset,
  overrides: Partial<Record<CommandHotkeyId, readonly CommandHotkeyBinding[]>>,
): CommandHotkeyPreset {
  return commandPreset({
    ...preset,
    ...overrides,
  } as Record<CommandHotkeyId, readonly CommandHotkeyBinding[]>);
}

const BASE_COMMAND_HOTKEY_PRESETS: Readonly<Record<
  Exclude<BuiltInCommandHotkeyPresetId, 'bar-grid-60pct' | 'bar-legacy-60pct'>,
  CommandHotkeyPreset
>> = {
  prototype: commandPreset({
    'waypoint.move': [key('M', 'm', { shift: 'any' })],
    'waypoint.fight': [key('F', 'f', { shift: 'any' })],
    'waypoint.patrol': [key('H', 'h', { shift: 'any' })],
    'formation.assume': [code('Ctrl+Alt+M', 'KeyM', { ctrl: true, alt: true })],
    'formation.move': [code('Ctrl+Alt+F', 'KeyF', { ctrl: true, alt: true })],
    'command.stop': [key('S', 's', { shift: 'any' })],
    'command.wait': [
      key('W', 'w', { shift: 'any' }),
      key('Ctrl+Shift+W', 'w', { ctrl: true, shift: true }),
    ],
    'command.gatherWait': [code('Ctrl+Alt+W', 'KeyW', { ctrl: true, alt: true })],
    'command.repeat': [key('Alt+R', 'r', { alt: true })],
    'command.factoryGuard': [code('Ctrl+G', 'KeyG', { ctrl: true })],
    'command.builderPriority': [],
    'command.carrierSpawn': [],
    'command.moveState': [key('Alt+H', 'h', { alt: true })],
    'command.trajectoryToggle': [key('Alt+J', 'j', { alt: true })],
    'command.cloak': [key('Alt+C', 'c', { alt: true })],
    'command.skipCurrent': [key('N', 'n', { shift: 'any' })],
    'command.undoQueue': [key('U', 'u', { shift: 'any' })],
    'command.clearQueue': [key('X', 'x', { shift: 'any' })],
    'command.fireToggle': [key('E', 'e', { shift: 'any' })],
    'command.buildingActive': [key('O', 'o', { shift: 'any' })],
    'command.selfDestruct': [key('K', 'k', { shift: 'any' })],
    'command.scan': [key('Y', 'y', { shift: 'any' })],
    'command.areaMex': [],
    'command.morph': [],
    'command.upgradeMexSelected': [code('Alt+U', 'KeyU', { alt: true })],
    'command.upgradeMexArea': [code('Ctrl+Alt+U', 'KeyU', { ctrl: true, alt: true })],
    'command.buildCycle': [key('B', 'b', { shift: 'any' })],
    'command.dgun': [key('D', 'd', { shift: 'any' })],
    'command.selectCommander': [key('Tab', 'tab', { shift: 'any' })],
    'factoryPreset.load1': [code('Ctrl+Alt+Z', 'KeyZ', { ctrl: true, alt: true })],
    'factoryPreset.load2': [code('Ctrl+Alt+X', 'KeyX', { ctrl: true, alt: true })],
    'factoryPreset.load3': [code('Ctrl+Alt+C', 'KeyC', { ctrl: true, alt: true })],
    'factoryPreset.load4': [code('Ctrl+Alt+V', 'KeyV', { ctrl: true, alt: true })],
    'factoryPreset.load5': [code('Ctrl+Alt+1', 'Digit1', { ctrl: true, alt: true })],
    'factoryPreset.load6': [code('Ctrl+Alt+2', 'Digit2', { ctrl: true, alt: true })],
    'factoryPreset.load7': [code('Ctrl+Alt+3', 'Digit3', { ctrl: true, alt: true })],
    'factoryPreset.load8': [code('Ctrl+Alt+4', 'Digit4', { ctrl: true, alt: true })],
    'factoryPreset.load9': [code('Ctrl+Alt+5', 'Digit5', { ctrl: true, alt: true })],
    'factoryPreset.load10': [code('Ctrl+Alt+6', 'Digit6', { ctrl: true, alt: true })],
    'factoryPreset.save1': [code('Ctrl+Alt+Shift+Z', 'KeyZ', { ctrl: true, alt: true, shift: true })],
    'factoryPreset.save2': [code('Ctrl+Alt+Shift+X', 'KeyX', { ctrl: true, alt: true, shift: true })],
    'factoryPreset.save3': [code('Ctrl+Alt+Shift+C', 'KeyC', { ctrl: true, alt: true, shift: true })],
    'factoryPreset.save4': [code('Ctrl+Alt+Shift+V', 'KeyV', { ctrl: true, alt: true, shift: true })],
    'factoryPreset.save5': [code('Ctrl+Alt+Shift+1', 'Digit1', { ctrl: true, alt: true, shift: true })],
    'factoryPreset.save6': [code('Ctrl+Alt+Shift+2', 'Digit2', { ctrl: true, alt: true, shift: true })],
    'factoryPreset.save7': [code('Ctrl+Alt+Shift+3', 'Digit3', { ctrl: true, alt: true, shift: true })],
    'factoryPreset.save8': [code('Ctrl+Alt+Shift+4', 'Digit4', { ctrl: true, alt: true, shift: true })],
    'factoryPreset.save9': [code('Ctrl+Alt+Shift+5', 'Digit5', { ctrl: true, alt: true, shift: true })],
    'factoryPreset.save10': [code('Ctrl+Alt+Shift+6', 'Digit6', { ctrl: true, alt: true, shift: true })],
    'factory.stopProduction': [key('S', 's', { shift: 'any' })],
    'factory.queueMode': [code('Alt+G', 'KeyG', { alt: true, shift: 'any' })],
    'factory.airIdleState': [],
    'build.slot1': [code('1', 'Digit1', { shift: 'any' })],
    'build.slot2': [code('2', 'Digit2', { shift: 'any' })],
    'build.slot3': [code('3', 'Digit3', { shift: 'any' })],
    'build.slot4': [code('4', 'Digit4', { shift: 'any' })],
    'build.slot5': [code('5', 'Digit5', { shift: 'any' })],
    'build.slot6': [code('6', 'Digit6', { shift: 'any' })],
    'build.slot7': [code('7', 'Digit7', { shift: 'any' })],
    'build.slot8': [code('8', 'Digit8', { shift: 'any' })],
    'build.slot9': [code('9', 'Digit9', { shift: 'any' })],
    'build.slot10': [code('0', 'Digit0', { shift: 'any' })],
    'build.slot11': [code('-', 'Minus', { shift: 'any' })],
    'build.slot12': [code('=', 'Equal', { shift: 'any' })],
    'build.spacingIncrease': [code(']', 'BracketRight', { shift: 'any' })],
    'build.spacingDecrease': [code('[', 'BracketLeft', { shift: 'any' })],
    'build.rotateClockwise': [code('.', 'Period', { shift: 'any' })],
    'build.rotateCounterClockwise': [code(',', 'Comma', { shift: 'any' })],
    'select.allUnits': [key('Ctrl+A', 'a', { ctrl: true })],
    'select.matching': [key('Ctrl+Z', 'z', { ctrl: true })],
    'select.matchingInView': [key('Alt+W', 'w', { alt: true })],
    'select.previous': [key('Alt+P', 'p', { alt: true })],
    'select.previousNotInControlGroups': [],
    'select.previousNonBuildersNotInControlGroups': [],
    'select.groundWeaponUnits': [],
    'select.idleBuilders': [key('Ctrl+B', 'b', { ctrl: true })],
    'select.idleTransports': [code('Ctrl+Alt+T', 'KeyT', { ctrl: true, alt: true })],
    'select.waitingUnits': [key('Ctrl+Y', 'y', { ctrl: true })],
    'select.sameTypeOnly': [key('Alt+Z', 'z', { alt: true })],
    'select.mobileOnly': [key('Alt+M', 'm', { alt: true })],
    // Alt+Q is the prototype autogroup-remove chord, so the damaged filter
    // stays hotkey-less here (BAR presets bind it per BAR defaults).
    'select.damagedOnly': [],
    'select.invert': [key('Alt+I', 'i', { alt: true })],
    'select.split': [key('Alt+S', 's', { alt: true })],
    'select.loop': [key('Alt+L', 'l', { alt: true })],
    'combat.attack': [key('V', 'v', { shift: 'any' })],
    'combat.attackLine': [key('Alt+V', 'v', { alt: true })],
    'combat.attackArea': [key('A', 'a', { shift: 'any' })],
    'combat.attackGround': [key('T', 't', { shift: 'any' })],
    'combat.guard': [key('G', 'g', { shift: 'any' })],
    'combat.reclaim': [key('C', 'c', { shift: 'any' })],
    'combat.capture': [key('Alt+E', 'e', { alt: true })],
    'combat.resurrect': [code('Alt+Shift+E', 'KeyE', { alt: true, shift: true })],
    'combat.resurrectArea': [code('Ctrl+Alt+Shift+E', 'KeyE', { ctrl: true, alt: true, shift: true })],
    'combat.loadTransport': [code('Ctrl+Alt+Q', 'KeyQ', { ctrl: true, alt: true })],
    'combat.unloadTransport': [code('Ctrl+Alt+Shift+Q', 'KeyQ', { ctrl: true, alt: true, shift: true })],
    'combat.manualLaunch': [code('Alt+D', 'KeyD', { alt: true, shift: 'any' })],
    'combat.repair': [key('R', 'r', { shift: 'any' })],
    'combat.restore': [],
    'combat.ping': [key('P', 'p', { shift: 'any' })],
    'combat.towerTargetSet': [key('L', 'l', { shift: 'any' })],
    'combat.towerTargetSetNoGround': [code('Alt+L', 'KeyL', { alt: true, shift: 'any' })],
    'combat.towerTargetClear': [key('J', 'j', { shift: 'any' })],
    // BAR chat_and_ui_keys.txt binds "Any+pause pause".
    'ui.pause': [code('Pause', 'Pause', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'ui.gameSpeedIncrease': [
      code('Alt+=', 'Equal', { alt: true }),
      code('Alt+Numpad+', 'NumpadAdd', { alt: true }),
    ],
    'ui.gameSpeedDecrease': [
      code('Alt+-', 'Minus', { alt: true }),
      code('Alt+Numpad-', 'NumpadSubtract', { alt: true }),
    ],
    'ui.optionsMenu': [code('F10', 'F10', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'ui.showMapOverview': [code('Ctrl+T', 'KeyT', { ctrl: true })],
    // Hold-to-show stats peek (BAR gui_unit_stats). Plain I follows the
    // BAR grid default; prototype has no other plain-I bind (invert is Alt+I).
    'ui.unitStats': [code('I', 'KeyI')],
    'ui.customGameInfo': [],
    'ui.flipCameraYaw': [code('Alt+O', 'KeyO', { alt: true })],
    'camera.toggleMode': [],
    'camera.fovDecrease': [],
    'camera.fovIncrease': [],
    'camera.viewRadiusIncrease': [],
    'camera.viewRadiusDecrease': [],
    'camera.viewTa': [code('Ctrl+F5', 'F5', { ctrl: true })],
    'camera.viewSpring': [code('Ctrl+F6', 'F6', { ctrl: true })],
    'ui.goToLastPing': [code('F5', 'F5', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'ui.toggleUiChrome': [code('Ctrl+F7', 'F7', { ctrl: true })],
    'ui.muteSound': [code('Ctrl+Shift+S', 'KeyS', { ctrl: true, shift: true })],
    'ui.volumeIncrease': [],
    'ui.volumeDecrease': [],
    'ui.captureScreenshot': [code('F12', 'F12', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'ui.toggleFullscreen': [key('Alt+Backspace', 'backspace', { alt: true })],
    'ui.chat': [key('Enter', 'enter', { shift: 'any' })],
    'ui.mapDraw': [code('Ctrl+Shift+D', 'KeyD', { ctrl: true, shift: true })],
    'ui.mapLabel': [code('Ctrl+Shift+L', 'KeyL', { ctrl: true, shift: true })],
    'ui.mapErase': [code('Ctrl+Shift+E', 'KeyE', { ctrl: true, shift: true })],
    'ui.attackRangeCycleNext': [],
    'ui.attackRangeCyclePrevious': [],
    'ui.toggleLosMap': [],
    'ui.togglePathingMap': [code('Ctrl+Shift+P', 'KeyP', { ctrl: true, shift: true })],
    'ui.toggleMetalMap': [code('Ctrl+Shift+M', 'KeyM', { ctrl: true, shift: true })],
    'ui.toggleElevationMap': [code('Ctrl+Shift+H', 'KeyH', { ctrl: true, shift: true })],
    'camera.anchorFocus1': [code('F1', 'F1')],
    'camera.anchorFocus2': [code('F2', 'F2')],
    'camera.anchorFocus3': [code('F3', 'F3')],
    'camera.anchorFocus4': [code('F4', 'F4')],
    'camera.anchorSet1': [code('Ctrl+F1', 'F1', { ctrl: true })],
    'camera.anchorSet2': [code('Ctrl+F2', 'F2', { ctrl: true })],
    'camera.anchorSet3': [code('Ctrl+F3', 'F3', { ctrl: true })],
    'camera.anchorSet4': [code('Ctrl+F4', 'F4', { ctrl: true })],
  }),
  'bar-grid': commandPreset({
    'waypoint.move': [],
    'waypoint.fight': [code('F', 'KeyF', { shift: 'any' })],
    'waypoint.patrol': [code('H', 'KeyH', { shift: 'any' })],
    'formation.assume': [],
    'formation.move': [],
    'command.stop': [code('G', 'KeyG', { shift: 'any' })],
    'command.wait': [
      code('Y', 'KeyY', { shift: 'any' }),
    ],
    'command.gatherWait': [code('P', 'KeyP', { shift: 'any' })],
    'command.repeat': [code('T', 'KeyT', { shift: 'any' })],
    'command.factoryGuard': [code('Ctrl+G', 'KeyG', { ctrl: true })],
    'command.builderPriority': [],
    'command.carrierSpawn': [],
    'command.moveState': [code(';', 'Semicolon', { shift: 'any' })],
    'command.trajectoryToggle': [code('B', 'KeyB', { shift: 'any' })],
    'command.cloak': [code('K', 'KeyK', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'command.skipCurrent': [code('N', 'KeyN', { shift: 'any' })],
    'command.undoQueue': [code('Ctrl+N', 'KeyN', { ctrl: true })],
    'command.clearQueue': [],
    'command.fireToggle': [code('L', 'KeyL', { shift: 'any' })],
    'command.buildingActive': [code('B', 'KeyB', { shift: 'any' })],
    'command.selfDestruct': [code('Ctrl+B', 'KeyB', { ctrl: true, shift: 'any' })],
    'command.scan': [],
    'command.areaMex': [],
    'command.morph': [],
    'command.upgradeMexSelected': [],
    'command.upgradeMexArea': [],
    // BAR-grid period cycles the active selected builder type, not the current build blueprint.
    'command.buildCycle': [],
    'command.dgun': [code('D', 'KeyD', { shift: 'any' })],
    'command.selectCommander': [
      key('Tab', 'tab'),
      key('Shift+Tab', 'tab', { shift: true }),
    ],
    'factoryPreset.load1': [code('Meta+0', 'Digit0', { meta: true })],
    'factoryPreset.load2': [code('Meta+1', 'Digit1', { meta: true })],
    'factoryPreset.load3': [code('Meta+2', 'Digit2', { meta: true })],
    'factoryPreset.load4': [code('Meta+3', 'Digit3', { meta: true })],
    'factoryPreset.load5': [code('Meta+4', 'Digit4', { meta: true })],
    'factoryPreset.load6': [code('Meta+5', 'Digit5', { meta: true })],
    'factoryPreset.load7': [code('Meta+6', 'Digit6', { meta: true })],
    'factoryPreset.load8': [code('Meta+7', 'Digit7', { meta: true })],
    'factoryPreset.load9': [code('Meta+8', 'Digit8', { meta: true })],
    'factoryPreset.load10': [code('Meta+9', 'Digit9', { meta: true })],
    'factoryPreset.save1': [code('Meta+Alt+0', 'Digit0', { meta: true, alt: true })],
    'factoryPreset.save2': [code('Meta+Alt+1', 'Digit1', { meta: true, alt: true })],
    'factoryPreset.save3': [code('Meta+Alt+2', 'Digit2', { meta: true, alt: true })],
    'factoryPreset.save4': [code('Meta+Alt+3', 'Digit3', { meta: true, alt: true })],
    'factoryPreset.save5': [code('Meta+Alt+4', 'Digit4', { meta: true, alt: true })],
    'factoryPreset.save6': [code('Meta+Alt+5', 'Digit5', { meta: true, alt: true })],
    'factoryPreset.save7': [code('Meta+Alt+6', 'Digit6', { meta: true, alt: true })],
    'factoryPreset.save8': [code('Meta+Alt+7', 'Digit7', { meta: true, alt: true })],
    'factoryPreset.save9': [code('Meta+Alt+8', 'Digit8', { meta: true, alt: true })],
    'factoryPreset.save10': [code('Meta+Alt+9', 'Digit9', { meta: true, alt: true })],
    'factory.stopProduction': [code('G', 'KeyG', { shift: 'any' })],
    'factory.queueMode': [code('Alt+G', 'KeyG', { alt: true, shift: 'any' })],
    'factory.airIdleState': [],
    'build.slot1': [code('Z', 'KeyZ', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'build.slot2': [code('X', 'KeyX', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'build.slot3': [code('C', 'KeyC', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'build.slot4': [code('V', 'KeyV', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'build.slot5': [code('A', 'KeyA', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'build.slot6': [code('S', 'KeyS', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'build.slot7': [code('D', 'KeyD', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'build.slot8': [code('F', 'KeyF', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'build.slot9': [code('Q', 'KeyQ', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'build.slot10': [code('W', 'KeyW', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'build.slot11': [code('E', 'KeyE', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'build.slot12': [code('R', 'KeyR', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'build.spacingIncrease': [code('Alt+Z', 'KeyZ', { alt: true, shift: 'any' })],
    'build.spacingDecrease': [code('Alt+X', 'KeyX', { alt: true, shift: 'any' })],
    'build.rotateClockwise': [code(']', 'BracketRight', { shift: 'any' })],
    'build.rotateCounterClockwise': [code('[', 'BracketLeft', { shift: 'any' })],
    'select.allUnits': [code('Ctrl+E', 'KeyE', { ctrl: true })],
    'select.matching': [code('Ctrl+W', 'KeyW', { ctrl: true })],
    'select.matchingInView': [code('Q', 'KeyQ', { shift: 'any' })],
    // BAR grid has no dedicated whole-previous-selection bind; Ctrl+Q is
    // the split-half command and Ctrl+W is same-type/all-map selection.
    'select.previous': [],
    'select.previousNotInControlGroups': [],
    'select.previousNonBuildersNotInControlGroups': [],
    'select.groundWeaponUnits': [],
    'select.idleBuilders': [key('Ctrl+Tab', 'tab', { ctrl: true })],
    'select.idleTransports': [code('Ctrl+R', 'KeyR', { ctrl: true })],
    'select.waitingUnits': [code('Ctrl+Y', 'KeyY', { ctrl: true })],
    'select.sameTypeOnly': [],
    // BAR covers mobile-only selection with the held-Alt selectbox modifier.
    'select.mobileOnly': [],
    // grid_keys.txt: Alt+sc_q select PrevSelection+_Not_Building_Not_RelativeHealth_60+
    'select.damagedOnly': [code('Alt+Q', 'KeyQ', { alt: true })],
    // BAR uses held selection modifiers for invert/loop selection
    // (chat_and_ui_keys.txt selectloop_*), not standalone order keys.
    'select.invert': [],
    // grid_keys.txt: Ctrl+sc_q select PrevSelection++_ClearSelection_SelectPart_50+
    'select.split': [code('Ctrl+Q', 'KeyQ', { ctrl: true })],
    'select.loop': [],
    'combat.attack': [code('A', 'KeyA', { shift: 'any' })],
    'combat.attackLine': [],
    'combat.attackArea': [code('Ctrl+A', 'KeyA', { ctrl: true, shift: 'any' })],
    'combat.attackGround': [],
    'combat.guard': [code('O', 'KeyO', { shift: 'any' })],
    'combat.reclaim': [code('E', 'KeyE', { shift: 'any' })],
    'combat.capture': [code('W', 'KeyW', { shift: 'any' })],
    'combat.resurrect': [code('W', 'KeyW', { shift: 'any' })],
    'combat.resurrectArea': [],
    'combat.loadTransport': [code('J', 'KeyJ', { shift: 'any' })],
    'combat.unloadTransport': [code('U', 'KeyU', { shift: 'any' })],
    'combat.manualLaunch': [code('D', 'KeyD', { shift: 'any' })],
    'combat.repair': [code('R', 'KeyR', { shift: 'any' })],
    // Recoil only exposes Restore when the unit can restore and map damage is
    // enabled. Budget Annihilation terrain is immutable, so exposing M here
    // would create a dead command instead of BAR-compatible capability gating.
    'combat.restore': [],
    'combat.ping': [],
    'combat.towerTargetSet': [code('S', 'KeyS', { shift: 'any' })],
    'combat.towerTargetSetNoGround': [code('Alt+S', 'KeyS', { alt: true, shift: 'any' })],
    'combat.towerTargetClear': [code('Ctrl+S', 'KeyS', { ctrl: true, shift: 'any' })],
    // BAR chat_and_ui_keys.txt binds "Any+pause pause".
    'ui.pause': [code('Pause', 'Pause', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    // grid_keys.txt/grid_keys_60pct.txt: Alt+sc_= / Alt+numpad+
    // increasespeed, Alt+sc_- / Alt+numpad- decreasespeed.
    'ui.gameSpeedIncrease': [
      code('Alt+=', 'Equal', { alt: true }),
      code('Alt+Numpad+', 'NumpadAdd', { alt: true }),
    ],
    'ui.gameSpeedDecrease': [
      code('Alt+-', 'Minus', { alt: true }),
      code('Alt+Numpad-', 'NumpadSubtract', { alt: true }),
    ],
    'ui.optionsMenu': [code('F10', 'F10')],
    'ui.showMapOverview': [code('Ctrl+T', 'KeyT', { ctrl: true })],
    // grid_keys.txt: "bind sc_i unit_stats" — hold-to-show stats peek
    // (gui_unit_stats registers press+release actions). BAR does not bind a
    // standalone invert-selection hotkey; invert is a held selectbox modifier.
    'ui.unitStats': [code('I', 'KeyI')],
    // grid_keys.txt/grid_keys_60pct.txt: Ctrl+sc_i customgameinfo.
    'ui.customGameInfo': [code('Ctrl+I', 'KeyI', { ctrl: true })],
    'ui.flipCameraYaw': [code('Alt+O', 'KeyO', { alt: true })],
    'camera.toggleMode': [],
    // chat_and_ui_keys.txt: Ctrl+sc_o / Numpad1 fov_dec 5,
    // Ctrl+sc_p / Numpad7 fov_inc 5.
    'camera.fovDecrease': [
      code('Ctrl+O', 'KeyO', { ctrl: true }),
      code('Numpad1', 'Numpad1'),
    ],
    'camera.fovIncrease': [
      code('Ctrl+P', 'KeyP', { ctrl: true }),
      code('Numpad7', 'Numpad7'),
    ],
    'camera.viewRadiusIncrease': [],
    'camera.viewRadiusDecrease': [],
    'camera.viewTa': [code('Ctrl+F5', 'F5', { ctrl: true })],
    'camera.viewSpring': [code('Ctrl+F6', 'F6', { ctrl: true })],
    'ui.goToLastPing': [code('F5', 'F5', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'ui.toggleUiChrome': [code('Ctrl+F7', 'F7', { ctrl: true })],
    'ui.muteSound': [key('Backspace', 'backspace')],
    // snd_volume_osd.lua: +/- step master volume by 8.
    'ui.volumeIncrease': [
      code('Numpad+', 'NumpadAdd'),
      code('=', 'Equal'),
    ],
    'ui.volumeDecrease': [
      code('-', 'Minus'),
      code('Numpad-', 'NumpadSubtract'),
    ],
    'ui.captureScreenshot': [code('F12', 'F12', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'ui.toggleFullscreen': [key('Alt+Backspace', 'backspace', { alt: true })],
    'ui.chat': [key('Enter', 'enter', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'ui.mapDraw': [code('`', 'Backquote')],
    'ui.mapLabel': [sequence(code('`', 'Backquote'), code('`', 'Backquote'))],
    'ui.mapErase': [],
    // chat_and_ui_keys.txt: Alt+sc_. attack_range_inc,
    // Alt+sc_comma attack_range_dec.
    'ui.attackRangeCycleNext': [code('Alt+.', 'Period', { alt: true })],
    'ui.attackRangeCyclePrevious': [code('Alt+,', 'Comma', { alt: true })],
    // grid_keys.txt/grid_keys_60pct.txt: Any+sc_' togglelos.
    'ui.toggleLosMap': [code("'", 'Quote', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'ui.togglePathingMap': [code('F6', 'F6', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'ui.toggleMetalMap': [code('F7', 'F7', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'ui.toggleElevationMap': [code('F8', 'F8', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'camera.anchorFocus1': [code('F1', 'F1')],
    'camera.anchorFocus2': [code('F2', 'F2')],
    'camera.anchorFocus3': [code('F3', 'F3')],
    'camera.anchorFocus4': [code('F4', 'F4')],
    'camera.anchorSet1': [code('Ctrl+F1', 'F1', { ctrl: true })],
    'camera.anchorSet2': [code('Ctrl+F2', 'F2', { ctrl: true })],
    'camera.anchorSet3': [code('Ctrl+F3', 'F3', { ctrl: true })],
    'camera.anchorSet4': [code('Ctrl+F4', 'F4', { ctrl: true })],
  }),
  'bar-legacy': commandPreset({
    'waypoint.move': [code('M', 'KeyM', { shift: 'any' })],
    'waypoint.fight': [code('F', 'KeyF', { shift: 'any' })],
    'waypoint.patrol': [code('P', 'KeyP', { shift: 'any' })],
    'formation.assume': [],
    'formation.move': [],
    'command.stop': [code('S', 'KeyS', { shift: 'any' })],
    'command.wait': [
      code('W', 'KeyW', { shift: 'any' }),
    ],
    'command.gatherWait': [],
    'command.repeat': [],
    'command.factoryGuard': [],
    'command.builderPriority': [],
    'command.carrierSpawn': [],
    'command.moveState': [],
    'command.trajectoryToggle': [],
    'command.cloak': [code('K', 'KeyK', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'command.skipCurrent': [code('N', 'KeyN', { shift: 'any' })],
    'command.undoQueue': [code('Ctrl+N', 'KeyN', { ctrl: true })],
    'command.clearQueue': [],
    'command.fireToggle': [],
    'command.buildingActive': [code('X', 'KeyX', { shift: 'any' })],
    'command.selfDestruct': [code('Ctrl+D', 'KeyD', { ctrl: true, shift: 'any' })],
    'command.scan': [],
    'command.areaMex': [
      code('Z', 'KeyZ'),
      code('Shift+Z', 'KeyZ', { shift: true }),
      code('Ctrl+Alt+Z', 'KeyZ', { ctrl: true, alt: true }),
    ],
    'command.morph': [],
    'command.upgradeMexSelected': [],
    'command.upgradeMexArea': [],
    'command.buildCycle': [],
    'command.dgun': [code('D', 'KeyD', { shift: 'any' })],
    'command.selectCommander': [
      code('Ctrl+C', 'KeyC', { ctrl: true }),
    ],
    'factoryPreset.load1': [code('Meta+0', 'Digit0', { meta: true })],
    'factoryPreset.load2': [code('Meta+1', 'Digit1', { meta: true })],
    'factoryPreset.load3': [code('Meta+2', 'Digit2', { meta: true })],
    'factoryPreset.load4': [code('Meta+3', 'Digit3', { meta: true })],
    'factoryPreset.load5': [code('Meta+4', 'Digit4', { meta: true })],
    'factoryPreset.load6': [code('Meta+5', 'Digit5', { meta: true })],
    'factoryPreset.load7': [code('Meta+6', 'Digit6', { meta: true })],
    'factoryPreset.load8': [code('Meta+7', 'Digit7', { meta: true })],
    'factoryPreset.load9': [code('Meta+8', 'Digit8', { meta: true })],
    'factoryPreset.load10': [code('Meta+9', 'Digit9', { meta: true })],
    'factoryPreset.save1': [code('Meta+Alt+0', 'Digit0', { meta: true, alt: true })],
    'factoryPreset.save2': [code('Meta+Alt+1', 'Digit1', { meta: true, alt: true })],
    'factoryPreset.save3': [code('Meta+Alt+2', 'Digit2', { meta: true, alt: true })],
    'factoryPreset.save4': [code('Meta+Alt+3', 'Digit3', { meta: true, alt: true })],
    'factoryPreset.save5': [code('Meta+Alt+4', 'Digit4', { meta: true, alt: true })],
    'factoryPreset.save6': [code('Meta+Alt+5', 'Digit5', { meta: true, alt: true })],
    'factoryPreset.save7': [code('Meta+Alt+6', 'Digit6', { meta: true, alt: true })],
    'factoryPreset.save8': [code('Meta+Alt+7', 'Digit7', { meta: true, alt: true })],
    'factoryPreset.save9': [code('Meta+Alt+8', 'Digit8', { meta: true, alt: true })],
    'factoryPreset.save10': [code('Meta+Alt+9', 'Digit9', { meta: true, alt: true })],
    'factory.stopProduction': [code('Ctrl+S', 'KeyS', { ctrl: true, shift: 'any' })],
    'factory.queueMode': [code('Alt+G', 'KeyG', { alt: true, shift: 'any' })],
    'factory.airIdleState': [],
    'build.slot1': [],
    'build.slot2': [],
    'build.slot3': [],
    'build.slot4': [],
    'build.slot5': [],
    'build.slot6': [],
    'build.slot7': [],
    'build.slot8': [],
    'build.slot9': [],
    'build.slot10': [],
    'build.slot11': [],
    'build.slot12': [],
    'build.spacingIncrease': [code('Alt+Z', 'KeyZ', { alt: true, shift: 'any' })],
    'build.spacingDecrease': [code('Alt+X', 'KeyX', { alt: true, shift: 'any' })],
    'build.rotateClockwise': [code(']', 'BracketRight', { shift: 'any' })],
    'build.rotateCounterClockwise': [code('[', 'BracketLeft', { shift: 'any' })],
    'select.allUnits': [code('Ctrl+A', 'KeyA', { ctrl: true })],
    'select.matching': [code('Ctrl+Z', 'KeyZ', { ctrl: true })],
    'select.matchingInView': [],
    'select.previous': [],
    'select.previousNotInControlGroups': [code('Ctrl+X', 'KeyX', { ctrl: true })],
    'select.previousNonBuildersNotInControlGroups': [code('Ctrl+V', 'KeyV', { ctrl: true })],
    'select.groundWeaponUnits': [code('Ctrl+W', 'KeyW', { ctrl: true })],
    'select.idleBuilders': [code('Ctrl+B', 'KeyB', { ctrl: true })],
    'select.idleTransports': [],
    'select.waitingUnits': [],
    'select.sameTypeOnly': [],
    'select.mobileOnly': [],
    // BAR legacy_keys.txt has no damaged-selection or split-selection binds
    // (Q is drawinmap there), so these stay hotkey-less like the other
    // legacy selection filters.
    'select.damagedOnly': [],
    'select.invert': [],
    'select.split': [],
    'select.loop': [],
    'combat.attack': [code('A', 'KeyA', { shift: 'any' })],
    'combat.attackLine': [],
    'combat.attackArea': [code('Alt+A', 'KeyA', { alt: true, shift: 'any' })],
    'combat.attackGround': [],
    'combat.guard': [code('G', 'KeyG', { shift: 'any' })],
    'combat.reclaim': [code('E', 'KeyE', { shift: 'any' })],
    'combat.capture': [],
    'combat.resurrect': [code('Ctrl+R', 'KeyR', { ctrl: true, shift: 'any' })],
    'combat.resurrectArea': [],
    'combat.loadTransport': [code('L', 'KeyL', { shift: 'any' })],
    'combat.unloadTransport': [code('U', 'KeyU', { shift: 'any' })],
    'combat.manualLaunch': [code('D', 'KeyD', { shift: 'any' })],
    'combat.repair': [code('R', 'KeyR', { shift: 'any' })],
    'combat.restore': [],
    'combat.ping': [],
    'combat.towerTargetSet': [code('Alt+Y', 'KeyY', { alt: true, shift: 'any' })],
    'combat.towerTargetSetNoGround': [code('Y', 'KeyY', { shift: 'any' })],
    'combat.towerTargetClear': [code('J', 'KeyJ', { shift: 'any' })],
    // BAR chat_and_ui_keys.txt binds "Any+pause pause".
    'ui.pause': [code('Pause', 'Pause', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    // legacy_keys.txt/legacy_keys_60pct.txt bind the grid speed chords plus
    // Alt+Insert / Alt+Delete.
    'ui.gameSpeedIncrease': [
      code('Alt+Insert', 'Insert', { alt: true }),
      code('Alt+=', 'Equal', { alt: true }),
      code('Alt+Numpad+', 'NumpadAdd', { alt: true }),
    ],
    'ui.gameSpeedDecrease': [
      code('Alt+Delete', 'Delete', { alt: true }),
      code('Alt+-', 'Minus', { alt: true }),
      code('Alt+Numpad-', 'NumpadSubtract', { alt: true }),
    ],
    'ui.optionsMenu': [code('F10', 'F10')],
    'ui.showMapOverview': [key('Tab', 'tab', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    // legacy_keys.txt: "bind Any+space unit_stats". Space doubles as the
    // BAR queue-front modifier (chat_and_ui_keys.txt "Any+space
    // commandinsert prepend") — the same overlap exists in BAR itself:
    // holding Space both shows the stats peek and prepends commands.
    'ui.unitStats': [code('Space', 'Space', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    // legacy_keys.txt/legacy_keys_60pct.txt: sc_i customgameinfo.
    'ui.customGameInfo': [code('I', 'KeyI')],
    'ui.flipCameraYaw': [code('Ctrl+Shift+O', 'KeyO', { ctrl: true, shift: true })],
    'camera.toggleMode': [
      key('Shift+Backspace', 'backspace', { shift: true }),
      key('Ctrl+Backspace', 'backspace', { ctrl: true }),
    ],
    // chat_and_ui_keys.txt: Ctrl+sc_o / Numpad1 fov_dec 5,
    // Ctrl+sc_p / Numpad7 fov_inc 5.
    'camera.fovDecrease': [
      code('Ctrl+O', 'KeyO', { ctrl: true }),
      code('Numpad1', 'Numpad1'),
    ],
    'camera.fovIncrease': [
      code('Ctrl+P', 'KeyP', { ctrl: true }),
      code('Numpad7', 'Numpad7'),
    ],
    // legacy_keys.txt/legacy_keys_60pct.txt: Any+home increaseViewRadius,
    // Any+end decreaseViewRadius.
    'camera.viewRadiusIncrease': [code('Home', 'Home', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'camera.viewRadiusDecrease': [code('End', 'End', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'camera.viewTa': [code('Ctrl+F2', 'F2', { ctrl: true })],
    'camera.viewSpring': [code('Ctrl+F3', 'F3', { ctrl: true })],
    'ui.goToLastPing': [code('F3', 'F3', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'ui.toggleUiChrome': [code('F5', 'F5', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'ui.muteSound': [code('F6', 'F6', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    // snd_volume_osd.lua: +/- step master volume by 8.
    'ui.volumeIncrease': [
      code('Numpad+', 'NumpadAdd'),
      code('=', 'Equal'),
    ],
    'ui.volumeDecrease': [
      code('-', 'Minus'),
      code('Numpad-', 'NumpadSubtract'),
    ],
    'ui.captureScreenshot': [code('F12', 'F12', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'ui.toggleFullscreen': [
      key('Alt+Backspace', 'backspace', { alt: true }),
      key('Alt+Enter', 'enter', { alt: true }),
    ],
    'ui.chat': [key('Enter', 'enter', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'ui.mapDraw': [
      code('Q', 'KeyQ'),
      code('`', 'Backquote'),
    ],
    'ui.mapLabel': [
      sequence(code('Q', 'KeyQ'), code('Q', 'KeyQ')),
      sequence(code('`', 'Backquote'), code('`', 'Backquote')),
    ],
    'ui.mapErase': [],
    // chat_and_ui_keys.txt: Alt+sc_. attack_range_inc,
    // Alt+sc_comma attack_range_dec.
    'ui.attackRangeCycleNext': [code('Alt+.', 'Period', { alt: true })],
    'ui.attackRangeCyclePrevious': [code('Alt+,', 'Comma', { alt: true })],
    // legacy_keys.txt/legacy_keys_60pct.txt: Any+sc_l togglelos. Plain
    // legacy L remains loadunits because BAR also binds that active order.
    'ui.toggleLosMap': [code('L', 'KeyL', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'ui.togglePathingMap': [code('F2', 'F2', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'ui.toggleMetalMap': [code('F4', 'F4', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'ui.toggleElevationMap': [code('F1', 'F1', { ctrl: 'any', shift: 'any', alt: 'any', meta: 'any' })],
    'camera.anchorFocus1': [],
    'camera.anchorFocus2': [],
    'camera.anchorFocus3': [],
    'camera.anchorFocus4': [],
    'camera.anchorSet1': [],
    'camera.anchorSet2': [],
    'camera.anchorSet3': [],
    'camera.anchorSet4': [],
  }),
};

const COMMAND_HOTKEY_PRESETS: Readonly<Record<BuiltInCommandHotkeyPresetId, CommandHotkeyPreset>> = {
  ...BASE_COMMAND_HOTKEY_PRESETS,
  'bar-grid-60pct': withCommandHotkeyOverrides(
    withoutFactoryPresetBindings(BASE_COMMAND_HOTKEY_PRESETS['bar-grid']),
    {
      'factory.queueMode': [],
      'ui.mapDraw': [code('Meta+Q', 'KeyQ', { meta: true })],
      'ui.mapLabel': [
        sequence(
          code('Meta+Q', 'KeyQ', { meta: true }),
          code('Meta+Q', 'KeyQ', { meta: true }),
        ),
      ],
      // grid_keys_60pct.txt moves the damaged filter to Ctrl+Alt+sc_q because
      // Alt+Q is the 60% autogroup-remove chord.
      'select.damagedOnly': [code('Ctrl+Alt+Q', 'KeyQ', { ctrl: true, alt: true })],
      'camera.viewTa': [code('Ctrl+Meta+5', 'Digit5', { ctrl: true, meta: true })],
      'camera.viewSpring': [code('Ctrl+Meta+6', 'Digit6', { ctrl: true, meta: true })],
      'ui.goToLastPing': [code('Meta+5', 'Digit5', { meta: true })],
      'ui.toggleUiChrome': [code('Ctrl+Meta+7', 'Digit7', { ctrl: true, meta: true })],
      'camera.anchorFocus1': [code('Meta+1', 'Digit1', { meta: true })],
      'camera.anchorFocus2': [code('Meta+2', 'Digit2', { meta: true })],
      'camera.anchorFocus3': [code('Meta+3', 'Digit3', { meta: true })],
      'camera.anchorFocus4': [code('Meta+4', 'Digit4', { meta: true })],
      'camera.anchorSet1': [code('Ctrl+Meta+1', 'Digit1', { ctrl: true, meta: true })],
      'camera.anchorSet2': [code('Ctrl+Meta+2', 'Digit2', { ctrl: true, meta: true })],
      'camera.anchorSet3': [code('Ctrl+Meta+3', 'Digit3', { ctrl: true, meta: true })],
      'camera.anchorSet4': [code('Ctrl+Meta+4', 'Digit4', { ctrl: true, meta: true })],
      'ui.togglePathingMap': [code('Meta+6', 'Digit6', { meta: true })],
      'ui.toggleMetalMap': [code('Meta+7', 'Digit7', { meta: true })],
      'ui.toggleElevationMap': [code('Meta+8', 'Digit8', { meta: true })],
    },
  ),
  'bar-legacy-60pct': withCommandHotkeyOverrides(
    withoutFactoryPresetBindings(BASE_COMMAND_HOTKEY_PRESETS['bar-legacy']),
    {
      'factory.queueMode': [],
      'ui.mapDraw': [code('Q', 'KeyQ')],
      'ui.mapLabel': [sequence(code('Q', 'KeyQ'), code('Q', 'KeyQ'))],
      'ui.optionsMenu': [],
      'camera.viewTa': [code('Ctrl+Meta+2', 'Digit2', { ctrl: true, meta: true })],
      'camera.viewSpring': [code('Ctrl+Meta+3', 'Digit3', { ctrl: true, meta: true })],
      'ui.goToLastPing': [code('Meta+3', 'Digit3', { meta: true })],
      'ui.toggleUiChrome': [code('Meta+5', 'Digit5', { meta: true })],
      'ui.muteSound': [code('Meta+6', 'Digit6', { meta: true })],
      'ui.captureScreenshot': [code('Meta+8', 'Digit8', { meta: true })],
      'ui.togglePathingMap': [code('Meta+2', 'Digit2', { meta: true })],
      'ui.toggleMetalMap': [code('Meta+4', 'Digit4', { meta: true })],
      'ui.toggleElevationMap': [code('Meta+1', 'Digit1', { meta: true })],
    },
  ),
};

type CommandHotkeyConflict = {
  presetId: CommandHotkeyPresetId;
  signature: string;
  commandIds: CommandHotkeyId[];
};

type CommandHotkeyResolution = {
  commandId: CommandHotkeyId | null;
  pending: boolean;
};

const COMMAND_HOTKEY_SEQUENCE_TIMEOUT_MS = 900;

type PendingCommandHotkeySequence = {
  presetId: CommandHotkeyPresetId;
  scope: CommandHotkeyScope;
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

function isCommandHotkeyPresetId(value: unknown): value is CommandHotkeyPresetId {
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
  if (firstBinding === undefined) return '';
  return bindingLabel(firstBinding);
}

export function resolveCommandHotkey(
  event: KeyboardEvent,
  presetId: CommandHotkeyPresetId = getActiveCommandHotkeyPresetId(),
  scope: CommandHotkeyScope = 'global',
): CommandHotkeyId | null {
  return resolveSingleChordCommandHotkey(event, presetId, scope);
}

export class CommandHotkeySequenceResolver {
  private pendingSequence: PendingCommandHotkeySequence | null = null;

  resolve(
    event: KeyboardEvent,
    presetId: CommandHotkeyPresetId = getActiveCommandHotkeyPresetId(),
    timeMs: number = event.timeStamp,
    scope: CommandHotkeyScope = 'global',
  ): CommandHotkeyResolution {
    const nowMs = Number.isFinite(timeMs) ? timeMs : 0;
    if (
      this.pendingSequence !== null &&
      (
        this.pendingSequence.presetId !== presetId ||
        this.pendingSequence.scope !== scope ||
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

    const sequence = findMatchingSequenceStart(event, presetId, scope);
    if (sequence !== null) {
      this.pendingSequence = {
        ...sequence,
        nextChordIndex: 1,
        expiresAtMs: nowMs + COMMAND_HOTKEY_SEQUENCE_TIMEOUT_MS,
      };
      return { commandId: null, pending: true };
    }

    return {
      commandId: resolveSingleChordCommandHotkey(event, presetId, scope),
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
  scope: CommandHotkeyScope,
): CommandHotkeyId | null {
  const preset = getCommandHotkeyPreset(presetId);
  for (const commandId of COMMAND_HOTKEY_IDS) {
    if (commandHotkeyScope(commandId) !== scope) continue;
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
  scope: CommandHotkeyScope,
): Omit<PendingCommandHotkeySequence, 'nextChordIndex' | 'expiresAtMs'> | null {
  const preset = getCommandHotkeyPreset(presetId);
  for (const commandId of COMMAND_HOTKEY_IDS) {
    if (commandHotkeyScope(commandId) !== scope) continue;
    const bindings = preset[commandId];
    for (const binding of bindings) {
      if (binding.length > 1 && keyChordMatchesEvent(binding[0], event)) {
        return { presetId, scope, commandId, binding };
      }
    }
  }
  return null;
}

export function getCommandHotkeyConflicts(
  presetId: CommandHotkeyPresetId,
): CommandHotkeyConflict[] {
  const ownersBySignature = new Map<string, { signature: string; commandIds: CommandHotkeyId[] }>();
  const preset = getCommandHotkeyPreset(presetId);
  for (const commandId of COMMAND_HOTKEY_IDS) {
    for (const binding of preset[commandId]) {
      const signature = bindingSignature(binding);
      const scope = commandHotkeyScope(commandId);
      const scopedSignature = `${scope}:${signature}`;
      const owners = ownersBySignature.get(scopedSignature);
      if (owners) owners.commandIds.push(commandId);
      else ownersBySignature.set(scopedSignature, { signature, commandIds: [commandId] });
    }
  }

  const conflicts: CommandHotkeyConflict[] = [];
  for (const { signature, commandIds } of ownersBySignature.values()) {
    const uniqueCommandIds: CommandHotkeyId[] = [];
    for (let i = 0; i < commandIds.length; i++) {
      const commandId = commandIds[i];
      let seen = false;
      for (let j = 0; j < uniqueCommandIds.length; j++) {
        if (uniqueCommandIds[j] !== commandId) continue;
        seen = true;
        break;
      }
      if (!seen) uniqueCommandIds.push(commandId);
    }
    if (
      uniqueCommandIds.length > 1 &&
      !isAllowedContextualCommandHotkeyConflict(presetId, signature, uniqueCommandIds) &&
      !isAllowedContextualStateHotkeyConflict(presetId, signature, uniqueCommandIds) &&
      !isAllowedContextualSupportHotkeyConflict(presetId, signature, uniqueCommandIds)
    ) {
      conflicts.push({ presetId, signature, commandIds: uniqueCommandIds });
    }
  }
  return conflicts;
}

function isAllowedContextualCommandHotkeyConflict(
  presetId: CommandHotkeyPresetId,
  signature: string,
  commandIds: readonly CommandHotkeyId[],
): boolean {
  if (!isBarCommandHotkeyPreset(presetId)) return false;
  if (signature !== 'ctrl:0+shift:any+alt:0+meta:0+keyd') return false;
  return commandIds.length === 2 &&
    commandIds.includes('command.dgun') &&
    commandIds.includes('combat.manualLaunch');
}

function isAllowedContextualStateHotkeyConflict(
  presetId: CommandHotkeyPresetId,
  signature: string,
  commandIds: readonly CommandHotkeyId[],
): boolean {
  if (!isBarGridCommandHotkeyPreset(presetId)) return false;
  if (signature !== 'ctrl:0+shift:any+alt:0+meta:0+keyb') return false;
  return commandIds.length === 2 &&
    commandIds.includes('command.trajectoryToggle') &&
    commandIds.includes('command.buildingActive');
}

function isAllowedContextualSupportHotkeyConflict(
  presetId: CommandHotkeyPresetId,
  signature: string,
  commandIds: readonly CommandHotkeyId[],
): boolean {
  if (!isBarGridCommandHotkeyPreset(presetId)) return false;
  if (signature !== 'ctrl:0+shift:any+alt:0+meta:0+keyw') return false;
  return commandIds.length === 2 &&
    commandIds.includes('combat.capture') &&
    commandIds.includes('combat.resurrect');
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
  let label = '';
  for (let i = 0; i < binding.length; i++) {
    if (i > 0) label += ' ';
    label += binding[i].label;
  }
  return label;
}

function bindingSignature(binding: CommandHotkeyBinding): string {
  let signature = '';
  for (let i = 0; i < binding.length; i++) {
    if (i > 0) signature += ',';
    signature += chordSignature(binding[i]);
  }
  return signature;
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
