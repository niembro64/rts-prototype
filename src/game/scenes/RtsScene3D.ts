// RtsScene3D — Three.js-backed game scene. Uses ThreeApp and
// Render3DEntities with focused input/view state pushed into helpers.

import type { ClientViewState } from '../network/ClientViewState';
import type { SceneCameraState } from '@/types/game';
import type { CameraViewMode } from '@/types/client';
import {
  RtsScene3DSnapshotIntake,
  type RtsScene3DSnapshotApplyStats,
  type RtsScene3DSnapshotCounters,
  type RtsScene3DSnapshotPayloadSizeStats,
  type RtsScene3DSnapshotRateStats,
} from './helpers/RtsScene3DSnapshotIntake';
import type { SnapshotMaterializationMetadata } from '../network/snapshotMaterializationMetadata';
import { SNAPSHOT_CADENCE_REGRESSION } from '../SnapshotCadenceRegression';
import { buildEconomyInfo, buildIdleBuilderGroups, buildUnitStatsOverlayInfo } from './helpers';
import type {
  EconomyInfo,
  IdleBuilderGroupInfo,
  MinimapData,
  SelectionInfo,
  UnitStatsOverlayInfo,
} from './helpers';
import { RtsScene3DCameraControl, type CameraShim } from './helpers/RtsScene3DCameraControl';
import { RtsScene3DCameraFootprintSystem } from './helpers/RtsScene3DCameraFootprintSystem';
import { RtsScene3DCameraFramingSystem } from './helpers/RtsScene3DCameraFramingSystem';
import { RtsScene3DFrameTelemetry, type RtsScene3DFrameTiming } from './helpers/RtsScene3DFrameTelemetry';
import { buildHudSpriteTelemetry, type HudSpriteTelemetry } from './helpers/RtsScene3DHudSpriteTelemetry';
import { RtsScene3DMinimapSystem } from './helpers/RtsScene3DMinimapSystem';
import { RtsScene3DRenderPhase } from './helpers/RtsScene3DRenderPhase';
import { RtsScene3DRenderBudget } from './helpers/RtsScene3DRenderBudget';
import { teardownRtsScene3DRenderers } from './helpers/RtsScene3DRendererLifecycle';
import { bootstrapRtsScene3DRenderers } from './helpers/RtsScene3DRendererBootstrap';
import { RtsScene3DRendererWarmup } from './helpers/RtsScene3DRendererWarmup';
import { RtsScene3DSelectionSystem } from './helpers/RtsScene3DSelectionSystem';
import { dispatchSimEvent3DVisual } from './helpers/RtsScene3DVisualEventDispatcher';
import {
  DETAIL_RUNG_GLYPH,
  detailLevelForViewPosition,
  detailRungForLevel,
} from '../render3d/EntityDetailLevel3D';
import { getGraphicsConfig } from '@/clientBarConfig';
import type { ClientCommandSink } from '../input/ClientCommandSink';
import type { BarBuildCategoryId } from '../input/buildMenuLayout';
import { ThreeApp } from '../render3d/ThreeApp';
import { Render3DEntities } from '../render3d/Render3DEntities';
import { Input3DManager } from '../render3d/Input3DManager';
import { BeamRenderer3D } from '../render3d/BeamRenderer3D';
import { ShieldRenderer3D } from '../render3d/ShieldRenderer3D';
import { TerrainTileRenderer3D } from '../render3d/TerrainTileRenderer3D';
import { MetalDepositRenderer3D } from '../render3d/MetalDepositRenderer3D';
import { EnvironmentPropRenderer3D } from '../render3d/EnvironmentPropRenderer3D';
import { generateMetalDeposits, type MetalDeposit } from '../../metalDepositConfig';
import { WaterRenderer3D } from '../render3d/WaterRenderer3D';
import { CursorGround } from '../render3d/CursorGround';
import { ViewportFootprint } from '../ViewportFootprint';
import { SprayRenderer3D } from '../render3d/SprayRenderer3D';
import { PylonTubeFlowRenderer } from '../render3d/PylonTubeFlowRenderer';
import { SmokeTrail3D } from '../render3d/SmokeTrail3D';
import { WindParticleField3D } from '../render3d/WindParticleField3D';
import { SightBoundaryRenderer3D } from '../render3d/SightBoundaryRenderer3D';
import type { OverlayLineSystem } from '../render3d/OverlayLineSystem';
import { Explosion3D } from '../render3d/Explosion3D';
import { ShieldImpactRenderer3D } from '../render3d/ShieldImpactRenderer3D';
import { WaterSplash3D } from '../render3d/WaterSplash3D';
import type { ScopedRenderMeshRetentionTelemetry } from '../render3d/ScopedRenderMeshRetention3D';
import { Debris3D } from '../render3d/Debris3D';
import { BurnMark3D } from '../render3d/BurnMark3D';
import { GroundPrint3D } from '../render3d/GroundPrint3D';
import { AreaDrag3D } from '../render3d/AreaDrag3D';
import { SurfaceLiftProbeOverlay3D } from '../render3d/SurfaceLiftProbeOverlay3D';
import { LineDrag3D } from '../render3d/LineDrag3D';
import { BuildGhost3D } from '../render3d/BuildGhost3D';
import { ContactShadowRenderer3D } from '../render3d/ContactShadowRenderer3D';
import { RtsScene3DAudioSystem } from './helpers/RtsScene3DAudioSystem';
import { RtsScene3DPredictionPhase } from './helpers/RtsScene3DPredictionPhase';
import type { NetworkServerSnapshotSimEvent } from '../network/NetworkTypes';
import { CommandQueue, type Command } from '../sim/commands';
import { getTerrainDividerTeamCount } from '../sim/playerLayout';
import {
  getSurfaceHeight,
  setTerrainTeamCount,
  setTerrainCenterMagnitude,
  setTerrainDividersMagnitude,
  setTerrainPerimeterMagnitude,
} from '../sim/Terrain';
import { HealthBar3D } from '../render3d/HealthBar3D';
import { NameLabel3D } from '../render3d/NameLabel3D';
import { Waypoint3D } from '../render3d/Waypoint3D';

import type { GameConnection } from '../server/GameConnection';
import type {
  GamePhase,
  NetworkServerSnapshotMeta,
} from '../network/NetworkTypes';
import { setPlayerCountForColors } from '../sim/types';
import type {
  Entity,
  EntityId,
  PlayerId,
  WaypointType,
  CombatFireState,
  UnitAirIdleState,
  UnitMoveState,
  BuildingBlueprintId,
} from '../sim/types';

import {
  CAMERA_CONSTRAINTS,
  WORLD_PADDING_PERCENT,
  LAND_CELL_SIZE,
} from '../../config';

type RtsScene3DConfig = {
  playerIds: PlayerId[];
  localPlayerId: PlayerId;
  gameConnection: GameConnection;
  /** Hoisted up to GameCanvas so state survives a live 2D↔3D renderer
   *  swap without waiting for the next snapshot. If the old scene's
   *  CVS is already populated, the new scene inherits all units,
   *  buildings, projectiles, selection, prediction, etc. with zero
   *  delay. On first boot GameCanvas creates a fresh one. */
  clientViewState: ClientViewState;
  mapWidth: number;
  mapHeight: number;
  centerMagnitude?: number;
  dividersMagnitude?: number;
  perimeterMagnitude?: number;
  backgroundMode: boolean;
  /** GAME LOBBY preview pane — selects the lobby camera defaults and
   *  expects the GameServer to have spawned commanders only (no AI,
   *  no buildings, no background units). Set by the lobby preview
   *  path; everywhere else this stays false. */
  lobbyPreview?: boolean;
  /** Resolves a player ID to its display name. Powered by the host
   *  app's lobby roster; the scene uses it for the separate commander
   *  owner label via NameLabel3D. Optional for back-compat with callers
   *  that don't yet pass it (lobby preview, demo standalones). */
  lookupPlayerName?: (playerId: PlayerId) => string | null;
  onRendererWarmupChange?: (warming: boolean) => void;
  onStartupReady?: () => void;
};

type SceneLifecycle = {
  onRestart(cb: () => void): void;
  restart(): void;
};

export class RtsScene3D {
  private threeApp: ThreeApp;

