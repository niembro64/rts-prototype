// RtsScene3D — 3D equivalent of RtsScene.
//
// Implements the same public API surface (callbacks + methods) so PhaserCanvas.vue
// can drive it interchangeably with the 2D scene. Internally it uses ThreeApp and
// Render3DEntities instead of Pixi graphics while delegating focused input/view
// state to helpers.

import type { ClientViewState } from '../network/ClientViewState';
import { audioManager } from '../audio/AudioManager';
import type { SceneCameraState } from '@/types/game';
import { isShotId, isTurretId, isUnitTypeId } from '@/types/blueprintIds';
import type { TerrainMapShape, TerrainShape } from '@/types/terrain';
import { RtsScene3DSnapshotIntake } from './helpers/RtsScene3DSnapshotIntake';
import { buildEconomyInfo } from './helpers';
import type { EconomyInfo, MinimapData, SelectionInfo } from './helpers';
import { EmaTracker } from './helpers/EmaTracker';
import { EmaMsTracker } from './helpers/EmaMsTracker';
import { LongtaskTracker } from './helpers/LongtaskTracker';
import { RtsScene3DCameraControl, type CameraShim } from './helpers/RtsScene3DCameraControl';
import { RtsScene3DCameraFootprintSystem } from './helpers/RtsScene3DCameraFootprintSystem';
import { RtsScene3DCameraFramingSystem } from './helpers/RtsScene3DCameraFramingSystem';
import { RtsScene3DMinimapSystem } from './helpers/RtsScene3DMinimapSystem';
import { RtsScene3DRenderPhase } from './helpers/RtsScene3DRenderPhase';
import { teardownRtsScene3DRenderers } from './helpers/RtsScene3DRendererLifecycle';
import { RtsScene3DSelectionSystem } from './helpers/RtsScene3DSelectionSystem';
import { ThreeApp } from '../render3d/ThreeApp';
import { Render3DEntities } from '../render3d/Render3DEntities';
import { Input3DManager } from '../render3d/Input3DManager';
import { BeamRenderer3D } from '../render3d/BeamRenderer3D';
import { ForceFieldRenderer3D } from '../render3d/ForceFieldRenderer3D';
import { CaptureTileRenderer3D } from '../render3d/CaptureTileRenderer3D';
import { MetalDepositRenderer3D } from '../render3d/MetalDepositRenderer3D';
import { EnvironmentPropRenderer3D } from '../render3d/EnvironmentPropRenderer3D';
import { generateMetalDeposits, type MetalDeposit } from '../../metalDepositConfig';
import { WaterRenderer3D } from '../render3d/WaterRenderer3D';
import { CursorGround } from '../render3d/CursorGround';
import { LegInstancedRenderer } from '../render3d/LegInstancedRenderer';
import { LodShellGround3D } from '../render3d/LodShellGround3D';
import { LodGridCells2D } from '../render3d/LodGridCells2D';
import {
  getRenderObjectLodShellDistances,
  objectLodToGraphicsTier,
  resolveRenderObjectLodForDistanceSq,
} from '../render3d/RenderObjectLod';

/** Same color the per-mesh leg path used. Single uniform value
 *  across the whole shared pool — legs aren't team-tinted. */
const LEG_COLOR = 0x2a2f36;
import { ViewportFootprint } from '../ViewportFootprint';
import { SprayRenderer3D } from '../render3d/SprayRenderer3D';
import { SmokeTrail3D } from '../render3d/SmokeTrail3D';
import { FogOfWarShroudRenderer3D } from '../render3d/FogOfWarShroudRenderer3D';
import { Explosion3D } from '../render3d/Explosion3D';
import { ForceFieldImpactRenderer3D } from '../render3d/ForceFieldImpactRenderer3D';
import { Debris3D } from '../render3d/Debris3D';
import { BurnMark3D } from '../render3d/BurnMark3D';
import { GroundPrint3D } from '../render3d/GroundPrint3D';
import { LineDrag3D } from '../render3d/LineDrag3D';
import { PingRenderer3D } from '../render3d/PingRenderer3D';
import { BuildGhost3D } from '../render3d/BuildGhost3D';
import { ContactShadowRenderer3D } from '../render3d/ContactShadowRenderer3D';
import { RtsScene3DAudioSystem } from './helpers/RtsScene3DAudioSystem';
import { RtsScene3DPredictionPhase } from './helpers/RtsScene3DPredictionPhase';
import type { NetworkServerSnapshotSimEvent } from '../network/NetworkTypes';
import {
  getGraphicsConfig,
  getGraphicsConfigFor,
} from '@/clientBarConfig';
import { CommandQueue } from '../sim/commands';
import { getTerrainDividerTeamCount } from '../sim/playerLayout';
import {
  getTerrainMeshHeight,
  getSurfaceHeight,
  setTerrainTeamCount,
  setTerrainCenterShape,
  setTerrainDividersShape,
  setTerrainMapShape,
  setMetalDepositFlatZones,
} from '../sim/Terrain';
import {
  normalizeLodCellSize,
} from '../lodGridMath';
import { landCellCenterForSize, landCellIndexForSize } from '../landGrid';
import { HealthBar3D } from '../render3d/HealthBar3D';
import { NameLabel3D } from '../render3d/NameLabel3D';
import { Waypoint3D } from '../render3d/Waypoint3D';
import { getUnitBodyCenterHeight, getUnitGroundZ } from '../sim/unitGeometry';

import type { GameConnection } from '../server/GameConnection';
import type { GraphicsConfig } from '@/types/graphics';
import type {
  NetworkServerSnapshotMeta,
} from '../network/NetworkTypes';
import { getPlayerPrimaryColor, setPlayerCountForColors } from '../sim/types';
import type {
  Entity,
  EntityId,
  PlayerId,
  WaypointType,
  BuildingType,
} from '../sim/types';

import {
  EMA_CONFIG,
  FRAME_TIMING_EMA,
  EMA_INITIAL_VALUES,
  WORLD_PADDING_PERCENT,
  LAND_CELL_SIZE,
} from '../../config';

