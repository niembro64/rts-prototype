<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { PLAYER_COLORS, getPlayerColors, setPlayerCountForColors, type PlayerId } from '../game/sim/types';
import { BATTLE_CONFIG } from '../battleBarConfig';
import { BAR_THEMES, barVars } from '../barThemes';
import CommanderAvatar from './CommanderAvatar.vue';
import BarButtonGroup from './BarButtonGroup.vue';
import BarButton from './BarButton.vue';
import { getUnitBlueprint } from '../game/sim/blueprints';
import type { TerrainMapShape, TerrainShape } from '@/types/terrain';

export type { LobbyPlayer } from '@/types/ui';
import type { LobbyPlayer } from '@/types/ui';

const props = defineProps<{
  visible: boolean;
  isHost: boolean;
  roomCode: string;
  players: LobbyPlayer[];
  localPlayerId: PlayerId;
  error: string | null;
  isConnecting: boolean;
  terrainCenter: TerrainShape;
  terrainDividers: TerrainShape;
  terrainMapShape: TerrainMapShape;
  unitTypes: readonly string[];
  allowedUnits: readonly string[];
  unitCap: number;
  ffAccelUnits: boolean;
  ffAccelShots: boolean;
  mirrorsEnabled: boolean;
  forceFieldsEnabled: boolean;
}>();

const emit = defineEmits<{
  (e: 'host'): void;
  (e: 'join', roomCode: string): void;
  (e: 'start'): void;
  (e: 'cancel'): void;
  (e: 'spectate'): void;
  (e: 'setTerrainCenter', shape: TerrainShape): void;
  (e: 'setTerrainDividers', shape: TerrainShape): void;
  (e: 'setTerrainMapShape', shape: TerrainMapShape): void;
  (e: 'toggleUnit', unitType: string): void;
  (e: 'toggleAllUnits'): void;
  (e: 'setUnitCap', cap: number): void;
  (e: 'setFfAccelUnits', enabled: boolean): void;
  (e: 'setFfAccelShots', enabled: boolean): void;
  (e: 'setMirrorsEnabled', enabled: boolean): void;
  (e: 'setForceFieldsEnabled', enabled: boolean): void;
  (e: 'resetDefaults'): void;
}>();

// Surface the labeled-options arrays to the template. The host
// clicks one to pick the shape; non-hosts see the same UI but the
// click handler is gated on isHost so only the host can change it.
const centerOptions = BATTLE_CONFIG.center.options;
const dividersOptions = BATTLE_CONFIG.dividers.options;
const mapShapeOptions = BATTLE_CONFIG.mapShape.options;
const capOptions = BATTLE_CONFIG.cap.options;

const allUnitsActive = computed(() =>
  props.unitTypes.every((ut) => props.allowedUnits.includes(ut)),
);

function pickTerrainCenter(shape: TerrainShape): void {
  if (!props.isHost) return;
  emit('setTerrainCenter', shape);
}

function pickTerrainDividers(shape: TerrainShape): void {
  if (!props.isHost) return;
  emit('setTerrainDividers', shape);
}

function pickTerrainMapShape(shape: TerrainMapShape): void {
  if (!props.isHost) return;
  emit('setTerrainMapShape', shape);
}

function pickToggleUnit(unitType: string): void {
  if (!props.isHost) return;
  emit('toggleUnit', unitType);
}

function pickToggleAllUnits(): void {
  if (!props.isHost) return;
  emit('toggleAllUnits');
}

function pickUnitCap(cap: number): void {
  if (!props.isHost) return;
  emit('setUnitCap', cap);
}

function pickFfAccelUnits(enabled: boolean): void {
  if (!props.isHost) return;
  emit('setFfAccelUnits', enabled);
}

function pickFfAccelShots(enabled: boolean): void {
  if (!props.isHost) return;
  emit('setFfAccelShots', enabled);
}

function pickMirrors(enabled: boolean): void {
  if (!props.isHost) return;
  emit('setMirrorsEnabled', enabled);
}

function pickForceFields(enabled: boolean): void {
  if (!props.isHost) return;
  emit('setForceFieldsEnabled', enabled);
}

function unitShortName(unitType: string): string {
  try {
    return getUnitBlueprint(unitType).shortName;
  } catch {
    return unitType.toUpperCase().slice(0, 3);
  }
}

function pickResetDefaults(): void {
  if (!props.isHost) return;
  emit('resetDefaults');
}