  private clientViewState!: ClientViewState;
  private entityRenderer!: Render3DEntities;
  private beamRenderer!: BeamRenderer3D;
  private shieldRenderer!: ShieldRenderer3D;
  private terrainTileRenderer!: TerrainTileRenderer3D;
  private metalDeposits: MetalDeposit[] = [];
  private metalDepositRenderer: MetalDepositRenderer3D | null = null;
  private environmentPropRenderer: EnvironmentPropRenderer3D | null = null;
  private waterRenderer!: WaterRenderer3D;
  private explosionRenderer!: Explosion3D;
  private shieldImpactRenderer!: ShieldImpactRenderer3D;
  private waterSplashRenderer!: WaterSplash3D;
  private debrisRenderer!: Debris3D;
  /** Per-frame world-XY visibility footprint driven by the PLAYER
   *  CLIENT `RENDER: WIN/PAD/ALL` toggle. Populated each frame from
   *  the same 4 corner raycasts the minimap already uses, so the
   *  cull bounds exactly match what the camera can see on the
   *  ground plane. Shared across all per-entity hot loops + the
   *  minimap. */
  private renderScope = new ViewportFootprint();
  private burnMarkRenderer!: BurnMark3D;
  private groundPrintRenderer!: GroundPrint3D;
  private areaDragRenderer!: AreaDrag3D;
  private airLiftProbeOverlay!: SurfaceLiftProbeOverlay3D;
  private lineDragRenderer!: LineDrag3D;
  private buildGhostRenderer!: BuildGhost3D;
  private sprayRenderer!: SprayRenderer3D;
  private pylonTubeFlowRenderer!: PylonTubeFlowRenderer;
  private smokeTrailRenderer!: SmokeTrail3D;
  private windParticleFieldRenderer!: WindParticleField3D;
  private overlayLineSystem!: OverlayLineSystem;
  private sightBoundaryRenderer!: SightBoundaryRenderer3D;
  private radarBoundaryRenderer!: SightBoundaryRenderer3D;
  private audioSystem = new RtsScene3DAudioSystem();
  private inputManager: Input3DManager | null = null;
  private gameConnection!: GameConnection;
  private snapshotIntake!: RtsScene3DSnapshotIntake;
  private localCommandQueue = new CommandQueue();
  private readonly clientCommandSink: ClientCommandSink = {
    enqueue: (command) => this.submitClientCommand(command),
  };
  private cameraFootprintSystem!: RtsScene3DCameraFootprintSystem;
  private minimapSystem!: RtsScene3DMinimapSystem;
  private selectionSystem!: RtsScene3DSelectionSystem;
  private healthBar3D: HealthBar3D | null = null;
  private nameLabel3D: NameLabel3D | null = null;
  private contactShadowRenderer: ContactShadowRenderer3D | null = null;
  private predictionPhase!: RtsScene3DPredictionPhase;
  private cameraControl!: RtsScene3DCameraControl;
  private cameraFramingSystem!: RtsScene3DCameraFramingSystem;
  private renderPhase: RtsScene3DRenderPhase | null = null;
  /** Resolves a player ID to its display name. Hooked up via
   *  RtsScene3DConfig.lookupPlayerName; the render phase applies the
   *  fallback policy for owner labels in single-player / demo /
   *  lobby-preview contexts that don't have a roster wired up. */
  private lookupPlayerName: (id: PlayerId) => string | null = () => null;
  private waypoint3D: Waypoint3D | null = null;

  // Single canonical cursor → 3D ground picker (raycaster against
  // the rendered terrain mesh). Shared by the orbit camera and the
  // input manager so every cursor-anchored point — camera zoom,
  // camera pan, move/attack/dgun/build clicks, waypoint chains,
  // factory rallies — comes from the same true-3D source.
  private cursorGround!: CursorGround;

  private localPlayerId: PlayerId;
  private playerIds: PlayerId[];
  private mapWidth: number;
  private mapHeight: number;
  private centerMagnitude: number;
  private dividersMagnitude: number;
  private perimeterMagnitude: number;
  private backgroundMode: boolean;
  private lobbyPreview: boolean;

  private isGameOver = false;

  private frameTelemetry = new RtsScene3DFrameTelemetry();
  private renderBudget = new RtsScene3DRenderBudget(getGraphicsConfig());

  // UI update throttling (mirror RtsScene)
  private economyUpdateTimer = 0;
  private readonly ECONOMY_UPDATE_INTERVAL = 100;
  // Entity source adapter, kept shape-compatible with RtsScene's for UI helpers
  private entitySourceAdapter!: {
    getUnits: () => Entity[];
    getBuildings: () => Entity[];
    getUnitsAndBuildings: () => Entity[];
    getProjectiles: () => Entity[];
    getAllEntities: () => Entity[];
    getEntity: (id: EntityId) => Entity | undefined;
    getSelectedUnits: () => Entity[];
    getSelectedBuildings: () => Entity[];
    getBuildingsByPlayer: (playerId: PlayerId) => Entity[];
    getUnitsByPlayer: (playerId: PlayerId) => Entity[];
    arePlayersAllied: (a: PlayerId, b: PlayerId) => boolean;
    getEntitySetVersion: () => number;
    getTerrainBuildabilityGrid: () => ReturnType<ClientViewState['getTerrainBuildabilityGrid']>;
  };
  private clientRenderEnabled = true;
  // `update()` finishes before ThreeApp calls renderer.render(). Keep the
  // scene-side timings until the app reports that the complete RAF callback
  // has finished so FRAME includes WebGL submission too.
  private pendingFrameTelemetry: {
    frameStart: number;
    renderMs: number;
    predMs: number;
  } | null = null;

  // ── Callback interface matching RtsScene ──
  public onPlayerChange?: (playerId: PlayerId) => void;
  public onSelectionChange?: (info: SelectionInfo) => void;
  public onEconomyChange?: (info: EconomyInfo) => void;
  /** Idle-builder chips for the persistent HUD panel. Published on the
   *  economy UI cadence (ECONOMY_UPDATE_INTERVAL) and only when the
   *  group signature actually changed, so idle frames publish nothing. */
  public onIdleBuildersChange?: (groups: IdleBuilderGroupInfo[]) => void;
  private lastIdleBuildersSignature = '';
  public onMinimapUpdate?: (data: MinimapData) => void;
  /** Separate per-frame callback for just the camera footprint quad.
   *  Decoupling this from `onMinimapUpdate` keeps the box animation
   *  smooth even when entity rebuilding is throttled to 20 Hz. */
  public onCameraQuadUpdate?: (
    quad: import('../ViewportFootprint').FootprintQuad,
    cameraYaw: number,
    cameraPitch: number,
    cameraView: MinimapData['cameraView'],
  ) => void;
  public onGameOverUI?: (winnerId: PlayerId) => void;
  public onGameRestart?: () => void;
  public onServerMetaUpdate?: (meta: NetworkServerSnapshotMeta) => void;
  /** Fires when the authoritative game phase changes (battle / paused /
   *  gameOver) so the HUD can show pause state. */
  public onGamePhaseChange?: (phase: GamePhase) => void;
  private lastUiGamePhase: GamePhase | null = null;
  public onStartupReady?: () => void;
  public onRendererWarmupChange?: (warming: boolean) => void;
  private rendererWarmup: RtsScene3DRendererWarmup | null = null;
  private destroyed = false;
  private lastPingPoint: { x: number; y: number } | null = null;
  private readonly cameraAnchors: Array<SceneCameraState | null> = [null, null, null, null];
  private readonly handleSimEvent3DCallback = (event: NetworkServerSnapshotSimEvent): void => {
    this.handleSimEvent3D(event);
  };

  // Scene lifecycle accessor read by GameCanvas.vue.
  private _restartCb: (() => void) | null = null;
  public readonly scene: SceneLifecycle = {
    onRestart: (cb: () => void) => { this._restartCb = cb; },
    restart: () => { this._restartCb?.(); },
  };

  // Dynamic camera shim — exposes a zoom-like number derived from the orbit
  // distance so UI (zoom display, minimap viewport) has a consistent axis to read.
  public readonly cameras: CameraShim;

