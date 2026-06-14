<script setup lang="ts">
import { ref, computed, reactive, watch, watchEffect, onMounted, onBeforeUnmount, nextTick } from 'vue';
import type { GameInstance } from '../game/createGame';
import type { PlayerId } from '../game/sim/types';
import type { BackgroundBattleState } from '../game/lobby/LobbyManager';
import SelectionPanel from './SelectionPanel.vue';
import TopBar from './TopBar.vue';
import Minimap from './Minimap.vue';
import LobbyModal, { type LobbyPlayer } from './LobbyModal.vue';
import GameCanvasOverlays from './GameCanvasOverlays.vue';
import GameCanvasBattleControlBar from './GameCanvasBattleControlBar.vue';
import GameCanvasServerControlBar from './GameCanvasServerControlBar.vue';
import GameCanvasClientControlBar from './GameCanvasClientControlBar.vue';
import LoadingEmblem from './LoadingEmblem.vue';
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
import { CommandHotkeySequenceResolver, type CommandHotkeyId } from '../game/input/commandHotkeys';
import { BACKGROUND_UNIT_BLUEPRINT_IDS } from '../game/server/BackgroundBattleStandalone';
import {
  BATTLE_CONFIG,
  loadStoredCap,
  loadStoredCenterMagnitude,
  loadStoredDividersMagnitude,
  loadStoredGrid,
  loadStoredTerrainDTerrain,
  loadStoredMetalDepositStep,
  loadStoredTerrainDetail,
  loadStoredTerrainMapShape,
  loadStoredMapLandDimensions,
  type BattleMode,
} from '../battleBarConfig';
import type { TerrainMapShape } from '../types/terrain';
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
  snapshotRateHz,
} from '../serverBarConfig';
import type { UnitGroundNormalEmaMode } from '../shellConfig';
import { getPlayerColor } from './uiUtils';
import type { GameServer } from '../game/server/GameServer';
import type { GameConnection } from '../game/server/GameConnection';
import type { CameraFovDegrees, CameraViewMode } from '../types/client';
import {
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
const loadingProgress = ref(0);
const loadingPhase = ref('Preparing battle');
const displayedLoadingProgress = computed(() => loadingProgress.value);
const displayedLoadingPhase = computed(() => loadingPhase.value);

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

if (props.initialSurface === 'demoBattle') {
  if (!spectateMode.value) toggleSpectateMode();
} else if (spectateMode.value) {
  toggleSpectateMode();
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
// Server metadata received from snapshots (for remote clients to display server bar)
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

const gameChromeVisible = computed(
  () => uiChromeVisible.value && (isMobile ? mobileBarsVisible.value : !lobbyModalVisible.value),
);
const bottomChromeVisible = computed(
  () => uiChromeVisible.value && !showLoadingOverlay.value && (isMobile ? mobileBarsVisible.value : !lobbyModalVisible.value),
);

const loadingInLobbyPreview = computed(
  () =>
    !gameStarted.value &&
    currentBattleMode.value === 'real' &&
    lobbyModalVisible.value &&
    showLoadingOverlay.value,
);
const showDemoLoadingOverlay = computed(
  () => showLoadingOverlay.value && !gameStarted.value && !loadingInLobbyPreview.value,
);
const showRealLoadingOverlay = computed(
  () => battleLoading.value && gameStarted.value,
);
const loadingNextLabel = computed(() => {
  if (gameStarted.value) return 'LOADING ONLINE BATTLE';
  if (currentBattleMode.value === 'real') return 'LOADING LOBBY SIMULATION';
  return 'LOADING DEMO BATTLE';
});
const lobbyControlsSidebarOpen = ref(false);
const showLobbyControlsSidebar = computed(
  () => uiChromeVisible.value && !isMobile && lobbyModalVisible.value,
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
  [bottomChromeVisible, bottomBarsCollapsed, mobileBarsVisible, showLoadingOverlay],
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
  () => playerClientEnabled.value && !showLoadingOverlay.value,
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

function setGamePaused(paused: boolean): void {
  activeConnection?.sendCommand({ type: 'setPaused', tick: 0, paused });
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
const pendingDrawStart = ref<NetworkCommunicationPoint | null>(null);
const chatInputRef = ref<HTMLInputElement | null>(null);
const gameUiHotkeys = new CommandHotkeySequenceResolver();
let communicationDraftSequence = 0;

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
  sendCommunicationDraft({
    kind: 'mapErase',
    clientEventId: nextCommunicationDraftId('erase-radius'),
    scope: 'radius',
    center: point,
    radius: 120,
  });
  return true;
}

function handleMinimapInteraction(x: number, y: number): void {
  if (handleCommunicationMapClick(x, y)) return;
  centerMinimapCamera(x, y);
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

function handleGameUiCommandHotkey(commandId: CommandHotkeyId): boolean {
  switch (commandId) {
    case 'ui.optionsMenu':
      toggleOptionsMenu();
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
  if (hotkey.commandId !== null && handleGameUiCommandHotkey(hotkey.commandId)) {
    event.preventDefault();
    return;
  }
  if (event.key === 'Escape' && (communicationMode.value !== 'none' || optionsMenuOpen.value)) {
    event.preventDefault();
    gameUiHotkeys.reset();
    communicationMode.value = 'none';
    pendingDrawStart.value = null;
    optionsMenuOpen.value = false;
  }
}

onMounted(() => {
  syncFullscreenActive();
  document.addEventListener('fullscreenchange', syncFullscreenActive);
  window.addEventListener('keydown', handleGameUiKeydown);
  bottomControlsResizeObserver = new ResizeObserver(updatePlayableBottomInset);
  if (bottomControlsRef.value !== null) bottomControlsResizeObserver.observe(bottomControlsRef.value);
  updatePlayableBottomInset();
});

onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', syncFullscreenActive);
  window.removeEventListener('keydown', handleGameUiKeydown);
  bottomControlsResizeObserver?.disconnect();
  bottomControlsResizeObserver = null;
});

// Demo battle unit blueprint list (state read from snapshots)
const demoUnitBlueprintIds = BACKGROUND_UNIT_BLUEPRINT_IDS;

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
const terrainMapShape = ref<TerrainMapShape>(loadStoredTerrainMapShape('demo'));
const terrainDTerrain = ref<number>(loadStoredTerrainDTerrain('demo'));
const metalDepositStep = ref<number>(loadStoredMetalDepositStep('demo'));
const terrainDetail = ref<number>(loadStoredTerrainDetail('demo'));
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
  { label: 'SHAPE', value: terrainMapShape.value.toUpperCase() },
  { label: 'CENTER', value: String(centerMagnitude.value) },
  { label: 'DIVIDERS', value: String(dividersMagnitude.value) },
  { label: 'D-TERRAIN', value: terrainDTerrain.value === 0 ? 'NONE' : String(terrainDTerrain.value) },
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
  beamSnapToTurret,
  beamEma,
  resourceBallDensity,
  triangleDebug,
  buildGridDebug,
  metalMap,
  elevationMap,
  pathingMap,
  sightBoundary,
  radarBoundary,
  movementPosEma,
  movementVelEma,
  rotationPosEma,
  rotationVelEma,
  predictionMode,
  clientUnitGroundNormalEmaMode,
  edgeScrollEnabled,
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
  cameraSmoothMode,
  cameraFollowMode,
  cameraFovDegrees,
  allRangesActive,
  allProjRangesActive,
  allUnitRadiiActive,
  allPanActive,
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
  toggleProjRange,
  toggleUnitRadius,
  toggleLegsRadius,
  setCameraMode,
  setCameraFollow,
  changeCameraFovDegrees,
  toggleAllRanges,
  toggleAllProjRanges,
  toggleAllUnitRadii,
  toggleAudioSmoothing,
  toggleBurnMarks,
  toggleLocomotionMarks,
  toggleSmokeTrails,
  toggleSmokeSoftEdges,
  toggleBeamSnapToTurret,
  changeBeamEma,
  changeResourceBallDensity,
  toggleTriangleDebug,
  toggleBuildGridDebug,
  toggleMetalMap,
  toggleElevationMap,
  togglePathingMap,
  toggleSightBoundary,
  toggleRadarBoundary,
  changeMovementPosEma,
  changeMovementVelEma,
  changeRotationPosEma,
  changeRotationVelEma,
  changePredictionMode,
  changeClientUnitGroundNormalEmaMode,
  changeWaypointDetail,
  toggleEntityHud,
  changeSelectionHudMode,
  changeCommandHotkeyPreset,
  refreshCommandHotkeys,
  toggleEdgeScroll,
  toggleDragPan,
  toggleAllPan,
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
  bindGameSceneUi,
  handleMinimapClick: centerMinimapCamera,
  handleMinimapCommand: issueMinimapCommand,
  gamePhase,
  selectionActions,
} = useGameCanvasSceneUi({
  activePlayer,
  gameOverWinner,
  serverMetaFromSnapshot,
  foregroundGame,
  getBackgroundBattle: () => getBackgroundBattle(),
});

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
  terrainMapShape,
  terrainDTerrain,
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
  diffSnapSizeAvgBytes,
  diffSnapSizeHiBytes,
  displayGpuMs,
  frameMsAvg,
  frameMsHi,
  fullSnapAvgRate,
  fullSnapSizeAvgBytes,
  fullSnapSizeHiBytes,
  fullSnapWorstRate,
  gpuSourceLabel,
  gpuTimerSupported,
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
    (ARCHITECTURE_CONFIG.backend === 'deterministic-lockstep'
      ? ARCHITECTURE_CONFIG.lockstep.fixedStepHz
      : SERVER_CONFIG.tickRate.default),
);
// HOST SERVER unit ground normal EMA mode. Picks the half-life used by the
// sim's updateUnitGroundNormal (UNIT_GROUND_NORMAL_EMA_HALF_LIFE_SEC[mode]). Persisted to
// localStorage and pushed via setUnitGroundNormalEmaMode command.
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
// HOST SERVER unit ground normal EMA — the host applies its setting via the
// setUnitGroundNormalEmaMode command, but remote clients render this control
// from snapshot meta (their own localStorage is irrelevant once
// connected). Reconcile when the host's value differs.
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
    SERVER_CONFIG.snapshot.default,
);
const displayKeyframeRatio = computed(
  () =>
    serverMetaFromSnapshot.value?.snaps.keyframes ??
    SERVER_CONFIG.keyframe.default,
);
// Bar-fill target for FSPS: full snapshots are a configurable fraction
// of the host DIFFSNAP rate.
const fullSnapBarTarget = computed(() => {
  const sps = snapshotRateHz(displaySnapshotRate.value, displayTickRate.value);
  const kf = displayKeyframeRatio.value;
  if (kf === 'NONE') return 1;
  if (kf === 'ALL') return sps;
  return Math.max(0.1, sps * (kf as number));
});
const remoteSnapshotClientCount = computed(() =>
  Math.max(0, lobbyPlayerCount.value - 1),
);
const snapshotMbpsPerClient = computed(() => {
  const diffSnapAvgRate = Math.max(0, snapAvgRate.value - fullSnapAvgRate.value);
  const bytesPerSec =
    diffSnapSizeAvgBytes.value * diffSnapAvgRate +
    fullSnapSizeAvgBytes.value * fullSnapAvgRate.value;
  return Math.max(0, (bytesPerSec * 8) / 1_000_000);
});
const snapshotMbpsHostTotal = computed(() =>
  snapshotMbpsPerClient.value * remoteSnapshotClientCount.value,
);
const displayGridInfo = computed(
  () => serverMetaFromSnapshot.value?.grid ?? loadStoredGrid(currentBattleMode.value),
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
  applyTerrainMapShape,
  applyTerrainDTerrain,
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
  terrainMapShape,
  terrainDTerrain,
  metalDepositStep,
  terrainDetail,
  mapWidthLandCells,
  mapLengthLandCells,
  stopBackgroundBattle,
  startBackgroundBattle,
});