const isTauri = typeof window !== 'undefined' && !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;

async function exitApp(): Promise<void> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  getCurrentWindow().close();
}

const joinCode = ref('');
const codeCopied = ref(false);

async function copyCode() {
  try {
    await navigator.clipboard.writeText(props.roomCode);
    codeCopied.value = true;
    setTimeout(() => {
      codeCopied.value = false;
    }, 2000);
  } catch (err) {
    // Fallback: select the text
    const codeEl = document.querySelector('.room-code') as HTMLElement;
    if (codeEl) {
      const range = document.createRange();
      range.selectNodeContents(codeEl);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }
}

// Keep the color wheel divided by however many players are currently
// in the lobby so the colors and derived names match what the game
// scene will use when it starts (RtsScene calls setPlayerCountForColors
// with the same value). Without this the lobby uses a 6-slot wheel by
// default and the in-game colors visibly shift on launch.
watch(
  () => props.players.length,
  (n) => {
    if (n > 0) setPlayerCountForColors(n);
  },
  { immediate: true },
);

function getPlayerColor(playerId: PlayerId): string {
  const color = PLAYER_COLORS[playerId]?.primary ?? 0x888888;
  return '#' + color.toString(16).padStart(6, '0');
}

/** Display name = derived from the rendered hue, so the label next to
 *  each player's color swatch is always the actual color the player
 *  sees. The server-assigned name (from NetworkManager) is ignored.
 *  Currently unused since the lobby roster shows the avatar as the
 *  color identifier; kept for future reuse / debugging. */
function getColorName(playerId: PlayerId): string {
  return getPlayerColors(playerId).name;
}
void getColorName; // suppress "unused" while we keep the helper around

// One-Hz reactive tick that drives the "current time in player's
// timezone" cell in each row. Bumping the ref is enough — the
// `formatPlayerTime` function reads it, so Vue re-tracks the
// dependency and re-renders every row's time column once per
// second. Started on mount, cleared on unmount; only ticks while
// the lobby modal is alive.
const nowTick = ref(0);
let nowTickInterval: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  nowTickInterval = setInterval(() => { nowTick.value++; }, 1000);
});
onUnmounted(() => {
  if (nowTickInterval) clearInterval(nowTickInterval);
  nowTickInterval = null;
});

/** Render a player's CURRENT local time + short timezone label
 *  (e.g. "14:32:15 PDT"). Reads `nowTick` so Vue treats this as
 *  a reactive dependency and re-runs once a second. Returns an
 *  empty string for players whose timezone isn't known yet OR
 *  when the timezone is rejected by Intl (very rare; falls back
 *  to skipping the row's time cell rather than throwing). */
function formatPlayerTime(timezone: string | undefined): string {
  void nowTick.value; // re-track every tick
  if (!timezone) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: timezone,
      timeZoneName: 'short',
    }).format(new Date());
  } catch {
    return '';
  }
}

function handleHost() {
  emit('host');
}

function handleJoinSubmit() {
  if (joinCode.value.length >= 4) {
    emit('join', joinCode.value.toUpperCase());
  }
}

function handleStart() {
  emit('start');
}

function handleCancel() {
  joinCode.value = '';
  emit('cancel');
}

const canStart = computed(() => {
  return props.isHost && props.players.length >= 1;
});

const isInLobby = computed(() => {
  return props.roomCode !== '';
});

const canJoin = computed(() => {
  return joinCode.value.length >= 4;
});

// Lobby's CENTER / DIVIDERS pickers mirror the bottom BATTLE bar's
// CENTER / DIVIDERS pickers — same data, same component family. We
// apply the same BATTLE palette inline so the active button color
// matches the BATTLE bar exactly. Non-host viewers fall through to
// the disabled palette so the dimmed-outline state matches the
// `bar-readonly` look used by the bottom bars when host-locked.
const terrainSectionVars = computed(() =>
  barVars(props.isHost ? BAR_THEMES.battle : BAR_THEMES.disabled),
);
</script>