  constructor(threeApp: ThreeApp, config: RtsScene3DConfig) {
    this.threeApp = threeApp;
    this.clientRenderEnabled = threeApp.isRenderEnabled();
    this.localPlayerId = config.localPlayerId;
    this.playerIds = config.playerIds;
    if (config.lookupPlayerName) this.lookupPlayerName = config.lookupPlayerName;
    this.onRendererWarmupChange = config.onRendererWarmupChange;
    this.onStartupReady = config.onStartupReady;
    this.centerMagnitude = config.centerMagnitude ?? 0;
    this.dividersMagnitude = config.dividersMagnitude ?? 0;
    this.perimeterMagnitude = config.perimeterMagnitude ?? 0;
    // Pin the color wheel to the lobby's player count. Player ids map
    // directly to color slots, so every browser sees the same colors.
    setPlayerCountForColors(this.playerIds.length);
    // Also seed the heightmap's divider count from the same source.
    // The same radial-slice math is used for every player count,
    // including one-player maps. The host's GameServer sets this too,
    // but remote clients only construct the renderer.
    setTerrainTeamCount(getTerrainDividerTeamCount(this.playerIds.length));
    setTerrainCenterMagnitude(this.centerMagnitude);
    setTerrainDividersMagnitude(this.dividersMagnitude);
    setTerrainPerimeterMagnitude(this.perimeterMagnitude);
    this.mapWidth = config.mapWidth;
    this.mapHeight = config.mapHeight;
    this.backgroundMode = config.backgroundMode;

    // Metal deposits are deterministic from map size + player count,
    // so the client re-derives the same list. `generateMetalDeposits`
    // installs the resulting flat zones into the client's local
    // Terrain module itself (see its docstring), so by the time the
    // marker pass below reads `metalDeposits` the heightmap already
    // matches the server's.
    const metalDeposits = generateMetalDeposits(
      this.mapWidth,
      this.mapHeight,
      this.playerIds.length,
    );
    this.metalDeposits = metalDeposits;
    this.lobbyPreview = config.lobbyPreview ?? false;
    this.gameConnection = config.gameConnection;
    // ClientViewState is owned by GameCanvas so its state (units, buildings,
    // prediction, selection) survives a live 2D↔3D renderer swap.
    this.clientViewState = config.clientViewState;
    this.cameraFootprintSystem = new RtsScene3DCameraFootprintSystem(
      this.mapWidth,
      this.mapHeight,
    );
    this.minimapSystem = new RtsScene3DMinimapSystem(
      this.clientViewState,
      this.mapWidth,
      this.mapHeight,
    );
    this.selectionSystem = new RtsScene3DSelectionSystem(
      this.clientViewState,
      () => this.localPlayerId,
    );
    this.snapshotIntake = new RtsScene3DSnapshotIntake(
      this.clientViewState,
      this.gameConnection,
    );
    this.predictionPhase = new RtsScene3DPredictionPhase(this.clientViewState);
    const baseDistance = Math.max(this.mapWidth, this.mapHeight) * 0.35;
    const cameraBattleKind = this.lobbyPreview
      ? 'lobbyBattle'
      : this.backgroundMode ? 'demoBattle' : 'realBattle';
    this.cameraControl = new RtsScene3DCameraControl(
      this.threeApp,
      baseDistance,
      this.mapWidth,
      this.mapHeight,
    );
    this.cameraFramingSystem = new RtsScene3DCameraFramingSystem(
      this.threeApp,
      baseDistance,
      this.mapWidth,
      this.mapHeight,
      this.playerIds,
      () => this.localPlayerId,
      cameraBattleKind,
      (x, z) => getSurfaceHeight(x, z, this.mapWidth, this.mapHeight, LAND_CELL_SIZE),
      () => this.selectionSystem.getSelectedUnits(),
    );
    this.cameras = this.cameraControl.cameras;

  }

  public setClientRenderEnabled(enabled: boolean): void {
    if (this.clientRenderEnabled === enabled) return;
    this.clientRenderEnabled = enabled;
    this.threeApp.setRenderEnabled(enabled);
    if (!enabled) {
      this.audioSystem.clear();
      this.renderPhase?.resetEffectAccumulators();
    }
  }

  public isClientRenderEnabled(): boolean {
    return this.clientRenderEnabled;
  }

