<script setup lang="ts">
import { ref, computed, reactive, shallowRef, watch, watchEffect, onMounted, onBeforeUnmount, nextTick } from 'vue';
import type { GameInstance } from '../game/createGame';
import type { PlayerId } from '../game/sim/types';
import type { BackgroundBattleState } from '../game/lobby/LobbyManager';
import SelectionPanel from './SelectionPanel.vue';
import TopBar from './TopBar.vue';
import Minimap from './Minimap.vue';
import IdleBuildersPanel from './IdleBuildersPanel.vue';
import UnitStatsOverlay from './UnitStatsOverlay.vue';
import type { UnitStatsOverlayInfo } from '../game/scenes/helpers';
import LobbyModal, { type LobbyPlayer } from './LobbyModal.vue';
import GameCanvasOverlays from './GameCanvasOverlays.vue';
import GameCanvasBattleControlBar from './GameCanvasBattleControlBar.vue';
import GameCanvasServerControlBar from './GameCanvasServerControlBar.vue';
import GameCanvasClientControlBar from './GameCanvasClientControlBar.vue';
import LoadingEmblem from './LoadingEmblem.vue';
import ChevronIcon from './ChevronIcon.vue';
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
  BAR_MAP_DRAW_DOUBLE_TAP_MS,
  CommandHotkeySequenceResolver,
  barMapDrawCommandForTapCount,
  barMapDrawHotkeySignature,
  type CommandHotkeyId,
} from '../game/input/commandHotkeys';
import { BACKGROUND_UNIT_BLUEPRINT_IDS } from '../game/server/BackgroundBattleStandalone';
import { BUILDING_BLUEPRINT_IDS, TOWER_BLUEPRINT_IDS } from '../types/blueprintIds';
import {
  BATTLE_CONFIG,
  loadStoredCap,
  loadStoredCenterMagnitude,
  loadStoredDividersMagnitude,
  loadStoredTerrainDTerrain,
  loadStoredMetalDepositStep,
  loadStoredPlateauWallSlopeDegrees,
  loadStoredWatersEdgeBeachSlopeDegrees,
  loadStoredWatersEdgeCliffHeight,
  loadStoredTerrainDetail,
  loadStoredPerimeterMagnitude,
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
import type {
  NetworkCommunicationDraft,
  NetworkCommunicationEvent,
  NetworkCommunicationMapDrawingEvent,
  NetworkCommunicationMapEraseEvent,
  NetworkCommunicationPoint,
} from '../types/network';
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
import { BATTLE_PRESETS, findMatchingPresetName } from './battlePresets';
import { useGameCanvasServerSettings } from './gameCanvasServerSettings';
import { useGameCanvasClientSettings } from './gameCanvasClientSettings';
import { useGameCanvasRealBattleHandoff } from './gameCanvasRealBattleHandoff';
import { useGameCanvasSceneUi } from './gameCanvasSceneUi';
import { useGameCanvasSessionLifecycle } from './gameCanvasSessionLifecycle';
import { useGameCanvasShellDisplay } from './gameCanvasShellDisplay';
import { useGameCanvasLobbyRoster } from './gameCanvasLobbyRoster';
import {
  HUD_MINIMAP_FOLLOW_TOP_PX,
  HUD_MINIMAP_MAX_PX,
  HUD_MINIMAP_STACK_GAP_PX,
} from './hudLayout';
import { LAND_CELL_SIZE } from '../mapSizeConfig';
import { ARCHITECTURE_CONFIG } from '../architectureConfig';

const isMobile =
  /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent,
  );

const emit = defineEmits<{
  openEntityLab: [];
}>();

