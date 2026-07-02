import selectionPanelSource from './SelectionPanel.vue?raw';
import { COLORS, WAYPOINT_COLOR_CSS } from '../colorsConfig';
import { resolveCommandHotkey } from '../game/input/commandHotkeys';
import { BAR_MAX_SELECTED_BUILDER_TYPES } from '../game/sim/builderBuildRoster';
import builderBuildRosterSource from '../game/sim/builderBuildRoster.ts?raw';
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
  assertContract(
    COLORS.ui.selectionPanel.cost.resource === '#f5f5f5' &&
      COLORS.ui.selectionPanel.cost.energy === '#ffff00',
    'BAR build/production grid prices must use gui_gridmenu.lua normal metal #f5f5f5 and energy #ffff00 colors',
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
    /const BAR_ORDER_TOOLTIP_BY_COMMAND_ID: Partial<Record<CommandHotkeyId, string>> = \{[\s\S]{0,400}'combat\.attackArea': 'Area attack everything within a circle \(click-drag\)',/.test(selectionPanelSource) &&
      /'command\.wait': 'Pause a unit\/factory on processing command\/build queues',/.test(selectionPanelSource) &&
      /'combat\.reclaim': 'Suck metal\/energy from wrecks or features \(trees\/stones\)',/.test(selectionPanelSource) &&
      /'factory\.stopProduction': 'Clear build queue and quotas for all units on selected factories',/.test(selectionPanelSource) &&
      /'factory\.queueMode': 'Queue: Build each queued unit once\\nQuota: Maintain a minimum quota of each unit on the battlefield',/.test(selectionPanelSource) &&
      /'combat\.towerTargetSet': 'Set a prioritized target \(prioritizes targeting when target in range\) ',/.test(selectionPanelSource) &&
      /'command\.morph': 'Upgrade to next Tech-level \(second click to cancel\)',/.test(selectionPanelSource),
    'BAR order button browser titles must use Beyond-All-Reason language/en/interface.json ui.orderMenu tooltip strings for analogous commands',
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
    /--bar-grid-queue-font-size:\s*calc\(var\(--bar-grid-cell-inner-size\) \* 0\.29\);/.test(selectionPanelSource) &&
      /--bar-grid-queue-badge-height:\s*calc\(var\(--bar-grid-cell-inner-size\) \* 0\.365\);/.test(selectionPanelSource) &&
      /--bar-grid-queue-text-padding:\s*calc\(var\(--bar-grid-cell-inner-size\) \* 0\.1\);/.test(selectionPanelSource) &&
      /--bar-grid-queue-corner-size:\s*calc\(var\(--bar-grid-corner-size\) \* 3\.3\);/.test(selectionPanelSource) &&
      /\.bar-cell-queue-count,[\s\S]{0,220}left:\s*0;[\s\S]{0,180}height:\s*var\(--bar-grid-queue-badge-height\);[\s\S]{0,180}font-size:\s*var\(--bar-grid-queue-font-size\);/.test(selectionPanelSource) &&
      /\.bar-cell-queue-count \{\s*top:\s*calc\(var\(--bar-grid-cell-padding\) \+ var\(--bar-grid-icon-padding\)\);\s*border-radius:\s*0 0 var\(--bar-grid-queue-corner-size\) 0;\s*color:\s*rgb\(190,\s*255,\s*190\);/.test(selectionPanelSource) &&
      /\.bar-cell-quota-count \{\s*bottom:\s*calc\(var\(--bar-grid-cell-padding\) \+ var\(--bar-grid-icon-padding\)\);\s*border-radius:\s*0 var\(--bar-grid-queue-corner-size\) 0 0;\s*color:\s*rgb\(255,\s*130,\s*190\);/.test(selectionPanelSource),
    'BAR factory build-cell queue/quota badges must use gui_gridmenu.lua cellInnerSize*0.29 font, 0.365 badge height, left-edge anchoring, and one-corner chamfer',
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
    /\.bar-grid-cell\.active \.btn-thumb::before \{\s*background:\s*rgba\(255,\s*217,\s*51,\s*0\.25\);[\s\S]{0,80}mix-blend-mode:\s*screen;/.test(selectionPanelSource),
    'BAR selected build/production cells must use gui_gridmenu.lua selectedCellColor yellow icon overlay instead of prototype button glow',
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
      /\.bar-grid-cell\.factory-under-construction:not\(:hover\):not\(:focus-visible\) \.btn-thumb-img \{\s*filter:\s*brightness\(0\.77\);/.test(selectionPanelSource) &&
      /\.bar-grid-cell\.factory-under-construction:not\(:hover\):not\(:focus-visible\) \.bar-cell-group-icon \{\s*filter:\s*brightness\(0\.63\) drop-shadow/.test(selectionPanelSource) &&
      /\.bar-grid-under-construction \{[\s\S]{0,220}color:\s*rgb\(255,\s*200,\s*50\);[\s\S]{0,120}font-size:\s*calc\(var\(--bar-grid-page-font-size\) \* 1\.1\);/.test(selectionPanelSource),
    'BAR incomplete selected factories must dim production cells and draw the gui_gridmenu.lua Under Construction footer warning',
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
    /v-else-if="showBuildGridPager"[\s\S]{0,260}:title="pageActionTitle\('Next build page'\)"[\s\S]{0,260}<span v-if="barGridNextPageHotkey" class="bar-category-key">\{\{ barGridNextPageHotkey \}\}<\/span>/.test(selectionPanelSource),
    'BAR page-only build grid pager must still draw nextPageRect hotkey like gui_gridmenu.lua drawPageButtons',
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
      /\.bar-builder-type-btn:hover \.bar-builder-thumb-img,[\s\S]{0,100}filter:\s*brightness\(0\.75\);[\s\S]{0,80}transform:\s*scale\(2\.2\);/.test(selectionPanelSource),
    'BAR builder selector must mirror gui_gridmenu.lua drawBuilder inactive 0.5 lightness, active 1.0 lightness, and hover zoom/brightness',
  );
  assertContract(
    BAR_MAX_SELECTED_BUILDER_TYPES === 5 &&
      /export const BAR_MAX_SELECTED_BUILDER_TYPES = 5;/.test(builderBuildRosterSource) &&
      /getSelectedBuilderTypeInfos\(selectedUnits\)\.slice\(0, BAR_MAX_SELECTED_BUILDER_TYPES\)/.test(builderBuildRosterSource),
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
      /left:\s*calc\(var\(--bar-order-panel-width\) \+ var\(--bar-flow-element-margin\)\);/.test(selectionPanelSource),
    'BAR order menu dimensions, side offset, and padding must follow gui_ordermenu.lua plus FlowUI elementMargin=0.0045*vsy and elementPadding=0.003*vsy',
  );
  assertContract(
    /--bar-grid-cell-size:\s*calc\(\(37\.825vh - \(var\(--bar-grid-bg-padding\) \* 2\)\) \/ 4\);/.test(selectionPanelSource) &&
      !/--bar-grid-cell-size:\s*clamp\(72px,\s*9\.45vh,\s*108px\);/.test(selectionPanelSource),
    'BAR build grid cells must mirror gui_gridmenu.lua side-mode width-derived cell size instead of the old capped 108px prototype size',
  );
  assertContract(
      /--bar-grid-cell-padding:\s*max\(1px,\s*calc\(var\(--bar-grid-cell-size\) \* 0\.007\)\);/.test(selectionPanelSource) &&
      /--bar-grid-icon-padding:\s*max\(1px,\s*calc\(var\(--bar-grid-cell-size\) \* 0\.015\)\);/.test(selectionPanelSource) &&
      /--bar-grid-corner-size:\s*calc\(var\(--bar-grid-cell-size\) \* 0\.025\);/.test(selectionPanelSource) &&
      /--bar-grid-progress-corner-size:\s*calc\(var\(--bar-grid-cell-size\) \* 0\.03\);/.test(selectionPanelSource) &&
      /--bar-grid-cell-inner-size:\s*calc\(var\(--bar-grid-cell-size\) - \(var\(--bar-grid-cell-padding\) \* 2\)\);/.test(selectionPanelSource) &&
      /--bar-grid-price-font-size:\s*calc\(var\(--bar-grid-cell-inner-size\) \* 0\.16\);/.test(selectionPanelSource) &&
      /--bar-grid-key-font-size:\s*calc\(var\(--bar-grid-price-font-size\) \* 1\.1\);/.test(selectionPanelSource) &&
      !/--bar-grid-cell-padding:\s*1px;/.test(selectionPanelSource) &&
      !/--bar-grid-icon-padding:\s*2px;/.test(selectionPanelSource) &&
      !/--bar-grid-price-font-size:\s*1\.5vh;/.test(selectionPanelSource),
    'BAR build grid padding, icon padding, corners, price font, and hotkey font must derive from gui_gridmenu.lua cellSize/cellInnerSize formulas',
  );
  assertContract(
    /\.bar-grid-cell \.btn-cost \{[\s\S]{0,180}right:\s*calc\(var\(--bar-grid-cell-padding\) \+ \(var\(--bar-grid-cell-inner-size\) \* 0\.048\)\);[\s\S]{0,140}bottom:\s*calc\(var\(--bar-grid-cell-padding\) \+ \(var\(--bar-grid-price-font-size\) \* 0\.35\)\);/.test(selectionPanelSource) &&
      /\.bar-grid-cell > \.btn-key\.bar-cell-key \{[\s\S]{0,120}right:\s*calc\(var\(--bar-grid-cell-padding\) \+ \(var\(--bar-grid-cell-inner-size\) \* 0\.048\)\);/.test(selectionPanelSource),
    'BAR build grid price and hotkey text must use gui_gridmenu.lua cellPadding + cellInnerSize*0.048 right offset and price baseline spacing',
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
      /--bar-grid-category-button-height:\s*calc\(var\(--bar-grid-category-font-size\) \* 2\.3 \* 1\.4\);/.test(selectionPanelSource) &&
      /--bar-grid-button-padding:\s*max\(1px,\s*calc\(var\(--bar-grid-bg-padding\) \* 0\.52\)\);/.test(selectionPanelSource) &&
      /--bar-grid-active-area-margin:\s*calc\(var\(--bar-grid-bg-padding\) \* 0\.1\);/.test(selectionPanelSource) &&
      /--bar-grid-category-rect-height:\s*calc\(var\(--bar-grid-category-button-height\) - var\(--bar-grid-active-area-margin\) - \(var\(--bar-grid-button-padding\) \* 2\)\);/.test(selectionPanelSource) &&
      /--bar-grid-footer-button-height:\s*calc\(var\(--bar-grid-category-button-height\) - \(var\(--bar-grid-button-padding\) \* 2\)\);/.test(selectionPanelSource) &&
      /\.bar-grid-category-btn,[\s\S]{0,80}\.bar-grid-footer-btn \{[\s\S]{0,180}height:\s*var\(--bar-grid-category-button-height\);[\s\S]{0,260}font-size:\s*var\(--bar-grid-category-font-size\);/.test(selectionPanelSource) &&
      /\.bar-grid-footer:not\(\.category-active\):not\(\.page-only\) \.bar-grid-category-btn \{[\s\S]{0,120}height:\s*var\(--bar-grid-category-rect-height\);[\s\S]{0,80}margin-top:\s*var\(--bar-grid-button-padding\);/.test(selectionPanelSource) &&
      /\.bar-grid-footer\.category-active \.bar-grid-current-category \{\s*height:\s*var\(--bar-grid-category-rect-height\);/.test(selectionPanelSource) &&
      /\.bar-grid-footer\.category-active \.bar-grid-back-btn,[\s\S]{0,120}\.bar-grid-footer\.page-only \.bar-grid-next-page-btn \{\s*height:\s*var\(--bar-grid-footer-button-height\);/.test(selectionPanelSource) &&
      /\.bar-category-key \{[\s\S]{0,220}font-size:\s*var\(--bar-grid-hotkey-font-size\);/.test(selectionPanelSource) &&
      !/height:\s*4\.2vh;/.test(selectionPanelSource) &&
      !/font-size:\s*1\.35vh;/.test(selectionPanelSource),
    'BAR grid category/footer labels, hotkeys, button heights, and padded rects must derive from gui_gridmenu.lua categoryFontSize/pageFontSize/hotkeyFontSize/setupCategoryRects formulas instead of fixed approximations',
  );
  assertContract(
    /--bar-builder-button-size:\s*calc\(var\(--bar-grid-category-font-size\) \* 2\.3 \* 2\);/.test(selectionPanelSource) &&
      /\.bar-builder-type-btn \{[\s\S]{0,160}width:\s*var\(--bar-builder-button-size\);\s*height:\s*var\(--bar-builder-button-size\);/.test(selectionPanelSource) &&
      /\.bar-builder-strip \{[\s\S]{0,120}bottom:\s*100%;[\s\S]{0,120}gap:\s*var\(--bar-grid-bg-padding\);/.test(selectionPanelSource) &&
      /\.bar-builder-type-list \{[\s\S]{0,160}gap:\s*calc\(var\(--bar-grid-bg-padding\) \* 1\.5\);[\s\S]{0,260}background:\s*rgba\(5,\s*7,\s*10,\s*0\.88\);/.test(selectionPanelSource),
    'BAR builder selector icons must use gui_gridmenu.lua builderButtonSize=pre-side-categoryButtonHeight*2 and bgpadding+iconMargin spacing',
  );
  assertContract(
    /<span class="bar-builder-cycle-label">›<\/span>/.test(selectionPanelSource) &&
      /--bar-builder-next-height:\s*calc\(var\(--bar-builder-button-size\) \* 0\.6\);/.test(selectionPanelSource) &&
      /--bar-builder-next-width:\s*calc\(\(var\(--bar-builder-button-size\) \* 0\.45\) \+ \(var\(--bar-grid-bg-padding\) \* 2\) \+ 1ch\);/.test(selectionPanelSource) &&
      /\.bar-builder-cycle-btn \{[\s\S]{0,220}margin-left:\s*0;/.test(selectionPanelSource) &&
      /\.bar-builder-cycle-label \{[\s\S]{0,160}left:\s*calc\(var\(--bar-builder-next-height\) \* 0\.2\);/.test(selectionPanelSource),
    'BAR next-builder button must mirror gui_gridmenu.lua nextBuilderRect glyph, 0.6*builder height, 0.45*builder width, and bgpadding spacing',
  );
  assertContract(
    /--bar-order-active-height:\s*calc\(var\(--bar-order-panel-height\) - var\(--bar-order-active-padding\) - var\(--bar-order-bottom-active-padding\)\);/.test(selectionPanelSource) &&
      /--bar-order-state-light-height:\s*calc\(\(var\(--bar-order-active-height\) \/ var\(--bar-order-rows\)\) \* 0\.14\);/.test(selectionPanelSource) &&
      /height:\s*var\(--bar-order-state-light-height\);/.test(selectionPanelSource) &&
      /bottom:\s*var\(--bar-order-button-padding\);/.test(selectionPanelSource),
    'BAR state lights must derive their height and bottom inset from gui_ordermenu.lua active rect and state padding placement',
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
      /'--bar-order-cell-margin-primary': barOrderCellMarginPrimary\.value,/.test(selectionPanelSource) &&
      /'--bar-order-cell-margin-secondary': barOrderCellMarginSecondary\.value,/.test(selectionPanelSource) &&
      !/--bar-order-cell-margin:\s*clamp\(1px,\s*0\.28vh,\s*3px\);/.test(selectionPanelSource),
    'BAR order cells must use gui_ordermenu.lua dynamic cellMarginPx/cellMarginPx2 formulas instead of a fixed viewport clamp',
  );
  assertContract(
    /--bar-order-active-width:\s*calc\(var\(--bar-order-panel-width\) - \(var\(--bar-order-active-padding\) \* 2\)\);/.test(selectionPanelSource) &&
      /--bar-order-cell-width:\s*calc\(var\(--bar-order-active-width\) \/ var\(--bar-order-columns\)\);/.test(selectionPanelSource) &&
      /--bar-order-cell-inner-width:\s*calc\(var\(--bar-order-cell-width\) - var\(--bar-order-cell-margin-primary\) - var\(--bar-order-cell-margin-secondary\)\);/.test(selectionPanelSource) &&
      /--bar-order-label-max-size:\s*calc\(var\(--bar-order-cell-inner-width\) \/ 7\);/.test(selectionPanelSource) &&
      /font-size:\s*min\(var\(--bar-order-font-size\),\s*var\(--bar-order-label-max-size\)\);/.test(selectionPanelSource) &&
      !/font-size:\s*min\(var\(--bar-order-font-size\),\s*7px\);/.test(selectionPanelSource),
    'BAR order command labels must cap from gui_ordermenu.lua cellInnerWidth/7 rather than a fixed 7px local cap',
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
    /<button[\s\S]{0,240}:disabled="!hasFactoryProduction"[\s\S]{0,240}:style="\{ '--btn-color': factoryStopProductionButtonColor\(\) \}"/.test(selectionPanelSource),
    'the factory Clear Queue button must route through the BAR neutral/prototype red color helper',
  );
  assertContract(
    /\.options-panel\.bar-hotkey-preset[\s\S]{0,260}\.action-btn\.active:not\(\.bar-grid-cell\):not\(\.bar-order-state\)[\s\S]{0,260}background:\s*linear-gradient\(to top,\s*rgba\(168,\s*168,\s*168,\s*0\.9\),\s*rgba\(255,\s*255,\s*255,\s*0\.9\)\);[\s\S]{0,180}color:\s*rgb\(20,\s*20,\s*20\);[\s\S]{0,120}box-shadow:\s*none;/.test(selectionPanelSource),
    'BAR active order commands must use gui_ordermenu.lua light active button fill with dark text instead of the prototype colored glow',
  );
  assertContract(
    /--bar-order-hover-top-alpha:\s*0\.28;/.test(selectionPanelSource) &&
      /--bar-order-hover-bottom-alpha:\s*0\.095;/.test(selectionPanelSource) &&
      /--bar-order-hover-top-alpha:\s*0\.112;/.test(selectionPanelSource) &&
      /\.action-btn:not\(\.bar-grid-cell\)::before,[\s\S]{0,180}\.action-btn:not\(\.bar-grid-cell\)::after \{[\s\S]{0,220}opacity:\s*0;[\s\S]{0,80}pointer-events:\s*none;/.test(selectionPanelSource) &&
      /\.action-btn:not\(\.bar-grid-cell\):hover:not\(:disabled\),[\s\S]{0,180}\.action-btn:not\(\.bar-grid-cell\):focus-visible:not\(:disabled\) \{[\s\S]{0,160}border-color:\s*var\(--selection-panel-button-border\);[\s\S]{0,80}box-shadow:\s*none;/.test(selectionPanelSource) &&
      /\.action-btn:not\(\.bar-grid-cell\):hover:not\(:disabled\)::before,[\s\S]{0,520}\.action-btn:not\(\.bar-grid-cell\):focus-visible:not\(:disabled\)::after \{\s*opacity:\s*1;/.test(selectionPanelSource),
    'BAR order command hover must keep neutral button chrome and draw gui_ordermenu.lua-style white gloss overlays instead of prototype command-colored borders',
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
    /const showFactoryQueueModeButton = computed\(\(\) =>\s*showPrototypeOnlyCommandButtons\.value\s*&&\s*props\.selection\.hasFactory,\s*\);/.test(selectionPanelSource),
    'BAR presets must hide the standalone factory Queue/Quota order button because BAR exposes factoryqueuemode as a hotkey and build-cell quota behavior, not as an order-menu button',
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
    !selectionPanelSource.includes('combat.restore') &&
      !selectionPanelSource.includes('showRestoreButton') &&
      !selectionPanelSource.includes('toggleRestoreArea'),
    'the Restore order surface must stay deleted — terrain never deforms, so no dead Restore button/hotkey may exist',
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