const {
  resetServerDefaults,
  setNetworkUpdateRate,
  setTickRateValue,
  setUnitGroundNormalEmaModeValue,
  setKeyframeRatioValue,
  resetGridInfoToDefault,
} = useGameCanvasServerSettings({
  currentBattleMode,
  displayGridInfo,
  serverUnitGroundNormalEmaMode,
  getActiveConnection: () => activeConnection,
});

const {
  currentAllowedUnits,
  currentAllowedUnitsSet,
  allDemoUnitsActive,
  currentForceFieldsVisible,
  currentShieldsObstructSight,
  currentFogOfWarEnabled,
  currentConverterTax,
  toggleDemoUnitBlueprintId,
  toggleAllDemoUnits,
  changeMaxTotalUnits,
  setForceFieldsVisible,
  setShieldsObstructSight,
  setFogOfWarEnabled,
  setConverterTax,
  resetDemoDefaults,
  applyPreset,
} = useGameCanvasBattleSettings({
  serverMetaFromSnapshot,
  currentBattleMode,
  demoUnitBlueprintIds,
  getActiveConnection: () => activeConnection,
  resetGridInfoToDefault,
  broadcastLobbySettingsIfHost,
  applyCenterMagnitude,
  applyDividersMagnitude,
  applyTerrainMapShape,
  applyTerrainDTerrain,
  applyMetalDepositStep,
  applyTerrainDetail,
  applyMapLandDimensions,
});

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
  displayUnitCap: displayUnitCap.value,
  gameStarted: gameStarted.value,
  mapWidthLandCells: mapWidthLandCells.value,
  mapLengthLandCells: mapLengthLandCells.value,
  centerMagnitude: centerMagnitude.value,
  dividersMagnitude: dividersMagnitude.value,
  terrainMapShape: terrainMapShape.value,
  terrainDTerrain: terrainDTerrain.value,
  metalDepositStep: metalDepositStep.value,
  terrainDetail: terrainDetail.value,
  displayUnitCount: displayUnitCount.value,
  currentForceFieldsVisible: currentForceFieldsVisible.value,
  currentShieldsObstructSight: currentShieldsObstructSight.value,
  currentFogOfWarEnabled: currentFogOfWarEnabled.value,
  currentConverterTax: currentConverterTax.value,
  presets: BATTLE_PRESETS,
  activePresetName: null,
  applyPreset,
  resetDemoDefaults,
  toggleAllDemoUnits,
  toggleDemoUnitBlueprintId,
  changeMaxTotalUnits,
  applyMapLandDimensions,
  applyCenterMagnitude,
  applyDividersMagnitude,
  applyTerrainMapShape,
  applyTerrainDTerrain,
  applyMetalDepositStep,
  applyTerrainDetail,
  setForceFieldsVisible,
  setShieldsObstructSight,
  setFogOfWarEnabled,
  setConverterTax,
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
  m.displayUnitCap = displayUnitCap.value;
  m.gameStarted = gameStarted.value;
  m.mapWidthLandCells = mapWidthLandCells.value;
  m.mapLengthLandCells = mapLengthLandCells.value;
  m.centerMagnitude = centerMagnitude.value;
  m.dividersMagnitude = dividersMagnitude.value;
  m.terrainMapShape = terrainMapShape.value;
  m.terrainDTerrain = terrainDTerrain.value;
  m.metalDepositStep = metalDepositStep.value;
  m.terrainDetail = terrainDetail.value;
  m.displayUnitCount = displayUnitCount.value;
  m.currentForceFieldsVisible = currentForceFieldsVisible.value;
  m.currentShieldsObstructSight = currentShieldsObstructSight.value;
  m.currentFogOfWarEnabled = currentFogOfWarEnabled.value;
  m.currentConverterTax = currentConverterTax.value;
  m.activePresetName = findMatchingPresetName({
    units: currentAllowedUnits.value,
    cap: displayUnitCap.value,
    turretShieldPanelsEnabled: BATTLE_CONFIG.turretShieldPanelsEnabled.default,
    turretShieldSpheresEnabled: BATTLE_CONFIG.turretShieldSpheresEnabled.default,
    forceFieldsVisible: currentForceFieldsVisible.value,
    shieldsObstructSight: currentShieldsObstructSight.value,
    shieldReflectionMode: BATTLE_CONFIG.shieldReflectionMode.default,
    fogOfWarEnabled: currentFogOfWarEnabled.value,
    converterTax: currentConverterTax.value,
    centerMagnitude: centerMagnitude.value,
    dividersMagnitude: dividersMagnitude.value,
    terrainMapShape: terrainMapShape.value,
    terrainDTerrain: terrainDTerrain.value,
    metalDepositStep: metalDepositStep.value,
    terrainDetail: terrainDetail.value,
    mapWidthLandCells: mapWidthLandCells.value,
    mapLengthLandCells: mapLengthLandCells.value,
    grid: displayGridInfo.value,
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
  architecture: ARCHITECTURE_CONFIG.backend,
  displayServerTime: displayServerTime.value,
  displayServerIp: displayServerIp.value,
  displayTickRate: displayTickRate.value,
  serverUnitGroundNormalEmaMode: serverUnitGroundNormalEmaMode.value,
  displayServerTpsAvg: displayServerTpsAvg.value,
  displayServerTpsWorst: displayServerTpsWorst.value,
  displayServerCpuAvg: displayServerCpuAvg.value,
  displayServerCpuHi: displayServerCpuHi.value,
  displaySnapshotRate: displaySnapshotRate.value,
  displayKeyframeRatio: displayKeyframeRatio.value,
  resetServerDefaults,
  setTickRateValue,
  setUnitGroundNormalEmaModeValue,
  setNetworkUpdateRate,
  setKeyframeRatioValue,
});
watchEffect(() => {
  const m = serverControlBarModel as {
    -readonly [K in keyof GameCanvasServerControlBarModel]: GameCanvasServerControlBarModel[K];
  };
  m.isReadonly = serverBarReadonly.value;
  m.barStyle = serverBarVars.value;
  m.serverLabel = serverLabel.value;
  m.architecture = ARCHITECTURE_CONFIG.backend;
  m.displayServerTime = displayServerTime.value;
  m.displayServerIp = displayServerIp.value;
  m.displayTickRate = displayTickRate.value;
  m.serverUnitGroundNormalEmaMode = serverUnitGroundNormalEmaMode.value;
  m.displayServerTpsAvg = displayServerTpsAvg.value;
  m.displayServerTpsWorst = displayServerTpsWorst.value;
  m.displayServerCpuAvg = displayServerCpuAvg.value;
  m.displayServerCpuHi = displayServerCpuHi.value;
  m.displaySnapshotRate = displaySnapshotRate.value;
  m.displayKeyframeRatio = displayKeyframeRatio.value;
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
  snapAvgRate: snapAvgRate.value,
  snapWorstRate: snapWorstRate.value,
  displayTickRate: displayTickRate.value,
  displaySnapshotRate: displaySnapshotRate.value,
  fullSnapAvgRate: fullSnapAvgRate.value,
  fullSnapWorstRate: fullSnapWorstRate.value,
  fullSnapBarTarget: fullSnapBarTarget.value,
  diffSnapSizeAvgBytes: diffSnapSizeAvgBytes.value,
  diffSnapSizeHiBytes: diffSnapSizeHiBytes.value,
  fullSnapSizeAvgBytes: fullSnapSizeAvgBytes.value,
  fullSnapSizeHiBytes: fullSnapSizeHiBytes.value,
  snapshotMbpsPerClient: snapshotMbpsPerClient.value,
  snapshotMbpsHostTotal: snapshotMbpsHostTotal.value,
  remoteSnapshotClientCount: remoteSnapshotClientCount.value,
  audioSmoothing: audioSmoothing.value,
  burnMarks: burnMarks.value,
  locomotionMarks: locomotionMarks.value,
  smokeTrails: smokeTrails.value,
  smokeSoftEdges: smokeSoftEdges.value,
  beamSnapToTurret: beamSnapToTurret.value,
  beamEma: beamEma.value,
  resourceBallDensity: resourceBallDensity.value,
  movementPosEma: movementPosEma.value,
  movementVelEma: movementVelEma.value,
  rotationPosEma: rotationPosEma.value,
  rotationVelEma: rotationVelEma.value,
  predictionMode: predictionMode.value,
  clientUnitGroundNormalEmaMode: clientUnitGroundNormalEmaMode.value,
  allPanActive: allPanActive.value,
  dragPanEnabled: dragPanEnabled.value,
  edgeScrollEnabled: edgeScrollEnabled.value,
  showServerControls: showServerControls.value,
  triangleDebug: triangleDebug.value,
  buildGridDebug: buildGridDebug.value,
  metalMap: metalMap.value,
  elevationMap: elevationMap.value,
  pathingMap: pathingMap.value,
  sightBoundary: sightBoundary.value,
  radarBoundary: radarBoundary.value,
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
  cameraFovDegrees: cameraFovDegrees.value,
  cameraSmoothMode: cameraSmoothMode.value,
  cameraFollowMode: cameraFollowMode.value,
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
  toggleBeamSnapToTurret,
  changeBeamEma,
  changeResourceBallDensity,
  changeMovementPosEma,
  changeMovementVelEma,
  changeRotationPosEma,
  changeRotationVelEma,
  changePredictionMode,
  changeClientUnitGroundNormalEmaMode,
  toggleAllPan,
  toggleDragPan,
  toggleEdgeScroll,
  toggleTriangleDebug,
  toggleBuildGridDebug,
  toggleMetalMap,
  toggleElevationMap,
  togglePathingMap,
  toggleSightBoundary,
  toggleRadarBoundary,
  changeRenderMode,
  changeAudioScope,
  changeMasterVolume,
  changeGameSpeed: setTickRateValue,
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
  changeCameraFovDegrees,
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
  m.snapAvgRate = snapAvgRate.value;
  m.snapWorstRate = snapWorstRate.value;
  m.displayTickRate = displayTickRate.value;
  m.displaySnapshotRate = displaySnapshotRate.value;
  m.fullSnapAvgRate = fullSnapAvgRate.value;
  m.fullSnapWorstRate = fullSnapWorstRate.value;
  m.fullSnapBarTarget = fullSnapBarTarget.value;
  m.diffSnapSizeAvgBytes = diffSnapSizeAvgBytes.value;
  m.diffSnapSizeHiBytes = diffSnapSizeHiBytes.value;
  m.fullSnapSizeAvgBytes = fullSnapSizeAvgBytes.value;
  m.fullSnapSizeHiBytes = fullSnapSizeHiBytes.value;
  m.snapshotMbpsPerClient = snapshotMbpsPerClient.value;
  m.snapshotMbpsHostTotal = snapshotMbpsHostTotal.value;
  m.remoteSnapshotClientCount = remoteSnapshotClientCount.value;
  m.audioSmoothing = audioSmoothing.value;
  m.burnMarks = burnMarks.value;
  m.locomotionMarks = locomotionMarks.value;
  m.smokeTrails = smokeTrails.value;
  m.smokeSoftEdges = smokeSoftEdges.value;
  m.beamSnapToTurret = beamSnapToTurret.value;
  m.beamEma = beamEma.value;
  m.resourceBallDensity = resourceBallDensity.value;
  m.movementPosEma = movementPosEma.value;
  m.movementVelEma = movementVelEma.value;
  m.rotationPosEma = rotationPosEma.value;
  m.rotationVelEma = rotationVelEma.value;
  m.predictionMode = predictionMode.value;
  m.clientUnitGroundNormalEmaMode = clientUnitGroundNormalEmaMode.value;
  m.allPanActive = allPanActive.value;
  m.dragPanEnabled = dragPanEnabled.value;
  m.edgeScrollEnabled = edgeScrollEnabled.value;
  m.showServerControls = showServerControls.value;
  m.triangleDebug = triangleDebug.value;
  m.buildGridDebug = buildGridDebug.value;
  m.metalMap = metalMap.value;
  m.elevationMap = elevationMap.value;
  m.pathingMap = pathingMap.value;
  m.sightBoundary = sightBoundary.value;
  m.radarBoundary = radarBoundary.value;
  m.renderMode = renderMode.value;
  m.audioScope = audioScope.value;
  m.masterVolume = masterVolume.value;
  m.allSoundsActive = allSoundsActive.value;
  m.allRangesActive = allRangesActive.value;
  m.allProjRangesActive = allProjRangesActive.value;
  m.allUnitRadiiActive = allUnitRadiiActive.value;
  m.legsRadiusToggle = legsRadiusToggle.value;
  m.cameraFovDegrees = cameraFovDegrees.value;
  m.cameraSmoothMode = cameraSmoothMode.value;
  m.cameraFollowMode = cameraFollowMode.value;
  m.fullscreenActive = fullscreenActive.value;
  m.uiChromeVisible = uiChromeVisible.value;
  m.mapDetailsVisible = mapDetailsVisible.value;
  m.optionsMenuOpen = optionsMenuOpen.value;
});

