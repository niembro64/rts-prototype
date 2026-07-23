import {
  COMMAND_HOTKEY_DISPLAY_LABELS,
  COMMAND_HOTKEY_IDS,
  COMMAND_HOTKEY_PRESET_IDS,
  barMapDrawCommandForTapCount,
  barMapDrawHotkeySignature,
  commandHotkeyLabel,
  getCommandHotkeyPreset,
  getCommandHotkeyConflicts,
  resolveCommandHotkey,
} from './commandHotkeys';
import {
  clearQueueModifierState,
  factoryProductionClickModeFromEvent,
  factoryProductionKeyModeFromEvent,
  queueModeForDragRelease,
  queueModeFromEvent,
  setQueueModifierKeyState,
  setSpaceQueueFrontEligibilityProvider,
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

function isIntentionallyUnboundCommand(presetId: string, commandId: string): boolean {
  const isBarGridPreset = presetId === 'bar-grid' || presetId === 'bar-grid-60pct';
  const isBarLegacyPreset = presetId === 'bar-legacy' || presetId === 'bar-legacy-60pct';
  const isBarPreset = isBarGridPreset || isBarLegacyPreset;
  const isPrototypeLikePreset = presetId === 'prototype' || presetId === 'custom';
  if (
    (presetId === 'bar-grid-60pct' || presetId === 'bar-legacy-60pct') &&
    commandId.startsWith('factoryPreset.')
  ) {
    return true;
  }
  if (
    (presetId === 'bar-grid-60pct' || presetId === 'bar-legacy-60pct') &&
    commandId === 'factory.queueMode'
  ) {
    return true;
  }
  if (presetId === 'bar-legacy-60pct' && commandId === 'ui.optionsMenu') return true;
  if (isPrototypeLikePreset && commandId === 'command.areaMex') return true;
  if (isPrototypeLikePreset && commandId === 'select.damagedOnly') return true;
  if (isPrototypeLikePreset && commandId === 'ui.customGameInfo') return true;
  if (isPrototypeLikePreset && commandId === 'ui.toggleLosMap') return true;
  if (isPrototypeLikePreset && commandId.startsWith('ui.attackRangeCycle')) return true;
  if (isPrototypeLikePreset && commandId.startsWith('ui.volume')) return true;
  if (isPrototypeLikePreset && commandId.startsWith('camera.fov')) return true;
  if (!isBarLegacyPreset && commandId.startsWith('camera.viewRadius')) return true;
  if (!isBarLegacyPreset && commandId === 'camera.toggleMode') return true;
  if (isBarPreset && commandId === 'select.previous') return true;
  if (!isBarLegacyPreset && commandId === 'select.previousNotInControlGroups') return true;
  if (!isBarLegacyPreset && commandId === 'select.previousNonBuildersNotInControlGroups') return true;
  if (!isBarLegacyPreset && commandId === 'select.groundWeaponUnits') return true;
  if (commandId === 'combat.restore') return true;
  if (commandId === 'command.builderPriority') return true;
  if (commandId === 'command.carrierSpawn') return true;
  if (commandId === 'factory.airIdleState') return true;
  if (commandId === 'command.morph') return true;
  if (
    isBarPreset &&
    (
      commandId === 'command.clearQueue' ||
      commandId === 'command.scan' ||
      (commandId === 'command.areaMex' && isBarGridPreset) ||
      commandId === 'command.upgradeMexSelected' ||
      commandId === 'command.upgradeMexArea' ||
      (isBarLegacyPreset && commandId.startsWith('camera.anchor')) ||
      (isBarLegacyPreset && commandId === 'formation.assume') ||
      (isBarLegacyPreset && commandId === 'formation.move') ||
      (isBarLegacyPreset && commandId === 'command.gatherWait') ||
      (isBarLegacyPreset && commandId === 'command.repeat') ||
      (isBarLegacyPreset && commandId === 'command.factoryGuard') ||
      (isBarLegacyPreset && commandId === 'command.moveState') ||
      (isBarLegacyPreset && commandId === 'command.trajectoryToggle') ||
      (isBarLegacyPreset && commandId === 'command.fireToggle') ||
      (isBarLegacyPreset && commandId === 'command.buildCycle') ||
      (isBarLegacyPreset && commandId.startsWith('build.slot')) ||
      (isBarGridPreset && commandId === 'select.sameTypeOnly') ||
      (isBarGridPreset && commandId === 'select.invert') ||
      (isBarGridPreset && commandId === 'select.loop') ||
      commandId === 'select.mobileOnly' ||
      (isBarLegacyPreset && (
        commandId === 'select.matchingInView' ||
        commandId === 'select.previous' ||
        commandId === 'select.idleTransports' ||
        commandId === 'select.waitingUnits' ||
        commandId === 'select.sameTypeOnly' ||
        commandId === 'select.damagedOnly' ||
        commandId === 'select.invert' ||
        commandId === 'select.split' ||
        commandId === 'select.loop'
      )) ||
      commandId === 'combat.ping' ||
      (isBarLegacyPreset && commandId === 'combat.capture') ||
      commandId === 'combat.attackLine' ||
      commandId === 'combat.attackGround' ||
      commandId === 'combat.resurrectArea' ||
      commandId === 'ui.mapErase'
    )
  ) {
    return true;
  }
  return isBarGridPreset && (
    commandId === 'waypoint.move'
    || commandId === 'formation.assume'
    || commandId === 'formation.move'
    || commandId === 'command.buildCycle'
    || commandId === 'combat.attackLine'
    || commandId === 'combat.attackGround'
  );
}

export function runCommandHotkeysContractTest(): void {
  clearQueueModifierState();
  for (const presetId of COMMAND_HOTKEY_PRESET_IDS) {
    const preset = getCommandHotkeyPreset(presetId);
    for (const commandId of COMMAND_HOTKEY_IDS) {
      const bindings = preset[commandId];
      if (isIntentionallyUnboundCommand(presetId, commandId)) {
        const reason = commandId.startsWith('factoryPreset.')
          ? 'BAR 60% hotkey configs explicitly unbind factory presets and their held-space preview'
          : commandId === 'factory.queueMode'
            ? 'BAR 60% hotkey configs do not bind factoryqueuemode'
          : commandId === 'factory.airIdleState'
            ? 'BAR air-plant aplandat has no default hotkey binding'
          : commandId === 'ui.optionsMenu'
            ? 'BAR legacy 60% does not bind the options menu'
          : commandId === 'ui.customGameInfo'
            ? 'prototype/custom do not expose BAR customgameinfo'
          : commandId === 'ui.toggleLosMap'
            ? 'prototype/custom do not have BAR togglelos view-mode semantics'
          : commandId.startsWith('ui.attackRangeCycle')
            ? 'prototype/custom do not expose BAR Attack Range GL4 cycle hotkeys'
          : commandId.startsWith('ui.volume')
            ? 'prototype/custom do not expose BAR snd_volume_osd hotkeys'
          : commandId.startsWith('camera.fov')
            ? 'prototype/custom do not expose BAR camera FOV step hotkeys'
          : commandId.startsWith('camera.viewRadius')
            ? 'BAR only binds increase/decreaseViewRadius in the legacy hotkey presets'
          : commandId === 'camera.toggleMode'
            ? 'BAR only binds togglecammode in the legacy hotkey presets'
          : commandId.startsWith('camera.anchor')
            ? 'BAR legacy presets do not bind camera anchors'
          : commandId === 'waypoint.move'
          ? 'BAR grid does not bind a move order key'
          : commandId === 'select.mobileOnly'
          ? 'BAR covers mobile-only selection with the held-Alt selectbox modifier, not a dedicated bind'
          : commandId === 'select.damagedOnly'
            ? presetId === 'prototype' || presetId === 'custom'
              ? 'prototype reserves Alt+Q for autogroup removal, so the damaged filter is panel/BAR-preset-only'
              : 'BAR legacy does not bind the damaged-selection filter'
          : commandId === 'select.invert'
            ? 'BAR exposes invert selection through held selectbox/loop modifiers, not a standalone invert-selection hotkey'
          : commandId === 'select.loop'
            ? 'BAR exposes loop selection through held Space selectloop behavior, not a standalone loop-selection hotkey'
          : commandId === 'formation.assume' || commandId === 'formation.move'
            ? 'BAR uses formation drag behavior, not separate formation order buttons'
          : commandId === 'command.clearQueue'
            ? 'BAR exposes skip-current and cancel-last queue commands, not clear-all queue'
          : commandId === 'command.scan'
            ? 'BAR does not bind a separate scanner sweep; those F-keys are map overlay toggles'
          : commandId === 'command.areaMex'
            ? 'Area Mex is exposed as a BAR order command; prototype/custom do not add a shortcut and BAR-grid keeps Z for build-grid slot 1'
          : commandId === 'combat.restore'
            ? 'Restore is unavailable while the authoritative terrain is immutable, matching Recoil map-damage capability gating'
          : commandId === 'command.builderPriority'
            ? 'BAR exposes builder priority as a visible state command without a default keyboard shortcut'
          : commandId === 'command.carrierSpawn'
            ? 'BAR exposes carrier spawning as a visible state command without a default keyboard shortcut'
          : commandId === 'command.morph'
            ? 'BAR exposes morph as a visible Upgrade command without a default keyboard shortcut'
          : commandId === 'command.upgradeMexSelected' || commandId === 'command.upgradeMexArea'
            ? 'BAR exposes mex placement/upgrades through areamex, buildunit, morph, and quick-build behavior, not prototype Alt+U shortcuts'
          : commandId === 'command.gatherWait'
            ? 'BAR legacy does not bind Gather Wait'
          : commandId === 'command.repeat'
            ? 'BAR legacy does not bind Repeat'
          : commandId === 'command.factoryGuard'
            ? 'BAR legacy does not bind Factory Guard'
          : commandId === 'command.moveState'
            ? 'BAR legacy does not bind Move State'
          : commandId === 'command.trajectoryToggle'
            ? 'BAR legacy does not bind Trajectory'
          : commandId === 'command.fireToggle'
            ? 'BAR legacy does not bind Fire State'
          : commandId === 'combat.ping'
            ? 'BAR uses map-draw/map-label commands for pings, not a separate Ping order button'
          : commandId === 'combat.capture'
            ? 'BAR legacy does not bind Capture; C is used by legacy build bindings'
          : commandId === 'combat.resurrectArea'
            ? 'BAR resurrect is area-capable without a separate resurrect-area button'
          : commandId === 'ui.mapErase'
            ? 'BAR erases map drawings through the draw key plus right-mouse drag, not a separate erase hotkey'
          : commandId === 'command.buildCycle'
            ? presetId === 'bar-grid' || presetId === 'bar-grid-60pct'
              ? 'BAR-grid period cycles the active builder type, not build blueprints'
              : 'BAR legacy B is reserved by buildmenu/build-unit context, not cycle-build'
            : commandId === 'combat.attackLine'
              ? 'BAR exposes attack and area attack, not a separate Attack Line order'
              : 'BAR exposes ground targeting through Attack, not a separate Attack Ground order';
        assertContract(
          bindings.length === 0,
          `${presetId}.${commandId} must stay unbound because ${reason}`,
        );
        assertContract(
          commandHotkeyLabel(commandId, presetId) === '',
          `${presetId}.${commandId} must display no fake hotkey label`,
        );
      } else {
        assertContract(
          bindings.length > 0,
          `${presetId}.${commandId} must have at least one binding`,
        );
        assertContract(
          commandHotkeyLabel(commandId, presetId).length > 0,
          `${presetId}.${commandId} must have a visible label`,
        );
      }
    }

    const conflicts = getCommandHotkeyConflicts(presetId);
    assertContract(
      conflicts.length === 0,
      `${presetId} has conflicting command hotkeys: ${
        conflicts.map((conflict) => `${conflict.signature} => ${conflict.commandIds.join(',')}`).join('; ')
      }`,
    );
  }

  assertContract(
    resolveCommandHotkey(keyEvent('l', 'KeyL'), 'bar-grid') === 'command.fireToggle',
    'bar-grid L should resolve the visible fire-state command',
  );
  assertContract(
    commandHotkeyLabel('command.fireToggle', 'bar-grid') === 'L',
    'bar-grid fire state should display the BAR L key',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('a', 'KeyA'), 'bar-grid') === 'combat.attack',
    'single-chord hotkey resolution should still resolve bar-grid A attack',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('z', 'KeyZ'), 'bar-grid', 'buildMenu') === 'build.slot1',
    'build-menu hotkey resolution should resolve bar-grid Z as build slot/category 1',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('v', 'KeyV'), 'bar-grid', 'buildMenu') === 'build.slot4',
    'build-menu hotkey resolution should resolve bar-grid V as build slot/category 4',
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
    resolveCommandHotkey(keyEvent('z', 'KeyZ', { ctrlKey: true }), 'bar-grid', 'buildMenu') === 'build.slot1',
    'BAR-grid build-menu keys must match BAR Any+ grid bindings for Ctrl+Z',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('x', 'KeyX', { shiftKey: true, altKey: true }), 'bar-grid', 'buildMenu') === 'build.slot2',
    'BAR-grid build-menu keys must match BAR Any+ grid bindings for Alt+Shift+X',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('q', 'KeyQ'), 'bar-grid') === 'select.matchingInView',
    'bar-grid Q should resolve matching-in-view selection',
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
    resolveCommandHotkey(keyEvent('n', 'KeyN'), 'bar-grid') === 'command.skipCurrent',
    'bar-grid N should resolve BAR skip-current queue command',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('n', 'KeyN', { ctrlKey: true }), 'bar-grid') === 'command.undoQueue',
    'bar-grid Ctrl+N should resolve BAR cancel-last queue command',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('y', 'KeyY', { shiftKey: true }), 'bar-grid') === 'command.wait',
    'bar-grid Shift+Y should resolve queued wait',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('y', 'KeyY', { ctrlKey: true, shiftKey: true }), 'bar-grid') === null,
    'bar-grid Ctrl+Shift+Y must not resolve a fake wait binding',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('`', 'Backquote'), 'bar-grid') === 'ui.mapDraw',
    'bar-grid backquote should resolve BAR map draw, not a separate Ping order',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('~', 'Backquote', { shiftKey: true }), 'bar-grid') === null,
    'bar-grid Shift+Backquote must not resolve BAR map draw',
  );
  assertContract(
    commandHotkeyLabel('combat.ping', 'bar-grid') === '',
    'bar-grid ping command must display no fake BAR order-menu hotkey',
  );
  assertContract(
    commandHotkeyLabel('ui.mapDraw', 'bar-grid') === '`',
    'bar-grid map draw should display the BAR backquote key',
  );
  assertContract(
    commandHotkeyLabel('ui.mapLabel', 'bar-grid') === '` `',
    'bar-grid map label should display BAR double-backquote',
  );
  assertContract(
    barMapDrawHotkeySignature(keyEvent('`', 'Backquote'), 'bar-grid') === 'bar-grid:Backquote',
    'bar-grid backquote must enter the BAR map draw double-tap resolver',
  );
  assertContract(
    barMapDrawCommandForTapCount(1) === 'ui.mapDraw' &&
      barMapDrawCommandForTapCount(2) === 'ui.mapLabel',
    'BAR map draw tap resolver must map single tap to draw and double tap to label',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('q', 'KeyQ', { metaKey: true }), 'bar-grid-60pct') === 'ui.mapDraw',
    'bar-grid-60pct Meta+Q should resolve BAR map draw',
  );
  assertContract(
    commandHotkeyLabel('ui.mapDraw', 'bar-grid-60pct') === 'Meta+Q',
    'bar-grid-60pct map draw should display BAR Meta+Q',
  );
  assertContract(
    commandHotkeyLabel('ui.mapLabel', 'bar-grid-60pct') === 'Meta+Q Meta+Q',
    'bar-grid-60pct map label should display BAR double Meta+Q',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('e', 'KeyE', { ctrlKey: true, altKey: true }), 'bar-grid') === null,
    'bar-grid must not expose a fake map-erase hotkey',
  );
  assertContract(
    commandHotkeyLabel('ui.mapErase', 'bar-grid') === '',
    'bar-grid map erase should display no separate hotkey label',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('.', 'Period', { altKey: true }), 'bar-grid') === 'ui.attackRangeCycleNext',
    'bar-grid Alt+Period should resolve BAR attack_range_inc',
  );
  assertContract(
    resolveCommandHotkey(keyEvent(',', 'Comma', { altKey: true }), 'bar-grid') === 'ui.attackRangeCyclePrevious',
    'bar-grid Alt+Comma should resolve BAR attack_range_dec',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('.', 'Period'), 'bar-grid') === null,
    'bar-grid plain Period is handled by gridmenu builder cycling, not the attack range widget',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('.', 'Period', { altKey: true }), 'bar-grid-60pct') === 'ui.attackRangeCycleNext',
    'bar-grid-60pct Alt+Period should resolve BAR attack_range_inc',
  );
  assertContract(
    resolveCommandHotkey(keyEvent(',', 'Comma', { altKey: true }), 'bar-legacy') === 'ui.attackRangeCyclePrevious',
    'bar-legacy Alt+Comma should resolve BAR attack_range_dec from chat_and_ui_keys.txt',
  );
  assertContract(
    commandHotkeyLabel('ui.attackRangeCycleNext', 'bar-grid') === 'Alt+.',
    'bar-grid attack range increment should display the BAR Alt+Period key',
  );
  assertContract(
    resolveCommandHotkey(keyEvent("'", 'Quote'), 'bar-grid') === 'ui.toggleLosMap',
    "bar-grid quote should resolve BAR togglelos",
  );
  assertContract(
    resolveCommandHotkey(keyEvent('"', 'Quote', { ctrlKey: true, shiftKey: true }), 'bar-grid-60pct') ===
      'ui.toggleLosMap',
    'bar-grid-60pct modified quote should resolve BAR Any+togglelos',
  );
  assertContract(
    commandHotkeyLabel('ui.toggleLosMap', 'bar-grid') === "'",
    'bar-grid LOS map toggle should display the BAR quote key',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('F6', 'F6'), 'bar-grid') === 'ui.togglePathingMap',
    'bar-grid F6 should toggle the path traversability overlay',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('F7', 'F7'), 'bar-grid') === 'ui.toggleMetalMap',
    'bar-grid F7 should toggle the metal map overlay',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('F8', 'F8'), 'bar-grid') === 'ui.toggleElevationMap',
    'bar-grid F8 should toggle the elevation map overlay',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('t', 'KeyT', { ctrlKey: true }), 'bar-grid') === 'ui.showMapOverview',
    'bar-grid Ctrl+T should toggle BAR overview',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('Tab', 'Tab'), 'bar-grid') === 'command.selectCommander',
    'bar-grid Tab should still select the commander',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('t', 'KeyT'), 'bar-grid') === 'command.repeat',
    'bar-grid plain T should remain repeat orders',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('F5', 'F5', { ctrlKey: true }), 'bar-grid') === 'camera.viewTa',
    'bar-grid Ctrl+F5 should switch to TA camera view',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('F5', 'F5'), 'bar-grid') === 'ui.goToLastPing',
    'bar-grid F5 should jump to the last message position',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('F6', 'F6', { ctrlKey: true }), 'bar-grid') === 'camera.viewSpring',
    'bar-grid Ctrl+F6 should switch to Spring camera view',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('F7', 'F7', { ctrlKey: true }), 'bar-grid') === 'ui.toggleUiChrome',
    'bar-grid Ctrl+F7 should hide or show the interface',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('o', 'KeyO', { ctrlKey: true }), 'bar-grid') === 'camera.fovDecrease',
    'bar-grid Ctrl+O should decrease camera FOV like chat_and_ui_keys.txt',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('p', 'KeyP', { ctrlKey: true }), 'bar-grid') === 'camera.fovIncrease',
    'bar-grid Ctrl+P should increase camera FOV like chat_and_ui_keys.txt',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('1', 'Numpad1'), 'bar-grid') === 'camera.fovDecrease',
    'bar-grid Numpad1 should decrease camera FOV like chat_and_ui_keys.txt',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('7', 'Numpad7'), 'bar-grid') === 'camera.fovIncrease',
    'bar-grid Numpad7 should increase camera FOV like chat_and_ui_keys.txt',
  );
  assertContract(
    commandHotkeyLabel('camera.fovDecrease', 'bar-grid') === 'Ctrl+O',
    'bar-grid FOV decrease should display the first BAR FOV decrease binding',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('Backspace', 'Backspace'), 'bar-grid') === 'ui.muteSound',
    'bar-grid Backspace should mute or unmute sound',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('+', 'NumpadAdd'), 'bar-grid') === 'ui.volumeIncrease',
    'bar-grid Numpad+ should resolve BAR snd_volume_increase',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('=', 'Equal'), 'bar-grid') === 'ui.volumeIncrease',
    'bar-grid = should resolve BAR snd_volume_increase',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('-', 'Minus'), 'bar-grid') === 'ui.volumeDecrease',
    'bar-grid - should resolve BAR snd_volume_decrease',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('-', 'NumpadSubtract'), 'bar-grid') === 'ui.volumeDecrease',
    'bar-grid Numpad- should resolve BAR snd_volume_decrease',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('F12', 'F12'), 'bar-grid') === 'ui.captureScreenshot',
    'bar-grid F12 should capture a screenshot',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('F10', 'F10'), 'bar-grid') === 'ui.optionsMenu',
    'bar-grid plain F10 should open options',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('F10', 'F10', { ctrlKey: true }), 'bar-grid') === null,
    'bar-grid Ctrl+F10 must not expose a fake options binding',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('Backspace', 'Backspace', { altKey: true }), 'bar-grid') === 'ui.toggleFullscreen',
    'bar-grid Alt+Backspace should toggle fullscreen',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('Enter', 'Enter', { ctrlKey: true }), 'bar-grid') === 'ui.chat' &&
      resolveCommandHotkey(keyEvent('Enter', 'Enter', { altKey: true }), 'bar-grid') === 'ui.chat' &&
      commandHotkeyLabel('ui.chat', 'bar-grid') === 'Enter',
    'bar-grid modified Enter should still open chat because chat_and_ui_keys.txt binds Any+enter chat',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('o', 'KeyO', { altKey: true }), 'bar-grid') === 'ui.flipCameraYaw',
    'bar-grid Alt+O should flip the camera',
  );
  // BAR grid_keys.txt: "bind sc_i unit_stats" — plain I holds the stats peek.
  assertContract(
    resolveCommandHotkey(keyEvent('i', 'KeyI'), 'bar-grid') === 'ui.unitStats',
    'bar-grid plain I should hold the unit stats peek (grid_keys.txt sc_i unit_stats)',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('i', 'KeyI', { ctrlKey: true }), 'bar-grid') === 'ui.customGameInfo',
    'bar-grid Ctrl+I should toggle customgameinfo like grid_keys.txt',
  );
  assertContract(
    commandHotkeyLabel('ui.customGameInfo', 'bar-grid') === 'Ctrl+I',
    'bar-grid custom game info should display the BAR Ctrl+I key',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('i', 'KeyI', { altKey: true }), 'bar-grid') === null,
    'bar-grid Alt+I must stay unbound because BAR uses held selectbox/loop modifiers rather than a standalone invert-selection hotkey',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('l', 'KeyL', { altKey: true }), 'bar-grid') === null,
    'bar-grid Alt+L must stay unbound because BAR has no standalone loop-selection hotkey',
  );
  assertContract(
    resolveCommandHotkey(keyEvent(' ', 'Space'), 'bar-grid') === null,
    'bar-grid Space is the queue-front modifier only, never the stats peek',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('F7', 'F7'), 'bar-grid') !== 'command.scan',
    'bar-grid F7 must not trigger the prototype scanner sweep',
  );
  assertContract(
    commandHotkeyLabel('command.scan', 'bar-grid') === '',
    'bar-grid scanner sweep should display no fake F7 hotkey',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('6', 'Digit6', { metaKey: true }), 'bar-grid-60pct') === 'ui.togglePathingMap',
    'bar-grid-60pct Meta+6 should toggle the path traversability overlay',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('7', 'Digit7', { metaKey: true }), 'bar-grid-60pct') === 'ui.toggleMetalMap',
    'bar-grid-60pct Meta+7 should toggle the metal map overlay',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('8', 'Digit8', { metaKey: true }), 'bar-grid-60pct') === 'ui.toggleElevationMap',
    'bar-grid-60pct Meta+8 should toggle the elevation map overlay',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('t', 'KeyT', { ctrlKey: true }), 'bar-grid-60pct') === 'ui.showMapOverview',
    'bar-grid-60pct Ctrl+T should toggle BAR overview',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('5', 'Digit5', { ctrlKey: true, metaKey: true }), 'bar-grid-60pct') === 'camera.viewTa',
    'bar-grid-60pct Ctrl+Meta+5 should switch to TA camera view',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('5', 'Digit5', { metaKey: true }), 'bar-grid-60pct') === 'ui.goToLastPing',
    'bar-grid-60pct Meta+5 should jump to the last message position',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('6', 'Digit6', { ctrlKey: true, metaKey: true }), 'bar-grid-60pct') === 'camera.viewSpring',
    'bar-grid-60pct Ctrl+Meta+6 should switch to Spring camera view',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('7', 'Digit7', { ctrlKey: true, metaKey: true }), 'bar-grid-60pct') === 'ui.toggleUiChrome',
    'bar-grid-60pct Ctrl+Meta+7 should hide or show the interface',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('F12', 'F12'), 'bar-grid-60pct') === 'ui.captureScreenshot',
    'bar-grid-60pct F12 should capture a screenshot',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('Backspace', 'Backspace'), 'bar-grid-60pct') === 'ui.muteSound',
    'bar-grid-60pct Backspace should mute or unmute sound',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('+', 'NumpadAdd'), 'bar-grid-60pct') === 'ui.volumeIncrease' &&
      resolveCommandHotkey(keyEvent('-', 'NumpadSubtract'), 'bar-grid-60pct') === 'ui.volumeDecrease',
    'bar-grid-60pct should inherit BAR snd_volume_osd numpad hotkeys',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('Enter', 'Enter', { ctrlKey: true, metaKey: true }), 'bar-grid-60pct') ===
      'ui.chat',
    'bar-grid-60pct modified Enter should still open chat because chat_and_ui_keys.txt binds Any+enter chat',
  );
  assertContract(
    barMapDrawHotkeySignature(keyEvent('q', 'KeyQ', { metaKey: true }), 'bar-grid-60pct') ===
      'bar-grid-60pct:Meta+KeyQ',
    'bar-grid-60pct Meta+Q must enter the BAR map draw double-tap resolver',
  );
  // grid_keys_60pct.txt keeps "bind sc_i unit_stats".
  assertContract(
    resolveCommandHotkey(keyEvent('i', 'KeyI'), 'bar-grid-60pct') === 'ui.unitStats',
    'bar-grid-60pct plain I should hold the unit stats peek',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('i', 'KeyI', { ctrlKey: true }), 'bar-grid-60pct') === 'ui.customGameInfo',
    'bar-grid-60pct Ctrl+I should toggle customgameinfo like grid_keys_60pct.txt',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('q', 'KeyQ', { ctrlKey: true }), 'bar-grid') === 'select.split',
    'bar-grid Ctrl+Q should resolve the BAR select-half split (grid_keys.txt SelectPart_50)',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('w', 'KeyW', { ctrlKey: true }), 'bar-grid') === 'select.matching',
    'bar-grid Ctrl+W should resolve BAR AllMap+_InPrevSel same-type selection',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('b', 'KeyB', { ctrlKey: true }), 'bar-grid') === 'command.selfDestruct',
    'bar-grid Ctrl+B should resolve BAR grid_keys.txt selfd',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('b', 'KeyB', { ctrlKey: true, shiftKey: true }), 'bar-grid-60pct') ===
      'command.selfDestruct',
    'bar-grid-60pct Ctrl+Shift+B should resolve BAR grid_keys_60pct.txt queued selfd',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('s', 'KeyS', { ctrlKey: true, altKey: true }), 'bar-grid') === null,
    'bar-grid must not expose a fake Ctrl+Alt+S previous-selection binding',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('q', 'KeyQ', { altKey: true }), 'bar-grid') === 'select.damagedOnly',
    'bar-grid Alt+Q should resolve the BAR damaged-mobile selection filter',
  );
  assertContract(
    commandHotkeyLabel('select.mobileOnly', 'bar-grid') === '',
    'bar-grid mobile-only must display no hotkey because held-Alt box select covers BAR semantics',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('w', 'KeyW', { altKey: true }), 'bar-grid') === null,
    'bar-grid Alt+W must remain unbound because BAR grid has no same-type selection bind',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('q', 'KeyQ', { ctrlKey: true, altKey: true }), 'bar-grid-60pct') ===
      'select.damagedOnly',
    'bar-grid-60pct Ctrl+Alt+Q should resolve the damaged filter like grid_keys_60pct.txt',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('q', 'KeyQ', { ctrlKey: true }), 'bar-grid-60pct') === 'select.split',
    'bar-grid-60pct Ctrl+Q should keep the BAR select-half split',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('q', 'KeyQ', { altKey: true }), 'bar-grid-60pct') === null,
    'bar-grid-60pct Alt+Q must remain unbound because BAR reserves it for remove-from-autogroup',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('q', 'KeyQ', { ctrlKey: true }), 'bar-legacy') === null,
    'bar-legacy Ctrl+Q must stay unbound because BAR legacy has no split-selection bind',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('w', 'KeyW', { altKey: true }), 'bar-grid-60pct') === null,
    'bar-grid-60pct Alt+W must remain unbound because BAR grid has no same-type selection bind',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('w', 'KeyW'), 'bar-grid') === 'combat.capture',
    'bar-grid W should resolve capture',
  );
  assertContract(
    commandHotkeyLabel('combat.resurrect', 'bar-grid') === 'W',
    'bar-grid resurrect should display the BAR W key',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('w', 'KeyW', { ctrlKey: true, altKey: true }), 'bar-grid') === null,
    'bar-grid Ctrl+Alt+W must not expose a separate resurrect-area hotkey',
  );
  assertContract(
    commandHotkeyLabel('combat.resurrectArea', 'bar-grid') === '',
    'bar-grid resurrect-area command must display no extra BAR order-menu hotkey',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('d', 'KeyD'), 'bar-grid') === 'command.dgun',
    'bar-grid D should resolve the default manual-fire command as commander DGun',
  );
  assertContract(
    commandHotkeyLabel('combat.manualLaunch', 'bar-grid') === 'D',
    'bar-grid manual launch should display the BAR manual-fire D key',
  );
  assertContract(
    commandHotkeyLabel('command.trajectoryToggle', 'bar-grid') === 'B',
    'bar-grid trajectory state should display the BAR B key',
  );
  assertContract(
    commandHotkeyLabel('command.buildingActive', 'bar-grid') === 'B',
    'bar-grid building active state should display the BAR B key',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('.', 'Period'), 'bar-grid') === null,
    'bar-grid period must not resolve the prototype build-cycle command because BAR cycles active builders',
  );
  assertContract(
    commandHotkeyLabel('command.buildCycle', 'bar-grid') === '',
    'bar-grid build-cycle command must display no fake BAR period hotkey label',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('b', 'KeyB'), 'bar-legacy') === null,
    'bar-legacy B must not resolve the prototype build-cycle command because BAR legacy reserves B for buildmenu context',
  );
  assertContract(
    commandHotkeyLabel('command.buildCycle', 'bar-legacy') === '',
    'bar-legacy build-cycle command must display no fake B hotkey label',
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
    resolveCommandHotkey(keyEvent('s', 'KeyS'), 'bar-grid') === 'combat.towerTargetSet',
    'bar-grid S should resolve set target',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('s', 'KeyS', { altKey: true }), 'bar-grid') === 'combat.towerTargetSetNoGround',
    'bar-grid Alt+S should resolve no-ground target',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('s', 'KeyS', { ctrlKey: true }), 'bar-grid') === 'combat.towerTargetClear',
    'bar-grid Ctrl+S should resolve cancel target',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('a', 'KeyA', { ctrlKey: true, altKey: true }), 'bar-grid') === null,
    'bar-grid Ctrl+Alt+A must not expose a separate attack-line hotkey',
  );
  assertContract(
    commandHotkeyLabel('combat.attackLine', 'bar-grid') === '',
    'bar-grid attack-line command must display no extra BAR order-menu hotkey',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('t', 'KeyT', { altKey: true }), 'bar-grid') === null,
    'bar-grid Alt+T must not expose a separate attack-ground hotkey',
  );
  assertContract(
    commandHotkeyLabel('combat.attackGround', 'bar-grid') === '',
    'bar-grid attack-ground command must display no extra BAR order-menu hotkey',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('r', 'KeyR'), 'bar-grid') === 'combat.repair',
    'bar-grid R should resolve generic repair',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('r', 'KeyR', { ctrlKey: true }), 'bar-grid') === 'select.idleTransports',
    'bar-grid Ctrl+R should resolve idle transports',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('0', 'Digit0', { metaKey: true }), 'bar-grid') === 'factoryPreset.load1',
    'bar-grid Meta+0 should resolve BAR factory preset slot 0 load',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('3', 'Digit3', { metaKey: true }), 'bar-grid') === 'factoryPreset.load4',
    'bar-grid Meta+3 should resolve BAR factory preset slot 3 load',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('9', 'Digit9', { metaKey: true }), 'bar-grid') === 'factoryPreset.load10',
    'bar-grid Meta+9 should resolve BAR factory preset slot 9 load',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('0', 'Digit0', { metaKey: true, altKey: true }), 'bar-grid') === 'factoryPreset.save1',
    'bar-grid Meta+Alt+0 should resolve BAR factory preset slot 0 save',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('9', 'Digit9', { metaKey: true, altKey: true }), 'bar-grid') === 'factoryPreset.save10',
    'bar-grid Meta+Alt+9 should resolve BAR factory preset slot 9 save',
  );
  assertContract(
    COMMAND_HOTKEY_DISPLAY_LABELS['factoryPreset.load1'] === 'Load Factory Preset 0' &&
      COMMAND_HOTKEY_DISPLAY_LABELS['factoryPreset.load10'] === 'Load Factory Preset 9' &&
      COMMAND_HOTKEY_DISPLAY_LABELS['factoryPreset.save1'] === 'Save Factory Preset 0' &&
      COMMAND_HOTKEY_DISPLAY_LABELS['factoryPreset.save10'] === 'Save Factory Preset 9',
    'BAR factory preset display labels must mirror num_keys.txt factory_preset load/save groups 0..9',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('g', 'KeyG', { altKey: true }), 'bar-grid', 'factory') === 'factory.queueMode',
    'bar-grid Alt+G should resolve BAR factory queue mode in factory scope',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('g', 'KeyG', { altKey: true }), 'bar-grid-60pct', 'factory') === null,
    'bar-grid-60pct Alt+G must stay unbound because BAR grid 60% omits factoryqueuemode',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('z', 'KeyZ', { ctrlKey: true, altKey: true }), 'bar-grid') !== 'factoryPreset.load1',
    'bar-grid Ctrl+Alt+Z must not keep the old prototype factory preset load binding',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('0', 'Digit0', { metaKey: true }), 'bar-legacy') === 'factoryPreset.load1',
    'bar-legacy Meta+0 should resolve BAR factory preset slot 0 load',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('9', 'Digit9', { metaKey: true }), 'bar-legacy') === 'factoryPreset.load10',
    'bar-legacy Meta+9 should resolve BAR factory preset slot 9 load',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('g', 'KeyG', { altKey: true }), 'bar-legacy', 'factory') === 'factory.queueMode',
    'bar-legacy Alt+G should resolve BAR factory queue mode in factory scope',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('g', 'KeyG', { altKey: true }), 'bar-legacy-60pct', 'factory') === null,
    'bar-legacy-60pct Alt+G must stay unbound because BAR legacy 60% omits factoryqueuemode',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('0', 'Digit0', { metaKey: true }), 'bar-grid-60pct') === null,
    'bar-grid-60pct must keep BAR factory preset loading unbound',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('0', 'Digit0', { metaKey: true, altKey: true }), 'bar-grid-60pct') === null,
    'bar-grid-60pct must keep BAR factory preset saving unbound',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('0', 'Digit0', { metaKey: true }), 'bar-legacy-60pct') === null,
    'bar-legacy-60pct must keep BAR factory preset loading unbound',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('0', 'Digit0', { metaKey: true, altKey: true }), 'bar-legacy-60pct') === null,
    'bar-legacy-60pct must keep BAR factory preset saving unbound',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('z', 'KeyZ'), 'bar-grid-60pct', 'buildMenu') === 'build.slot1',
    'bar-grid-60pct must retain BAR grid build-menu slot keys',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('i', 'KeyI', { altKey: true }), 'bar-grid-60pct') === null &&
      resolveCommandHotkey(keyEvent('l', 'KeyL', { altKey: true }), 'bar-grid-60pct') === null,
    'bar-grid-60pct must keep standalone invert/loop selection hotkeys unbound like BAR grid_keys_60pct.txt',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('z', 'KeyZ', { ctrlKey: true, altKey: true }), 'prototype') === 'factoryPreset.load1',
    'prototype Ctrl+Alt+Z should keep the prototype factory preset load binding',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('g', 'KeyG', { altKey: true }), 'prototype', 'factory') === 'factory.queueMode',
    'prototype Alt+G should expose the factory queue mode command',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('l', 'KeyL'), 'bar-legacy') === 'combat.loadTransport',
    'bar-legacy L should resolve load transport',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('l', 'KeyL', { ctrlKey: true, altKey: true }), 'bar-legacy') ===
      'ui.toggleLosMap',
    'bar-legacy modified L should resolve BAR Any+togglelos where it does not collide with load transport',
  );
  assertContract(
    commandHotkeyLabel('ui.toggleLosMap', 'bar-legacy') === 'L',
    'bar-legacy LOS map toggle should display the BAR L key',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('u', 'KeyU'), 'bar-legacy') === 'combat.unloadTransport',
    'bar-legacy U should resolve unload transport',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('y', 'KeyY', { altKey: true }), 'bar-legacy') === 'combat.towerTargetSet',
    'bar-legacy Alt+Y should resolve BAR settarget',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('y', 'KeyY', { altKey: true, shiftKey: true }), 'bar-legacy-60pct') === 'combat.towerTargetSet',
    'bar-legacy-60pct Shift+Alt+Y should resolve BAR settarget',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('y', 'KeyY'), 'bar-legacy') === 'combat.towerTargetSetNoGround',
    'bar-legacy Y should resolve BAR settargetnoground',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('y', 'KeyY', { shiftKey: true }), 'bar-legacy-60pct') === 'combat.towerTargetSetNoGround',
    'bar-legacy-60pct Shift+Y should resolve BAR settargetnoground',
  );
  assertContract(
    commandHotkeyLabel('combat.towerTargetSet', 'bar-legacy') === 'Alt+Y',
    'bar-legacy Set Target should display BAR Alt+Y',
  );
  assertContract(
    commandHotkeyLabel('combat.towerTargetSetNoGround', 'bar-legacy') === 'Y',
    'bar-legacy Set Target No Ground should display BAR Y even though BAR hides the order-menu button',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('j', 'KeyJ'), 'bar-legacy') === 'combat.towerTargetClear',
    'bar-legacy J should resolve cancel target',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('w', 'KeyW', { shiftKey: true }), 'bar-legacy') === 'command.wait',
    'bar-legacy Shift+W should resolve queued wait',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('w', 'KeyW', { ctrlKey: true, shiftKey: true }), 'bar-legacy') === null,
    'bar-legacy Ctrl+Shift+W must not resolve a fake wait binding',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('a', 'KeyA', { altKey: true }), 'bar-legacy') === 'combat.attackArea',
    'bar-legacy Alt+A should resolve BAR area attack',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('a', 'KeyA', { ctrlKey: true, altKey: true }), 'bar-legacy') === null,
    'bar-legacy Ctrl+Alt+A must not resolve a fake Attack Line hotkey',
  );
  assertContract(
    commandHotkeyLabel('combat.attackLine', 'bar-legacy') === '',
    'bar-legacy attack line should display no fake Ctrl+Alt+A hotkey',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('t', 'KeyT'), 'bar-legacy') === null,
    'bar-legacy T must not resolve a fake Attack Ground hotkey',
  );
  assertContract(
    commandHotkeyLabel('combat.attackGround', 'bar-legacy') === '',
    'bar-legacy attack ground should display no fake T hotkey',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('l', 'KeyL', { ctrlKey: true, altKey: true }), 'bar-legacy') !== 'command.fireToggle',
    'bar-legacy Ctrl+Alt+L must not resolve a fake fire-state hotkey',
  );
  assertContract(
    commandHotkeyLabel('command.fireToggle', 'bar-legacy') === '',
    'bar-legacy fire state should display no fake Ctrl+Alt+L hotkey',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('`', 'Backquote'), 'bar-legacy') === 'ui.mapDraw',
    'bar-legacy backquote should resolve BAR map draw, not a separate Ping order',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('q', 'KeyQ'), 'bar-legacy') === 'ui.mapDraw',
    'bar-legacy Q should resolve BAR map draw',
  );
  assertContract(
    commandHotkeyLabel('combat.ping', 'bar-legacy') === '',
    'bar-legacy ping command must display no fake BAR order-menu hotkey',
  );
  assertContract(
    commandHotkeyLabel('ui.mapLabel', 'bar-legacy') === 'Q Q',
    'bar-legacy map label should display BAR double-Q first',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('l', 'KeyL', { ctrlKey: true, shiftKey: true }), 'bar-legacy') ===
      'ui.toggleLosMap',
    'bar-legacy Ctrl+Shift+L should resolve BAR Any+togglelos instead of a fake map-label hotkey',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('Tab', 'Tab'), 'bar-legacy') === 'ui.showMapOverview',
    'bar-legacy Tab should toggle BAR overview, not select commander',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('Tab', 'Tab', { shiftKey: true }), 'bar-legacy') === 'ui.showMapOverview',
    'bar-legacy Shift+Tab should still match BAR Any+Tab overview',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('c', 'KeyC', { ctrlKey: true }), 'bar-legacy') === 'command.selectCommander',
    'bar-legacy Ctrl+C should select the commander',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('c', 'KeyC', { ctrlKey: true, shiftKey: true }), 'bar-legacy') === null,
    'bar-legacy Ctrl+Shift+C must not match commander selection because BAR binds only Ctrl+C',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('c', 'KeyC', { ctrlKey: true, shiftKey: true }), 'bar-legacy-60pct') === null,
    'bar-legacy-60pct Ctrl+Shift+C must not inherit a fake commander-selection binding',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('a', 'KeyA', { ctrlKey: true }), 'bar-legacy') === 'select.allUnits',
    'bar-legacy Ctrl+A should select all units',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('b', 'KeyB', { ctrlKey: true }), 'bar-legacy') === 'select.idleBuilders',
    'bar-legacy Ctrl+B should select one idle builder',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('z', 'KeyZ', { ctrlKey: true }), 'bar-legacy') === 'select.matching',
    'bar-legacy Ctrl+Z should select all matching previous-selection units',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('w', 'KeyW', { altKey: true }), 'bar-legacy') === null,
    'bar-legacy Alt+W must not expose the prototype matching-in-view selector',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('w', 'KeyW', { ctrlKey: true }), 'bar-legacy') ===
      'select.groundWeaponUnits',
    'bar-legacy Ctrl+W should resolve BAR Not_Aircraft_Weapons selection',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('w', 'KeyW', { ctrlKey: true }), 'bar-legacy-60pct') ===
      'select.groundWeaponUnits',
    'bar-legacy-60pct Ctrl+W should resolve BAR Not_Aircraft_Weapons selection',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('p', 'KeyP', { altKey: true }), 'bar-legacy') === null,
    'bar-legacy Alt+P must not expose the prototype previous-selection selector',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('t', 'KeyT', { ctrlKey: true, altKey: true }), 'bar-legacy') === null,
    'bar-legacy Ctrl+Alt+T must not expose the prototype idle-transport selector',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('y', 'KeyY', { ctrlKey: true }), 'bar-legacy') === null,
    'bar-legacy Ctrl+Y must not expose the BAR-grid waiting-units selector',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('x', 'KeyX', { ctrlKey: true }), 'bar-legacy') ===
      'select.previousNotInControlGroups',
    'bar-legacy Ctrl+X should resolve BAR previous-selection Not_InHotkeyGroup selector',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('x', 'KeyX', { ctrlKey: true }), 'bar-legacy-60pct') ===
      'select.previousNotInControlGroups',
    'bar-legacy-60pct Ctrl+X should resolve BAR previous-selection Not_InHotkeyGroup selector',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('v', 'KeyV', { ctrlKey: true }), 'bar-legacy') ===
      'select.previousNonBuildersNotInControlGroups',
    'bar-legacy Ctrl+V should resolve BAR previous non-builder Not_InHotkeyGroup selector',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('v', 'KeyV', { ctrlKey: true }), 'bar-legacy-60pct') ===
      'select.previousNonBuildersNotInControlGroups',
    'bar-legacy-60pct Ctrl+V should resolve BAR previous non-builder Not_InHotkeyGroup selector',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('m', 'KeyM', { altKey: true }), 'bar-legacy') === null,
    'bar-legacy Alt+M must not expose the prototype mobile-only selector',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('o', 'KeyO', { ctrlKey: true, shiftKey: true }), 'bar-legacy') === 'ui.flipCameraYaw',
    'bar-legacy Ctrl+Shift+O should flip the camera',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('o', 'KeyO', { ctrlKey: true }), 'bar-legacy') === 'camera.fovDecrease',
    'bar-legacy Ctrl+O should decrease camera FOV like chat_and_ui_keys.txt',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('p', 'KeyP', { ctrlKey: true }), 'bar-legacy') === 'camera.fovIncrease',
    'bar-legacy Ctrl+P should increase camera FOV like chat_and_ui_keys.txt',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('1', 'Numpad1'), 'bar-legacy-60pct') === 'camera.fovDecrease' &&
      resolveCommandHotkey(keyEvent('7', 'Numpad7'), 'bar-legacy-60pct') === 'camera.fovIncrease',
    'bar-legacy-60pct should inherit BAR common Numpad FOV step hotkeys',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('Home', 'Home'), 'bar-legacy') === 'camera.viewRadiusIncrease',
    'bar-legacy Home should resolve BAR increaseViewRadius',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('Home', 'Home', { ctrlKey: true, shiftKey: true, altKey: true }), 'bar-legacy') ===
      'camera.viewRadiusIncrease',
    'bar-legacy modified Home should still resolve BAR Any+home increaseViewRadius',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('End', 'End'), 'bar-legacy') === 'camera.viewRadiusDecrease',
    'bar-legacy End should resolve BAR decreaseViewRadius',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('Home', 'Home'), 'bar-legacy-60pct') === 'camera.viewRadiusIncrease' &&
      resolveCommandHotkey(keyEvent('End', 'End'), 'bar-legacy-60pct') === 'camera.viewRadiusDecrease',
    'bar-legacy-60pct should retain BAR legacy view-radius hotkeys',
  );
  assertContract(
    commandHotkeyLabel('camera.viewRadiusIncrease', 'bar-legacy') === 'Home',
    'bar-legacy view-radius increase should display the BAR Home key',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('q', 'KeyQ'), 'bar-legacy-60pct') === 'ui.mapDraw',
    'bar-legacy-60pct Q should resolve BAR map draw',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('F2', 'F2', { ctrlKey: true }), 'bar-legacy') === 'camera.viewTa',
    'bar-legacy Ctrl+F2 should switch to TA camera view',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('Backspace', 'Backspace', { shiftKey: true }), 'bar-legacy') ===
      'camera.toggleMode',
    'bar-legacy Shift+Backspace should toggle camera mode like legacy_keys.txt',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('Backspace', 'Backspace', { ctrlKey: true }), 'bar-legacy') ===
      'camera.toggleMode',
    'bar-legacy Ctrl+Backspace should toggle camera mode like legacy_keys.txt',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('d', 'KeyD', { ctrlKey: true }), 'bar-legacy') === 'command.selfDestruct' &&
      resolveCommandHotkey(keyEvent('d', 'KeyD', { ctrlKey: true, shiftKey: true }), 'bar-legacy-60pct') ===
        'command.selfDestruct',
    'BAR legacy presets should resolve legacy_keys.txt Ctrl+D/Ctrl+Shift+D selfd bindings',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('b', 'KeyB', { ctrlKey: true }), 'bar-legacy') === 'select.idleBuilders',
    'bar-legacy Ctrl+B must remain idle-builder selection, not grid self-destruct',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('F1', 'F1'), 'bar-legacy') === 'ui.toggleElevationMap',
    'bar-legacy F1 should toggle the elevation map overlay',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('F2', 'F2'), 'bar-legacy') === 'ui.togglePathingMap',
    'bar-legacy F2 should toggle the path traversability overlay',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('F3', 'F3', { ctrlKey: true }), 'bar-legacy') === 'camera.viewSpring',
    'bar-legacy Ctrl+F3 should switch to Spring camera view',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('F3', 'F3'), 'bar-legacy') === 'ui.goToLastPing',
    'bar-legacy F3 should jump to the last message position',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('F4', 'F4'), 'bar-legacy') === 'ui.toggleMetalMap',
    'bar-legacy F4 should toggle the metal map overlay',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('F5', 'F5'), 'bar-legacy') === 'ui.toggleUiChrome',
    'bar-legacy F5 should hide or show the interface',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('F6', 'F6'), 'bar-legacy') === 'ui.muteSound',
    'bar-legacy F6 should mute or unmute sound',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('+', 'NumpadAdd'), 'bar-legacy') === 'ui.volumeIncrease',
    'bar-legacy Numpad+ should resolve BAR snd_volume_increase',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('=', 'Equal'), 'bar-legacy') === 'ui.volumeIncrease',
    'bar-legacy = should resolve BAR snd_volume_increase',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('-', 'Minus'), 'bar-legacy') === 'ui.volumeDecrease',
    'bar-legacy - should resolve BAR snd_volume_decrease',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('-', 'NumpadSubtract'), 'bar-legacy') === 'ui.volumeDecrease',
    'bar-legacy Numpad- should resolve BAR snd_volume_decrease',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('F12', 'F12'), 'bar-legacy') === 'ui.captureScreenshot',
    'bar-legacy F12 should capture a screenshot',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('F10', 'F10'), 'bar-legacy') === 'ui.optionsMenu',
    'bar-legacy plain F10 should open options',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('F10', 'F10', { shiftKey: true }), 'bar-legacy') === null,
    'bar-legacy Shift+F10 must not expose a fake options binding',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('Backspace', 'Backspace', { altKey: true }), 'bar-legacy') === 'ui.toggleFullscreen',
    'bar-legacy Alt+Backspace should toggle fullscreen',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('Enter', 'Enter', { altKey: true }), 'bar-legacy') === 'ui.toggleFullscreen',
    'bar-legacy Alt+Enter should toggle fullscreen',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('Enter', 'Enter', { ctrlKey: true }), 'bar-legacy') === 'ui.chat' &&
      commandHotkeyLabel('ui.chat', 'bar-legacy') === 'Enter',
    'bar-legacy modified Enter should open chat except for the exact Alt+Enter fullscreen override',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('F4', 'F4'), 'bar-legacy') !== 'command.scan',
    'bar-legacy F4 must not trigger the prototype scanner sweep',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('i', 'KeyI'), 'bar-legacy') === 'ui.customGameInfo',
    'bar-legacy plain I should toggle customgameinfo like legacy_keys.txt',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('i', 'KeyI'), 'bar-legacy-60pct') === 'ui.customGameInfo',
    'bar-legacy-60pct plain I should toggle customgameinfo like legacy_keys_60pct.txt',
  );
  assertContract(
    commandHotkeyLabel('ui.customGameInfo', 'bar-legacy') === 'I',
    'bar-legacy custom game info should display the BAR I key',
  );
  // legacy_keys.txt: "bind Any+space unit_stats" (Space also stays the
  // queue-front modifier, matching BAR's own overlap).
  assertContract(
    resolveCommandHotkey(keyEvent(' ', 'Space'), 'bar-legacy') === 'ui.unitStats',
    'bar-legacy Space should hold the unit stats peek (legacy_keys.txt Any+space unit_stats)',
  );
  assertContract(
    resolveCommandHotkey(keyEvent(' ', 'Space', { ctrlKey: true, shiftKey: true }), 'bar-legacy') === 'ui.unitStats',
    'bar-legacy modified Space must still match because BAR binds Any+space',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('1', 'Digit1', { metaKey: true }), 'bar-legacy-60pct') === 'ui.toggleElevationMap',
    'bar-legacy-60pct Meta+1 should toggle the elevation map overlay',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('2', 'Digit2', { ctrlKey: true, metaKey: true }), 'bar-legacy-60pct') === 'camera.viewTa',
    'bar-legacy-60pct Ctrl+Meta+2 should switch to TA camera view',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('Backspace', 'Backspace', { shiftKey: true }), 'bar-legacy-60pct') ===
      'camera.toggleMode',
    'bar-legacy-60pct Shift+Backspace should retain BAR legacy togglecammode',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('2', 'Digit2', { metaKey: true }), 'bar-legacy-60pct') === 'ui.togglePathingMap',
    'bar-legacy-60pct Meta+2 should toggle the path traversability overlay',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('3', 'Digit3', { ctrlKey: true, metaKey: true }), 'bar-legacy-60pct') === 'camera.viewSpring',
    'bar-legacy-60pct Ctrl+Meta+3 should switch to Spring camera view',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('3', 'Digit3', { metaKey: true }), 'bar-legacy-60pct') === 'ui.goToLastPing',
    'bar-legacy-60pct Meta+3 should jump to the last message position',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('4', 'Digit4', { metaKey: true }), 'bar-legacy-60pct') === 'ui.toggleMetalMap',
    'bar-legacy-60pct Meta+4 should toggle the metal map overlay',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('5', 'Digit5', { metaKey: true }), 'bar-legacy-60pct') === 'ui.toggleUiChrome',
    'bar-legacy-60pct Meta+5 should hide or show the interface',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('6', 'Digit6', { metaKey: true }), 'bar-legacy-60pct') === 'ui.muteSound',
    'bar-legacy-60pct Meta+6 should mute or unmute sound',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('+', 'NumpadAdd'), 'bar-legacy-60pct') === 'ui.volumeIncrease' &&
      resolveCommandHotkey(keyEvent('-', 'Minus'), 'bar-legacy-60pct') === 'ui.volumeDecrease',
    'bar-legacy-60pct should inherit BAR snd_volume_osd volume hotkeys',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('8', 'Digit8', { metaKey: true }), 'bar-legacy-60pct') === 'ui.captureScreenshot',
    'bar-legacy-60pct Meta+8 should capture a screenshot',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('Enter', 'Enter', { altKey: true }), 'bar-legacy-60pct') === 'ui.toggleFullscreen',
    'bar-legacy-60pct Alt+Enter should toggle fullscreen',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('Enter', 'Enter', { ctrlKey: true, metaKey: true }), 'bar-legacy-60pct') ===
      'ui.chat',
    'bar-legacy-60pct modified Enter should open chat except for the exact Alt+Enter fullscreen override',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('Tab', 'Tab'), 'bar-legacy-60pct') === 'ui.showMapOverview',
    'bar-legacy-60pct Tab should toggle BAR overview',
  );
  // legacy_keys_60pct.txt keeps "bind Any+space unit_stats".
  assertContract(
    resolveCommandHotkey(keyEvent(' ', 'Space'), 'bar-legacy-60pct') === 'ui.unitStats',
    'bar-legacy-60pct Space should hold the unit stats peek',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('F10', 'F10'), 'bar-legacy-60pct') === null,
    'bar-legacy-60pct must not bind F10 options because BAR legacy 60% omits it',
  );
  assertContract(
    commandHotkeyLabel('ui.optionsMenu', 'bar-legacy-60pct') === '',
    'bar-legacy-60pct options menu should display no F10 hotkey',
  );
  assertContract(
    commandHotkeyLabel('ui.mapLabel', 'bar-legacy-60pct') === 'Q Q',
    'bar-legacy-60pct map label should display BAR double-Q',
  );
  assertContract(
    barMapDrawHotkeySignature(keyEvent('q', 'KeyQ'), 'bar-legacy-60pct') === 'bar-legacy-60pct:KeyQ',
    'bar-legacy-60pct Q must enter the BAR map draw double-tap resolver',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('x', 'KeyX'), 'bar-legacy') === 'command.buildingActive',
    'bar-legacy X should resolve BAR on/off',
  );
  assertContract(
    commandHotkeyLabel('command.buildingActive', 'bar-legacy') === 'X',
    'bar-legacy on/off should display the BAR X key',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('x', 'KeyX'), 'bar-legacy', 'buildMenu') === null,
    'bar-legacy X must not resolve a fake positional build slot; the controller handles BAR buildunit cycling',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('c', 'KeyC'), 'bar-legacy') === null,
    'bar-legacy C must not resolve capture because BAR legacy uses C for build bindings',
  );
  assertContract(
    commandHotkeyLabel('combat.capture', 'bar-legacy') === '',
    'bar-legacy capture should display no fake C hotkey',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('r', 'KeyR', { ctrlKey: true }), 'bar-legacy') === 'combat.resurrect',
    'bar-legacy Ctrl+R should resolve resurrect',
  );
  assertContract(
    commandHotkeyLabel('combat.resurrect', 'bar-legacy') === 'Ctrl+R',
    'bar-legacy resurrect should display the BAR Ctrl+R key',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('e', 'KeyE', { altKey: true }), 'prototype') === 'combat.capture',
    'prototype Alt+E should resolve capture without colliding with reclaim',
  );
  // Prototype adopts the BAR-grid plain-I stats peek; Alt+I stays invert.
  assertContract(
    resolveCommandHotkey(keyEvent('i', 'KeyI'), 'prototype') === 'ui.unitStats',
    'prototype plain I should hold the unit stats peek',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('i', 'KeyI', { altKey: true }), 'prototype') === 'select.invert',
    'prototype Alt+I must stay the selection invert, not the stats peek',
  );
  assertContract(
    resolveCommandHotkey(keyEvent(';', 'Semicolon'), 'bar-grid') === 'command.moveState',
    'bar-grid semicolon should resolve move state',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('k', 'KeyK', { altKey: true }), 'bar-grid') === 'command.cloak' &&
      resolveCommandHotkey(keyEvent('k', 'KeyK', { ctrlKey: true, metaKey: true }), 'bar-grid-60pct') === 'command.cloak' &&
      resolveCommandHotkey(keyEvent('k', 'KeyK', { ctrlKey: true }), 'bar-legacy') === 'command.cloak' &&
      resolveCommandHotkey(keyEvent('k', 'KeyK', { altKey: true, metaKey: true }), 'bar-legacy-60pct') === 'command.cloak' &&
      commandHotkeyLabel('command.cloak', 'bar-grid') === 'K',
    'BAR presets must resolve Any+K to wantcloak/command.cloak while displaying the plain K label like the hotkey files',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('m', 'KeyM'), 'bar-grid') === null &&
      resolveCommandHotkey(keyEvent('m', 'KeyM'), 'bar-grid-60pct') === null &&
      commandHotkeyLabel('combat.restore', 'bar-grid') === '',
    'immutable terrain must not expose Recoil Restore as a dead BAR-grid hotkey',
  );
  assertContract(
    commandHotkeyLabel('waypoint.move', 'bar-grid') === '',
    'bar-grid Move should display no fake M hotkey label',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('m', 'KeyM'), 'bar-legacy') === 'waypoint.move',
    'bar-legacy M should still resolve Move',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('m', 'KeyM', { ctrlKey: true, altKey: true }), 'bar-grid') === null,
    'bar-grid Ctrl+Alt+M must not expose a separate assume-formation hotkey',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('m', 'KeyM', { ctrlKey: true, altKey: true }), 'bar-legacy') === null,
    'bar-legacy Ctrl+Alt+M must not expose a separate assume-formation hotkey',
  );
  assertContract(
    commandHotkeyLabel('formation.assume', 'bar-grid') === '',
    'bar-grid assume-formation command must display no extra BAR order-menu hotkey',
  );
  assertContract(
    commandHotkeyLabel('formation.assume', 'bar-legacy') === '',
    'bar-legacy assume-formation command must display no extra BAR order-menu hotkey',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('f', 'KeyF', { ctrlKey: true, altKey: true }), 'bar-grid') === null,
    'bar-grid Ctrl+Alt+F must not expose a separate move-in-formation hotkey',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('f', 'KeyF', { ctrlKey: true, altKey: true }), 'bar-legacy') === null,
    'bar-legacy Ctrl+Alt+F must not expose a separate move-in-formation hotkey',
  );
  assertContract(
    commandHotkeyLabel('formation.move', 'bar-grid') === '',
    'bar-grid move-in-formation command must display no extra BAR order-menu hotkey',
  );
  assertContract(
    commandHotkeyLabel('formation.move', 'bar-legacy') === '',
    'bar-legacy move-in-formation command must display no extra BAR order-menu hotkey',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('z', 'KeyZ', { altKey: true }), 'bar-grid') === 'build.spacingIncrease',
    'bar-grid Alt+Z should resolve build spacing increase',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('[', 'BracketLeft'), 'bar-grid') === 'build.rotateCounterClockwise',
    'bar-grid [ should resolve BAR buildfacing inc',
  );
  assertContract(
    resolveCommandHotkey(keyEvent(']', 'BracketRight'), 'bar-grid') === 'build.rotateClockwise',
    'bar-grid ] should resolve BAR buildfacing dec',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('[', 'BracketLeft', { shiftKey: true }), 'bar-grid-60pct') === 'build.rotateCounterClockwise',
    'bar-grid-60pct Shift+[ should resolve BAR buildfacing inc',
  );
  assertContract(
    resolveCommandHotkey(keyEvent(']', 'BracketRight', { shiftKey: true }), 'bar-legacy') === 'build.rotateClockwise',
    'bar-legacy Shift+] should resolve BAR buildfacing dec',
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
    commandHotkeyLabel('factory.stopProduction', 'bar-grid') === 'G',
    'factory stop production BAR-grid hotkey label must remain G',
  );
  assertContract(
    COMMAND_HOTKEY_DISPLAY_LABELS['factory.stopProduction'] === 'Clear Queue',
    'factory stop production must use BAR order-menu label Clear Queue',
  );
  assertContract(
    commandHotkeyLabel('factory.stopProduction', 'prototype').length > 0,
    'factory stop production command must expose a visible label in the prototype preset',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('g', 'KeyG'), 'bar-grid') === 'command.stop',
    'global bar-grid G should still resolve unit stop',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('n', 'KeyN'), 'bar-legacy') === 'command.skipCurrent',
    'bar-legacy N should resolve BAR skip-current queue command',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('n', 'KeyN', { ctrlKey: true }), 'bar-legacy') === 'command.undoQueue',
    'bar-legacy Ctrl+N should resolve BAR cancel-last queue command',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('n', 'KeyN', { ctrlKey: true, shiftKey: true }), 'bar-grid') === null,
    'bar-grid Ctrl+Shift+N must not expose a clear-all queue hotkey',
  );
  assertContract(
    commandHotkeyLabel('command.clearQueue', 'bar-grid') === '',
    'bar-grid clear queue command must display no fake BAR queue hotkey',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('z', 'KeyZ'), 'bar-grid') === null,
    'bar-grid plain Z must not resolve Area Mex because Z belongs to build slot 1 in build-menu scope',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('z', 'KeyZ'), 'bar-grid', 'buildMenu') === 'build.slot1',
    'bar-grid build-menu Z should remain build slot/category 1',
  );
  assertContract(
    commandHotkeyLabel('command.areaMex', 'bar-grid') === '',
    'bar-grid Area Mex button must display no fake Z hotkey label',
  );
  assertContract(
    commandHotkeyLabel('command.builderPriority', 'bar-grid') === '',
    'bar-grid Builder Priority button must display no fake hotkey label',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('z', 'KeyZ'), 'bar-legacy') === 'command.areaMex',
    'bar-legacy Z should resolve BAR Area Mex',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('z', 'KeyZ', { shiftKey: true }), 'bar-legacy') === 'command.areaMex',
    'bar-legacy Shift+Z should resolve BAR Area Mex',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('z', 'KeyZ', { ctrlKey: true, altKey: true }), 'bar-legacy') === 'command.areaMex',
    'bar-legacy Ctrl+Alt+Z should resolve BAR Area Mex',
  );
  assertContract(
    commandHotkeyLabel('command.areaMex', 'bar-legacy') === 'Z',
    'bar-legacy Area Mex should display the BAR Z key',
  );
  assertContract(
    commandHotkeyLabel('command.builderPriority', 'bar-legacy') === '',
    'bar-legacy Builder Priority button must display no fake hotkey label',
  );
  assertContract(
    commandHotkeyLabel('command.carrierSpawn', 'bar-grid') === '',
    'bar-grid Carrier Spawning button must display no fake hotkey label',
  );
  assertContract(
    commandHotkeyLabel('command.carrierSpawn', 'bar-legacy') === '',
    'bar-legacy Carrier Spawning button must display no fake hotkey label',
  );
  assertContract(
    commandHotkeyLabel('command.morph', 'bar-grid') === '',
    'bar-grid Morph/Upgrade button must display no fake hotkey label',
  );
  assertContract(
    commandHotkeyLabel('command.morph', 'bar-legacy') === '',
    'bar-legacy Morph/Upgrade button must display no fake hotkey label',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('u', 'KeyU', { altKey: true }), 'bar-grid') === null,
    'bar-grid Alt+U must not expose a fake selected metal extractor upgrade hotkey',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('u', 'KeyU', { ctrlKey: true, altKey: true }), 'bar-grid') === null,
    'bar-grid Ctrl+Alt+U must not expose a fake area metal extractor upgrade hotkey',
  );
  assertContract(
    commandHotkeyLabel('command.upgradeMexSelected', 'bar-grid') === '',
    'bar-grid selected metal extractor upgrade must display no fake BAR hotkey',
  );
  assertContract(
    commandHotkeyLabel('command.upgradeMexArea', 'bar-grid') === '',
    'bar-grid area metal extractor upgrade must display no fake BAR hotkey',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('F1', 'F1'), 'bar-grid') === 'camera.anchorFocus1',
    'bar-grid F1 should focus camera anchor 1',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('F4', 'F4'), 'bar-grid') === 'camera.anchorFocus4',
    'bar-grid F4 should focus camera anchor 4',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('F1', 'F1', { ctrlKey: true }), 'bar-grid') === 'camera.anchorSet1',
    'bar-grid Ctrl+F1 should set camera anchor 1',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('F4', 'F4', { ctrlKey: true }), 'bar-grid') === 'camera.anchorSet4',
    'bar-grid Ctrl+F4 should set camera anchor 4',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('1', 'Digit1', { metaKey: true }), 'bar-grid-60pct') === 'camera.anchorFocus1',
    'bar-grid-60pct Meta+1 should focus camera anchor 1',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('4', 'Digit4', { metaKey: true }), 'bar-grid-60pct') === 'camera.anchorFocus4',
    'bar-grid-60pct Meta+4 should focus camera anchor 4',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('1', 'Digit1', { ctrlKey: true, metaKey: true }), 'bar-grid-60pct') === 'camera.anchorSet1',
    'bar-grid-60pct Ctrl+Meta+1 should set camera anchor 1',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('4', 'Digit4', { ctrlKey: true, metaKey: true }), 'bar-grid-60pct') === 'camera.anchorSet4',
    'bar-grid-60pct Ctrl+Meta+4 should set camera anchor 4',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('5', 'Digit5', { ctrlKey: true, metaKey: true }), 'bar-grid-60pct') === 'camera.viewTa',
    'bar-grid-60pct Ctrl+Meta+5 should switch to TA camera view',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('6', 'Digit6', { ctrlKey: true, metaKey: true }), 'bar-grid-60pct') === 'camera.viewSpring',
    'bar-grid-60pct Ctrl+Meta+6 should switch to Spring camera view',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('5', 'Digit5', { metaKey: true }), 'bar-grid-60pct') === 'ui.goToLastPing',
    'bar-grid-60pct Meta+5 should jump to the last message position',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('6', 'Digit6', { metaKey: true }), 'bar-grid-60pct') === 'ui.togglePathingMap',
    'bar-grid-60pct Meta+6 should toggle the path traversability overlay',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('7', 'Digit7', { ctrlKey: true, metaKey: true }), 'bar-grid-60pct') === 'ui.toggleUiChrome',
    'bar-grid-60pct Ctrl+Meta+7 should hide or show the interface',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('7', 'Digit7', { metaKey: true }), 'bar-grid-60pct') === 'ui.toggleMetalMap',
    'bar-grid-60pct Meta+7 should toggle the metal map overlay',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('8', 'Digit8', { metaKey: true }), 'bar-grid-60pct') === 'ui.toggleElevationMap',
    'bar-grid-60pct Meta+8 should toggle the elevation map overlay',
  );
  const barGridSpeedPresetIds = ['bar-grid', 'bar-grid-60pct'] as const;
  for (const presetId of barGridSpeedPresetIds) {
    assertContract(
      resolveCommandHotkey(keyEvent('=', 'Equal', { altKey: true }), presetId) === 'ui.gameSpeedIncrease',
      `${presetId} Alt+= must resolve BAR increasespeed`,
    );
    assertContract(
      resolveCommandHotkey(keyEvent('+', 'NumpadAdd', { altKey: true }), presetId) === 'ui.gameSpeedIncrease',
      `${presetId} Alt+Numpad+ must resolve BAR increasespeed`,
    );
    assertContract(
      resolveCommandHotkey(keyEvent('-', 'Minus', { altKey: true }), presetId) === 'ui.gameSpeedDecrease',
      `${presetId} Alt+- must resolve BAR decreasespeed`,
    );
    assertContract(
      resolveCommandHotkey(keyEvent('-', 'NumpadSubtract', { altKey: true }), presetId) === 'ui.gameSpeedDecrease',
      `${presetId} Alt+Numpad- must resolve BAR decreasespeed`,
    );
  }
  const barLegacySpeedPresetIds = ['bar-legacy', 'bar-legacy-60pct'] as const;
  for (const presetId of barLegacySpeedPresetIds) {
    assertContract(
      resolveCommandHotkey(keyEvent('Insert', 'Insert', { altKey: true }), presetId) === 'ui.gameSpeedIncrease',
      `${presetId} Alt+Insert must resolve BAR legacy increasespeed`,
    );
    assertContract(
      resolveCommandHotkey(keyEvent('Delete', 'Delete', { altKey: true }), presetId) === 'ui.gameSpeedDecrease',
      `${presetId} Alt+Delete must resolve BAR legacy decreasespeed`,
    );
    assertContract(
      resolveCommandHotkey(keyEvent('=', 'Equal', { altKey: true }), presetId) === 'ui.gameSpeedIncrease',
      `${presetId} Alt+= must resolve BAR increasespeed`,
    );
    assertContract(
      resolveCommandHotkey(keyEvent('-', 'Minus', { altKey: true }), presetId) === 'ui.gameSpeedDecrease',
      `${presetId} Alt+- must resolve BAR decreasespeed`,
    );
  }
  assertContract(
    resolveCommandHotkey(keyEvent('F1', 'F1'), 'bar-legacy') === 'ui.toggleElevationMap',
    'bar-legacy F1 must be elevation overlay, not a camera anchor',
  );
  assertContract(
    commandHotkeyLabel('camera.anchorFocus1', 'bar-legacy') === '',
    'bar-legacy camera anchor focus should display no hotkey label',
  );
  for (const presetId of COMMAND_HOTKEY_PRESET_IDS) {
    assertContract(
      resolveCommandHotkey(keyEvent('Pause', 'Pause'), presetId) === 'ui.pause',
      `${presetId} Pause key must resolve the game pause toggle (BAR Any+pause)`,
    );
    assertContract(
      resolveCommandHotkey(keyEvent('Pause', 'Pause', { ctrlKey: true, shiftKey: true }), presetId) === 'ui.pause',
      `${presetId} modified Pause must still match because BAR binds Any+pause`,
    );
  }
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
  const plainFactoryQueue = factoryProductionClickModeFromEvent(keyEvent('z', 'KeyZ'), false);
  assertContract(
    plainFactoryQueue.repeat === false && plainFactoryQueue.count === 1,
    'BAR factory plain grid key should queue one unit while factory repeat is off',
  );
  const repeatFactoryQueue = factoryProductionClickModeFromEvent(keyEvent('z', 'KeyZ'), true);
  assertContract(
    repeatFactoryQueue.repeat === true && repeatFactoryQueue.count === 1,
    'BAR factory plain grid key should repeat one unit while factory repeat is on',
  );
  const shiftFactoryQueue = factoryProductionClickModeFromEvent(keyEvent('z', 'KeyZ', { shiftKey: true }), false);
  assertContract(
    shiftFactoryQueue.repeat === false && shiftFactoryQueue.count === 5,
    'BAR factory Shift grid key should queue five units',
  );
  const ctrlFactoryQueue = factoryProductionClickModeFromEvent(keyEvent('z', 'KeyZ', { ctrlKey: true }), false);
  assertContract(
    ctrlFactoryQueue.repeat === false && ctrlFactoryQueue.count === 20,
    'BAR factory Ctrl mouse click should queue twenty units',
  );
  const shiftCtrlFactoryQueue = factoryProductionClickModeFromEvent(keyEvent('z', 'KeyZ', { ctrlKey: true, shiftKey: true }), false);
  assertContract(
    shiftCtrlFactoryQueue.repeat === false && shiftCtrlFactoryQueue.count === 100,
    'BAR factory Shift+Ctrl mouse click should queue one hundred units',
  );
  const ctrlFactoryKey = factoryProductionKeyModeFromEvent(keyEvent('z', 'KeyZ', { ctrlKey: true }), false);
  assertContract(
    ctrlFactoryKey.repeat === false && ctrlFactoryKey.count === 20,
    'BAR factory Ctrl grid key should queue twenty units',
  );
  const shiftCtrlFactoryKey = factoryProductionKeyModeFromEvent(keyEvent('z', 'KeyZ', { ctrlKey: true, shiftKey: true }), false);
  assertContract(
    shiftCtrlFactoryKey.repeat === false && shiftCtrlFactoryKey.count === 100,
    'BAR factory Shift+Ctrl grid key should queue one hundred units',
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

  // BAR chat_and_ui_keys.txt: Any+space commandinsert prepend — held Space
  // queue-fronts commands when the input layer marks the selection eligible
  // (BAR preset, selection is not a factory).
  setSpaceQueueFrontEligibilityProvider(() => true);
  setQueueModifierKeyState(keyEvent(' ', 'Space'), true);
  const spaceFrontQueue = queueModeFromEvent(keyEvent('w', 'KeyW'), 3);
  assertContract(
    spaceFrontQueue.queue === true &&
      spaceFrontQueue.queueFront === true &&
      spaceFrontQueue.queueInsertIndex === undefined,
    'held Space must queue-front commands like BAR commandinsert prepend',
  );
  setSpaceQueueFrontEligibilityProvider(() => false);
  assertContract(
    queueModeFromEvent(keyEvent('w', 'KeyW')).queue === false,
    'held Space must stay inert when the input layer reports factory/preset ineligibility',
  );
  setSpaceQueueFrontEligibilityProvider(() => true);
  clearQueueModifierState();
  assertContract(
    queueModeFromEvent(keyEvent('w', 'KeyW')).queueFront === false,
    'clearing tracked modifier state must release the held-Space queue-front',
  );
  setSpaceQueueFrontEligibilityProvider(null);
  clearQueueModifierState();
}
