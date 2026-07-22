import selectionPanelSource from './SelectionPanel.vue?raw';
import { COLORS, WAYPOINT_COLOR_CSS } from '../colorsConfig';
import { resolveCommandHotkey } from '../game/input/commandHotkeys';
import { BAR_MAX_SELECTED_BUILDER_TYPES } from '../game/sim/hostCapabilities';
import hostCapabilitiesSource from '../game/sim/hostCapabilities.ts?raw';
import buildMenuLayoutSource from '../game/input/buildMenuLayout.ts?raw';
import input3DManagerSource from '../game/render3d/Input3DManager.ts?raw';
import uiUpdateManagerSource from '../game/scenes/helpers/UIUpdateManager.ts?raw';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[selection panel command surface contract] ${message}`);
  }
}

function keyEvent(
  key: string,
  code: string,
  options: Partial<KeyboardEvent> = {},
): KeyboardEvent {
  return {
    key,
    code,
    altKey: options.altKey ?? false,
    ctrlKey: options.ctrlKey ?? false,
    metaKey: options.metaKey ?? false,
    shiftKey: options.shiftKey ?? false,
  } as KeyboardEvent;
}

export function runSelectionPanelCommandSurfaceContractTest(): void {
  const barUnitOrderStart = selectionPanelSource.indexOf('<template v-if="isBarHotkeyPreset">');
  const barUnitRepeatIndex = selectionPanelSource.indexOf(
    ':title="actionTitle(repeatStateLabel(selection.isRepeatQueue), \'command.repeat\')"',
    barUnitOrderStart,
  );
  const barUnitMoveStateIndex = selectionPanelSource.indexOf(
    ':title="stateActionTitle(moveStateLabel(selection.unitMoveState),',
    barUnitRepeatIndex,
  );
  const barUnitCloakIndex = selectionPanelSource.indexOf(
    ':title="stateActionTitle(cloakStateLabel(selection),',
    barUnitMoveStateIndex,
  );
  const barUnitFireStateIndex = selectionPanelSource.indexOf(
    ':title="stateActionTitle(fireStateLabel(selection.fireState),',
    barUnitCloakIndex,
  );
  const barUnitTrajectoryIndex = selectionPanelSource.indexOf(
    ':title="actionTitle(trajectoryModeLabel(visibleTrajectoryMode), \'command.trajectoryToggle\')"',
    barUnitFireStateIndex,
  );
  const barUnitBuilderPriorityIndex = selectionPanelSource.indexOf(
    ':title="actionTitle(builderPriorityLabel(selection.builderPriorityLow), \'command.builderPriority\', \'Assigns resources to use for this builder when not having enough for all\')"',
    barUnitTrajectoryIndex,
  );
  const barUnitCarrierSpawnIndex = selectionPanelSource.indexOf(
    ':title="actionTitle(carrierSpawnLabel(selection.carrierSpawnEnabled), \'command.carrierSpawn\', \'Enable/Disable drone spawning\')"',
    barUnitBuilderPriorityIndex,
  );
  const barUnitWaitIndex = selectionPanelSource.indexOf(
    ':title="actionTitle(\'Wait\', \'command.wait\', \'Shift-click queues; Ctrl/Cmd+Shift-click inserts next\')"',
    barUnitTrajectoryIndex,
  );
  const barUnitWaypointIndex = selectionPanelSource.indexOf('v-for="wm in waypointModes"', barUnitWaitIndex);
  const factoryControlStart = selectionPanelSource.indexOf('<!-- Factory production control -->');
  const factoryRepeatIndex = selectionPanelSource.indexOf(
    ':title="actionTitle(repeatStateLabel(selection.factoryRepeatsProduction === true), \'command.repeat\')"',
    factoryControlStart,
  );
  const factoryMoveStateIndex = selectionPanelSource.indexOf(
    'v-if="isBarHotkeyPreset && selection.hasMoveStateControl"',
    factoryRepeatIndex,
  );
  const factoryAirIdleIndex = selectionPanelSource.indexOf(
    'v-if="showFactoryAirIdleButton"',
    factoryMoveStateIndex,
  );
  const factoryBuilderPriorityIndex = selectionPanelSource.indexOf(
    'v-if="showBuilderPriorityButton"',
    factoryAirIdleIndex,
  );
  const factoryGuardIndex = selectionPanelSource.indexOf(
    'v-if="showFactoryGuardButton"',
    factoryBuilderPriorityIndex,
  );
  const factoryQueueModeIndex = selectionPanelSource.indexOf(
    'v-if="showFactoryQueueModeButton"',
    factoryGuardIndex,
  );
  const factoryWaitIndex = selectionPanelSource.indexOf(
    ':title="actionTitle(\'Wait\', \'command.wait\', \'Shift-click queues; Ctrl/Cmd+Shift-click inserts next\')"',
    factoryQueueModeIndex,
  );
  const factoryStopIndex = selectionPanelSource.indexOf(
    'factoryStopProductionButtonColor()',
    factoryWaitIndex,
  );
  const towerCombatStart = selectionPanelSource.indexOf('<!-- Fire control (units + towers).');
  const towerFireStateIndex = selectionPanelSource.indexOf(
    ':title="stateActionTitle(fireStateLabel(selection.fireState),',
    towerCombatStart,
  );
  const towerStopIndex = selectionPanelSource.indexOf('v-if="showTowerStopButton"', towerFireStateIndex);
  const towerTargetStart = selectionPanelSource.indexOf('<!-- Combat lock-on.', towerStopIndex);
  const buildingPowerStart = selectionPanelSource.indexOf('<!-- Building ON/OFF.');
  const buildingPowerIndex = selectionPanelSource.indexOf(
    ":title=\"stateActionTitle(selectedBuildingsActive ? 'On' : 'Off'",
    buildingPowerStart,
  );
  const buildingStopIndex = selectionPanelSource.indexOf('v-if="showBuildingStopButton"', buildingPowerIndex);

  assertContract(
    COLORS.ui.selectionPanel.cost.resource === '#f5f5f5' &&
      COLORS.ui.selectionPanel.cost.energy === '#ffff00',
    'BAR build/production grid prices must use gui_gridmenu.lua normal metal #f5f5f5 and energy #ffff00 colors',
  );
  assertContract(
    COLORS.ui.selectionPanel.buildMenuCategoryBorders.Economy === '#64e880' &&
      COLORS.ui.selectionPanel.buildMenuCategoryBorders.Defense === '#ff5a5a' &&
      COLORS.ui.selectionPanel.buildMenuCategoryBorders.Intel === '#70c4ff' &&
      COLORS.ui.selectionPanel.buildMenuCategoryBorders.Production === '#ffd66b' &&
      /const BUILD_MENU_CATEGORY_BORDER_COLORS: Record<BuildMenuCategory, string> =\s*SELECTION_PANEL\.buildMenuCategoryBorders;/.test(selectionPanelSource) &&
      /:style="\{ '--btn-color': buildOptionBorderColor\(bo\.category\) \}"/.test(selectionPanelSource) &&
      /\.bar-grid-cell\.build-btn \{\s*border-color:\s*color-mix\(in srgb, var\(--btn-color\) 48%, transparent\);/.test(selectionPanelSource) &&
      /\.bar-grid-cell\.build-btn:hover,[\s\S]{0,700}border-color:\s*color-mix\(in srgb, var\(--btn-color\) 92%, transparent\);/.test(selectionPanelSource),
    'build options must inherit the annihilation-plus-plus Economy/Combat/Utility/Production accent frames at rest and on hover or selection',
  );
  assertContract(
    WAYPOINT_COLOR_CSS.move === '#a3ffa3' &&
      WAYPOINT_COLOR_CSS.patrol === '#babaff' &&
      WAYPOINT_COLOR_CSS.fight === '#e680ff' &&
      COLORS.ui.selectionPanel.buttons.stop === '#ff4d4d' &&
      COLORS.ui.selectionPanel.buttons.attackArea === '#ff8059' &&
      COLORS.ui.selectionPanel.buttons.attackGround === '#ff5926' &&
      COLORS.ui.selectionPanel.buttons.guard === '#54ebff' &&
      COLORS.ui.selectionPanel.buttons.wait === '#b3a899' &&
      COLORS.ui.selectionPanel.buttons.repair === '#fff2b3' &&
      COLORS.ui.selectionPanel.buttons.reclaim === '#dbffdb' &&
      COLORS.ui.selectionPanel.buttons.restore === '#c4ffc4' &&
      COLORS.ui.selectionPanel.buttons.capture === '#ffd936' &&
      COLORS.ui.selectionPanel.buttons.resurrect === '#ffbfff' &&
      COLORS.ui.selectionPanel.buttons.build === '#ededed' &&
      COLORS.ui.selectionPanel.buttons.setTarget === '#ffa859' &&
      COLORS.ui.selectionPanel.buttons.cancelTarget === '#cc8c33' &&
      COLORS.ui.selectionPanel.buttons.loadTransport === '#1ab3ff' &&
      COLORS.ui.selectionPanel.buttons.unloadTransport === '#0080ff',
    'BAR order command colors must match gui_ordermenu.lua commandInfo RGB values for visible analogous commands',
  );
  assertContract(
    COLORS.ui.selectionPanel.buttons.manualFire === '#ffb3b3' &&
      /:style="\{ '--btn-color': BUTTON_COLORS\.manualFire \}"[\s\S]{0,260}combat\.manualLaunch/.test(selectionPanelSource) &&
      !/:style="\{ '--btn-color': BUTTON_COLORS\.dgun \}"[\s\S]{0,260}combat\.manualLaunch/.test(selectionPanelSource),
    'BAR Manual Fire/Manual Launch must use gui_ordermenu.lua manualfire color #ffb3b3 through a dedicated token, not the D-Gun token',
  );
  assertContract(
    /'combat\.manualLaunch': 'Launch a missile at a target',/.test(selectionPanelSource) &&
      /:title="actionTitle\(barOrderLabel\('Launch', 'Manual launch'\), 'combat\.manualLaunch'/.test(selectionPanelSource) &&
      /<span class="btn-label">\{\{ barOrderLabel\('Launch', 'Launch'\) \}\}<\/span>/.test(selectionPanelSource),
    'BAR Manual Launch must use interface.json ui.orderMenu.manuallaunch label Launch and manuallaunch_tooltip text, not manualfire/D-Gun wording',
  );
  assertContract(
    /'combat\.loadTransport': 'Load unit or multiple units within an area in the transport',/.test(selectionPanelSource) &&
      /'combat\.unloadTransport': 'Unload unit or multiple units within an area in the transport',/.test(selectionPanelSource) &&
      /:title="actionTitle\(barOrderLabel\('Load units', 'Load transport'\), 'combat\.loadTransport'/.test(selectionPanelSource) &&
      /:title="actionTitle\(barOrderLabel\('Unload units', 'Unload transport'\), 'combat\.unloadTransport', 'Click ground or click-drag an area'\)"/.test(selectionPanelSource) &&
      /<span class="btn-label">\{\{ barOrderLabel\('Load units', 'Load'\) \}\}<\/span>/.test(selectionPanelSource) &&
      /<span class="btn-label">\{\{ barOrderLabel\('Unload units', 'Unload'\) \}\}<\/span>/.test(selectionPanelSource),
    'BAR transport order buttons must use interface.json ui.orderMenu loadunits/unloadunits labels and tooltip text while preserving prototype labels for non-BAR presets',
  );
  assertContract(
    /const BAR_ORDER_TOOLTIP_BY_COMMAND_ID: Partial<Record<CommandHotkeyId, string>> = \{[\s\S]{0,400}'combat\.attackArea': 'Area attack everything within a circle \(click-drag\)',/.test(selectionPanelSource) &&
      /'command\.wait': 'Pause a unit\/factory on processing command\/build queues',/.test(selectionPanelSource) &&
      /'combat\.reclaim': 'Suck metal\/energy from wrecks or features \(trees\/stones\)',/.test(selectionPanelSource) &&
      /'factory\.stopProduction': 'Clear build queue and quotas for all units on selected factories',/.test(selectionPanelSource) &&
      /'factory\.airIdleState': 'Sets what aircraft do when leaving air factory',/.test(selectionPanelSource) &&
      /'factory\.queueMode': 'Queue: Build each queued unit once\\nQuota: Maintain a minimum quota of each unit on the battlefield',/.test(selectionPanelSource) &&
      /'combat\.towerTargetSet': 'Set a prioritized target \(prioritizes targeting when target in range\) ',/.test(selectionPanelSource) &&
      /'command\.morph': 'Upgrade to next Tech-level \(second click to cancel\)',/.test(selectionPanelSource),
    'BAR order button browser titles must use Beyond-All-Reason language/en/interface.json ui.orderMenu tooltip strings for analogous commands',
  );
  assertContract(
    /:title="actionTitle\(barOrderLabel\('Set Target', 'Set target'\), 'combat\.towerTargetSet', 'Click an entity or ground point to lock on'\)"/.test(selectionPanelSource) &&
      /:title="actionTitle\(barOrderLabel\('Clear Target', 'Clear target'\), 'combat\.towerTargetClear'\)"/.test(selectionPanelSource),
    'BAR target order button browser titles must use interface.json Set Target/Clear Target labels while preserving prototype title casing',
  );
  assertContract(
    /function builderPriorityLabel\(lowPriority: boolean\): string \{\s*return isBarHotkeyPreset\.value\s*\?\s*lowPriority \? 'Low Priority' : 'High Priority'\s*:\s*lowPriority \? 'Low Prio' : 'High Prio';\s*\}/.test(selectionPanelSource),
    'BAR builder priority state button must use gui_ordermenu.lua translated Low Priority/High Priority text from unit_builder_priority.lua params',
  );
  assertContract(
    /const barTooltip = isBarHotkeyPreset\.value \? BAR_ORDER_TOOLTIP_BY_COMMAND_ID\[commandId\] : undefined;/.test(selectionPanelSource) &&
      /const hotkeyText = key === '' \? '' : `\$\{key\.toUpperCase\(\)\} - `;/.test(selectionPanelSource) &&
      /return `\$\{label\} - \$\{hotkeyText\}\$\{barTooltip\}`;/.test(selectionPanelSource) &&
      /const hotkeyText = key === '' \? '' : ` - Hotkey \$\{key\}`;/.test(selectionPanelSource),
    'BAR tooltip overrides must be BAR-preset-only and keep prototype actionTitle wording for non-BAR presets',
  );
  assertContract(
    /function stateActionTitle\(barLabel: string, prototypeLabel: string, commandId: CommandHotkeyId\): string \{\s*return actionTitle\(isBarHotkeyPreset\.value \? barLabel : prototypeLabel, commandId\);\s*\}/.test(selectionPanelSource) &&
      /:title="stateActionTitle\(moveStateLabel\(selection\.unitMoveState\), `Move state: \$\{moveStateLabel\(selection\.unitMoveState\)\}; next \$\{nextMoveStateLabel\(selection\.unitMoveState\)\}`, 'command\.moveState'\)"/.test(selectionPanelSource) &&
      /:title="stateActionTitle\(cloakStateLabel\(selection\), selection\.wantsCloak \? 'Disable cloak' : 'Enable cloak', 'command\.cloak'\)"/.test(selectionPanelSource) &&
      /:title="stateActionTitle\(fireStateLabel\(selection\.fireState\), `Fire state: \$\{fireStateLabel\(selection\.fireState\)\}; next \$\{nextFireStateLabel\(selection\.fireState\)\}`, 'command\.fireToggle'\)"/.test(selectionPanelSource) &&
      /:title="stateActionTitle\(selectedBuildingsActive \? 'On' : 'Off', selectedBuildingsActive \? 'Turn off' : 'Turn on', 'command\.buildingActive'\)"/.test(selectionPanelSource),
    'BAR state command browser titles must use current interface.json state text as the hover label while preserving prototype labels for non-BAR presets',
  );
  assertContract(
    barUnitOrderStart >= 0 &&
      barUnitRepeatIndex > barUnitOrderStart &&
      barUnitMoveStateIndex > barUnitRepeatIndex &&
      barUnitCloakIndex > barUnitMoveStateIndex &&
      barUnitFireStateIndex > barUnitCloakIndex &&
      barUnitTrajectoryIndex > barUnitFireStateIndex &&
      barUnitBuilderPriorityIndex > barUnitTrajectoryIndex &&
      barUnitCarrierSpawnIndex > barUnitBuilderPriorityIndex &&
      barUnitWaitIndex > barUnitCarrierSpawnIndex &&
      barUnitWaypointIndex > barUnitWaitIndex &&
      /if \(isBarHotkeyPreset\.value\) \{\s*if \(showCombatActions\.value\) count \+= 1; \/\/ fire state\s*if \(showTrajectoryButton\.value\) count \+= 1;\s*if \(showBuilderPriorityButton\.value\) count \+= 1;\s*if \(showCarrierSpawnButton\.value\) count \+= 1;\s*\}/.test(selectionPanelSource) &&
      /if \(showCombatActions\.value && \(!isBarHotkeyPreset\.value \|\| !showUnitActions\.value\)\) \{\s*count \+= 1; \/\/ fire state/.test(selectionPanelSource) &&
      /showUnitActions\.value &&\s*\(\s*props\.selection\.hasDGun \|\|\s*props\.selection\.hasBuilder \|\|\s*showCaptureButton\.value \|\|\s*showResurrectButton\.value \|\|\s*props\.selection\.hasCommander \|\|\s*props\.selection\.hasTransport\s*\)\s*\)\s*\{\s*if \(props\.selection\.hasDGun\) count \+= 1;/.test(selectionPanelSource) &&
      /<div v-if="showCombatActions && \(!isBarHotkeyPreset \|\| !showUnitActions\)" class="button-group">/.test(selectionPanelSource) &&
      !/\(selection\.hasDGun \|\| selection\.hasBuilder \|\| selection\.hasCommander \|\| showCaptureButton \|\| selection\.hasTransport \|\| showBuilderPriorityButton\) && showUnitActions/.test(selectionPanelSource) &&
      /v-if="!isBarHotkeyPreset"[\s\S]{0,140}class="action-btn bar-order-wait"/.test(selectionPanelSource) &&
      /v-if="!isBarHotkeyPreset && selection\.hasMoveStateControl"/.test(selectionPanelSource),
    'BAR unit order menu must follow gui_ordermenu.lua ordering by placing all state commands, including builder priority and carrier spawning, before Wait and other commands while avoiding duplicate unit fire-state buttons or hidden sizing cells',
  );
  assertContract(
    /\.options-panel > \.button-group:not\(\.bar-menu-group\):not\(\.selection-command-group\):not\(\.details-group\) \{\s*display:\s*contents;\s*\}/.test(selectionPanelSource) &&
      /\.options-panel > \.button-group:not\(\.bar-menu-group\):not\(\.selection-command-group\):not\(\.details-group\) > \.buttons,[\s\S]{0,260}\.options-panel > \.factory-preset-group > \.factory-preset-grid \{\s*display:\s*contents;\s*\}/.test(selectionPanelSource) &&
      /\.group-label \{\s*display:\s*none;/.test(selectionPanelSource),
    'BAR order menu command groups must flatten into one gui_ordermenu.lua-style command grid and hide local group labels',
  );
  assertContract(
    /class="selection-info-panel"/.test(selectionPanelSource) &&
      /getCachedEntityPreviewImage\('panel',/.test(selectionPanelSource) &&
      /\.selection-info-panel \{[\s\S]{0,120}position:\s*fixed;[\s\S]{0,80}left:\s*0;[\s\S]{0,120}bottom:\s*var\(--selection-panel-playable-bottom,\s*0px\);[\s\S]{0,160}width:\s*var\(--bar-order-panel-width\);/.test(selectionPanelSource),
    'BAR selected entity info must occupy the bottom-left gui_info.lua slot and use panel-resolution entity images instead of staying hidden in the command grid',
  );
  assertContract(
    /const showQueueInsertPicker = computed\(\(\) =>\s*!isBarHotkeyPreset\.value\s*&&\s*showUnitActions\.value\s*&&\s*props\.selection\.queueInsertOptions\.length > 0,\s*\);/.test(selectionPanelSource),
    'BAR presets must not expose the prototype queue-insert picker because BAR command insertion is not a visible gui_ordermenu.lua command button',
  );
  assertContract(
    /const showBuildUtilityGrid = computed\(\(\) =>\s*showPrototypeOnlyCommandButtons\.value &&\s*\(props\.selection\.canUpgradeMetalExtractors \|\| props\.selection\.isBuildMode\),\s*\);/.test(selectionPanelSource) &&
      /<div v-if="showBuildUtilityGrid" class="buttons bar-command-grid build-utility-grid">/.test(selectionPanelSource) &&
      /v-if="showBuildUtilityGrid"[\s\S]{0,1800}build\.spacingDecrease[\s\S]{0,900}build\.spacingIncrease[\s\S]{0,900}build\.rotateCounterClockwise[\s\S]{0,900}build\.rotateClockwise/.test(selectionPanelSource),
    'BAR presets must keep buildspacing/buildfacing/mex-upgrade utility controls hotkey-only, matching BAR hotkey files instead of adding visible gui_ordermenu.lua buttons',
  );
  assertContract(
    /const showSelfDestructButton = computed\(\(\) =>\s*showPrototypeOnlyCommandButtons\.value && props\.selection\.hasSelfDestructable,\s*\);/.test(selectionPanelSource) &&
      /BAR presets match BAR's order menu, where CMD\.SELFD is hotkey-only\./.test(selectionPanelSource),
    'BAR presets must keep CMD.SELFD hotkey-only because gui_ordermenu.lua lists CMD.SELFD in hiddenCommands',
  );
  assertContract(
    /const showGatherWaitButton = computed\(\(\) => showPrototypeOnlyCommandButtons\.value\);/.test(selectionPanelSource) &&
      /const showTowerTargetNoGroundButton = computed\(\(\) => showPrototypeOnlyCommandButtons\.value\);/.test(selectionPanelSource) &&
      /BAR's order menu hides CMD\.GATHERWAIT, settargetnoground, and CMD\.SELFD/.test(selectionPanelSource),
    'BAR presets must keep CMD.GATHERWAIT and settargetnoground hotkey-only because gui_ordermenu.lua lists them in hiddenCommands',
  );
  assertContract(
    /armllt\/armbeamer\/armrl set removewait=true[\s\S]{0,180}do not set removestop/.test(selectionPanelSource) &&
      /const showTowerStopButton = computed\(\(\) =>\s*isBarHotkeyPreset\.value &&\s*showTowerActions\.value &&\s*props\.selection\.hasFireControl &&\s*!props\.selection\.hasFactory,\s*\);/.test(selectionPanelSource) &&
      /if \(showCombatActions\.value && \(!isBarHotkeyPreset\.value \|\| !showUnitActions\.value\)\) \{\s*count \+= 1; \/\/ fire state\s*if \(showTrajectoryButton\.value\) count \+= 1;\s*if \(showTowerStopButton\.value\) count \+= 1;/.test(selectionPanelSource) &&
      towerCombatStart >= 0 &&
      towerFireStateIndex > towerCombatStart &&
      towerStopIndex > towerFireStateIndex &&
      towerTargetStart > towerStopIndex &&
      /v-if="showTowerStopButton"[\s\S]{0,220}:title="actionTitle\('Stop', 'command\.stop'\)"[\s\S]{0,160}@click="actions\.stopSelectedUnits\(\)"/.test(selectionPanelSource),
    'BAR pure combat-tower selections must show Stop after state commands and before target commands because ARM static defenses remove Wait but keep Stop',
  );
  assertContract(
    /BAR armamex sets removewait=true[\s\S]{0,180}does not set removestop/.test(selectionPanelSource) &&
      /const showBuildingStopButton = computed\(\(\) =>\s*isBarHotkeyPreset\.value &&\s*showBuildingActions\.value &&\s*props\.selection\.hasBarBuildingStopControl,\s*\);/.test(selectionPanelSource) &&
      /if \(showBuildingActiveButton\.value && showBuildingActions\.value\) count \+= 1;\s*if \(showBuildingStopButton\.value\) count \+= 1;/.test(selectionPanelSource) &&
      buildingPowerIndex > buildingPowerStart &&
      buildingStopIndex > buildingPowerIndex &&
      /v-if="showBuildingStopButton"[\s\S]{0,420}:title="actionTitle\('Stop', 'command\.stop'\)"[\s\S]{0,180}@click="actions\.stopSelectedUnits\(\)"/.test(selectionPanelSource),
    'BAR buildingExtractorT2/armamex selections must show Stop after ON/OFF because armamex removes Wait but keeps Stop',
  );
  assertContract(
    /const showResurrectButton = computed\(\(\) =>\s*isBarHotkeyPreset\.value\s*\?\s*props\.selection\.hasBarResurrectControl\s*:\s*showPrototypeOnlyCommandButtons\.value && props\.selection\.hasCommander,\s*\);/.test(selectionPanelSource) &&
      /getSelectedResurrectSourceForActivePreset\(\): Entity \| null \{[\s\S]{0,260}entityHasBarResurrectCommand/.test(input3DManagerSource),
    'BAR Resurrect must be driven only by BAR-equivalent resurrectors, while prototype presets keep commander-only resurrect',
  );
  assertContract(
    /--bar-grid-queue-font-size:\s*calc\(var\(--bar-grid-cell-inner-size\) \* 0\.29\);/.test(selectionPanelSource) &&
      /--bar-grid-queue-badge-height:\s*round\(down,\s*calc\(var\(--bar-grid-cell-inner-size\) \* 0\.365\),\s*1px\);/.test(selectionPanelSource) &&
      /--bar-grid-queue-text-padding:\s*round\(down,\s*calc\(var\(--bar-grid-cell-inner-size\) \* 0\.1\),\s*1px\);/.test(selectionPanelSource) &&
      /--bar-grid-queue-corner-size:\s*calc\(var\(--bar-grid-corner-size\) \* 3\.3\);/.test(selectionPanelSource) &&
      /\.bar-cell-queue-count,[\s\S]{0,220}left:\s*0;[\s\S]{0,180}height:\s*var\(--bar-grid-queue-badge-height\);[\s\S]{0,180}font-size:\s*var\(--bar-grid-queue-font-size\);/.test(selectionPanelSource) &&
      /\.bar-cell-queue-count \{\s*top:\s*calc\(var\(--bar-grid-cell-padding\) \+ var\(--bar-grid-icon-padding\)\);\s*border-radius:\s*0 0 var\(--bar-grid-queue-corner-size\) 0;\s*color:\s*rgb\(190,\s*255,\s*190\);/.test(selectionPanelSource) &&
      /\.bar-cell-quota-count \{\s*bottom:\s*calc\(var\(--bar-grid-cell-padding\) \+ var\(--bar-grid-icon-padding\)\);\s*border-radius:\s*0 var\(--bar-grid-queue-corner-size\) 0 0;\s*color:\s*rgb\(255,\s*130,\s*190\);/.test(selectionPanelSource),
    'BAR factory build-cell queue/quota badges must use gui_gridmenu.lua cellInnerSize*0.29 font, floored 0.365 badge height/text padding, left-edge anchoring, and one-corner chamfer',
  );
  assertContract(
    /background:\s*linear-gradient\(to top,\s*rgba\(38,\s*38,\s*38,\s*0\.95\),\s*rgba\(64,\s*64,\s*64,\s*0\.95\)\);/.test(selectionPanelSource),
    'BAR factory build-cell queue/quota badges must use gui_gridmenu.lua dark badge treatment instead of colored badge backgrounds',
  );
  assertContract(
    /\.bar-grid-cell > \.btn-key\.bar-cell-key \{[\s\S]{0,420}background:\s*transparent;[\s\S]{0,80}border:\s*0;[\s\S]{0,80}color:\s*rgb\(215,\s*255,\s*215\);/.test(selectionPanelSource),
    'BAR build-cell hotkeys must render as plain top-right pale-green text, not as local black key badges',
  );
  assertContract(
    /buildingResourceConverter:\s*'metal',/.test(selectionPanelSource) &&
      /buildingSolar:\s*'energy',/.test(selectionPanelSource) &&
      /buildingWind:\s*'energy',/.test(selectionPanelSource),
    'BAR build-grid economy group icons must match ARM LandEconomy unitgroups: armmakr/buildingResourceConverter uses metal while solar and wind use energy',
  );
  assertContract(
    /unitBee:\s*'util',/.test(selectionPanelSource) &&
      /unitEagle:\s*'aa',/.test(selectionPanelSource) &&
      !/unitTransport:\s*'util',/.test(selectionPanelSource),
    'BAR-grid air factory analogue group icons must match unitgroup fields: unitBee/armpeep uses util, unitEagle/armfig uses aa, and unitTransport/armatlas has no group icon',
  );
  assertContract(
    /\.bar-grid-cell \.btn-thumb::before \{[\s\S]{0,100}z-index:\s*2;/.test(selectionPanelSource) &&
      /\.bar-grid-cell\.active \.btn-thumb::before \{\s*background:\s*rgba\(255,\s*217,\s*51,\s*0\.25\);[\s\S]{0,80}mix-blend-mode:\s*screen;/.test(selectionPanelSource),
    'BAR selected build/production cells must use gui_gridmenu.lua selectedCellColor yellow icon overlay above FlowUI Unit shading instead of prototype button glow',
  );
  assertContract(
    /\.bar-grid-cell \.btn-thumb::after \{[\s\S]{0,120}inset:\s*0;[\s\S]{0,220}linear-gradient\(to bottom,\s*rgba\(255,\s*255,\s*255,\s*0\.06\),\s*rgba\(255,\s*255,\s*255,\s*0\) 40%,\s*rgba\(255,\s*255,\s*255,\s*0\) 100%\),[\s\S]{0,160}linear-gradient\(to top,\s*rgba\(0,\s*0,\s*0,\s*0\.2\),\s*rgba\(0,\s*0,\s*0,\s*0\)\);/.test(selectionPanelSource) &&
      !/height:\s*55%;[\s\S]{0,80}rgba\(0,\s*0,\s*0,\s*0\.82\)/.test(selectionPanelSource),
    'BAR build-cell icon shading must mirror gui_flowui.lua Unit layer 2 subtle full-icon bottom gradient and layer 3 top shine instead of a strong half-height local fade',
  );
  assertContract(
    /--bar-grid-icon-inner-size:\s*calc\(var\(--bar-grid-cell-inner-size\) - \(var\(--bar-grid-icon-padding\) \* 2\)\);/.test(selectionPanelSource) &&
      /--bar-grid-default-unit-scale:\s*1\.0610079576;/.test(selectionPanelSource) &&
      /--bar-grid-hover-unit-scale:\s*1\.2048192771;/.test(selectionPanelSource) &&
      /--bar-grid-selected-unit-scale:\s*1\.2861736334;/.test(selectionPanelSource) &&
      /\.bar-grid-cell \.btn-thumb-img \{[\s\S]{0,180}transform:\s*scale\(var\(--bar-grid-default-unit-scale\)\);[\s\S]{0,80}transform-origin:\s*center;/.test(selectionPanelSource) &&
      /\.bar-grid-cell:hover \.btn-thumb-img,[\s\S]{0,80}\.bar-grid-cell:focus-visible \.btn-thumb-img \{\s*transform:\s*scale\(var\(--bar-grid-hover-unit-scale\)\);/.test(selectionPanelSource) &&
      /\.bar-grid-cell\.active \.btn-thumb-img \{\s*transform:\s*scale\(var\(--bar-grid-selected-unit-scale\)\);/.test(selectionPanelSource) &&
      !/\.bar-grid-cell \.btn-thumb-img \{[\s\S]{0,220}transform:\s*scale\(2\./.test(selectionPanelSource) &&
      !/\.bar-grid-cell:hover \.btn-thumb-img,[\s\S]{0,80}\.bar-grid-cell:focus-visible \.btn-thumb-img \{\s*transform:\s*scale\(2\./.test(selectionPanelSource) &&
      !/\.bar-grid-cell\.active \.btn-thumb-img \{\s*transform:\s*scale\(2\./.test(selectionPanelSource) &&
      !/\.bar-grid-cell \.btn-thumb-img \{[\s\S]{0,220}transition:\s*transform/.test(selectionPanelSource) &&
      /--bar-grid-unit-base-outline-width:\s*max\(1px,\s*round\(down,\s*calc\(var\(--bar-grid-icon-inner-size\) \* 0\.044\),\s*1px\)\);/.test(selectionPanelSource) &&
      /--bar-grid-unit-border-size:\s*min\(max\(1px,\s*round\(down,\s*calc\(var\(--bar-grid-icon-inner-size\) \* 0\.024\),\s*1px\)\),\s*round\(nearest,\s*0\.15vh,\s*1px\)\);/.test(selectionPanelSource) &&
      /\.bar-grid-cell \.btn-thumb \{[\s\S]{0,160}width:\s*auto;[\s\S]{0,40}height:\s*auto;/.test(selectionPanelSource) &&
      /\.bar-grid-cell \.btn-thumb \{[\s\S]{0,340}box-shadow:\s*0 0 0 var\(--bar-grid-unit-base-outline-width\) rgba\(0,\s*0,\s*0,\s*0\.22\);/.test(selectionPanelSource) &&
      /\.bar-grid-cell \.btn-thumb::after \{[\s\S]{0,420}box-shadow:\s*inset 0 0 0 var\(--bar-grid-unit-border-size\) rgba\(255,\s*255,\s*255,\s*0\.14\),[\s\S]{0,120}inset 0 0 calc\(var\(--bar-grid-unit-border-size\) \* 2\) rgba\(255,\s*255,\s*255,\s*0\.1\);/.test(selectionPanelSource),
    'BAR build-cell thumbnails must use gui_gridmenu.lua/FlowUI Unit texture zoom, base outline, and capped feathered edge highlight formulas',
  );
  assertContract(
    /function factoryCellBuildProgressStyle\(unitBlueprintId: string\): \{ '--bar-cell-progress-remaining': string \} \| undefined \{[\s\S]{0,260}`\$\{\(\(1 - progress\) \* 100\)\.toFixed\(3\)\}%`/.test(selectionPanelSource) &&
      /v-if="factoryCellShowsBuildProgress\(uo\.unitBlueprintId\)"[\s\S]{0,160}class="bar-cell-build-progress"[\s\S]{0,160}:style="factoryCellBuildProgressStyle\(uo\.unitBlueprintId\)"/.test(selectionPanelSource) &&
      /\.bar-cell-build-progress \{[\s\S]{0,140}inset:\s*calc\(var\(--bar-grid-cell-padding\) \+ var\(--bar-grid-icon-padding\)\);[\s\S]{0,120}border-radius:\s*var\(--bar-grid-progress-corner-size\);[\s\S]{0,180}rgba\(20,\s*20,\s*20,\s*0\.6\)[\s\S]{0,160}transform:\s*scaleX\(-1\);/.test(selectionPanelSource),
    'BAR producing factory cell must draw gui_gridmenu.lua RectRoundProgress-style dark remaining-progress overlay inside the icon inset',
  );
  assertContract(
    /import \{[\s\S]{0,80}getBuildFraction,[\s\S]{0,80}isBuildInProgress,[\s\S]{0,80}\} from '..\/..\/sim\/buildableHelpers';/.test(uiUpdateManagerSource) &&
      /if \(isBuildInProgress\(factoryBuildable\)\) \{[\s\S]{0,80}factoryUnderConstruction = true;[\s\S]{0,80}factoryConstructionProgress = getBuildFraction\(factoryBuildable\);/.test(uiUpdateManagerSource) &&
      /else \{[\s\S]{0,80}factoryUnderConstruction = false;[\s\S]{0,80}factoryConstructionProgress = 1;/.test(uiUpdateManagerSource) &&
      /'factory-under-construction': selection\.factoryUnderConstruction === true/.test(selectionPanelSource) &&
      /v-if="selection\.factoryUnderConstruction === true" class="bar-grid-under-construction"[\s\S]{0,80}Under Construction/.test(selectionPanelSource) &&
      /v-if="selection\.factoryUnderConstruction === true \|\| factoryGridPageCount > 1"[\s\S]{0,220}class="bar-grid-under-construction"[\s\S]{0,180}<button[\s\S]{0,80}v-if="factoryGridPageCount > 1"[\s\S]{0,160}title="Next page"/.test(selectionPanelSource) &&
      !/class="bar-grid-under-construction"[\s\S]{0,180}<button[\s\S]{0,80}v-else[\s\S]{0,160}title="Next page"/.test(selectionPanelSource) &&
      /\.bar-grid-cell\.factory-under-construction:not\(:hover\):not\(:focus-visible\) \.btn-thumb-img \{\s*filter:\s*brightness\(0\.77\);/.test(selectionPanelSource) &&
      /--bar-grid-group-icon-size:\s*round\(down,\s*calc\(var\(--bar-grid-icon-inner-size\) \* 0\.3\),\s*1px\);/.test(selectionPanelSource) &&
      /\.bar-cell-group-icon \{[\s\S]{0,160}width:\s*var\(--bar-grid-group-icon-size\);[\s\S]{0,80}height:\s*var\(--bar-grid-group-icon-size\);[\s\S]{0,160}filter:\s*none;/.test(selectionPanelSource) &&
      /\.bar-grid-cell\.factory-under-construction:not\(:hover\):not\(:focus-visible\) \.bar-cell-group-icon \{\s*filter:\s*brightness\(0\.63\);/.test(selectionPanelSource) &&
      !/\.bar-cell-group-icon \{[\s\S]{0,180}drop-shadow/.test(selectionPanelSource) &&
      /\.bar-grid-under-construction \{[\s\S]{0,220}color:\s*rgb\(255,\s*200,\s*50\);[\s\S]{0,120}font-size:\s*calc\(var\(--bar-grid-page-font-size\) \* 1\.1\);/.test(selectionPanelSource),
    'BAR incomplete selected factories must dim production cells, draw group icons at gui_flowui.lua floor(iconWidth*0.3), tint them with gui_gridmenu.lua t0.63 only, draw the Under Construction footer warning, and keep pages>1 pagination available',
  );
  assertContract(
    /\.bar-grid-cell\.empty \{\s*position:\s*relative;\s*background:\s*transparent;\s*border:\s*0;/.test(selectionPanelSource) &&
      /\.bar-grid-cell\.empty::before \{\s*content:\s*"";\s*position:\s*absolute;\s*inset:\s*calc\(var\(--bar-grid-cell-padding\) \+ var\(--bar-grid-icon-padding\)\);[\s\S]{0,120}background:\s*rgba\(26,\s*26,\s*26,\s*0\.7\);/.test(selectionPanelSource),
    'BAR empty build/production cells must draw an inset dark rounded rect using cellPadding+iconPadding instead of filling the whole cell',
  );
  assertContract(
    /\.bar-menu-group \{[\s\S]{0,260}padding:\s*0;\s*background:\s*transparent;\s*border:\s*0;\s*border-radius:\s*0;\s*box-shadow:\s*none;/.test(selectionPanelSource),
    'BAR build grid wrapper must not add a second local panel frame around gui_gridmenu.lua backgroundRect',
  );
  assertContract(
    /\.options-panel\.bar-hotkey-preset \.bar-grid-cell\.action-btn:hover,[\s\S]{0,120}\.bar-grid-cell\.action-btn\.active \{\s*background:\s*var\(--selection-panel-button-bg\);\s*border-color:\s*var\(--selection-panel-button-border\);\s*box-shadow:\s*none;/.test(selectionPanelSource),
    'BAR build/production grid hover and selected cells must keep neutral outer button chrome while feedback is drawn inside the icon',
  );
  assertContract(
    /\.bar-category-key \{[\s\S]{0,180}background:\s*transparent;[\s\S]{0,80}color:\s*rgb\(215,\s*255,\s*215\);/.test(selectionPanelSource),
    'BAR grid category/page/builder hotkeys must use gui_gridmenu.lua drawButtonHotkey pale-green text without local badge backgrounds',
  );
  assertContract(
    /\.bar-category-label \{[\s\S]{0,160}left:\s*calc\(var\(--bar-grid-bg-padding\) \* 7\);/.test(selectionPanelSource) &&
      /\.bar-page-label \{[\s\S]{0,160}left:\s*calc\(var\(--bar-grid-bg-padding\) \* 3\);/.test(selectionPanelSource) &&
      /\.bar-back-arrow \{[\s\S]{0,100}left:\s*calc\(var\(--bar-grid-bg-padding\) \* 2\);/.test(selectionPanelSource) &&
      /\.bar-back-label \{[\s\S]{0,100}left:\s*25%;/.test(selectionPanelSource) &&
      /\.bar-grid-footer \.bar-category-key \{[\s\S]{0,100}right:\s*calc\(var\(--bar-grid-bg-padding\) \* 2\);/.test(selectionPanelSource),
    'BAR grid footer labels and hotkeys must use gui_gridmenu.lua fixed bgpadding offsets rather than centered flex spacing',
  );
  assertContract(
    /:title="barBuildCategoryTitle\(category\)"/.test(selectionPanelSource) &&
      /description: 'Show economy structures'/.test(buildMenuLayoutSource) &&
      /description: 'Show combat and defensive structures'/.test(buildMenuLayoutSource) &&
      /description: 'Show utility structures'/.test(buildMenuLayoutSource) &&
      /description: 'Show production structures'/.test(buildMenuLayoutSource) &&
      /function barBuildCategoryTitle\(category: \(typeof BAR_BUILD_CATEGORIES\)\[number\]\): string \{[\s\S]{0,160}Hotkey: \[\$\{key\}\]/.test(selectionPanelSource) &&
      /title="Go back to main view"/.test(selectionPanelSource) &&
      /v-else-if="showBuildGridPager"[\s\S]{0,260}title="Next page"[\s\S]{0,260}<span class="bar-page-label">Page \{\{ buildGridPage \+ 1 \}\}\/\{\{ buildGridPageCount \}\}&nbsp;&nbsp;🠚<\/span>[\s\S]{0,160}<span v-if="barGridNextPageHotkey" class="bar-category-key">\{\{ barGridNextPageHotkey \}\}<\/span>/.test(selectionPanelSource) &&
      /<span class="bar-page-label">Page \{\{ factoryGridPage \+ 1 \}\}\/\{\{ factoryGridPageCount \}\}&nbsp;&nbsp;🠚<\/span>/.test(selectionPanelSource),
    'BAR build category/back/page browser titles and page labels must use gui_gridmenu.lua localized buildMenu strings, Page X/Y  🠚 spacing, and nextPageRect hotkeys',
  );
  assertContract(
    !selectionPanelSource.includes('Next build page') &&
    !selectionPanelSource.includes('Next unit page') &&
      !selectionPanelSource.includes('Back to build categories') &&
      !selectionPanelSource.includes('buildings -'),
    'BAR build-grid browser titles must not keep prototype wording for categories, back, or build/factory pagination',
  );
  assertContract(
    /\.bar-grid-category-btn:hover,[\s\S]{0,80}\.bar-grid-footer-btn:hover \{\s*border-color:\s*var\(--selection-panel-button-border\);\s*background:\s*var\(--selection-panel-button-hover-bg\);/.test(selectionPanelSource) &&
      /\.bar-grid-category-btn\.active \{\s*background:\s*rgba\(51,\s*51,\s*51,\s*0\.9\);\s*border-color:\s*var\(--selection-panel-button-border\);\s*box-shadow:\s*none;/.test(selectionPanelSource),
    'BAR grid category/footer hover and active category states must use neutral drawButton chrome instead of prototype build-colored glows',
  );
  assertContract(
    /\.bar-builder-type-btn \{[\s\S]{0,180}background:\s*transparent;\s*border:\s*0;/.test(selectionPanelSource) &&
      !/\.bar-builder-type-btn\.active \{[\s\S]{0,120}box-shadow:/.test(selectionPanelSource),
    'BAR builder selector icons must not use prototype active border or shadow chrome',
  );
  assertContract(
    /\.bar-builder-thumb-img \{[\s\S]{0,120}filter:\s*brightness\(0\.5\);[\s\S]{0,120}transform:\s*scale\(2\.1\);/.test(selectionPanelSource) &&
      /\.bar-builder-type-btn\.active \.bar-builder-thumb-img \{\s*filter:\s*brightness\(1\);/.test(selectionPanelSource) &&
      /\.bar-builder-type-btn:hover \.bar-builder-thumb-img,[\s\S]{0,100}filter:\s*brightness\(0\.75\);[\s\S]{0,80}transform:\s*scale\(2\.2\);/.test(selectionPanelSource) &&
      !/\.bar-builder-thumb-img \{[\s\S]{0,180}transition:/.test(selectionPanelSource),
    'BAR builder selector must mirror gui_gridmenu.lua drawBuilder inactive 0.5 lightness, active 1.0 lightness, and immediate hover zoom/brightness without prototype tweening',
  );
  assertContract(
    /--bar-grid-icon-margin:\s*round\(nearest,\s*calc\(var\(--bar-grid-bg-padding\) \* 0\.5\),\s*1px\);/.test(selectionPanelSource) &&
      /\.bar-builder-type-list \{[\s\S]{0,120}gap:\s*calc\(var\(--bar-grid-bg-padding\) \+ var\(--bar-grid-icon-margin\)\);[\s\S]{0,240}padding:\s*var\(--bar-grid-icon-margin\)\s*calc\(var\(--bar-grid-bg-padding\) \* 2\)\s*calc\(var\(--bar-grid-bg-padding\) \+ var\(--bar-grid-icon-margin\)\)\s*calc\(var\(--bar-grid-bg-padding\) \+ var\(--bar-grid-icon-margin\)\);/.test(selectionPanelSource) &&
      /\.bar-builder-cycle-btn \{[\s\S]{0,120}align-self:\s*flex-start;[\s\S]{0,180}margin-top:\s*calc\(var\(--bar-grid-icon-margin\) \+ \(var\(--bar-builder-button-size\) \* 0\.2\)\);/.test(selectionPanelSource),
    'BAR builder selector strip must use gui_gridmenu.lua iconMargin=floor(bgpadding*0.5+0.5) for icon spacing/padding and next-builder y offset',
  );
  assertContract(
    /--bar-builder-count-font-size:\s*calc\(var\(--bar-builder-button-size\) \* 0\.3\);/.test(selectionPanelSource) &&
      /--bar-builder-count-pad:\s*round\(down,\s*calc\(var\(--bar-builder-button-size\) \* 0\.03\),\s*1px\);/.test(selectionPanelSource) &&
      /\.bar-builder-count \{[\s\S]{0,120}left:\s*calc\(var\(--bar-builder-count-pad\) \* 2\);[\s\S]{0,80}bottom:\s*var\(--bar-builder-count-pad\);[\s\S]{0,80}color:\s*rgb\(240,\s*240,\s*240\);[\s\S]{0,120}font-size:\s*var\(--bar-builder-count-font-size\);/.test(selectionPanelSource),
    'BAR builder selector count badge must use gui_gridmenu.lua rectSize*0.3 font, floor(rectSize*0.03) pad, and 240/240/240 text color',
  );
  assertContract(
    /function builderTypeBuildProgressStyle\(active: boolean\): \{ '--bar-builder-progress-remaining': string \} \| undefined \{[\s\S]{0,260}props\.selection\.factoryUnderConstruction !== true[\s\S]{0,260}`\$\{\(\(1 - progress\) \* 100\)\.toFixed\(3\)\}%`/.test(selectionPanelSource) &&
      /v-if="builderTypeBuildProgressStyle\(builderType\.active\)"[\s\S]{0,160}class="bar-builder-build-progress"[\s\S]{0,160}:style="builderTypeBuildProgressStyle\(builderType\.active\)"/.test(selectionPanelSource) &&
      /--bar-builder-progress-corner-size:\s*min\(max\(1px,\s*round\(down,\s*calc\(var\(--bar-builder-button-size\) \* 0\.024\),\s*1px\)\),\s*round\(nearest,\s*0\.15vh,\s*1px\)\);/.test(selectionPanelSource) &&
      /\.bar-builder-build-progress \{[\s\S]{0,80}inset:\s*0;[\s\S]{0,120}border-radius:\s*var\(--bar-builder-progress-corner-size\);[\s\S]{0,180}rgba\(13,\s*13,\s*13,\s*0\.72\)[\s\S]{0,160}transform:\s*scaleX\(-1\);/.test(selectionPanelSource),
    'BAR active builder selector icon must draw gui_gridmenu.lua RectRoundProgress overlay while the selected factory shell is under construction',
  );
  assertContract(
    BAR_MAX_SELECTED_BUILDER_TYPES === 5 &&
      /export const BAR_MAX_SELECTED_BUILDER_TYPES = 5;/.test(hostCapabilitiesSource) &&
      /getSelectedBuilderTypeInfos\(selectedUnits\)\.slice\(0, BAR_MAX_SELECTED_BUILDER_TYPES\)/.test(hostCapabilitiesSource),
    'BAR builder selector must cap visible builder types to gui_gridmenu.lua maxBuilderRects=5',
  );
  assertContract(
    /const builderTypeInfos = getBarVisibleSelectedBuilderTypeInfos\(selectedUnits\);/.test(uiUpdateManagerSource) &&
      /setActiveBuilderUnitBlueprintId\(unitBlueprintId: string\): boolean \{[\s\S]{0,140}getBarVisibleSelectedBuilderTypeInfos/.test(input3DManagerSource) &&
      /cycleActiveBuilder\(\): boolean \{[\s\S]{0,140}getBarVisibleSelectedBuilderTypeInfos/.test(input3DManagerSource) &&
      /normalizeActiveBuilderUnitBlueprintId\(\): string \| null \{[\s\S]{0,140}getBarVisibleSelectedBuilderTypeInfos/.test(input3DManagerSource),
    'BAR visible builder cap must drive the selection strip and active-builder switching, not only rendering',
  );
  assertContract(
    /--bar-order-panel-width:\s*37\.825vh;/.test(selectionPanelSource) &&
      /--bar-order-panel-height:\s*14vh;/.test(selectionPanelSource) &&
      /--bar-flow-element-margin:\s*0\.45vh;/.test(selectionPanelSource) &&
      /--bar-flow-element-padding:\s*0\.3vh;/.test(selectionPanelSource) &&
      /--bar-order-active-padding:\s*calc\(var\(--bar-flow-element-padding\) \* 1\.4\);/.test(selectionPanelSource) &&
      /--bar-order-bottom-active-padding:\s*calc\(var\(--bar-order-active-padding\) \/ 3\);/.test(selectionPanelSource) &&
      /--bar-order-button-padding:\s*max\(1px,\s*calc\(var\(--bar-flow-element-padding\) \* 0\.52\)\);/.test(selectionPanelSource) &&
      /\.options-panel > \.button-group:not\(\.bar-menu-group\):not\(\.selection-command-group\):not\(\.details-group\) \.action-btn \{[\s\S]{0,520}padding:\s*var\(--bar-order-button-padding\);/.test(selectionPanelSource) &&
      !/padding-bottom:\s*calc\(var\(--bar-order-button-padding\) \+ 4px\);/.test(selectionPanelSource) &&
      /left:\s*calc\(var\(--bar-order-panel-width\) \+ var\(--bar-flow-element-margin\)\);/.test(selectionPanelSource),
    'BAR order menu dimensions, side offset, and single-value button padding must follow gui_ordermenu.lua plus FlowUI elementMargin=0.0045*vsy and elementPadding=0.003*vsy',
  );
  assertContract(
    /--bar-grid-bg-padding:\s*var\(--bar-flow-element-padding\);/.test(selectionPanelSource) &&
      /--bar-grid-cell-size:\s*round\(down,\s*calc\(\(37\.825vh - \(var\(--bar-grid-bg-padding\) \* 2\)\) \/ 4\),\s*1px\);/.test(selectionPanelSource) &&
      !/--bar-grid-bg-padding:\s*clamp\(3px,\s*0\.35vh,\s*5px\);/.test(selectionPanelSource) &&
      !/--bar-grid-cell-size:\s*clamp\(72px,\s*9\.45vh,\s*108px\);/.test(selectionPanelSource),
    'BAR build grid cells must mirror gui_gridmenu.lua FlowUI bgpadding and math_floor side-mode width-derived cell size instead of clamped or fractional local approximations',
  );
  assertContract(
      /--bar-grid-cell-padding:\s*round\(down,\s*calc\(var\(--bar-grid-cell-size\) \* 0\.007\),\s*1px\);/.test(selectionPanelSource) &&
      /--bar-grid-icon-padding:\s*max\(1px,\s*round\(down,\s*calc\(var\(--bar-grid-cell-size\) \* 0\.015\),\s*1px\)\);/.test(selectionPanelSource) &&
      /--bar-grid-corner-size:\s*round\(down,\s*calc\(var\(--bar-grid-cell-size\) \* 0\.025\),\s*1px\);/.test(selectionPanelSource) &&
      /--bar-grid-progress-corner-size:\s*calc\(var\(--bar-grid-cell-size\) \* 0\.03\);/.test(selectionPanelSource) &&
      /--bar-grid-cell-inner-size:\s*calc\(var\(--bar-grid-cell-size\) - \(var\(--bar-grid-cell-padding\) \* 2\)\);/.test(selectionPanelSource) &&
      /--bar-grid-price-font-size:\s*round\(nearest,\s*calc\(var\(--bar-grid-cell-inner-size\) \* 0\.16\),\s*1px\);/.test(selectionPanelSource) &&
      /--bar-grid-key-font-size:\s*calc\(var\(--bar-grid-price-font-size\) \* 1\.1\);/.test(selectionPanelSource) &&
      !/--bar-grid-cell-padding:\s*max\(1px,/.test(selectionPanelSource) &&
      !/--bar-grid-icon-padding:\s*2px;/.test(selectionPanelSource) &&
      !/--bar-grid-price-font-size:\s*1\.5vh;/.test(selectionPanelSource),
    'BAR build grid padding, icon padding, corners, price font, and hotkey font must mirror gui_gridmenu.lua math_floor/nearest rounding formulas',
  );
  assertContract(
    /\.bar-grid-cell \.btn-cost \{[\s\S]{0,180}right:\s*calc\(var\(--bar-grid-cell-padding\) \+ \(var\(--bar-grid-cell-inner-size\) \* 0\.048\)\);[\s\S]{0,140}bottom:\s*calc\(var\(--bar-grid-cell-padding\) \+ \(var\(--bar-grid-price-font-size\) \* 0\.35\)\);/.test(selectionPanelSource) &&
      /\.bar-grid-cell > \.btn-key\.bar-cell-key \{[\s\S]{0,120}right:\s*calc\(var\(--bar-grid-cell-padding\) \+ \(var\(--bar-grid-cell-inner-size\) \* 0\.048\)\);[\s\S]{0,120}top:\s*var\(--bar-grid-cell-padding\);/.test(selectionPanelSource),
    'BAR build grid price and hotkey text must use gui_gridmenu.lua cellPadding + cellInnerSize*0.048 right offset, top hotkey inset, and price baseline spacing',
  );
  assertContract(
    /--bar-grid-footer-third-width:\s*calc\(var\(--bar-grid-cell-size\) \* 1\.3333333333\);/.test(selectionPanelSource) &&
      /\.bar-grid-footer\.category-active \.bar-grid-back-btn,[\s\S]{0,160}\.bar-grid-footer\.page-only \.bar-grid-next-page-btn \{\s*width:\s*calc\(var\(--bar-grid-footer-third-width\) - \(var\(--bar-grid-bg-padding\) \* 2\)\);/.test(selectionPanelSource) &&
      /\.bar-grid-footer\.category-active \.bar-grid-current-category \{[\s\S]{0,80}width:\s*var\(--bar-grid-footer-third-width\);/.test(selectionPanelSource),
    'BAR category-active footer must use gui_gridmenu.lua thirds: back/next width=buttonWidth-bgpadding*2 and current category width=buttonWidth',
  );
  assertContract(
      /--bar-grid-category-font-size:\s*1\.3vh;/.test(selectionPanelSource) &&
      /--bar-grid-page-font-size:\s*var\(--bar-grid-category-font-size\);/.test(selectionPanelSource) &&
      /--bar-grid-hotkey-font-size:\s*calc\(var\(--bar-grid-category-font-size\) \+ 5px\);/.test(selectionPanelSource) &&
      /--bar-grid-category-button-base-height:\s*round\(down,\s*calc\(var\(--bar-grid-category-font-size\) \* 2\.3\),\s*1px\);/.test(selectionPanelSource) &&
      /--bar-grid-category-button-height:\s*calc\(var\(--bar-grid-category-button-base-height\) \* 1\.4\);/.test(selectionPanelSource) &&
      /--bar-grid-button-padding:\s*max\(1px,\s*calc\(var\(--bar-grid-bg-padding\) \* 0\.52\)\);/.test(selectionPanelSource) &&
      /--bar-grid-active-area-margin:\s*calc\(var\(--bar-grid-bg-padding\) \* 0\.1\);/.test(selectionPanelSource) &&
      /--bar-grid-category-rect-height:\s*calc\(var\(--bar-grid-category-button-height\) - var\(--bar-grid-active-area-margin\) - \(var\(--bar-grid-button-padding\) \* 2\)\);/.test(selectionPanelSource) &&
      /--bar-grid-category-icon-size:\s*min\(calc\(var\(--bar-grid-category-rect-height\) \* 1\.1\),\s*var\(--bar-grid-category-button-height\)\);/.test(selectionPanelSource) &&
      /--bar-grid-footer-button-height:\s*calc\(var\(--bar-grid-category-button-height\) - \(var\(--bar-grid-button-padding\) \* 2\)\);/.test(selectionPanelSource) &&
      /\.bar-grid-category-btn,[\s\S]{0,80}\.bar-grid-footer-btn \{[\s\S]{0,180}height:\s*var\(--bar-grid-category-button-height\);[\s\S]{0,260}font-size:\s*var\(--bar-grid-category-font-size\);/.test(selectionPanelSource) &&
      /\.bar-grid-footer:not\(\.category-active\):not\(\.page-only\) \.bar-grid-category-btn \{[\s\S]{0,120}height:\s*var\(--bar-grid-category-rect-height\);[\s\S]{0,80}margin-top:\s*var\(--bar-grid-button-padding\);/.test(selectionPanelSource) &&
      /\.bar-grid-category-btn \{\s*width:\s*var\(--bar-grid-cell-size\);\s*overflow:\s*visible;/.test(selectionPanelSource) &&
      /\.bar-category-icon \{[\s\S]{0,160}top:\s*calc\(var\(--bar-grid-bg-padding\) \* 0\.5\);[\s\S]{0,100}left:\s*calc\(var\(--bar-grid-bg-padding\) \* 0\.5\);[\s\S]{0,100}width:\s*var\(--bar-grid-category-icon-size\);[\s\S]{0,80}height:\s*var\(--bar-grid-category-icon-size\);/.test(selectionPanelSource) &&
      /\.bar-grid-footer\.category-active \.bar-grid-current-category \{\s*height:\s*var\(--bar-grid-category-rect-height\);/.test(selectionPanelSource) &&
      /\.bar-grid-footer\.category-active \.bar-grid-back-btn,[\s\S]{0,120}\.bar-grid-footer\.page-only \.bar-grid-next-page-btn \{\s*height:\s*var\(--bar-grid-footer-button-height\);/.test(selectionPanelSource) &&
      /\.bar-category-key \{[\s\S]{0,220}font-size:\s*var\(--bar-grid-hotkey-font-size\);/.test(selectionPanelSource) &&
      !/height:\s*calc\(100% - var\(--bar-grid-bg-padding\)\);/.test(selectionPanelSource) &&
      !/height:\s*4\.2vh;/.test(selectionPanelSource) &&
      !/font-size:\s*1\.35vh;/.test(selectionPanelSource),
    'BAR grid category/footer labels, icons, hotkeys, button heights, and padded rects must derive from gui_gridmenu.lua categoryFontSize/pageFontSize/hotkeyFontSize/setupCategoryRects/drawButton formulas, including floored categoryButtonHeight, instead of fixed approximations',
  );
  assertContract(
      /--bar-builder-button-size:\s*calc\(var\(--bar-grid-category-button-base-height\) \* 2\);/.test(selectionPanelSource) &&
      /\.bar-builder-type-btn \{[\s\S]{0,160}width:\s*var\(--bar-builder-button-size\);\s*height:\s*var\(--bar-builder-button-size\);/.test(selectionPanelSource) &&
      /\.bar-builder-strip \{[\s\S]{0,120}bottom:\s*100%;[\s\S]{0,120}gap:\s*var\(--bar-grid-bg-padding\);/.test(selectionPanelSource) &&
      /\.bar-builder-type-list \{[\s\S]{0,160}gap:\s*calc\(var\(--bar-grid-bg-padding\) \+ var\(--bar-grid-icon-margin\)\);[\s\S]{0,260}background:\s*rgba\(5,\s*7,\s*10,\s*0\.88\);/.test(selectionPanelSource),
    'BAR builder selector icons must use gui_gridmenu.lua builderButtonSize=pre-side floored categoryButtonHeight*2 and bgpadding+iconMargin spacing',
  );
  assertContract(
      /const barGridCycleBuilderHotkey = computed\(\(\) =>\s*isBarGridCommandHotkeyPreset\(props\.hotkeyPreset\) \? '\.' : '',\s*\);/.test(selectionPanelSource) &&
      /const barGridCycleBuilderTitle = computed\(\(\) => 'Next Builder'\);/.test(selectionPanelSource) &&
      !selectionPanelSource.includes('Next Builder -') &&
      /<span class="bar-builder-cycle-label">›<\/span>/.test(selectionPanelSource) &&
      /<span v-if="barGridCycleBuilderHotkey" class="bar-category-key">\{\{ barGridCycleBuilderHotkey \}\}<\/span>/.test(selectionPanelSource) &&
      /--bar-builder-next-height:\s*calc\(var\(--bar-builder-button-size\) \* 0\.6\);/.test(selectionPanelSource) &&
      /--bar-builder-next-width:\s*calc\(\(var\(--bar-builder-button-size\) \* 0\.45\) \+ \(var\(--bar-grid-bg-padding\) \* 2\) \+ 1ch\);/.test(selectionPanelSource) &&
      /\.bar-builder-cycle-btn \{[\s\S]{0,260}margin-top:\s*calc\(var\(--bar-grid-icon-margin\) \+ \(var\(--bar-builder-button-size\) \* 0\.2\)\);[\s\S]{0,80}margin-left:\s*0;/.test(selectionPanelSource) &&
      /\.bar-builder-cycle-label \{[\s\S]{0,160}left:\s*calc\(var\(--bar-builder-next-height\) \* 0\.2\);/.test(selectionPanelSource),
    'BAR next-builder button must mirror gui_gridmenu.lua nextBuilderRect glyph/key display, nextBuilder tooltip text, 0.6*builder height, 0.45*builder width, and iconMargin+0.2*builder y offset',
  );
  assertContract(
    /--bar-order-active-height:\s*calc\(var\(--bar-order-panel-height\) - var\(--bar-order-active-padding\) - var\(--bar-order-bottom-active-padding\)\);/.test(selectionPanelSource) &&
      /--bar-order-cell-height:\s*round\(down,\s*calc\(var\(--bar-order-active-height\) \/ var\(--bar-order-rows\)\),\s*1px\);/.test(selectionPanelSource) &&
      /--bar-order-cell-inner-height:\s*round\(down,\s*calc\(var\(--bar-order-cell-height\) - var\(--bar-order-cell-margin-primary\) - var\(--bar-order-cell-margin-secondary\)\),\s*1px\);/.test(selectionPanelSource) &&
      /--bar-order-state-light-height:\s*calc\(var\(--bar-order-cell-inner-height\) \* 0\.14\);/.test(selectionPanelSource) &&
      !/--bar-order-state-light-height:\s*calc\(\(var\(--bar-order-active-height\) \/ var\(--bar-order-rows\)\) \* 0\.14\);/.test(selectionPanelSource) &&
      /height:\s*var\(--bar-order-state-light-height\);/.test(selectionPanelSource) &&
      /bottom:\s*var\(--bar-order-button-padding\);/.test(selectionPanelSource),
    'BAR state lights must derive their height from gui_ordermenu.lua floored cellInnerHeight*0.14 and bottom inset from state padding placement',
  );
  assertContract(
    /--bar-state-light-count:\s*2;/.test(selectionPanelSource) &&
      /\.bar-state-lights:has\(\.bar-state-light:nth-child\(3\)\) \{\s*--bar-state-light-count:\s*3;/.test(selectionPanelSource) &&
      /--bar-state-light-width:\s*calc\(\(var\(--bar-order-cell-inner-width\) \/ var\(--bar-state-light-count\)\) - \(var\(--bar-order-button-padding\) \* 2\)\);/.test(selectionPanelSource) &&
      /--bar-state-light-gap:\s*calc\(\(var\(--bar-state-light-width\) \* 0\.075\) \+ \(var\(--bar-order-button-padding\) \* 2\)\);/.test(selectionPanelSource) &&
      /right:\s*calc\(var\(--bar-order-button-padding\) \* 2\);/.test(selectionPanelSource) &&
      /left:\s*calc\(var\(--bar-order-button-padding\) \* 2\);/.test(selectionPanelSource) &&
      /grid-template-columns:\s*repeat\(var\(--bar-state-light-count\),\s*minmax\(0,\s*1fr\)\);/.test(selectionPanelSource),
    'BAR state light strips must follow gui_ordermenu.lua statecount, padding2, and stateMargin=(stateWidth*0.075)+padding2*2 formulas',
  );
  assertContract(
    /const BAR_ORDER_CELL_MARGIN_ORIGINAL = 0\.055;/.test(selectionPanelSource) &&
      /const sizeDivider = \(gridSize\.columns \+ gridSize\.rows\) \/ 16;/.test(selectionPanelSource) &&
      /return cellHeight \* cellMarginHeightMultiplier \* cellMargin;/.test(selectionPanelSource) &&
      /function barOrderCellMarginCss\(valueVh: number, minPixels: 0 \| 1\): string \{\s*return `max\(\$\{minPixels\}px, round\(up, \$\{valueVh\.toFixed\(4\)\}vh, 1px\)\)`;\s*\}/.test(selectionPanelSource) &&
      /barOrderCellMarginCss\(barOrderCellMarginVh\(barOrderGridSize\.value, 0\.5\), 1\)/.test(selectionPanelSource) &&
      /barOrderCellMarginCss\(barOrderCellMarginVh\(barOrderGridSize\.value, 0\.18\), 0\)/.test(selectionPanelSource) &&
      /'--bar-order-cell-margin-primary': barOrderCellMarginPrimary\.value,/.test(selectionPanelSource) &&
      /'--bar-order-cell-margin-secondary': barOrderCellMarginSecondary\.value,/.test(selectionPanelSource) &&
      !/--bar-order-cell-margin:\s*clamp\(1px,\s*0\.28vh,\s*3px\);/.test(selectionPanelSource),
    'BAR order cells must use gui_ordermenu.lua dynamic ceil cellMarginPx/cellMarginPx2 formulas, including secondary min 0px, instead of a fixed viewport clamp',
  );
  assertContract(
    /--bar-order-corner-size:\s*calc\(var\(--bar-order-cell-width\) \* 0\.019\);/.test(selectionPanelSource) &&
      !/--bar-order-corner-size:\s*clamp\(2px,\s*0\.22vh,\s*3px\);/.test(selectionPanelSource),
    'BAR order button corners must derive from gui_ordermenu.lua cellWidth*0.019 instead of a fixed viewport clamp',
  );
  assertContract(
    /--bar-order-active-width:\s*calc\(var\(--bar-order-panel-width\) - \(var\(--bar-order-active-padding\) \* 2\)\);/.test(selectionPanelSource) &&
      /--bar-order-cell-width:\s*round\(down,\s*calc\(var\(--bar-order-active-width\) \/ var\(--bar-order-columns\)\),\s*1px\);/.test(selectionPanelSource) &&
      /--bar-order-cell-inner-width:\s*round\(down,\s*calc\(var\(--bar-order-cell-width\) - var\(--bar-order-cell-margin-primary\) - var\(--bar-order-cell-margin-secondary\)\),\s*1px\);/.test(selectionPanelSource) &&
      /--bar-order-label-max-size:\s*calc\(var\(--bar-order-cell-inner-width\) \/ 7\);/.test(selectionPanelSource) &&
      /font-size:\s*min\(var\(--bar-order-font-size\),\s*var\(--bar-order-label-max-size\)\);/.test(selectionPanelSource) &&
      !/font-size:\s*min\(var\(--bar-order-font-size\),\s*7px\);/.test(selectionPanelSource),
    'BAR order command labels must cap from gui_ordermenu.lua floored cellInnerWidth/7 rather than a fixed 7px local cap',
  );
  assertContract(
    /background:\s*rgba\(0,\s*0,\s*0,\s*0\.36\);/.test(selectionPanelSource) &&
      /background:\s*rgba\(255,\s*26,\s*26,\s*0\.8\);/.test(selectionPanelSource) &&
      /background:\s*rgba\(255,\s*255,\s*26,\s*0\.8\);/.test(selectionPanelSource) &&
      /background:\s*rgba\(26,\s*255,\s*26,\s*0\.8\);/.test(selectionPanelSource) &&
      /box-shadow:\s*0 0 calc\(var\(--bar-order-state-light-height\) \* 8\) rgba\(255,\s*26,\s*26,\s*0\.09\);/.test(selectionPanelSource) &&
      /box-shadow:\s*0 0 calc\(var\(--bar-order-state-light-height\) \* 8\) rgba\(255,\s*255,\s*26,\s*0\.09\);/.test(selectionPanelSource) &&
      /box-shadow:\s*0 0 calc\(var\(--bar-order-state-light-height\) \* 8\) rgba\(26,\s*255,\s*26,\s*0\.09\);/.test(selectionPanelSource),
    'BAR state lights must use gui_ordermenu.lua inactive black alpha, active red/yellow/green colors, and stateHeight*8 glow at 0.09 alpha',
  );
  assertContract(
    /function barStateButtonColor\(prototypeColor: string\): string \{\s*return isBarHotkeyPreset\.value \? BUTTON_COLORS\.default : prototypeColor;\s*\}/.test(selectionPanelSource),
    'BAR state commands must use the default order-menu color because gui_ordermenu.lua commandInfo leaves state commands uncolored',
  );
  assertContract(
    /function factoryStopProductionButtonColor\(\): string \{\s*return isBarHotkeyPreset\.value \? BUTTON_COLORS\.default : BUTTON_COLORS\.stop;\s*\}/.test(selectionPanelSource),
    'BAR factory stopproduction/Clear Queue must use the neutral order-menu color because gui_ordermenu.lua commandInfo only colors the separate Stop command',
  );
  assertContract(
    /<button[\s\S]{0,260}:disabled="!isBarHotkeyPreset && !hasFactoryProduction"[\s\S]{0,240}:style="\{ '--btn-color': factoryStopProductionButtonColor\(\) \}"/.test(selectionPanelSource),
    'the factory Clear Queue button must route through the BAR neutral/prototype red color helper while staying enabled for BAR presets',
  );
  assertContract(
      /count \+= 3; \/\/ repeat, wait, stop production/.test(selectionPanelSource) &&
      /if \(isBarHotkeyPreset\.value && props\.selection\.hasMoveStateControl\) count \+= 1;/.test(selectionPanelSource) &&
      /if \(showFactoryAirIdleButton\.value\) count \+= 1;/.test(selectionPanelSource) &&
      factoryControlStart >= 0 &&
      factoryRepeatIndex > factoryControlStart &&
      factoryMoveStateIndex > factoryRepeatIndex &&
      factoryAirIdleIndex > factoryMoveStateIndex &&
      factoryBuilderPriorityIndex > factoryAirIdleIndex &&
      factoryGuardIndex > factoryBuilderPriorityIndex &&
      factoryQueueModeIndex > factoryGuardIndex &&
      factoryWaitIndex > factoryQueueModeIndex &&
      factoryStopIndex > factoryWaitIndex &&
      /if \(props\.selection\.isWaiting\) return `\$\{modeLabel\} \$\{unitLabel\} waiting\$\{queuedLabel\}`;/.test(selectionPanelSource) &&
      /class="action-btn bar-order-wait"[\s\S]{0,220}:title="actionTitle\('Wait', 'command\.wait', 'Shift-click queues; Ctrl\/Cmd\+Shift-click inserts next'\)"[\s\S]{0,140}@click="toggleWaitFromClick"[\s\S]{0,260}binaryStateLights\(selection\.isWaiting\)/.test(selectionPanelSource),
    'BAR factory command surface must use state-first gui_ordermenu.lua ordering, include factory Move State and air-plant LandAt before Wait, and show waiting status when factory production is paused',
  );
  assertContract(
    /\.options-panel\.bar-hotkey-preset[\s\S]{0,260}\.action-btn\.active:not\(\.bar-grid-cell\):not\(\.bar-order-state\)[\s\S]{0,260}background:\s*linear-gradient\(to top,\s*rgba\(168,\s*168,\s*168,\s*0\.75\),\s*rgba\(255,\s*255,\s*255,\s*0\.75\)\);[\s\S]{0,180}color:\s*rgb\(20,\s*20,\s*20\);[\s\S]{0,120}box-shadow:\s*none;/.test(selectionPanelSource) &&
      /\.action-btn\.active:not\(\.bar-grid-cell\):not\(\.bar-order-state\)[\s\S]{0,220}transform:\s*scale\(1\.05\);[\s\S]{0,60}z-index:\s*2;/.test(selectionPanelSource) &&
      /\.action-btn\.active:not\(\.bar-grid-cell\):not\(\.bar-order-state\):hover:not\(:disabled\),[\s\S]{0,180}\.action-btn\.active:not\(\.bar-grid-cell\):not\(\.bar-order-state\):focus-visible:not\(:disabled\) \{[\s\S]{0,220}transform:\s*scale\(1\.05\);[\s\S]{0,60}z-index:\s*2;/.test(selectionPanelSource) &&
      !/rgba\(168,\s*168,\s*168,\s*0\.9\),\s*rgba\(255,\s*255,\s*255,\s*0\.9\)/.test(selectionPanelSource),
    'BAR active order commands must use gui_ordermenu.lua default ui_opacity clamp 0.75 light fill, dark text, and cellClickedZoom=1.05 instead of the prototype colored glow',
  );
  assertContract(
    /--bar-order-hover-top-alpha:\s*0\.28;/.test(selectionPanelSource) &&
      /--bar-order-hover-bottom-alpha:\s*0\.095;/.test(selectionPanelSource) &&
      /--bar-order-hover-top-alpha:\s*0\.112;/.test(selectionPanelSource) &&
      /\.options-panel\.bar-hotkey-preset \.action-btn \{\s*transition:\s*none;/.test(selectionPanelSource) &&
      /\.action-btn:not\(\.bar-grid-cell\)::before,[\s\S]{0,180}\.action-btn:not\(\.bar-grid-cell\)::after \{[\s\S]{0,220}opacity:\s*0;[\s\S]{0,80}pointer-events:\s*none;/.test(selectionPanelSource) &&
      /\.action-btn:not\(\.bar-grid-cell\):hover:not\(:disabled\),[\s\S]{0,180}\.action-btn:not\(\.bar-grid-cell\):focus-visible:not\(:disabled\) \{[\s\S]{0,160}border-color:\s*var\(--selection-panel-button-border\);[\s\S]{0,80}box-shadow:\s*none;/.test(selectionPanelSource) &&
      /\.action-btn:not\(\.bar-grid-cell\):hover:not\(:disabled\),[\s\S]{0,180}\.action-btn:not\(\.bar-grid-cell\):focus-visible:not\(:disabled\) \{[\s\S]{0,220}transform:\s*scale\(1\.035\);[\s\S]{0,60}z-index:\s*1;/.test(selectionPanelSource) &&
      /\.action-btn:not\(\.bar-grid-cell\):hover:not\(:disabled\)::before,[\s\S]{0,520}\.action-btn:not\(\.bar-grid-cell\):focus-visible:not\(:disabled\)::after \{\s*opacity:\s*1;/.test(selectionPanelSource),
    'BAR order command hover must keep neutral button chrome, apply cellHoverZoom=1.035 immediately, and draw gui_ordermenu.lua-style white gloss overlays instead of prototype command-colored borders/tweening',
  );
  assertContract(
    /\.options-panel\.bar-hotkey-preset \.bar-order-state\.active \{\s*background:\s*var\(--selection-panel-button-bg\);\s*border-color:\s*var\(--selection-panel-button-border\);\s*box-shadow:\s*none;\s*\}/.test(selectionPanelSource),
    'BAR state command buttons must keep neutral chrome and show current state through state lights rather than prototype active-button glow',
  );
  assertContract(
    !/class="action-btn bar-order-state"[\s\S]{0,240}:style="\{ '--btn-color': BUTTON_COLORS\.(?:wait|fireControl|guard|buildingActive) \}"/.test(selectionPanelSource),
    'BAR state command buttons must not directly reuse Wait, Fire, Guard, or On/Off command colors',
  );
  assertContract(
    /class="action-btn bar-order-state"[\s\S]{0,240}:style="\{ '--btn-color': barStateButtonColor\(BUTTON_COLORS\.fireControl\) \}"/.test(selectionPanelSource) &&
      /class="action-btn bar-order-state"[\s\S]{0,240}:style="\{ '--btn-color': barStateButtonColor\(BUTTON_COLORS\.buildingActive\) \}"/.test(selectionPanelSource),
    'fire/trajectory and on/off state buttons must route through the BAR neutral state-color helper',
  );
  assertContract(
    /const showFactoryQueueModeButton = computed\(\(\) => props\.selection\.hasFactory\);/.test(selectionPanelSource) &&
      /'factory\.queueMode': 'Queue: Build each queued unit once\\nQuota: Maintain a minimum quota of each unit on the battlefield',/.test(selectionPanelSource),
    'BAR presets must show the factory Queue/Quota state button because unit_factory_quota.lua inserts the factoryqueuemode ICON_MODE command on factories',
  );
  assertContract(
    /:disabled="!isBarHotkeyPreset && !hasFactoryProduction"/.test(selectionPanelSource),
    'BAR factory Clear Queue/Stop Production button must stay enabled because cmd_factory_stop_production.lua inserts a non-disabled command descriptor',
  );
  assertContract(
    /:title="actionTitle\(repeatStateLabel\(selection\.isRepeatQueue\), 'command\.repeat'\)"/.test(selectionPanelSource) &&
      /:title="actionTitle\(repeatStateLabel\(selection\.factoryRepeatsProduction === true\), 'command\.repeat'\)"/.test(selectionPanelSource),
    'BAR Repeat state button browser titles must use interface.json Repeat On/Repeat Off state text rather than local queue wording',
  );
  assertContract(
    /const showFactoryGuardButton = computed\(\(\) =>\s*isBarHotkeyPreset\.value && props\.selection\.hasFactoryGuardControl,\s*\);/.test(selectionPanelSource) &&
    /function factoryGuardStateLabel\(active: boolean\): string \{\s*return isBarHotkeyPreset\.value \? 'Factory Guard' : active \? 'Factory guard on' : 'Factory guard off';\s*\}/.test(selectionPanelSource) &&
      /:title="actionTitle\(factoryGuardStateLabel\(selection\.factoryGuardTargetId === selection\.factoryId\), 'command\.factoryGuard'\)"/.test(selectionPanelSource) &&
      /<span class="btn-label">\{\{ barOrderLabel\('Factory Guard', 'Guard'\) \}\}<\/span>/.test(selectionPanelSource),
    'BAR Factory Guard state button must be BAR-preset gated and use interface.json factoryguard label and factoryguard_tooltip text rather than prototype on/off wording',
  );
  assertContract(
    /const showFactoryAirIdleButton = computed\(\(\) =>\s*isBarHotkeyPreset\.value && props\.selection\.hasFactoryAirIdleControl,\s*\);/.test(selectionPanelSource) &&
      /function factoryAirIdleStateLabel\(airIdleState: SelectionInfo\['factoryAirIdleState'\]\): string \{\s*return airIdleState === 'fly' \? 'Fly' : 'Land';\s*\}/.test(selectionPanelSource) &&
      /:title="actionTitle\(factoryAirIdleStateLabel\(selection\.factoryAirIdleState\), 'factory\.airIdleState', 'Sets what aircraft do when leaving air factory'\)"/.test(selectionPanelSource) &&
      /@click="actions\.setFactoryAirIdleState\(selection\.factoryId!, nextFactoryAirIdleState\(selection\.factoryAirIdleState\)\)"/.test(selectionPanelSource),
    'BAR air-plant LandAt state button must mirror unit_air_plants.lua Fly/Land labels and aplandat_tooltip text',
  );
  assertContract(
    /v-if="showFactoryQueueModeButton"/.test(selectionPanelSource),
    'the factory Queue/Quota order button must remain controlled by showFactoryQueueModeButton',
  );
  assertContract(
    /function factoryProductionCellTitle\(option: FactoryGridOption\)/.test(selectionPanelSource) &&
      /const queueModeKey = hotkey\('factory\.queueMode'\);/.test(selectionPanelSource) &&
      /const queueModeHint = queueModeKey === '' \? '' : `; \$\{queueModeKey\} toggles quota mode`;/.test(selectionPanelSource) &&
      /:title="factoryProductionCellTitle\(uo\)"/.test(selectionPanelSource),
    'BAR factory production cell tooltip must derive the quota-mode key from the active preset',
  );
  assertContract(
    !selectionPanelSource.includes('Alt+G toggles quota mode'),
    'factory production cells must not hardcode Alt+G because BAR 60% presets leave factoryqueuemode unbound',
  );
  assertContract(
    /const barFactoryPresetTitle = computed\(\(\) =>[\s\S]{0,140}props\.selection\.details\.find\(\(detail\) => detail\.label === 'Name'\)\?\.value \?\? 'Factory'/.test(selectionPanelSource) &&
      /<span class="bar-factory-preset-title-thumb" aria-hidden="true">[\s\S]{0,220}structureThumbnailSrc\('towerFabricator'\)[\s\S]{0,220}<span class="bar-factory-preset-title-main">\{\{ barFactoryPresetTitle \}\}<\/span>/.test(selectionPanelSource) &&
      /--bar-factory-preset-width:\s*round\(nearest,\s*31\.0416667vh,\s*1px\);/.test(selectionPanelSource) &&
      /--bar-factory-preset-row-height:\s*round\(nearest,\s*4\.1666667vh,\s*1px\);/.test(selectionPanelSource) &&
      /--bar-factory-preset-title-height:\s*round\(nearest,\s*5\.2083333vh,\s*1px\);/.test(selectionPanelSource) &&
      /--bar-factory-preset-icon-border:\s*round\(nearest,\s*0\.3125vh,\s*1px\);/.test(selectionPanelSource) &&
      /--bar-factory-preset-group-label-margin:\s*round\(nearest,\s*3\.125vh,\s*1px\);/.test(selectionPanelSource) &&
      /\.bar-factory-preset-title \{[\s\S]{0,160}grid-template-columns:\s*var\(--bar-factory-preset-title-height\) minmax\(0,\s*1fr\);[\s\S]{0,120}height:\s*var\(--bar-factory-preset-title-height\);/.test(selectionPanelSource) &&
      /\.bar-factory-preset-row \{[\s\S]{0,120}grid-template-columns:\s*var\(--bar-factory-preset-group-label-margin\) minmax\(0,\s*1fr\);[\s\S]{0,120}height:\s*var\(--bar-factory-preset-row-height\);[\s\S]{0,80}padding:\s*0;/.test(selectionPanelSource) &&
      /\.bar-factory-preset-row \+ \.bar-factory-preset-row \{\s*margin-top:\s*0;/.test(selectionPanelSource) &&
      !selectionPanelSource.includes('bar-factory-preset-title-sub') &&
      !selectionPanelSource.includes('Factory Presets'),
    'BAR factory preset overlay must mirror cmd_factoryqmanager.lua scaled 298/50/40 geometry, factory title/icon header, and contiguous rows instead of the local generic preset card',
  );
  assertContract(
    /\.bar-factory-preset-row\.repeat \.bar-factory-preset-number \{\s*color:\s*rgb\(0,\s*255,\s*0\);/.test(selectionPanelSource) &&
      /\.bar-factory-preset-row\.queue \.bar-factory-preset-number \{\s*color:\s*rgb\(255,\s*255,\s*255\);/.test(selectionPanelSource) &&
      /\.bar-factory-preset-thumb-img \{[\s\S]{0,100}filter:\s*brightness\(0\.8\);/.test(selectionPanelSource),
    'BAR factory preset rows must mirror cmd_factoryqmanager.lua repeat/queue label colors and 0.8 thumbnail brightness',
  );
  assertContract(
    /function queueFactoryUnitFromClick\(factoryId: number, unitBlueprintId: string, event: MouseEvent\): void \{[\s\S]{0,260}if \(props\.selection\.factoryQueueMode && !event\.altKey\) \{[\s\S]{0,120}changeFactoryUnitQuota/.test(selectionPanelSource) &&
      /function removeFactoryQueuedUnitFromCell\(factoryId: number, unitBlueprintId: string, event: MouseEvent\): void \{[\s\S]{0,260}if \(props\.selection\.factoryQueueMode && !event\.altKey && factoryQuotaTarget\(unitBlueprintId\) > 0\) \{[\s\S]{0,120}changeFactoryUnitQuota/.test(selectionPanelSource) &&
      !/factoryQueueMode && !event\.altKey && !event\.metaKey/.test(selectionPanelSource),
    'BAR factory production-cell clicks must follow gui_gridmenu.lua quota-mode bypass semantics: Alt bypasses quota mode, Meta does not',
  );
  assertContract(
    /function queueFactoryUnitFromClick[\s\S]{0,900}if \(event\.altKey && !productionMode\.repeat && queueLengthBeforeAdd > 0\) \{\s*props\.actions\.editFactoryQueue\(factoryId, 'move', queueLengthBeforeAdd, productionMode\.count, 0\);/.test(selectionPanelSource),
    'BAR Alt factory clicks must compose queueUnit + editFactoryQueue move-to-front like gui_gridmenu.lua alt insert',
  );
  assertContract(
    /const showAttackCommand = computed\(\(\) =>\s*isBarHotkeyPreset\.value \? props\.selection\.hasBarAttackControl : props\.selection\.unitCount > 0,\s*\);/.test(selectionPanelSource),
    'BAR presets must show Attack only for selections with a BAR-equivalent weapon command',
  );
  assertContract(
    /<button\s+v-if="showAttackCommand"[\s\S]{0,500}combat\.attack/.test(selectionPanelSource),
    'the Attack order button must be gated by showAttackCommand',
  );
  assertContract(
    !/<button\s+v-if="showAttackCommand"[\s\S]{0,500}Select all units/.test(selectionPanelSource),
    'selection utility buttons must not be hidden behind the Attack capability',
  );
  assertContract(
    !/<button\s+v-if="showAttackAreaCommand"[\s\S]{0,500}Select all units/.test(selectionPanelSource),
    'selection utility buttons must not be hidden behind the Area Attack capability',
  );
  assertContract(
    /<button\s+v-if="showAttackAreaCommand"[\s\S]{0,500}combat\.attackArea/.test(selectionPanelSource),
    'the Area Attack order button must be gated by the BAR-equivalent Area Attack capability',
  );
  assertContract(
    /'combat\.restore': 'Restore an area of the map to its original height',/.test(selectionPanelSource) &&
      /v-if="selection\.hasBuilder && isBarHotkeyPreset"[\s\S]{0,260}:class="\{ active: selection\.isRestoreAreaMode \}"[\s\S]{0,260}:title="actionTitle\('Restore', 'combat\.restore'\)"[\s\S]{0,220}@click="actions\.toggleRestoreArea\(\)"/.test(selectionPanelSource),
    'BAR Restore order surface must be visible for builder selections and use interface.json restore tooltip text',
  );
  assertContract(
    /const showFormationCommands = computed\(\(\) => !isBarHotkeyPreset\.value\);/.test(selectionPanelSource),
    'BAR presets must hide the prototype-only formation assume/move buttons because BAR does not expose separate formation order-menu buttons',
  );
  assertContract(
    /const showAttackLineCommand = computed\(\(\) => !isBarHotkeyPreset\.value\);/.test(selectionPanelSource),
    'BAR presets must hide the prototype-only Attack Line button because BAR uses Fight/Area Attack order commands instead',
  );
  assertContract(
    /const showAttackGroundCommand = computed\(\(\) => !isBarHotkeyPreset\.value\);/.test(selectionPanelSource),
    'BAR presets must hide the prototype-only Attack Ground button because BAR does not expose a separate order-menu button for it',
  );
  assertContract(
    /<button\s+v-if="showFormationCommands"[\s\S]{0,500}formation\.assume/.test(selectionPanelSource) &&
      /<button\s+v-if="showFormationCommands"[\s\S]{0,500}formation\.move/.test(selectionPanelSource),
    'formation assume/move buttons must stay behind the prototype-only showFormationCommands gate',
  );
  assertContract(
    /<button\s+v-if="showAttackLineCommand"[\s\S]{0,500}combat\.attackLine/.test(selectionPanelSource),
    'the Attack Line button must stay behind the prototype-only showAttackLineCommand gate',
  );
  assertContract(
    /<button\s+v-if="showAttackGroundCommand"[\s\S]{0,500}combat\.attackGround/.test(selectionPanelSource),
    'the Attack Ground button must stay behind the prototype-only showAttackGroundCommand gate',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('g', 'KeyG', { altKey: true }), 'bar-grid', 'factory') === 'factory.queueMode',
    'BAR-grid factories must keep Alt+G factoryqueuemode even though the standalone order button is hidden',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('g', 'KeyG', { altKey: true }), 'bar-grid-60pct', 'factory') === null,
    'BAR-grid 60% factories must not inherit the full-size Alt+G factoryqueuemode shortcut',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('g', 'KeyG', { altKey: true }), 'bar-legacy', 'factory') === 'factory.queueMode',
    'BAR-legacy factories must keep Alt+G factoryqueuemode even though the standalone order button is hidden',
  );
  assertContract(
    resolveCommandHotkey(keyEvent('g', 'KeyG', { altKey: true }), 'bar-legacy-60pct', 'factory') === null,
    'BAR-legacy 60% factories must not inherit the full-size Alt+G factoryqueuemode shortcut',
  );
}