<template>
  <div v-if="visible" class="lobby-overlay">
    <div class="lobby-modal" :class="{ 'in-lobby': isInLobby }">
      <!-- Spectate button (hide menu to watch background battle).
           Only meaningful on the initial / connecting screens —
           inside the GAME LOBBY the demo battle is already visible
           in the preview pane. -->
      <button
        v-if="!isInLobby"
        class="spectate-btn"
        @click="emit('spectate')"
        title="Watch Battle"
      >
        ●
      </button>

      <!-- Live mini-simulation preview target. Always rendered
           whenever the modal is open (so Vue Teleport from
           GameCanvas always has a stable target DOM node), but
           only visually shown in the GAME LOBBY state via v-show.
           Putting this in a v-else-if and reactively flipping the
           Teleport disabled prop alongside the target's existence
           caused mid-frame race conditions where Vue's patcher
           hit detached vnodes (see Teleport runtime errors). -->
      <div
        id="lobby-preview-target"
        class="preview-pane"
        v-show="isInLobby"
      ></div>

      <!-- Initial screen -->
      <template v-if="!isInLobby && !isConnecting">
        <h1 class="title">BUDGET ANNIHILATION</h1>
        <p class="subtitle">Multiplayer RTS</p>

        <div class="main-actions">
          <button class="lobby-btn host-btn" @click="handleHost">Host</button>

          <div class="join-row">
            <input
              v-model="joinCode"
              class="code-input"
              type="text"
              maxlength="4"
              placeholder="CODE"
              @keyup.enter="handleJoinSubmit"
            />
            <button
              class="lobby-btn join-btn"
              :disabled="!canJoin"
              @click="handleJoinSubmit"
            >Join</button>
          </div>
        </div>

        <div v-if="error" class="error-message">{{ error }}</div>

        <div v-if="isTauri" class="footer-row">
          <button class="lobby-btn exit-btn" @click="exitApp">Exit</button>
        </div>
      </template>

      <!-- Connecting screen -->
      <template v-else-if="isConnecting">
        <h1 class="title">CONNECTING...</h1>
        <div class="connecting-spinner"></div>
        <div class="footer-row">
          <button class="lobby-btn cancel-btn" @click="handleCancel">Cancel</button>
          <button v-if="isTauri" class="lobby-btn exit-btn" @click="exitApp">Exit</button>
        </div>
      </template>

      <!-- Lobby screen — full-screen 2-column layout. The
           `.lobby-left` and `.lobby-right` divs and the preview-pane
           (always-mounted, outside the v-else-if) become direct
           children of `.lobby-modal.in-lobby`, which switches to
           CSS Grid and places each into its named area. The
           preview-pane lives in source-order at the top of the
           modal so the imperative DOM-move watcher in GameCanvas
           always has a stable target — Grid's `grid-area` lets us
           visually park it in the right column regardless. -->
      <template v-else-if="isInLobby">
        <div class="lobby-left">
          <div class="room-code-display">
            <h1 class="title">GAME LOBBY CODE:</h1>
            <div class="room-code-row" @click="copyCode">
              <span class="room-code">{{ roomCode }}</span>
              <button class="copy-btn" :class="{ copied: codeCopied }" :title="codeCopied ? 'Copied!' : 'Copy'">
                {{ codeCopied ? '✓' : '⧉' }}
              </button>
            </div>
          </div>

          <div class="players-section">
            <h2 class="players-title">Players ({{ players.length }}/6)</h2>
            <ul class="player-list">
              <li
                v-for="player in players"
                :key="player.playerId"
                class="player-item"
                :class="{ 'is-local': player.playerId === localPlayerId }"
              >
                <CommanderAvatar
                  :color="getPlayerColor(player.playerId)"
                  :size="44"
                />
                <!-- Three-line player info. The avatar's color IS
                     the per-player identifier, so the literal
                     "Red" / "Blue" name is dropped — what's
                     shown instead is what the player IS at this
                     moment: where they're connecting from
                     (location), as whom (IP), and when
                     (live time + tz). Each row reads
                     diagnostically without asking the player who
                     they are. -->
                <div class="player-info">
                  <span v-if="player.location" class="player-location">{{ player.location }}</span>
                  <span v-if="player.ipAddress" class="player-ip">{{ player.ipAddress }}</span>
                  <span
                    v-if="player.timezone"
                    class="player-time"
                  >{{ formatPlayerTime(player.timezone) }}</span>
                </div>
                <!-- Badges pinned to the right edge of the row.
                     HOST anchors top-right (default flex-column
                     position), YOU drops to bottom-right via
                     `margin-top: auto` so it always pins to the
                     bottom whether or not HOST is also present. -->
                <div
                  v-if="player.isHost || player.playerId === localPlayerId"
                  class="player-badges"
                >
                  <span v-if="player.isHost" class="host-badge">HOST</span>
                  <span v-if="player.playerId === localPlayerId" class="you-badge">YOU</span>
                </div>
              </li>
            </ul>
          </div>
        </div>

        <div class="lobby-right">
          <!-- Terrain controls use the shared button components, but
               keep lobby-specific labels in a fixed-width column
               instead of reusing the compact bottom-bar label row. -->
          <!-- Non-host: use the SAME `bar-readonly` pattern as the
               bottom BATTLE bar (pointer-events: none, cursor: default
               on every .control-btn). Avoids the per-button `:disabled`
               attribute, whose `.control-btn.active:disabled` rule
               dims the active text/bg and made the lobby's bright
               text look softer than the bottom bar's bright text.
               Host-gating still happens inside the click handlers. -->
          <div
            class="terrain-section"
            :class="{ 'bar-readonly': !isHost }"
            :style="terrainSectionVars"
          >
            <div class="terrain-control-row">
              <div class="terrain-control-label">CENTER:</div>
              <BarButtonGroup>
                <BarButton
                  v-for="opt in centerOptions"
                  :key="opt.value"
                  size="large"
                  :active="terrainCenter === opt.value"
                  :title="isHost ? `Set the central ripple to ${opt.label.toLowerCase()}` : 'Only the host can change terrain'"
                  @click="pickTerrainCenter(opt.value)"
                >{{ opt.label }}</BarButton>
              </BarButtonGroup>
            </div>
            <div class="terrain-control-row">
              <div class="terrain-control-label">DIVIDERS:</div>
              <BarButtonGroup>
                <BarButton
                  v-for="opt in dividersOptions"
                  :key="opt.value"
                  size="large"
                  :active="terrainDividers === opt.value"
                  :title="isHost ? `Set the team-separator ridges to ${opt.label.toLowerCase()}` : 'Only the host can change terrain'"
                  @click="pickTerrainDividers(opt.value)"
                >{{ opt.label }}</BarButton>
              </BarButtonGroup>
            </div>
            <div class="terrain-control-row">
              <div class="terrain-control-label">PERIMETER:</div>
              <BarButtonGroup>
                <BarButton
                  v-for="opt in mapShapeOptions"
                  :key="opt.value"
                  size="large"
                  :active="terrainMapShape === opt.value"
                  :title="isHost ? `Set the map perimeter to ${opt.label.toLowerCase()}` : 'Only the host can change terrain'"
                  @click="pickTerrainMapShape(opt.value)"
                >{{ opt.label }}</BarButton>
              </BarButtonGroup>
            </div>
            <!-- Real-battle config rows. These were previously editable
                 mid-battle on the bottom BATTLE bar; that bar is now
                 demo-only, so the lobby is the single place to set
                 them for an upcoming real game. -->
            <div class="terrain-control-row">
              <div class="terrain-control-label">UNITS:</div>
              <BarButtonGroup>
                <BarButton
                  size="large"
                  :active="allUnitsActive"
                  :title="isHost ? 'Toggle all unit types on/off' : 'Only the host can change battle settings'"
                  @click="pickToggleAllUnits"
                >ALL</BarButton>
                <BarButton
                  v-for="ut in unitTypes"
                  :key="ut"
                  size="large"
                  :active="allowedUnits.includes(ut)"
                  :title="isHost ? `Toggle ${ut}` : 'Only the host can change battle settings'"
                  @click="pickToggleUnit(ut)"
                >{{ unitShortName(ut) }}</BarButton>
              </BarButtonGroup>
            </div>
            <div class="terrain-control-row">
              <div class="terrain-control-label">CAP:</div>
              <BarButtonGroup>
                <BarButton
                  v-for="opt in capOptions"
                  :key="opt"
                  size="large"
                  :active="unitCap === opt"
                  :title="isHost ? `Max ${opt} total units` : 'Only the host can change battle settings'"
                  @click="pickUnitCap(opt)"
                >{{ opt.toLocaleString() }}</BarButton>
              </BarButtonGroup>
            </div>
            <div class="terrain-control-row">
              <div class="terrain-control-label">FF:</div>
              <BarButtonGroup>
                <BarButton
                  size="large"
                  :active="ffAccelUnits"
                  :title="isHost ? 'Force field accelerates enemy units' : 'Only the host can change battle settings'"
                  @click="pickFfAccelUnits(!ffAccelUnits)"
                >UNIT-ACC</BarButton>
                <BarButton
                  size="large"
                  :active="ffAccelShots"
                  :title="isHost ? 'Force field accelerates enemy projectiles' : 'Only the host can change battle settings'"
                  @click="pickFfAccelShots(!ffAccelShots)"
                >SHOT-ACC</BarButton>
              </BarButtonGroup>
            </div>
            <div class="terrain-control-row">
              <div class="terrain-control-label">SYSTEM:</div>
              <BarButtonGroup>
                <BarButton
                  size="large"
                  :active="mirrorsEnabled"
                  :title="isHost ? 'Enable mirror turrets and laser/beam reflections' : 'Only the host can change battle settings'"
                  @click="pickMirrors(!mirrorsEnabled)"
                >MIRROR</BarButton>
                <BarButton
                  size="large"
                  :active="forceFieldsEnabled"
                  :title="isHost ? 'Enable force-field turrets, force-field simulation, and force-field rendering' : 'Only the host can change battle settings'"
                  @click="pickForceFields(!forceFieldsEnabled)"
                >FIELD</BarButton>
              </BarButtonGroup>
            </div>
          </div>
        </div>

        <div v-if="error" class="error-message">{{ error }}</div>

        <div class="footer-row">
          <button v-if="isTauri" class="lobby-btn exit-btn" @click="exitApp">Exit</button>
          <button class="lobby-btn cancel-btn" @click="handleCancel">Leave</button>
          <button
            v-if="isHost"
            class="lobby-btn defaults-btn"
            title="Reset every battle setting (units, cap, terrain, FF, system) to its default value"
            @click="pickResetDefaults"
          >Defaults</button>
          <div class="footer-spacer"></div>
          <button
            v-if="isHost"
            class="lobby-btn start-btn"
            :disabled="!canStart"
            @click="handleStart"
          >Start</button>
          <span v-else class="waiting-text">Waiting for host...</span>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.lobby-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(10, 10, 20, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 3000;
}