  create(): void {
    // this.clientViewState is already set from config (constructor).
    this.entitySourceAdapter = {
      getUnits: () => this.clientViewState.getUnits(),
      getBuildings: () => this.clientViewState.getBuildings(),
      getUnitsAndBuildings: () => this.clientViewState.getUnitsAndBuildings(),
      getProjectiles: () => this.clientViewState.getProjectiles(),
      getAllEntities: () => this.clientViewState.getAllEntities(),
      getEntity: (id) => this.clientViewState.getEntity(id),
      getSelectedUnits: () => this.selectionSystem.getSelectedUnits(),
      getSelectedBuildings: () => this.selectionSystem.getSelectedBuildings(),
      getBuildingsByPlayer: (pid) => this.clientViewState.getBuildingsByPlayer(pid),
      getUnitsByPlayer: (pid) => this.clientViewState.getUnitsByPlayer(pid),
      arePlayersAllied: (a, b) => this.arePlayersAlliedForInput(a, b),
      getEntitySetVersion: () => this.clientViewState.getEntitySetVersion(),
      getTerrainBuildabilityGrid: () => this.clientViewState.getTerrainBuildabilityGrid(),
    };

    this.snapshotIntake.attach();

    this.gameConnection.onGameOver((winnerId: PlayerId) => {
      if (!this.isGameOver) this.handleGameOver(winnerId);
    });

    const renderers = bootstrapRtsScene3DRenderers({
      threeApp: this.threeApp,
      clientViewState: this.clientViewState,
      renderScope: this.renderScope,
      cameraFramingSystem: this.cameraFramingSystem,
      mapWidth: this.mapWidth,
      mapHeight: this.mapHeight,
      playerCount: this.playerIds.length,
      metalDeposits: this.metalDeposits,
      gameConnection: this.gameConnection,
    });
    this.entityRenderer = renderers.entityRenderer;
    this.beamRenderer = renderers.beamRenderer;
    this.shieldRenderer = renderers.shieldRenderer;
    this.terrainTileRenderer = renderers.terrainTileRenderer;
    this.metalDepositRenderer = renderers.metalDepositRenderer;
    this.environmentPropRenderer = renderers.environmentPropRenderer;
    this.contactShadowRenderer = renderers.contactShadowRenderer;
    this.waterRenderer = renderers.waterRenderer;
    this.cursorGround = renderers.cursorGround;
    this.explosionRenderer = renderers.explosionRenderer;
    this.shieldImpactRenderer = renderers.shieldImpactRenderer;
    this.waterSplashRenderer = renderers.waterSplashRenderer;
    this.debrisRenderer = renderers.debrisRenderer;
    this.burnMarkRenderer = renderers.burnMarkRenderer;
    this.groundPrintRenderer = renderers.groundPrintRenderer;
    this.areaDragRenderer = renderers.areaDragRenderer;
    this.airLiftProbeOverlay = renderers.airLiftProbeOverlay;
    this.lineDragRenderer = renderers.lineDragRenderer;
    this.buildGhostRenderer = renderers.buildGhostRenderer;
    this.sprayRenderer = renderers.sprayRenderer;
    this.pylonTubeFlowRenderer = renderers.pylonTubeFlowRenderer;
    this.smokeTrailRenderer = renderers.smokeTrailRenderer;
    this.windParticleFieldRenderer = renderers.windParticleFieldRenderer;
    this.overlayLineSystem = renderers.overlayLineSystem;
    this.sightBoundaryRenderer = renderers.sightBoundaryRenderer;
    this.radarBoundaryRenderer = renderers.radarBoundaryRenderer;
    this.rendererWarmup = new RtsScene3DRendererWarmup({
      threeApp: this.threeApp,
      explosionRenderer: this.explosionRenderer,
      snapshotIntake: this.snapshotIntake,
      getRenderPhase: () => this.renderPhase,
      isClientRenderEnabled: () => this.clientRenderEnabled,
      isDestroyed: () => this.destroyed,
      notifyWarmupChange: (active) => this.onRendererWarmupChange?.(active),
    });

    const canvasParent = this.threeApp.canvas.parentElement;
    if (canvasParent) {
      // HUD elements live in the 3D scene now: pooled sprites + line
      // buffers parented to the world group so they get full GPU
      // depth-occlusion against the terrain (a unit behind a hill
      // has its bar/waypoint markers naturally clipped).
      this.healthBar3D = new HealthBar3D(this.threeApp.world);
      this.nameLabel3D = new NameLabel3D(this.threeApp.world);
      this.waypoint3D = new Waypoint3D(
        this.threeApp.world,
        this.mapWidth, this.mapHeight,
        this.overlayLineSystem,
        (id) => this.clientViewState.getEntity(id),
      );
    }

    // Wire raycast-based selection + move commands. The shared
    // CursorGround is passed in so EVERY command point Input3DManager
    // computes (move targets, build clicks, dgun targets, factory
    // rallies, line-path waypoints) comes from the actual rendered
    // 3D ground — same source the camera uses, no y=0 plane in the
    // input pipeline.
    this.inputManager = new Input3DManager(
      this.threeApp,
      {
        getTick: () => this.clientViewState.getTick(),
        activePlayerId: this.localPlayerId,
      },
      this.entitySourceAdapter,
      this.clientCommandSink,
      this.cursorGround,
    );
    // Hand the build-ghost renderer to the input manager so it can
    // drive preview updates on mouse-move-in-build-mode (hidden on
    // mode exit via the onBuildModeChange callback below).
    this.inputManager.setBuildGhost(this.buildGhostRenderer);
    this.inputManager.setMapBounds(
      this.mapWidth,
      this.mapHeight,
      this.playerIds.length,
      this.metalDeposits,
    );
    // Keep scene's waypointMode in lockstep with the InputManager so the
    // SelectionPanel reflects the active mode when M/F/H hotkeys fire.
    this.inputManager.onWaypointModeChange = (mode) => {
      this.selectionSystem.setWaypointMode(mode);
    };
    this.inputManager.onControlGroupsChange = (groups) => {
      this.selectionSystem.setControlGroups(groups);
    };
    this.selectionSystem.setControlGroups(this.inputManager.getControlGroupSlotSnapshots());
    this.inputManager.onControlGroupFocus = (x, y) => {
      this.cameraControl.centerOn(x, y);
    };
    // Keep the SelectionPanel's mode chips (build / D-gun) in sync
    // with the shared CommanderModeController inside Input3DManager.
    this.inputManager.onBuildModeChange = (buildingBlueprintId) => {
      this.selectionSystem.setBuildMode(buildingBlueprintId);
    };
    this.inputManager.onBuildGridCategoryChange = (categoryId) => {
      this.selectionSystem.setBuildGridCategory(categoryId);
    };
    this.selectionSystem.setBuildGridCategory(this.inputManager.getBuildGridCategory());
    this.inputManager.onBuildGridPageChange = (pageIndex) => {
      this.selectionSystem.setBuildGridPage(pageIndex);
    };
    this.selectionSystem.setBuildGridPage(this.inputManager.getBuildGridPage());
    this.inputManager.onFactoryGridPageChange = (pageIndex) => {
      this.selectionSystem.setFactoryGridPage(pageIndex);
    };
    this.selectionSystem.setFactoryGridPage(this.inputManager.getFactoryGridPage());
    this.inputManager.onFactoryQueueModeChange = (active) => {
      this.selectionSystem.setFactoryQueueMode(active);
    };
    this.selectionSystem.setFactoryQueueMode(this.inputManager.getFactoryQueueMode());
    this.inputManager.onFactoryPresetOverlayChange = (active) => {
      this.selectionSystem.setFactoryPresetOverlayVisible(active);
    };
    this.selectionSystem.setFactoryPresetOverlayVisible(this.inputManager.getFactoryPresetOverlayVisible());
    this.inputManager.onActiveBuilderChange = (unitBlueprintId) => {
      this.selectionSystem.setActiveBuilder(unitBlueprintId);
    };
    this.selectionSystem.setActiveBuilder(this.inputManager.getActiveBuilderUnitBlueprintId());
    this.inputManager.onBuildLineSpacingChange = (spacing) => {
      this.selectionSystem.setBuildLineSpacing(spacing);
    };
    this.selectionSystem.setBuildLineSpacing(this.inputManager.getBuildLineSpacingInfo());
    this.inputManager.onBuildFacingChange = (facing) => {
      this.selectionSystem.setBuildFacing(facing);
    };
    this.selectionSystem.setBuildFacing(this.inputManager.getBuildFacingInfo());
    this.inputManager.onQueueInsertIndexChange = (index) => {
      this.selectionSystem.setQueueInsertIndex(index);
    };
    this.inputManager.onDGunModeChange = (active) => {
      this.selectionSystem.setDGunMode(active);
    };
    this.inputManager.onRepairAreaModeChange = (active) => {
      this.selectionSystem.setRepairAreaMode(active);
    };
    this.inputManager.onRestoreAreaModeChange = (active) => {
      this.selectionSystem.setRestoreAreaMode(active);
    };
    this.inputManager.onFormationAssumeModeChange = (active) => {
      this.selectionSystem.setFormationAssumeMode(active);
    };
    this.inputManager.onFormationMoveModeChange = (active) => {
      this.selectionSystem.setFormationMoveMode(active);
    };
    this.inputManager.onAttackModeChange = (active) => {
      this.selectionSystem.setAttackMode(active);
    };
    this.inputManager.onAttackAreaModeChange = (active) => {
      this.selectionSystem.setAttackAreaMode(active);
    };
    this.inputManager.onAttackGroundModeChange = (active) => {
      this.selectionSystem.setAttackGroundMode(active);
    };
    this.inputManager.onManualLaunchModeChange = (active) => {
      this.selectionSystem.setManualLaunchMode(active);
    };
    this.inputManager.onGuardModeChange = (active) => {
      this.selectionSystem.setGuardMode(active);
    };
    this.inputManager.onReclaimModeChange = (active) => {
      this.selectionSystem.setReclaimMode(active);
    };
    this.inputManager.onCaptureModeChange = (active) => {
      this.selectionSystem.setCaptureMode(active);
    };
    this.inputManager.onResurrectModeChange = (active) => {
      this.selectionSystem.setResurrectMode(active);
    };
    this.inputManager.onResurrectAreaModeChange = (active) => {
      this.selectionSystem.setResurrectAreaMode(active);
    };
    this.inputManager.onLoadTransportModeChange = (active) => {
      this.selectionSystem.setLoadTransportMode(active);
    };
    this.inputManager.onUnloadTransportModeChange = (active) => {
      this.selectionSystem.setUnloadTransportMode(active);
    };
    this.inputManager.onMexUpgradeModeChange = (active) => {
      this.selectionSystem.setMexUpgradeMode(active);
    };
    this.inputManager.onPingModeChange = (active) => {
      this.selectionSystem.setPingMode(active);
    };
    this.inputManager.onTowerTargetModeChange = (active) => {
      this.selectionSystem.setTowerTargetMode(active);
    };
    this.inputManager.onTowerTargetNoGroundModeChange = (active) => {
      this.selectionSystem.setTowerTargetNoGroundMode(active);
    };

    this.renderPhase = new RtsScene3DRenderPhase(
      this.threeApp,
      this.clientViewState,
      this.renderScope,
      this.cameraFootprintSystem,
      this.selectionSystem,
      {
        entityRenderer: this.entityRenderer,
        beamRenderer: this.beamRenderer,
        shieldRenderer: this.shieldRenderer,
        terrainTileRenderer: this.terrainTileRenderer,
        buildGhostRenderer: this.buildGhostRenderer,
        metalDepositRenderer: this.metalDepositRenderer,
        environmentPropRenderer: this.environmentPropRenderer,
        contactShadowRenderer: this.contactShadowRenderer,
        waterRenderer: this.waterRenderer,
        explosionRenderer: this.explosionRenderer,
        shieldImpactRenderer: this.shieldImpactRenderer,
        waterSplashRenderer: this.waterSplashRenderer,
        debrisRenderer: this.debrisRenderer,
        burnMarkRenderer: this.burnMarkRenderer,
        groundPrintRenderer: this.groundPrintRenderer,
        areaDragRenderer: this.areaDragRenderer,
        airLiftProbeOverlay: this.airLiftProbeOverlay,
        lineDragRenderer: this.lineDragRenderer,
        sprayRenderer: this.sprayRenderer,
        pylonTubeFlowRenderer: this.pylonTubeFlowRenderer,
        smokeTrailRenderer: this.smokeTrailRenderer,
        windParticleFieldRenderer: this.windParticleFieldRenderer,
        overlayLineSystem: this.overlayLineSystem,
        sightBoundaryRenderer: this.sightBoundaryRenderer,
        radarBoundaryRenderer: this.radarBoundaryRenderer,
        healthBar3D: this.healthBar3D,
        nameLabel3D: this.nameLabel3D,
        waypoint3D: this.waypoint3D,
      },
      () => this.localPlayerId,
      () => this.inputManager,
      (playerId) => this.lookupPlayerName(playerId),
      () => this.onCameraQuadUpdate,
    );

    // Camera clamping: keep the orbit target inside a padded map region.
    if (CAMERA_CONSTRAINTS.targetBounds === 'map-padding') {
      const paddingX = this.mapWidth * WORLD_PADDING_PERCENT;
      const paddingY = this.mapHeight * WORLD_PADDING_PERCENT;
      this.threeApp.orbit.setTargetBounds(
        -paddingX,
        -paddingY,
        this.mapWidth + paddingX,
        this.mapHeight + paddingY,
      );
    }
  }

