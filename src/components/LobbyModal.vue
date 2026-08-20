<script setup lang="ts">
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue';
import { setPlayerCountForColors, type PlayerId } from '../game/sim/types';
import { resolveLobbyTeamGroups } from '../game/lobby/lobbyIdentity';
import { BATTLE_CONFIG } from '../battleBarConfig';
import { BAR_THEMES, barVars } from '../barThemes';
import CommanderAvatar from './CommanderAvatar.vue';
import BarButtonGroup from './BarButtonGroup.vue';
import BarButton from './BarButton.vue';
import BarControlGroup from './BarControlGroup.vue';
import BarDivider from './BarDivider.vue';
import BarLabel from './BarLabel.vue';
import LoadingEmblem from './LoadingEmblem.vue';
import ChevronIcon from './ChevronIcon.vue';
import {
  getUnitDisplayShortName,
  getBuildingDisplayShortName,
} from '../game/sim/blueprints/displayRosters';
import type { MapLandCellDimensions } from '../mapSizeConfig';
import type { BattlePreset } from './battlePresets';
import type { TerrainPrecedence } from '../types/terrainPrecedence';
import { MAX_NAME_LENGTH } from '@/playerNamesConfig';
import {
  MAX_LOBBY_NAME_LENGTH,
  normalizeLobbyName,
  resolveLobbyDisplayName,
} from '../game/network/lobbyName';
import { MAX_ALLY_TEAM_COUNT } from '../game/sim/teamRoster';
import { getMapPresetThumbnailUrl } from './mapPresetThumbnails';
import { readableInkOn } from './uiUtils';
import { AUTHOR_BYLINE } from '@/authorBylineConfig';
import { closeCurrentTauriWindow, isTauriRuntime } from '@/browserRuntime';
import { LOBBY_LIST_POLL_INTERVAL_MS } from '../game/network/LobbyDirectory';
import { getMultiplayerBackend } from '../game/network/multiplayer/multiplayerBackendRegistry';
import type { MultiplayerLobbySummary } from '../game/network/multiplayer/MultiplayerBackend';

import type { LobbyPlayer } from '@/types/ui';
import type { LobbyMember } from '../game/network/NetworkManager';

const props = defineProps<{
  visible: boolean;
  sidebarOpen: boolean;
  isHost: boolean;
  roomCode: string;
  players: readonly LobbyPlayer[];
  /** Members holding no seat — everyone who joined and has not been put on a
   *  team by the host. */
  spectators: readonly LobbyMember[];
  localPlayerId: PlayerId;
  localMemberId: number;
  /** Seat -> the member holding it, so a control on a seated row can address
   *  the member the host actually edits. */
  seatedMemberIds: Readonly<Record<number, number>>;
  error: string | null;
  isConnecting: boolean;
  centerMagnitude: number;
  ringMagnitude: number;
  dividersMagnitude: number;
  perimeterMagnitude: number;
  terrainPrecedence: TerrainPrecedence;
  terrainDTerrain: number;
  plateauWallSlopeDegrees: number;
  metalDepositStep: number;
  terrainDetail: number;
  pathfindingCellConsolidation: number;
  simulationTickRateHz: number;
  mapWidthLandCells: number;
  mapLengthLandCells: number;
  unitBlueprintIds: readonly string[];
  allowedUnits: readonly string[];
  buildingBlueprintIds: readonly string[];
  allowedBuildings: readonly string[];
  unitCap: number;
  /** Sides the host declared — empty ones included; they still carve terrain. */
  allyTeamCount: number;
  /** What the host called this lobby; empty until they type one. */
  lobbyName: string;
  converterTax: number;
  previewLoading: boolean;
  previewLoadingProgress: number;
  previewLoadingPhase: string;
  presets: readonly BattlePreset[];
  activePresetName: string | null;
}>();

const emit = defineEmits<{
  (e: 'host'): void;
  (e: 'join', roomCode: string): void;
  (e: 'start'): void;
  (e: 'cancel'): void;
  (e: 'entityLab'): void;
  /** Collapse or reveal the menu sidebar. Nothing to do with watching a
   *  match — this is the chevron on the sidebar's edge. */
  (e: 'toggleMenu'): void;
  (e: 'setCenterMagnitude', value: number): void;
  (e: 'setRingMagnitude', value: number): void;
  (e: 'setDividersMagnitude', value: number): void;
  (e: 'setPerimeterMagnitude', value: number): void;
  (e: 'setTerrainPrecedence', value: TerrainPrecedence): void;
  (e: 'setTerrainDTerrain', value: number): void;
  (e: 'setPlateauWallSlopeDegrees', value: number): void;
  (e: 'setMetalDepositStep', value: number): void;
  (e: 'setTerrainDetail', value: number): void;
  (e: 'setPathfindingCellConsolidation', value: number): void;
  (e: 'setSimulationTickRate', value: number): void;
  (e: 'setPreset', preset: BattlePreset): void;
  (e: 'setMapLandDimensions', dimensions: MapLandCellDimensions): void;
  (e: 'toggleUnit', unitBlueprintId: string): void;
  (e: 'toggleAllUnits'): void;
  (e: 'toggleBuilding', buildingBlueprintId: string): void;
  (e: 'toggleAllBuildings'): void;
  (e: 'setUnitCap', cap: number): void;
  /** Host changes how many sides the lobby declares. */
  (e: 'setAllyTeamCount', count: number): void;
  /** Host declares one more side. */
  (e: 'addAllyTeam'): void;
  /** Host deletes one EMPTY side, closing the gap behind it. */
  (e: 'removeAllyTeam', allyTeamId: number): void;
  /** Host renames the lobby — the title the directory lists it under. */
  (e: 'setLobbyName', name: string): void;
  /** Host moves a seat to the next side (the lobby's TEAM N). */
  (e: 'cycleMemberAllyTeam', memberId: number): void;
  /** Host moves a watcher onto a team, or a player back to the bench. The
   *  only route between the two — nobody moves themselves. */
  (e: 'toggleMemberSeated', memberId: number): void;
  (e: 'setConverterTax', tax: number): void;
  (e: 'setPlayerName', name: string): void;
  (e: 'resetDefaults'): void;
}>();

// Surface the labeled-options arrays to the template. The host
// clicks one to pick the shape; non-hosts see the same UI but the
// click handler is gated on isHost so only the host can change it.
const centerMagnitudeOptions = BATTLE_CONFIG.centerMagnitude.options;
const ringMagnitudeOptions = BATTLE_CONFIG.ringMagnitude.options;
const dividersMagnitudeOptions = BATTLE_CONFIG.dividersMagnitude.options;
const perimeterMagnitudeOptions = BATTLE_CONFIG.perimeterMagnitude.options;
const terrainPrecedenceOptions = BATTLE_CONFIG.terrainPrecedence.options;
const terrainDTerrainOptions = BATTLE_CONFIG.terrainDTerrain.options;
const plateauWallSlopeDegreesOptions =
  BATTLE_CONFIG.plateauWallSlopeDegrees.options;
const metalDepositStepOptions = BATTLE_CONFIG.metalDepositStep.options;
const terrainDetailOptions = BATTLE_CONFIG.terrainDetail.options;
const pathfindingCellConsolidationOptions =
  BATTLE_CONFIG.pathfindingCellConsolidation.options;
const simulationTickRateOptions = BATTLE_CONFIG.simulationTickRate.options;
const converterTaxOptions = BATTLE_CONFIG.converterTax.options;
const mapWidthOptions = BATTLE_CONFIG.mapSize.width.options;
const mapLengthOptions = BATTLE_CONFIG.mapSize.length.options;
const capOptions = BATTLE_CONFIG.cap.options;
const allyTeamCountOptions = BATTLE_CONFIG.allyTeamCount.options;
/** Sides holding at least one seat — what the entity count cap divides by,
 *  matching WorldState.getTeamEntityCountCap. Declared-but-empty sides carve
 *  terrain but own no economy, so they are not counted here. */
const occupiedAllyTeamCount = computed(() => {
  let occupied = 0;
  for (const group of teamGroups.value) {
    if (group.seats.length > 0) occupied++;
  }
  return Math.max(1, occupied);
});

// Set view of allowedUnits so per-button lookups in the v-for below
// are O(1) instead of O(allowedUnits.length) on every parent re-render.
const allowedUnitsSet = computed(() => new Set(props.allowedUnits));
const allUnitsActive = computed(() => {
  const allowed = allowedUnitsSet.value;
  for (let i = 0; i < props.unitBlueprintIds.length; i++) {
    if (!allowed.has(props.unitBlueprintIds[i])) return false;
  }
  return true;
});
const allowedBuildingsSet = computed(() => new Set(props.allowedBuildings));
const allBuildingsActive = computed(() => {
  const allowed = allowedBuildingsSet.value;
  for (let i = 0; i < props.buildingBlueprintIds.length; i++) {
    if (!allowed.has(props.buildingBlueprintIds[i])) return false;
  }
  return true;
});

function pickCenterMagnitude(value: number): void {
  if (!props.isHost) return;
  emit('setCenterMagnitude', value);
}