.lobby-modal {
  /* Lightly aligned with the bottom-bar aesthetic: dark semi-
   * transparent base, muted gray border. Rounded corners stay
   * (16px) per the global "keep rounded corners" pref; the soft
   * blue glow stays as the lobby's own accent so the BUDGET
   * ANNIHILATION title still reads as the brand moment. */
  position: relative;
  background: rgba(15, 18, 24, 0.92);
  border: 1px solid #444;
  border-radius: 16px;
  padding: 40px 50px;
  min-width: 500px;
  text-align: center;
  box-shadow: 0 0 60px rgba(68, 68, 170, 0.25);
}

/* GAME LOBBY screen — full-screen two-column layout.
 *   [ LEFT  ] [ PREVIEW ]
 *   [ left  ] [ TERRAIN ]
 *   [        FOOTER       ]
 *
 * Left column (title / share code / players list) spans the top
 * two grid rows; the preview-pane and terrain options stack in the
 * right column; footer (Exit / Leave / Start) spans both. The
 * preview-pane is a stable always-mounted child of `.lobby-modal`
 * — Grid's named areas place it visually without needing to move
 * its DOM position. */
.lobby-modal.in-lobby {
  display: grid;
  grid-template-columns: minmax(360px, 1fr) minmax(480px, 1.6fr);
  grid-template-rows: minmax(0, 1fr) auto auto;
  grid-template-areas:
    "left   preview"
    "left   terrain"
    "footer footer";
  width: 100vw;
  height: 100vh;
  max-width: none;
  min-width: 0;
  padding: 32px 40px;
  gap: 24px;
  text-align: left;
  /* Fullscreen lobby has no surrounding chrome — the dark
   * `.lobby-overlay` already covers the whole viewport, so the
   * card border + soft glow that frame the smaller initial /
   * connecting screens become visual noise here. */
  border: none;
  border-radius: 0;
  box-shadow: none;
}

