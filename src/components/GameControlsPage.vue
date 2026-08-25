<script setup lang="ts">
/**
 * GAME CONTROLS — the controls reference, one of the app's declared
 * top-level surfaces (see src/appSurfaceMachine.ts).
 *
 * Shows every command the game answers to and the binding each hotkey
 * preset gives it, with the active preset selectable here exactly as it is
 * from the CLIENT bar in a battle — both write the same stored preset, so
 * there is one truth about which keys are live. Read-only beyond that:
 * rebinding individual keys stays with the CLIENT bar's CUSTOM preset flow.
 */
import { computed, ref } from 'vue';
import { sendAppSurface } from '../appSurfaceMachine';
import {
  COMMAND_HOTKEY_DISPLAY_LABELS,
  COMMAND_HOTKEY_IDS,
  COMMAND_HOTKEY_PRESET_IDS,
  commandHotkeyLabel,
  getActiveCommandHotkeyPresetId,
  setActiveCommandHotkeyPresetId,
  type CommandHotkeyId,
  type CommandHotkeyPresetId,
} from '../game/input/commandHotkeys';
import {
  COMMAND_HOTKEY_PRESET_DESCRIPTIONS,
  COMMAND_HOTKEY_PRESET_LABELS,
} from '../game/input/commandHotkeyPresentation';

const activePresetId = ref<CommandHotkeyPresetId>(getActiveCommandHotkeyPresetId());

function selectPreset(presetId: CommandHotkeyPresetId): void {
  setActiveCommandHotkeyPresetId(presetId);
  activePresetId.value = presetId;
}

/** Commands grouped by their id prefix — command.*, build.*, camera.*,
 *  ui.* — which is how the registry already names families. */
const groupedCommands = computed(() => {
  const groups = new Map<string, { id: CommandHotkeyId; label: string; binding: string }[]>();
  for (const commandId of COMMAND_HOTKEY_IDS) {
    const family = commandId.split('.')[0];
    const rows = groups.get(family) ?? [];
    rows.push({
      id: commandId,
      label: COMMAND_HOTKEY_DISPLAY_LABELS[commandId],
      binding: commandHotkeyLabel(commandId, activePresetId.value),
    });
    groups.set(family, rows);
  }
  return [...groups.entries()].map(([family, rows]) => ({ family, rows }));
});

const FAMILY_TITLES: Record<string, string> = {
  command: 'Unit Commands',
  build: 'Build Menu',
  factory: 'Factory',
  camera: 'Camera',
  ui: 'Interface',
};

function familyTitle(family: string): string {
  return FAMILY_TITLES[family] ?? family;
}

function openHome(): void {
  sendAppSurface('openHome');
}

function openEntityLab(): void {
  sendAppSurface('openEntityLab');
}

function openGameInfo(): void {
  sendAppSurface('openGameInfo');
}
</script>

<template>
  <div class="game-controls-page">
    <div class="game-controls-shell">
      <div class="game-controls-header">
        <div>
          <h2>Game Controls</h2>
          <p>{{ COMMAND_HOTKEY_PRESET_DESCRIPTIONS[activePresetId] }}</p>
        </div>
        <nav class="mode-nav" aria-label="App modes">
          <button @click="openHome">Home</button>
          <button @click="openEntityLab">Entity Lab</button>
          <button class="active" aria-current="page">Game Controls</button>
          <button @click="openGameInfo">Game Info</button>
          <!-- No "Game Room" here on purpose: a match needs a host or a
               code, and this screen has neither. The road runs through
               home, and the surface machine declares no other edge. -->
        </nav>
      </div>

      <div class="preset-row" role="group" aria-label="Hotkey preset">
        <span class="preset-title">PRESET</span>
        <button
          v-for="presetId in COMMAND_HOTKEY_PRESET_IDS"
          :key="presetId"
          :class="{ active: presetId === activePresetId }"
          :title="`Use ${COMMAND_HOTKEY_PRESET_DESCRIPTIONS[presetId]} command hotkeys`"
          @click="selectPreset(presetId)"
        >{{ COMMAND_HOTKEY_PRESET_LABELS[presetId] }}</button>
      </div>

      <div class="controls-body">
        <section v-for="group in groupedCommands" :key="group.family" class="controls-section">
          <h3>{{ familyTitle(group.family) }}</h3>
          <table>
            <tbody>
              <tr v-for="row in group.rows" :key="row.id">
                <td class="control-label">{{ row.label }}</td>
                <td class="control-binding">
                  <span v-if="row.binding !== ''" class="key">{{ row.binding }}</span>
                  <span v-else class="unbound">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.game-controls-page {
  width: 100%;
  height: 100%;
  display: flex;
  box-sizing: border-box;
  background: #040609;
  color: #dce6ee;
  font-family: monospace;
}

.game-controls-shell {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: rgba(11, 15, 18, 0.98);
}

.game-controls-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
  border-bottom: 1px solid rgba(180, 199, 209, 0.2);
  background: rgba(18, 24, 27, 0.98);
}

.game-controls-header h2 {
  margin: 0;
  font-size: 17px;
  color: #edf4f7;
}

.game-controls-header p {
  margin: 0;
  font-size: 11px;
  color: #93a7b3;
}

.mode-nav {
  display: flex;
  gap: 6px;
}

.mode-nav button {
  background: rgba(32, 42, 48, 0.9);
  border: 1px solid rgba(180, 199, 209, 0.25);
  color: #c8d6de;
  font-family: monospace;
  font-size: 12px;
  padding: 6px 12px;
  cursor: pointer;
}

.mode-nav button:hover {
  background: rgba(52, 66, 74, 0.9);
}

.mode-nav button.active {
  background: rgba(84, 128, 150, 0.55);
  color: #f0f7fa;
  cursor: default;
}

.preset-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  border-bottom: 1px solid rgba(180, 199, 209, 0.15);
}

.preset-title {
  font-size: 11px;
  color: #93a7b3;
  margin-right: 6px;
}

.preset-row button {
  background: rgba(32, 42, 48, 0.9);
  border: 1px solid rgba(180, 199, 209, 0.25);
  color: #c8d6de;
  font-family: monospace;
  font-size: 11px;
  padding: 4px 10px;
  cursor: pointer;
}

.preset-row button:hover {
  background: rgba(52, 66, 74, 0.9);
}

.preset-row button.active {
  background: rgba(84, 128, 150, 0.55);
  color: #f0f7fa;
}

.controls-body {
  flex: 1;
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px;
  padding: 16px;
  align-content: start;
}

.controls-section h3 {
  margin: 0 0 8px;
  font-size: 13px;
  color: #a9c3d1;
  border-bottom: 1px solid rgba(180, 199, 209, 0.15);
  padding-bottom: 4px;
}

.controls-section table {
  width: 100%;
  border-collapse: collapse;
}

.controls-section td {
  padding: 3px 4px;
  font-size: 12px;
  vertical-align: top;
}

.control-label {
  color: #c8d6de;
}

.control-binding {
  text-align: right;
  white-space: nowrap;
}

.key {
  display: inline-block;
  background: rgba(52, 66, 74, 0.9);
  border: 1px solid rgba(180, 199, 209, 0.3);
  border-radius: 3px;
  padding: 1px 6px;
  font-size: 11px;
  color: #edf4f7;
}

.unbound {
  color: #5c6b74;
}
</style>