function pickRingMagnitude(value: number): void {
  if (!props.isHost) return;
  emit('setRingMagnitude', value);
}

function pickDividersMagnitude(value: number): void {
  if (!props.isHost) return;
  emit('setDividersMagnitude', value);
}

function pickPerimeterMagnitude(value: number): void {
  if (!props.isHost) return;
  emit('setPerimeterMagnitude', value);
}

function pickTerrainPrecedence(value: TerrainPrecedence): void {
  if (!props.isHost) return;
  emit('setTerrainPrecedence', value);
}

function pickTerrainDTerrain(value: number): void {
  if (!props.isHost) return;
  emit('setTerrainDTerrain', value);
}

function pickPlateauWallSlopeDegrees(value: number): void {
  if (!props.isHost) return;
  emit('setPlateauWallSlopeDegrees', value);
}

function pickMetalDepositStep(value: number): void {
  if (!props.isHost) return;
  emit('setMetalDepositStep', value);
}

function pickTerrainDetail(value: number): void {
  if (!props.isHost) return;
  emit('setTerrainDetail', value);
}

function pickPathfindingCellConsolidation(value: number): void {
  if (!props.isHost) return;
  emit('setPathfindingCellConsolidation', value);
}

function pickSimulationTickRate(value: number): void {
  if (!props.isHost) return;
  emit('setSimulationTickRate', value);
}

function pickPreset(preset: BattlePreset): void {
  if (!props.isHost) return;
  emit('setPreset', preset);
}

function pickMapWidthLandCells(widthLandCells: number): void {
  if (!props.isHost) return;
  emit('setMapLandDimensions', {
    widthLandCells,
    lengthLandCells: props.mapLengthLandCells,
  });
}

function pickMapLengthLandCells(lengthLandCells: number): void {
  if (!props.isHost) return;
  emit('setMapLandDimensions', {
    widthLandCells: props.mapWidthLandCells,
    lengthLandCells,
  });
}

function pickToggleUnit(unitBlueprintId: string): void {
  if (!props.isHost) return;
  emit('toggleUnit', unitBlueprintId);
}

function pickToggleAllUnits(): void {
  if (!props.isHost) return;
  emit('toggleAllUnits');
}

function pickToggleBuilding(buildingBlueprintId: string): void {
  if (!props.isHost) return;
  emit('toggleBuilding', buildingBlueprintId);
}

function pickToggleAllBuildings(): void {
  if (!props.isHost) return;
  emit('toggleAllBuildings');
}

function pickUnitCap(cap: number): void {
  if (!props.isHost) return;
  emit('setUnitCap', cap);
}

/** The member behind a seat. The roster the host edits is keyed by member —
 *  seats belong to members, not the other way round — so a control on a
 *  seated row has to resolve back to one. */
function memberIdForSeat(playerId: PlayerId): number {
  return props.seatedMemberIds[playerId] ?? 0;
}

function pickAllyTeamCount(count: number) {
  if (!props.isHost) return;
  emit('setAllyTeamCount', count);
}

function pickConverterTax(value: number): void {
  if (!props.isHost) return;
  emit('setConverterTax', value);
}

function unitShortName(unitBlueprintId: string): string {
  return getUnitDisplayShortName(unitBlueprintId);
}

function buildingShortName(buildingBlueprintId: string): string {
  return getBuildingDisplayShortName(buildingBlueprintId);
}

function pickResetDefaults(): void {
  if (!props.isHost) return;
  emit('resetDefaults');
}

const editingName = ref('');
const nameModalOpen = ref(false);
const nameInputEl = ref<HTMLInputElement | null>(null);

const localPlayer = computed(
  () => props.players.find((p) => p.playerId === props.localPlayerId) ?? null,
);
const localPlayerName = computed(() => localPlayer.value?.name ?? '');

watch(
  localPlayerName,
  (name) => {
    if (!nameModalOpen.value) editingName.value = name;
  },
  { immediate: true },
);

const nameCanSave = computed(() => editingName.value.trim().length > 0);

async function openNameEditor(): Promise<void> {
  editingName.value = localPlayerName.value;
  nameModalOpen.value = true;
  await nextTick();
  nameInputEl.value?.focus();
  nameInputEl.value?.select();
}

function closeNameEditor(): void {
  editingName.value = localPlayerName.value;
  nameModalOpen.value = false;
}

watch(
  () => props.visible,
  (visible) => {
    if (!visible) closeNameEditor();
  },
);

function commitLocalPlayerName(): void {
  const trimmed = editingName.value.trim().slice(0, MAX_NAME_LENGTH);
  if (trimmed.length === 0) {
    nameInputEl.value?.focus();
    return;
  }
  if (trimmed !== localPlayerName.value) emit('setPlayerName', trimmed);
  editingName.value = trimmed;
  nameModalOpen.value = false;
}

const isTauri = isTauriRuntime();

const joinCode = ref('');
const codeCopied = ref(false);

/* Open-lobby directory.
 *
 * Joining used to require someone reading you a four-character code. The
 * directory lists what is open so players can find each other cold, and
 * lists running games so the screen shows there is activity even when
 * nothing is joinable.
 *
 * It polls only while this menu is actually on screen — entering a lobby or
 * starting a battle stops it, so no timer runs during a match. Every fetch
 * is best-effort: a backend that is down yields an empty list and the
 * code-entry path above still works exactly as it always did. */
const directoryLobbies = ref<readonly MultiplayerLobbySummary[]>([]);
const directoryLoaded = ref(false);
let directoryPollTimer: ReturnType<typeof setInterval> | null = null;

const openLobbies = computed(() =>
  directoryLobbies.value.filter((lobby) => lobby.status === 'open'),
);
const runningGames = computed(() =>
  directoryLobbies.value.filter((lobby) => lobby.status === 'in-game'),
);

async function refreshDirectory(): Promise<void> {
  // Whichever backend this build uses — the web directory or Steam — answers
  // in the same vocabulary, so nothing here knows which is in play.
  directoryLobbies.value = await getMultiplayerBackend().listLobbies();
  directoryLoaded.value = true;
}

function stopDirectoryPolling(): void {
  if (directoryPollTimer === null) return;
  clearInterval(directoryPollTimer);
  directoryPollTimer = null;
}

function startDirectoryPolling(): void {
  if (directoryPollTimer !== null) return;
  void refreshDirectory();
  directoryPollTimer = setInterval(() => void refreshDirectory(), LOBBY_LIST_POLL_INTERVAL_MS);
}

/** One-click join straight from the list — the code is already known, so
 *  the player never has to read or type it. */
function handleJoinListed(lobby: MultiplayerLobbySummary): void {
  emit('join', lobby.roomCode);
}

/** How stale a listing is, in the words a player actually wants: how long
 *  the lobby has been sitting there waiting. */
function formatLobbyAge(lobby: MultiplayerLobbySummary): string {
  // Not every backend reports one — Steam has no lobby creation time — and a
  // missing timestamp would otherwise render as "56 years ago".
  if (lobby.createdAt <= 0) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - lobby.createdAt) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

let codeCopiedTimeout: ReturnType<typeof setTimeout> | null = null;