.lobby-modal.in-lobby > .lobby-left {
  grid-area: left;
  display: flex;
  flex-direction: column;
  gap: 24px;
  min-height: 0;
  overflow: hidden;
}

.lobby-modal.in-lobby > .lobby-right {
  grid-area: terrain;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.lobby-modal.in-lobby > .footer-row {
  grid-area: footer;
}

/* When in fullscreen lobby mode the preview-pane lives in the
 * grid's "preview" cell; override its fixed 480x270 default so it
 * fills the cell while keeping a 16:9 aspect (clamped by max-
 * height so the right column stays room for the terrain options). */
.lobby-modal.in-lobby > .preview-pane {
  grid-area: preview;
  width: 100%;
  height: auto;
  aspect-ratio: 16 / 9;
  max-height: calc(100vh - 320px);
  margin: 0;
}

/* Players list in fullscreen mode gets vertical scroll if many
 * players (the default lobby cap is 6, so this is mostly for
 * future-proofing). */
.lobby-modal.in-lobby .players-section {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

.spectate-btn {
  position: absolute;
  top: 10px;
  right: 10px;
  width: 24px;
  height: 24px;
  padding: 0;
  background: transparent;
  border: none;
  color: #555;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
}

.spectate-btn:hover {
  color: #4a9eff;
  background: rgba(74, 158, 255, 0.1);
}

/* Preview pane — appears ONLY in the GAME LOBBY screen (after
 * Host/Join). The demo-battle container teleports into the
 * `#lobby-preview-target` div inside it. Aligned with the
 * bottom-bar aesthetic: dark base, thin gray border, rounded. */
.preview-pane {
  position: relative;          /* anchor for the teleported absolute child */
  width: 480px;
  height: 270px;               /* 16:9 — comfortable preview ratio */
  margin: 0 auto 16px;
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid #444;
  border-radius: 8px;
  overflow: hidden;
}

.title {
  font-family: monospace;
  font-size: 32px;
  color: #ffffff;
  margin: 0;
  text-shadow: 0 0 20px rgba(68, 68, 170, 0.5);
}

.subtitle {
  font-family: monospace;
  font-size: 14px;
  color: #888;
  margin: 8px 0 20px 0;
}

.main-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: stretch;
  width: 220px;
  margin: 0 auto 8px;
}

.join-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.join-row .join-btn {
  flex-shrink: 0;
}

.join-row .code-input {
  flex: 1;
  min-width: 0;
}

.lobby-btn {
  font-family: monospace;
  font-size: 16px;
  padding: 10px 28px;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.lobby-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.host-btn {
  background: #44aa44;
  color: white;
  width: 100%;
}

.host-btn:hover:not(:disabled) {
  background: #55cc55;
}

.join-btn {
  background: #4a9eff;
  color: white;
}

.join-btn:hover:not(:disabled) {
  background: #5aafff;
}

.start-btn {
  background: #44aa44;
  color: white;
}

.start-btn:hover:not(:disabled) {
  background: #55cc55;
}

.cancel-btn {
  background: #666;
  color: white;
}

.cancel-btn:hover {
  background: #777;
}

.defaults-btn {
  background: #555;
  color: white;
}

.defaults-btn:hover:not(:disabled) {
  background: #666;
}

.exit-btn {
  background: rgba(255, 40, 40, 0.15);
  color: #ff6666;
  border: 1px solid rgba(255, 80, 80, 0.3);
}

.exit-btn:hover:not(:disabled) {
  background: rgba(255, 40, 40, 0.35);
  color: #ff9999;
  border-color: rgba(255, 80, 80, 0.6);
}

.code-input {
  font-family: monospace;
  font-size: 20px;
  text-align: center;
  width: 110px;
  padding: 8px 10px;
  background: rgba(0, 0, 0, 0.3);
  border: 2px solid #4444aa;
  border-radius: 8px;
  color: white;
  text-transform: uppercase;
  letter-spacing: 4px;
}

.code-input::placeholder {
  color: #555;
  letter-spacing: 4px;
}

.code-input:focus {
  outline: none;
  border-color: #6666cc;
}

.footer-row {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: center;
  margin-top: 20px;
}

.footer-spacer {
  flex: 1;
}

.room-code-display {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 8px 0;
  margin-bottom: 16px;
}

.room-code-row {
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
}

.room-code {
  font-family: monospace;
  font-size: 28px;
  color: #4a9eff;
  letter-spacing: 6px;
  font-weight: bold;
  user-select: all;
  text-shadow: 0 0 10px rgba(74, 158, 255, 0.4);
}

.copy-btn {
  font-size: 16px;
  width: 32px;
  height: 32px;
  padding: 0;
  background: rgba(74, 158, 255, 0.2);
  border: 1px solid #4a9eff;
  border-radius: 8px;
  color: #4a9eff;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.copy-btn:hover {
  background: rgba(74, 158, 255, 0.4);
}

.copy-btn.copied {
  background: rgba(68, 170, 68, 0.3);
  border-color: #44aa44;
  color: #44aa44;
}

.players-section {
  margin-bottom: 25px;
}

.players-title {
  font-family: monospace;
  font-size: 16px;
  color: #aaa;
  margin: 0 0 15px 0;
}

.player-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

/* Lobby player rows — sized so the full 6-player roster fits in
 * the left column without scrolling on typical desktop viewports
 * (≥720px tall). Per-row height ≈ 60-64px content + 6px margin
 * → 6 rows × ~70px = ~420px total. The `.players-section`
 * still has `overflow-y: auto` for genuinely cramped windows. */
.player-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 10px;
  margin-bottom: 6px;
  min-height: 60px;
}

.player-item.is-local {
  background: rgba(68, 68, 170, 0.2);
  border: 1px solid rgba(68, 68, 170, 0.4);
}

.player-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
  font-family: monospace;
  /* Each row is one line of info — keep them tight so 3 lines
   * fit comfortably in the row's 60px min-height. */
}