  update(_time: number, delta: number): void {
    // A shut-down scene must never tick: the ThreeApp keeps its RAF
    // alive across scene restarts, so a stale update on torn-down
    // renderer state is reachable without this guard.
    if (this.destroyed) return;
    const frameStart = performance.now();

    this.frameTelemetry.recordRenderDelta(delta);
    if (this.clientRenderEnabled) {
      this.renderPhase?.beginEnabledFrame();
    }

    this.audioSystem.drainReady(
      this.clientRenderEnabled,
      this.handleSimEvent3DCallback,
    );

    const snapshotResult = this.snapshotIntake.consumeLatestSnapshot(
      this.clientRenderEnabled,
      this.audioSystem.snapshotAudioOptions(
        this.clientRenderEnabled,
        this.handleSimEvent3DCallback,
      ),
    );
    if (snapshotResult.appliedSnapshot) {
      if (snapshotResult.startupReleased) this.onStartupReady?.();
      if (snapshotResult.serverMeta && this.onServerMetaUpdate) {
        this.onServerMetaUpdate(snapshotResult.serverMeta);
      }
      const gamePhase = this.clientViewState.getGamePhase();
      if (gamePhase !== this.lastUiGamePhase) {
        this.lastUiGamePhase = gamePhase;
        this.onGamePhaseChange?.(gamePhase);
      }
      if (snapshotResult.gameOverWinnerId !== null && !this.isGameOver) {
        this.handleGameOver(snapshotResult.gameOverWinnerId);
      }

      this.cameraFramingSystem.centerAfterFirstSnapshot(
        this.clientViewState.getUnits(),
      );

      this.selectionSystem.markSelectionDirty();
    }

    // Process local commands — select/clearSelection apply to ClientViewState,
    // everything else gets forwarded to the server via GameConnection
    this.processLocalCommands();
    SNAPSHOT_CADENCE_REGRESSION.tickHostScenario({
      now: performance.now(),
      currentTick: this.clientViewState.getTick(),
      localPlayerId: this.localPlayerId,
      hostPlayerId: this.playerIds[0],
      mapWidth: this.mapWidth,
      mapHeight: this.mapHeight,
      backgroundMode: this.backgroundMode,
      lobbyPreview: this.lobbyPreview,
      sendCommand: (command) => this.gameConnection.sendCommand(command),
    });

    if (!this.clientRenderEnabled) {
      // Diagnostic PLAYER CLIENT OFF path. Keep snapshot intake,
      // server-meta/economy/combat-stat UI, local commands, and timing
      // instrumentation alive, but skip prediction, camera, minimap, 3D
      // entity/effect/HUD/selection-cache updates, and the WebGL draw call
      // in ThreeApp.
      this.economyUpdateTimer += delta;
      if (this.economyUpdateTimer >= this.ECONOMY_UPDATE_INTERVAL) {
        this.economyUpdateTimer = 0;
        this.updateEconomyInfo();
        this.updateIdleBuildersInfo();
      }

      this.rendererWarmup?.markClientReadyForStartupIfPossible();
      this.frameTelemetry.recordRenderDisabledFrame(frameStart);
      return;
    }

    const renderPhase = this.renderPhase;
    if (!renderPhase) return;

    this.selectionSystem.rebuildEntityCachesIfNeeded();

    const { effectDtMs } = renderPhase.beginRenderFrame();
    // Camera smoothing must step BEFORE visibility scope decisions.
    // Otherwise CPU culling, prediction cadence, and
    // rich-unit selection trail the rendered camera by one frame
    // during dolly/pan.
    this.cameraFramingSystem.tickCameraSmoothing(effectDtMs / 1000);
    const viewportHeightPx = this.threeApp.renderer.domElement.clientHeight;
    const {
      renderFrameState,
      graphicsConfig,
      predMs,
    } = this.predictionPhase.run({
      deltaMs: delta,
      camera: this.threeApp.camera,
      viewportHeightPx,
      zoom: this.cameras.main.zoom,
    });
    const renderTpsStats = this.frameTelemetry.getRenderTpsStats();
    const serverUnitCount = this.clientViewState.getServerMeta()?.units?.count;
    const budgetState = this.renderBudget.resolve({
      baseGraphicsConfig: graphicsConfig,
      unitCount: serverUnitCount ?? this.clientViewState.getUnits().length,
      renderTpsAvg: renderTpsStats.avgRate,
      renderTpsWorst: renderTpsStats.worstRate,
    });
    renderFrameState.gfx = budgetState.graphicsConfig;

    const { cameraQuad, cameraView, renderMs } = renderPhase.run({
      effectDtMs,
      graphicsConfig: budgetState.graphicsConfig,
      renderFrameState,
    });
    this.rendererWarmup?.tickStartupGate();

    // UI updates -- throttled like RtsScene. Producing-factory progress
    // invalidation lives with the rest of the 3D selection state.
    this.selectionSystem.emitSelectionInfoIfDirty(
      this.entitySourceAdapter,
      this.onSelectionChange,
    );

    this.economyUpdateTimer += delta;
    if (this.economyUpdateTimer >= this.ECONOMY_UPDATE_INTERVAL) {
      this.economyUpdateTimer = 0;
      this.updateEconomyInfo();
      this.updateIdleBuildersInfo();
    }

    this.minimapSystem.tick(
      delta,
      budgetState.graphicsConfig,
      this.entitySourceAdapter,
      cameraQuad,
      this.threeApp.orbit.yaw,
      this.threeApp.orbit.pitch,
      cameraView,
      this.onMinimapUpdate,
    );

    this.pendingFrameTelemetry = { frameStart, renderMs, predMs };
  }

  /** Called by ThreeApp immediately after the optional WebGL draw. */
  public completeFrameTelemetry(rendererRenderMs: number): void {
    const pending = this.pendingFrameTelemetry;
    this.pendingFrameTelemetry = null;
    if (!pending || this.destroyed) return;
    this.frameTelemetry.recordRenderFrame({
      ...pending,
      rendererRenderMs,
    });
  }

  private processLocalCommands(): void {
    const commands = this.localCommandQueue.getAll();
    this.localCommandQueue.clear();
    for (const command of commands) {
      const handledSelectionCommand = this.selectionSystem.handleLocalCommand(
        command,
        () => this.inputManager?.setWaypointMode('move'),
      );
      if (!handledSelectionCommand) this.sendAuthoritativeCommand(command);
    }
  }

  private submitClientCommand(command: Command): void {
    this.localCommandQueue.enqueue(command);
  }

  private sendAuthoritativeCommand(command: Command): void {
    SNAPSHOT_CADENCE_REGRESSION.recordCommandIssued(
      command,
      this.clientViewState.getTick(),
    );
    this.gameConnection.sendCommand(command);
  }

  private handleSimEvent3D(event: NetworkServerSnapshotSimEvent): void {
    if (
      event.type === 'ping' &&
      Number.isFinite(event.pos.x) &&
      Number.isFinite(event.pos.y)
    ) {
      this.lastPingPoint = { x: event.pos.x, y: event.pos.y };
    }
    if (event.entityId !== null && this.healthBar3D !== null) {
      // Self-destruct countdown blink: armed entities flash their hp
      // bar; disarm or death clears the flag.
      if (event.type === 'selfDestructArmed') {
        this.healthBar3D.setSelfDestructArmed(event.entityId, true);
      } else if (event.type === 'selfDestructDisarmed' || event.type === 'death') {
        this.healthBar3D.setSelfDestructArmed(event.entityId, false);
      }
    }
    dispatchSimEvent3DVisual(event, {
      clientViewState: this.clientViewState,
      entityRenderer: this.entityRenderer,
      explosionRenderer: this.explosionRenderer,
      shieldImpactRenderer: this.shieldImpactRenderer,
      waterSplashRenderer: this.waterSplashRenderer,
      debrisRenderer: this.debrisRenderer,
      isPositionLowLod: (simX, simY, simZ) =>
        detailRungForLevel(this.positionVisualDetailLevel(simX, simY, simZ)) ===
          DETAIL_RUNG_GLYPH,
      positionVisualDetailLevel: (simX, simY, simZ) =>
        this.positionVisualDetailLevel(simX, simY, simZ),
    });
  }

  private positionVisualDetailLevel(
    simX: number,
    simY: number,
    simZ: number,
  ): number {
    const camera = this.threeApp.camera;
    const matrix = camera.matrixWorld.elements;
    return detailLevelForViewPosition(
      {
        viewportHeightPx: Math.max(1, this.threeApp.renderer.domElement.clientHeight),
        cameraX: camera.position.x,
        cameraY: camera.position.y,
        cameraZ: camera.position.z,
        forwardX: -matrix[8],
        forwardY: -matrix[9],
        forwardZ: -matrix[10],
        fovYRad: (camera.fov * Math.PI) / 180,
      },
      simX,
      simY,
      simZ,
    );
  }

  private handleGameOver(winnerId: PlayerId): void {
    if (this.isGameOver) return;
    this.isGameOver = true;
    this.onGameOverUI?.(winnerId);
  }

  public updateSelectionInfo(): void {
    this.selectionSystem.emitSelectionInfo(
      this.entitySourceAdapter,
      this.onSelectionChange,
    );
  }

  public updateEconomyInfo(): void {
    if (!this.onEconomyChange) return;
    const serverMeta = this.clientViewState.getServerMeta();
    const maxTotal = serverMeta?.units.max ?? 120;
    const info = buildEconomyInfo(
      this.entitySourceAdapter,
      this.localPlayerId,
      Math.floor(maxTotal / this.playerIds.length),
    );
    if (info) this.onEconomyChange(info);
  }

