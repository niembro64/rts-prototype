<script setup lang="ts">
import { ref, computed, reactive, shallowRef, watch, watchEffect, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { appSurface, sendAppSurface } from '../appSurfaceMachine';
import type { GameInstance } from '../game/createGame';
import type { PlayerId } from '../game/sim/types';
import type { BackgroundBattleState } from '../game/lobby/LobbyManager';
import SelectionPanel from './SelectionPanel.vue';
import TopBar from './TopBar.vue';
import Minimap from './Minimap.vue';
import IdleBuildersPanel from './IdleBuildersPanel.vue';
import UnitStatsOverlay from './UnitStatsOverlay.vue';
import type { UnitStatsOverlayInfo } from '../game/scenes/helpers';
import LobbyModal from './LobbyModal.vue';
import type { LobbyMember, LobbyMemberRole } from '../game/network/NetworkManager';
import type { LobbyBotSeat } from '../types/network';
import type { RealBattleFlowControlReport } from './gameCanvasRealBattleStartup';
import type { LockstepCatchUpProgress } from '../game/architecture/LockstepCatchUp';
import GameCanvasOverlays from './GameCanvasOverlays.vue';
import GameCanvasBattleControlBar from './GameCanvasBattleControlBar.vue';
import GameCanvasServerControlBar from './GameCanvasServerControlBar.vue';
import GameCanvasClientControlBar from './GameCanvasClientControlBar.vue';
import LoadingEmblem from './LoadingEmblem.vue';
import ChevronIcon from './ChevronIcon.vue';
import FullscreenToggleIcon from './FullscreenToggleIcon.vue';
import CaptureControlGrid from './CaptureControlGrid.vue';
import {
  CaptureController,
  type CaptureUiSnapshot,
} from '../game/capture/CaptureController';
import type { CaptureModeId } from '@/captureConfig';
import type {
  GameCanvasBattleControlBarModel,
  GameCanvasClientControlBarModel,
  GameCanvasServerControlBarModel,
} from './gameCanvasControlBarModels';
import type { NetworkServerSnapshotMeta } from '../game/network/NetworkTypes';
import {
  networkManager,
  type NetworkRole,
} from '../game/network/NetworkManager';
import {
  CommandHotkeySequenceResolver,
  type CommandHotkeyId,
} from '../game/input/commandHotkeys';
import { BACKGROUND_UNIT_BLUEPRINT_IDS } from '../game/server/BackgroundBattleStandalone';
import { BUILDING_BLUEPRINT_IDS } from '../types/blueprintIds';
import {
  BATTLE_CONFIG,
  getUnitCap,
  loadStoredCenterMagnitude,
  loadStoredDividersMagnitude,
  loadStoredTerrainDTerrain,
  loadStoredMetalDepositStep,
  loadStoredPlateauWallSlopeDegrees,
  loadStoredTerrainDetail,
  loadStoredPathfindingCellConsolidation,
  loadStoredSimulationTickRate,
  loadStoredPerimeterMagnitude,
  loadStoredRingMagnitude,
  loadStoredTerrainPrecedence,
  loadStoredMapLandDimensions,
  getTerrainLightSmoothAcrossWallBoundary,
  getTerrainLightSmoothing,
  getTerrainSplitWallBoundaryVertices,
  getTerrainTextureSmoothAcrossWallBoundary,
  getTerrainTextureSmoothing,
  setTerrainLightSmoothAcrossWallBoundary,
  setTerrainLightSmoothing,
  setTerrainSplitWallBoundaryVertices,
  setTerrainTextureSmoothAcrossWallBoundary,
  setTerrainTextureSmoothing,
  syncTerrainRenderSmoothingSettings,
  type BattleMode,
} from '../battleBarConfig';
import { DEMO_CONFIG } from '../demoConfig';
import type {
  NetworkCommunicationDraft,
  NetworkCommunicationEvent,
} from '../types/network';
import ChatConsole from './ChatConsole.vue';
import type { ChatChannelOption, ChatConsoleMessage } from './chatConsoleTypes';
import { GlobalChatClient, type GlobalChatMessage } from '../game/network/GlobalChatClient';
import { getInitialLocalUsername } from '../playerNamesConfig';
import {
  SERVER_CONFIG,
  loadStoredUnitGroundNormalEmaMode,
} from '../serverBarConfig';
import {
  PRESENTATION_SNAPSHOT_RATE_DEFAULT,
} from '../presentationSnapshotConfig';
import type { UnitGroundNormalEmaMode } from '../shellConfig';
import { getPlayerColor } from './uiUtils';
import type { GameServer } from '../game/server/GameServer';
import type { GameConnection } from '../game/server/GameConnection';
import type { CameraFovDegrees, CameraViewMode } from '../types/client';
import {
  resolveGameCanvasChromeVisibility,
  resolveGameCanvasPresentationPhase,
  setPlayerClientRenderEnabled,
  useGameCanvasChromeState,
} from './gameCanvasChromeState';
import { useGameCanvasTelemetry } from './gameCanvasTelemetry';
import { useGameCanvasBackgroundBattle } from './gameCanvasBackgroundBattle';
import { useGameCanvasPresence } from './gameCanvasPresence';
import { useGameCanvasEntityLabHotkey } from './gameCanvasEntityLabHotkey';
import { useGameCanvasRealBattleLifecycle } from './gameCanvasRealBattleLifecycle';
import { useGameCanvasForegroundSceneBinding } from './gameCanvasForegroundSceneBinding';
import { useGameCanvasForegroundGame } from './gameCanvasForegroundGame';
import { useGameCanvasLobbyPreview } from './gameCanvasLobbyPreview';
import { useGameCanvasLobbyActions } from './gameCanvasLobbyActions';
import { useGameCanvasLobbySettings } from './gameCanvasLobbySettings';
import { useGameCanvasBattleSettings } from './gameCanvasBattleSettings';
import {
  BATTLE_PRESETS,
  resolveBattleMapPresentation,
} from './battlePresets';
import type { TerrainPrecedence } from '../types/terrainPrecedence';
import { setActiveBackdropPresetName } from '../game/render3d/presetBackdrops';
import { setActiveMapPresetLabel } from '../game/render3d/presetMapLabel';
import { useGameCanvasServerSettings } from './gameCanvasServerSettings';
import { useGameCanvasClientSettings } from './gameCanvasClientSettings';
import { useGameCanvasRealBattleHandoff } from './gameCanvasRealBattleHandoff';
import { useGameCanvasSceneUi } from './gameCanvasSceneUi';
import { useGameCanvasSessionLifecycle } from './gameCanvasSessionLifecycle';
import { useGameCanvasHostEviction } from './gameCanvasHostEviction';
import { useGameCanvasPeerLag } from './gameCanvasPeerLag';
import NetworkPeerLagIndicator from './NetworkPeerLagIndicator.vue';
import NetworkMatchHoldBanner from './NetworkMatchHoldBanner.vue';
import SpectatorViewBar from './SpectatorViewBar.vue';
import SpectatorTeamOverlay from './SpectatorTeamOverlay.vue';
import { ARCHITECTURE_CONFIG } from '../architectureConfig';
import { useGameCanvasShellDisplay } from './gameCanvasShellDisplay';
import { useGameCanvasLobbyRoster } from './gameCanvasLobbyRoster';
import {
  HUD_MINIMAP_FOLLOW_TOP_PX,
  HUD_MINIMAP_MAX_PX,
  HUD_MINIMAP_STACK_GAP_PX,
} from './hudLayout';
import { LAND_CELL_SIZE } from '../mapSizeConfig';

const isMobile =
  /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent,
  );


const containerRef = ref<HTMLDivElement | null>(null);
const backgroundContainerRef = ref<HTMLDivElement | null>(null);
// The original DOM home of `backgroundContainerRef`. The watcher
// below moves the container between this element and the lobby
// modal's preview slot (`#lobby-preview-target`). Captured as a
// ref so the watcher doesn't depend on selector lookups.
const gameAreaRef = ref<HTMLDivElement | null>(null);
const bottomControlsRef = ref<HTMLDivElement | null>(null);
const playableBottomInsetPx = ref(0);
const activePlayer = ref<PlayerId>(1);
const fullscreenActive = ref(false);
const uiChromeVisible = ref(true);
const mapDetailsVisible = ref(false);
const optionsMenuOpen = ref(false);
const gameOverWinner = ref<PlayerId | null>(null);
const battleLoading = ref(false);
const rendererWarmupLoading = ref(true);
const showLoadingOverlay = computed(() => battleLoading.value || rendererWarmupLoading.value);
const activeSurfaceLoading = computed(
  () => gameStarted.value ? battleLoading.value : showLoadingOverlay.value,
);
const loadingProgress = ref(0);
const loadingPhase = ref('Preparing battle');
/**
 * A peer replaying its way into a running match owns the loading overlay for
 * the whole replay, because that IS the load: it is stepping the simulation
 * from frame 0 to now, and there is nothing to render until it arrives.
 *
 * The measured rate is shown rather than hidden. Replay speed is bounded by
 * simulation step cost, so a big match on a slow machine may genuinely not be
 * joinable — a player watching the number fall towards 1.0x can see why, and
 * the join is refused with it rather than spinning forever.
 */
const displayedLoadingProgress = computed(() =>
  catchUpProgress.value === null ? loadingProgress.value : catchUpProgress.value.fraction,
);
const displayedLoadingPhase = computed(() => {
  const catchUp = catchUpProgress.value;
  if (catchUp === null) return loadingPhase.value;
  if (catchUp.state === 'requesting') return 'Asking to join the battle';
  if (catchUp.state === 'verifying') return 'Checking against the host';
  if (catchUp.state === 'failed') return 'Could not join the battle';
  const eta = catchUp.etaSeconds === null
    ? ''
    : ` — about ${Math.max(1, Math.round(catchUp.etaSeconds))}s left`;
  return (
    `Replaying the battle: frame ${catchUp.currentFrame} of ${catchUp.targetFrame}` +
    ` (${catchUp.rateRealtime.toFixed(1)}x)${eta}`
  );
});
const gameWrapperStyle = computed(() => ({
  '--hud-minimap-max': `${HUD_MINIMAP_MAX_PX}px`,
  '--hud-minimap-gap': `${HUD_MINIMAP_STACK_GAP_PX}px`,
  '--hud-minimap-follow-top': `${HUD_MINIMAP_FOLLOW_TOP_PX}px`,
  '--bottom-controls-height': `${playableBottomInsetPx.value}px`,
}));

function setLoadingProgress(progress: number, phase?: string): void {
  if (!Number.isFinite(progress)) {
    loadingProgress.value = 0;
    loadingPhase.value = phase ?? 'Preparing battle';
    return;
  }
  const clamped = Math.max(0, Math.min(1, progress));
  if (clamped <= 0) {
    loadingProgress.value = 0;
    loadingPhase.value = phase ?? 'Preparing battle';
    return;
  }
  if (phase && clamped >= loadingProgress.value) {
    loadingPhase.value = phase;
  }
  loadingProgress.value = Math.max(loadingProgress.value, clamped);
}

let getBackgroundBattle = (): BackgroundBattleState | null => null;
let startBackgroundBattle = async (): Promise<void> => {};
let stopBackgroundBattle = (): void => {};
let waitForBackgroundBattleIdle = async (): Promise<void> => {};

// Current game server (owned by this component)
let currentServer: GameServer | null = null;
const realBattleLifecycle = useGameCanvasRealBattleLifecycle();
const foregroundSceneBinding = useGameCanvasForegroundSceneBinding();
const foregroundGame = useGameCanvasForegroundGame();

// Lobby state
const showLobby = ref(true);
const isHost = ref(false);
const roomCode = ref('');
/** Everyone attached, watchers included. The seated projection is derived
 *  from it (`lobbyPlayers`) rather than stored beside it, so the two can
 *  never drift. */
const lobbyMembers = ref<LobbyMember[]>([]);
/** Bot seats beside the members, adopted from the same atomic roster
 *  announcement (src/game/sim/agentSeat.ts). */
const lobbyBotSeats = ref<LobbyBotSeat[]>([]);

function cycleBotAllyTeam(playerId: PlayerId): void {
  const bot = lobbyBotSeats.value.find((b) => b.playerId === playerId);
  if (bot === undefined) return;
  const sides = networkManager.lobbyAllyTeamCount();
  const next = bot.allyTeamId >= sides ? 1 : bot.allyTeamId + 1;
  networkManager.setBotSeatAllyTeam(playerId, next);
}
const winningAllyTeamName = computed(() => {
  if (gameOverWinner.value === null) return '';
  const winner = lobbyPlayers.value.find((player) => player.playerId === gameOverWinner.value);
  return `Team ${winner?.allyTeamId ?? gameOverWinner.value}`;
});

/** Host-only: move a seat to the next side, wrapping at the lobby's side
 *  count. The host is authoritative — NetworkManager re-announces the whole
 *  roster, and every client's list is replaced from that announcement rather
 *  than patched from a local guess. */
function cycleMemberAllyTeam(memberId: number): void {
  if (!isHost.value) return;
  const sides = networkManager.lobbyAllyTeamCount();
  const current = lobbyMembers.value.find((m: LobbyMember) => m.memberId === memberId)?.allyTeamId ?? 1;
  const next = (current % Math.max(1, sides)) + 1;
  networkManager.setMemberAllyTeam(memberId, next);
  lobbyMembers.value = networkManager.getMembers();
}

/**
 * Why the match is currently stopped, or null while it is running.
 *
 * Distinct from the lag indicator: that names who is BEHIND, this names who
 * the match is being HELD for. A watcher can never appear here — it holds no
 * seat, so flow control never sees it.
 */
const matchHold = ref<RealBattleFlowControlReport | null>(null);
/** Replay progress while joining a match already in progress, or null when
 *  this client started at frame 0 and has nothing to catch up on. */
const catchUpProgress = ref<LockstepCatchUpProgress | null>(null);
/** Handed to us by the backend so the heartbeat's silence signal can reach
 *  flow control. Only the coordinator ever receives one. */
let markSeatedPlayerSilent: ((playerId: PlayerId) => void) | null = null;
let markSeatedPlayerReturned: ((playerId: PlayerId) => void) | null = null;

/**
 * The seat a WATCHER is looking through, or null for the whole battle.
 *
 * Purely local, and never command authority: every peer already holds the
 * complete world, so this is a filtering choice and nobody else is told.
 */
const watchingPlayerId = ref<PlayerId | null>(null);
/** Bumped on every snapshot so the spectator overlay re-reads the economy.
 *  The economy singleton is not reactive, and making it so for one overlay
 *  would put Vue in the simulation's way. */

/**
 * How many units and buildings a seat owns.
 *
 * Read from the LOCAL simulation, not from the filtered snapshot: in
 * deterministic lockstep every peer runs the whole authoritative world, so a
 * watcher can count anybody's army without asking and without the number
 * changing depending on whose vision it happens to be borrowing.
 */
function spectatorEntityCountFor(playerId: PlayerId): number {
  const world = currentServer?.getLockstepSimulationCore().world;
  if (world === undefined) return 0;
  return world.getUnitsByPlayer(playerId).length + world.getBuildingsByPlayer(playerId).length;
}

/** Forget everything about watching. A view target, a pause banner and a
 *  replay bar all describe a match that no longer exists. */
function resetSpectatorState(): void {
  watchingPlayerId.value = null;
  matchHold.value = null;
  catchUpProgress.value = null;
  localRole.value = 'spectator';
}

function watchPlayer(playerId: PlayerId | null): void {
  watchingPlayerId.value = playerId;
  foregroundGame.getScene()?.watchPlayer(playerId ?? undefined);
  if (playerId !== null) {
    localPlayerId.value = playerId;
    activePlayer.value = playerId;
  }
}