</script>

<template>
  <div class="game-wrapper">
    <!-- Top status bar lives outside the 3D game area, like the bottom controls. -->
    <div
      v-if="gameChromeVisible"
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
        v-if="!playerClientEnabled && !showLoadingOverlay"
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
        v-if="gameStarted && gamePhase === 'paused' && gameOverWinner === null"
        class="game-paused-banner"
        role="status"
        aria-live="polite"
        title="Click to resume"
        @click="setGamePaused(false)"
      >
        ⏸ PAUSED
      </div>

      <!-- Game UI (desktop: hidden when lobby modal visible; mobile: follows hamburger toggle) -->
      <template v-if="playerClientEnabled && gameChromeVisible">
        <!-- Selection panel (bottom-left) -->
        <SelectionPanel
          :selection="selectionInfo"
          :actions="selectionActions"
          :hotkey-preset="commandHotkeyPreset"
          :hotkey-revision="commandHotkeyRevision"
          :playable-bottom-inset-px="playableBottomInsetPx"
        />

        <!-- Minimap -->
        <div class="minimap-stack">
          <Minimap
            :data="minimapData"
            :drawings="minimapCommunicationDrawings"
            :drag-pan="minimapDragPanEnabled"
            @click="handleMinimapInteraction"
            @command="handleMinimapCommandInteraction"
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
              title="Erase all drawings"
              @click="eraseAllCommunicationDrawings"
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
        :class="{ collapsed: bottomBarsCollapsed }"
        :aria-expanded="!bottomBarsCollapsed"
        :aria-label="bottomBarsCollapsed ? 'Show bottom controls' : 'Hide bottom controls'"
        :title="bottomBarsCollapsed ? 'Show bottom controls' : 'Hide bottom controls'"
        @click="toggleBottomBars"
      >
        <span class="toggle-dot"></span>
        <span class="toggle-dot"></span>
        <span class="toggle-dot"></span>
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

    <!-- Lobby Modal. On the initial (BUDGET ANNIHILATION) and
         connecting screens it renders full-screen over the
         demo-battle backdrop — exactly the original load-time
         behavior. Once `roomCode` is set (the user clicked
         Host or finished joining), the GAME LOBBY screen renders
         a `#lobby-preview-target` div inside the modal; the demo
         container teleports into it (see Teleport above) and the
         demo battle runs as a small simulation preview alongside
         the lobby's terrain / player controls. -->
    <LobbyModal
      :visible="!isMobile && showLobby && !spectateMode"
      :is-host="isHost"
      :room-code="roomCode"
      :players="lobbyPlayers"
      :local-player-id="localPlayerId"
      :error="lobbyError"
      :is-connecting="isConnecting"
      :center-magnitude="centerMagnitude"
      :dividers-magnitude="dividersMagnitude"
      :terrain-map-shape="terrainMapShape"
      :terrain-d-terrain="terrainDTerrain"
      :metal-deposit-step="metalDepositStep"
      :terrain-detail="terrainDetail"
      :map-width-land-cells="mapWidthLandCells"
      :map-length-land-cells="mapLengthLandCells"
      :unit-blueprint-ids="demoUnitBlueprintIds"
      :allowed-units="currentAllowedUnits"
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
      @set-terrain-map-shape="(s) => applyTerrainMapShape(s)"
      @set-terrain-d-terrain="(v) => applyTerrainDTerrain(v)"
      @set-metal-deposit-step="(v) => applyMetalDepositStep(v)"
      @set-terrain-detail="(v) => applyTerrainDetail(v)"
      @set-preset="(p) => applyPreset(p)"
      @set-map-land-dimensions="(dimensions) => applyMapLandDimensions(dimensions)"
      @toggle-unit="(ut) => toggleDemoUnitBlueprintId(ut)"
      @toggle-all-units="toggleAllDemoUnits"
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
      :ui-chrome-visible="uiChromeVisible"
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
  left: 464px;
  z-index: 1001;
  width: min(300px, calc(100vw - 484px));
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
  left: 780px;
  z-index: 1001;
  width: min(244px, calc(100vw - 800px));
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
    top: 296px;
    left: 0;
    max-width: min(300px, 100vw);
    transform: none;
  }

  .communication-panel.open {
    width: min(300px, 100vw);
    min-width: 0;
  }

  .map-details-panel {
    top: 296px;
    left: 0;
    width: min(300px, 100vw);
  }

  .options-menu-panel {
    top: 296px;
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
  width: 30px;
  height: 72px;
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

.bottom-controls-toggle {
  flex: 0 0 30px;
  align-self: stretch;
  min-height: 100%;
  padding: 0;
  background: #12121a;
  border: 1px solid #444;
  border-right: none;
  border-radius: 0;
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

.bottom-controls-toggle.collapsed {
  height: 100%;
  min-height: 72px;
  border-right: 1px solid #444;
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