  /** Rebuild the idle-builder chip list on the economy UI cadence and
   *  publish only when it changed since the last publish. */
  public updateIdleBuildersInfo(): void {
    if (!this.onIdleBuildersChange) return;
    const groups = buildIdleBuilderGroups(this.entitySourceAdapter, this.localPlayerId);
    let signature = '';
    for (let i = 0; i < groups.length; i++) {
      signature += `${groups[i].unitBlueprintId}:${groups[i].count};`;
    }
    if (signature === this.lastIdleBuildersSignature) return;
    this.lastIdleBuildersSignature = signature;
    this.onIdleBuildersChange(groups);
  }

  /** Hold-I stats peek target: the hovered entity (any owner, same
   *  raycastEntity-backed hover the smart cursor uses) or, when nothing
   *  is hovered, the single selected entity. Display-only. */
  public getUnitStatsInfo(): UnitStatsOverlayInfo | null {
    const hovered = this.inputManager?.getHoveredEntity() ?? null;
    if (hovered !== null) return buildUnitStatsOverlayInfo(hovered, 'hover');
    const selectedUnits = this.selectionSystem.getSelectedUnits();
    const selectedBuildings = this.selectionSystem.getSelectedBuildings();
    if (selectedUnits.length + selectedBuildings.length !== 1) return null;
    const entity = selectedUnits.length === 1 ? selectedUnits[0] : selectedBuildings[0];
    return buildUnitStatsOverlayInfo(entity, 'selection');
  }

  public updateMinimapData(): void {
    // The camera quad is already computed once per frame for the shared
    // ViewportFootprint; the minimap system consumes it without raycasting.
    this.minimapSystem.emit(
      this.entitySourceAdapter,
      this.cameraFootprintSystem.getQuad(),
      this.threeApp.orbit.yaw,
      this.threeApp.orbit.pitch,
      this.renderPhase?.getCameraViewBasis(),
      this.onMinimapUpdate,
    );
  }

  // ── Public methods matching RtsScene's surface ──

  public restartGame(): void {
    this.isGameOver = false;
    this.onGameRestart?.();
    this.scene.restart();
  }

  public switchPlayer(playerId: PlayerId): void {
    this.localPlayerId = playerId;
    this.inputManager?.setActivePlayerId(playerId);
    // Tell the connection to filter snapshots for the new player. On
    // local connections this re-binds the server-side listener so the
    // client view state, minimap, and fog-of-war visuals pick up the
    // new player's vision sources on the next snapshot. Remote
    // connections don't expose this — the network recipient is fixed.
    this.gameConnection.setRecipientPlayerId?.(playerId);
    this.markSelectionDirty();
    // Force a fresh idle-builders publish for the new seat.
    this.lastIdleBuildersSignature = '';
    this.onPlayerChange?.(playerId);
  }

  private arePlayersAlliedForInput(a: PlayerId, b: PlayerId): boolean {
    if (a === b) return true;
    if (a !== this.localPlayerId && b !== this.localPlayerId) return false;
    const other = a === this.localPlayerId ? b : a;
    return this.clientViewState.getVisionPlayerIds(this.localPlayerId).includes(other);
  }

  public togglePlayer(): void {
    const currentIndex = this.playerIds.indexOf(this.localPlayerId);
    const nextIndex = (currentIndex + 1) % this.playerIds.length;
    this.switchPlayer(this.playerIds[nextIndex]);
  }

  public getActivePlayer(): PlayerId {
    return this.localPlayerId;
  }

  /** The OrbitCamera instance driving the rendered camera. Exposed
   *  for read-only consumers (e.g. CameraTutorial) that need to
   *  watch yaw / target / distance for input-detection — keeps
   *  ThreeApp itself private to the scene. */
  public getOrbitCamera(): import('../render3d/OrbitCamera').OrbitCamera {
    return this.cameraControl.getOrbitCamera();
  }

  /**
   * Actual rendered-camera pose, in Three world coordinates.  This is
   * intentionally the eye and forward vector after OrbitCamera.apply(), not
   * its target / requested orbit state, so camera diagnostics expose exactly
   * what the renderer is drawing from.
   */
  public getCameraDebugPose(): {
    readonly positionX: number;
    readonly positionY: number;
    readonly positionZ: number;
    readonly directionX: number;
    readonly directionY: number;
    readonly directionZ: number;
  } {
    const camera = this.threeApp.camera;
    // lookAt() updates the camera quaternion immediately; ensure matrixWorld
    // reflects it too before extracting Three's normalized -Z forward axis.
    camera.updateWorldMatrix(true, false);
    const worldMatrix = camera.matrixWorld.elements;
    return {
      positionX: camera.position.x,
      positionY: camera.position.y,
      positionZ: camera.position.z,
      directionX: -worldMatrix[8],
      directionY: -worldMatrix[9],
      directionZ: -worldMatrix[10],
    };
  }

  public markSelectionDirty(): void {
    this.selectionSystem.markSelectionDirty();
  }

  public setWaypointMode(mode: WaypointType): void {
    this.selectionSystem.setWaypointMode(mode);
    this.inputManager?.setWaypointMode(mode);
  }

  public stopSelectedUnits(): void {
    this.inputManager?.stopSelectedUnits();
  }

  public skipCurrentOrder(): void {
    this.inputManager?.skipCurrentOrder();
  }

  public clearQueuedOrders(): void {
    this.inputManager?.clearQueuedOrders();
  }

  public removeLastQueuedOrder(): void {
    this.inputManager?.removeLastQueuedOrder();
  }

  public setQueueInsertIndex(index: number | null): void {
    this.inputManager?.setQueueInsertIndex(index);
  }

  public toggleSelectedWait(queue = false, queueFront = false, queueInsertIndex?: number): void {
    this.inputManager?.toggleSelectedWait(queue, queueFront, queueInsertIndex);
  }

  public toggleSelectedGatherWait(queue = false, queueFront = false, queueInsertIndex?: number): void {
    this.inputManager?.toggleSelectedGatherWait(queue, queueFront, queueInsertIndex);
  }

  public toggleRepeatQueue(): void {
    this.inputManager?.toggleRepeatQueue();
  }

  public toggleBuilderPriority(): void {
    this.inputManager?.toggleBuilderPriority();
  }

  public toggleCarrierSpawn(): void {
    this.inputManager?.toggleCarrierSpawn();
  }

  public toggleUnitMoveState(): void {
    this.inputManager?.toggleUnitMoveState();
  }

  public setUnitMoveState(moveState: UnitMoveState): void {
    this.inputManager?.setUnitMoveState(moveState);
  }

  public toggleTrajectoryMode(): void {
    this.inputManager?.toggleTrajectoryMode();
  }

  public toggleCloakState(): void {
    this.inputManager?.toggleCloakState();
  }

  public toggleSelectedFire(): void {
    this.inputManager?.toggleSelectedFire();
  }

  public setSelectedFireState(fireState: CombatFireState): void {
    this.inputManager?.setSelectedFireState(fireState);
  }

  public toggleBuildingActive(): void {
    this.inputManager?.toggleBuildingActive();
  }

  public selfDestructSelected(queue = false, queueFront = false, queueInsertIndex?: number): void {
    this.inputManager?.selfDestructSelected(queue, queueFront, queueInsertIndex);
  }

  public selectOnlyEntityType(entityType: 'unit' | 'tower' | 'building'): void {
    this.inputManager?.selectOnlyEntityType(entityType);
  }

  public selectAllOwnedUnits(): void {
    this.inputManager?.selectAllOwnedUnits();
  }

  public selectAllMatching(): void {
    this.inputManager?.selectAllMatching();
  }

  public selectAllMatchingInView(): void {
    this.inputManager?.selectAllMatchingInView();
  }

  public selectPreviousSelection(): void {
    this.inputManager?.selectPreviousSelection();
  }

  public selectIdleBuilders(): void {
    this.inputManager?.selectIdleBuilders();
  }

  /** Idle-builders panel left-click: select the next idle builder of the
   *  chip's type and center the camera on it. */
  public cycleIdleBuilder(unitBlueprintId: string): void {
    const builder = this.inputManager?.cycleIdleBuilderSelection(unitBlueprintId) ?? null;
    if (builder !== null) this.cameraControl.centerOn(builder.transform.x, builder.transform.y);
  }

  /** Idle-builders panel Shift+click: add all idle builders of the
   *  chip's type to the current selection. */
  public addIdleBuildersToSelection(unitBlueprintId: string): void {
    this.inputManager?.addIdleBuildersToSelection(unitBlueprintId);
  }

  /** Idle-builders panel right-click: center the camera on the next idle
   *  builder of the chip's type without changing the selection. */
  public focusIdleBuilder(unitBlueprintId: string): void {
    const builder = this.inputManager?.nextIdleBuilder(unitBlueprintId) ?? null;
    if (builder !== null) this.cameraControl.centerOn(builder.transform.x, builder.transform.y);
  }

  public selectIdleTransports(): void {
    this.inputManager?.selectIdleTransports();
  }