/** Seat -> the member holding it. The roster is keyed by member, so a
 *  control rendered on a seated row has to resolve back to one. */
const seatedMemberIds = computed<Record<number, number>>(() => {
  const out: Record<number, number> = {};
  for (const member of lobbyMembers.value) {
    if (member.playerId === undefined) continue;
    out[member.playerId] = member.memberId;
  }
  return out;
});

/** Host-only: move a watcher onto a team, or a player back to the bench.
 *  The only route between the two — a user can never move themselves. */
function toggleMemberSeated(memberId: number): void {
  if (!isHost.value) return;
  const member = lobbyMembers.value.find((m: LobbyMember) => m.memberId === memberId);
  if (member === undefined) return;
  networkManager.setMemberSeated(memberId, member.playerId === undefined);
  lobbyMembers.value = networkManager.getMembers();
}

/** Host-only: how many sides the map is carved into. Empty sides are kept —
 *  they carve a slice with no commander on it — so this is a real map choice
 *  and rides `lobbySettings` out to every client like any other. */
const lobbyAllyTeamCount = ref(networkManager.lobbyAllyTeamCount());

/** What the host called this lobby. Session state like every other real-
 *  battle setting: it belongs to one lobby, so it is never persisted and it
 *  is cleared on the way in. */
const lobbyName = ref('');

function setLobbyAllyTeamCount(count: number): void {
  if (!isHost.value) return;
  networkManager.setLobbyAllyTeamCount(count);
  lobbyAllyTeamCount.value = networkManager.lobbyAllyTeamCount();
  lobbyMembers.value = networkManager.getMembers();
  broadcastLobbySettingsIfHost();
}

/** Host-only: declare one more side. Capped by the roster's own ceiling — a
 *  side per seat is already the most any lobby can occupy. */
function addLobbyAllyTeam(): void {
  setLobbyAllyTeamCount(lobbyAllyTeamCount.value + 1);
}

/** Host-only: delete one EMPTY side. NetworkManager refuses a side that
 *  holds a seat, so the button on an occupied team can only ever be a
 *  no-op — the check is there, not here. */
function removeLobbyAllyTeam(allyTeamId: number): void {
  if (!isHost.value) return;
  if (!networkManager.removeLobbyAllyTeam(allyTeamId)) return;
  lobbyAllyTeamCount.value = networkManager.lobbyAllyTeamCount();
  lobbyMembers.value = networkManager.getMembers();
  broadcastLobbySettingsIfHost();
}

function setLobbyName(name: string): void {
  if (!isHost.value) return;
  applyLobbyName(name);
}

/** A name belongs to one lobby. Leaving clears it so the next lobby this
 *  browser hosts starts unnamed instead of inheriting the last one's title —
 *  the same rule every other real-battle setting follows. */
watch(roomCode, (code) => {
  if (code === '') lobbyName.value = '';
});
/** The seat this client VIEWS as. For a player it is their own seat; for a
 *  watcher it is whoever they are following — a local choice, never command
 *  authority. */
const localPlayerId = ref<PlayerId>(1);
/** Whether this client holds a seat at all. Command authority follows this,
 *  never the view above. */
const localRole = ref<LobbyMemberRole>('spectator');
const lobbyError = ref<string | null>(null);
const isConnecting = ref(false);
const gameStarted = ref(false);
const currentBattleMode = computed<BattleMode>(
  () => (gameStarted.value || roomCode.value !== '' ? 'real' : 'demo'),
);

const {
  localUsername,
  lobbyPlayers,
  lobbySpectators,
  resolvePlayerName,
  resolveMemberName,
  onPlayerNameChange,
} = useGameCanvasLobbyRoster({
  lobbyBotSeats,
  network: networkManager,
  currentBattleMode,
  lobbyMembers,
  localPlayerId,
});
const {
  mobileBarsVisible,
  menuHidden,
  bottomBarsCollapsed,
  playerClientEnabled,
  toggleBottomBars,
  togglePlayerClientEnabled,
  toggleMenuHidden,
} = useGameCanvasChromeState(currentBattleMode, applyPlayerClientEnabled);

// The sidebar's open/closed state is restored from localStorage by
// useGameCanvasChromeState, which is what lets it persist across reloads.
// The sidebar is CHROME within the home surface, not navigation, so a
// re-entry from the lab or the controls screen surfaces the menu (that is
// what "Home" on their nav means) while leaving the saved preference alone
// (never via toggleMenuHidden).
if (appSurface.value === 'home') {
  menuHidden.value = false;
}

function toggleUiChrome(): void {
  uiChromeVisible.value = !uiChromeVisible.value;
}

function toggleMapDetails(): void {
  mapDetailsVisible.value = !mapDetailsVisible.value;
}

function toggleOptionsMenu(): void {
  optionsMenuOpen.value = !optionsMenuOpen.value;
}

function getActiveOrbitCamera(): import('../game/render3d/OrbitCamera').OrbitCamera | null {
  return foregroundGame.getScene()?.getOrbitCamera() ?? null;
}
const networkRole = ref<NetworkRole | null>(null);
const hasServer = ref(false); // True when we own a GameServer (host/offline/background)
const networkNotice = ref<string | null>(null);
// Server metadata received from snapshots for display reconciliation.
const serverMetaFromSnapshot = ref<NetworkServerSnapshotMeta | null>(null);

const spectatorOverlayRevision = ref(0);
// serverMetaFromSnapshot is replaced wholesale on every presentation snapshot,
// so watching it is the cheapest honest "something moved" signal there is.
watch(serverMetaFromSnapshot, () => {
  spectatorOverlayRevision.value++;
});

const {
  lobbyPlayerCount,
  networkStatus,
  localLobbyPlayer,
  lobbyModalVisible,
  showServerControls,
  serverBarReadonly,
  battleBarVars,
  serverBarVars,
  clientBarVars,
  battleLabel,
  serverLabel,
  clientLabel,
} = useGameCanvasShellDisplay({
  currentBattleMode,
  isMobile,
  showLobby,
  menuHidden,
  gameStarted,
  roomCode,
  lobbyPlayers,
  localPlayerId,
  networkRole,
  networkNotice,
  hasServer,
  serverMetaFromSnapshot,
});

// The startup BUDGET ANNIHILATION screen is now a non-blocking sidebar
// (see LobbyModal). Only the connecting / in-lobby screens are still
// full-screen blocking modals, so only those and explicit loading phases
// should hide the demo game chrome and bottom bars. The startup sidebar
// leaves the demo fully visible and interactive whether it is open or
// closed.
const lobbyFullscreenVisible = computed(
  () => lobbyModalVisible.value && (isConnecting.value || roomCode.value !== ''),
);
// The startup BUDGET ANNIHILATION sidebar is mounted and slid open. The
// sidebar is a top-level opaque layer, so when it is open we inset the
// demo's top/bottom bars to its left edge — nothing renders under it.
const menuSidebarOpen = computed(
  () => lobbyModalVisible.value && !lobbyFullscreenVisible.value,
);
const presentationPhase = computed(() =>
  resolveGameCanvasPresentationPhase({
    currentBattleMode: currentBattleMode.value,
    gameStarted: gameStarted.value,
    lobbyFullscreenVisible: lobbyFullscreenVisible.value,
    loading: activeSurfaceLoading.value,
    playerClientEnabled: playerClientEnabled.value,
  }),
);
const chromeVisibility = computed(() =>
  resolveGameCanvasChromeVisibility({
    phase: presentationPhase.value,
    uiChromeVisible: uiChromeVisible.value,
    isMobile,
    mobileBarsVisible: mobileBarsVisible.value,
    lobbyFullscreenVisible: lobbyFullscreenVisible.value,
  }),
);
const topChromeVisible = computed(() => chromeVisibility.value.topBar);
const bottomChromeVisible = computed(() => chromeVisibility.value.bottomBars);
const gameplayHudVisible = computed(() => chromeVisibility.value.gameplayHud);
const overlayControlsVisible = computed(() => chromeVisibility.value.overlayControls);
const playerClientOffOverlayVisible = computed(() => chromeVisibility.value.playerClientOffOverlay);
const loadingInLobbyPreview = computed(() => presentationPhase.value === 'lobby-preview-loading');
const showDemoLoadingOverlay = computed(
  () => presentationPhase.value === 'background-loading',
);
const showRealLoadingOverlay = computed(
  () => presentationPhase.value === 'real-battle-loading',
);
const loadingNextLabel = computed(() => {
  if (gameStarted.value) return 'LOADING ONLINE BATTLE';
  if (currentBattleMode.value === 'real') return 'LOADING LOBBY SIMULATION';
  return 'LOADING DEMO BATTLE';
});
const lobbyControlsSidebarOpen = ref(false);
const showLobbyControlsSidebar = computed(
  () => uiChromeVisible.value && !isMobile && lobbyFullscreenVisible.value,
);
watch(showLobbyControlsSidebar, (visible) => {
  if (!visible) lobbyControlsSidebarOpen.value = false;
});

let bottomControlsResizeObserver: ResizeObserver | null = null;

function updatePlayableBottomInset(): void {
  if (!bottomChromeVisible.value || (!isMobile && bottomBarsCollapsed.value)) {
    playableBottomInsetPx.value = 0;
    return;
  }
  const controls = bottomControlsRef.value;
  if (controls === null) {
    playableBottomInsetPx.value = 0;
    return;
  }
  playableBottomInsetPx.value = Math.max(0, Math.round(controls.getBoundingClientRect().height));
}

watch(bottomControlsRef, (controls, previousControls) => {
  if (previousControls !== null) bottomControlsResizeObserver?.unobserve(previousControls);
  if (controls !== null) bottomControlsResizeObserver?.observe(controls);
  void nextTick(updatePlayableBottomInset);
});

watch(
  [bottomChromeVisible, bottomBarsCollapsed, mobileBarsVisible],
  () => {
    void nextTick(updatePlayableBottomInset);
  },
  { immediate: true },
);


let battleStartTime = 0;
const {
  battleElapsed,
  displayedClientIp,
  displayedClientTime,
  localIpAddress,
  reportLocalPlayerInfo,
} = useGameCanvasPresence({
  currentBattleMode,
  localLobbyPlayer,
  getBattleStartTime: () => battleStartTime,
  getBackgroundBattle: () => getBackgroundBattle(),
  getCurrentServer: () => currentServer,
});

function setInstanceCameraFovDegrees(
  instance: GameInstance | null | undefined,
  fov: CameraFovDegrees,
): void {
  instance?.app.setCameraFovDegrees(fov);
}

const effectivePlayerClientRenderEnabled = computed(
  () => playerClientEnabled.value && !activeSurfaceLoading.value,
);
function applyPlayerClientEnabled(): void {
  const enabled = effectivePlayerClientRenderEnabled.value;
  setPlayerClientRenderEnabled(getBackgroundBattle()?.gameInstance, enabled);
  setPlayerClientRenderEnabled(foregroundGame.getInstance(), enabled);
}
watch(effectivePlayerClientRenderEnabled, () => applyPlayerClientEnabled());

function applyCameraFovDegrees(fov: CameraFovDegrees): void {
  setInstanceCameraFovDegrees(getBackgroundBattle()?.gameInstance, fov);
  setInstanceCameraFovDegrees(foregroundGame.getInstance(), fov);
}

// Active connection for sending commands (set when server/connection is created)
let activeConnection: GameConnection | null = null;

const BAR_VOLUME_STEP_PERCENT = 8;
const BAR_VOLUME_MIN_PERCENT = 0;
const BAR_VOLUME_MAX_PERCENT = 200;

function setGamePaused(paused: boolean): void {
  activeConnection?.sendCommand({ type: 'setPaused', tick: 0, paused });
}

function adjustGameSpeed(direction: 1 | -1): void {
  activeConnection?.sendCommand({ type: 'adjustGameSpeed', tick: 0, direction });
}

function changeMasterVolumeByBarStep(direction: 1 | -1): void {
  const nextVolume = Math.max(
    BAR_VOLUME_MIN_PERCENT,
    Math.min(BAR_VOLUME_MAX_PERCENT, masterVolume.value + (direction * BAR_VOLUME_STEP_PERCENT)),
  );
  changeMasterVolume(nextVolume);
}

function syncFullscreenActive(): void {
  fullscreenActive.value = document.fullscreenElement !== null;
}

async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  } catch (err) {
    console.warn('Fullscreen request failed', err);
  } finally {
    syncFullscreenActive();
  }
}

// Gameplay capture (VID/PIC grid + F12). The controller owns the whole
// lifecycle — clean-frame instrument hiding, fidelity pinning, MediaRecorder,
// display capture, and saving; this component only forwards triggers and
// mirrors the lifecycle into a ref for the grid.
const captureController = new CaptureController({
  getApp: () =>
    foregroundGame.getInstance()?.app ?? getBackgroundBattle()?.gameInstance?.app ?? null,
  getGameArea: () => gameAreaRef.value,
  onChanged: () => syncCaptureUi(),
});
const captureUi = ref<CaptureUiSnapshot>(captureController.getUiSnapshot());

function syncCaptureUi(): void {
  captureUi.value = captureController.getUiSnapshot();
}

function triggerCapture(modeId: CaptureModeId): void {
  captureController.trigger(modeId);
}

/** The historical SHOT button / F12 entry point — now the clean (no-HUD)
 *  screenshot. The old direct canvas.toBlob() path read a non-preserved
 *  drawing buffer outside the render tick and produced blank frames. */
function captureScreenshot(): void {
  triggerCapture('pic-raw');
}