const props = withDefaults(defineProps<{
  initialSurface?: 'demoBattle' | 'lobby' | 'onlineGame';
}>(), {
  initialSurface: 'lobby',
});

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
const displayedLoadingProgress = computed(() => loadingProgress.value);
const displayedLoadingPhase = computed(() => loadingPhase.value);
const gameWrapperStyle = computed(() => ({
  '--hud-minimap-max': `${HUD_MINIMAP_MAX_PX}px`,
  '--hud-minimap-gap': `${HUD_MINIMAP_STACK_GAP_PX}px`,
  '--hud-minimap-follow-top': `${HUD_MINIMAP_FOLLOW_TOP_PX}px`,
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
const lobbyPlayers = ref<LobbyPlayer[]>([]);
const localPlayerId = ref<PlayerId>(1);
const lobbyError = ref<string | null>(null);
const isConnecting = ref(false);
const gameStarted = ref(false);
const currentBattleMode = computed<BattleMode>(
  () => (gameStarted.value || roomCode.value !== '' ? 'real' : 'demo'),
);
const {
  mobileBarsVisible,
  spectateMode,
  bottomBarsCollapsed,
  playerClientEnabled,
  toggleBottomBars,
  togglePlayerClientEnabled,
  toggleSpectateMode,
} = useGameCanvasChromeState(currentBattleMode, applyPlayerClientEnabled);

// The sidebar's open/closed state is restored from localStorage by
// useGameCanvasChromeState, which is what lets it persist across reloads.
// A plain page load / refresh always comes up on the 'lobby' surface, so
// that case must keep the restored value untouched. Only the explicit
// entry surfaces reached by navigating from the entity lab override it,
// and they set the flag directly (never via toggleSpectateMode) so they
// don't overwrite the saved preference in storage.
if (props.initialSurface === 'demoBattle') {
  spectateMode.value = true; // slide the menu out of the way to watch the demo
} else if (props.initialSurface === 'onlineGame') {
  spectateMode.value = false; // entering the online flow surfaces the menu
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
  spectateMode,
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

const {
  localUsername,
  resolvePlayerName,
  upsertLobbyPlayer,
  onPlayerNameChange,
} = useGameCanvasLobbyRoster({
  network: networkManager,
  currentBattleMode,
  lobbyPlayers,
  localPlayerId,
});

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

function captureScreenshot(): void {
  const canvas =
    containerRef.value?.querySelector('canvas') ??
    backgroundContainerRef.value?.querySelector('canvas');
  if (!(canvas instanceof HTMLCanvasElement)) return;

  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `budget-annihilation-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, 'image/png');
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

type CommunicationMode = 'none' | 'chat' | 'draw' | 'label' | 'erase';
type CommunicationChatEvent = Extract<NetworkCommunicationEvent, { kind: 'chat' }>;

const communicationPanelOpen = ref(false);
const communicationMode = ref<CommunicationMode>('none');
const communicationMessages = ref<CommunicationChatEvent[]>([]);
const communicationDrawings = ref<NetworkCommunicationMapDrawingEvent[]>([]);
const communicationDraftText = ref('');
const communicationLabelText = ref('');
const clearMapMarksContinuous = ref(false);
const pendingDrawStart = ref<NetworkCommunicationPoint | null>(null);
const chatInputRef = ref<HTMLInputElement | null>(null);
const gameUiHotkeys = new CommandHotkeySequenceResolver();
let communicationDraftSequence = 0;
let barMapDrawTap: {
  signature: string;
  count: number;
  timeoutId: ReturnType<typeof setTimeout> | null;
} | null = null;

const minimapCommunicationDrawings = computed(() => communicationDrawings.value.map((drawing) => ({
  id: drawing.drawingId,
  kind: drawing.drawingKind,
  points: drawing.points,
  label: drawing.label,
  color: getPlayerColor(drawing.senderPlayerId),
})));

const minimapDragPanEnabled = computed(() => communicationMode.value === 'none');

function nextCommunicationDraftId(prefix: string): string {
  communicationDraftSequence++;
  return `${prefix}-${Date.now().toString(36)}-${communicationDraftSequence.toString(36)}`;
}

function createLocalCommunicationEvent(
  draft: NetworkCommunicationDraft,
  senderPlayerId: PlayerId,
): NetworkCommunicationEvent {
  const id = nextCommunicationDraftId(`local-${draft.kind}`);
  const createdAtMs = Date.now();
  switch (draft.kind) {
    case 'chat':
      return {
        kind: 'chat',
        id,
        senderPlayerId,
        createdAtMs,
        text: draft.text.trim().slice(0, 220),
      };
    case 'mapDrawing':
      return {
        kind: 'mapDrawing',
        id,
        senderPlayerId,
        createdAtMs,
        drawingId: draft.drawingId,
        drawingKind: draft.drawingKind,
        points: draft.points,
        ...(draft.label ? { label: draft.label.trim().slice(0, 48) } : {}),
      };
    case 'mapErase':
      return {
        kind: 'mapErase',
        id,
        senderPlayerId,
        createdAtMs,
        scope: draft.scope,
        ...(draft.center ? { center: draft.center } : {}),
        ...(draft.radius !== undefined ? { radius: draft.radius } : {}),
      };
  }
}

function drawingTouchesErase(
  drawing: NetworkCommunicationMapDrawingEvent,
  erase: NetworkCommunicationMapEraseEvent,
): boolean {
  if (erase.scope === 'all') return true;
  const center = erase.center;
  const radius = erase.radius;
  if (!center || radius === undefined) return false;
  const radiusSq = radius * radius;
  return drawing.points.some((point) => {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    return dx * dx + dy * dy <= radiusSq;
  });
}

function applyCommunicationEvent(event: NetworkCommunicationEvent): void {
  if (event.kind === 'chat') {
    communicationMessages.value = [...communicationMessages.value.slice(-39), event];
    communicationPanelOpen.value = true;
    return;
  }
  if (event.kind === 'mapDrawing') {
    if (clearMapMarksContinuous.value) return;
    communicationDrawings.value = [
      ...communicationDrawings.value.filter((drawing) => drawing.drawingId !== event.drawingId),
      event,
    ].slice(-80);
    return;
  }
  communicationDrawings.value = communicationDrawings.value.filter(
    (drawing) => !drawingTouchesErase(drawing, event),
  );
}

function sendCommunicationDraft(draft: NetworkCommunicationDraft): void {
  if (draft.kind === 'mapDrawing' && clearMapMarksContinuous.value) return;
  const role = networkManager.getRole();
  if (role === 'host' || role === 'client') {
    networkManager.sendCommunication(draft);
    return;
  }
  applyCommunicationEvent(createLocalCommunicationEvent(draft, activePlayer.value));
}

function setCommunicationMode(mode: CommunicationMode): void {
  communicationPanelOpen.value = true;
  communicationMode.value = mode;
  pendingDrawStart.value = null;
  if (mode === 'chat') {
    void nextTick(() => chatInputRef.value?.focus());
  }
}

function submitCommunicationChat(): void {
  const text = communicationDraftText.value.trim();
  if (text.length === 0) return;
  sendCommunicationDraft({
    kind: 'chat',
    clientEventId: nextCommunicationDraftId('chat'),
    text,
  });
  communicationDraftText.value = '';
  setCommunicationMode('chat');
}

function eraseAllCommunicationDrawings(): void {
  sendCommunicationDraft({
    kind: 'mapErase',
    clientEventId: nextCommunicationDraftId('erase-all'),
    scope: 'all',
  });
}

function handleClearMapMarksClick(event: MouseEvent): void {
  eraseAllCommunicationDrawings();
  if (!event.ctrlKey) return;
  clearMapMarksContinuous.value = !clearMapMarksContinuous.value;
  if (clearMapMarksContinuous.value) {
    communicationDrawings.value = [];
    pendingDrawStart.value = null;
  }
}

function sendCommunicationMapEraseAt(x: number, y: number): void {
  sendCommunicationDraft({
    kind: 'mapErase',
    clientEventId: nextCommunicationDraftId('erase-radius'),
    scope: 'radius',
    center: { x, y },
    radius: 120,
  });
}

function handleCommunicationMapClick(x: number, y: number): boolean {
  const point = { x, y };
  if (communicationMode.value === 'none' || communicationMode.value === 'chat') return false;
  communicationPanelOpen.value = true;
  if (communicationMode.value === 'draw') {
    if (pendingDrawStart.value === null) {
      pendingDrawStart.value = point;
      return true;
    }
    const start = pendingDrawStart.value;
    pendingDrawStart.value = null;
    sendCommunicationDraft({
      kind: 'mapDrawing',
      clientEventId: nextCommunicationDraftId('draw'),
      drawingId: nextCommunicationDraftId('line'),
      drawingKind: 'line',
      points: [start, point],
    });
    return true;
  }
  if (communicationMode.value === 'label') {
    const label = communicationLabelText.value.trim();
    if (label.length === 0) return true;
    sendCommunicationDraft({
      kind: 'mapDrawing',
      clientEventId: nextCommunicationDraftId('label'),
      drawingId: nextCommunicationDraftId('map-label'),
      drawingKind: 'label',
      points: [point],
      label,
    });
    communicationLabelText.value = '';
    return true;
  }
  sendCommunicationMapEraseAt(point.x, point.y);
  return true;
}

function handleMinimapInteraction(x: number, y: number): void {
  if (handleCommunicationMapClick(x, y)) return;
  centerMinimapCamera(x, y);
}

// BAR erases drawings by right-dragging while the draw mode is active; the
// minimap forwards right-drag points as 'erase' events while drawing.
function handleMinimapErase(x: number, y: number): void {
  sendCommunicationMapEraseAt(x, y);
}

function handleMinimapCommandInteraction(x: number, y: number, queue: boolean): void {
  issueMinimapCommand(x, y, queue);
}

function communicationSenderName(playerId: PlayerId): string {
  return resolvePlayerName(playerId);
}

function formatCommunicationTime(createdAtMs: number): string {
  const date = new Date(createdAtMs);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
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
      captureScreenshot();
      return true;
    case 'ui.toggleFullscreen':
      void toggleFullscreen();
      return true;
    case 'ui.chat':
      setCommunicationMode('chat');
      return true;
    case 'ui.mapDraw':
      setCommunicationMode(communicationMode.value === 'draw' ? 'none' : 'draw');
      return true;
    case 'ui.mapLabel':
      setCommunicationMode(communicationMode.value === 'label' ? 'none' : 'label');
      return true;
    case 'ui.mapErase':
      setCommunicationMode(communicationMode.value === 'erase' ? 'none' : 'erase');
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

function clearBarMapDrawTap(): void {
  const timeoutId = barMapDrawTap?.timeoutId ?? null;
  if (timeoutId !== null) clearTimeout(timeoutId);
  barMapDrawTap = null;
}

function flushBarMapDrawTap(): void {
  const tap = barMapDrawTap;
  if (tap === null) return;
  if (tap.timeoutId !== null) clearTimeout(tap.timeoutId);
  barMapDrawTap = null;
  handleGameUiCommandHotkey(barMapDrawCommandForTapCount(tap.count));
}

function recordBarMapDrawTap(signature: string): void {
  if (barMapDrawTap !== null && barMapDrawTap.signature !== signature) {
    flushBarMapDrawTap();
  }

  if (barMapDrawTap === null) {
    barMapDrawTap = {
      signature,
      count: 1,
      timeoutId: null,
    };
  } else {
    barMapDrawTap.count++;
  }

  if (barMapDrawTap.timeoutId !== null) {
    clearTimeout(barMapDrawTap.timeoutId);
    barMapDrawTap.timeoutId = null;
  }

  if (barMapDrawTap.count >= 2) {
    flushBarMapDrawTap();
    return;
  }

  barMapDrawTap.timeoutId = setTimeout(() => {
    flushBarMapDrawTap();
  }, BAR_MAP_DRAW_DOUBLE_TAP_MS);
}

function handleBarMapDrawKeydown(event: KeyboardEvent): boolean {
  const signature = barMapDrawHotkeySignature(event, commandHotkeyPreset.value);
  if (signature === null) {
    flushBarMapDrawTap();
    return false;
  }
  event.preventDefault();
  gameUiHotkeys.reset();
  recordBarMapDrawTap(signature);
  return true;
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
  if (handleBarMapDrawKeydown(event)) return;
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
    (communicationMode.value !== 'none' || optionsMenuOpen.value || mapDetailsVisible.value)
  ) {
    event.preventDefault();
    gameUiHotkeys.reset();
    clearBarMapDrawTap();
    communicationMode.value = 'none';
    pendingDrawStart.value = null;
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
  clearBarMapDrawTap();
  bottomControlsResizeObserver?.disconnect();
  bottomControlsResizeObserver = null;
});

// Demo battle unit blueprint list (state read from snapshots)
const demoUnitBlueprintIds = BACKGROUND_UNIT_BLUEPRINT_IDS;
// Demo battle structure blueprint lists for the BUILDINGS / TOWERS bar
// groups. Source of truth is the authoritative blueprint-id arrays.
const demoBuildingBlueprintIds: readonly string[] = [...BUILDING_BLUEPRINT_IDS];
const demoTowerBlueprintIds: readonly string[] = [...TOWER_BLUEPRINT_IDS];

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
const dividersMagnitude = ref<number>(loadStoredDividersMagnitude('demo'));
const perimeterMagnitude = ref<number>(loadStoredPerimeterMagnitude('demo'));
const terrainDTerrain = ref<number>(loadStoredTerrainDTerrain('demo'));
const plateauWallSlopeDegrees = ref<number>(
  loadStoredPlateauWallSlopeDegrees('demo'),
);
const watersEdgeBeachSlopeDegrees = ref<number>(
  loadStoredWatersEdgeBeachSlopeDegrees('demo'),
);
const watersEdgeCliffHeight = ref<number>(
  loadStoredWatersEdgeCliffHeight('demo'),
);
const metalDepositStep = ref<number>(loadStoredMetalDepositStep('demo'));
const terrainDetail = ref<number>(loadStoredTerrainDetail('demo'));
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
  { label: 'DIVIDERS', value: String(dividersMagnitude.value) },
  { label: 'PERIMETER', value: String(perimeterMagnitude.value) },
  { label: 'D-TERRAIN', value: terrainDTerrain.value === 0 ? 'NONE' : String(terrainDTerrain.value) },
  { label: 'PLATEAU WALL', value: `${plateauWallSlopeDegrees.value} deg` },
  { label: 'BEACH SLOPE', value: `${watersEdgeBeachSlopeDegrees.value} deg` },
  { label: 'W-CLIFF', value: String(watersEdgeCliffHeight.value) },
  { label: 'METAL STEP', value: metalDepositStep.value === 0 ? 'NONE' : String(metalDepositStep.value) },
  { label: 'DETAIL', value: String(terrainDetail.value) },
  { label: 'PLAYERS', value: String(lobbyPlayerCount.value) },
]);
const {
  renderMode,
  audioScope,
  masterVolume,
  audioSmoothing,
  burnMarks,
  locomotionMarks,
  smokeTrails,
  smokeSoftEdges,
  fogShade,
  materialExplosions,
  triangleDebug,
  waterTriangleDebug,
  wallTriangleDebug,
  buildGridDebug,
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
  projRangeToggles,
  unitRadiusToggles,
  legsRadiusToggle,
  legsReachToggle,
  lodMode,
  cameraSmoothMode,
  cameraFollowMode,
  cameraFovDegrees,
  waterBoundaryMode,
  allRangesActive,
  allProjRangesActive,
  allUnitRadiiActive,
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
  toggleRange,
  cycleAttackRangeDisplay,
  toggleProjRange,
  toggleUnitRadius,
  toggleLegsRadius,
  toggleLegsReach,
  changeLodMode,
  setCameraMode,
  setCameraFollow,
  changeCameraFovDegrees,
  changeCameraFovBy,
  changeWaterBoundaryMode,
  toggleAllRanges,
  toggleAllProjRanges,
  toggleAllUnitRadii,
  toggleAudioSmoothing,
  toggleBurnMarks,
  toggleLocomotionMarks,
  toggleSmokeTrails,
  toggleSmokeSoftEdges,
  toggleFogShade,
  toggleMaterialExplosions,
  toggleTriangleDebug,
  toggleWaterTriangleDebug,
  toggleWallTriangleDebug,
  toggleBuildGridDebug,
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
  emit('openEntityLab');
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
const pauseBannerVisible = computed(
  () =>
    presentationPhase.value === 'real-battle-interactive' &&
    gamePhase.value === 'paused' &&
    gameOverWinner.value === null,
);

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
  dividersMagnitude,
  perimeterMagnitude,
  terrainDTerrain,
  plateauWallSlopeDegrees,
  watersEdgeBeachSlopeDegrees,
  watersEdgeCliffHeight,
  metalDepositStep,
  terrainDetail,
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
    ARCHITECTURE_CONFIG.lockstep.fixedStepHz,
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
  () => serverMetaFromSnapshot.value?.units.max ?? loadStoredCap(currentBattleMode.value),
);
const displayServerTime = computed(
  () => serverMetaFromSnapshot.value?.server.time ?? '',
);
const displayServerIp = computed(
  () => serverMetaFromSnapshot.value?.server.ip ?? '',
);
const {
  currentLobbySettings,
  broadcastLobbySettingsIfHost,
  applyCenterMagnitude,
  applyDividersMagnitude,
  applyPerimeterMagnitude,
  applyTerrainDTerrain,
  applyPlateauWallSlopeDegrees,
  applyWatersEdgeBeachSlopeDegrees,
  applyWatersEdgeCliffHeight,
  applyMetalDepositStep,
  applyTerrainDetail,
  applyMapLandDimensions,
  applyLobbySettingsFromHost,
} = useGameCanvasLobbySettings({
  network: networkManager,
  currentBattleMode,
  networkRole,
  roomCode,
  gameStarted,
  centerMagnitude,
  dividersMagnitude,
  perimeterMagnitude,
  terrainDTerrain,
  plateauWallSlopeDegrees,
  watersEdgeBeachSlopeDegrees,
  watersEdgeCliffHeight,
  metalDepositStep,
  terrainDetail,
  mapWidthLandCells,
  mapLengthLandCells,
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
  currentAllowedTowers,
  currentAllowedTowersSet,
  allDemoTowersActive,
  currentForceFieldsVisible,
  currentShieldsObstructSight,
  currentFogOfWarEnabled,
  currentSlopePathMode,
  currentConverterTax,
  toggleDemoUnitBlueprintId,
  toggleAllDemoUnits,
  toggleDemoBuildingBlueprintId,
  toggleAllDemoBuildings,
  toggleDemoTowerBlueprintId,
  toggleAllDemoTowers,
  changeMaxTotalUnits,
  setForceFieldsVisible,
  setShieldsObstructSight,
  setFogOfWarEnabled,
  setSlopePathMode,
  setConverterTax,
  resetDemoDefaults,
  applyPreset,
} = useGameCanvasBattleSettings({
  serverMetaFromSnapshot,
  currentBattleMode,
  demoUnitBlueprintIds,
  demoBuildingBlueprintIds,
  demoTowerBlueprintIds,
  getActiveConnection: () => activeConnection,
  broadcastLobbySettingsIfHost,
  applyCenterMagnitude,
  applyDividersMagnitude,
  applyPerimeterMagnitude,
  applyTerrainDTerrain,
  applyPlateauWallSlopeDegrees,
  applyWatersEdgeBeachSlopeDegrees,
  applyWatersEdgeCliffHeight,
  applyMetalDepositStep,
  applyTerrainDetail,
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
  resetUnitGroundNormalEmaDefault();
  resetTerrainRenderSmoothingDefaults();
}

const {
  setupNetworkCallbacks,
  startGameWithPlayers,
} = useGameCanvasRealBattleHandoff({
  containerRef,
  showLobby,
  gameStarted,
  battleLoading,
  activePlayer,
  localPlayerId,
  networkRole,
  playerClientEnabled,
  cameraFovDegrees,
  localIpAddress,
  hasServer,
  networkNotice,
  lobbyError,
  lobbyPlayers,
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
  upsertLobbyPlayer,
  applyLobbySettingsFromHost,
  currentLobbySettings,
  onCommunication: applyCommunicationEvent,
  onLoadingProgress: setLoadingProgress,
  bindSceneUi: (scene) => {
    bindGameSceneUi(scene, true);
  },
});

const { restartGame } = useGameCanvasSessionLifecycle({
  gameOverWinner,
  battleLoading,
  gameStarted,
  showLobby,
  networkRole,
  lobbyPlayers,
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
});

const {
  handleHost,
  handleJoin,
  handleLobbyStart,
  handleLobbyCancel,
  handleOffline,
} = useGameCanvasLobbyActions({
  network: networkManager,
  isConnecting,
  lobbyError,
  networkNotice,
  roomCode,
  isHost,
  networkRole,
  localPlayerId,
  lobbyPlayers,
  battleLoading,
  setupNetworkCallbacks,
  reportLocalPlayerInfo,
  startGameWithPlayers,
  onLoadingProgress: setLoadingProgress,
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
  allDemoTowersActive: allDemoTowersActive.value,
  demoTowerBlueprintIds,
  currentAllowedTowersSet: currentAllowedTowersSet.value,
  displayUnitCap: displayUnitCap.value,
  gameStarted: gameStarted.value,
  mapWidthLandCells: mapWidthLandCells.value,
  mapLengthLandCells: mapLengthLandCells.value,
  centerMagnitude: centerMagnitude.value,
  dividersMagnitude: dividersMagnitude.value,
  perimeterMagnitude: perimeterMagnitude.value,
  terrainDTerrain: terrainDTerrain.value,
  plateauWallSlopeDegrees: plateauWallSlopeDegrees.value,
  watersEdgeBeachSlopeDegrees: watersEdgeBeachSlopeDegrees.value,
  watersEdgeCliffHeight: watersEdgeCliffHeight.value,
  metalDepositStep: metalDepositStep.value,
  terrainDetail: terrainDetail.value,
  terrainTextureSmoothing: terrainTextureSmoothing.value,
  terrainLightSmoothing: terrainLightSmoothing.value,
  terrainTextureSmoothAcrossWallBoundary:
    terrainTextureSmoothAcrossWallBoundary.value,
  terrainLightSmoothAcrossWallBoundary:
    terrainLightSmoothAcrossWallBoundary.value,
  terrainSplitWallBoundaryVertices: terrainSplitWallBoundaryVertices.value,
  displayUnitCount: displayUnitCount.value,
  currentForceFieldsVisible: currentForceFieldsVisible.value,
  currentShieldsObstructSight: currentShieldsObstructSight.value,
  currentFogOfWarEnabled: currentFogOfWarEnabled.value,
  currentSlopePathMode: currentSlopePathMode.value,
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
  toggleAllDemoTowers,
  toggleDemoTowerBlueprintId,
  changeMaxTotalUnits,
  applyMapLandDimensions,
  applyCenterMagnitude,
  applyDividersMagnitude,
  applyPerimeterMagnitude,
  applyTerrainDTerrain,
  applyPlateauWallSlopeDegrees,
  applyWatersEdgeBeachSlopeDegrees,
  applyWatersEdgeCliffHeight,
  applyMetalDepositStep,
  applyTerrainDetail,
  applyTerrainTextureSmoothing,
  applyTerrainLightSmoothing,
  toggleTerrainTextureSmoothAcrossWallBoundary,
  toggleTerrainLightSmoothAcrossWallBoundary,
  toggleTerrainSplitWallBoundaryVertices,
  setForceFieldsVisible,
  setShieldsObstructSight,
  setFogOfWarEnabled,
  setSlopePathMode,
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
  m.allDemoTowersActive = allDemoTowersActive.value;
  m.currentAllowedTowersSet = currentAllowedTowersSet.value;
  m.displayUnitCap = displayUnitCap.value;
  m.gameStarted = gameStarted.value;
  m.mapWidthLandCells = mapWidthLandCells.value;
  m.mapLengthLandCells = mapLengthLandCells.value;
  m.centerMagnitude = centerMagnitude.value;
  m.dividersMagnitude = dividersMagnitude.value;
  m.perimeterMagnitude = perimeterMagnitude.value;
  m.terrainDTerrain = terrainDTerrain.value;
  m.plateauWallSlopeDegrees = plateauWallSlopeDegrees.value;
  m.watersEdgeBeachSlopeDegrees = watersEdgeBeachSlopeDegrees.value;
  m.watersEdgeCliffHeight = watersEdgeCliffHeight.value;
  m.metalDepositStep = metalDepositStep.value;
  m.terrainDetail = terrainDetail.value;
  m.terrainTextureSmoothing = terrainTextureSmoothing.value;
  m.terrainLightSmoothing = terrainLightSmoothing.value;
  m.terrainTextureSmoothAcrossWallBoundary =
    terrainTextureSmoothAcrossWallBoundary.value;
  m.terrainLightSmoothAcrossWallBoundary =
    terrainLightSmoothAcrossWallBoundary.value;
  m.terrainSplitWallBoundaryVertices =
    terrainSplitWallBoundaryVertices.value;
  m.displayUnitCount = displayUnitCount.value;
  m.currentForceFieldsVisible = currentForceFieldsVisible.value;
  m.currentShieldsObstructSight = currentShieldsObstructSight.value;
  m.currentFogOfWarEnabled = currentFogOfWarEnabled.value;
  m.currentSlopePathMode = currentSlopePathMode.value;
  m.currentConverterTax = currentConverterTax.value;
  m.serverUnitGroundNormalEmaMode = serverUnitGroundNormalEmaMode.value;
  m.activePresetName = findMatchingPresetName({
    units: currentAllowedUnits.value,
    buildings: currentAllowedBuildings.value,
    towers: currentAllowedTowers.value,
    cap: displayUnitCap.value,
    turretShieldPanelsEnabled: BATTLE_CONFIG.turretShieldPanelsEnabled.default,
    turretShieldSpheresEnabled: BATTLE_CONFIG.turretShieldSpheresEnabled.default,
    forceFieldsVisible: currentForceFieldsVisible.value,
    shieldsObstructSight: currentShieldsObstructSight.value,
    shieldReflectionMode: BATTLE_CONFIG.shieldReflectionMode.default,
    fogOfWarEnabled: currentFogOfWarEnabled.value,
    slopePathMode: BATTLE_CONFIG.slopePathMode.default,
    converterTax: currentConverterTax.value,
    centerMagnitude: centerMagnitude.value,
    dividersMagnitude: dividersMagnitude.value,
    perimeterMagnitude: perimeterMagnitude.value,
    terrainDTerrain: terrainDTerrain.value,
    plateauWallSlopeDegrees: plateauWallSlopeDegrees.value,
    watersEdgeBeachSlopeDegrees: watersEdgeBeachSlopeDegrees.value,
    watersEdgeCliffHeight: watersEdgeCliffHeight.value,
    metalDepositStep: metalDepositStep.value,
    terrainDetail: terrainDetail.value,
    mapWidthLandCells: mapWidthLandCells.value,
    mapLengthLandCells: mapLengthLandCells.value,
    barsCollapsed: bottomBarsCollapsed.value,
  });
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
  locomotionMarks: locomotionMarks.value,
  smokeTrails: smokeTrails.value,
  smokeSoftEdges: smokeSoftEdges.value,
  fogShade: fogShade.value,
  materialExplosions: materialExplosions.value,
  clientUnitGroundNormalEmaMode: clientUnitGroundNormalEmaMode.value,
  dragPanEnabled: dragPanEnabled.value,
  showServerControls: showServerControls.value,
  triangleDebug: triangleDebug.value,
  waterTriangleDebug: waterTriangleDebug.value,
  wallTriangleDebug: wallTriangleDebug.value,
  buildGridDebug: buildGridDebug.value,
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
  allSoundsActive: allSoundsActive.value,
  soundToggles,
  sfxCategories: SFX_CATEGORIES,
  soundLabels: SOUND_LABELS,
  soundTooltips: SOUND_TOOLTIPS,
  allRangesActive: allRangesActive.value,
  rangeToggles,
  allProjRangesActive: allProjRangesActive.value,
  projRangeToggles,
  allUnitRadiiActive: allUnitRadiiActive.value,
  unitRadiusToggles,
  legsRadiusToggle: legsRadiusToggle.value,
  legsReachToggle: legsReachToggle.value,
  lodMode: lodMode.value,
  cameraFovDegrees: cameraFovDegrees.value,
  cameraSmoothMode: cameraSmoothMode.value,
  cameraFollowMode: cameraFollowMode.value,
  waterBoundaryMode: waterBoundaryMode.value,
  fullscreenActive: fullscreenActive.value,
  uiChromeVisible: uiChromeVisible.value,
  mapDetailsVisible: mapDetailsVisible.value,
  optionsMenuOpen: optionsMenuOpen.value,
  resetClientDefaults,
  togglePlayerClientEnabled,
  changeWaypointDetail,
  toggleEntityHud,
  changeSelectionHudMode,
  changeCommandHotkeyPreset,
  refreshCommandHotkeys,
  toggleAudioSmoothing,
  toggleBurnMarks,
  toggleLocomotionMarks,
  toggleSmokeTrails,
  toggleSmokeSoftEdges,
  toggleFogShade,
  toggleMaterialExplosions,
  changeClientUnitGroundNormalEmaMode,
  toggleDragPan,
  toggleTriangleDebug,
  toggleWaterTriangleDebug,
  toggleWallTriangleDebug,
  toggleBuildGridDebug,
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
  setGamePaused,
  toggleAllSounds,
  toggleSoundCategory,
  toggleAllRanges,
  toggleRange,
  toggleAllProjRanges,
  toggleProjRange,
  toggleAllUnitRadii,
  toggleUnitRadius,
  toggleLegsRadius,
  toggleLegsReach,
  changeLodMode,
  changeCameraFovDegrees,
  changeWaterBoundaryMode,
  setCameraMode,
  setCameraViewMode,
  setCameraFollowMode: setCameraFollow,
  showMapOverview,
  flipCameraYaw,
  setCameraAnchor,
  focusCameraAnchor,
  toggleFullscreen,
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
  m.locomotionMarks = locomotionMarks.value;
  m.smokeTrails = smokeTrails.value;
  m.smokeSoftEdges = smokeSoftEdges.value;
  m.fogShade = fogShade.value;
  m.materialExplosions = materialExplosions.value;
  m.clientUnitGroundNormalEmaMode = clientUnitGroundNormalEmaMode.value;
  m.dragPanEnabled = dragPanEnabled.value;
  m.showServerControls = showServerControls.value;
  m.triangleDebug = triangleDebug.value;
  m.waterTriangleDebug = waterTriangleDebug.value;
  m.wallTriangleDebug = wallTriangleDebug.value;
  m.buildGridDebug = buildGridDebug.value;
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
  m.allSoundsActive = allSoundsActive.value;
  m.allRangesActive = allRangesActive.value;
  m.allProjRangesActive = allProjRangesActive.value;
  m.allUnitRadiiActive = allUnitRadiiActive.value;
  m.legsRadiusToggle = legsRadiusToggle.value;
  m.legsReachToggle = legsReachToggle.value;
  m.lodMode = lodMode.value;
  m.cameraFovDegrees = cameraFovDegrees.value;
  m.cameraSmoothMode = cameraSmoothMode.value;
  m.cameraFollowMode = cameraFollowMode.value;
  m.waterBoundaryMode = waterBoundaryMode.value;
  m.fullscreenActive = fullscreenActive.value;
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

      <!-- Authoritative pause banner (BAR-style center-screen indicator).
           Click resumes — the same setPaused command the PAUSE button sends. -->
      <div
        v-if="pauseBannerVisible"
        class="game-paused-banner"
        role="status"
        aria-live="polite"
        title="Click to resume"
        @click="setGamePaused(false)"
      >
        ⏸ PAUSED
      </div>

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
            :drawings="minimapCommunicationDrawings"
            :drag-pan="minimapDragPanEnabled"
            :erase-on-right-drag="communicationMode === 'draw'"
            @click="handleMinimapInteraction"
            @command="handleMinimapCommandInteraction"
            @erase="handleMinimapErase"
          />
        </div>

        <section
          class="communication-panel"
          :class="{
            open: communicationPanelOpen,
            drawing: communicationMode !== 'none' && communicationMode !== 'chat',
          }"
          aria-label="Team communication"
        >
          <div class="communication-toolbar">
            <button
              type="button"
              class="communication-toggle"
              :aria-pressed="communicationPanelOpen"
              title="Chat"
              @click="setCommunicationMode('chat')"
            >CHAT</button>
            <button
              type="button"
              :class="{ active: communicationMode === 'draw' }"
              title="Draw on map"
              @click="setCommunicationMode(communicationMode === 'draw' ? 'none' : 'draw')"
            >DRAW</button>
            <button
              type="button"
              :class="{ active: communicationMode === 'label' }"
              title="Draw label"
              @click="setCommunicationMode(communicationMode === 'label' ? 'none' : 'label')"
            >LABEL</button>
            <button
              type="button"
              :class="{ active: communicationMode === 'erase' }"
              title="Erase drawings"
              @click="setCommunicationMode(communicationMode === 'erase' ? 'none' : 'erase')"
            >ERASE</button>
            <button
              type="button"
              :class="{ active: clearMapMarksContinuous }"
              title="Clear mapmarks/drawings - CTRL-click to continuously clear"
              @click="handleClearMapMarksClick"
            >CLEAR</button>
          </div>

          <div
            v-if="communicationPanelOpen"
            class="communication-body"
          >
            <div class="communication-log" aria-live="polite">
              <div
                v-for="message in communicationMessages"
                :key="message.id"
                class="communication-message"
              >
                <span class="communication-time">{{ formatCommunicationTime(message.createdAtMs) }}</span>
                <span
                  class="communication-sender"
                  :style="{ color: getPlayerColor(message.senderPlayerId) }"
                >{{ communicationSenderName(message.senderPlayerId) }}</span>
                <span class="communication-text">{{ message.text }}</span>
              </div>
            </div>

            <form
              v-if="communicationMode === 'chat'"
              class="communication-input-row"
              @submit.prevent="submitCommunicationChat"
            >
              <input
                ref="chatInputRef"
                v-model="communicationDraftText"
                class="communication-input"
                type="text"
                maxlength="220"
                autocomplete="off"
                aria-label="Chat message"
                @keydown.stop
              />
              <button type="submit">SEND</button>
            </form>

            <div
              v-if="communicationMode === 'label'"
              class="communication-input-row"
            >
              <input
                v-model="communicationLabelText"
                class="communication-input"
                type="text"
                maxlength="48"
                autocomplete="off"
                aria-label="Map label"
                @keydown.stop
              />
            </div>

            <div
              v-if="communicationMode === 'draw'"
              class="communication-status"
            >DRAW {{ pendingDrawStart === null ? '1/2' : '2/2' }}</div>
            <div
              v-if="communicationMode === 'erase'"
              class="communication-status"
            >ERASE</div>
          </div>
        </section>

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
              @click="toggleFullscreen"
            >FULL</button>
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
      :sidebar-open="!spectateMode"
      :is-host="isHost"
      :room-code="roomCode"
      :players="lobbyPlayers"
      :local-player-id="localPlayerId"
      :error="lobbyError"
      :is-connecting="isConnecting"
      :center-magnitude="centerMagnitude"
      :dividers-magnitude="dividersMagnitude"
      :perimeter-magnitude="perimeterMagnitude"
      :terrain-d-terrain="terrainDTerrain"
      :plateau-wall-slope-degrees="plateauWallSlopeDegrees"
      :waters-edge-beach-slope-degrees="watersEdgeBeachSlopeDegrees"
      :waters-edge-cliff-height="watersEdgeCliffHeight"
      :metal-deposit-step="metalDepositStep"
      :terrain-detail="terrainDetail"
      :map-width-land-cells="mapWidthLandCells"
      :map-length-land-cells="mapLengthLandCells"
      :unit-blueprint-ids="demoUnitBlueprintIds"
      :allowed-units="currentAllowedUnits"
      :building-blueprint-ids="demoBuildingBlueprintIds"
      :allowed-buildings="currentAllowedBuildings"
      :tower-blueprint-ids="demoTowerBlueprintIds"
      :allowed-towers="currentAllowedTowers"
      :unit-cap="displayUnitCap"
      :force-fields-visible="currentForceFieldsVisible"
      :shields-obstruct-sight="currentShieldsObstructSight"
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
      @offline="handleOffline"
      @entity-lab="openEntityLab"
      @spectate="toggleSpectateMode"
      @set-center-magnitude="(v) => applyCenterMagnitude(v)"
      @set-dividers-magnitude="(v) => applyDividersMagnitude(v)"
      @set-perimeter-magnitude="(v) => applyPerimeterMagnitude(v)"
      @set-terrain-d-terrain="(v) => applyTerrainDTerrain(v)"
      @set-plateau-wall-slope-degrees="(v) => applyPlateauWallSlopeDegrees(v)"
      @set-waters-edge-beach-slope-degrees="(v) => applyWatersEdgeBeachSlopeDegrees(v)"
      @set-waters-edge-cliff-height="(v) => applyWatersEdgeCliffHeight(v)"
      @set-metal-deposit-step="(v) => applyMetalDepositStep(v)"
      @set-terrain-detail="(v) => applyTerrainDetail(v)"
      @set-preset="(p) => applyPreset(p)"
      @set-map-land-dimensions="(dimensions) => applyMapLandDimensions(dimensions)"
      @toggle-unit="(ut) => toggleDemoUnitBlueprintId(ut)"
      @toggle-all-units="toggleAllDemoUnits"
      @toggle-building="(bt) => toggleDemoBuildingBlueprintId(bt)"
      @toggle-all-buildings="toggleAllDemoBuildings"
      @toggle-tower="(tt) => toggleDemoTowerBlueprintId(tt)"
      @toggle-all-towers="toggleAllDemoTowers"
      @set-unit-cap="(c) => changeMaxTotalUnits(c)"
      @set-force-fields-visible="(e) => setForceFieldsVisible(e)"
      @set-shields-obstruct-sight="(e) => setShieldsObstructSight(e)"
      @set-converter-tax="(v) => setConverterTax(v)"
      @set-player-name="onPlayerNameChange"
      @reset-defaults="resetDemoDefaults"
    />

    <GameCanvasOverlays
      :is-mobile="isMobile"
      :show-lobby="showLobby"
      :spectate-mode="spectateMode"
      :hud-visible="overlayControlsVisible"
      :mobile-bars-visible="mobileBarsVisible"
      :game-started="gameStarted"
      :current-battle-mode="currentBattleMode"
      :get-orbit="getActiveOrbitCamera"
      :game-over-winner="gameOverWinner"
      :winner-name="gameOverWinner === null ? '' : resolvePlayerName(gameOverWinner)"
      :winner-color="gameOverWinner === null ? '' : getPlayerColor(gameOverWinner)"
      @toggle-spectate-mode="toggleSpectateMode"
      @toggle-mobile-bars="mobileBarsVisible = !mobileBarsVisible"
      @dismiss-game-over="gameOverWinner = null"
      @restart-game="restartGame"
    />
  </div>
</template>

<style scoped>
.game-wrapper {
  width: 100%;
  height: 100%;
  position: relative;
  display: flex;
  flex-direction: column;
}

/* When the startup menu sidebar is open it is the topmost layer on the
 * right; reserve its strip so nothing game-related runs underneath it.
 * The game area (which holds both the 3D battle and its loading screen
 * in the same element) is inset alongside the top/bottom bars, so the
 * game and its loading overlay always live to the left of the sidebar.
 * The renderer's ResizeObserver picks up the narrower container and
 * resizes the canvas to match. */
.game-wrapper.menu-sidebar-open {
  --menu-sidebar-w: min(380px, calc(100vw - 40px));
}

.game-wrapper.menu-sidebar-open .game-area {
  margin-right: var(--menu-sidebar-w);
}

.game-wrapper.menu-sidebar-open .top-controls-shell {
  width: auto;
  right: var(--menu-sidebar-w);
}

.game-wrapper.menu-sidebar-open .bottom-controls-shell:not(.collapsed) {
  box-sizing: border-box;
  padding-right: var(--menu-sidebar-w);
}

.game-area {
  flex: 1;
  position: relative;
  overflow: hidden;
  min-height: 0;
}

.game-container {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.background-battle-container {
  /* Identical positioning rules in both contexts:
   *   - default home: inside `.game-area` (position: relative) →
   *     fills the full viewport behind the BUDGET ANNIHILATION
   *     lobby screen (original pre-change behavior).
   *   - re-parented home: inside `.preview-pane` (also
   *     position: relative, sized 480x270) → fills that small
   *     box, framing the demo as a mini-simulation preview.
   *
   * The lobby-preview composable does the DOM move; the element's own
   * CSS doesn't need to change because both parents resolve `position:
   * absolute; width/height: 100%` to the right thing. */
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  z-index: 0;
}

.game-container canvas {
  display: block;
}

.game-container.loading-active {
  z-index: 3700;
}

.battle-loading-overlay {
  position: absolute;
  inset: 0;
  z-index: 3600;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: #05070a;
  color: #edf3ff;
  pointer-events: auto;
}

.player-client-off .game-container canvas,
.player-client-off .background-battle-container canvas {
  visibility: hidden;
}

.player-client-off-overlay {
  position: absolute;
  inset: 0;
  z-index: 900;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: #05070a;
  color: #edf3ff;
  pointer-events: auto;
}

.game-paused-banner {
  position: absolute;
  top: 18%;
  left: 50%;
  transform: translateX(-50%);
  z-index: 950;
  padding: 10px 28px;
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 8px;
  background: #05070a;
  color: #ffd166;
  font: 700 22px/1.2 monospace;
  letter-spacing: 0.18em;
  cursor: pointer;
  pointer-events: auto;
  user-select: none;
}

.top-controls-shell {
  position: absolute;
  top: 0;
  left: 0;
  display: flex;
  justify-content: center;
  z-index: 3001;
  width: 100%;
  height: 0;
  pointer-events: none;
}

.top-controls-shell :deep(.top-bar) {
  pointer-events: auto;
}

.minimap-stack {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 1000;
  display: block;
  pointer-events: none;
}

.minimap-stack :deep(.minimap-container) {
  pointer-events: auto;
}

.communication-panel {
  position: absolute;
  top: 62px;
  left: 50%;
  z-index: 1002;
  width: auto;
  max-width: min(420px, calc(100vw - 560px));
  border: 1px solid #4f6074;
  border-radius: 4px;
  background: #080c12;
  color: #edf3ff;
  font: 11px/1.25 system-ui, sans-serif;
  letter-spacing: 0;
  pointer-events: auto;
  transform: translateX(-50%);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.34);
}

.communication-panel.open {
  width: min(420px, calc(100vw - 560px));
  min-width: 360px;
}

.communication-panel.drawing {
  border-color: #82d2ff;
}

.communication-toolbar {
  display: flex;
  justify-content: center;
  gap: 2px;
  padding: 3px;
}

.communication-toolbar button,
.communication-input-row button {
  min-width: 0;
  width: 38px;
  height: 20px;
  padding: 0 2px;
  border: 1px solid #667184;
  border-radius: 2px;
  background: #191f2a;
  color: #dce7fb;
  font: 700 7px/1 system-ui, sans-serif;
  letter-spacing: 0;
  cursor: pointer;
}

.communication-toolbar button:hover,
.communication-input-row button:hover {
  border-color: #b4cdeb;
  background: #263142;
}

.communication-toolbar button.active,
.communication-toggle[aria-pressed="true"] {
  border-color: #82d2ff;
  color: #f8fcff;
  background: #265270;
}

.communication-body {
  border-top: 1px solid rgba(120, 140, 165, 0.28);
  padding: 7px;
}

.communication-log {
  display: grid;
  gap: 3px;
  max-height: 136px;
  min-height: 24px;
  overflow-y: auto;
  scrollbar-width: thin;
}

.communication-message {
  display: grid;
  grid-template-columns: 38px 72px minmax(0, 1fr);
  gap: 6px;
  align-items: baseline;
  min-width: 0;
}

.communication-time {
  color: #8998ad;
  font-family: monospace;
  font-size: 10px;
}

.communication-sender {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 800;
}

.communication-text {
  min-width: 0;
  overflow-wrap: anywhere;
  color: #f5f8ff;
}

.communication-input-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 6px;
  margin-top: 7px;
}

.communication-input {
  min-width: 0;
  height: 24px;
  box-sizing: border-box;
  border: 1px solid #667184;
  border-radius: 4px;
  background: #04080e;
  color: #edf3ff;
  padding: 0 7px;
  font: 11px/1 system-ui, sans-serif;
  outline: none;
}

.communication-input:focus {
  border-color: #82d2ff;
}

.communication-status {
  margin-top: 7px;
  color: #a9bdd6;
  font: 700 10px/1.2 system-ui, sans-serif;
}

.map-details-panel {
  position: absolute;
  top: 0;
  left: calc(var(--hud-minimap-max, 320px) + 16px);
  z-index: 1001;
  width: min(300px, calc(100vw - var(--hud-minimap-max, 320px) - 36px));
  max-width: 300px;
  border: 1px solid #4f6074;
  border-radius: 6px;
  background: #0a0e14;
  color: #edf3ff;
  font: 11px/1.25 system-ui, sans-serif;
  letter-spacing: 0;
  pointer-events: auto;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.38);
}

.map-details-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 28px;
  padding: 0 8px 0 10px;
  border-bottom: 1px solid rgba(120, 140, 165, 0.32);
  font-weight: 700;
}

.map-details-close {
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid #667184;
  border-radius: 4px;
  background: #191f2a;
  color: #dce7fb;
  cursor: pointer;
}

.map-details-list {
  display: grid;
  grid-template-columns: minmax(88px, auto) 1fr;
  gap: 6px 12px;
  margin: 0;
  padding: 10px;
}

.map-details-list dt {
  color: #9fb1c9;
  font-weight: 700;
}

.map-details-list dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
  color: #f5f8ff;
  text-align: right;
}

.options-menu-panel {
  position: absolute;
  top: 0;
  left: calc(var(--hud-minimap-max, 320px) + 332px);
  z-index: 1001;
  width: min(244px, calc(100vw - var(--hud-minimap-max, 320px) - 352px));
  max-width: 244px;
  border: 1px solid #4f6074;
  border-radius: 6px;
  background: #0a0e14;
  color: #edf3ff;
  font: 11px/1.25 system-ui, sans-serif;
  letter-spacing: 0;
  pointer-events: auto;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.38);
}

.options-menu-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 28px;
  padding: 0 8px 0 10px;
  border-bottom: 1px solid rgba(120, 140, 165, 0.32);
  font-weight: 700;
}

.options-menu-close {
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid #667184;
  border-radius: 4px;
  background: #191f2a;
  color: #dce7fb;
  cursor: pointer;
}

.options-menu-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
  padding: 10px;
}

.options-menu-grid button {
  min-width: 0;
  height: 28px;
  padding: 0 5px;
  border: 1px solid #667184;
  border-radius: 4px;
  background: #191f2a;
  color: #dce7fb;
  font: 700 10px/1 system-ui, sans-serif;
  letter-spacing: 0;
  cursor: pointer;
}

.options-menu-grid button:hover,
.options-menu-close:hover {
  border-color: #b4cdeb;
  background: #263142;
}

.options-menu-grid button.active {
  border-color: #82d2ff;
  color: #f8fcff;
  background: #265270;
}

@media (max-width: 760px) {
  .minimap-stack {
    display: block;
  }

  .communication-panel {
    top: var(--hud-minimap-follow-top, 326px);
    left: 0;
    max-width: min(300px, 100vw);
    transform: none;
  }

  .communication-panel.open {
    width: min(300px, 100vw);
    min-width: 0;
  }

  .map-details-panel {
    top: var(--hud-minimap-follow-top, 326px);
    left: 0;
    width: min(300px, 100vw);
  }

  .options-menu-panel {
    top: var(--hud-minimap-follow-top, 326px);
    left: 0;
    width: min(244px, 100vw);
  }
}

.ui-chrome-restore {
  position: fixed;
  right: 12px;
  bottom: 12px;
  z-index: 4200;
  min-width: 38px;
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid #5d6b82;
  border-radius: 4px;
  background: #11161e;
  color: #e8f0ff;
  font: 700 11px/1 system-ui, sans-serif;
  letter-spacing: 0;
  cursor: pointer;
  pointer-events: auto;
}

.ui-chrome-restore:hover {
  border-color: #8da1c0;
  background: #1c2430;
}

.ui-chrome-restore:active {
  background: #090c12;
}



/* Bottom control bars */
.bottom-controls-shell {
  position: relative;
  flex-shrink: 0;
  z-index: 3001;
  display: flex;
  align-items: stretch;
  justify-content: flex-start;
  width: 100%;
  pointer-events: none;
}

.bottom-controls-shell.collapsed {
  position: absolute;
  left: 0;
  bottom: 0;
  background: transparent;
}

.bottom-controls {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  pointer-events: none;
}

/* Horizontal tab that sits ON TOP of the bars near the left — the
 * bottom-bars mirror of the right-edge sidebar handle, rotated 90° so
 * the rounded edge faces up into the screen and the chevron points up
 * (expand) / down (collapse). `bottom: 100%` parks its base at the top
 * of the bars when expanded; when collapsed the bars are hidden so the
 * shell has zero height and the tab falls to the screen's bottom edge —
 * exactly how the sidebar handle rides out with its panel. */
.bottom-controls-toggle {
  position: absolute;
  left: 12px;
  bottom: 100%;
  width: 72px;
  height: 30px;
  padding: 0;
  background: #12121a;
  border: 1px solid #444;
  border-bottom: none;
  border-radius: 8px 8px 0 0;
  color: #888;
  cursor: pointer;
  pointer-events: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.bottom-controls-toggle:hover {
  background: #232330;
  border-color: #777;
}

.bottom-controls-toggle:active {
  background: #0c0c12;
  border-color: #666;
}

.toggle-dot {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: currentColor;
  display: block;
}

.lobby-controls-sidebar {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 3002;
  width: min(860px, calc(100vw - 40px));
  pointer-events: none;
  transform: translateX(100%);
  transition: transform 0.18s ease;
}

.lobby-controls-sidebar.open {
  transform: translateX(0);
}

.lobby-controls-sidebar-toggle {
  position: absolute;
  top: 50%;
  left: -30px;
  width: 30px;
  height: 72px;
  padding: 0;
  transform: translateY(-50%);
  background: #12121a;
  border: 1px solid #444;
  border-right: none;
  border-radius: 6px 0 0 6px;
  color: #888;
  cursor: pointer;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.lobby-controls-sidebar-toggle:hover {
  background: #232330;
  border-color: #777;
  color: #bbb;
}

.lobby-controls-sidebar-toggle:active {
  background: #0c0c12;
  border-color: #666;
}

.lobby-controls-sidebar-panel {
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding: 10px;
  overflow-y: auto;
  background: #0a0c12;
  border-left: 1px solid #444;
  box-shadow: -16px 0 32px rgba(0, 0, 0, 0.36);
  pointer-events: auto;
  visibility: visible;
}

.lobby-controls-sidebar:not(.open) .lobby-controls-sidebar-panel {
  visibility: hidden;
}

</style>