export type RtsScene3DConfig = {
  playerIds: PlayerId[];
  localPlayerId: PlayerId;
  gameConnection: GameConnection;
  /** Hoisted up to GameCanvas so state survives a live 2D↔3D renderer
   *  swap without waiting for the next keyframe. If the old scene's
   *  CVS is already populated, the new scene inherits all units,
   *  buildings, projectiles, selection, prediction, etc. with zero
   *  delay. On first boot GameCanvas creates a fresh one. */
  clientViewState: ClientViewState;
  mapWidth: number;
  mapHeight: number;
  terrainCenter?: TerrainShape;
  terrainDividers?: TerrainShape;
  terrainMapShape?: TerrainMapShape;
  backgroundMode: boolean;
  /** GAME LOBBY preview pane — uses the dedicated wider zoom and
   *  expects the GameServer to have spawned commanders only (no
   *  AI, no buildings, no background units). Set by the lobby
   *  preview path; everywhere else this stays false. */
  lobbyPreview?: boolean;
  /** Resolves a player ID to its display name. Powered by the host
   *  app's lobby roster; the scene uses it to label commanders via
   *  NameLabel3D. Null result → fall back to the deterministic
   *  funny-name default. Optional for back-compat with callers that
   *  don't yet pass it (lobby preview, demo standalones). */
  lookupPlayerName?: (playerId: PlayerId) => string | null;
  onRendererWarmupChange?: (warming: boolean) => void;
};

type SceneLifecycle = {
  onRestart(cb: () => void): void;
  restart(): void;
};

export class RtsScene3D {
  private threeApp: ThreeApp;

  private clientViewState!: ClientViewState;
  private entityRenderer!: Render3DEntities;
  /** Shared instanced cylinder pool driving every leg in the scene.
   *  Owned at the scene level so its lifetime brackets the entity
   *  renderer's; passed in by reference. */
  private legInstancedRenderer!: LegInstancedRenderer;
  private beamRenderer!: BeamRenderer3D;
  private forceFieldRenderer!: ForceFieldRenderer3D;
  private captureTileRenderer!: CaptureTileRenderer3D;
  private metalDeposits: MetalDeposit[] = [];
  private metalDepositRenderer: MetalDepositRenderer3D | null = null;
  private environmentPropRenderer: EnvironmentPropRenderer3D | null = null;
  private waterRenderer!: WaterRenderer3D;
  private explosionRenderer!: Explosion3D;
  private forceFieldImpactRenderer!: ForceFieldImpactRenderer3D;
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
  private lineDragRenderer!: LineDrag3D;
  private pingRenderer!: PingRenderer3D;
  private buildGhostRenderer!: BuildGhost3D;
  private sprayRenderer!: SprayRenderer3D;
  private smokeTrailRenderer!: SmokeTrail3D;
  private fogOfWarShroudRenderer!: FogOfWarShroudRenderer3D;
  private audioSystem = new RtsScene3DAudioSystem();
  private inputManager: Input3DManager | null = null;
  private gameConnection!: GameConnection;
  private snapshotIntake!: RtsScene3DSnapshotIntake;
  private localCommandQueue = new CommandQueue();
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
   *  RtsScene3DConfig.lookupPlayerName; null result falls back to
   *  `getDefaultPlayerName(playerId)` so commander labels still
   *  render with a stable funny default in single-player / demo /
   *  lobby-preview contexts that don't have a roster wired up. */
  private lookupPlayerName: (id: PlayerId) => string | null = () => null;
  private waypoint3D: Waypoint3D | null = null;
  private lodShellGround3D: LodShellGround3D | null = null;
  private lodGridCells2D: LodGridCells2D | null = null;

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
  private terrainCenter: TerrainShape;
  private terrainDividers: TerrainShape;
  private terrainMapShape: TerrainMapShape;
  private backgroundMode: boolean;
  private lobbyPreview: boolean;

  private isGameOver = false;