  public selectWaitingUnits(): void {
    this.inputManager?.selectWaitingUnits();
  }

  public selectSameTypeOnly(): void {
    this.inputManager?.selectSameTypeOnly();
  }

  public selectMobileOnly(): void {
    this.inputManager?.selectMobileOnly();
  }

  public invertSelection(): void {
    this.inputManager?.invertSelection();
  }

  public splitArmySelection(): void {
    this.inputManager?.splitArmySelection();
  }

  public loopSelection(): void {
    this.inputManager?.loopSelection();
  }

  public toggleTowerTargetMode(): void {
    this.inputManager?.toggleTowerTargetMode();
  }

  public toggleTowerTargetNoGroundMode(): void {
    this.inputManager?.toggleTowerTargetNoGroundMode();
  }

  public clearTowerTarget(): void {
    this.inputManager?.clearTowerTarget();
  }

  public toggleAttackMode(): void {
    this.inputManager?.toggleAttackMode();
  }

  public toggleAttackAreaMode(): void {
    this.inputManager?.toggleAttackAreaMode();
  }

  public toggleAttackGroundMode(): void {
    this.inputManager?.toggleAttackGroundMode();
  }

  public toggleManualLaunchMode(): void {
    this.inputManager?.toggleManualLaunchMode();
  }

  public toggleGuardMode(): void {
    this.inputManager?.toggleGuardMode();
  }

  public toggleReclaimMode(): void {
    this.inputManager?.toggleReclaimMode();
  }

  public toggleCaptureMode(): void {
    this.inputManager?.toggleCaptureMode();
  }

  public toggleResurrectMode(): void {
    this.inputManager?.toggleResurrectMode();
  }

  public toggleResurrectAreaMode(): void {
    this.inputManager?.toggleResurrectAreaMode();
  }

  public toggleLoadTransportMode(): void {
    this.inputManager?.toggleLoadTransportMode();
  }

  public toggleUnloadTransportMode(): void {
    this.inputManager?.toggleUnloadTransportMode();
  }

  public reclaimSelected(): void {
    this.inputManager?.reclaimSelected();
  }

  public toggleMexUpgradeMode(): void {
    this.inputManager?.toggleMexUpgradeMode();
  }

  public upgradeSelectedMetalExtractors(): void {
    this.inputManager?.upgradeSelectedMetalExtractors();
  }

  public togglePingMode(): void {
    this.inputManager?.togglePingMode();
  }

  public storeControlGroup(index: number): void {
    this.inputManager?.storeControlGroupSlot(index);
  }

  public recallControlGroup(index: number, additive: boolean): void {
    this.inputManager?.recallControlGroupSlot(index, additive);
  }

  /** Enter build mode — forwards to Input3DManager which handles the
   *  left-click-places-building / right-click-cancels flow. */
  public startBuildMode(buildingBlueprintId: BuildingBlueprintId): void {
    this.inputManager?.setBuildMode(buildingBlueprintId);
  }

  public cancelBuildMode(): void {
    this.inputManager?.cancelBuildMode();
  }

  public setActiveBuilder(unitBlueprintId: string): void {
    this.inputManager?.setActiveBuilderUnitBlueprintId(unitBlueprintId);
  }

  public cycleActiveBuilder(): void {
    this.inputManager?.cycleActiveBuilder();
  }

  public setBuildGridCategory(categoryId: BarBuildCategoryId | null): void {
    this.inputManager?.setBuildGridCategory(categoryId);
  }

  public stepBuildGridPage(delta: number): void {
    this.inputManager?.stepBuildGridPage(delta);
  }

  public stepFactoryGridPage(delta: number): void {
    this.inputManager?.stepFactoryGridPage(delta);
  }

  public toggleFactoryQueueMode(): void {
    this.inputManager?.toggleFactoryQueueMode();
  }

  public increaseBuildLineSpacing(): void {
    this.inputManager?.increaseBuildLineSpacing();
  }

  public decreaseBuildLineSpacing(): void {
    this.inputManager?.decreaseBuildLineSpacing();
  }

  public rotateBuildFacingClockwise(): void {
    this.inputManager?.rotateBuildFacingClockwise();
  }

  public rotateBuildFacingCounterClockwise(): void {
    this.inputManager?.rotateBuildFacingCounterClockwise();
  }

  public toggleDGunMode(): void {
    this.inputManager?.toggleDGunMode();
  }

  public toggleRepairAreaMode(): void {
    this.inputManager?.toggleRepairAreaMode();
  }

  public toggleRestoreAreaMode(): void {
    this.inputManager?.toggleRestoreAreaMode();
  }

  public toggleFormationMoveMode(): void {
    this.inputManager?.toggleFormationMoveMode();
  }

  public toggleFormationAssumeMode(): void {
    this.inputManager?.toggleFormationAssumeMode();
  }

  public queueFactoryUnit(factoryId: number, unitBlueprintId: string, repeat = false, count = 1): void {
    this.submitClientCommand({
      type: 'queueUnit',
      tick: this.clientViewState.getTick(),
      factoryId,
      unitBlueprintId,
      repeat,
      count,
    });
  }

  public removeFactoryUnitProduction(factoryId: number, unitBlueprintId: string, count = 1): void {
    this.submitClientCommand({
      type: 'removeFactoryUnitProduction',
      tick: this.clientViewState.getTick(),
      factoryId,
      unitBlueprintId,
      count,
    });
  }

  public setFactoryRepeatProduction(factoryId: number, enabled: boolean): void {
    this.submitClientCommand({
      type: 'setFactoryRepeatProduction',
      tick: this.clientViewState.getTick(),
      factoryId,
      enabled,
    });
  }

  public setFactoryAirIdleState(factoryId: number, airIdleState: UnitAirIdleState): void {
    this.submitClientCommand({
      type: 'setFactoryAirIdleState',
      tick: this.clientViewState.getTick(),
      factoryId,
      airIdleState,
    });
  }

  public changeFactoryUnitQuota(factoryId: number, unitBlueprintId: string, delta: number): void {
    this.submitClientCommand({
      type: 'changeFactoryUnitQuota',
      tick: this.clientViewState.getTick(),
      factoryId,
      unitBlueprintId,
      delta,
    });
  }

  public editFactoryQueue(
    factoryId: number,
    operation: 'remove' | 'move' | 'setCount',
    index: number,
    length = 1,
    toIndex?: number,
    count?: number,
  ): void {
    this.submitClientCommand({
      type: 'editFactoryQueue',
      tick: this.clientViewState.getTick(),
      factoryId,
      operation,
      index,
      length,
      toIndex,
      count,
    });
  }

  public stopFactoryProduction(factoryId: number): void {
    this.submitClientCommand({
      type: 'stopFactoryProduction',
      tick: this.clientViewState.getTick(),
      factoryId,
    });
  }

  public clearFactoryGuard(factoryId: number): void {
    this.submitClientCommand({
      type: 'setFactoryGuard',
      tick: this.clientViewState.getTick(),
      factoryId,
      targetId: null,
    });
  }

  public toggleFactoryGuard(factoryId: number): void {
    const factory = this.clientViewState.getEntity(factoryId);
    this.submitClientCommand({
      type: 'setFactoryGuard',
      tick: this.clientViewState.getTick(),
      factoryId,
      targetId: factory?.factory?.guardTargetId === factoryId ? null : factoryId,
    });
  }

  public centerCameraOn(x: number, y: number): void {
    this.cameraControl.centerOn(x, y);
  }

  /** Minimap right-click: dispatch the standard right-click command
   *  (repair → attack-at-point → move / factory rally) at a minimap
   *  world point for the current selection. BAR convention: left
   *  minimap click moves the camera, right minimap click commands. */
  public issueMinimapCommand(x: number, y: number, queue: boolean): void {
    if (this.inputManager === null) return;
    this.inputManager.issueMinimapWorldCommand(x, y, queue);
  }

  public goToLastPing(): void {
    if (this.lastPingPoint === null) return;
    this.cameraControl.centerOn(this.lastPingPoint.x, this.lastPingPoint.y);
  }

  public flipCameraYaw(): void {
    this.cameraControl.flipYaw();
  }

  public showMapOverview(): void {
    const centerX = this.mapWidth / 2;
    const centerY = this.mapHeight / 2;
    this.cameraControl.showMapOverview(
      this.mapWidth,
      this.mapHeight,
      getSurfaceHeight(centerX, centerY, this.mapWidth, this.mapHeight, LAND_CELL_SIZE),
    );
  }

  public setCameraViewMode(mode: CameraViewMode): void {
    this.cameraControl.setViewMode(mode);
  }

  public toggleCameraViewMode(): void {
    this.cameraControl.toggleViewMode();
  }

  public changeCameraViewRadius(direction: 1 | -1): void {
    this.cameraControl.changeViewRadius(direction);
  }