async function copyCode() {
  try {
    await navigator.clipboard.writeText(props.roomCode);
    codeCopied.value = true;
    if (codeCopiedTimeout !== null) clearTimeout(codeCopiedTimeout);
    codeCopiedTimeout = setTimeout(() => {
      codeCopiedTimeout = null;
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

onBeforeUnmount(() => {
  if (codeCopiedTimeout !== null) clearTimeout(codeCopiedTimeout);
  codeCopiedTimeout = null;
  stopDirectoryPolling();
});

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

/** The roster grouped by SIDE, carrying the exact team and player colours
 *  the match will use. Both are derived, never authored here: the lobby
 *  resolves the same TeamRoster the sim resolves and reads the same
 *  identity-colour rule the renderer reads (see lobbyIdentity.ts). */
const teamGroups = computed(() =>
  resolveLobbyTeamGroups(props.players, props.allyTeamCount),
);

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

function handleEntityLab() {
  emit('entityLab');
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

/** The directory is only interesting on the menu screen: once the player is
 *  in a lobby or connecting, they have already chosen. Polling follows that
 *  exactly, so no timer survives into a running battle. */
const showingMenu = computed(
  () => props.visible && !isInLobby.value && !props.isConnecting,
);

watch(
  showingMenu,
  (visible) => {
    if (visible) startDirectoryPolling();
    else stopDirectoryPolling();
  },
  { immediate: true },
);

/* ── The map picker ───────────────────────────────────────────────────────
 *
 * A map is a place, and a place is recognised by looking at it. The eight
 * authored maps are offered as pictures of themselves — captured from the
 * real terrain generator, see mapPresetThumbnails.ts — because a row of
 * names ("Spikey Lake", "Angels Playhouse") tells a player nothing about
 * what they are about to fight on.
 *
 * The full battle-options bar is still there, one click away behind CUSTOM.
 * It is the fine control: every terrain magnitude, the unit and building
 * rosters, the caps. Most hosts want a map, not a terrain editor, so the
 * pictures are what the lobby opens on. */
const customOptionsOpen = ref(false);

type MapPresetTile = {
  readonly preset: BattlePreset;
  readonly thumbnailUrl: string;
  readonly active: boolean;
};

const mapPresetTiles = computed<MapPresetTile[]>(() =>
  props.presets.map((preset) => ({
    preset,
    thumbnailUrl: getMapPresetThumbnailUrl(preset.backdropSlug),
    active: props.activePresetName === preset.name,
  })),
);

/** A capture that has not been taken yet must not leave a broken-image glyph
 *  in the grid; the tile falls back to its own name plate. */
const missingThumbnails = ref<Set<string>>(new Set());

function markThumbnailMissing(slug: string): void {
  const next = new Set(missingThumbnails.value);
  next.add(slug);
  missingThumbnails.value = next;
}

/* ── Lobby name ────────────────────────────────────────────────────────── */

/** Host's in-progress text. Committed on blur or Enter rather than on every
 *  keystroke: each commit broadcasts the settings contract and republishes
 *  the public listing, and a lobby does not need renaming per character. */
const editingLobbyName = ref('');
const lobbyNameFocused = ref(false);
const lobbyNameInputEl = ref<HTMLInputElement | null>(null);

watch(
  () => props.lobbyName,
  (name) => {
    if (!lobbyNameFocused.value) editingLobbyName.value = name;
  },
  { immediate: true },
);

/** The title this lobby is listed and shown under, host-typed or derived. */
const lobbyDisplayName = computed(() =>
  resolveLobbyDisplayName(
    props.lobbyName,
    props.players.find((p) => p.isHost)?.name ?? '',
  ),
);

function commitLobbyName(): void {
  lobbyNameFocused.value = false;
  if (!props.isHost) return;
  // Show the host exactly what was stored. A name that normalizes to what is
  // already set produces no prop change to watch, so the field would
  // otherwise keep the raw text (stray spaces and all) on screen.
  const normalized = normalizeLobbyName(editingLobbyName.value);
  editingLobbyName.value = normalized;
  emit('setLobbyName', normalized);
}

/* ── Sides ─────────────────────────────────────────────────────────────── */

const canAddAllyTeam = computed(
  () => props.isHost && props.allyTeamCount < MAX_ALLY_TEAM_COUNT,
);

/** A side may only be deleted while nobody is standing on it — the same rule
 *  NetworkManager enforces; this only decides whether to offer the control. */
function canRemoveAllyTeam(group: { seats: readonly unknown[] }): boolean {
  return props.isHost && props.allyTeamCount > 1 && group.seats.length === 0;
}

/** Ink for a label painted straight onto a side's generated colour. */
function teamBandInk(teamColor: string): string {
  return readableInkOn(teamColor);
}

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
  <!-- Startup BUDGET ANNIHILATION screen — a non-blocking right-edge
       sidebar that slides over the live demo battle. The wrapper is
       pointer-events:none so clicks pass straight through to the demo
       everywhere except the panel and its toggle handle; the demo keeps
       running and stays fully interactive whether the sidebar is open
       or closed. The edge toggle slides the panel in/out. -->
  <aside
    v-if="visible && !isInLobby && !isConnecting"
    class="menu-sidebar"
    :class="{ open: sidebarOpen }"
    aria-label="Budget Annihilation menu"
  >
    <button
      class="menu-sidebar-toggle"
      :aria-expanded="sidebarOpen"
      :aria-label="sidebarOpen ? 'Close menu' : 'Open menu'"
      :title="sidebarOpen ? 'Close menu' : 'Open menu'"
      @click="emit('toggleMenu')"
    >
      <ChevronIcon :direction="sidebarOpen ? 'right' : 'left'" />
    </button>

    <div class="menu-sidebar-panel" :aria-hidden="!sidebarOpen">
      <div class="menu-brand">
        <h1 class="title">BUDGET ANNIHILATION</h1>
        <p class="subtitle">Online Multiplayer RTS</p>
      </div>

      <div class="main-actions">
        <button class="lobby-btn host-btn" @click="handleHost">Host Game</button>

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

      <!-- The open-lobby directory. Every row is a one-click join: the
           room code is already known, so nobody has to be told one. Running
           games are listed too but are not joinable — the host rejects late
           joiners — so they read as status, not as buttons. -->
      <div class="lobby-list">
        <div class="lobby-list-header">
          <span class="lobby-list-label">OPEN LOBBIES</span>
          <span v-if="openLobbies.length > 0" class="lobby-list-count">{{ openLobbies.length }}</span>
        </div>

        <ul v-if="openLobbies.length > 0" class="lobby-rows">
          <li v-for="lobby in openLobbies" :key="lobby.roomCode">
            <button
              class="lobby-row"
              :title="`Join ${lobby.name || lobby.roomCode}`"
              @click="handleJoinListed(lobby)"
            >
              <span class="lobby-row-main">
                <span class="lobby-row-name">{{ lobby.name || lobby.hostName || 'Open lobby' }}</span>
                <span class="lobby-row-meta">
                  <span class="lobby-row-code">{{ lobby.roomCode }}</span>
                  <span v-if="lobby.mapName" class="lobby-row-map">{{ lobby.mapName }}</span>
                  <span v-if="formatLobbyAge(lobby)" class="lobby-row-age">{{ formatLobbyAge(lobby) }}</span>
                </span>
              </span>
              <span class="lobby-row-players">
                {{ lobby.playerCount }}/{{ lobby.maxPlayers }}
                <span v-if="lobby.spectatorCount > 0" class="lobby-row-watch">
                  +{{ lobby.spectatorCount }} watching
                </span>
              </span>
            </button>
          </li>
        </ul>

        <p v-else-if="!directoryLoaded" class="lobby-list-hint">Looking for open lobbies…</p>
        <p v-else class="lobby-list-hint">
          No open lobbies — host a game, or join with a code.
        </p>

        <template v-if="runningGames.length > 0">
          <div class="lobby-list-header">
            <span class="lobby-list-label">IN PROGRESS</span>
            <span class="lobby-list-count">{{ runningGames.length }}</span>
          </div>
          <!-- A running battle takes no new SEATS — the frame-0 roster is
               hashed and cannot grow — but it takes watchers freely, so the
               row is a WATCH button rather than a dead entry. -->
          <ul class="lobby-rows">
            <li v-for="game in runningGames" :key="game.roomCode">
              <button
                class="lobby-row lobby-row-running"
                :disabled="game.spectatorCount >= game.maxSpectators"
                :title="game.spectatorCount >= game.maxSpectators
                  ? 'This battle has no room left to watch'
                  : `Watch ${game.name || game.roomCode}`"
                @click="handleJoinListed(game)"
              >
                <span class="lobby-row-main">
                  <span class="lobby-row-name">{{ game.name || game.hostName || 'Battle' }}</span>
                  <span class="lobby-row-meta">
                    <span v-if="game.mapName" class="lobby-row-map">{{ game.mapName }}</span>
                    <span v-if="formatLobbyAge(game)" class="lobby-row-age">started {{ formatLobbyAge(game) }}</span>
                  </span>
                </span>
                <span class="lobby-row-players">
                  {{ game.playerCount }}/{{ game.maxPlayers }}
                  <span class="lobby-row-watch">WATCH {{ game.spectatorCount }}/{{ game.maxSpectators }}</span>
                </span>
              </button>
            </li>
          </ul>
        </template>
      </div>

      <div class="surface-actions">
        <button class="secondary-surface-btn" @click="handleEntityLab">Entity Lab</button>
      </div>

      <div v-if="error" class="error-message">{{ error }}</div>

      <div v-if="isTauri" class="footer-row">
        <button class="lobby-btn exit-btn" @click="closeCurrentTauriWindow">Exit</button>
      </div>

      <!-- Whose game this is. It belongs to the panel's chrome, not to the
           map: carried on the terrain sign it read as one more map
           statistic beside the cell counts and the terrain magnitudes. -->
      <div class="menu-byline">
        <a
          class="menu-byline-link"
          :href="AUTHOR_BYLINE.siteUrl"
          target="_blank"
          rel="noopener noreferrer"
        >{{ AUTHOR_BYLINE.siteUrl }}</a>
        <a
          class="menu-byline-link"
          :href="`mailto:${AUTHOR_BYLINE.email}`"
        >{{ AUTHOR_BYLINE.email }}</a>
      </div>
    </div>
  </aside>

  <!-- Connecting / GAME LOBBY screens — still full-screen modals. -->
  <div v-else-if="visible" class="lobby-overlay">
    <div class="lobby-modal" :class="{ 'in-lobby': isInLobby }">
      <!-- Live mini-simulation preview target. Rendered whenever the
           full-screen modal is mounted, but only visually shown in the
           GAME LOBBY state via v-show. The demo container is moved into
           it imperatively (see useGameCanvasLobbyPreview) once a room
           code exists. -->
      <div
        id="lobby-preview-target"
        class="preview-pane"
        v-show="isInLobby"
      >
        <div
          v-if="previewLoading"
          class="preview-loading-overlay"
          role="status"
          aria-live="polite"
        >
          <LoadingEmblem
            :progress="previewLoadingProgress"
            :phase="previewLoadingPhase"
            next-label="LOBBY VISUALIZATION"
          />
        </div>
      </div>

      <!-- Connecting screen -->
      <template v-if="isConnecting">
        <h1 class="title">CONNECTING...</h1>
        <div class="connecting-spinner"></div>
        <div class="footer-row">
          <button class="lobby-btn cancel-btn" @click="handleCancel">Cancel</button>
          <button v-if="isTauri" class="lobby-btn exit-btn" @click="closeCurrentTauriWindow">Exit</button>
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
          <!-- Who this lobby is. The host types the title the directory
               lists it under; everyone else reads it. The room code sits
               under it as the thing you read aloud, not as the heading —
               a lobby is a name first and a four-character code second. -->
          <div class="lobby-identity">
            <input
              v-if="isHost"
              ref="lobbyNameInputEl"
              v-model="editingLobbyName"
              class="lobby-name-input"
              type="text"
              :maxlength="MAX_LOBBY_NAME_LENGTH"
              :placeholder="lobbyDisplayName"
              spellcheck="false"
              autocomplete="off"
              title="Name this lobby — the title it is listed under"
              @focus="lobbyNameFocused = true"
              @blur="commitLobbyName"
              @keyup.enter="lobbyNameInputEl?.blur()"
            />
            <h1 v-else class="lobby-name-static">{{ lobbyDisplayName }}</h1>

            <div
              class="room-code-row"
              :title="codeCopied ? 'Copied!' : 'Copy the lobby code'"
              @click="copyCode"
            >
              <span class="room-code-label">CODE</span>
              <span class="room-code">{{ roomCode }}</span>
              <span class="copy-btn" :class="{ copied: codeCopied }">{{ codeCopied ? '✓' : '⧉' }}</span>
            </div>
          </div>

          <div class="lobby-actions-row">
            <button class="lobby-btn cancel-btn" @click="handleCancel">Leave</button>
            <button
              v-if="isHost"
              class="lobby-btn start-btn"
              :disabled="!canStart"
              @click="handleStart"
            >Start</button>
            <span v-else class="waiting-text">Waiting for host...</span>
          </div>

          <div class="players-section">
            <div class="players-header">
              <h2 class="players-title">Players ({{ players.length }}/6)</h2>
              <!-- Sides are added and removed here rather than picked off a
                   1..6 button row: the host is looking at the teams while
                   they decide, and a side is a thing you add to a list, not
                   a number you set. -->
              <button
                v-if="isHost"
                class="team-add-btn"
                type="button"
                :disabled="!canAddAllyTeam"
                :title="canAddAllyTeam
                  ? `Add TEAM ${allyTeamCount + 1} — it carves its own slice, deposits and spawn arc`
                  : `A lobby cannot declare more than ${MAX_ALLY_TEAM_COUNT} teams`"
                @click="emit('addAllyTeam')"
              >+ TEAM</button>
            </div>
            <!-- Grouped by SIDE, because a side is what an alliance means
                 on the ground: shared slice, shared vision, no friendly
                 fire. The band on the far left is the side's own colour and
                 the spinning avatar is the seat's, so a player reads both
                 identities here exactly as they will read them in the
                 battle (see lobbyIdentity.ts). -->
            <ul class="team-list">
              <li
                v-for="group in teamGroups"
                :key="group.allyTeamId"
                class="team-group"
              >
                <!-- The side's own colour, straight from the identity rule
                     the battle uses. The label takes whichever ink stays
                     readable on it — these colours are generated, so half of
                     them are dark and a fixed black label vanished on those. -->
                <div
                  class="team-band"
                  :style="{ background: group.teamColor, color: teamBandInk(group.teamColor) }"
                  :title="`TEAM ${group.allyTeamId}`"
                >
                  <span class="team-band-label">TEAM {{ group.allyTeamId }}</span>
                  <!-- Only on a side nobody is standing on. Deleting an
                       occupied side would move somebody without being asked. -->
                  <button
                    v-if="canRemoveAllyTeam(group)"
                    class="team-remove-btn"
                    type="button"
                    :title="`Remove TEAM ${group.allyTeamId} — no commander is on it`"
                    @click.stop="emit('removeAllyTeam', group.allyTeamId)"
                  >−</button>
                </div>
                <ul class="player-list">
              <li
                v-for="seat in group.seats"
                :key="seat.player.playerId"
                class="player-item"
                :class="{ 'is-local': seat.player.playerId === localPlayerId }"
              >
                <CommanderAvatar
                  :color="seat.playerColor"
                  :size="44"
                />
                <!-- Player info. The local user's row owns the only
                     name-edit entry point; remote slots render the
                     name broadcast by that player. -->
                <div class="player-info">
                  <div class="player-name-row">
                    <span class="player-name">{{ seat.player.name }}</span>
                    <button
                      v-if="seat.player.playerId === localPlayerId"
                      class="player-name-edit-btn"
                      type="button"
                      title="Edit username"
                      aria-label="Edit username"
                      @click="openNameEditor"
                    >
                      Edit
                    </button>
                  </div>
                  <span v-if="seat.player.location" class="player-location">{{ seat.player.location }}</span>
                  <span v-if="seat.player.ipAddress" class="player-ip">{{ seat.player.ipAddress }}</span>
                  <span
                    v-if="seat.player.localTime"
                    class="player-time"
                  >{{ seat.player.localTime }}</span>
                </div>
                <!-- The host's controls for this seat. No TEAM label here:
                     the row already sits inside its side's band, so printing
                     the number again on the right was the same fact twice. -->
                <div v-if="isHost" class="player-controls">
                  <button
                    class="player-control-btn"
                    type="button"
                    :title="`Move ${seat.player.name} to the next team`"
                    @click="emit('cycleMemberAllyTeam', memberIdForSeat(seat.player.playerId))"
                  >MOVE</button>
                  <!-- The host's own seat has no bench button: a lobby with
                       nobody in it is not a lobby. -->
                  <button
                    v-if="!seat.player.isHost"
                    class="player-control-btn"
                    type="button"
                    :title="`Move ${seat.player.name} back to the watchers`"
                    @click="emit('toggleMemberSeated', memberIdForSeat(seat.player.playerId))"
                  >BENCH</button>
                </div>
                <!-- Badges pinned to the right edge of the row. HOST anchors
                     top-right, YOU bottom-right, whether or not the other is
                     present. -->
                <div class="player-badges">
                  <span v-if="seat.player.isHost" class="host-badge">HOST</span>
                  <span v-if="seat.player.playerId === localPlayerId" class="you-badge">YOU</span>
                </div>
              </li>
                  <!-- A declared side with nobody on it. It is not a gap in
                       the list: the match still carves its slice, deposits
                       and spawn arc, so the host can see the ground they
                       just made before anyone stands on it. -->
                  <li v-if="group.seats.length === 0" class="player-item team-empty">
                    <span class="team-empty-text">EMPTY — slice carved, no commander</span>
                  </li>
                </ul>
              </li>
            </ul>

            <!-- The bench. Everyone joins here; only the host moves anybody
                 onto a team, which is why there is no control on this list
                 for anyone else. -->
            <div class="spectator-section">
              <div class="spectator-heading">
                WATCHING
                <span class="spectator-count">{{ spectators.length }}</span>
              </div>
              <ul v-if="spectators.length > 0" class="player-list">
                <li
                  v-for="member in spectators"
                  :key="member.memberId"
                  class="player-item spectator-item"
                  :class="{ 'is-local': member.memberId === localMemberId }"
                >
                  <div class="player-info">
                    <div class="player-name-row">
                      <span class="player-name">{{ member.name }}</span>
                      <button
                        v-if="member.memberId === localMemberId"
                        class="player-name-edit-btn"
                        type="button"
                        title="Edit username"
                        aria-label="Edit username"
                        @click="openNameEditor"
                      >
                        Edit
                      </button>
                    </div>
                    <span v-if="member.location" class="player-location">{{ member.location }}</span>
                    <span v-if="member.localTime" class="player-time">{{ member.localTime }}</span>
                  </div>
                  <div class="player-badges">
                    <button
                      v-if="isHost"
                      class="seat-toggle-btn seat-toggle-btn-add"
                      type="button"
                      :title="`Put ${member.name} on a team`"
                      @click="emit('toggleMemberSeated', member.memberId)"
                    >SEAT</button>
                    <span v-if="member.memberId === localMemberId" class="you-badge">YOU</span>
                  </div>
                </li>
              </ul>
              <p v-else class="spectator-empty">Nobody is watching.</p>
            </div>
          </div>
        </div>

        <div class="lobby-right">
          <!-- What map, and how it is chosen. The eight authored maps are
               offered as pictures of themselves; CUSTOM swaps the grid for
               the full battle-options bar behind it. Two views of the same
               choice, never both at once — so the map picker is not a
               summary of the bar, it is the default way to answer it. -->
          <div class="map-section-header">
            <span class="map-section-title">MAP</span>
            <span class="map-section-current">{{ activePresetName ?? 'CUSTOM' }}</span>
            <button
              class="custom-toggle"
              :class="{ active: customOptionsOpen }"
              type="button"
              :title="customOptionsOpen
                ? 'Back to the map picker'
                : 'Open the full battle options — terrain, rosters, caps'"
              @click="customOptionsOpen = !customOptionsOpen"
            >CUSTOM</button>
          </div>

          <div
            v-show="!customOptionsOpen"
            class="map-grid"
            :class="{ 'bar-readonly': !isHost }"
          >
            <button
              v-for="tile in mapPresetTiles"
              :key="tile.preset.name"
              class="map-tile"
              :class="{ active: tile.active }"
              type="button"
              :title="isHost ? `Play on ${tile.preset.name}` : 'Only the host can change the map'"
              @click="pickPreset(tile.preset)"
            >
              <img
                v-if="!missingThumbnails.has(tile.preset.backdropSlug)"
                class="map-tile-image"
                :src="tile.thumbnailUrl"
                :alt="tile.preset.name"
                loading="lazy"
                @error="markThumbnailMissing(tile.preset.backdropSlug)"
              />
              <span class="map-tile-name">{{ tile.preset.name }}</span>
            </button>
          </div>

          <!-- Battle-config bar. Same component family + flex-wrap
               layout as the bottom DEMO BATTLE bar, just adapted to
               the lobby's right column: small `.control-btn` buttons
               grouped into wrapping `BarControlGroup`s. Non-host
               viewers get the `bar-readonly` pointer-events lock so
               the saturated active palette stays bright. -->
          <div
            v-show="customOptionsOpen"
            class="control-bar terrain-section"
            :class="{ 'bar-readonly': !isHost }"
            :style="terrainSectionVars"
          >
            <div class="bar-info">
              <BarButton
                :active="true"
                class="bar-label"
                :title="isHost ? 'Click to reset every battle setting (units, cap, terrain, FF, fog) to its default value' : 'Only the host can change battle settings'"
                @click="pickResetDefaults"
              >
                <span class="bar-label-text">REAL BATTLE</span
                ><span class="bar-label-hover">DEFAULTS</span>
              </BarButton>
            </div>
            <div class="bar-controls">
              <BarControlGroup>
                <BarLabel>PRESETS:</BarLabel>
                <BarButtonGroup>
                  <BarButton
                    v-for="preset in presets"
                    :key="preset.name"
                    :active="activePresetName === preset.name"
                    :title="isHost ? `Apply preset: ${preset.name}` : 'Only the host can change battle settings'"
                    @click="pickPreset(preset)"
                  >{{ preset.name }}</BarButton>
                </BarButtonGroup>
              </BarControlGroup>
              <BarControlGroup>
                <BarDivider />
                <BarLabel>WIDTH:</BarLabel>
                <BarButtonGroup>
                  <BarButton
                    v-for="opt in mapWidthOptions"
                    :key="opt.label"
                    :active="mapWidthLandCells === opt.valueLandCells"
                    :title="isHost ? `Set map width to ${opt.label} land cells` : 'Only the host can change terrain'"
                    @click="pickMapWidthLandCells(opt.valueLandCells)"
                  >{{ opt.label }}</BarButton>
                </BarButtonGroup>
              </BarControlGroup>
              <BarControlGroup>
                <BarDivider />
                <BarLabel>LENGTH:</BarLabel>
                <BarButtonGroup>
                  <BarButton
                    v-for="opt in mapLengthOptions"
                    :key="opt.label"
                    :active="mapLengthLandCells === opt.valueLandCells"
                    :title="isHost ? `Set map length to ${opt.label} land cells` : 'Only the host can change terrain'"
                    @click="pickMapLengthLandCells(opt.valueLandCells)"
                  >{{ opt.label }}</BarButton>
                </BarButtonGroup>
              </BarControlGroup>
              <BarControlGroup>
                <BarDivider />
                <BarLabel>CENTER:</BarLabel>
                <BarButtonGroup>
                  <BarButton
                    v-for="opt in centerMagnitudeOptions"
                    :key="opt"
                    :active="centerMagnitude === opt"
                    :title="isHost ? `Set the centre dome altitude to ${opt}` : 'Only the host can change terrain'"
                    @click="pickCenterMagnitude(opt)"
                  >{{ opt.toLocaleString() }}</BarButton>
                </BarButtonGroup>
              </BarControlGroup>
              <BarControlGroup>
                <BarDivider />
                <BarLabel>RING:</BarLabel>
                <BarButtonGroup>
                  <BarButton
                    v-for="opt in ringMagnitudeOptions"
                    :key="opt"
                    :active="ringMagnitude === opt"
                    :title="isHost ? `Set the ring crest altitude to ${opt}` : 'Only the host can change terrain'"
                    @click="pickRingMagnitude(opt)"
                  >{{ opt.toLocaleString() }}</BarButton>
                </BarButtonGroup>
              </BarControlGroup>
              <BarControlGroup>
                <BarDivider />
                <BarLabel>DIVIDERS:</BarLabel>
                <BarButtonGroup>
                  <BarButton
                    v-for="opt in dividersMagnitudeOptions"
                    :key="opt"
                    :active="dividersMagnitude === opt"
                    :title="isHost ? `Set the team-separator ridge altitude to ${opt}` : 'Only the host can change terrain'"
                    @click="pickDividersMagnitude(opt)"
                  >{{ opt.toLocaleString() }}</BarButton>
                </BarButtonGroup>
              </BarControlGroup>
              <BarControlGroup>
                <BarDivider />
                <BarLabel>PERIMETER:</BarLabel>
                <BarButtonGroup>
                  <BarButton
                    v-for="opt in perimeterMagnitudeOptions"
                    :key="opt"
                    :active="perimeterMagnitude === opt"
                    :title="isHost ? `Set the map perimeter altitude to ${opt}` : 'Only the host can change terrain'"
                    @click="pickPerimeterMagnitude(opt)"
                  >{{ opt.toLocaleString() }}</BarButton>
                </BarButtonGroup>
              </BarControlGroup>
              <BarControlGroup>
                <BarDivider />
                <BarLabel>PRECEDENCE:</BarLabel>
                <BarButtonGroup>
                  <BarButton
                    v-for="opt in terrainPrecedenceOptions"
                    :key="opt"
                    :active="terrainPrecedence === opt"
                    :title="isHost
                      ? (opt === 'dividers-precedence'
                        ? 'DIVIDERS last: the ridges run out to the map edge, punching through the ring'
                        : 'PERIMETER last: the ring overrides the divider ridges at the rim')
                      : 'Only the host can change terrain'"
                    @click="pickTerrainPrecedence(opt)"
                  >{{ opt === 'dividers-precedence' ? 'DIVIDERS' : 'PERIMETER' }}</BarButton>
                </BarButtonGroup>
              </BarControlGroup>
              <BarControlGroup>
                <BarDivider />
                <BarLabel>D-PLATEAU:</BarLabel>
                <BarButtonGroup>
                  <BarButton
                    v-for="opt in terrainDTerrainOptions"
                    :key="opt"
                    :active="terrainDTerrain === opt"
                    :title="isHost
                      ? (opt === 0
                        ? 'NONE — disable plateau terracing'
                        : `Vertical spacing between plateau levels: ${opt}`)
                      : 'Only the host can change terrain'"
                    @click="pickTerrainDTerrain(opt)"
                  >{{ opt === 0 ? 'NONE' : opt.toLocaleString() }}</BarButton>
                </BarButtonGroup>
              </BarControlGroup>
              <BarControlGroup>
                <BarDivider />
                <BarLabel>PLATEAU WALL:</BarLabel>
                <BarButtonGroup>
                  <BarButton
                    v-for="opt in plateauWallSlopeDegreesOptions"
                    :key="opt"
                    :active="plateauWallSlopeDegrees === opt"
                    :title="isHost
                      ? `D-PLATEAU transition slope angle from horizontal: ${opt} degrees`
                      : 'Only the host can change terrain'"
                    @click="pickPlateauWallSlopeDegrees(opt)"
                  >{{ opt }} DEG</BarButton>
                </BarButtonGroup>
              </BarControlGroup>
              <BarControlGroup>
                <BarDivider />
                <BarLabel>D-DEPOSIT:</BarLabel>
                <BarButtonGroup>
                  <BarButton
                    v-for="opt in metalDepositStepOptions"
                    :key="opt"
                    :active="metalDepositStep === opt"
                    :title="isHost ? `Signed metal-extractor pad altitude step: ${opt} (negative lowers authored levels)` : 'Only the host can change terrain'"
                    @click="pickMetalDepositStep(opt)"
                  >{{ opt.toLocaleString() }}</BarButton>
                </BarButtonGroup>
              </BarControlGroup>
              <BarControlGroup>
                <BarDivider />
                <BarLabel>TERRAIN DETAIL:</BarLabel>
                <BarButtonGroup>
                  <BarButton
                    v-for="opt in terrainDetailOptions"
                    :key="opt"
                    :active="terrainDetail === opt"
                    :title="isHost
                      ? (opt === 0
                        ? 'OFF — one triangle per land cell'
                        : `Fine-triangle subdivisions per land cell: ${opt}`)
                      : 'Only the host can change terrain'"
                    @click="pickTerrainDetail(opt)"
                  >{{ opt === 0 ? 'OFF' : opt.toLocaleString() }}</BarButton>
                </BarButtonGroup>
              </BarControlGroup>
              <BarControlGroup>
                <BarDivider />
                <BarLabel title="Build squares consolidated along each axis into one conservative pathfinding square">PATH CELL:</BarLabel>
                <BarButtonGroup>
                  <BarButton
                    v-for="opt in pathfindingCellConsolidationOptions"
                    :key="opt"
                    :active="pathfindingCellConsolidation === opt"
                    :title="isHost ? `${opt}×${opt} build squares per pathfinding square` : 'Only the host can change pathfinding resolution'"
                    @click="pickPathfindingCellConsolidation(opt)"
                  >{{ opt }}×{{ opt }}</BarButton>
                </BarButtonGroup>
              </BarControlGroup>
              <BarControlGroup>
                <BarDivider />
                <BarLabel title="Authoritative server simulation steps per second; rendering remains independent">SIM TICK:</BarLabel>
                <BarButtonGroup>
                  <BarButton
                    v-for="opt in simulationTickRateOptions"
                    :key="opt"
                    :active="simulationTickRateHz === opt"
                    :title="isHost ? `${opt} authoritative simulation tick${opt === 1 ? '' : 's'} per second` : 'Only the host can change simulation cadence'"
                    @click="pickSimulationTickRate(opt)"
                  >{{ opt }} HZ</BarButton>
                </BarButtonGroup>
              </BarControlGroup>
              <!-- Real-battle config groups. These were previously editable
                   mid-battle on the bottom BATTLE bar; that bar is now
                   demo-only, so the lobby is the single place to set
                   them for an upcoming real game. -->
              <BarControlGroup>
                <BarDivider />
                <BarLabel>UNITS:</BarLabel>
                <BarButton
                  :active="allUnitsActive"
                  :title="isHost ? 'Toggle all unit blueprints on/off' : 'Only the host can change battle settings'"
                  @click="pickToggleAllUnits"
                >ALL</BarButton>
                <BarButtonGroup>
                  <BarButton
                    v-for="ut in unitBlueprintIds"
                    :key="ut"
                    :active="allowedUnitsSet.has(ut)"
                    :title="isHost ? `Toggle ${ut}` : 'Only the host can change battle settings'"
                    @click="pickToggleUnit(ut)"
                  >{{ unitShortName(ut) }}</BarButton>
                </BarButtonGroup>
              </BarControlGroup>
              <BarControlGroup>
                <BarDivider />
                <BarLabel>BUILDINGS:</BarLabel>
                <BarButton
                  :active="allBuildingsActive"
                  :title="isHost ? 'Toggle all building blueprints on/off' : 'Only the host can change battle settings'"
                  @click="pickToggleAllBuildings"
                >ALL</BarButton>
                <BarButtonGroup>
                  <BarButton
                    v-for="bt in buildingBlueprintIds"
                    :key="bt"
                    :active="allowedBuildingsSet.has(bt)"
                    :title="isHost ? `Toggle ${bt}` : 'Only the host can change battle settings'"
                    @click="pickToggleBuilding(bt)"
                  >{{ buildingShortName(bt) }}</BarButton>
                </BarButtonGroup>
              </BarControlGroup>
              <BarControlGroup>
                <BarDivider />
                <BarLabel title="How many sides the map is carved into. A team left empty still gets its own slice, deposits and spawn arc — it just has no commander on it.">TEAMS:</BarLabel>
                <BarButtonGroup>
                  <BarButton
                    v-for="opt in allyTeamCountOptions"
                    :key="opt"
                    :active="allyTeamCount === opt"
                    :title="isHost ? `Carve the map into ${opt} team slice(s)` : 'Only the host can change battle settings'"
                    @click="pickAllyTeamCount(opt)"
                  >{{ opt }}</BarButton>
                </BarButtonGroup>
              </BarControlGroup>
              <BarControlGroup>
                <BarDivider />
                <BarLabel :title="`Total entities (units + buildings) for the match, split evenly across the ${occupiedAllyTeamCount} team(s) that hold seats`">ENTITY CAP:</BarLabel>
                <BarButtonGroup>
                  <BarButton
                    v-for="opt in capOptions"
                    :key="opt"
                    :active="unitCap === opt"
                    :title="isHost ? `Max ${opt.toLocaleString()} entities total — ${Math.floor(opt / occupiedAllyTeamCount).toLocaleString()} per team across ${occupiedAllyTeamCount} team(s)` : 'Only the host can change battle settings'"
                    @click="pickUnitCap(opt)"
                  >{{ opt.toLocaleString() }}</BarButton>
                </BarButtonGroup>
              </BarControlGroup>
              <BarControlGroup>
                <BarDivider />
                <BarLabel>CONVERTER TAX:</BarLabel>
                <BarButtonGroup>
                  <BarButton
                    v-for="opt in converterTaxOptions"
                    :key="opt"
                    :active="Math.abs(converterTax - opt) < 1e-6"
                    :title="isHost ? `Set resource converter tax to ${opt.toFixed(1)}` : 'Only the host can change battle settings'"
                    @click="pickConverterTax(opt)"
                  >{{ opt.toFixed(1) }}</BarButton>
                </BarButtonGroup>
              </BarControlGroup>
            </div>
          </div>
        </div>

        <div v-if="error" class="error-message">{{ error }}</div>

        <!-- Footer carries only Tauri's Exit now that Start / Leave
             moved up to the left column and Defaults moved into the
             options section. Hidden entirely on web (no Exit button to
             show) so the lobby grid doesn't reserve a footer band for
             nothing. -->
        <div v-if="isTauri" class="footer-row">
          <button class="lobby-btn exit-btn" @click="closeCurrentTauriWindow">Exit</button>
        </div>
      </template>

      <div
        v-if="nameModalOpen"
        class="name-edit-backdrop"
        role="presentation"
        @click.self="closeNameEditor"
      >
        <form
          class="name-edit-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="name-edit-title"
          @submit.prevent="commitLocalPlayerName"
        >
          <h2 id="name-edit-title" class="name-edit-title">Username</h2>
          <input
            ref="nameInputEl"
            v-model="editingName"
            class="name-edit-input"
            type="text"
            :maxlength="MAX_NAME_LENGTH"
            spellcheck="false"
            autocomplete="off"
            @keydown.esc.prevent="closeNameEditor"
          />
          <div
            v-if="localPlayer?.location || localPlayer?.ipAddress || localPlayer?.localTime"
            class="name-edit-meta"
          >
            <span v-if="localPlayer?.location">{{ localPlayer.location }}</span>
            <span v-if="localPlayer?.ipAddress">{{ localPlayer.ipAddress }}</span>
            <span v-if="localPlayer?.localTime">{{ localPlayer.localTime }}</span>
          </div>
          <div class="name-edit-actions">
            <button class="lobby-btn cancel-btn" type="button" @click="closeNameEditor">
              Cancel
            </button>
            <button class="lobby-btn host-btn" type="submit" :disabled="!nameCanSave">
              Save
            </button>
          </div>
        </form>
      </div>
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
  box-sizing: border-box;
  text-align: center;
  box-shadow: 0 0 60px rgba(68, 68, 170, 0.25);
  /* The panel is dark, so the DEFAULT ink has to be light. Without this the
   * modal inherits the document's black — every label that deliberately
   * says `color: inherit` (the watcher list, the empty-side notes, the small
   * outline buttons) rendered black on near-black. */
  color: #e6edf7;
}

.lobby-modal:not(.in-lobby) {
  width: 600px;
  height: 380px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

/* GAME LOBBY screen — full-screen two-column layout.
 *   [ LEFT  ] [ PREVIEW ]
 *   [ left  ] [ TERRAIN ]
 *   [        FOOTER       ]
 *
 * Left column (title / share code / players list / actions row at
 * top) spans the top two grid rows; the preview-pane and options
 * stack in the right column; footer (Tauri Exit only) spans both.
 * Row sizing rule: the OPTIONS row sizes to its content (auto), so
 * adding more battle-config rows always claims the space it needs;
 * the PREVIEW row gets the remaining 1fr — i.e. whatever vertical
 * space is left over. The lobby simulation can never push the
 * options off-screen, only the other way around. */
.lobby-modal.in-lobby {
  display: grid;
  grid-template-columns: minmax(320px, 24vw) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) auto auto;
  grid-template-areas:
    "left preview"
    "left terrain"
    "error footer";
  width: 100vw;
  height: 100vh;
  max-width: none;
  min-width: 0;
  /* No inset anywhere. The lobby IS the screen: the live simulation runs
   * edge to edge and the battle options sit flush under it, so nothing is
   * spent on a frame around a full-screen surface. The roster column keeps
   * its own padding because a list of names needs one; the map and the
   * simulation do not. */
  padding: 0;
  gap: 0;
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
  gap: 14px;
  min-height: 0;
  overflow: hidden;
  padding: 18px 18px 14px;
  background: rgba(9, 11, 16, 0.72);
  border-right: 1px solid rgba(120, 140, 165, 0.28);
}

/* Top-of-left-column action row. Leave + Start (or "Waiting for
 * host..." span). Same lobby-btn classes as before — only their
 * position moved. */
.lobby-actions-row {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 12px;
}

.lobby-modal.in-lobby > .lobby-right {
  grid-area: terrain;
  display: flex;
  flex-direction: column;
  gap: 0;
  min-width: 0;
  border-top: 1px solid rgba(120, 140, 165, 0.28);
}

/* Tauri's Exit and the error banner get their own cells in a last row that
 * sizes to content — so on the web, where neither is present, the row
 * collapses to nothing and the simulation keeps the space. */
.lobby-modal.in-lobby > .footer-row {
  grid-area: footer;
  margin: 0;
  padding: 8px 12px;
  justify-content: flex-end;
}

.lobby-modal.in-lobby > .error-message {
  grid-area: error;
  margin: 0;
}

/* When in fullscreen lobby mode the preview-pane lives in the
 * grid's "preview" cell. Fill the cell exactly — no aspect-ratio
 * constraint and no hardcoded max-height — so the preview always
 * yields whatever vertical space the options row needs. The 3D
 * scene inside resizes to whatever container size it finds, so a
 * non-16:9 cell just renders at the cell's actual ratio rather
 * than overflowing into (or stealing space from) the options. */
.lobby-modal.in-lobby > .preview-pane {
  grid-area: preview;
  width: 100%;
  height: 100%;
  margin: 0;
  min-height: 0;
  border: none;
  border-radius: 0;
}

/* Players list in fullscreen mode gets vertical scroll if many
 * players (the default lobby cap is 6, so this is mostly for
 * future-proofing). */
.lobby-modal.in-lobby .players-section {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

/* ============================================================
 * Startup BUDGET ANNIHILATION menu — right-edge sidebar.
 * Mirrors the lobby-controls-sidebar pattern in GameCanvas: a
 * pointer-events:none fixed wrapper so the live demo battle behind
 * it stays clickable, with only the panel + edge toggle re-enabling
 * pointer events. Slides off the right edge when closed, leaving the
 * toggle handle visible at the screen edge.
 * ============================================================ */
.menu-sidebar {
  position: fixed;
  top: 0;
  right: 0;
  /* The bottom controls claim their naturally wrapped height first.
   * This fixed sidebar then occupies only the vertical space left above
   * them, matching the flex-sized game area beside it. */
  bottom: var(--bottom-controls-height, 0px);
  /* Above the top/bottom control bars (z-index 3001) so the sidebar is
   * truly top-level — nothing in the gameplay chrome renders in front
   * of it. Stays below the full-screen loading overlay (3600). */
  z-index: 3500;
  width: min(380px, calc(100vw - 40px));
  pointer-events: none;
  transform: translateX(0);
  transition: transform 0.2s ease;
}

.menu-sidebar:not(.open) {
  transform: translateX(100%);
}

/* Top-right edge handle. Sits at the top of the screen (mirroring the
 * bottom-bars handle at bottom-left) and matches its palette so the two
 * toggles read as the same control. */
.menu-sidebar-toggle {
  position: absolute;
  top: 12px;
  left: -30px;
  width: 30px;
  height: 72px;
  padding: 0;
  background: #12121a;
  border: 1px solid #444;
  border-right: none;
  border-radius: 8px 0 0 8px;
  color: #888;
  cursor: pointer;
  pointer-events: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.menu-sidebar-toggle:hover {
  background: #232330;
  border-color: #777;
  color: #cdd6e0;
}

.menu-sidebar-toggle:active {
  background: #0c0c12;
  border-color: #666;
}

.menu-sidebar-panel {
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding: 30px 26px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 22px;
  text-align: left;
  /* Fully opaque so no demo gameplay shows through behind the panel. */
  background: #0f1218;
  border-left: 1px solid #444;
  box-shadow: -16px 0 38px rgba(0, 0, 0, 0.55);
  pointer-events: auto;
  /* Same reason as `.lobby-modal`: on a near-black panel the inherited
   * document ink is black, so anything that does not name its own colour
   * has to be given a light default here rather than at each site. */
  color: #e6edf7;
}

.menu-sidebar:not(.open) .menu-sidebar-panel {
  visibility: hidden;
}

/* Layout overrides for elements shared with the old centered modal,
 * re-flowed for the vertical left-aligned sidebar column. */
.menu-sidebar-panel .title {
  font-size: 26px;
}

.menu-sidebar-panel .subtitle {
  margin: 6px 0 0;
}

.menu-sidebar-panel .main-actions,
.menu-sidebar-panel .surface-actions {
  width: 100%;
  max-width: none;
  margin: 0;
}

.menu-sidebar-panel .surface-actions {
  justify-content: flex-start;
}

.menu-sidebar-panel .error-message {
  margin-top: 0;
}

.menu-sidebar-panel .footer-row {
  margin-top: auto;
  justify-content: flex-start;
}

/* The byline sits under everything else, at the foot of the column. It is
 * the quietest thing in the panel on purpose — it is authorship, not an
 * action, and it must not compete with the join controls above it. */
.menu-byline {
  display: flex;
  flex-direction: column;
  gap: 4px;
  /* Only claims the leftover space when no Exit row is there to claim it,
   * so it is at the bottom of the column either way. */
  margin-top: auto;
  font-family: monospace;
  font-size: 12px;
  line-height: 1.5;
  color: #667180;
}

.menu-byline-link {
  color: inherit;
  text-decoration: none;
  width: fit-content;
}

.menu-byline-link:hover,
.menu-byline-link:focus-visible {
  color: #b9c4d2;
  text-decoration: underline;
}

/* Open-lobby directory. Solid border rather than the old dashed
 * placeholder — this is real content now, not a reserved slot. */
.lobby-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid #3a4452;
  border-radius: 10px;
  /* The list is the one part of the sidebar that grows without bound, so it
   * scrolls internally instead of pushing the buttons below it off-screen. */
  max-height: 40vh;
  overflow-y: auto;
}

.lobby-list-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.lobby-list-label {
  font-family: monospace;
  font-size: 12px;
  letter-spacing: 2px;
  color: #8893a3;
}

.lobby-list-count {
  font-family: monospace;
  font-size: 12px;
  color: #44aa44;
}

.lobby-list-hint {
  margin: 0;
  font-family: monospace;
  font-size: 12px;
  line-height: 1.5;
  color: #67707d;
}

.lobby-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.lobby-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  font-family: monospace;
  text-align: left;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid #3a4452;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.lobby-row:hover {
  background: rgba(68, 170, 68, 0.15);
  border-color: #44aa44;
}

/* A running game is information, not an action: no pointer, no hover. */
.lobby-row-running {
  cursor: default;
  opacity: 0.65;
}

.lobby-row-running:hover {
  background: rgba(255, 255, 255, 0.04);
  border-color: #3a4452;
}

.lobby-row-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.lobby-row-name {
  font-size: 13px;
  color: #d8dee6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lobby-row-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 11px;
  color: #67707d;
}

.lobby-row-code {
  letter-spacing: 1px;
  color: #8893a3;
}

.lobby-row-players {
  flex-shrink: 0;
  font-size: 13px;
  color: #8893a3;
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

.preview-loading-overlay {
  position: absolute;
  inset: 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 18px;
  background: rgba(5, 7, 10, 0.9);
  color: #edf3ff;
  text-align: center;
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

.surface-actions {
  display: flex;
  justify-content: center;
  gap: 12px;
  width: 220px;
  max-width: calc(100vw - 64px);
  margin: 10px auto 0;
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

.secondary-surface-btn {
  padding: 2px 0;
  border: none;
  background: transparent;
  color: rgba(170, 180, 192, 0.72);
  font-family: monospace;
  font-size: 11px;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.secondary-surface-btn:hover {
  color: rgba(220, 230, 238, 0.92);
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

.room-code-row {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
}

.room-code {
  flex: 1;
  font-family: monospace;
  font-size: 22px;
  color: #4a9eff;
  letter-spacing: 5px;
  font-weight: bold;
  user-select: all;
  text-shadow: 0 0 10px rgba(74, 158, 255, 0.4);
}

.copy-btn {
  font-size: 14px;
  width: 26px;
  height: 26px;
  padding: 0;
  background: rgba(74, 158, 255, 0.2);
  border: 1px solid #4a9eff;
  border-radius: 6px;
  color: #4a9eff;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
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
  margin-bottom: 0;
}

.players-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 0 0 10px;
}

.players-title {
  font-family: monospace;
  font-size: 15px;
  color: #aeb9c8;
  margin: 0;
}

.team-add-btn {
  flex: 0 0 auto;
  padding: 3px 9px;
  font-family: monospace;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #9fd0ff;
  background: rgba(74, 158, 255, 0.14);
  border: 1px solid rgba(74, 158, 255, 0.45);
  border-radius: 5px;
  cursor: pointer;
}

.team-add-btn:hover:not(:disabled) {
  background: rgba(74, 158, 255, 0.3);
  border-color: #4a9eff;
  color: #fff;
}

.team-add-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ── Lobby identity: the name, then the code ───────────────────────────── */

.lobby-identity {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.lobby-name-input,
.lobby-name-static {
  width: 100%;
  margin: 0;
  padding: 7px 10px;
  font-family: monospace;
  font-size: 19px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: #ffffff;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(120, 140, 165, 0.3);
  border-radius: 8px;
  box-sizing: border-box;
}

.lobby-name-input {
  outline: none;
  caret-color: currentColor;
}

.lobby-name-input::placeholder {
  color: #6d7a8b;
  font-weight: 400;
}

.lobby-name-input:hover {
  border-color: rgba(120, 140, 165, 0.55);
}

.lobby-name-input:focus {
  border-color: #4a9eff;
  background: rgba(0, 0, 0, 0.45);
}

.lobby-name-static {
  background: transparent;
  border-color: transparent;
  padding-left: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.room-code-label {
  font-family: monospace;
  font-size: 11px;
  letter-spacing: 0.16em;
  color: #7d8899;
}

/* ── Host controls on a seat row ───────────────────────────────────────── */

.player-controls {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex-shrink: 0;
}

.player-control-btn {
  padding: 2px 7px;
  font-family: monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #c3cddb;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.24);
  border-radius: 4px;
  cursor: pointer;
}

.player-control-btn:hover,
.player-control-btn:focus-visible {
  background: rgba(255, 255, 255, 0.16);
  border-color: rgba(255, 255, 255, 0.6);
  color: #ffffff;
  outline: none;
}

/* The options bar is flush with the column: no card border, no rounding, no
 * outer margin. It scrolls inside itself so adding more controls can never
 * push the live simulation off the screen. */
.lobby-modal.in-lobby > .lobby-right > .control-bar {
  margin: 0;
  border: none;
  border-radius: 0;
  align-items: flex-start;
  /* Same band height the map grid claims, so switching between the two
   * views does not resize the live simulation above them. */
  max-height: clamp(190px, 32vh, 400px);
  overflow-y: auto;
}

/* ── Map picker ────────────────────────────────────────────────────────── */

.map-section-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  background: rgba(9, 11, 16, 0.72);
  border-bottom: 1px solid rgba(120, 140, 165, 0.22);
}

.map-section-title {
  font-family: monospace;
  font-size: 11px;
  letter-spacing: 0.18em;
  color: #7d8899;
}

.map-section-current {
  flex: 1;
  min-width: 0;
  font-family: monospace;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: #e6edf7;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.custom-toggle {
  flex: 0 0 auto;
  padding: 3px 12px;
  font-family: monospace;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: #c3cddb;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.24);
  border-radius: 5px;
  cursor: pointer;
}

.custom-toggle:hover {
  background: rgba(255, 255, 255, 0.16);
  border-color: rgba(255, 255, 255, 0.6);
  color: #ffffff;
}

.custom-toggle.active {
  background: rgba(74, 158, 255, 0.28);
  border-color: #4a9eff;
  color: #ffffff;
}

/* Four across, two down — the eight authored maps, whole, with nothing
 * between them but a hairline. The tiles carry the choice; the row of names
 * they replaced is still available under CUSTOM. */
.map-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  /* Exactly two rows, both the same height. The band's own height is what
   * bounds the tiles — not the tiles' aspect ratio — so the live simulation
   * above always keeps the larger share of the screen no matter how wide
   * the window is. */
  grid-template-rows: repeat(2, minmax(0, 1fr));
  height: clamp(190px, 32vh, 400px);
  gap: 2px;
  padding: 2px;
  background: rgba(9, 11, 16, 0.72);
}

.map-tile {
  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  padding: 0;
  overflow: hidden;
  background: #0b0f14;
  border: 2px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  transition: border-color 0.15s ease, filter 0.15s ease;
}

/* Host-locked, the same way the options bar locks: the tiles keep their full
 * colour so a joiner sees exactly the map the host picked, they just do not
 * answer a click. (`bar-readonly` in barControls.css only reaches
 * `.control-btn`, and a map tile is a picture, not a bar button.) */
.map-grid.bar-readonly .map-tile {
  pointer-events: none;
  cursor: default;
}

.map-tile:hover {
  border-color: rgba(255, 255, 255, 0.45);
  filter: brightness(1.15);
}

.map-tile.active {
  border-color: #4a9eff;
  filter: brightness(1.1);
}

.map-tile-image {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.map-tile-name {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 4px 6px;
  font-family: monospace;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: #ffffff;
  text-align: left;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);
  background: linear-gradient(to top, rgba(0, 0, 0, 0.78), rgba(0, 0, 0, 0));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.map-tile.active .map-tile-name {
  color: #cfe6ff;
}

.team-list,
.player-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

/* One block per SIDE. The band spans every seat on that side, which is
 * what makes an alliance read as one thing rather than as N rows that
 * happen to share a badge. */
.team-group {
  display: flex;
  align-items: stretch;
  gap: 10px;
  margin-bottom: 10px;
}

.team-group:last-child {
  margin-bottom: 0;
}

.team-group .player-list {
  flex: 1;
  min-width: 0;
}

.team-group .player-item:last-child {
  margin-bottom: 0;
}

/* The side's own colour, straight from the identity-colour rule the
 * battle uses — not a lobby palette. */
.lobby-row-watch {
  display: block;
  font-size: 9px;
  letter-spacing: 0.08em;
  opacity: 0.6;
}

.lobby-row-running:disabled {
  cursor: default;
  opacity: 0.5;
}

.spectator-section {
  margin-top: 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.12);
  padding-top: 8px;
}

.spectator-heading {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  letter-spacing: 0.1em;
  opacity: 0.7;
  margin-bottom: 4px;
}

.spectator-count {
  opacity: 0.6;
}

.spectator-empty {
  font-size: 11px;
  opacity: 0.45;
  margin: 4px 0 0;
}

.spectator-item {
  padding-left: 8px;
}

.seat-toggle-btn {
  font-size: 10px;
  letter-spacing: 0.08em;
  padding: 2px 6px;
  border-radius: 3px;
  border: 1px solid rgba(255, 255, 255, 0.35);
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.seat-toggle-btn:hover {
  border-color: rgba(255, 255, 255, 0.8);
}

.team-empty {
  justify-content: center;
  opacity: 0.55;
}

.team-empty-text {
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.team-band {
  flex: 0 0 20px;
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 0;
  overflow: hidden;
}

/* Sits inside the band so the control that deletes a side is on the side
 * itself, not in a separate list of team numbers somewhere else. */
.team-remove-btn {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: monospace;
  font-size: 13px;
  line-height: 1;
  color: inherit;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid currentColor;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0.72;
}

.team-remove-btn:hover,
.team-remove-btn:focus-visible {
  background: rgba(0, 0, 0, 0.55);
  opacity: 1;
  outline: none;
}

.team-band-label {
  font-family: monospace;
  font-size: 10px;
  font-weight: bold;
  letter-spacing: 2px;
  /* Inherited from the band's inline style, which picks black or white from
   * the side's own generated colour — see readableInkOn. */
  color: inherit;
  opacity: 0.82;
  writing-mode: vertical-rl;
  text-orientation: mixed;
  white-space: nowrap;
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
  /* Keep rows tight so name + connection diagnostics fit
   * comfortably in the row's 60px min-height. */
}

.player-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.player-info .player-name {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 14px;
  color: #f2f2f2;
  font-weight: bold;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.player-name-edit-btn {
  flex: 0 0 auto;
  padding: 2px 7px;
  background: rgba(74, 158, 255, 0.16);
  border: 1px solid rgba(74, 158, 255, 0.45);
  border-radius: 5px;
  color: #9fd0ff;
  font-family: monospace;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  cursor: pointer;
}

.player-name-edit-btn:hover,
.player-name-edit-btn:focus-visible {
  background: rgba(74, 158, 255, 0.3);
  border-color: #4a9eff;
  color: #fff;
  outline: none;
}

.name-edit-backdrop {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.58);
}

.name-edit-modal {
  width: min(420px, calc(100vw - 48px));
  padding: 24px;
  background: rgba(15, 18, 24, 0.98);
  border: 1px solid rgba(74, 158, 255, 0.45);
  border-radius: 12px;
  box-shadow: 0 0 36px rgba(0, 0, 0, 0.55);
}

.name-edit-title {
  margin: 0 0 14px;
  color: #fff;
  font-family: monospace;
  font-size: 18px;
  text-transform: uppercase;
}

.name-edit-input {
  box-sizing: border-box;
  width: 100%;
  padding: 10px 12px;
  background: rgba(0, 0, 0, 0.32);
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 8px;
  color: #fff;
  font-family: monospace;
  font-size: 18px;
  outline: none;
  caret-color: currentColor;
}

.name-edit-input:focus {
  border-color: #4a9eff;
}

.name-edit-meta {
  display: grid;
  gap: 4px;
  margin-top: 12px;
  color: #cfd7e5;
  font-family: monospace;
  font-size: 12px;
  line-height: 1.35;
}

.name-edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 18px;
}

.name-edit-actions .host-btn {
  width: auto;
}

/* Location: "Mountain View, United States". */
.player-info .player-location {
  font-size: 12px;
  color: #ddd;
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

/* Host-propagated local time + short timezone label. */
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