  // Performance trackers (mirror RtsScene)
  private renderTpsTracker = new EmaTracker(EMA_CONFIG.tps, EMA_INITIAL_VALUES.tps);
  private frameMsTracker = new EmaMsTracker(FRAME_TIMING_EMA.frameMs, EMA_INITIAL_VALUES.frameMs);
  private renderMsTracker = new EmaMsTracker(FRAME_TIMING_EMA.renderMs, EMA_INITIAL_VALUES.renderMs);
  private logicMsTracker = new EmaMsTracker(FRAME_TIMING_EMA.logicMs, EMA_INITIAL_VALUES.logicMs);
  private predMsTracker = new EmaMsTracker(FRAME_TIMING_EMA.predMs, EMA_INITIAL_VALUES.predMs);
  private longtaskTracker = new LongtaskTracker();

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
    getEntitySetVersion: () => number;
    getTerrainBuildabilityGrid: () => ReturnType<ClientViewState['getTerrainBuildabilityGrid']>;
  };
  private clientRenderEnabled = true;

  // ── Callback interface matching RtsScene ──
  public onPlayerChange?: (playerId: PlayerId) => void;
  public onSelectionChange?: (info: SelectionInfo) => void;
  public onEconomyChange?: (info: EconomyInfo) => void;
  public onMinimapUpdate?: (data: MinimapData) => void;
  /** Separate per-frame callback for just the camera footprint quad.
   *  Decoupling this from `onMinimapUpdate` keeps the box animation
   *  smooth even when entity rebuilding is throttled to 20 Hz. */
  public onCameraQuadUpdate?: (
    quad: import('../ViewportFootprint').FootprintQuad,
    cameraYaw: number,
  ) => void;
  public onGameOverUI?: (winnerId: PlayerId) => void;
  public onGameRestart?: () => void;
  public onServerMetaUpdate?: (meta: NetworkServerSnapshotMeta) => void;
  public onStartupReady?: () => void;
  public onRendererWarmupChange?: (warming: boolean) => void;
  private rendererWarmupStarted = false;
  private rendererWarmupActive = false;
  private rendererWarmupToken = 0;
  private destroyed = false;

  // Phaser-compat accessors used by PhaserCanvas.vue
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
    this.terrainCenter = config.terrainCenter ?? 'valley';
    this.terrainDividers = config.terrainDividers ?? 'valley';
    this.terrainMapShape = config.terrainMapShape ?? 'circle';
    // Pin the color wheel to the lobby's player count. Player ids map
    // directly to color slots, so every browser sees the same colors.
    setPlayerCountForColors(this.playerIds.length);
    // Also seed the heightmap's divider count from the same source.
    // The same radial-slice math is used for every player count,
    // including one-player maps. The host's GameServer sets this too,
    // but remote clients only construct the renderer.
    setTerrainTeamCount(getTerrainDividerTeamCount(this.playerIds.length));
    setTerrainCenterShape(this.terrainCenter);
    setTerrainDividersShape(this.terrainDividers);
    setTerrainMapShape(this.terrainMapShape);
    this.mapWidth = config.mapWidth;
    this.mapHeight = config.mapHeight;
    this.backgroundMode = config.backgroundMode;

    // Metal deposits are deterministic from map size + player count,
    // so the client re-derives the same list and pushes flat zones to
    // its local Terrain module. The server already does this in its
    // own GameServer constructor; we mirror it here so the client's
    // baked terrain mesh matches the server's heightmap. Captured for
    // rendering further down so the marker pass uses the same list.
    const metalDeposits = generateMetalDeposits(
      this.mapWidth,
      this.mapHeight,
      this.playerIds.length,
      this.terrainCenter,
    );
    setMetalDepositFlatZones(
      metalDeposits.map((d) => ({
        x: d.x,
        y: d.y,
        radius: d.flatPadRadius,
        height: d.height,
        blendRadius: d.blendRadius,
      })),
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
      this.gameConnection,
      () => this.clientViewState.getTick(),
      () => this.localPlayerId,
      () => !this.backgroundMode && !this.lobbyPreview,
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
    this.cameraControl = new RtsScene3DCameraControl(this.threeApp, baseDistance);
    this.cameraFramingSystem = new RtsScene3DCameraFramingSystem(
      this.threeApp,
      baseDistance,
      this.mapWidth,
      this.mapHeight,
      this.playerIds,
      () => this.localPlayerId,
      this.backgroundMode,
      this.lobbyPreview,
    );
    this.cameras = this.cameraControl.cameras;
    this.cameraFramingSystem.seedInitialCamera();

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
      getEntitySetVersion: () => this.clientViewState.getEntitySetVersion(),
      getTerrainBuildabilityGrid: () => this.clientViewState.getTerrainBuildabilityGrid(),
    };

    this.snapshotIntake.attach();

    this.gameConnection.onGameOver((winnerId: PlayerId) => {
      if (!this.isGameOver) this.handleGameOver(winnerId);
    });

    // Single shared cylinder pool for every leg in the scene. Every
    // unit's locomotion writes into this each frame; the GPU then
    // draws every leg cylinder in 2 instanced draw calls (upper,
    // lower). Replaces the old per-leg THREE.Mesh pattern that
    // produced 2 draw calls per leg → 16 per arachnid → 8000+ at
    // 500 units. Construct BEFORE the entity renderer because the
    // renderer takes the leg pool as a constructor dependency and
    // forwards it through every locomotion build/update/destroy.
    this.legInstancedRenderer = new LegInstancedRenderer(
      this.threeApp.world,
      LEG_COLOR,
    );
    this.entityRenderer = new Render3DEntities(
      this.threeApp.world,
      this.clientViewState,
      this.renderScope,
      this.legInstancedRenderer,
      this.threeApp.camera,
      () => this.threeApp.renderer.domElement.clientHeight,
      () => this.localPlayerId,
    );
    this.beamRenderer = new BeamRenderer3D(this.threeApp.world, this.renderScope);
    // ForceFieldRenderer3D parents each unit's force-field meshes onto
    // that unit's yaw subgroup (like a regular turret root) so the
    // bubble inherits position + tilt + yaw from the scenegraph
    // chain. The lookup is via Render3DEntities since that's where
    // the per-unit mesh hierarchy lives; entityRenderer was just
    // constructed above so the callback resolves immediately.
    this.forceFieldRenderer = new ForceFieldRenderer3D(
      this.threeApp.world,
      this.renderScope,
      (eid) => this.entityRenderer.getUnitYawGroup(eid),
    );
    this.captureTileRenderer = new CaptureTileRenderer3D(
      this.threeApp.world,
      this.clientViewState,
      this.mapWidth,
      this.mapHeight,
      this.metalDeposits,
    );
    this.metalDepositRenderer = new MetalDepositRenderer3D(
      this.threeApp.world,
      this.metalDeposits,
      getGraphicsConfig().tier,
    );
    this.environmentPropRenderer = new EnvironmentPropRenderer3D(
      this.threeApp.world,
      {
        mapWidth: this.mapWidth,
        mapHeight: this.mapHeight,
        playerCount: this.playerIds.length,
        metalDeposits: this.metalDeposits,
        renderScope: this.renderScope,
        sampleTerrainHeight: (x, z) =>
          getTerrainMeshHeight(x, z, this.mapWidth, this.mapHeight),
      },
    );
    this.contactShadowRenderer = new ContactShadowRenderer3D(
      this.threeApp.world,
      this.mapWidth,
      this.mapHeight,
    );
    // Transparent horizon water sits at WATER_LEVEL. The submerged
    // off-map continuation is part of the terrain mesh itself, so the
    // map edge and infinity shelf share the same material/color path.
    // Terrain above the plane hides it via depth testing; terrain
    // below the plane reads as submerged. Physics treats the water
    // surface as the walkable ground (Terrain.getSurfaceHeight clamps
    // UP to WATER_LEVEL), so units never enter the water.
    this.waterRenderer = new WaterRenderer3D(
      this.threeApp.world,
      this.mapWidth,
      this.mapHeight,
    );
    // Build the canonical cursor → 3D ground picker now that the
    // terrain mesh exists. ONE raycaster, ONE terrain mesh, two
    // lenses (three.js coords for the orbit camera, sim coords for
    // commands). Used by EVERY input flow that needs to know "where
    // on the actual ground is the cursor": camera zoom + pan, every
    // command builder via Input3DManager (move waypoints, attack-
    // moves, build clicks, dgun targets, rally points, factory
    // waypoints…). Stops anyone in the input pipeline from
    // approximating with a y=0 plane projection.
    this.cursorGround = new CursorGround(
      this.threeApp.camera,
      this.threeApp.renderer.domElement,
      this.mapWidth,
      this.mapHeight,
    );
    this.threeApp.orbit.setCursorPicker((cx, cy) => this.cursorGround.pickWorld(cx, cy));
    // Camera-clearance sampler — sample the RAW rendered terrain mesh
    // (`getTerrainMeshHeight`) instead of `getSurfaceHeight`. The
    // surface variant clamps up to WATER_LEVEL because that's what
    // UNITS walk on; using it for the camera made the water plane
    // an artificial floor for zoom-in (camera couldn't dip below
    // water + clearance, even though the real basin extends down
    // to TILE_FLOOR_Y). Raw mesh terrain lets the player zoom toward
    // the actual valley bed; the heightmap's own TILE_FLOOR_Y clamp
    // is the true world floor.
    this.threeApp.orbit.setTerrainSampler((x, z) =>
      getTerrainMeshHeight(x, z, this.mapWidth, this.mapHeight)
    );
    this.explosionRenderer = new Explosion3D(this.threeApp.world);
    this.forceFieldImpactRenderer = new ForceFieldImpactRenderer3D(this.threeApp.world);
    this.debrisRenderer = new Debris3D(
      this.threeApp.world,
      (x, z) => getTerrainMeshHeight(x, z, this.mapWidth, this.mapHeight),
    );
    this.burnMarkRenderer = new BurnMark3D(
      this.threeApp.world,
      this.renderScope,
      (x, y) => getSurfaceHeight(x, y, this.mapWidth, this.mapHeight, LAND_CELL_SIZE),
    );
    this.groundPrintRenderer = new GroundPrint3D(this.threeApp.world, this.renderScope);
    this.lineDragRenderer = new LineDrag3D(this.threeApp.world);
    this.pingRenderer = new PingRenderer3D(this.threeApp.world);
    this.buildGhostRenderer = new BuildGhost3D(
      this.threeApp.world,
      (x, y) => getTerrainMeshHeight(x, y, this.mapWidth, this.mapHeight),
    );
    this.sprayRenderer = new SprayRenderer3D(this.threeApp.world);
    this.smokeTrailRenderer = new SmokeTrail3D(this.threeApp.world);
    this.fogOfWarShroudRenderer = new FogOfWarShroudRenderer3D(
      this.threeApp.world,
      this.mapWidth,
      this.mapHeight,
    );

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
        (id) => this.clientViewState.getEntity(id),
      );
      this.lodShellGround3D = new LodShellGround3D(
        this.threeApp.world,
        this.mapWidth,
        this.mapHeight,
        (x, z) => getTerrainMeshHeight(x, z, this.mapWidth, this.mapHeight),
      );
      this.lodGridCells2D = new LodGridCells2D(
        this.threeApp.world,
        this.mapWidth,
        this.mapHeight,
        this.clientViewState,
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
      this.localCommandQueue,
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
      this.terrainCenter,
    );
    // Keep scene's waypointMode in lockstep with the InputManager so the
    // SelectionPanel reflects the active mode when M/F/H hotkeys fire.
    this.inputManager.onWaypointModeChange = (mode) => {
      this.selectionSystem.setWaypointMode(mode);
    };
    this.inputManager.onControlGroupsChange = (groups) => {
      this.selectionSystem.setControlGroups(groups);
    };
    // Keep the SelectionPanel's mode chips (build / D-gun) in sync
    // with the shared CommanderModeController inside Input3DManager.
    this.inputManager.onBuildModeChange = (type) => {
      this.selectionSystem.setBuildMode(type);
    };
    this.inputManager.onDGunModeChange = (active) => {
      this.selectionSystem.setDGunMode(active);
    };
    this.inputManager.onRepairAreaModeChange = (active) => {
      this.selectionSystem.setRepairAreaMode(active);
    };
    this.inputManager.onAttackAreaModeChange = (active) => {
      this.selectionSystem.setAttackAreaMode(active);
    };
    this.inputManager.onAttackGroundModeChange = (active) => {
      this.selectionSystem.setAttackGroundMode(active);
    };
    this.inputManager.onGuardModeChange = (active) => {
      this.selectionSystem.setGuardMode(active);
    };
    this.inputManager.onReclaimModeChange = (active) => {
      this.selectionSystem.setReclaimMode(active);
    };
    this.inputManager.onPingModeChange = (active) => {
      this.selectionSystem.setPingMode(active);
    };

    this.renderPhase = new RtsScene3DRenderPhase(
      this.threeApp,
      this.clientViewState,
      this.renderScope,
      this.cameraFootprintSystem,
      this.snapshotIntake,
      this.selectionSystem,
      {
        entityRenderer: this.entityRenderer,
        beamRenderer: this.beamRenderer,
        forceFieldRenderer: this.forceFieldRenderer,
        captureTileRenderer: this.captureTileRenderer,
        metalDepositRenderer: this.metalDepositRenderer,
        environmentPropRenderer: this.environmentPropRenderer,
        contactShadowRenderer: this.contactShadowRenderer,
        waterRenderer: this.waterRenderer,
        explosionRenderer: this.explosionRenderer,
        forceFieldImpactRenderer: this.forceFieldImpactRenderer,
        debrisRenderer: this.debrisRenderer,
        burnMarkRenderer: this.burnMarkRenderer,
        groundPrintRenderer: this.groundPrintRenderer,
        lineDragRenderer: this.lineDragRenderer,
        pingRenderer: this.pingRenderer,
        sprayRenderer: this.sprayRenderer,
        smokeTrailRenderer: this.smokeTrailRenderer,
        fogOfWarShroudRenderer: this.fogOfWarShroudRenderer,
        healthBar3D: this.healthBar3D,
        nameLabel3D: this.nameLabel3D,
        waypoint3D: this.waypoint3D,
        lodShellGround3D: this.lodShellGround3D,
        lodGridCells2D: this.lodGridCells2D,
      },
      () => this.localPlayerId,
      () => this.inputManager,
      (playerId) => this.lookupPlayerName(playerId),
      () => this.onCameraQuadUpdate,
    );

    // Camera clamping: keep the orbit target inside a padded map region.
    const paddingX = this.mapWidth * WORLD_PADDING_PERCENT;
    const paddingY = this.mapHeight * WORLD_PADDING_PERCENT;
    this.threeApp.orbit.setTargetBounds(
      -paddingX,
      -paddingY,
      this.mapWidth + paddingX,
      this.mapHeight + paddingY,
    );
  }

  private setRendererWarmupActive(active: boolean): void {
    if (this.rendererWarmupActive === active) return;
    this.rendererWarmupActive = active;
    this.onRendererWarmupChange?.(active);
  }

  private startRendererWarmup(): void {
    if (this.rendererWarmupStarted) return;
    this.rendererWarmupStarted = true;
    this.setRendererWarmupActive(true);
    const token = ++this.rendererWarmupToken;
    void this.threeApp.precompileShadersAsync().finally(() => {
      if (this.destroyed || token !== this.rendererWarmupToken) return;
      this.setRendererWarmupActive(false);
    });
  }

  update(_time: number, delta: number): void {
    const frameStart = performance.now();

    // PLAYER CLIENT scene/update loop cadence used by the client LOD resolver.
    if (delta > 0) {
      const rate = 1000 / delta;
      this.renderTpsTracker.update(rate);
    }
    if (this.clientRenderEnabled) {
      this.renderPhase?.beginEnabledFrame();
    }

    this.audioSystem.drainReady(
      this.clientRenderEnabled,
      (event) => this.handleSimEvent3D(event),
    );

    const snapshotResult = this.snapshotIntake.consumeLatestSnapshot({
      clientRenderEnabled: this.clientRenderEnabled,
      audio: this.audioSystem.snapshotAudioOptions(
        this.clientRenderEnabled,
        (event) => this.handleSimEvent3D(event),
      ),
    });
    if (snapshotResult.appliedSnapshot) {
      if (snapshotResult.startupReleased) this.onStartupReady?.();
      if (snapshotResult.serverMeta && this.onServerMetaUpdate) {
        this.onServerMetaUpdate(snapshotResult.serverMeta);
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

    if (!this.clientRenderEnabled) {
      // Diagnostic PLAYER CLIENT OFF path. Keep network snapshot intake,
      // server-meta/economy/combat-stat UI, local commands, and timing
      // instrumentation alive, but skip prediction, camera, minimap, 3D
      // entity/effect/HUD/selection-cache updates, and the WebGL draw call
      // in ThreeApp.
      this.economyUpdateTimer += delta;
      if (this.economyUpdateTimer >= this.ECONOMY_UPDATE_INTERVAL) {
        this.economyUpdateTimer = 0;
        this.updateEconomyInfo();
      }

      const frameEnd = performance.now();
      const frameMs = frameEnd - frameStart;
      this.frameMsTracker.update(frameMs);
      this.renderMsTracker.update(0);
      this.logicMsTracker.update(frameMs);
      // Render-disabled branch never runs prediction, so PRED ms is 0.
      this.predMsTracker.update(0);
      this.longtaskTracker.tick();
      return;
    }

    const renderPhase = this.renderPhase;
    if (!renderPhase) return;

    this.selectionSystem.rebuildEntityCachesIfNeeded();

    const { effectDtMs } = renderPhase.beginRenderFrame();
    // Camera smoothing must step BEFORE visibility scope and view-LOD
    // decisions. Otherwise CPU culling, prediction cadence, and
    // rich-unit selection trail the rendered camera by one frame
    // during dolly/pan.
    this.cameraFramingSystem.tickCameraSmoothing(effectDtMs / 1000);
    const viewportHeightPx = this.threeApp.renderer.domElement.clientHeight;
    const {
      renderLod,
      graphicsConfig,
      predMs,
    } = this.predictionPhase.run({
      deltaMs: delta,
      camera: this.threeApp.camera,
      viewportHeightPx,
      zoom: this.cameras.main.zoom,
    });

    const { cameraQuad, renderMs } = renderPhase.run({
      deltaMs: delta,
      effectDtMs,
      graphicsConfig,
      renderLod,
      renderLodGrid: this.predictionPhase.renderLodGrid,
    });
    if (
      !this.rendererWarmupStarted &&
      (snapshotResult.appliedSnapshot || this.clientViewState.getTick() > 0)
    ) {
      this.startRendererWarmup();
    }

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
    }

    this.minimapSystem.tick(
      delta,
      graphicsConfig,
      this.entitySourceAdapter,
      cameraQuad,
      this.threeApp.orbit.yaw,
      this.onMinimapUpdate,
    );

    // Track frame timing. logicMs = frameMs - renderMs - predMs so
    // the three buckets sum to frameMs and a long applyPrediction
    // pass can no longer hide behind the LOGIC bar. Clamp at 0 to
    // protect against `performance.now()` reordering jitter (in
    // practice negligible but defensive).
    const frameEnd = performance.now();
    const frameMs = frameEnd - frameStart;
    const logicMs = Math.max(0, frameMs - renderMs - predMs);
    this.frameMsTracker.update(frameMs);
    this.renderMsTracker.update(renderMs);
    this.logicMsTracker.update(logicMs);
    this.predMsTracker.update(predMs);
    this.longtaskTracker.tick();
  }

  private processLocalCommands(): void {
    const commands = this.localCommandQueue.getAll();
    this.localCommandQueue.clear();
    for (const command of commands) {
      const handledSelectionCommand = this.selectionSystem.handleLocalCommand(
        command,
        () => this.inputManager?.setWaypointMode('move'),
      );
      if (!handledSelectionCommand) this.gameConnection.sendCommand(command);
    }
  }

  private graphicsConfigForEffectCell(
    simX: number,
    _simY: number,
    simZ: number,
  ): GraphicsConfig | null {
    const base = getGraphicsConfig();
    const shells = getRenderObjectLodShellDistances(base);
    const cellSize = normalizeLodCellSize(base.objectLodCellSize);
    const cx = landCellCenterForSize(landCellIndexForSize(simX, cellSize), cellSize);
    const cz = landCellCenterForSize(landCellIndexForSize(simZ, cellSize), cellSize);
    const camera = this.threeApp.camera.position;
    const dx = cx - camera.x;
    const dy = -camera.y;
    const dz = cz - camera.z;
    const objectTier = resolveRenderObjectLodForDistanceSq(
      dx * dx + dy * dy + dz * dz,
      shells,
      base.forcedObjectTier,
    );
    if (objectTier === 'marker') return null;
    return getGraphicsConfigFor(objectLodToGraphicsTier(objectTier, base.tier));
  }

  /**
   * Dispatch a SimEvent to the 3D effect renderers. Mirrors the subset of
   * DeathEffectsHandler that is visual (audio is handled separately, or not
   * yet — the 3D view currently leaves audio to the 2D path via shared state).
   *
   * Event types handled:
   *   - 'hit'              → fire explosion at event.pos
   *   - 'projectileExpire' → smaller fire explosion (projectile reached max
   *                          range or hit the ground)
   *   - 'forceFieldImpact' → tangent-plane force-field shield flash
   *   - 'death'            → fire explosion + material debris cluster
   *
   * laserStart/Stop and forceFieldStart/Stop need no visual reaction here —
   * beams are drawn continuously while live projectiles exist, and force-field
   * visuals come from FLAG toggles on their turret state.
   */
  private handleSimEvent3D(event: NetworkServerSnapshotSimEvent): void {
    // FOW-09 prereq: play the audio side of every SimEvent before
    // any visual branch returns early. Audio stays on even when the
    // camera/effect-cell gating drops the visual — that's what makes
    // off-screen gunfire audible, the whole point of an RTS soundscape.
    this.playSimEventAudio(event);
    // FOW-09 main: events forwarded by the audio earshot pad arrive
    // with audioOnly=true. The sound has already played above; skip
    // every visual branch so the explosion sprite / debris / ping
    // marker don't leak the still-shrouded source's position.
    if (event.audioOnly) return;
    if (event.type === 'ping') {
      const effectGfx = this.graphicsConfigForEffectCell(
        event.pos.x,
        event.pos.y,
        event.pos.y,
      );
      if (!effectGfx) return;
      this.pingRenderer.spawn(
        event.pos.x,
        event.pos.y,
        event.pos.z,
        getPlayerPrimaryColor(event.playerId),
      );
      return;
    }
    if (event.type === 'attackAlert') {
      // FOW-08-followup remainder: a marker at the attacker's
      // position, drawn for the victim's recipient even when the
      // attacker is in their fog. Red instead of player-colored so
      // the visual reads as "incoming fire" and stays distinct from
      // a deliberate teammate ping.
      const effectGfx = this.graphicsConfigForEffectCell(
        event.pos.x,
        event.pos.y,
        event.pos.z,
      );
      if (!effectGfx) return;
      this.pingRenderer.spawn(
        event.pos.x,
        event.pos.y,
        event.pos.z,
        0xff3030,
      );
      return;
    }

    const effectGfx = this.graphicsConfigForEffectCell(
      event.pos.x,
      event.pos.y,
      event.pos.z,
    );
    if (!effectGfx) return;

    if (event.type === 'hit') {
      const ctx = event.impactContext;
      // Size the explosion by the biggest radius the shot genuinely
      // has — primary/secondary explosion zones for projectiles,
      // just the line's half-width (≈beam_width/2) for beams/lasers.
      // No artificial floor here: line-weapon hits should read as
      // localized sparks the size of the beam, not as a 8-unit
      // pop that looks like a bullet impact.
      const r = ctx
        ? Math.max(ctx.collisionRadius, ctx.explosionRadius)
        : 2;
      // Combined impulse vector (sim X/Y → world X/Z): penetration direction
      // dominates because that's the intended "away from attacker" push, with
      // smaller contributions from the projectile's ballistic momentum and
      // the target's own velocity (so a moving target's debris trails).
      // Same three components the 2D DeathEffectsHandler feeds into
      // addExplosion(..., penetrationX, penetrationY, attackerX, attackerY,
      // velocityX, velocityY, ...).
      let mx = 0, mz = 0;
      if (ctx) {
        mx =
          ctx.penetrationDir.x * 120 +
          ctx.projectile.vel.x * 0.3 +
          ctx.entity.vel.x * 0.3;
        mz =
          ctx.penetrationDir.y * 120 +
          ctx.projectile.vel.y * 0.3 +
          ctx.entity.vel.y * 0.3;
      }
      this.explosionRenderer.spawnImpact(
        event.pos.x,
        event.pos.y,
        event.pos.z,
        r,
        mx,
        mz,
        undefined,
        effectGfx.fireExplosionStyle,
      );
    } else if (event.type === 'projectileExpire') {
      // Ground / expired-projectile fire — always a small pop, no meaningful
      // momentum (the projectile stopped). event.pos.z carries the exact
      // altitude the sim computed — ground-impact events have z=0, aerial
      // splash-on-expiry have whatever altitude the shot reached.
      this.explosionRenderer.spawnImpact(
        event.pos.x,
        event.pos.y,
        event.pos.z,
        8,
        0,
        0,
        undefined,
        effectGfx.fireExplosionStyle,
      );
    } else if (event.type === 'forceFieldImpact') {
      const ctx = event.forceFieldImpact;
      if (ctx) {
        this.forceFieldImpactRenderer.spawn(
          event.pos.x,
          event.pos.y,
          event.pos.z,
          ctx.normal,
          ctx.playerId,
        );
      }
    } else if (event.type === 'death') {
      // Some kill paths (splash, bleed-out, force-field zone damage) emit
      // a death event with no deathContext. Rather than skipping the
      // material explosion entirely, try to reconstruct a minimal context
      // from the entity if it's still in view state; otherwise synthesize
      // a generic fallback so debris still fires.
      let ctx = event.deathContext;
      // The entity may already be gone from view state if the death
      // event is processed after the snapshot that removed it. We
      // look it up either to synthesize a missing context (legacy
      // path) OR — when the server-supplied context is missing
      // turret poses — to enrich it with the live per-turret yaw /
      // pitch so debris cylinders spawn where the actual barrels
      // were pointing at death.
      const ent = event.entityId !== undefined
        ? this.clientViewState.getEntity(event.entityId)
        : undefined;
      if (!ctx && ent) {
        const pid = ent.ownership?.playerId;
        const tcol = getPlayerPrimaryColor(pid);
        const visualRadius = ent.unit?.radius.body
          ?? ent.unit?.radius.shot
          ?? 15;
        const pushRadius = ent.unit ? getUnitBodyCenterHeight(ent.unit) : visualRadius;
        ctx = {
          unitVel: {
            x: ent.unit?.velocityX ?? 0,
            y: ent.unit?.velocityY ?? 0,
          },
          hitDir: { x: 0, y: 0 },
          projectileVel: { x: 0, y: 0 },
          attackMagnitude: 25,
          radius: ent.unit?.radius.shot ?? 15,
          visualRadius,
          pushRadius,
          baseZ: ent.unit ? getUnitGroundZ(ent) : ent.transform.z - pushRadius,
          color: tcol,
          unitType: ent.unit?.unitType && isUnitTypeId(ent.unit.unitType)
            ? ent.unit.unitType
            : undefined,
          rotation: ent.transform.rotation,
        };
      }
      if (ctx && ent?.unit) {
        const visualRadius = ent.unit.radius.body
          ?? ent.unit.radius.shot
          ?? ctx.visualRadius
          ?? ctx.radius;
        const pushRadius = getUnitBodyCenterHeight(ent.unit);
        if (
          ctx.visualRadius === undefined ||
          ctx.pushRadius === undefined ||
          ctx.baseZ === undefined
        ) {
          ctx = {
            ...ctx,
            visualRadius: ctx.visualRadius ?? visualRadius,
            pushRadius: ctx.pushRadius ?? pushRadius,
            baseZ: ctx.baseZ ?? getUnitGroundZ(ent),
          };
        }
      }
      if (ctx && ent && !ctx.turretPoses && ent.combat && ent.combat.turrets.length > 0) {
        ctx = {
          ...ctx,
          turretPoses: ent.combat.turrets.map((t) => ({
            rotation: t.rotation,
            pitch: t.pitch,
          })),
        };
      }
      if (!ctx) {
        // Entity already gone and no server-supplied context — synthesize a
        // bare-minimum neutral context so Debris3D's generic-chunks fallback
        // still produces *something* visible. Worse than a real debris
        // burst but better than silence.
        ctx = {
          unitVel: { x: 0, y: 0 },
          hitDir: { x: 0, y: 0 },
          projectileVel: { x: 0, y: 0 },
          attackMagnitude: 25,
          radius: 15,
          visualRadius: 15,
          pushRadius: 15,
          baseZ: event.pos.z - 15,
          color: 0xcccccc,
        };
      }

      // Scale the hit-direction push by the damaging attack's magnitude so
      // a glancing railgun hit kicks debris further than a DoT tick. Clamp
      // to prevent absurd throws at very-high-damage edge cases.
      const attackPush = Math.min(ctx.attackMagnitude * 2, 200);
      const mx =
        ctx.hitDir.x * attackPush +
        ctx.projectileVel.x * 0.3 +
        ctx.unitVel.x * 0.5;
      const mz =
        ctx.hitDir.y * attackPush +
        ctx.projectileVel.y * 0.3 +
        ctx.unitVel.y * 0.5;
      this.explosionRenderer.spawnDeath(
        event.pos.x, event.pos.y, event.pos.z,
        Math.max(ctx.radius, 6),
        mx, mz,
        effectGfx.fireExplosionStyle,
      );
      this.debrisRenderer.spawn(event.pos.x, event.pos.y, event.pos.z, ctx, effectGfx);
    }
  }

  /** Play the audio side of a SimEvent (FOW-09 prereq). Called once
   *  per event by handleSimEvent3D ahead of the visual branches so
   *  off-screen action stays audible even when the visual gating
   *  trims the explosion sprite. Continuous laser / force-field
   *  sounds are looped state, not one-shots, so they start/stop on
   *  the matching SimEvent pair. */
  private playSimEventAudio(event: NetworkServerSnapshotSimEvent): void {
    switch (event.type) {
      case 'fire':
        // turretId on a 'fire' event is the firing turret blueprint id.
        // Narrow before passing so we don't accidentally feed a shot
        // or unit id when the event was authored unexpectedly.
        if (event.turretId && isTurretId(event.turretId)) {
          audioManager.playWeaponFire(event.turretId);
        }
        return;
      case 'hit':
      case 'projectileExpire':
        // hit / expire audio is keyed by the shot blueprint id. Beam
        // and laser hits carry a turret id in this same field; the
        // blueprintId helper distinguishes shot vs turret so we route
        // it through the right AudioManager method.
        if (event.turretId) {
          if (isShotId(event.turretId)) audioManager.playWeaponHit(event.turretId);
          else if (isTurretId(event.turretId)) audioManager.playWeaponFire(event.turretId);
        }
        return;
      case 'death': {
        const unitType = event.deathContext?.unitType;
        if (unitType && isUnitTypeId(unitType)) audioManager.playUnitDeath(unitType);
        return;
      }
      case 'laserStart':
        if (event.entityId !== undefined) {
          audioManager.startLaserSound(event.entityId, undefined);
        }
        return;
      case 'laserStop':
        if (event.entityId !== undefined) audioManager.stopLaserSound(event.entityId);
        return;
      case 'forceFieldStart':
        if (event.entityId !== undefined) audioManager.startForceFieldSound(event.entityId);
        return;
      case 'forceFieldStop':
        if (event.entityId !== undefined) audioManager.stopForceFieldSound(event.entityId);
        return;
      // ping / attackAlert / forceFieldImpact have no one-shot sound
      // wired yet; the visual is the whole UX. Drop through.
    }
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

  public updateMinimapData(): void {
    // The camera quad is already computed once per frame for the shared
    // ViewportFootprint; the minimap system consumes it without raycasting.
    this.minimapSystem.emit(
      this.entitySourceAdapter,
      this.cameraFootprintSystem.getQuad(),
      this.threeApp.orbit.yaw,
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
    // client view state, minimap, and fog-of-war shroud pick up the
    // new player's vision sources on the next snapshot. Remote
    // connections don't expose this — the network recipient is fixed.
    this.gameConnection.setRecipientPlayerId?.(playerId);
    this.markSelectionDirty();
    this.onPlayerChange?.(playerId);
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

  public clearQueuedOrders(): void {
    this.inputManager?.clearQueuedOrders();
  }

  public removeLastQueuedOrder(): void {
    this.inputManager?.removeLastQueuedOrder();
  }

  public toggleSelectedWait(): void {
    this.inputManager?.toggleSelectedWait();
  }

  public toggleSelectedJump(): void {
    this.inputManager?.toggleSelectedJump();
  }

  public toggleSelectedFire(): void {
    this.inputManager?.toggleSelectedFire();
  }

  public toggleAttackAreaMode(): void {
    this.inputManager?.toggleAttackAreaMode();
  }

  public toggleAttackGroundMode(): void {
    this.inputManager?.toggleAttackGroundMode();
  }

  public toggleGuardMode(): void {
    this.inputManager?.toggleGuardMode();
  }

  public toggleReclaimMode(): void {
    this.inputManager?.toggleReclaimMode();
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
  public startBuildMode(buildingType: BuildingType): void {
    this.inputManager?.setBuildMode(buildingType);
  }

  public cancelBuildMode(): void {
    this.inputManager?.cancelBuildMode();
  }
  public toggleDGunMode(): void {
    this.inputManager?.toggleDGunMode();
  }

  public toggleRepairAreaMode(): void {
    this.inputManager?.toggleRepairAreaMode();
  }

  public queueFactoryUnit(factoryId: number, unitId: string): void {
    // Factory build queue is server-authoritative, so this command
    // goes straight through gameConnection (same path the 2D scene's
    // processLocalCommands forwards it to).
    this.gameConnection.sendCommand({
      type: 'queueUnit',
      tick: this.clientViewState.getTick(),
      factoryId,
      unitId,
    });
  }

  public cancelFactoryQueueItem(factoryId: number, index: number): void {
    this.gameConnection.sendCommand({
      type: 'cancelQueueItem',
      tick: this.clientViewState.getTick(),
      factoryId,
      index,
    });
  }

  public centerCameraOn(x: number, y: number): void {
    this.cameraControl.centerOn(x, y);
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

  public getFrameTiming(): {
    frameMsAvg: number; frameMsHi: number;
    renderMsAvg: number; renderMsHi: number;
    logicMsAvg: number; logicMsHi: number;
    /** Pure ClientViewState.applyPrediction wall-clock per frame
     *  (avg/hi). Pulled out of logicMs so the PLAYER CLIENT bar can
     *  isolate prediction cost — long prediction passes used to hide
     *  in the LOGIC bar. */
    predMsAvg: number; predMsHi: number;
    /** Actual GPU execution time (ms) from EXT_disjoint_timer_query_webgl2,
     *  or 0 when the extension isn't available (Safari). Callers should
     *  check `gpuTimerSupported` and fall back to renderMs if false. */
    gpuTimerMs: number;
    gpuTimerSupported: boolean;
    /** Longtask signal — blocked ms per second of wall-clock time. */
    longtaskMsPerSec: number;
    longtaskCountPerSec: number;
    longtaskSupported: boolean;
  } {
    return {
      frameMsAvg: this.frameMsTracker.getAvg(),
      frameMsHi: this.frameMsTracker.getHi(),
      renderMsAvg: this.renderMsTracker.getAvg(),
      renderMsHi: this.renderMsTracker.getHi(),
      logicMsAvg: this.logicMsTracker.getAvg(),
      logicMsHi: this.logicMsTracker.getHi(),
      predMsAvg: this.predMsTracker.getAvg(),
      predMsHi: this.predMsTracker.getHi(),
      gpuTimerMs: this.clientRenderEnabled ? this.threeApp.gpuTimer.getGpuMs() : 0,
      gpuTimerSupported: this.threeApp.gpuTimer.isSupported(),
      longtaskMsPerSec: this.longtaskTracker.getBlockedMsPerSec(),
      longtaskCountPerSec: this.longtaskTracker.getCountPerSec(),
      longtaskSupported: this.longtaskTracker.isSupported(),
    };
  }

  public getRenderTpsStats(): { avgRate: number; worstRate: number } {
    return {
      avgRate: this.renderTpsTracker.getAvg(),
      worstRate: this.renderTpsTracker.getLow(),
    };
  }

  public getSnapshotStats(): { avgRate: number; worstRate: number } {
    return this.snapshotIntake.getSnapshotStats();
  }

  /** Full-keyframe arrival rate. Only counts snaps where
   *  `state.isDelta === false`. Useful for spotting an aggressive
   *  keyframe ratio (full snaps every tick) vs a sparse one (full
   *  every few seconds). */
  public getFullSnapshotStats(): { avgRate: number; worstRate: number } {
    return this.snapshotIntake.getFullSnapshotStats();
  }

  /**
   * Tear down the scene. By default disconnects the GameConnection;
   * passing `{ keepConnection: true }` skips the disconnect so a live
   * renderer swap can reuse the same connection across the new scene.
   */
  public shutdown(opts: { keepConnection?: boolean } = {}): void {
    this.destroyed = true;
    this.rendererWarmupToken++;
    this.setRendererWarmupActive(false);
    teardownRtsScene3DRenderers({
      inputManager: this.inputManager,
      healthBar3D: this.healthBar3D,
      nameLabel3D: this.nameLabel3D,
      waypoint3D: this.waypoint3D,
      lodShellGround3D: this.lodShellGround3D,
      lodGridCells2D: this.lodGridCells2D,
      entityRenderer: this.entityRenderer,
      metalDepositRenderer: this.metalDepositRenderer,
      environmentPropRenderer: this.environmentPropRenderer,
      contactShadowRenderer: this.contactShadowRenderer,
      beamRenderer: this.beamRenderer,
      forceFieldRenderer: this.forceFieldRenderer,
      captureTileRenderer: this.captureTileRenderer,
      waterRenderer: this.waterRenderer,
      explosionRenderer: this.explosionRenderer,
      forceFieldImpactRenderer: this.forceFieldImpactRenderer,
      debrisRenderer: this.debrisRenderer,
      burnMarkRenderer: this.burnMarkRenderer,
      groundPrintRenderer: this.groundPrintRenderer,
      lineDragRenderer: this.lineDragRenderer,
      pingRenderer: this.pingRenderer,
      buildGhostRenderer: this.buildGhostRenderer,
      sprayRenderer: this.sprayRenderer,
      smokeTrailRenderer: this.smokeTrailRenderer,
      fogOfWarShroudRenderer: this.fogOfWarShroudRenderer,
      longtaskTracker: this.longtaskTracker,
      audioSystem: this.audioSystem,
    });
    this.inputManager = null;
    this.healthBar3D = null;
    this.nameLabel3D = null;
    this.waypoint3D = null;
    this.lodShellGround3D = null;
    this.lodGridCells2D = null;
    this.metalDepositRenderer = null;
    this.environmentPropRenderer = null;
    this.contactShadowRenderer = null;
    this.renderPhase = null;
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
    this.onRendererWarmupChange = undefined;
  }
}