function downloadReplay(): void {
  const server = currentServer ?? getBackgroundBattle()?.server ?? null;
  if (server === null) return;
  const replay = server.exportReplay();
  const blob = new Blob([`${JSON.stringify(replay, null, 2)}\n`], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `budget-annihilation-replay-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function getActiveGameScene() {
  return foregroundGame.getScene() ?? getBackgroundBattle()?.gameInstance?.getScene() ?? null;
}

function goToLastPing(): void {
  getActiveGameScene()?.goToLastPing();
}

function flipCameraYaw(): void {
  getActiveGameScene()?.flipCameraYaw();
}

function showMapOverview(): void {
  getActiveGameScene()?.showMapOverview();
}

function setCameraViewMode(mode: CameraViewMode): void {
  getActiveGameScene()?.setCameraViewMode(mode);
}

function toggleCameraViewMode(): void {
  getActiveGameScene()?.toggleCameraViewMode();
}

function changeCameraViewRadius(direction: 1 | -1): void {
  getActiveGameScene()?.changeCameraViewRadius(direction);
}

function setCameraAnchor(index: number): void {
  getActiveGameScene()?.setCameraAnchor(index);
}

function focusCameraAnchor(index: number): void {
  getActiveGameScene()?.focusCameraAnchor(index);
}

type CommunicationChatEvent = Extract<NetworkCommunicationEvent, { kind: 'chat' }>;

const communicationMessages = ref<CommunicationChatEvent[]>([]);
/** The battle console's OUTGOING room, BAR-style: 'all' is public, 'team'
 *  resolves host-side to allies or the bench. */
const chatChannelId = ref<'all' | 'team'>('all');
const battleChatRef = ref<InstanceType<typeof ChatConsole> | null>(null);
const homeChatRef = ref<InstanceType<typeof ChatConsole> | null>(null);
const globalChatMessages = ref<GlobalChatMessage[]>([]);
const globalChat = new GlobalChatClient();
const gameUiHotkeys = new CommandHotkeySequenceResolver();
let communicationDraftSequence = 0;

function nextCommunicationDraftId(prefix: string): string {
  communicationDraftSequence++;
  return `${prefix}-${Date.now().toString(36)}-${communicationDraftSequence.toString(36)}`;
}

/**
 * The offline echo of something the local player just said.
 *
 * Only used when there is no host to relay through, so the room is whoever is
 * here: nobody else. The networked path stamps the real channel host-side,
 * where the roster that decides it actually lives.
 */
function createLocalCommunicationEvent(
  draft: NetworkCommunicationDraft,
  senderPlayerId: PlayerId,
): NetworkCommunicationEvent {
  return {
    kind: 'chat',
    id: nextCommunicationDraftId('local-chat'),
    channel: 'all',
    senderPlayerId,
    createdAtMs: Date.now(),
    text: draft.text.trim().slice(0, 220),
  };
}

function applyCommunicationEvent(event: NetworkCommunicationEvent): void {
  // The console renders whatever is here and sticks to the bottom on its
  // own; nothing force-opens, BAR-style.
  communicationMessages.value = [...communicationMessages.value.slice(-79), event];
}

function sendCommunicationDraft(draft: NetworkCommunicationDraft): void {
  const role = networkManager.getRole();
  if (role === 'host' || role === 'client') {
    networkManager.sendCommunication(draft);
    return;
  }
  applyCommunicationEvent(createLocalCommunicationEvent(draft, activePlayer.value));
}

function sendBattleChat(text: string): void {
  sendCommunicationDraft({
    kind: 'chat',
    clientEventId: nextCommunicationDraftId('chat'),
    text,
    channel: chatChannelId.value,
  });
}

function sendGlobalChat(text: string): void {
  void globalChat.send(getInitialLocalUsername(), text);
}

function sendLobbyChat(text: string): void {
  // The lobby is one shared room; the host resolves 'all' regardless, but
  // saying it keeps the draft honest.
  sendCommunicationDraft({
    kind: 'chat',
    clientEventId: nextCommunicationDraftId('chat'),
    text,
    channel: 'all',
  });
}

function focusChatConsole(): void {
  if (gameStarted.value) battleChatRef.value?.focusInput();
  else homeChatRef.value?.focusInput();
}

/** The session console's rows — lobby room and battle rooms alike. */
const sessionChatConsoleMessages = computed<ChatConsoleMessage[]>(() =>
  communicationMessages.value.map((message) => ({
    id: message.id,
    senderName: communicationSenderName(message.senderPlayerId),
    senderColor: getPlayerColor(message.senderPlayerId),
    channelTag: message.channel === 'team'
      ? 'TEAM'
      : message.channel === 'spectators'
        ? 'SPEC'
        : gameStarted.value ? 'ALL' : '',
    text: message.text,
  })),
);

const battleChatChannels = computed<ChatChannelOption[]>(() => [
  { id: 'all', label: 'ALL' },
  { id: 'team', label: localRole.value === 'spectator' ? 'SPEC' : 'TEAM' },
]);

const globalChatConsoleMessages = computed<ChatConsoleMessage[]>(() =>
  globalChatMessages.value.map((message) => ({
    id: `global-${message.seq}`,
    senderName: message.name,
    senderColor: '',
    channelTag: '',
    text: message.text,
  })),
);

const GLOBAL_CHAT_CHANNELS: ChatChannelOption[] = [{ id: 'global', label: 'GLOBAL' }];

// The HOME room is served by games.niemo.io — poll it only while the player
// is actually home. Everything network-session chat does stays untouched.
watch(
  () => appSurface.value === 'home',
  (onHome) => {
    if (onHome) {
      globalChat.start((incoming) => {
        globalChatMessages.value = [...globalChatMessages.value, ...incoming].slice(-100);
      });
    } else {
      globalChat.stop();
    }
  },
  { immediate: true },
);

// A NEW session is a new conversation: entering a lobby clears whatever the
// last session (or the home screen's neighbors) left on the console. The
// lobby -> battle transition keeps history — it is the same room splitting.
watch(roomCode, (code, previous) => {
  if (code !== '' && previous === '') communicationMessages.value = [];
});

function handleMinimapInteraction(x: number, y: number): void {
  centerMinimapCamera(x, y);
}

function handleMinimapCommandInteraction(x: number, y: number, queue: boolean): void {
  issueMinimapCommand(x, y, queue);
}

function communicationSenderName(playerId: PlayerId): string {
  return resolvePlayerName(playerId);
}

// ── Hold-I unit stats peek (BAR gui_unit_stats: press shows, release
// hides). The overlay polls the active scene for hovered/selected entity
// stats on a coarse interval instead of hooking per-frame reactivity. ──
const UNIT_STATS_POLL_MS = 150;
const unitStatsOverlayInfo = shallowRef<UnitStatsOverlayInfo | null>(null);
const unitStatsHeld = ref(false);
let unitStatsHoldCode: string | null = null;
let unitStatsPollTimer: ReturnType<typeof setInterval> | null = null;

function refreshUnitStatsOverlay(): void {
  unitStatsOverlayInfo.value = getActiveGameScene()?.getUnitStatsInfo() ?? null;
}

function beginUnitStatsHold(code: string | null): void {
  if (code !== null) unitStatsHoldCode = code;
  if (unitStatsHeld.value) return;
  unitStatsHeld.value = true;
  refreshUnitStatsOverlay();
  unitStatsPollTimer = setInterval(refreshUnitStatsOverlay, UNIT_STATS_POLL_MS);
}

function endUnitStatsHold(): void {
  unitStatsHoldCode = null;
  if (!unitStatsHeld.value) return;
  unitStatsHeld.value = false;
  if (unitStatsPollTimer !== null) {
    clearInterval(unitStatsPollTimer);
    unitStatsPollTimer = null;
  }
  unitStatsOverlayInfo.value = null;
}

function handleGameUiKeyup(event: KeyboardEvent): void {
  if (unitStatsHoldCode !== null && event.code === unitStatsHoldCode) endUnitStatsHold();
}

function handleGameUiWindowBlur(): void {
  endUnitStatsHold();
}

function handleGameUiCommandHotkey(commandId: CommandHotkeyId, event?: KeyboardEvent): boolean {
  switch (commandId) {
    case 'ui.pause':
      // Same setPaused flow as the control-bar PAUSE button / paused banner.
      setGamePaused(gamePhase.value !== 'paused');
      return true;
    case 'ui.gameSpeedIncrease':
      adjustGameSpeed(1);
      return true;
    case 'ui.gameSpeedDecrease':
      adjustGameSpeed(-1);
      return true;
    case 'ui.unitStats':
      // Hold semantics: keydown shows, the matching keyup hides.
      beginUnitStatsHold(event?.code ?? null);
      return true;
    case 'ui.customGameInfo':
      toggleMapDetails();
      return true;
    case 'ui.optionsMenu':
      toggleOptionsMenu();
      return true;
    case 'ui.showMapOverview':
      showMapOverview();
      return true;
    case 'ui.flipCameraYaw':
      flipCameraYaw();
      return true;
    case 'camera.toggleMode':
      toggleCameraViewMode();
      return true;
    case 'camera.fovDecrease':
      changeCameraFovBy(-5);
      return true;
    case 'camera.fovIncrease':
      changeCameraFovBy(5);
      return true;
    case 'camera.viewRadiusIncrease':
      changeCameraViewRadius(1);
      return true;
    case 'camera.viewRadiusDecrease':
      changeCameraViewRadius(-1);
      return true;
    case 'camera.viewTa':
      setCameraViewMode('ta');
      return true;
    case 'camera.viewSpring':
      setCameraViewMode('spring');
      return true;
    case 'ui.goToLastPing':
      goToLastPing();
      return true;
    case 'ui.toggleUiChrome':
      toggleUiChrome();
      return true;
    case 'ui.muteSound':
      toggleAllSounds();
      return true;
    case 'ui.volumeIncrease':
      changeMasterVolumeByBarStep(1);
      return true;
    case 'ui.volumeDecrease':
      changeMasterVolumeByBarStep(-1);
      return true;
    case 'ui.captureScreenshot':
      triggerCapture('pic-raw');
      return true;
    case 'ui.capturePicHud':
      triggerCapture('pic-hud');
      return true;
    case 'ui.captureVidRaw':
      triggerCapture('vid-raw');
      return true;
    case 'ui.captureVidHud':
      triggerCapture('vid-hud');
      return true;
    case 'ui.toggleFullscreen':
      void toggleFullscreen();
      return true;
    case 'ui.chat':
      focusChatConsole();
      return true;
    case 'ui.attackRangeCycleNext':
      cycleAttackRangeDisplay(1);
      return true;
    case 'ui.attackRangeCyclePrevious':
      cycleAttackRangeDisplay(-1);
      return true;
    case 'ui.toggleLosMap':
      toggleSightBoundary();
      return true;
    case 'ui.togglePathingMap':
      togglePathingMap();
      return true;
    case 'ui.toggleMetalMap':
      toggleMetalMap();
      return true;
    case 'ui.toggleElevationMap':
      toggleElevationMap();
      return true;
    case 'camera.anchorFocus1':
      focusCameraAnchor(0);
      return true;
    case 'camera.anchorFocus2':
      focusCameraAnchor(1);
      return true;
    case 'camera.anchorFocus3':
      focusCameraAnchor(2);
      return true;
    case 'camera.anchorFocus4':
      focusCameraAnchor(3);
      return true;
    case 'camera.anchorSet1':
      setCameraAnchor(0);
      return true;
    case 'camera.anchorSet2':
      setCameraAnchor(1);
      return true;
    case 'camera.anchorSet3':
      setCameraAnchor(2);
      return true;
    case 'camera.anchorSet4':
      setCameraAnchor(3);
      return true;
    default:
      return false;
  }
}

function handleGameUiKeydown(event: KeyboardEvent): void {
  const target = event.target;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return;
  }
  const hotkey = gameUiHotkeys.resolve(event);
  if (hotkey.pending) {
    event.preventDefault();
    return;
  }
  if (hotkey.commandId !== null && handleGameUiCommandHotkey(hotkey.commandId, event)) {
    event.preventDefault();
    return;
  }
  if (
    event.key === 'Escape' &&
    (optionsMenuOpen.value || mapDetailsVisible.value)
  ) {
    event.preventDefault();
    gameUiHotkeys.reset();
    optionsMenuOpen.value = false;
    mapDetailsVisible.value = false;
  }
}

onMounted(() => {
  syncFullscreenActive();
  document.addEventListener('fullscreenchange', syncFullscreenActive);
  window.addEventListener('keydown', handleGameUiKeydown);
  window.addEventListener('keyup', handleGameUiKeyup);
  window.addEventListener('blur', handleGameUiWindowBlur);
  bottomControlsResizeObserver = new ResizeObserver(updatePlayableBottomInset);
  if (bottomControlsRef.value !== null) bottomControlsResizeObserver.observe(bottomControlsRef.value);
  updatePlayableBottomInset();
});

onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', syncFullscreenActive);
  window.removeEventListener('keydown', handleGameUiKeydown);
  window.removeEventListener('keyup', handleGameUiKeyup);
  window.removeEventListener('blur', handleGameUiWindowBlur);
  endUnitStatsHold();
  globalChat.stop();
  captureController.dispose();
  bottomControlsResizeObserver?.disconnect();
  bottomControlsResizeObserver = null;
});

// Demo battle unit blueprint list (state read from snapshots)
const demoUnitBlueprintIds = BACKGROUND_UNIT_BLUEPRINT_IDS;
// Demo battle static-host blueprint list for the BUILDINGS bar group.
const demoBuildingBlueprintIds: readonly string[] = [...BUILDING_BLUEPRINT_IDS];

// Terrain-shape selection. Source of truth is localStorage; the
// refs below mirror it so the battle bar can reactively highlight
// the active option. Changing the shape rebuilds the heightmap on
// the next game construction (background battle restart for live
// preview, or first real-game start), so click handlers save the
// new value AND restart the demo battle when one is running.
// Initial load is always demo mode — at component-mount time the
// user is on the BUDGET ANNIHILATION screen (gameStarted=false,
// roomCode=''). Switching into the GAME LOBBY flips
// `currentBattleMode` to `real`; the lobby-preview composable reloads
// these refs from the real-battle keys at that point.
const centerMagnitude = ref<number>(loadStoredCenterMagnitude('demo'));
const ringMagnitude = ref<number>(loadStoredRingMagnitude('demo'));
const dividersMagnitude = ref<number>(loadStoredDividersMagnitude('demo'));
const perimeterMagnitude = ref<number>(loadStoredPerimeterMagnitude('demo'));
const terrainPrecedence = ref<TerrainPrecedence>(
  loadStoredTerrainPrecedence('demo'),
);
const terrainDTerrain = ref<number>(loadStoredTerrainDTerrain('demo'));
const plateauWallSlopeDegrees = ref<number>(
  loadStoredPlateauWallSlopeDegrees('demo'),
);
const metalDepositStep = ref<number>(loadStoredMetalDepositStep('demo'));
const terrainDetail = ref<number>(loadStoredTerrainDetail('demo'));
const pathfindingCellConsolidation = ref<number>(
  loadStoredPathfindingCellConsolidation('demo'),
);
const simulationTickRateHz = ref<number>(
  loadStoredSimulationTickRate('demo'),
);
const terrainTextureSmoothing = ref<number>(getTerrainTextureSmoothing());
const terrainLightSmoothing = ref<number>(getTerrainLightSmoothing());
const terrainTextureSmoothAcrossWallBoundary = ref<boolean>(
  getTerrainTextureSmoothAcrossWallBoundary(),
);
const terrainLightSmoothAcrossWallBoundary = ref<boolean>(
  getTerrainLightSmoothAcrossWallBoundary(),
);
const terrainSplitWallBoundaryVertices = ref<boolean>(
  getTerrainSplitWallBoundaryVertices(),
);
const initialMapDimensions = loadStoredMapLandDimensions('demo');
const mapWidthLandCells = ref<number>(initialMapDimensions.widthLandCells);
const mapLengthLandCells = ref<number>(initialMapDimensions.lengthLandCells);
const mapDetailsRows = computed(() => [
  { label: 'MODE', value: currentBattleMode.value.toUpperCase() },
  { label: 'SIZE', value: `${mapWidthLandCells.value} x ${mapLengthLandCells.value} cells` },
  {
    label: 'WORLD',
    value: `${mapWidthLandCells.value * LAND_CELL_SIZE} x ${mapLengthLandCells.value * LAND_CELL_SIZE}`,
  },
  { label: 'CENTER', value: String(centerMagnitude.value) },
  { label: 'RING', value: String(ringMagnitude.value) },
  { label: 'DIVIDERS', value: String(dividersMagnitude.value) },
  { label: 'PERIMETER', value: String(perimeterMagnitude.value) },
  {
    label: 'PRECEDENCE',
    value: terrainPrecedence.value === 'dividers-precedence'
      ? 'DIVIDERS'
      : 'PERIMETER',
  },
  { label: 'D-TERRAIN', value: terrainDTerrain.value === 0 ? 'NONE' : String(terrainDTerrain.value) },
  { label: 'PLATEAU WALL', value: `${plateauWallSlopeDegrees.value} deg` },
  { label: 'METAL STEP', value: metalDepositStep.value === 0 ? 'NONE' : String(metalDepositStep.value) },
  { label: 'DETAIL', value: String(terrainDetail.value) },
  { label: 'PLAYERS', value: String(lobbyPlayerCount.value) },
]);
const {
  renderMode,
  audioScope,
  masterVolume,
  environmentLight,
  ambientLight,
  directionalLight,
  skyLight,
  exposure,
  audioSmoothing,
  burnMarks,
  windParticles,
  locomotionMarks,
  teamTrim,
  surfaceTexture,
  smokeTrails,
  smokeSoftEdges,
  entityShadows,
  forceFieldsVisible,
  fogShade,
  materialExplosions,
  triangleDebug,
  waterTriangleDebug,
  wallTriangleDebug,
  buildGridDebugMode,
  pathingHierarchyDebug,
  airLiftProbeDebug,
  zoomPointsDebug,
  metalMap,
  elevationMap,
  pathingMap,
  pathingDebugUnit,
  pathingDebugMode,
  clientUnitGroundNormalEmaMode,
  dragPanEnabled,
  waypointDetail,
  entityHud,
  selectionHudMode,
  commandHotkeyPreset,
  commandHotkeyRevision,
  soundToggles,
  rangeToggles,
  volumeToggles,
  legsRadiusToggle,
  legsReachToggle,
  lodMode,
  aaMsaaMode,
  aaResolutionMode,
  cameraSmoothMode,
  cameraFollowMode,
  cameraFovDegrees,
  waterBoundaryMode,
  allRangesActive,
  allVolumesActive,
  entityHudTypes,
  entityHudElements,
  SFX_CATEGORIES,
  allSoundsActive,
  SOUND_LABELS,
  SOUND_TOOLTIPS,
  resetClientDefaults,
  changeRenderMode,
  changeAudioScope,
  changeMasterVolume,
  changeEnvironmentLight,
  changeAmbientLight,
  changeDirectionalLight,
  changeSkyLight,
  changeExposure,
  toggleRange,
  cycleAttackRangeDisplay,
  toggleVolume,
  toggleLegsRadius,
  toggleLegsReach,
  changeLodMode,
  changeAaMsaaMode,
  changeAaResolutionMode,
  setCameraMode,
  setCameraFollow,
  changeCameraFovDegrees,
  changeCameraFovBy,
  changeWaterBoundaryMode,
  toggleAllRanges,
  toggleAllVolumes,
  toggleAudioSmoothing,
  toggleBurnMarks,
  toggleWindParticles,
  toggleLocomotionMarks,
  toggleTeamTrim,
  toggleSurfaceTexture,
  toggleSmokeTrails,
  toggleSmokeSoftEdges,
  toggleEntityShadows,
  toggleForceFieldsVisible,
  toggleFogShade,
  toggleMaterialExplosions,
  toggleTriangleDebug,
  toggleWaterTriangleDebug,
  toggleWallTriangleDebug,
  changeBuildGridDebugMode,
  togglePathingHierarchyDebug,
  toggleAirLiftProbeDebug,
  toggleZoomPointsDebug,
  toggleMetalMap,
  toggleElevationMap,
  togglePathingMap,
  changePathingDebugMode,
  changePathingDebugUnit,
  toggleSightBoundary,
  changeClientUnitGroundNormalEmaMode,
  changeWaypointDetail,
  toggleEntityHud,
  changeSelectionHudMode,
  changeCommandHotkeyPreset,
  refreshCommandHotkeys,
  toggleDragPan,
  toggleAllSounds,
  toggleSoundCategory,
} = useGameCanvasClientSettings({
  currentClientMode: currentBattleMode,
  applyCameraFovDegrees,
});

function openEntityLab(): void {
  // Refused anywhere in the game room — seating screen included: unmounting
  // the canvas would disconnect the network session, so leaving stays an
  // explicit act on the match's own exits.
  sendAppSurface('openEntityLab');
}

function openGameControls(): void {
  // Same refusal shape as the lab: a side room, reachable from home only.
  sendAppSurface('openGameControls');
}

useGameCanvasEntityLabHotkey(openEntityLab);

const {
  selectionInfo,
  economyInfo,
  minimapData,
  idleBuilders,
  bindGameSceneUi,
  handleMinimapClick: centerMinimapCamera,
  handleMinimapCommand: issueMinimapCommand,
  cycleIdleBuilder,
  addIdleBuildersToSelection,
  focusIdleBuilder,
  gamePhase,
  selectionActions,
} = useGameCanvasSceneUi({
  activePlayer,
  gameOverWinner,
  serverMetaFromSnapshot,
  foregroundGame,
  getBackgroundBattle: () => getBackgroundBattle(),
});
/** The lockstep scheduler's halt state, from the pump's edge detector:
 *  'paused' is a deliberate protocol pause, 'desynced' a dead match. */
const lockstepHalt = ref<'paused' | 'desynced' | null>(null);

/** Every way the game stops is one overlay: the demo/sim pause (gamePhase),
 *  a lockstep protocol pause, a desync, and the flow-control match hold. */
const pausedOverlayVisible = computed(
  () =>
    (gamePhase.value === 'paused' || lockstepHalt.value !== null || matchHold.value !== null) &&
    gameOverWinner.value === null,
);
/** Click-to-resume only where a click can actually resume: manual pauses.
 *  A match hold lifts on its own; a desync never does. */
const pausedOverlayResumable = computed(
  () =>
    matchHold.value === null &&
    lockstepHalt.value !== 'desynced' &&
    (gamePhase.value === 'paused' || lockstepHalt.value === 'paused'),
);
const pausedOverlaySubtitle = computed(() => {
  if (lockstepHalt.value === 'desynced') return 'Desync detected — the match is stopped';
  if (matchHold.value !== null) return 'The match is held for a player — see the banner above';
  return 'Click to resume';
});

/** The sim stopping is also a PRESENTATION fact: every frontend-only
 *  animation clock (spray, smoke, explosions, build bands, fans...) freezes
 *  with it, while the camera and HUD stay live. */
const simulationPausedForPresentation = computed(
  () => gamePhase.value === 'paused' || lockstepHalt.value !== null || matchHold.value !== null,
);
watch(simulationPausedForPresentation, (paused) => {
  foregroundGame.getScene()?.setSimulationPaused(paused);
}, { immediate: true });

({
  getBackgroundBattle,
  startBackgroundBattle,
  stopBackgroundBattle,
  waitForBackgroundBattleIdle,
} = useGameCanvasBackgroundBattle({
  backgroundContainerRef,
  getLocalIpAddress: () => localIpAddress.value,
  getBattleMode: () => currentBattleMode.value,
  getPreviewPlayerIds: () => currentBattleMode.value === 'real'
    ? lobbyPlayers.value.map((p) => p.playerId)
    : undefined,
  getPreviewLocalPlayerId: () => currentBattleMode.value === 'real'
    ? localPlayerId.value
    : undefined,
  getPlayerClientEnabled: () => playerClientEnabled.value,
  onLoadingProgress: setLoadingProgress,
  bindSceneUi: (scene) => bindGameSceneUi(scene),
  onRendererWarmupChange: (warming) => {
    if (!gameStarted.value) rendererWarmupLoading.value = warming;
  },
  onStarted: (battle) => {
    activeConnection = battle.connection;
    hasServer.value = true;
    battleStartTime = Date.now();
    setPlayerClientRenderEnabled(battle.gameInstance, playerClientEnabled.value);
    setInstanceCameraFovDegrees(battle.gameInstance, cameraFovDegrees.value);
  },
  onStopped: () => {
    if (!currentServer) {
      activeConnection = null;
      hasServer.value = false;
      if (!gameStarted.value) battleStartTime = 0;
    }
  },
}));

useGameCanvasLobbyPreview({
  backgroundContainerRef,
  gameAreaRef,
  currentBattleMode,
  lobbyModalVisible,
  roomCode,
  gameStarted,
  lobbyPlayerCount,
  localPlayerId,
  centerMagnitude,
  ringMagnitude,
  dividersMagnitude,
  perimeterMagnitude,
  terrainPrecedence,
  terrainDTerrain,
  plateauWallSlopeDegrees,
  metalDepositStep,
  terrainDetail,
  pathfindingCellConsolidation,
  simulationTickRateHz,
  mapWidthLandCells,
  mapLengthLandCells,
  stopBackgroundBattle,
  startBackgroundBattle,
});

// Display values: always read from snapshot meta (server→snapshot→display)
const displayServerTpsAvg = computed(
  () => serverMetaFromSnapshot.value?.ticks.avg ?? 0,
);
const displayServerTpsWorst = computed(
  () => serverMetaFromSnapshot.value?.ticks.low ?? 0,
);
const {
  currentZoom,
  cameraPositionX,
  cameraPositionY,
  cameraPositionZ,
  cameraDirectionX,
  cameraDirectionY,
  cameraDirectionZ,
  displayGpuMs,
  frameMsAvg,
  frameMsHi,
  gpuSourceLabel,
  gpuTimerSupported,
  runtimeProfile,
  nativePixelRatio,
  activePixelRatio,
  dynamicPixelRatioEnabled,
  antialiasSamples,
  webglBufferProfilerSupported,
  webglRendererRenderMs,
  webglDrawCalls,
  webglTriangles,
  webglPoints,
  webglLines,
  webglGeometries,
  webglTextures,
  webglBufferDataCalls,
  webglBufferSubDataCalls,
  webglBufferUploadBytes,
  hudSpriteActiveCount,
  hudSpriteBudgetCount,
  hudSpriteDisposedCount,
  hudSpritePeakCount,
  hudSpriteRetainedCount,
  scopedMeshDestroyPerSec,
  scopedMeshHiddenPerSec,
  scopedMeshReactivatedPerSec,
  scopedMeshRebuildPerSec,
  scopedRetainedBuildingMeshes,
  scopedRetainedUnitMeshes,
  rendererContextAuxiliaryBudget,
  rendererContextAuxiliaryCount,
  rendererContextDeniedAuxiliaryCount,
  rendererContextMainCount,
  logicMsAvg,
  logicMsHi,
  longtaskMsPerSec,
  longtaskSupported,
  renderMsAvg,
  renderMsHi,
  renderTpsAvg,
  renderTpsWorst,
  snapAvgRate,
  snapWorstRate,
  rawSnapshotReceivedRate,
  rawSnapshotAppliedRate,
  richSnapAvgRate,
  richSnapWorstRate,
  deltaSnapAvgRate,
  deltaSnapWorstRate,
  entityDeltaSnapAvgRate,
  entityDeltaSnapWorstRate,
  projectileDeltaSnapAvgRate,
  projectileDeltaSnapWorstRate,
  snapshotSizeAvgBytes,
  snapshotSizeHiBytes,
  richSnapshotSizeAvgBytes,
  richSnapshotSizeHiBytes,
  deltaSnapshotSizeAvgBytes,
  deltaSnapshotSizeHiBytes,
  entityDeltaSnapshotSizeAvgBytes,
  entityDeltaSnapshotSizeHiBytes,
  projectileDeltaSnapshotSizeAvgBytes,
  projectileDeltaSnapshotSizeHiBytes,
  snapshotApplyAvgMs,
  snapshotApplyHiMs,
  richSnapshotApplyAvgMs,
  richSnapshotApplyHiMs,
  deltaSnapshotApplyAvgMs,
  deltaSnapshotApplyHiMs,
  entityDeltaSnapshotApplyAvgMs,
  entityDeltaSnapshotApplyHiMs,
  projectileDeltaSnapshotApplyAvgMs,
  projectileDeltaSnapshotApplyHiMs,
} = useGameCanvasTelemetry({
  getScene: () => getBackgroundBattle()?.gameInstance?.getScene() ?? foregroundGame.getScene(),
});
const displayServerCpuAvg = computed(
  () => serverMetaFromSnapshot.value?.cpu?.avg ?? 0,
);
const displayServerCpuHi = computed(
  () => serverMetaFromSnapshot.value?.cpu?.hi ?? 0,
);
const displayTickRate = computed(
  () =>
    serverMetaFromSnapshot.value?.ticks.rate ??
    simulationTickRateHz.value,
);
// Simulation-side unit ground normal EMA mode. Picks the half-life used by the
// sim's updateUnitGroundNormal (UNIT_GROUND_NORMAL_EMA_HALF_LIFE_SEC[mode]). Persisted to
// localStorage and pushed via the host-applied setUnitGroundNormalEmaMode command.
const serverUnitGroundNormalEmaMode = ref<UnitGroundNormalEmaMode>(
  loadStoredUnitGroundNormalEmaMode(currentBattleMode.value),
);
// Reload the persisted EMA mode when the bar swaps namespaces. The
// host pushes its own setting via the setUnitGroundNormalEmaMode
// command path; this watcher keeps the local control's display in
// sync with the new mode's stored value.
watch(currentBattleMode, (mode) => {
  serverUnitGroundNormalEmaMode.value = loadStoredUnitGroundNormalEmaMode(mode);
});
watch(currentBattleMode, (mode) => {
  syncTerrainRenderSmoothingSettings(mode);
  terrainTextureSmoothing.value = getTerrainTextureSmoothing();
  terrainLightSmoothing.value = getTerrainLightSmoothing();
  terrainTextureSmoothAcrossWallBoundary.value =
    getTerrainTextureSmoothAcrossWallBoundary();
  terrainLightSmoothAcrossWallBoundary.value =
    getTerrainLightSmoothAcrossWallBoundary();
  terrainSplitWallBoundaryVertices.value =
    getTerrainSplitWallBoundaryVertices();
});
// Simulation-side unit ground normal EMA - the host applies its setting via the
// setUnitGroundNormalEmaMode command, then the display reconciles from
// snapshot meta when the stored value differs.
watch(
  () => serverMetaFromSnapshot.value?.unitGroundNormalEma,
  (mode) => {
    if (!mode) return;
    if (!SERVER_CONFIG.unitGroundNormalEma.options.includes(mode as UnitGroundNormalEmaMode)) return;
    if (mode === serverUnitGroundNormalEmaMode.value) return;
    serverUnitGroundNormalEmaMode.value = mode as UnitGroundNormalEmaMode;
  },
);
const displaySnapshotRate = computed(
  () =>
    serverMetaFromSnapshot.value?.snaps.rate ??
    PRESENTATION_SNAPSHOT_RATE_DEFAULT,
);
const displayUnitCount = computed(
  () => serverMetaFromSnapshot.value?.units.count ?? 0,
);
const displayUnitCap = computed(
  () => serverMetaFromSnapshot.value?.units.max ?? getUnitCap(currentBattleMode.value),
);
/** Sides that actually hold a seat — what the entity count cap divides by
 *  (WorldState.getTeamEntityCountCap / getOccupiedAllyTeamCount). The demo's
 *  shape is authored as seats-per-side and legitimately declares an EMPTY
 *  side, which gets terrain but no share of the cap. */
const occupiedAllyTeamCount = computed(() => {
  if (currentBattleMode.value === 'demo') {
    return Math.max(1, DEMO_CONFIG.allyTeamSeats.filter((seats) => seats > 0).length);
  }
  const sides = new Set<number>();
  for (const player of lobbyPlayers.value) sides.add(player.allyTeamId ?? 1);
  return Math.max(1, sides.size);
});
// (Declared-but-empty sides deliberately excluded: they carve terrain but
// hold no economy, matching getOccupiedAllyTeamCount.)
const displayServerTime = computed(
  () => serverMetaFromSnapshot.value?.server.time ?? '',
);
const displayServerIp = computed(
  () => serverMetaFromSnapshot.value?.server.ip ?? '',
);
const slowDownAtFinalWaypointStoreVersion = ref(0);
const worldSurfaceStoreVersion = ref(0);
const {
  currentLobbySettings,
  broadcastLobbySettingsIfHost,
  applyLobbyName,
  applyCenterMagnitude,
  applyRingMagnitude,
  applyDividersMagnitude,
  applyPerimeterMagnitude,
  applyTerrainPrecedence,
  applyTerrainDTerrain,
  applyPlateauWallSlopeDegrees,
  applyMetalDepositStep,
  applyTerrainDetail,
  applyPathfindingCellConsolidation,
  applySimulationTickRate,
  applyMetalCoverage,
  applyLiquidSurfaceMode,
  applyMapLandDimensions,
  applyLobbySettingsFromHost,
} = useGameCanvasLobbySettings({
  network: networkManager,
  currentBattleMode,
  networkRole,
  roomCode,
  gameStarted,
  centerMagnitude,
  ringMagnitude,
  dividersMagnitude,
  perimeterMagnitude,
  terrainPrecedence,
  terrainDTerrain,
  plateauWallSlopeDegrees,
  metalDepositStep,
  terrainDetail,
  pathfindingCellConsolidation,
  simulationTickRateHz,
  mapWidthLandCells,
  mapLengthLandCells,
  lobbyName,
  allyTeamCount: lobbyAllyTeamCount,
  slowDownAtFinalWaypointStoreVersion,
  worldSurfaceStoreVersion,
  stopBackgroundBattle,
  startBackgroundBattle,
});

const {
  resetServerDefaults: resetUnitGroundNormalEmaDefault,
  setUnitGroundNormalEmaModeValue,
} = useGameCanvasServerSettings({
  currentBattleMode,
  serverUnitGroundNormalEmaMode,
  getActiveConnection: () => activeConnection,
});

const {
  currentAllowedUnits,
  currentAllowedUnitsSet,
  allDemoUnitsActive,
  currentAllowedBuildings,
  currentAllowedBuildingsSet,
  allDemoBuildingsActive,
  localPlayerShieldAwareTargeting,
  localPlayerShieldsPowered,
  currentFogOfWarEnabled,
  currentSlowDownAtFinalWaypoint,
  currentSlopePathMode,
  currentMetalCoverage,
  currentLiquidSurfaceMode,
  currentConverterTax,
  toggleDemoUnitBlueprintId,
  toggleAllDemoUnits,
  toggleDemoBuildingBlueprintId,
  toggleAllDemoBuildings,
  changeEntityCountCap,
  setFogOfWarEnabled,
  setSlowDownAtFinalWaypoint,
  setSlopePathMode,
  setMetalCoverage,
  setLiquidSurfaceMode,
  setConverterTax,
  resetDemoDefaults,
  applyPreset,
} = useGameCanvasBattleSettings({
  serverMetaFromSnapshot,
  localPlayerId,
  currentBattleMode,
  slowDownAtFinalWaypointStoreVersion,
  worldSurfaceStoreVersion,
  demoUnitBlueprintIds,
  demoBuildingBlueprintIds,
  getActiveConnection: () => activeConnection,
  broadcastLobbySettingsIfHost,
  applyCenterMagnitude,
  applyRingMagnitude,
  applyDividersMagnitude,
  applyPerimeterMagnitude,
  applyTerrainPrecedence,
  applyTerrainDTerrain,
  applyPlateauWallSlopeDegrees,
  applyMetalDepositStep,
  applyTerrainDetail,
  applyMetalCoverage,
  applyLiquidSurfaceMode,
  applyMapLandDimensions,
});

function applyTerrainTextureSmoothing(value: number): void {
  setTerrainTextureSmoothing(value, currentBattleMode.value);
  terrainTextureSmoothing.value = getTerrainTextureSmoothing();
}

function applyTerrainLightSmoothing(value: number): void {
  setTerrainLightSmoothing(value, currentBattleMode.value);
  terrainLightSmoothing.value = getTerrainLightSmoothing();
}

function toggleTerrainTextureSmoothAcrossWallBoundary(): void {
  setTerrainTextureSmoothAcrossWallBoundary(
    !terrainTextureSmoothAcrossWallBoundary.value,
    currentBattleMode.value,
  );
  terrainTextureSmoothAcrossWallBoundary.value =
    getTerrainTextureSmoothAcrossWallBoundary();
}

function toggleTerrainLightSmoothAcrossWallBoundary(): void {
  setTerrainLightSmoothAcrossWallBoundary(
    !terrainLightSmoothAcrossWallBoundary.value,
    currentBattleMode.value,
  );
  terrainLightSmoothAcrossWallBoundary.value =
    getTerrainLightSmoothAcrossWallBoundary();
}

function toggleTerrainSplitWallBoundaryVertices(): void {
  setTerrainSplitWallBoundaryVertices(
    !terrainSplitWallBoundaryVertices.value,
    currentBattleMode.value,
  );
  terrainSplitWallBoundaryVertices.value =
    getTerrainSplitWallBoundaryVertices();
}

function resetTerrainRenderSmoothingDefaults(): void {
  setTerrainTextureSmoothing(
    BATTLE_CONFIG.terrainTextureSmoothing.default,
    currentBattleMode.value,
  );
  setTerrainLightSmoothing(
    BATTLE_CONFIG.terrainLightSmoothing.default,
    currentBattleMode.value,
  );
  setTerrainTextureSmoothAcrossWallBoundary(
    BATTLE_CONFIG.terrainTextureSmoothAcrossWallBoundary.default,
    currentBattleMode.value,
  );
  setTerrainLightSmoothAcrossWallBoundary(
    BATTLE_CONFIG.terrainLightSmoothAcrossWallBoundary.default,
    currentBattleMode.value,
  );
  setTerrainSplitWallBoundaryVertices(
    BATTLE_CONFIG.terrainSplitWallBoundaryVertices.default,
    currentBattleMode.value,
  );
  terrainTextureSmoothing.value = getTerrainTextureSmoothing();
  terrainLightSmoothing.value = getTerrainLightSmoothing();
  terrainTextureSmoothAcrossWallBoundary.value =
    getTerrainTextureSmoothAcrossWallBoundary();
  terrainLightSmoothAcrossWallBoundary.value =
    getTerrainLightSmoothAcrossWallBoundary();
  terrainSplitWallBoundaryVertices.value =
    getTerrainSplitWallBoundaryVertices();
}

function resetBattleDefaultsWithGroundNormal(): void {
  resetDemoDefaults();
  applyPathfindingCellConsolidation(
    BATTLE_CONFIG.pathfindingCellConsolidation.default,
  );
  applySimulationTickRate(BATTLE_CONFIG.simulationTickRate.default);
  resetUnitGroundNormalEmaDefault();
}

function resetClientDefaultsWithTerrainRender(): void {
  resetClientDefaults();
  resetTerrainRenderSmoothingDefaults();
}

// Declared ahead of the network wiring below, which needs somewhere to send
// a client whose host has vanished. `restartGame` is defined further down, so
// the exit is passed as a lambda: by the time a host can leave, it is bound.
const {
  hostLeftSecondsRemaining,
  beginHostLeftEviction,
  exitAfterHostLeft,
} = useGameCanvasHostEviction({ exitToMenu: () => restartGame() });

const {
  laggingPeers,
  recordPeerFrameReport,
  clearPeerFrames,
} = useGameCanvasPeerLag();

// Peer progress only means something inside a running battle. Clearing on
// every exit — not just the Return-to-Lobby one — stops the composable's
// staleness timer and guarantees a new match never opens showing the last
// match's laggards.
watch(gameStarted, (started) => {
  if (!started) clearPeerFrames();
});

// startGameWithPlayers still exists on the composable — the network
// callbacks reach it internally for the client's gameStart handoff — but
// nothing in this component calls it directly any more: hosting flows
// start via network.startGame(), and the old dead offline path is gone.
const {
  setupNetworkCallbacks,
} = useGameCanvasRealBattleHandoff({
  containerRef,
  lobbyBotSeats,
  showLobby,
  gameStarted,
  battleLoading,
  activePlayer,
  localPlayerId,
  localRole,
  networkRole,
  playerClientEnabled,
  cameraFovDegrees,
  localIpAddress,
  hasServer,
  networkNotice,
  lobbyError,
  lobbyMembers,
  roomCode,
  localUsername,
  network: networkManager,
  lifecycle: realBattleLifecycle,
  foregroundGame,
  foregroundSceneBinding,
  stopBackgroundBattle,
  waitForBackgroundBattleIdle,
  getCurrentServer: () => currentServer,
  setCurrentServer: (server) => {
    currentServer = server;
  },
  setActiveConnection: (connection) => {
    activeConnection = connection;
  },
  setBattleStartTime: (time) => {
    battleStartTime = time;
  },
  resolvePlayerName,
  resolveMemberName,
  onSeatedPeerSilent: (playerId) => {
    networkNotice.value = `${resolvePlayerName(playerId)} lost connection`;
    markSeatedPlayerSilent?.(playerId);
  },
  onSeatedPeerReturned: (playerId) => {
    networkNotice.value = `${resolvePlayerName(playerId)} is reconnecting`;
    markSeatedPlayerReturned?.(playerId);
  },
  applyLobbySettingsFromHost,
  currentLobbySettings,
  onCommunication: applyCommunicationEvent,
  onHostLeft: beginHostLeftEviction,
  onPeerFrameReport: recordPeerFrameReport,
  onFlowControlChange: (report) => {
    matchHold.value = report.state === 'paused' ? report : null;
  },
  onLockstepHaltChange: (halt) => {
    lockstepHalt.value = halt;
  },
  onCatchUpProgress: (progress) => {
    catchUpProgress.value = progress.state === 'live' ? null : progress;
    if (progress.state === 'failed') {
      // An honest refusal beats an infinite spinner. The measured rate is the
      // whole explanation, so it goes in the message.
      const why = progress.failure === 'cannot-converge'
        ? `replay could not keep up (${progress.rateRealtime.toFixed(2)}x real time)`
        : progress.failure === 'state-mismatch'
          ? 'replayed state did not match the host'
          : 'the host never answered';
      networkNotice.value = `Could not join the battle: ${why}`;
      battleLoading.value = false;
    }
  },
  registerSilentPlayer: (markSilent, markReturned) => {
    markSeatedPlayerSilent = markSilent;
    markSeatedPlayerReturned = markReturned;
  },
  onLoadingProgress: setLoadingProgress,
  bindSceneUi: (scene) => {
    bindGameSceneUi(scene, true);
  },
});

const { restartGame: restartGameSession } = useGameCanvasSessionLifecycle({
  gameOverWinner,
  battleLoading,
  gameStarted,
  showLobby,
  networkRole,
  lobbyMembers,
  roomCode,
  lobbyError,
  networkNotice,
  hasServer,
  serverMetaFromSnapshot,
  network: networkManager,
  lifecycle: realBattleLifecycle,
  foregroundSceneBinding,
  foregroundGame,
  getCurrentServer: () => currentServer,
  setCurrentServer: (server) => {
    currentServer = server;
  },
  setActiveConnection: (connection) => {
    activeConnection = connection;
  },
  setBattleStartTime: (time) => {
    battleStartTime = time;
  },
  startBackgroundBattle,
  stopBackgroundBattle,
  resetSpectatorState,
});

/** Every way out of a game room funnels here: the game-over banner, the
 *  OPTIONS LEAVE button, host eviction. Tear the session down, take the
 *  machine's exit, and land the player HOME with the menu surfaced — the
 *  exits all read "Return to Lobby", so the menu is what they get. The
 *  nextTick outruns the battle-mode watcher that would otherwise restore a
 *  saved closed-menu preference over the destination the player just chose. */
function restartGame(): void {
  restartGameSession();
  // The session's conversation ends with the session, and so do its halt
  // and its bot seats.
  communicationMessages.value = [];
  lockstepHalt.value = null;
  lobbyBotSeats.value = [];
  if (sendAppSurface('exitGameRoom') || sendAppSurface('leaveLobby')) {
    void nextTick(() => {
      menuHidden.value = false;
    });
  }
}

onMounted(() => {
  // Boot ends when the canvas is actually on screen; a remount returning
  // from the entity lab sends this too and is refused, machine already out
  // of init. The sidebar's restored open/closed preference is chrome inside
  // the home surface, so the machine has nothing to replay.
  sendAppSurface('boot');
});

/** The sidebar chevron slides the menu over the demo battle and back. Pure
 *  chrome within the home surface — the machine has no edge here, which is
 *  exactly the point of calling it home. */
function handleMenuToggle(): void {
  toggleMenuHidden();
}

const {
  handleHost,
  handleJoin,
  handleLobbyStart,
  handleLobbyCancel,
  handleHostLocal,
} = useGameCanvasLobbyActions({
  network: networkManager,
  isConnecting,
  lobbyError,
  networkNotice,
  roomCode,
  isHost,
  networkRole,
  localPlayerId,
  localRole,
  lobbyMembers,
  battleLoading,
  setupNetworkCallbacks,
  reportLocalPlayerInfo,
});

// Reactive object instead of computed-returning-fresh-literal so the
// model identity stays stable across snapshot ticks. The previous
// pattern allocated a brand new 30-field object on every dep change,
// forcing the child <GameCanvasBattleControlBar> + its 50-odd
// BarButton children through a full prop diff. With per-field
// reactivity the only re-evaluations are templates that actually
// read the changed field. Methods and the demoUnitBlueprintIds ref are
// stable references so they sit on the object once at construction.
const battleControlBarModel = reactive<GameCanvasBattleControlBarModel>({
  isReadonly: serverBarReadonly.value,
  barStyle: battleBarVars.value,
  battleLabel: battleLabel.value,
  battleElapsed: battleElapsed.value,
  allDemoUnitsActive: allDemoUnitsActive.value,
  demoUnitBlueprintIds,
  currentAllowedUnits: currentAllowedUnits.value,
  currentAllowedUnitsSet: currentAllowedUnitsSet.value,
  allDemoBuildingsActive: allDemoBuildingsActive.value,
  demoBuildingBlueprintIds,
  currentAllowedBuildingsSet: currentAllowedBuildingsSet.value,
  displayUnitCap: displayUnitCap.value,
  occupiedAllyTeamCount: occupiedAllyTeamCount.value,
  gameStarted: gameStarted.value,
  mapWidthLandCells: mapWidthLandCells.value,
  mapLengthLandCells: mapLengthLandCells.value,
  centerMagnitude: centerMagnitude.value,
  ringMagnitude: ringMagnitude.value,
  dividersMagnitude: dividersMagnitude.value,
  perimeterMagnitude: perimeterMagnitude.value,
  terrainPrecedence: terrainPrecedence.value,
  terrainDTerrain: terrainDTerrain.value,
  plateauWallSlopeDegrees: plateauWallSlopeDegrees.value,
  metalDepositStep: metalDepositStep.value,
  terrainDetail: terrainDetail.value,
  pathfindingCellConsolidation: pathfindingCellConsolidation.value,
  simulationTickRateHz: simulationTickRateHz.value,
  displayUnitCount: displayUnitCount.value,
  localPlayerShieldAwareTargeting: localPlayerShieldAwareTargeting.value,
  localPlayerShieldsPowered: localPlayerShieldsPowered.value,
  currentFogOfWarEnabled: currentFogOfWarEnabled.value,
  currentSlowDownAtFinalWaypoint: currentSlowDownAtFinalWaypoint.value,
  currentSlopePathMode: currentSlopePathMode.value,
  currentMetalCoverage: currentMetalCoverage.value,
  currentLiquidSurfaceMode: currentLiquidSurfaceMode.value,
  currentConverterTax: currentConverterTax.value,
  serverUnitGroundNormalEmaMode: serverUnitGroundNormalEmaMode.value,
  presets: BATTLE_PRESETS,
  activePresetName: null,
  applyPreset,
  resetDemoDefaults: resetBattleDefaultsWithGroundNormal,
  toggleAllDemoUnits,
  toggleDemoUnitBlueprintId,
  toggleAllDemoBuildings,
  toggleDemoBuildingBlueprintId,
  changeEntityCountCap,
  applyMapLandDimensions,
  applyCenterMagnitude,
  applyRingMagnitude,
  applyDividersMagnitude,
  applyPerimeterMagnitude,
  applyTerrainPrecedence,
  applyTerrainDTerrain,
  applyPlateauWallSlopeDegrees,
  applyMetalDepositStep,
  applyTerrainDetail,
  applyPathfindingCellConsolidation,
  applySimulationTickRate,
  setFogOfWarEnabled,
  setSlowDownAtFinalWaypoint,
  setSlopePathMode,
  setMetalCoverage,
  setLiquidSurfaceMode,
  setConverterTax,
  setUnitGroundNormalEmaModeValue,
});
watchEffect(() => {
  const m = battleControlBarModel as {
    -readonly [K in keyof GameCanvasBattleControlBarModel]: GameCanvasBattleControlBarModel[K];
  };
  m.isReadonly = serverBarReadonly.value;
  m.barStyle = battleBarVars.value;
  m.battleLabel = battleLabel.value;
  m.battleElapsed = battleElapsed.value;
  m.allDemoUnitsActive = allDemoUnitsActive.value;
  m.currentAllowedUnits = currentAllowedUnits.value;
  m.currentAllowedUnitsSet = currentAllowedUnitsSet.value;
  m.allDemoBuildingsActive = allDemoBuildingsActive.value;
  m.currentAllowedBuildingsSet = currentAllowedBuildingsSet.value;
  m.displayUnitCap = displayUnitCap.value;
  m.occupiedAllyTeamCount = occupiedAllyTeamCount.value;
  m.gameStarted = gameStarted.value;
  m.mapWidthLandCells = mapWidthLandCells.value;
  m.mapLengthLandCells = mapLengthLandCells.value;
  m.centerMagnitude = centerMagnitude.value;
  m.ringMagnitude = ringMagnitude.value;
  m.dividersMagnitude = dividersMagnitude.value;
  m.perimeterMagnitude = perimeterMagnitude.value;
  m.terrainPrecedence = terrainPrecedence.value;
  m.terrainDTerrain = terrainDTerrain.value;
  m.plateauWallSlopeDegrees = plateauWallSlopeDegrees.value;
  m.metalDepositStep = metalDepositStep.value;
  m.terrainDetail = terrainDetail.value;
  m.pathfindingCellConsolidation = pathfindingCellConsolidation.value;
  m.simulationTickRateHz = simulationTickRateHz.value;
  m.displayUnitCount = displayUnitCount.value;
  m.localPlayerShieldAwareTargeting = localPlayerShieldAwareTargeting.value;
  m.localPlayerShieldsPowered = localPlayerShieldsPowered.value;
  m.currentFogOfWarEnabled = currentFogOfWarEnabled.value;
  m.currentSlowDownAtFinalWaypoint = currentSlowDownAtFinalWaypoint.value;
  m.currentSlopePathMode = currentSlopePathMode.value;
  m.currentMetalCoverage = currentMetalCoverage.value;
  m.currentLiquidSurfaceMode = currentLiquidSurfaceMode.value;
  m.currentConverterTax = currentConverterTax.value;
  m.serverUnitGroundNormalEmaMode = serverUnitGroundNormalEmaMode.value;
  const mapPresentation = resolveBattleMapPresentation({
    cap: displayUnitCap.value,
    slowDownAtFinalWaypoint: currentSlowDownAtFinalWaypoint.value,
    metalCoverage: currentMetalCoverage.value,
    liquidSurfaceMode: currentLiquidSurfaceMode.value,
    slopePathMode: currentSlopePathMode.value,
    converterTax: currentConverterTax.value,
    centerMagnitude: centerMagnitude.value,
    ringMagnitude: ringMagnitude.value,
    dividersMagnitude: dividersMagnitude.value,
    perimeterMagnitude: perimeterMagnitude.value,
    terrainPrecedence: terrainPrecedence.value,
    terrainDTerrain: terrainDTerrain.value,
    plateauWallSlopeDegrees: plateauWallSlopeDegrees.value,
    metalDepositStep: metalDepositStep.value,
    terrainDetail: terrainDetail.value,
    mapWidthLandCells: mapWidthLandCells.value,
    mapLengthLandCells: mapLengthLandCells.value,
  });
  // Sky backdrop panorama follows the matched preset; null (settings
  // drifted off every stock preset) resolves to the default panorama, so
  // a custom map still gets a layered horizon rather than a flat sky.
  m.activePresetName = mapPresentation.presetName;
  setActiveBackdropPresetName(mapPresentation.backdropPresetName);
  setActiveMapPresetLabel(mapPresentation.labelCaption);
});

// Same reactive() pattern as battleControlBarModel: stable proxy
// identity so per-field changes only trigger renders of bindings that
  // actually read the changed field. See the battle bar comment above
  // for the why.
const serverControlBarModel = reactive<GameCanvasServerControlBarModel>({
  isReadonly: serverBarReadonly.value,
  barStyle: serverBarVars.value,
  serverLabel: serverLabel.value,
  displayServerTime: displayServerTime.value,
  displayServerIp: displayServerIp.value,
  displayServerTpsAvg: displayServerTpsAvg.value,
  displayServerTpsWorst: displayServerTpsWorst.value,
  displayServerCpuAvg: displayServerCpuAvg.value,
  displayServerCpuHi: displayServerCpuHi.value,
  displayTickRate: displayTickRate.value,
});
watchEffect(() => {
  const m = serverControlBarModel as {
    -readonly [K in keyof GameCanvasServerControlBarModel]: GameCanvasServerControlBarModel[K];
  };
  m.isReadonly = serverBarReadonly.value;
  m.barStyle = serverBarVars.value;
  m.serverLabel = serverLabel.value;
  m.displayServerTime = displayServerTime.value;
  m.displayServerIp = displayServerIp.value;
  m.displayServerTpsAvg = displayServerTpsAvg.value;
  m.displayServerTpsWorst = displayServerTpsWorst.value;
  m.displayServerCpuAvg = displayServerCpuAvg.value;
  m.displayServerCpuHi = displayServerCpuHi.value;
  m.displayTickRate = displayTickRate.value;
});

// Same reactive() pattern as the other two bar models. This one is
// the biggest bar model, so the parent + child re-render savings
// scale across sound/range/radius toggles and live telemetry.
const clientControlBarModel = reactive<GameCanvasClientControlBarModel>({
  barStyle: clientBarVars.value,
  clientLabel: clientLabel.value,
  playerClientEnabled: playerClientEnabled.value,
  displayedClientTime: displayedClientTime.value,
  displayedClientIp: displayedClientIp.value,
  waypointDetail: waypointDetail.value,
  entityHud,
  selectionHudMode: selectionHudMode.value,
  commandHotkeyPreset: commandHotkeyPreset.value,
  commandHotkeyRevision: commandHotkeyRevision.value,
  terrainTextureSmoothing: terrainTextureSmoothing.value,
  terrainLightSmoothing: terrainLightSmoothing.value,
  terrainTextureSmoothAcrossWallBoundary:
    terrainTextureSmoothAcrossWallBoundary.value,
  terrainLightSmoothAcrossWallBoundary:
    terrainLightSmoothAcrossWallBoundary.value,
  terrainSplitWallBoundaryVertices: terrainSplitWallBoundaryVertices.value,
  forceFieldsVisible: forceFieldsVisible.value,
  entityHudTypes,
  entityHudElements,
  logicMsAvg: logicMsAvg.value,
  logicMsHi: logicMsHi.value,
  renderMsAvg: renderMsAvg.value,
  renderMsHi: renderMsHi.value,
  displayGpuMs: displayGpuMs.value,
  gpuSourceLabel: gpuSourceLabel.value,
  gpuTimerSupported: gpuTimerSupported.value,
  runtimeProfile: runtimeProfile.value,
  nativePixelRatio: nativePixelRatio.value,
  activePixelRatio: activePixelRatio.value,
  dynamicPixelRatioEnabled: dynamicPixelRatioEnabled.value,
  webglBufferProfilerSupported: webglBufferProfilerSupported.value,
  webglRendererRenderMs: webglRendererRenderMs.value,
  webglDrawCalls: webglDrawCalls.value,
  webglTriangles: webglTriangles.value,
  webglPoints: webglPoints.value,
  webglLines: webglLines.value,
  webglGeometries: webglGeometries.value,
  webglTextures: webglTextures.value,
  webglBufferDataCalls: webglBufferDataCalls.value,
  webglBufferSubDataCalls: webglBufferSubDataCalls.value,
  webglBufferUploadBytes: webglBufferUploadBytes.value,
  rendererContextMainCount: rendererContextMainCount.value,
  rendererContextAuxiliaryCount: rendererContextAuxiliaryCount.value,
  rendererContextAuxiliaryBudget: rendererContextAuxiliaryBudget.value,
  rendererContextDeniedAuxiliaryCount: rendererContextDeniedAuxiliaryCount.value,
  hudSpriteActiveCount: hudSpriteActiveCount.value,
  hudSpriteRetainedCount: hudSpriteRetainedCount.value,
  hudSpritePeakCount: hudSpritePeakCount.value,
  hudSpriteDisposedCount: hudSpriteDisposedCount.value,
  hudSpriteBudgetCount: hudSpriteBudgetCount.value,
  scopedRetainedUnitMeshes: scopedRetainedUnitMeshes.value,
  scopedRetainedBuildingMeshes: scopedRetainedBuildingMeshes.value,
  scopedMeshHiddenPerSec: scopedMeshHiddenPerSec.value,
  scopedMeshReactivatedPerSec: scopedMeshReactivatedPerSec.value,
  scopedMeshDestroyPerSec: scopedMeshDestroyPerSec.value,
  scopedMeshRebuildPerSec: scopedMeshRebuildPerSec.value,
  frameMsAvg: frameMsAvg.value,
  frameMsHi: frameMsHi.value,
  longtaskSupported: longtaskSupported.value,
  longtaskMsPerSec: longtaskMsPerSec.value,
  renderTpsAvg: renderTpsAvg.value,
  renderTpsWorst: renderTpsWorst.value,
  currentZoom: currentZoom.value,
  cameraPositionX: cameraPositionX.value,
  cameraPositionY: cameraPositionY.value,
  cameraPositionZ: cameraPositionZ.value,
  cameraDirectionX: cameraDirectionX.value,
  cameraDirectionY: cameraDirectionY.value,
  cameraDirectionZ: cameraDirectionZ.value,
  snapAvgRate: snapAvgRate.value,
  snapWorstRate: snapWorstRate.value,
  rawSnapshotReceivedRate: rawSnapshotReceivedRate.value,
  rawSnapshotAppliedRate: rawSnapshotAppliedRate.value,
  richSnapAvgRate: richSnapAvgRate.value,
  richSnapWorstRate: richSnapWorstRate.value,
  deltaSnapAvgRate: deltaSnapAvgRate.value,
  deltaSnapWorstRate: deltaSnapWorstRate.value,
  entityDeltaSnapAvgRate: entityDeltaSnapAvgRate.value,
  entityDeltaSnapWorstRate: entityDeltaSnapWorstRate.value,
  projectileDeltaSnapAvgRate: projectileDeltaSnapAvgRate.value,
  projectileDeltaSnapWorstRate: projectileDeltaSnapWorstRate.value,
  displayTickRate: displayTickRate.value,
  displaySnapshotRate: displaySnapshotRate.value,
  snapshotSizeAvgBytes: snapshotSizeAvgBytes.value,
  snapshotSizeHiBytes: snapshotSizeHiBytes.value,
  richSnapshotSizeAvgBytes: richSnapshotSizeAvgBytes.value,
  richSnapshotSizeHiBytes: richSnapshotSizeHiBytes.value,
  deltaSnapshotSizeAvgBytes: deltaSnapshotSizeAvgBytes.value,
  deltaSnapshotSizeHiBytes: deltaSnapshotSizeHiBytes.value,
  entityDeltaSnapshotSizeAvgBytes: entityDeltaSnapshotSizeAvgBytes.value,
  entityDeltaSnapshotSizeHiBytes: entityDeltaSnapshotSizeHiBytes.value,
  projectileDeltaSnapshotSizeAvgBytes: projectileDeltaSnapshotSizeAvgBytes.value,
  projectileDeltaSnapshotSizeHiBytes: projectileDeltaSnapshotSizeHiBytes.value,
  snapshotApplyAvgMs: snapshotApplyAvgMs.value,
  snapshotApplyHiMs: snapshotApplyHiMs.value,
  richSnapshotApplyAvgMs: richSnapshotApplyAvgMs.value,
  richSnapshotApplyHiMs: richSnapshotApplyHiMs.value,
  deltaSnapshotApplyAvgMs: deltaSnapshotApplyAvgMs.value,
  deltaSnapshotApplyHiMs: deltaSnapshotApplyHiMs.value,
  entityDeltaSnapshotApplyAvgMs: entityDeltaSnapshotApplyAvgMs.value,
  entityDeltaSnapshotApplyHiMs: entityDeltaSnapshotApplyHiMs.value,
  projectileDeltaSnapshotApplyAvgMs: projectileDeltaSnapshotApplyAvgMs.value,
  projectileDeltaSnapshotApplyHiMs: projectileDeltaSnapshotApplyHiMs.value,
  audioSmoothing: audioSmoothing.value,
  burnMarks: burnMarks.value,
  windParticles: windParticles.value,
  locomotionMarks: locomotionMarks.value,
  teamTrim: teamTrim.value,
  surfaceTexture: surfaceTexture.value,
  smokeTrails: smokeTrails.value,
  smokeSoftEdges: smokeSoftEdges.value,
  entityShadows: entityShadows.value,
  fogShade: fogShade.value,
  materialExplosions: materialExplosions.value,
  clientUnitGroundNormalEmaMode: clientUnitGroundNormalEmaMode.value,
  dragPanEnabled: dragPanEnabled.value,
  showServerControls: showServerControls.value,
  triangleDebug: triangleDebug.value,
  waterTriangleDebug: waterTriangleDebug.value,
  wallTriangleDebug: wallTriangleDebug.value,
  buildGridDebugMode: buildGridDebugMode.value,
  pathingHierarchyDebug: pathingHierarchyDebug.value,
  airLiftProbeDebug: airLiftProbeDebug.value,
  zoomPointsDebug: zoomPointsDebug.value,
  metalMap: metalMap.value,
  elevationMap: elevationMap.value,
  pathingMap: pathingMap.value,
  pathingDebugUnit: pathingDebugUnit.value,
  pathingDebugMode: pathingDebugMode.value,
  renderMode: renderMode.value,
  audioScope: audioScope.value,
  masterVolume: masterVolume.value,
  environmentLight: environmentLight.value,
  ambientLight: ambientLight.value,
  directionalLight: directionalLight.value,
  skyLight: skyLight.value,
  exposure: exposure.value,
  allSoundsActive: allSoundsActive.value,
  soundToggles,
  sfxCategories: SFX_CATEGORIES,
  soundLabels: SOUND_LABELS,
  soundTooltips: SOUND_TOOLTIPS,
  allRangesActive: allRangesActive.value,
  rangeToggles,
  allVolumesActive: allVolumesActive.value,
  volumeToggles,
  legsRadiusToggle: legsRadiusToggle.value,
  legsReachToggle: legsReachToggle.value,
  lodMode: lodMode.value,
  aaMsaaMode: aaMsaaMode.value,
  aaResolutionMode: aaResolutionMode.value,
  antialiasSamples: antialiasSamples.value,
  cameraFovDegrees: cameraFovDegrees.value,
  cameraSmoothMode: cameraSmoothMode.value,
  cameraFollowMode: cameraFollowMode.value,
  waterBoundaryMode: waterBoundaryMode.value,
  uiChromeVisible: uiChromeVisible.value,
  mapDetailsVisible: mapDetailsVisible.value,
  optionsMenuOpen: optionsMenuOpen.value,
  resetClientDefaults: resetClientDefaultsWithTerrainRender,
  togglePlayerClientEnabled,
  changeWaypointDetail,
  toggleEntityHud,
  changeSelectionHudMode,
  changeCommandHotkeyPreset,
  refreshCommandHotkeys,
  applyTerrainTextureSmoothing,
  applyTerrainLightSmoothing,
  toggleTerrainTextureSmoothAcrossWallBoundary,
  toggleTerrainLightSmoothAcrossWallBoundary,
  toggleTerrainSplitWallBoundaryVertices,
  toggleForceFieldsVisible,
  toggleAudioSmoothing,
  toggleBurnMarks,
  toggleWindParticles,
  toggleTeamTrim,
  toggleSurfaceTexture,
  toggleLocomotionMarks,
  toggleSmokeTrails,
  toggleSmokeSoftEdges,
  toggleEntityShadows,
  toggleFogShade,
  toggleMaterialExplosions,
  changeClientUnitGroundNormalEmaMode,
  toggleDragPan,
  toggleTriangleDebug,
  toggleWaterTriangleDebug,
  toggleWallTriangleDebug,
  changeBuildGridDebugMode,
  togglePathingHierarchyDebug,
  toggleAirLiftProbeDebug,
  toggleZoomPointsDebug,
  toggleMetalMap,
  toggleElevationMap,
  togglePathingMap,
  changePathingDebugMode,
  changePathingDebugUnit,
  changeRenderMode,
  changeAudioScope,
  changeMasterVolume,
  changeEnvironmentLight,
  changeAmbientLight,
  changeDirectionalLight,
  changeSkyLight,
  changeExposure,
  setGamePaused,
  toggleAllSounds,
  toggleSoundCategory,
  toggleAllRanges,
  toggleRange,
  toggleAllVolumes,
  toggleVolume,
  toggleLegsRadius,
  toggleLegsReach,
  changeLodMode,
  changeAaMsaaMode,
  changeAaResolutionMode,
  changeCameraFovDegrees,
  changeWaterBoundaryMode,
  setCameraMode,
  setCameraViewMode,
  setCameraFollowMode: setCameraFollow,
  showMapOverview,
  flipCameraYaw,
  setCameraAnchor,
  focusCameraAnchor,
  captureScreenshot,
  goToLastPing,
  toggleUiChrome,
  toggleMapDetails,
  toggleOptionsMenu,
});
watchEffect(() => {
  const m = clientControlBarModel as {
    -readonly [K in keyof GameCanvasClientControlBarModel]: GameCanvasClientControlBarModel[K];
  };
  m.barStyle = clientBarVars.value;
  m.clientLabel = clientLabel.value;
  m.playerClientEnabled = playerClientEnabled.value;
  m.displayedClientTime = displayedClientTime.value;
  m.displayedClientIp = displayedClientIp.value;
  m.waypointDetail = waypointDetail.value;
  m.selectionHudMode = selectionHudMode.value;
  m.commandHotkeyPreset = commandHotkeyPreset.value;
  m.commandHotkeyRevision = commandHotkeyRevision.value;
  m.terrainTextureSmoothing = terrainTextureSmoothing.value;
  m.terrainLightSmoothing = terrainLightSmoothing.value;
  m.terrainTextureSmoothAcrossWallBoundary =
    terrainTextureSmoothAcrossWallBoundary.value;
  m.terrainLightSmoothAcrossWallBoundary =
    terrainLightSmoothAcrossWallBoundary.value;
  m.terrainSplitWallBoundaryVertices =
    terrainSplitWallBoundaryVertices.value;
  m.forceFieldsVisible = forceFieldsVisible.value;
  m.logicMsAvg = logicMsAvg.value;
  m.logicMsHi = logicMsHi.value;
  m.renderMsAvg = renderMsAvg.value;
  m.renderMsHi = renderMsHi.value;
  m.displayGpuMs = displayGpuMs.value;
  m.gpuSourceLabel = gpuSourceLabel.value;
  m.gpuTimerSupported = gpuTimerSupported.value;
  m.runtimeProfile = runtimeProfile.value;
  m.nativePixelRatio = nativePixelRatio.value;
  m.activePixelRatio = activePixelRatio.value;
  m.dynamicPixelRatioEnabled = dynamicPixelRatioEnabled.value;
  m.webglBufferProfilerSupported = webglBufferProfilerSupported.value;
  m.webglRendererRenderMs = webglRendererRenderMs.value;
  m.webglDrawCalls = webglDrawCalls.value;
  m.webglTriangles = webglTriangles.value;
  m.webglPoints = webglPoints.value;
  m.webglLines = webglLines.value;
  m.webglGeometries = webglGeometries.value;
  m.webglTextures = webglTextures.value;
  m.webglBufferDataCalls = webglBufferDataCalls.value;
  m.webglBufferSubDataCalls = webglBufferSubDataCalls.value;
  m.webglBufferUploadBytes = webglBufferUploadBytes.value;
  m.rendererContextMainCount = rendererContextMainCount.value;
  m.rendererContextAuxiliaryCount = rendererContextAuxiliaryCount.value;
  m.rendererContextAuxiliaryBudget = rendererContextAuxiliaryBudget.value;
  m.rendererContextDeniedAuxiliaryCount = rendererContextDeniedAuxiliaryCount.value;
  m.hudSpriteActiveCount = hudSpriteActiveCount.value;
  m.hudSpriteRetainedCount = hudSpriteRetainedCount.value;
  m.hudSpritePeakCount = hudSpritePeakCount.value;
  m.hudSpriteDisposedCount = hudSpriteDisposedCount.value;
  m.hudSpriteBudgetCount = hudSpriteBudgetCount.value;
  m.scopedRetainedUnitMeshes = scopedRetainedUnitMeshes.value;
  m.scopedRetainedBuildingMeshes = scopedRetainedBuildingMeshes.value;
  m.scopedMeshHiddenPerSec = scopedMeshHiddenPerSec.value;
  m.scopedMeshReactivatedPerSec = scopedMeshReactivatedPerSec.value;
  m.scopedMeshDestroyPerSec = scopedMeshDestroyPerSec.value;
  m.scopedMeshRebuildPerSec = scopedMeshRebuildPerSec.value;
  m.frameMsAvg = frameMsAvg.value;
  m.frameMsHi = frameMsHi.value;
  m.longtaskSupported = longtaskSupported.value;
  m.longtaskMsPerSec = longtaskMsPerSec.value;
  m.renderTpsAvg = renderTpsAvg.value;
  m.renderTpsWorst = renderTpsWorst.value;
  m.currentZoom = currentZoom.value;
  m.cameraPositionX = cameraPositionX.value;
  m.cameraPositionY = cameraPositionY.value;
  m.cameraPositionZ = cameraPositionZ.value;
  m.cameraDirectionX = cameraDirectionX.value;
  m.cameraDirectionY = cameraDirectionY.value;
  m.cameraDirectionZ = cameraDirectionZ.value;
  m.snapAvgRate = snapAvgRate.value;
  m.snapWorstRate = snapWorstRate.value;
  m.rawSnapshotReceivedRate = rawSnapshotReceivedRate.value;
  m.rawSnapshotAppliedRate = rawSnapshotAppliedRate.value;
  m.richSnapAvgRate = richSnapAvgRate.value;
  m.richSnapWorstRate = richSnapWorstRate.value;
  m.deltaSnapAvgRate = deltaSnapAvgRate.value;
  m.deltaSnapWorstRate = deltaSnapWorstRate.value;
  m.entityDeltaSnapAvgRate = entityDeltaSnapAvgRate.value;
  m.entityDeltaSnapWorstRate = entityDeltaSnapWorstRate.value;
  m.projectileDeltaSnapAvgRate = projectileDeltaSnapAvgRate.value;
  m.projectileDeltaSnapWorstRate = projectileDeltaSnapWorstRate.value;
  m.displayTickRate = displayTickRate.value;
  m.displaySnapshotRate = displaySnapshotRate.value;
  m.snapshotSizeAvgBytes = snapshotSizeAvgBytes.value;
  m.snapshotSizeHiBytes = snapshotSizeHiBytes.value;
  m.richSnapshotSizeAvgBytes = richSnapshotSizeAvgBytes.value;
  m.richSnapshotSizeHiBytes = richSnapshotSizeHiBytes.value;
  m.deltaSnapshotSizeAvgBytes = deltaSnapshotSizeAvgBytes.value;
  m.deltaSnapshotSizeHiBytes = deltaSnapshotSizeHiBytes.value;
  m.entityDeltaSnapshotSizeAvgBytes = entityDeltaSnapshotSizeAvgBytes.value;
  m.entityDeltaSnapshotSizeHiBytes = entityDeltaSnapshotSizeHiBytes.value;
  m.projectileDeltaSnapshotSizeAvgBytes = projectileDeltaSnapshotSizeAvgBytes.value;
  m.projectileDeltaSnapshotSizeHiBytes = projectileDeltaSnapshotSizeHiBytes.value;
  m.snapshotApplyAvgMs = snapshotApplyAvgMs.value;
  m.snapshotApplyHiMs = snapshotApplyHiMs.value;
  m.richSnapshotApplyAvgMs = richSnapshotApplyAvgMs.value;
  m.richSnapshotApplyHiMs = richSnapshotApplyHiMs.value;
  m.deltaSnapshotApplyAvgMs = deltaSnapshotApplyAvgMs.value;
  m.deltaSnapshotApplyHiMs = deltaSnapshotApplyHiMs.value;
  m.entityDeltaSnapshotApplyAvgMs = entityDeltaSnapshotApplyAvgMs.value;
  m.entityDeltaSnapshotApplyHiMs = entityDeltaSnapshotApplyHiMs.value;
  m.projectileDeltaSnapshotApplyAvgMs = projectileDeltaSnapshotApplyAvgMs.value;
  m.projectileDeltaSnapshotApplyHiMs = projectileDeltaSnapshotApplyHiMs.value;
  m.audioSmoothing = audioSmoothing.value;
  m.burnMarks = burnMarks.value;
  m.windParticles = windParticles.value;
  m.locomotionMarks = locomotionMarks.value;
  m.teamTrim = teamTrim.value;
  m.surfaceTexture = surfaceTexture.value;
  m.smokeTrails = smokeTrails.value;
  m.smokeSoftEdges = smokeSoftEdges.value;
  m.entityShadows = entityShadows.value;
  m.fogShade = fogShade.value;
  m.materialExplosions = materialExplosions.value;
  m.clientUnitGroundNormalEmaMode = clientUnitGroundNormalEmaMode.value;
  m.dragPanEnabled = dragPanEnabled.value;
  m.showServerControls = showServerControls.value;
  m.triangleDebug = triangleDebug.value;
  m.waterTriangleDebug = waterTriangleDebug.value;
  m.wallTriangleDebug = wallTriangleDebug.value;
  m.buildGridDebugMode = buildGridDebugMode.value;
  m.pathingHierarchyDebug = pathingHierarchyDebug.value;
  m.airLiftProbeDebug = airLiftProbeDebug.value;
  m.zoomPointsDebug = zoomPointsDebug.value;
  m.metalMap = metalMap.value;
  m.elevationMap = elevationMap.value;
  m.pathingMap = pathingMap.value;
  m.pathingDebugUnit = pathingDebugUnit.value;
  m.pathingDebugMode = pathingDebugMode.value;
  m.renderMode = renderMode.value;
  m.audioScope = audioScope.value;
  m.masterVolume = masterVolume.value;
  m.environmentLight = environmentLight.value;
  m.ambientLight = ambientLight.value;
  m.directionalLight = directionalLight.value;
  m.skyLight = skyLight.value;
  m.exposure = exposure.value;
  m.allSoundsActive = allSoundsActive.value;
  m.allRangesActive = allRangesActive.value;
  m.allVolumesActive = allVolumesActive.value;
  m.legsRadiusToggle = legsRadiusToggle.value;
  m.legsReachToggle = legsReachToggle.value;
  m.lodMode = lodMode.value;
  m.aaMsaaMode = aaMsaaMode.value;
  m.aaResolutionMode = aaResolutionMode.value;
  m.antialiasSamples = antialiasSamples.value;
  m.cameraFovDegrees = cameraFovDegrees.value;
  m.cameraSmoothMode = cameraSmoothMode.value;
  m.cameraFollowMode = cameraFollowMode.value;
  m.waterBoundaryMode = waterBoundaryMode.value;
  m.uiChromeVisible = uiChromeVisible.value;
  m.mapDetailsVisible = mapDetailsVisible.value;
  m.optionsMenuOpen = optionsMenuOpen.value;
});

</script>

<template>
  <div
    class="game-wrapper"
    :class="{ 'menu-sidebar-open': menuSidebarOpen }"
    :style="gameWrapperStyle"
  >
    <!-- Top status bar lives outside the 3D game area, like the bottom controls. -->
    <div
      v-if="topChromeVisible"
      class="top-controls-shell"
    >
      <TopBar
        :economy="economyInfo"
        :direction-data="minimapData"
        :network-status="networkStatus"
        :network-warning="networkNotice"
      />
    </div>

    <div
      ref="gameAreaRef"
      class="game-area"
      :class="{ 'player-client-off': !playerClientEnabled }"
    >
      <!-- Background battle container (demo game).
           Loads full-screen behind the BUDGET ANNIHILATION screen
           exactly as before. Once the user clicks Host/Join AND
           lands in the GAME LOBBY state, the lobby-preview composable
           re-parents this element into the lobby modal's
           `#lobby-preview-target` so the demo runs as a small preview
           pane. Vue Teleport was the
           obvious tool but its interaction with the demo battle's
           per-frame reactive updates triggered "Cannot set
           properties of null" patcher crashes on initial mount;
           an imperative move keeps Vue's vnode tree stable. -->
      <div
        ref="backgroundContainerRef"
        class="background-battle-container"
        :class="{ 'loading-active': showDemoLoadingOverlay }"
        v-show="!gameStarted"
      >
        <div
          v-if="showDemoLoadingOverlay"
          class="battle-loading-overlay"
          role="status"
          aria-live="polite"
        >
          <LoadingEmblem
            :progress="displayedLoadingProgress"
            :phase="displayedLoadingPhase"
            :next-label="loadingNextLabel"
          />
        </div>
      </div>

      <!-- Main game container (real game) -->
      <div
        ref="containerRef"
        class="game-container"
        :class="{ 'loading-active': showRealLoadingOverlay }"
        v-show="gameStarted"
      >
        <div
          v-if="showRealLoadingOverlay"
          class="battle-loading-overlay"
          role="status"
          aria-live="polite"
        >
          <LoadingEmblem
            :progress="displayedLoadingProgress"
            :phase="displayedLoadingPhase"
            :next-label="loadingNextLabel"
          />
        </div>
      </div>

      <div
        v-if="playerClientOffOverlayVisible"
        class="player-client-off-overlay"
        role="status"
        aria-live="polite"
      >
        <LoadingEmblem
          :show-progress="false"
          phase="Client paused — toggle CLIENT to resume"
          :next-label="loadingNextLabel"
        />
      </div>

      <!-- The pause is unmissable: a dimmed world and PAUSED in the middle
           of it, for every way the game stops — manual pause (demo or
           lockstep), match hold, desync. Clicking resumes where a click can
           resume; the control bars sit above the scrim and stay usable. -->
      <div
        v-if="pausedOverlayVisible"
        class="game-paused-overlay"
        :class="{ resumable: pausedOverlayResumable }"
        role="status"
        aria-live="polite"
        :title="pausedOverlayResumable ? 'Click to resume' : undefined"
        @click="pausedOverlayResumable ? setGamePaused(false) : undefined"
      >
        <div class="game-paused-title">⏸ PAUSED</div>
        <div class="game-paused-subtitle">{{ pausedOverlaySubtitle }}</div>
      </div>

      <CaptureControlGrid
        v-if="gameplayHudVisible"
        :availability="captureUi.availability"
        :lifecycle-state="captureUi.lifecycleState"
        :recording-mode-id="captureUi.recordingModeId"
        :recording-started-at-ms="captureUi.recordingStartedAtMs"
        @trigger="triggerCapture"
      />

      <button
        v-if="gameplayHudVisible"
        type="button"
        class="fullscreen-game-toggle"
        :class="{ active: fullscreenActive }"
        :aria-label="fullscreenActive ? 'Exit fullscreen and return to window' : 'Enter fullscreen'"
        :aria-pressed="fullscreenActive"
        :title="fullscreenActive ? 'Exit fullscreen — return to window' : 'Enter fullscreen'"
        @click.stop="toggleFullscreen"
      >
        <FullscreenToggleIcon :fullscreen="fullscreenActive" />
      </button>

      <!-- Game UI (hidden during loading/client-off; desktop also hides behind full-screen lobby) -->
      <template v-if="gameplayHudVisible">
        <!-- Selection panel (bottom-left) -->
        <SelectionPanel
          :selection="selectionInfo"
          :actions="selectionActions"
          :hotkey-preset="commandHotkeyPreset"
          :hotkey-revision="commandHotkeyRevision"
          :playable-bottom-inset-px="playableBottomInsetPx"
        />

        <!-- Idle builders (bottom-center, BAR gui_idle_builders) -->
        <IdleBuildersPanel
          :groups="idleBuilders"
          :playable-bottom-inset-px="playableBottomInsetPx"
          @cycle="cycleIdleBuilder"
          @add-all="addIdleBuildersToSelection"
          @center="focusIdleBuilder"
        />

        <!-- Hold-I unit stats peek (BAR gui_unit_stats) -->
        <UnitStatsOverlay
          v-if="unitStatsHeld && unitStatsOverlayInfo !== null"
          :info="unitStatsOverlayInfo"
        />

        <!-- Minimap -->
        <div class="minimap-stack">
          <Minimap
            :data="minimapData"
            @click="handleMinimapInteraction"
            @command="handleMinimapCommandInteraction"
          />
        </div>

        <!-- BAR-style corner console. In a battle it is the session's rooms
             (ALL public / TEAM-or-SPEC); at home it is the games.niemo.io
             global room, since the player is connected to nobody yet. -->
        <ChatConsole
          v-if="gameStarted"
          ref="battleChatRef"
          class="hud-chat"
          :messages="sessionChatConsoleMessages"
          :channels="battleChatChannels"
          :active-channel-id="chatChannelId"
          placeholder="Enter to chat"
          @send="sendBattleChat"
          @update:active-channel-id="(id: string) => (chatChannelId = id === 'all' ? 'all' : 'team')"
        />
        <ChatConsole
          v-else
          ref="homeChatRef"
          class="hud-chat"
          :messages="globalChatConsoleMessages"
          :channels="GLOBAL_CHAT_CHANNELS"
          active-channel-id="global"
          placeholder="Enter to chat with everyone online"
          @send="sendGlobalChat"
        />

        <section
          v-if="mapDetailsVisible"
          class="map-details-panel"
          aria-label="Map details"
        >
          <div class="map-details-header">
            <span>MAP INFO</span>
            <button
              class="map-details-close"
              title="Close map details"
              aria-label="Close map details"
              @click="mapDetailsVisible = false"
            >X</button>
          </div>
          <dl class="map-details-list">
            <template
              v-for="row in mapDetailsRows"
              :key="row.label"
            >
              <dt>{{ row.label }}</dt>
              <dd>{{ row.value }}</dd>
            </template>
          </dl>
        </section>

        <section
          v-if="optionsMenuOpen"
          class="options-menu-panel"
          aria-label="Options menu"
        >
          <div class="options-menu-header">
            <span>OPTIONS</span>
            <button
              class="options-menu-close"
              title="Close options menu"
              aria-label="Close options menu"
              @click="optionsMenuOpen = false"
            >X</button>
          </div>
          <div class="options-menu-grid">
            <button
              type="button"
              :class="{ active: fullscreenActive }"
              :aria-label="fullscreenActive ? 'Exit fullscreen and return to window' : 'Enter fullscreen'"
              :title="fullscreenActive ? 'Exit fullscreen — return to window' : 'Enter fullscreen'"
              @click="toggleFullscreen"
            ><FullscreenToggleIcon :fullscreen="fullscreenActive" /></button>
            <button
              type="button"
              @click="captureScreenshot"
            >SHOT</button>
            <button
              type="button"
              @click="downloadReplay"
            >RPLY</button>
            <button
              type="button"
              :class="{ active: mapDetailsVisible }"
              @click="toggleMapDetails"
            >INFO</button>
            <button
              type="button"
              @click="showMapOverview"
            >OVR</button>
            <button
              type="button"
              @click="goToLastPing"
            >PING</button>
            <button
              type="button"
              :class="{ active: uiChromeVisible }"
              @click="toggleUiChrome"
            >UI</button>
            <button
              type="button"
              :class="{ active: gamePhase === 'paused' }"
              :title="gamePhase === 'paused' ? 'Resume the game' : 'Pause the game'"
              @click="setGamePaused(gamePhase !== 'paused')"
            >PAUSE</button>
            <button
              v-if="gameStarted"
              type="button"
              class="options-menu-leave"
              title="Leave the match and return to the lobby"
              @click="optionsMenuOpen = false; restartGame()"
            >LEAVE</button>
          </div>
        </section>
      </template>
    </div>

    <!-- Bottom control bars (desktop: hidden when lobby modal visible; mobile: toggled) -->
    <div
      v-if="bottomChromeVisible"
      class="bottom-controls-shell"
      :class="{ collapsed: !isMobile && bottomBarsCollapsed }"
    >
      <button
        v-if="!isMobile"
        class="bottom-controls-toggle"
        :aria-expanded="!bottomBarsCollapsed"
        :aria-label="bottomBarsCollapsed ? 'Show bottom controls' : 'Hide bottom controls'"
        :title="bottomBarsCollapsed ? 'Show bottom controls' : 'Hide bottom controls'"
        @click="toggleBottomBars"
      >
        <ChevronIcon :direction="bottomBarsCollapsed ? 'up' : 'down'" />
      </button>

      <div
        v-show="isMobile || !bottomBarsCollapsed"
        ref="bottomControlsRef"
        class="bottom-controls"
      >
        <GameCanvasBattleControlBar
          v-if="showServerControls && currentBattleMode === 'demo'"
          :model="battleControlBarModel"
        />
        <GameCanvasServerControlBar
          v-if="showServerControls"
          :model="serverControlBarModel"
        />
        <GameCanvasClientControlBar :model="clientControlBarModel" />
      </div>

    </div>

    <button
      v-if="!uiChromeVisible"
      class="ui-chrome-restore"
      title="Show UI"
      aria-label="Show UI"
      @click="toggleUiChrome"
    >
      UI
    </button>

    <div
      v-if="showLobbyControlsSidebar"
      class="lobby-controls-sidebar"
      :class="{ open: lobbyControlsSidebarOpen }"
    >
      <button
        class="lobby-controls-sidebar-toggle"
        :aria-expanded="lobbyControlsSidebarOpen"
        :aria-label="lobbyControlsSidebarOpen ? 'Close lobby server and client controls' : 'Open lobby server and client controls'"
        :title="lobbyControlsSidebarOpen ? 'Close server/client controls' : 'Open server/client controls'"
        @click="lobbyControlsSidebarOpen = !lobbyControlsSidebarOpen"
      >
        <span class="toggle-dot"></span>
        <span class="toggle-dot"></span>
        <span class="toggle-dot"></span>
      </button>

      <aside
        class="lobby-controls-sidebar-panel"
        aria-label="Lobby server and client controls"
        :aria-hidden="!lobbyControlsSidebarOpen"
      >
        <GameCanvasServerControlBar
          v-if="showServerControls"
          :model="serverControlBarModel"
        />
        <GameCanvasClientControlBar :model="clientControlBarModel" />
      </aside>
    </div>

    <!-- Lobby Modal. The startup (BUDGET ANNIHILATION) screen renders
         as a non-blocking right-edge sidebar (`sidebar-open` slides it
         in/out) over the live, interactive demo battle. The connecting
         and GAME LOBBY screens still render as full-screen modals. Once
         `roomCode` is set (the user clicked Host or finished joining),
         the GAME LOBBY screen renders a `#lobby-preview-target` div
         inside the modal; the demo container teleports into it and the
         demo battle runs as a small simulation preview alongside the
         lobby's terrain / player controls. -->
    <LobbyModal
      :visible="!isMobile && showLobby"
      :sidebar-open="!menuHidden"
      :is-host="isHost"
      :room-code="roomCode"
      :players="lobbyPlayers"
      :spectators="lobbySpectators"
      :local-player-id="localPlayerId"
      :local-member-id="networkManager.getLocalMemberId()"
      :seated-member-ids="seatedMemberIds"
      :chat-messages="sessionChatConsoleMessages"
      :error="lobbyError"
      :is-connecting="isConnecting"
      :center-magnitude="centerMagnitude"
      :ring-magnitude="ringMagnitude"
      :dividers-magnitude="dividersMagnitude"
      :perimeter-magnitude="perimeterMagnitude"
      :liquid-surface-mode="currentLiquidSurfaceMode"
      :terrain-precedence="terrainPrecedence"
      :terrain-d-terrain="terrainDTerrain"
      :plateau-wall-slope-degrees="plateauWallSlopeDegrees"
      :metal-deposit-step="metalDepositStep"
      :terrain-detail="terrainDetail"
      :pathfinding-cell-consolidation="pathfindingCellConsolidation"
      :simulation-tick-rate-hz="simulationTickRateHz"
      :map-width-land-cells="mapWidthLandCells"
      :map-length-land-cells="mapLengthLandCells"
      :unit-blueprint-ids="demoUnitBlueprintIds"
      :allowed-units="currentAllowedUnits"
      :building-blueprint-ids="demoBuildingBlueprintIds"
      :allowed-buildings="currentAllowedBuildings"
      :unit-cap="displayUnitCap"
      :ally-team-count="lobbyAllyTeamCount"
      :lobby-name="lobbyName"
      :converter-tax="currentConverterTax"
      :preview-loading="loadingInLobbyPreview"
      :preview-loading-progress="displayedLoadingProgress"
      :preview-loading-phase="displayedLoadingPhase"
      :presets="BATTLE_PRESETS"
      :active-preset-name="battleControlBarModel.activePresetName"
      @host="handleHost"
      @join="handleJoin"
      @start="handleLobbyStart"
      @cancel="handleLobbyCancel"
      @host-local="handleHostLocal"
      @entity-lab="openEntityLab"
      @game-controls="openGameControls"
      @chat-send="sendLobbyChat"
      @add-bot-seat="(teamId: number) => networkManager.addBotSeat(teamId)"
      @remove-bot-seat="(pid: PlayerId) => networkManager.removeBotSeat(pid)"
      @cycle-bot-ally-team="cycleBotAllyTeam"
      @set-seat-initial-state="(pid: PlayerId, state: 'commander' | 'base') => networkManager.setSeatInitialState(pid, state)"
      @toggle-menu="handleMenuToggle"
      @set-center-magnitude="(v) => applyCenterMagnitude(v)"
      @set-ring-magnitude="(v) => applyRingMagnitude(v)"
      @set-dividers-magnitude="(v) => applyDividersMagnitude(v)"
      @set-perimeter-magnitude="(v) => applyPerimeterMagnitude(v)"
      @set-terrain-precedence="(v) => applyTerrainPrecedence(v)"
      @set-terrain-d-terrain="(v) => applyTerrainDTerrain(v)"
      @set-plateau-wall-slope-degrees="(v) => applyPlateauWallSlopeDegrees(v)"
      @set-metal-deposit-step="(v) => applyMetalDepositStep(v)"
      @set-terrain-detail="(v) => applyTerrainDetail(v)"
      @set-pathfinding-cell-consolidation="(v) => applyPathfindingCellConsolidation(v)"
      @set-simulation-tick-rate="(v) => applySimulationTickRate(v)"
      @set-preset="(p) => applyPreset(p)"
      @set-map-land-dimensions="(dimensions) => applyMapLandDimensions(dimensions)"
      @toggle-unit="(ut) => toggleDemoUnitBlueprintId(ut)"
      @toggle-all-units="toggleAllDemoUnits"
      @toggle-building="(bt) => toggleDemoBuildingBlueprintId(bt)"
      @toggle-all-buildings="toggleAllDemoBuildings"
      @set-unit-cap="(c) => changeEntityCountCap(c)"
      @set-ally-team-count="setLobbyAllyTeamCount"
      @add-ally-team="addLobbyAllyTeam"
      @remove-ally-team="removeLobbyAllyTeam"
      @set-lobby-name="setLobbyName"
      @cycle-member-ally-team="cycleMemberAllyTeam"
      @toggle-member-seated="toggleMemberSeated"
      @set-converter-tax="(v) => setConverterTax(v)"
      @set-player-name="onPlayerNameChange"
      @reset-defaults="resetBattleDefaultsWithGroundNormal"
    />

    <NetworkPeerLagIndicator
      v-if="gameStarted && networkRole !== null && matchHold === null"
      :peers="laggingPeers"
      :resolve-player-name="resolvePlayerName"
      :get-player-color="getPlayerColor"
    />

    <!-- Distinct from the lag indicator above: that one names who is BEHIND
         while everyone still plays, this one appears only when nothing is
         advancing at all. Showing both at once would say the same thing
         twice, so the hold takes over. -->
    <!-- Both economies at once: the thing a watcher wants and a player cannot
         have. Free to show, because this peer already holds the whole world. -->
    <SpectatorTeamOverlay
      v-if="gameStarted && localRole === 'spectator' && lobbyPlayers.length > 0"
      :players="lobbyPlayers"
      :revision="spectatorOverlayRevision"
      :get-player-color="getPlayerColor"
      :entity-count-for="spectatorEntityCountFor"
    />

    <!-- A watcher picks whose vision to borrow, or none at all. Only shown to
         someone who actually holds no seat: for a player the view and the
         seat are the same thing. -->
    <SpectatorViewBar
      v-if="gameStarted && localRole === 'spectator' && lobbyPlayers.length > 0"
      :players="lobbyPlayers"
      :watching="watchingPlayerId"
      :get-player-color="getPlayerColor"
      @watch="watchPlayer"
    />

    <NetworkMatchHoldBanner
      v-if="gameStarted && networkRole !== null"
      :hold="matchHold"
      :resolve-player-name="resolvePlayerName"
      :get-player-color="getPlayerColor"
      :drop-after-seconds="ARCHITECTURE_CONFIG.lockstep.flowControl.dropAfterSeconds"
    />

    <GameCanvasOverlays
      :is-mobile="isMobile"
      :show-lobby="showLobby"
      :hud-visible="overlayControlsVisible"
      :mobile-bars-visible="mobileBarsVisible"
      :game-started="gameStarted"
      :current-battle-mode="currentBattleMode"
      :get-orbit="getActiveOrbitCamera"
      :game-over-winner="gameOverWinner"
      :winner-name="winningAllyTeamName"
      :winner-color="gameOverWinner === null ? '' : getPlayerColor(gameOverWinner)"
      :host-left-seconds-remaining="hostLeftSecondsRemaining"
      @exit-after-host-left="exitAfterHostLeft"
      @toggle-mobile-bars="mobileBarsVisible = !mobileBarsVisible"
      @dismiss-game-over="gameOverWinner = null; menuHidden = true"
      @restart-game="restartGame"
    />
  </div>
</template>

<style scoped src="./gameCanvas.css"></style>