/* Most prominent line: "Mountain View, United States" — the
 * fastest read for "where are you from?" */
.player-info .player-location {
  font-size: 13px;
  color: #ddd;
  font-weight: bold;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* IP address — technical identifier, dimmer. Tabular nums so
 * dotted quads line up cleanly across rows. */
.player-info .player-ip {
  font-size: 11px;
  color: #888;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* Live local time + short timezone label. Slight accent color
 * since this cell ticks once a second and the eye picks up
 * motion; tabular nums keep digits from jiggling. */
.player-info .player-time {
  font-size: 11px;
  color: #99a;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* Badges column on the far right of the row. CSS Grid with two
 * equal rows so HOST always anchors to the top-right cell and
 * YOU always to the bottom-right cell — regardless of which is
 * present (only-HOST leaves the bottom half empty, only-YOU
 * leaves the top half empty). The negative margins yank the
 * column out of the .player-item's `padding: 14px 18px` so each
 * badge actually touches the row's outer edges, and the
 * border-radius on each cell mirrors the row's rounded corners. */
.player-badges {
  display: grid;
  grid-template-rows: 1fr 1fr;
  align-self: stretch;
  flex-shrink: 0;
  width: 72px;
  /* Negative margins must match `.player-item`'s padding so the
   * cells touch the row's outer rounded edges. Keep these in sync
   * if the player-item padding ever changes. */
  margin: -10px -14px -10px 0;
}

.player-badges .host-badge,
.player-badges .you-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: monospace;
  font-size: 14px;
  font-weight: bold;
  color: white;
  letter-spacing: 1px;
  /* Reset the standalone-badge defaults below — inside the
   * column the badge IS the cell, no padding pill shape. */
  padding: 0;
  border-radius: 0;
  background: transparent;
}

.player-badges .host-badge {
  grid-row: 1;
  background: #44aa44;
  border-top-right-radius: 10px;
}

.player-badges .you-badge {
  grid-row: 2;
  background: #4a9eff;
  border-bottom-right-radius: 10px;
}

.host-badge {
  font-family: monospace;
  font-size: 11px;
  background: #44aa44;
  color: white;
  padding: 3px 8px;
  border-radius: 4px;
}

.you-badge {
  font-family: monospace;
  font-size: 11px;
  background: #4a9eff;
  color: white;
  padding: 3px 8px;
  border-radius: 4px;
}

.waiting-text {
  font-family: monospace;
  font-size: 14px;
  color: #888;
  padding: 14px 20px;
}

/* Terrain controls use large shared buttons plus a lobby-specific
 * fixed label column so every row starts at the same x-position. */
.terrain-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.terrain-control-row {
  display: grid;
  grid-template-columns: 112px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
}

.terrain-control-label {
  color: #aaa;
  font-family: monospace;
  font-size: 13px;
  font-weight: 700;
  text-align: right;
  text-transform: uppercase;
  white-space: nowrap;
}

.terrain-section .button-group {
  flex: 1;
}

.error-message {
  font-family: monospace;
  font-size: 14px;
  color: #ff6666;
  background: rgba(255, 0, 0, 0.1);
  padding: 10px 15px;
  border-radius: 6px;
  margin-top: 15px;
}

.connecting-spinner {
  width: 40px;
  height: 40px;
  border: 4px solid rgba(68, 68, 170, 0.3);
  border-top-color: #4a9eff;
  border-radius: 50%;
  margin: 20px auto;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