  public setCameraAnchor(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.cameraAnchors.length) return;
    this.cameraAnchors[index] = this.captureCameraState();
  }

  public focusCameraAnchor(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.cameraAnchors.length) return;
    const anchor = this.cameraAnchors[index];
    if (anchor === null) return;
    this.applyCameraState(anchor);
  }

  /** Capture the orbit camera's current framing in the portable
   *  `SceneCameraState` shape — 2D-equivalent zoom + the (x, y)
   *  world-space target point. */
  public captureCameraState(): SceneCameraState {
    return this.cameraControl.captureState();
  }

  /** Apply a captured camera state. Works with states captured from
   *  either renderer — the zoom scalar is in 2D-equivalent units and
   *  maps back to an orbit distance via the scene's base distance. */
  public applyCameraState(state: SceneCameraState): void {
    this.cameraControl.applyState(state);
  }

  public getFrameTiming(): RtsScene3DFrameTiming {
    const renderRuntime = this.threeApp.getRenderRuntimeTelemetry();
    const webglProfile = this.threeApp.getWebGlFrameProfile();
    const renderBudget = this.renderBudget.getTelemetry();
    const renderPhaseTimings = this.renderPhase?.getLastPhaseTimings();
    return this.frameTelemetry.getFrameTiming({
      gpuTimerMs: this.clientRenderEnabled ? this.threeApp.gpuTimer.getGpuMs() : 0,
      gpuTimerSupported: this.threeApp.gpuTimer.isSupported(),
      runtimeProfile: renderRuntime.runtimeProfile,
      nativePixelRatio: renderRuntime.nativePixelRatio,
      activePixelRatio: renderRuntime.activePixelRatio,
      dynamicPixelRatioEnabled: renderRuntime.dynamicPixelRatioEnabled,
      webglBufferProfilerSupported: webglProfile.bufferProfilerSupported,
      webglRendererRenderMs: webglProfile.rendererRenderMs,
      webglDrawCalls: webglProfile.drawCalls,
      webglTriangles: webglProfile.triangles,
      webglPoints: webglProfile.points,
      webglLines: webglProfile.lines,
      webglGeometries: webglProfile.geometries,
      webglTextures: webglProfile.textures,
      webglBufferDataCalls: webglProfile.bufferDataCalls,
      webglBufferSubDataCalls: webglProfile.bufferSubDataCalls,
      webglBufferUploadBytes: webglProfile.bufferUploadBytes,
      renderBudgetTier: renderBudget.tier,
      renderBudgetTierIndex: renderBudget.tierIndex,
      renderBudgetUnitCount: renderBudget.unitCount,
      renderBudgetHudFrameStride: renderBudget.hudFrameStride,
      renderBudgetEffectFrameStride: renderBudget.effectFrameStride,
      renderPhaseScopeMs: renderPhaseTimings?.scopeMs ?? 0,
      renderPhaseProjectileQueryMs: renderPhaseTimings?.projectileQueryMs ?? 0,
      renderPhaseEntityPacketMs: renderPhaseTimings?.entityPacketMs ?? 0,
      renderPhaseEntityRendererMs: renderPhaseTimings?.entityRendererMs ?? 0,
      renderPhaseTerrainMs: renderPhaseTimings?.terrainMs ?? 0,
      renderPhaseBeamMs: renderPhaseTimings?.beamMs ?? 0,
      renderPhaseEffectsMs: renderPhaseTimings?.effectsMs ?? 0,
      renderPhaseHudMs: renderPhaseTimings?.hudMs ?? 0,
      renderPhaseUnitRows: renderPhaseTimings?.unitRows ?? 0,
      renderPhaseBuildingRows: renderPhaseTimings?.buildingRows ?? 0,
      renderPhaseUnitLodProxyRows: renderPhaseTimings?.unitLodProxyRows ?? 0,
      renderPhaseBuildingLodProxyRows: renderPhaseTimings?.buildingLodProxyRows ?? 0,
      renderPhaseProjectileRows: renderPhaseTimings?.projectileRows ?? 0,
      renderPhaseLineProjectileRows: renderPhaseTimings?.lineProjectileRows ?? 0,
    });
  }

  public getRenderTpsStats(): { avgRate: number; worstRate: number } {
    return this.frameTelemetry.getRenderTpsStats();
  }

  public getHudSpriteTelemetry(): HudSpriteTelemetry {
    return buildHudSpriteTelemetry([
      this.healthBar3D?.getSpritePoolTelemetry(),
      this.nameLabel3D?.getSpritePoolTelemetry(),
      this.waypoint3D?.getSpritePoolTelemetry(),
    ]);
  }

  public getScopedMeshRetentionTelemetry(): ScopedRenderMeshRetentionTelemetry {
    return this.entityRenderer.getScopedMeshRetentionTelemetry();
  }

  public getSnapshotStats(): RtsScene3DSnapshotRateStats {
    return this.snapshotIntake.getSnapshotStats();
  }

  public getSnapshotCounters(): RtsScene3DSnapshotCounters {
    return this.snapshotIntake.getSnapshotCounters();
  }

  public getReceivedSnapshotCounters(): RtsScene3DSnapshotCounters {
    return this.snapshotIntake.getReceivedSnapshotCounters();
  }

  public getSnapshotPayloadSizeStats(): RtsScene3DSnapshotPayloadSizeStats {
    return this.snapshotIntake.getSnapshotPayloadSizeStats();
  }

  public getSnapshotApplyStats(): RtsScene3DSnapshotApplyStats {
    return this.snapshotIntake.getSnapshotApplyStats();
  }

  public drainSnapshotMaterializationMetadata(out: SnapshotMaterializationMetadata[]): void {
    this.snapshotIntake.drainSnapshotMaterializationMetadata(out);
  }

  /**
   * Tear down the scene. By default disconnects the GameConnection;
   * passing `{ keepConnection: true }` skips the disconnect so a live
   * renderer swap can reuse the same connection across the new scene.
   */
  public shutdown(opts: { keepConnection?: boolean } = {}): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.rendererWarmup?.shutdown();
    teardownRtsScene3DRenderers({
      inputManager: this.inputManager,
      healthBar3D: this.healthBar3D,
      nameLabel3D: this.nameLabel3D,
      waypoint3D: this.waypoint3D,
      entityRenderer: this.entityRenderer,
      metalDepositRenderer: this.metalDepositRenderer,
      environmentPropRenderer: this.environmentPropRenderer,
      contactShadowRenderer: this.contactShadowRenderer,
      beamRenderer: this.beamRenderer,
      shieldRenderer: this.shieldRenderer,
      terrainTileRenderer: this.terrainTileRenderer,
      waterRenderer: this.waterRenderer,
      explosionRenderer: this.explosionRenderer,
      shieldImpactRenderer: this.shieldImpactRenderer,
      waterSplashRenderer: this.waterSplashRenderer,
      debrisRenderer: this.debrisRenderer,
      burnMarkRenderer: this.burnMarkRenderer,
      groundPrintRenderer: this.groundPrintRenderer,
      areaDragRenderer: this.areaDragRenderer,
      airLiftProbeOverlay: this.airLiftProbeOverlay,
      lineDragRenderer: this.lineDragRenderer,
      buildGhostRenderer: this.buildGhostRenderer,
      sprayRenderer: this.sprayRenderer,
      pylonTubeFlowRenderer: this.pylonTubeFlowRenderer,
      smokeTrailRenderer: this.smokeTrailRenderer,
      windParticleFieldRenderer: this.windParticleFieldRenderer,
      sightBoundaryRenderer: this.sightBoundaryRenderer,
      radarBoundaryRenderer: this.radarBoundaryRenderer,
      overlayLineSystem: this.overlayLineSystem,
      cursorGround: this.cursorGround,
      longtaskTracker: this.frameTelemetry,
      audioSystem: this.audioSystem,
    });
    this.inputManager = null;
    this.healthBar3D = null;
    this.nameLabel3D = null;
    this.waypoint3D = null;
    this.metalDepositRenderer = null;
    this.environmentPropRenderer = null;
    this.contactShadowRenderer = null;
    this.renderPhase = null;
    this.rendererWarmup = null;
    if (!opts.keepConnection) {
      this.gameConnection?.disconnect();
    }
    this.snapshotIntake.clear();
    this.localCommandQueue.clear();
    this.onPlayerChange = undefined;
    this.onSelectionChange = undefined;
    this.onEconomyChange = undefined;
    this.onMinimapUpdate = undefined;
    this.onCameraQuadUpdate = undefined;
    this.onGameOverUI = undefined;
    this.onGameRestart = undefined;
    this.onServerMetaUpdate = undefined;
    this.onGamePhaseChange = undefined;
    this.onStartupReady = undefined;
    this.onRendererWarmupChange = undefined;
  }
}
