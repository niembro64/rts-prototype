// RtsScene3D — 3D equivalent of RtsScene.
//
// Implements the same public API surface (callbacks + methods) so PhaserCanvas.vue
// can drive it interchangeably with the 2D scene. Internally it uses ThreeApp and
// Render3DEntities instead of Pixi graphics, and currently has no selection/input
// (view-only). Selection/commands will be added in a later pass.

import * as THREE from 'three';
import type { ClientViewState } from '../network/ClientViewState';
import type { SceneCameraState } from '@/types/game';
import { isUnitTypeId } from '@/types/blueprintIds';
import type { TerrainMapShape, TerrainShape } from '@/types/terrain';
import { SnapshotBuffer } from './helpers/SnapshotBuffer';
import {
  buildSelectionInfo,
  buildEconomyInfo,
  buildMinimapData,
} from './helpers';
import type { EconomyInfo, MinimapData } from './helpers';
import type { SprayTarget, UIInputState } from '@/types/ui';
import { EmaTracker } from './helpers/EmaTracker';
import { EmaMsTracker } from './helpers/EmaMsTracker';
import { LongtaskTracker } from './helpers/LongtaskTracker';
import { ThreeApp } from '../render3d/ThreeApp';
import { Render3DEntities } from '../render3d/Render3DEntities';
import { Input3DManager } from '../render3d/Input3DManager';
import { BeamRenderer3D } from '../render3d/BeamRenderer3D';
import { ForceFieldRenderer3D } from '../render3d/ForceFieldRenderer3D';
import { CaptureTileRenderer3D } from '../render3d/CaptureTileRenderer3D';
import { MetalDepositRenderer3D } from '../render3d/MetalDepositRenderer3D';
import { generateMetalDeposits, type MetalDeposit } from '../../metalDepositConfig';
import { isCommander } from '../sim/combat/combatUtils';
import { WaterRenderer3D } from '../render3d/WaterRenderer3D';
import { CursorGround } from '../render3d/CursorGround';
import { LegInstancedRenderer } from '../render3d/LegInstancedRenderer';
import { LodShellGround3D } from '../render3d/LodShellGround3D';
import { LodGridCells2D } from '../render3d/LodGridCells2D';
import { RenderLodGrid } from '../render3d/RenderLodGrid';
import { snapshotLod } from '../render3d/Lod3D';
import {
  getRenderObjectLodShellDistances,
  objectLodToGraphicsTier,
  resolveRenderObjectLodForDistanceSq,
} from '../render3d/RenderObjectLod';

/** Same color the per-mesh leg path used. Single uniform value
 *  across the whole shared pool — legs aren't team-tinted. */
const LEG_COLOR = 0x2a2f36;
import { ViewportFootprint } from '../ViewportFootprint';
import type { FootprintBounds, FootprintQuad } from '../ViewportFootprint';
import { SprayRenderer3D } from '../render3d/SprayRenderer3D';
import { SmokeTrail3D } from '../render3d/SmokeTrail3D';
import { Explosion3D } from '../render3d/Explosion3D';
import { ForceFieldImpactRenderer3D } from '../render3d/ForceFieldImpactRenderer3D';
import { Debris3D } from '../render3d/Debris3D';
import { BurnMark3D } from '../render3d/BurnMark3D';
import { GroundPrint3D } from '../render3d/GroundPrint3D';
import { LineDrag3D } from '../render3d/LineDrag3D';
import { BuildGhost3D } from '../render3d/BuildGhost3D';
import { ContactShadowRenderer3D } from '../render3d/ContactShadowRenderer3D';
import { AudioEventScheduler } from './helpers/AudioEventScheduler';
import type { NetworkServerSnapshotSimEvent } from '../network/NetworkTypes';
import {
  getAudioSmoothing,
  getCameraSmoothMode,
  getGraphicsConfig,
  getGraphicsConfigFor,
  getLodShellRings,
  getLodGridBorders,
  setCurrentZoom,
  getGridOverlay,
  getGridOverlayIntensity,
} from '@/clientBarConfig';
import { CommandQueue, type SelectCommand } from '../sim/commands';
import { getPlayerBaseAngle, getSpawnPositionForSeat } from '../sim/spawn';
import { getTerrainDividerTeamCount } from '../sim/playerLayout';
import {
  getTerrainMeshHeight,
  getSurfaceHeight,
  setTerrainTeamCount,
  setTerrainCenterShape,
  setTerrainDividersShape,
  setTerrainMapShape,
  setMetalDepositFlatZones,
  TERRAIN_MAX_RENDER_Y,
  TILE_FLOOR_Y,
} from '../sim/Terrain';
import {
  normalizeLodCellSize,
} from '../lodGridMath';
import { landCellCenterForSize, landCellIndexForSize } from '../landGrid';
import { HealthBar3D } from '../render3d/HealthBar3D';
import { NameLabel3D } from '../render3d/NameLabel3D';
import { resolveEntityDisplayName } from '../render3d/EntityName';
import { getDefaultPlayerName } from '@/playerNamesConfig';
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
  ZOOM_INITIAL_GAME,
  ZOOM_INITIAL_DEMO,
  ZOOM_INITIAL_LOBBY_PREVIEW,
  LOBBY_PREVIEW_SPIN_RATE,
  LAND_CELL_SIZE,
} from '../../config';

const RENDER_SCOPE_AERIAL_HEADROOM_Y = 700;
const RENDER_SCOPE_PLANE_Y = [
  TILE_FLOOR_Y,
  0,
  TERRAIN_MAX_RENDER_Y + RENDER_SCOPE_AERIAL_HEADROOM_Y,
] as const;
const RENDER_SCOPE_NDC_SAMPLES = [
  [-1,  1], [0,  1], [1,  1],
  [-1,  0], [0,  0], [1,  0],
  [-1, -1], [0, -1], [1, -1],
] as const;

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
};

// Mini "camera" accessor that PhaserCanvas.vue reads for zoom display. We derive
// a Pixi-equivalent zoom number from the 3D orbit distance so UI sliders show a
// consistent value. baseDistance is the default camera distance.
//
// Two zoom-shaped values:
//
//   `zoom`     — LOD ratio (`baseDistance / orbit.distance`). Higher = more
//                zoomed in. Used for save/restore camera state, UI/legacy
//                camera reads, and any code path that needs a multiplicative
//                scalar relative to the default framing. Counts wheel ticks
//                multiplicatively. Object-level view LOD uses camera
//                projection instead of this raw ratio.
//
//   `altitude` — Camera world Y, i.e. distance from the y=0 ground plane
//                along its normal. Universal: same physical state → same
//                number, regardless of pan / wheel / target-y history.
//                Smaller = closer to surface, larger = farther up. The
//                wheel-zoom rail also clamps on this (in OrbitCamera) so
//                hitting "min/max zoom" matches what the user feels — at
//                the floor you're grazing the surface, at the ceiling
//                you're at panoramic altitude. Replaces the old
//                `viewSpan` (focal-plane span) which was meaningful in
//                isolation but didn't match the wheel clamp's actual
//                rail.
type CameraShim = {
  main: {
    zoom: number;
    altitude: number;
    scrollX: number;
    scrollY: number;
    width: number;
    height: number;
  };
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
  private buildGhostRenderer!: BuildGhost3D;
  private sprayRenderer!: SprayRenderer3D;
  private smokeTrailRenderer!: SmokeTrail3D;
  private audioScheduler = new AudioEventScheduler();
  private lastEffectsTickMs = 0;
  private renderFrameIndex = 0;
  private fireExplosionAccumMs = 0;
  private debrisAccumMs = 0;
  private burnMarkAccumMs = 0;
  private groundPrintAccumMs = 0;
  private smokeTrailAccumMs = 0;
  private sprayAccumMs = 0;
  private combinedSprayTargets: SprayTarget[] = [];
  private inputManager: Input3DManager | null = null;
  private gameConnection!: GameConnection;
  private snapshotBuffer = new SnapshotBuffer();
  private localCommandQueue = new CommandQueue();
  private currentWaypointMode: WaypointType = 'move';
  // Mirrors Input3DManager's shared CommanderModeController so the
  // SelectionPanel's "SOLAR / FACTORY / D-GUN" chips stay accurate
  // (scene.updateSelectionInfo reads these each frame).
  private currentBuildType: BuildingType | null = null;
  private currentDGunActive = false;
  private healthBar3D: HealthBar3D | null = null;
  private nameLabel3D: NameLabel3D | null = null;
  private contactShadowRenderer: ContactShadowRenderer3D | null = null;
  /** Resolves a player ID to its display name. Hooked up via
   *  RtsScene3DConfig.lookupPlayerName; null result falls back to
   *  `getDefaultPlayerName(playerId)` so commander labels still
   *  render with a stable funny default in single-player / demo /
   *  lobby-preview contexts that don't have a roster wired up. */
  private lookupPlayerName: (id: PlayerId) => string | null = () => null;
  private waypoint3D: Waypoint3D | null = null;
  private lodShellGround3D: LodShellGround3D | null = null;
  private lodGridCells2D: LodGridCells2D | null = null;
  private renderLodGrid = new RenderLodGrid();
  private readonly predictionLodResolver = (worldX: number, worldY: number, worldZ: number) => {
    const tier = this.renderLodGrid.resolve(worldX, worldY, worldZ);
    return tier === 'hero' ? 'rich' : tier;
  };

  // Camera frustum cached once per frame and shared with the HUD
  // renderers so they can skip the bake / position update for every
  // entity outside the view. With ~5k units on the map but only a few
  // hundred visible at any zoom the savings are large; the test itself
  // is six plane dot products.
  private _frustum = new THREE.Frustum();
  private _frustumMatrix = new THREE.Matrix4();

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
  private hasCenteredCamera = false;
  /** Frame counter used to drive the one-shot shader precompile sweep
   *  during early gameplay. THREE compiles shaders lazily — sweeping
   *  the first ~60 update frames catches most material variants
   *  (units, buildings, beams, force fields, explosions, debris,
   *  smoke, sprays) right after they're added to the scene, instead
   *  of paying a 100-150ms getProgramInfoLog stall mid-battle. */
  private precompileFramesRemaining = 60;

  // Performance trackers (mirror RtsScene)
  private renderTpsTracker = new EmaTracker(EMA_CONFIG.tps, EMA_INITIAL_VALUES.tps);
  private snapTracker = new EmaTracker(EMA_CONFIG.snaps, EMA_INITIAL_VALUES.snaps);
  // Parallel tracker that ONLY updates on full keyframes (state.isDelta=false).
  //
  // No initialValue passed on purpose — the EMA's "wait for first
  // sample" mode seeds at the actual rate as soon as a real interval
  // is observed. FSPS samples arrive at ~0.5 Hz by default, so even a
  // small nonzero seed can linger too long and make FSPS look higher
  // than SPS, which is logically impossible.
  private fullSnapTracker = new EmaTracker(EMA_CONFIG.snaps);
  private frameMsTracker = new EmaMsTracker(FRAME_TIMING_EMA.frameMs, EMA_INITIAL_VALUES.frameMs);
  private renderMsTracker = new EmaMsTracker(FRAME_TIMING_EMA.renderMs, EMA_INITIAL_VALUES.renderMs);
  private logicMsTracker = new EmaMsTracker(FRAME_TIMING_EMA.logicMs, EMA_INITIAL_VALUES.logicMs);
  private predMsTracker = new EmaMsTracker(FRAME_TIMING_EMA.predMs, EMA_INITIAL_VALUES.predMs);
  private longtaskTracker = new LongtaskTracker();

  // Reusable raycaster + horizontal-plane scratch for projecting
  // viewport samples into world/sim space. Allocated once; every
  // frame reuses them for the minimap quad and render scope.
  private _minimapRay = new THREE.Raycaster();
  private _minimapNdc = new THREE.Vector2();
  private _minimapHit = new THREE.Vector3();
  private _renderScopeBounds: FootprintBounds = {
    minX: -Infinity,
    maxX: Infinity,
    minY: -Infinity,
    maxY: Infinity,
  };

  // UI update throttling (mirror RtsScene)
  private selectionDirty = true;
  private economyUpdateTimer = 0;
  private minimapUpdateTimer = 0;
  private readonly ECONOMY_UPDATE_INTERVAL = 100;
  private readonly MINIMAP_UPDATE_INTERVAL = 50;
  private _minimapDataScratch: MinimapData = {
    contentVersion: 0,
    captureVersion: 0,
    mapWidth: 0,
    mapHeight: 0,
    entities: [],
    cameraQuad: [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ],
    cameraYaw: 0,
    captureTiles: [],
    captureCellSize: 0,
    gridOverlayIntensity: 0,
    showTerrain: true,
    wind: undefined,
  };
  private _lineProjectilesScratch: Entity[] = [];
  private _burnMarkProjectilesScratch: Entity[] = [];
  private _smokeTrailProjectilesScratch: Entity[] = [];

  // Snapshot-arrival tracking for snap-rate EMA
  private lastSnapArrivalMs = 0;
  // Separate timestamp for the full-keyframe rate. Stays 0 until the
  // first keyframe arrives, then updates only on subsequent keyframes.
  private lastFullSnapArrivalMs = 0;
  private startupReadyAckSent = false;
  private startupFullSnapshotApplied = false;
  private startupReleased = false;

  // Entity source adapter, kept shape-compatible with RtsScene's for UI helpers
  private entitySourceAdapter!: {
    getUnits: () => Entity[];
    getBuildings: () => Entity[];
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
  private _cachedSelectedUnits: Entity[] = [];
  private _cachedSelectedBuildings: Entity[] = [];
  private _selectedEntityCacheDirty = true;
  private clientRenderEnabled = true;

  // ── Callback interface matching RtsScene ──
  public onPlayerChange?: (playerId: PlayerId) => void;
  public onSelectionChange?: (info: {
    unitCount: number;
    hasCommander: boolean;
    hasBuilder: boolean;
    hasDGun: boolean;
    hasFactory: boolean;
    factoryId?: number;
    commanderId?: number;
    waypointMode: WaypointType;
    isBuildMode: boolean;
    selectedBuildingType: string | null;
    isDGunMode: boolean;
    factoryQueue?: { unitId: string; label: string }[];
    factoryProgress?: number;
    factoryIsProducing?: boolean;
  }) => void;
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

  // Phaser-compat accessors used by PhaserCanvas.vue
  private _restartCb: (() => void) | null = null;
  public readonly scene: SceneLifecycle = {
    onRestart: (cb: () => void) => { this._restartCb = cb; },
    restart: () => { this._restartCb?.(); },
  };

  // Dynamic camera shim — exposes a zoom-like number derived from the orbit
  // distance so UI (zoom display, minimap viewport) has a consistent axis to read.
  public readonly cameras: CameraShim = {
    main: {
      // Filled by the getters below via Object.defineProperty in constructor
      zoom: 0, altitude: 0, scrollX: 0, scrollY: 0, width: 0, height: 0,
    },
  };

  private _baseDistance: number;

  constructor(threeApp: ThreeApp, config: RtsScene3DConfig) {
    this.threeApp = threeApp;
    this.clientRenderEnabled = threeApp.isRenderEnabled();
    this.localPlayerId = config.localPlayerId;
    this.playerIds = config.playerIds;
    if (config.lookupPlayerName) this.lookupPlayerName = config.lookupPlayerName;
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
    this._baseDistance = Math.max(this.mapWidth, this.mapHeight) * 0.35;

    // Seed orbit camera from the same battle-facing target logic used
    // after snapshots arrive, while keeping per-mode zoom distances.
    //
    // Initial yaw is set to the local seat's POV — camera "behind" the
    // viewer's team, looking toward the map center. DEMO BATTLE and
    // REAL BATTLE both frame the local commander so their controls
    // feel identical; only GAME LOBBY preview keeps the wide map-center
    // framing and continuous slow orbit (driven from `update()` below).
    const initialZoom = this.lobbyPreview
      ? ZOOM_INITIAL_LOBBY_PREVIEW
      : this.backgroundMode ? ZOOM_INITIAL_DEMO : ZOOM_INITIAL_GAME;
    // Target the LOCAL SEAT's spawn position so the commander is
    // in-frame from frame 1, before any snapshot arrives. Lobby preview
    // is intentionally spectator-style and stays centered on the map.
    const framesLocalCommander = !this.lobbyPreview;
    const seatIndex = framesLocalCommander
      ? Math.max(0, this.playerIds.indexOf(this.localPlayerId))
      : 0;
    const initialTarget = framesLocalCommander
      ? getSpawnPositionForSeat(
          seatIndex,
          Math.max(1, this.playerIds.length),
          this.mapWidth,
          this.mapHeight,
        )
      : { x: this.mapWidth / 2, y: this.mapHeight / 2 };
    this.threeApp.orbit.setState({
      targetX: initialTarget.x,
      targetY: 0,
      targetZ: initialTarget.y,
      distance: this._baseDistance / initialZoom,
      yaw: this._povYawForLocalSeat(),
      pitch: this.threeApp.orbit.pitch,
    });
    this.threeApp.orbit.setSmoothTau(this._cameraSmoothTauSec());

    // Redefine cameras.main as live getters bound to orbit + renderer
    Object.defineProperties(this.cameras.main, {
      zoom: {
        get: () => this._baseDistance / this.threeApp.orbit.distance,
      },
      // Camera altitude (world Y, distance from the y=0 ground plane
      // along its normal). Read directly off the rendered camera so
      // it reflects the actual displayed framing — including any
      // terrain-clearance lift `apply()` may have applied.
      altitude: {
        get: () => this.threeApp.camera.position.y,
      },
      scrollX: {
        get: () => this.threeApp.orbit.target.x - this._visibleHalfWidth(),
      },
      scrollY: {
        get: () => this.threeApp.orbit.target.z - this._visibleHalfHeight(),
      },
      width: { get: () => this.threeApp.renderer.domElement.clientWidth },
      height: { get: () => this.threeApp.renderer.domElement.clientHeight },
    });
  }

  public setClientRenderEnabled(enabled: boolean): void {
    if (this.clientRenderEnabled === enabled) return;
    this.clientRenderEnabled = enabled;
    this.threeApp.setRenderEnabled(enabled);
    if (!enabled) {
      this.audioScheduler.clear();
      this.fireExplosionAccumMs = 0;
      this.debrisAccumMs = 0;
      this.burnMarkAccumMs = 0;
      this.groundPrintAccumMs = 0;
      this.smokeTrailAccumMs = 0;
      this.sprayAccumMs = 0;
    }
  }

  public isClientRenderEnabled(): boolean {
    return this.clientRenderEnabled;
  }

  /** Approximate visible world-width at the ground plane (for minimap viewport). */
  private _visibleHalfWidth(): number {
    // perspective view: half-angle * distance, scaled by aspect ratio
    const cam = this.threeApp.camera;
    const vFov = (cam.fov * Math.PI) / 180;
    const halfH = Math.tan(vFov / 2) * this.threeApp.orbit.distance;
    return halfH * cam.aspect;
  }

  private _visibleHalfHeight(): number {
    const cam = this.threeApp.camera;
    const vFov = (cam.fov * Math.PI) / 180;
    return Math.tan(vFov / 2) * this.threeApp.orbit.distance;
  }

  create(): void {
    // this.clientViewState is already set from config (constructor).
    this.entitySourceAdapter = {
      getUnits: () => this.clientViewState.getUnits(),
      getBuildings: () => this.clientViewState.getBuildings(),
      getProjectiles: () => this.clientViewState.getProjectiles(),
      getAllEntities: () => this.clientViewState.getAllEntities(),
      getEntity: (id) => this.clientViewState.getEntity(id),
      getSelectedUnits: () => this._cachedSelectedUnits,
      getSelectedBuildings: () => this._cachedSelectedBuildings,
      getBuildingsByPlayer: (pid) => this.clientViewState.getBuildingsByPlayer(pid),
      getUnitsByPlayer: (pid) => this.clientViewState.getUnitsByPlayer(pid),
      getEntitySetVersion: () => this.clientViewState.getEntitySetVersion(),
      getTerrainBuildabilityGrid: () => this.clientViewState.getTerrainBuildabilityGrid(),
    };

    this.snapshotBuffer.attach(this.gameConnection);

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
    this.buildGhostRenderer = new BuildGhost3D(
      this.threeApp.world,
      (x, y) => getTerrainMeshHeight(x, y, this.mapWidth, this.mapHeight),
    );
    this.sprayRenderer = new SprayRenderer3D(this.threeApp.world);
    this.smokeTrailRenderer = new SmokeTrail3D(this.threeApp.world);

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
      this.currentWaypointMode = mode;
      this.selectionDirty = true;
    };
    // Keep the SelectionPanel's mode chips (build / D-gun) in sync
    // with the shared CommanderModeController inside Input3DManager.
    this.inputManager.onBuildModeChange = (type) => {
      this.currentBuildType = type;
      this.selectionDirty = true;
    };
    this.inputManager.onDGunModeChange = (active) => {
      this.currentDGunActive = active;
      this.selectionDirty = true;
    };

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

  update(_time: number, delta: number): void {
    const frameStart = performance.now();

    // PLAYER CLIENT scene/update loop cadence used by the client LOD resolver.
    if (delta > 0) {
      const rate = 1000 / delta;
      this.renderTpsTracker.update(rate);
    }
    if (this.clientRenderEnabled) {
      this.explosionRenderer.beginFrame();
      this.debrisRenderer.beginFrame();
    }

    // Drain any audio events whose scheduled playback time has arrived. This
    // runs every frame (not just on snapshot arrival) because scheduled events
    // are staggered across the snapshot interval.
    if (this.clientRenderEnabled) {
      const nowDrain = performance.now();
      this.audioScheduler.drain(nowDrain, (event) => this.handleSimEvent3D(event));
    }

    // Consume newest snapshot (if any)
    const state = this.snapshotBuffer.consume();
    if (state) {
      this.clientViewState.applyNetworkState(state);
      if (!this.startupReadyAckSent && !state.isDelta) {
        this.startupFullSnapshotApplied = true;
      }
      if (!this.startupReleased && state.tick > 0) {
        this.startupReleased = true;
        this.onStartupReady?.();
      }

      const now = performance.now();
      if (this.lastSnapArrivalMs > 0) {
        const dt = now - this.lastSnapArrivalMs;
        if (dt > 0) this.snapTracker.update(1000 / dt);
      }
      this.lastSnapArrivalMs = now;
      // Full-keyframe rate — only ticks on keyframe snaps. The first
      // keyframe seeds; the second one starts producing a non-zero
      // EMA reading.
      if (!state.isDelta) {
        if (this.lastFullSnapArrivalMs > 0) {
          const dt = now - this.lastFullSnapArrivalMs;
          if (dt > 0) this.fullSnapTracker.update(1000 / dt);
        }
        this.lastFullSnapArrivalMs = now;
      }

      if (this.clientRenderEnabled) {
        // Schedule any new SimEvents that came in with this snapshot. Smoothing
        // staggers one-shot events across the snapshot interval; continuous
        // start/stop events fire immediately (handled inside AudioEventScheduler).
        this.audioScheduler.recordSnapshot(now);
        const events = this.clientViewState.getPendingAudioEvents();
        if (events && events.length > 0) {
          this.audioScheduler.schedule(
            events,
            now,
            getAudioSmoothing(),
            (event) => this.handleSimEvent3D(event),
          );
        }
      }

      // Forward server meta to UI
      const serverMeta = this.clientViewState.getServerMeta();
      if (serverMeta && this.onServerMetaUpdate) this.onServerMetaUpdate(serverMeta);

      // Game over
      const winnerId = this.clientViewState.getGameOverWinnerId();
      if (winnerId !== null && !this.isGameOver) this.handleGameOver(winnerId);

      // First-snapshot camera framing. Interactive battles center on
      // the local player's commander (yaw tilts so the map center is
      // forward); the GAME LOBBY preview remains spectator-wide.
      if (!this.hasCenteredCamera) {
        if (this.lobbyPreview) this.centerCameraOnMap();
        else this.centerCameraOnCommander();
      }

      this.selectionDirty = true;
      this._selectedEntityCacheDirty = true;
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

    this.rebuildSelectedEntityCachesIfNeeded();

    this.renderFrameIndex = (this.renderFrameIndex + 1) & 0x3fffffff;
    // Camera smoothing must step BEFORE visibility scope and view-LOD
    // decisions. Otherwise CPU culling, prediction cadence, and
    // rich-unit selection trail the rendered camera by one frame
    // during dolly/pan.
    const effectNow = performance.now();
    const effectDt = this.lastEffectsTickMs === 0
      ? 0
      : Math.min(effectNow - this.lastEffectsTickMs, 100);
    this.lastEffectsTickMs = effectNow;
    this.threeApp.orbit.setSmoothTau(this._cameraSmoothTauSec());
    this.threeApp.orbit.tick(effectDt / 1000);
    // GAME LOBBY preview: continuous slow orbit around the map
    // center, like an unattended alt+middle-drag. `effectDt` is
    // the same clamped per-frame ms the orbit tick uses, so the
    // spin stays smooth at any frame rate and pauses cleanly
    // when the tab backgrounds (the clamp caps catch-up bursts).
    if (this.lobbyPreview) {
      const dtSec = effectDt / 1000;
      this.threeApp.orbit.setOrbitAngles(
        this.threeApp.orbit.yaw + LOBBY_PREVIEW_SPIN_RATE * dtSec,
        this.threeApp.orbit.pitch,
      );
    }
    // Publish camera zoom for UI/legacy signal reads after camera
    // smoothing has advanced. In 3D the global AUTO tier no longer
    // depends on zoom by default; view scale is consumed inside
    // Render3DEntities for per-object rich mesh selection instead.
    setCurrentZoom(this.cameras.main.zoom);
    const viewportHeightPx = this.threeApp.renderer.domElement.clientHeight;
    const renderLod = snapshotLod(this.threeApp.camera, viewportHeightPx);
    const graphicsConfig = renderLod.gfx;
    this.renderLodGrid.beginFrame(renderLod.view, graphicsConfig);

    // Dead-reckon + drift through the exact same camera-sphere cell
    // resolver used by renderers this frame. Near entities predict
    // every frame; far cells update on sparse staggered strides.
    // Wall-clock the prediction pass independently so the PLAYER
    // CLIENT bar can isolate prediction cost from the broader
    // logic/render/frame timing — see getFrameTiming().
    const predStart = performance.now();
    this.clientViewState.applyPrediction(delta, {
      cameraX: renderLod.view.cameraX,
      cameraY: renderLod.view.cameraY,
      cameraZ: renderLod.view.cameraZ,
      richDistance: 0,
      simpleDistance: 0,
      massDistance: 0,
      impostorDistance: 0,
      cellSize: graphicsConfig.objectLodCellSize,
      physicsPredictionFramesSkip: graphicsConfig.clientPhysicsPredictionFramesSkip,
      resolveTier: this.predictionLodResolver,
    });
    const predMs = performance.now() - predStart;

    // Render phase
    const renderStart = performance.now();
    const lodShells = getRenderObjectLodShellDistances(graphicsConfig);
    this.lodShellGround3D?.update(
      this.threeApp.camera,
      [
        { tier: 'rich', distance: lodShells.rich },
        { tier: 'simple', distance: lodShells.simple },
        { tier: 'mass', distance: lodShells.mass },
        { tier: 'impostor', distance: lodShells.impostor },
      ],
      getLodShellRings(),
    );
    const gridMode = getGridOverlay();
    const gridOverlayIntensity = gridMode !== 'off' ? getGridOverlayIntensity() : 0;
    this.lodGridCells2D?.update(
      graphicsConfig.objectLodCellSize,
      getLodGridBorders(),
      gridMode !== 'off',
      gridOverlayIntensity,
    );
    this.metalDepositRenderer?.update(
      graphicsConfig,
      renderLod,
      this.renderLodGrid,
    );
    const hudFrameStride = Math.max(1, graphicsConfig.hudFrameStride | 0);
    const effectFrameStride = Math.max(1, graphicsConfig.effectFrameStride | 0);
    const updateHudThisFrame = hudFrameStride <= 1 || this.renderFrameIndex % hudFrameStride === 0;
    const updateEffectsThisFrame = effectFrameStride <= 1 || this.renderFrameIndex % effectFrameStride === 0;
    // Refresh the shared visibility footprint once per frame so every
    // per-entity hot loop below can early-out on off-screen entities
    // without re-querying camera state or getRenderMode(). The same
    // quad feeds the minimap (see updateMinimapData).
    this._cameraQuad = this.computeCameraQuad();
    this.renderScope.setQuad(
      this._cameraQuad,
      this.computeRenderScopeBounds(this._cameraQuad),
    );
    // Emit the quad every frame — the minimap's camera box reads
    // this directly so it stays pinned to the view regardless of
    // the (throttled) entity-list refresh.
    this.onCameraQuadUpdate?.(this._cameraQuad, this.threeApp.orbit.yaw);
    const serverMeta = this.clientViewState.getServerMeta();
    this.entityRenderer.update(
      renderLod,
      this.renderLodGrid,
      { mirrorsEnabled: serverMeta?.mirrorsEnabled ?? true },
    );
    this.contactShadowRenderer?.update(
      this.clientViewState.getUnits(),
      this.clientViewState.getBuildings(),
      graphicsConfig,
      this.renderFrameIndex,
      this.renderScope,
    );
    this.captureTileRenderer.update(
      graphicsConfig,
      renderLod,
      this.renderLodGrid,
    );
    if (this.startupFullSnapshotApplied && !this.startupReadyAckSent) {
      this.startupReadyAckSent = true;
      this.gameConnection.markClientReady();
    }
    const lineProjectiles = this.clientViewState.collectLineProjectiles(this._lineProjectilesScratch);
    const smokeTrailProjectiles = updateEffectsThisFrame
      ? this.clientViewState.collectSmokeTrailProjectiles(this._smokeTrailProjectilesScratch)
      : this._smokeTrailProjectilesScratch;
    this.beamRenderer.update(
      lineProjectiles,
      graphicsConfig,
      renderLod,
      this.renderLodGrid,
      this.clientViewState.getLineProjectileRenderVersion(),
    );
    // Force-field iteration is deferred — fused with HealthBar3D's
    // per-unit walk below, after the camera frustum is computed.
    // Single getUnits() iteration drives both per-unit renderers.

    // Effects integrate their own lightweight physics. Debris/material
    // explosions apply their PLAYER CLIENT LOD physics-frame skip internally;
    // burn marks sample live beams to trace scorches on the ground. We feed
    // the scheduler's clamped dt so backgrounded tabs don't jump-forward.
    // Water is static and opaque; update is now just a visibility /
    // lazy-geometry check.
    this.waterRenderer.update(
      effectDt / 1000,
      graphicsConfig,
      renderLod,
      this.renderLodGrid,
    );
    this.fireExplosionAccumMs += effectDt;
    this.debrisAccumMs += effectDt;
    if (updateEffectsThisFrame) {
      this.explosionRenderer.update(this.fireExplosionAccumMs);
      this.debrisRenderer.update(this.debrisAccumMs);
      this.fireExplosionAccumMs = 0;
      this.debrisAccumMs = 0;
    }
    this.forceFieldImpactRenderer.update(effectDt, lineProjectiles);
    this.burnMarkAccumMs += effectDt;
    if (updateEffectsThisFrame) {
      const burnMarkProjectiles = this.clientViewState.collectBurnMarkProjectiles(this._burnMarkProjectilesScratch);
      this.burnMarkRenderer.update(burnMarkProjectiles, this.burnMarkAccumMs);
      this.burnMarkAccumMs = 0;
    }
    // Wheel/tread/foot ground prints. We pull each unit's locomotion
    // mesh from the entity renderer (which built it earlier in this
    // tick during updateAll), so this runs AFTER updateLocomotion has
    // refreshed every contact's worldX/Z for the frame.
    this.groundPrintAccumMs += effectDt;
    if (updateEffectsThisFrame) {
      const units = this.clientViewState.getUnits();
      this.groundPrintRenderer.update(
        units,
        (e) => this.entityRenderer.getLocomotionMesh(e.id),
        this.groundPrintAccumMs,
      );
      this.groundPrintAccumMs = 0;
    }
    // Commander build/heal spray comes from sim state; factory unit
    // construction spray is derived from the client-side factory tower
    // rig so it can originate at the rendered nozzle height.
    this.sprayAccumMs += effectDt;
    if (updateEffectsThisFrame) {
      const commanderSprays = this.clientViewState.getSprayTargets();
      const factorySprays = this.entityRenderer.getFactorySprayTargets();
      if (factorySprays.length > 0) {
        this.combinedSprayTargets.length = 0;
        for (const spray of commanderSprays) this.combinedSprayTargets.push(spray);
        for (const spray of factorySprays) this.combinedSprayTargets.push(spray);
        this.sprayRenderer.update(this.combinedSprayTargets, this.sprayAccumMs);
      } else {
        this.sprayRenderer.update(commanderSprays, this.sprayAccumMs);
      }
      this.sprayAccumMs = 0;
    }
    // Rocket smoke trails: reads the same projectile list the beam
    // renderer consumes; puffs fall back to pooled meshes once their
    // fade completes.
    this.smokeTrailAccumMs += effectDt;
    if (updateEffectsThisFrame) {
      this.smokeTrailRenderer.update(
        smokeTrailProjectiles,
        this.smokeTrailAccumMs,
        this.renderFrameIndex,
        this.renderScope,
      );
      this.smokeTrailAccumMs = 0;
    }
    // Input selection-change bookkeeping is handled when local
    // selection commands are processed. Do not poll all units here:
    // at 10k units that turns a rare UI state change into a permanent
    // per-frame full-unit scan.
    // Line-drag preview reads directly from the input manager's live state.
    if (this.inputManager) {
      this.lineDragRenderer.update(this.inputManager.getLineDragState());
    }
    // Refresh the camera frustum once per frame from the current
    // view-projection matrix; HUD renderers test entity positions
    // against it to skip off-screen work.
    //
    // RENDER mode integration: when the player explicitly selected
    // RENDER:ALL they want every HP bar / selection label visible,
    // including off-screen ones (e.g. for AOE awareness during a
    // pulled-back screenshot). Pass `undefined` instead of the
    // frustum so the HUD renderers skip the per-sprite cull. WIN
    // and PAD modes still get the precise per-pixel frustum test —
    // for HUD elements with negligible world-space footprint, frustum
    // is the right tool (AABB scope's padding doesn't add value).
    const cam = this.threeApp.camera;
    this._frustumMatrix.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._frustumMatrix);
    const hudFrustum = this.renderScope.getMode() === 'all' ? undefined : this._frustum;

    // Force fields are rare compared to total unit count, so feed the
    // renderer its cached subset instead of asking every normal unit
    // to run the force-field branch. Health bars still walk broad
    // entity lists because HP/build progress are dynamic per snapshot.
    this.forceFieldRenderer.beginFrame(graphicsConfig);
    if (this.clientViewState.getServerMeta()?.forceFieldsEnabled ?? true) {
      for (const u of this.clientViewState.getForceFieldUnits()) {
        this.forceFieldRenderer.perUnit(u);
      }
    }
    this.forceFieldRenderer.endFrame();

    // Health bars track unit positions and run EVERY frame — the
    // sprites are siblings of the unit groups (not children), so
    // without a per-frame position update they visibly "snap" to the
    // unit's last hud-stride position while the unit's own mesh
    // continues moving smoothly. The expensive part is gated
    // internally by `repaintIfChanged`, so per-frame iteration just
    // sets sprite positions and frustum-probes for small damaged /
    // hovered entity lists.
    const hoveredEntity = this.inputManager?.getHoveredEntity() ?? null;
    if (this.healthBar3D) {
      this.healthBar3D.beginFrame(hudFrustum);
      const damagedUnits = this.clientViewState.getDamagedUnits();
      for (const u of damagedUnits) {
        this.healthBar3D.perUnit(u);
      }
      const healthBarBuildings = this.clientViewState.getHealthBarBuildings();
      for (const b of healthBarBuildings) {
        this.healthBar3D.perBuilding(b);
      }
      if (hoveredEntity?.unit) {
        this.healthBar3D.perUnit(hoveredEntity, true);
      } else if (hoveredEntity?.building) {
        this.healthBar3D.perBuilding(hoveredEntity, true);
      }
      this.healthBar3D.endFrame();
    }

    // Entity labels: commanders show player names, selected units and
    // buildings show their blueprint names. Same fallback story as the
    // rest of the renderer — if no roster lookup was wired up,
    // getDefaultPlayerName(pid) gives a stable name keyed by player id.
    if (this.nameLabel3D) {
      this.nameLabel3D.beginFrame(hudFrustum);
      const lookup = (pid: PlayerId): string | null =>
        this.lookupPlayerName(pid) ?? getDefaultPlayerName(pid);
      for (const u of this.clientViewState.getUnits()) {
        const name = resolveEntityDisplayName(u, lookup);
        if (name !== null) this.nameLabel3D.perEntity(u, name);
      }
      for (const b of this.clientViewState.getBuildings()) {
        const name = resolveEntityDisplayName(b, lookup);
        if (name !== null) this.nameLabel3D.perEntity(b, name);
      }
      this.nameLabel3D.endFrame();
    }
    // Waypoint markers stay gated — their world points are fixed
    // command goals (move target, build site, rally point), not
    // tracking entities, so per-frame updates would be wasted work.
    if (updateHudThisFrame) {
      this.waypoint3D?.update(
        this._cachedSelectedUnits,
        this._cachedSelectedBuildings,
      );
    }

    // Shader precompile sweep — every per-frame renderer above has had
    // a chance to add its current materials to the scene by now. THREE
    // compiles shaders lazily on first render of each program, and the
    // sync getProgramInfoLog read after compile blocks the frame for
    // 100-150ms (caught in the wild on a 144ms profile). Sweeping the
    // first ~60 frames forces every just-added material's program
    // through the compiler at a known time, so first-of-its-kind
    // beams / explosions / debris / force fields don't stall the frame
    // they appear on. compile() is a no-op for already-cached programs.
    if (this.precompileFramesRemaining > 0) {
      this.threeApp.precompileShaders();
      this.precompileFramesRemaining--;
    }
    const renderEnd = performance.now();

    // UI updates — throttled like RtsScene. A producing factory's
    // queue/progress changes continuously, so force a selection-info
    // push whenever one is selected — mirrors RtsScene so the
    // SelectionPanel's build progress bar ticks live.
    if (!this.selectionDirty) {
      const hasProducingFactory = this._cachedSelectedBuildings.some(
        (b) => b.factory?.isProducing,
      );
      if (hasProducingFactory) this.selectionDirty = true;
    }
    if (this.selectionDirty) {
      this.updateSelectionInfo();
      this.selectionDirty = false;
    }

    this.economyUpdateTimer += delta;
    if (this.economyUpdateTimer >= this.ECONOMY_UPDATE_INTERVAL) {
      this.economyUpdateTimer = 0;
      this.updateEconomyInfo();
    }

    this.minimapUpdateTimer += delta;
    const minimapInterval = this.getMinimapUpdateInterval(graphicsConfig);
    if (this.minimapUpdateTimer >= minimapInterval) {
      this.minimapUpdateTimer = 0;
      this.updateMinimapData();
    }

    // Track frame timing. logicMs = frameMs - renderMs - predMs so
    // the three buckets sum to frameMs and a long applyPrediction
    // pass can no longer hide behind the LOGIC bar. Clamp at 0 to
    // protect against `performance.now()` reordering jitter (in
    // practice negligible but defensive).
    const frameEnd = performance.now();
    const frameMs = frameEnd - frameStart;
    const renderMs = renderEnd - renderStart;
    const logicMs = Math.max(0, frameMs - renderMs - predMs);
    this.frameMsTracker.update(frameMs);
    this.renderMsTracker.update(renderMs);
    this.logicMsTracker.update(logicMs);
    this.predMsTracker.update(predMs);
    this.longtaskTracker.tick();
  }

  private getMinimapUpdateInterval(graphicsConfig: GraphicsConfig): number {
    const renderStrideScale = Math.min(
      4,
      Math.max(1, graphicsConfig.captureTileFrameStride | 0),
    );
    const unitCount = this.clientViewState.getServerMeta()?.units?.count ?? 0;
    const unitScale =
      unitCount >= 8000 ? 6 :
      unitCount >= 4000 ? 4 :
      unitCount >= 1500 ? 2 :
      1;
    return this.MINIMAP_UPDATE_INTERVAL * renderStrideScale * unitScale;
  }

  private centerCameraOnCommander(): void {
    const units = this.clientViewState.getUnits();
    const commander = units.find(
      (e) => isCommander(e) && e.ownership?.playerId === this.localPlayerId,
    );
    if (commander) {
      const cx = commander.transform.x;
      const cz = commander.transform.y;
      this.threeApp.orbit.setTarget(cx, 0, cz);

      // Place the camera "behind" the commander looking toward the map
      // center — natural RTS framing on spawn where the battlefield
      // opens up in front of the unit. Yaw math:
      //
      //   forward vector (commander → center) = normalize(center − pos)
      //   OrbitCamera's yaw=0 convention puts the camera on the -Z side
      //   of the target looking toward +Z. yaw=π flips that. In general
      //   the camera sits at target + distance · (sin(yaw), 0,
      //   -cos(yaw)) and looks back at the target, so for a forward
      //   vector (fx, fz) we want the camera OPPOSITE that vector —
      //   i.e. yaw = atan2(-fx, fz).
      //
      // Commanders spawn in even oval-space angles around the map center
      // (sim/spawn.ts), so this makes every player's first view look
      // the same relative to their own commander regardless of seat.
      const forwardX = this.mapWidth / 2 - cx;
      const forwardZ = this.mapHeight / 2 - cz;
      if (forwardX * forwardX + forwardZ * forwardZ > 1) {
        this.threeApp.orbit.setOrbitAngles(
          Math.atan2(-forwardX, forwardZ),
          this.threeApp.orbit.pitch,
        );
      }
      this.hasCenteredCamera = true;
    }
  }

  // Center the orbit camera on the map center — used by the GAME
  // LOBBY preview so the whole upcoming battlefield is visible instead
  // of framing a specific commander's seat. Yaw is held at red's POV
  // (set in the constructor via _povYawForLocalSeat) for stable
  // spectator framing.
  private centerCameraOnMap(): void {
    this.threeApp.orbit.setTarget(this.mapWidth / 2, 0, this.mapHeight / 2);
    this.hasCenteredCamera = true;
  }

  /** Translate the persisted camera-smooth mode into the orbit
   *  camera's EMA time-constant (seconds). 0 = snap (no animation).
   *  Larger τ = gentler easing. After τ seconds the rendered camera
   *  is ~63% of the way to the to-state; after 3·τ it's ~95%.
   *
   *    fast → ~150 ms perceived settle.
   *    mid  → ~360 ms.
   *    slow → ~1.2 s — properly slow / weighty. */
  private _cameraSmoothTauSec(): number {
    switch (getCameraSmoothMode()) {
      case 'fast': return 0.05;
      case 'mid':  return 0.12;
      case 'slow': return 0.4;
      case 'snap':
      default: return 0;
    }
  }

  /** Compute the orbit yaw that would put the camera "behind" a
   *  player's spawn position on the commander oval, looking toward
   *  the map center. DEMO BATTLE and REAL BATTLE use the active
   *  local player's index; GAME LOBBY preview uses red (index 0)
   *  for stable spectator framing. Math mirrors centerCameraOnCommander:
   *  yaw = atan2(−forwardX, forwardZ) where forward is the unit
   *  vector from the player's spawn to the map center. */
  private _povYawForLocalSeat(): number {
    const playerCount = Math.max(1, this.playerIds.length);
    const seatIndex = this.lobbyPreview
      ? 0
      : Math.max(0, this.playerIds.indexOf(this.localPlayerId));
    const angle = getPlayerBaseAngle(seatIndex, playerCount);
    // Spawn position relative to map center: (cos(angle), sin(angle))
    // scaled by the spawn radius. The spawn → center forward vector is
    // therefore the negation of that direction. We don't need the
    // actual radius — yaw only depends on direction.
    const forwardSimX = -Math.cos(angle);
    const forwardSimY = -Math.sin(angle);
    // sim x → three x, sim y → three z.
    const fx = forwardSimX;
    const fz = forwardSimY;
    return Math.atan2(-fx, fz);
  }

  private processLocalCommands(): void {
    const commands = this.localCommandQueue.getAll();
    this.localCommandQueue.clear();
    for (const command of commands) {
      if (command.type === 'select') {
        const sc = command as SelectCommand;
        if (!sc.additive) this.clientViewState.clearSelection();
        for (const id of sc.entityIds) this.clientViewState.selectEntity(id);
        this.preferUnitsOverBuildingsInSelection();
        this.inputManager?.setWaypointMode('move');
        this.selectionDirty = true;
        this._selectedEntityCacheDirty = true;
      } else if (command.type === 'clearSelection') {
        this.clientViewState.clearSelection();
        this.inputManager?.setWaypointMode('move');
        this.selectionDirty = true;
        this._selectedEntityCacheDirty = true;
      } else {
        this.gameConnection.sendCommand(command);
      }
    }
  }

  private preferUnitsOverBuildingsInSelection(): void {
    let hasSelectedUnit = false;
    const pid = this.localPlayerId;
    for (const unit of this.clientViewState.getUnits()) {
      if (unit.selectable?.selected && unit.ownership?.playerId === pid) {
        hasSelectedUnit = true;
        break;
      }
    }
    if (!hasSelectedUnit) return;

    for (const building of this.clientViewState.getBuildings()) {
      if (building.selectable?.selected && building.ownership?.playerId === pid) {
        this.clientViewState.deselectEntity(building.id);
      }
    }
  }

  private rebuildSelectedEntityCachesIfNeeded(): void {
    if (!this._selectedEntityCacheDirty) return;
    this._selectedEntityCacheDirty = false;

    this._cachedSelectedUnits.length = 0;
    this._cachedSelectedBuildings.length = 0;
    const pid = this.localPlayerId;
    for (const e of this.clientViewState.getUnits()) {
      if (e.selectable?.selected && e.ownership?.playerId === pid) {
        this._cachedSelectedUnits.push(e);
      }
    }
    for (const b of this.clientViewState.getBuildings()) {
      if (b.selectable?.selected && b.ownership?.playerId === pid) {
        this._cachedSelectedBuildings.push(b);
      }
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

  private handleGameOver(winnerId: PlayerId): void {
    if (this.isGameOver) return;
    this.isGameOver = true;
    this.onGameOverUI?.(winnerId);
  }

  public updateSelectionInfo(): void {
    if (!this.onSelectionChange) return;
    // Input-state mirror for the SelectionPanel UI — reads the live
    // build/waypoint/d-gun flags so the panel's mode chips stay in sync.
    const inputState: UIInputState = {
      waypointMode: this.currentWaypointMode,
      isBuildMode: this.currentBuildType !== null,
      selectedBuildingType: this.currentBuildType,
      isDGunMode: this.currentDGunActive,
    };
    this.onSelectionChange(
      buildSelectionInfo(this.entitySourceAdapter, inputState),
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
    if (!this.onMinimapUpdate) return;
    // The camera quad is already computed once per frame for the
    // shared ViewportFootprint (scope culling); the minimap just
    // reads it so we don't pay 4× raycasts twice per frame.
    //
    // Capture-overlay parity: hand the minimap the same tiles +
    // cellSize the 3D floating cells overlay consumes, plus the GRID
    // intensity from clientBarConfig. GRID controls ownership tint only;
    // terrain/water stay visible and are optimized by LOD.
    const captureTiles = this.clientViewState.getCaptureTiles();
    const captureVersion = this.clientViewState.getCaptureVersion();
    const captureCellSize = this.clientViewState.getCaptureCellSize();
    const gridMode = getGridOverlay();
    const showTerrain = true;
    const intensity = gridMode !== 'off' ? getGridOverlayIntensity() : 0;
    this.onMinimapUpdate(
      buildMinimapData(
        this.entitySourceAdapter,
        this.mapWidth,
        this.mapHeight,
        this._cameraQuad,
        this.threeApp.orbit.yaw,
        captureTiles,
        captureVersion,
        captureCellSize,
        intensity,
        showTerrain,
        this.clientViewState.getServerMeta()?.wind,
        this._minimapDataScratch,
      ),
    );
  }

  /** Raycast each of the four NDC viewport corners (±1, ±1) through
   *  the perspective camera onto the y=0 ground plane, returning a
   *  ground-plane quad (TL, TR, BR, BL in screen order). Reused by
   *  the scope footprint and the minimap — called once per frame
   *  in update(). */
  private computeCameraQuad(): [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
  ] {
    return [
      this.cornerOnGround(-1,  1),
      this.cornerOnGround( 1,  1),
      this.cornerOnGround( 1, -1),
      this.cornerOnGround(-1, -1),
    ];
  }

  private _cameraQuad: [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
  ] = [
    { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 },
  ];

  private computeRenderScopeBounds(
    baseQuad: FootprintQuad,
  ): FootprintBounds {
    const b = this._renderScopeBounds;
    b.minX = Infinity;
    b.maxX = -Infinity;
    b.minY = Infinity;
    b.maxY = -Infinity;
    const include = (p: { x: number; y: number }) => {
      if (p.x < b.minX) b.minX = p.x;
      if (p.x > b.maxX) b.maxX = p.x;
      if (p.y < b.minY) b.minY = p.y;
      if (p.y > b.maxY) b.maxY = p.y;
    };

    for (const p of baseQuad) include(p);

    // WIN/PAD culling must be conservative in 3D. The minimap quad is
    // intentionally the y=0 ground-plane footprint, but visible units
    // can stand on mountains above that plane or on lowered/water
    // terrain below it. Sample a small NDC grid against the world
    // height band and use the AABB of those intersections for CPU
    // scope tests. That keeps "window" mode from popping hilltop
    // units as the camera pitches or yaws.
    for (const [ndcX, ndcY] of RENDER_SCOPE_NDC_SAMPLES) {
      for (const planeY of RENDER_SCOPE_PLANE_Y) {
        include(this.pointOnHorizontalPlane(ndcX, ndcY, planeY));
      }
    }

    return b;
  }

  /** Project a viewport corner (in NDC: x,y ∈ [-1,1]) onto the y=0
   *  ground plane. When the corner ray points above the horizon (no
   *  intersection with positive t), fall back to a point far along
   *  the ray's ground-plane projection so the minimap still draws a
   *  non-degenerate quad. */
  private cornerOnGround(ndcX: number, ndcY: number): { x: number; y: number } {
    return this.pointOnHorizontalPlane(ndcX, ndcY, 0);
  }

  private pointOnHorizontalPlane(
    ndcX: number,
    ndcY: number,
    worldY: number,
  ): { x: number; y: number } {
    this._minimapNdc.set(ndcX, ndcY);
    this._minimapRay.setFromCamera(this._minimapNdc, this.threeApp.camera);
    const ray = this._minimapRay.ray;
    const denom = ray.direction.y;
    if (Math.abs(denom) > 1e-6) {
      const t = (worldY - ray.origin.y) / denom;
      if (t >= 0) {
        this._minimapHit.set(
          ray.origin.x + ray.direction.x * t,
          worldY,
          ray.origin.z + ray.direction.z * t,
        );
        return { x: this._minimapHit.x, y: this._minimapHit.z };
      }
    }
    const origin = ray.origin;
    const dir = ray.direction;
    const farT = Math.max(this.mapWidth, this.mapHeight) * 4;
    return {
      x: origin.x + dir.x * farT,
      y: origin.z + dir.z * farT,
    };
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
    return this.threeApp.orbit;
  }

  public markSelectionDirty(): void {
    this.selectionDirty = true;
    this._selectedEntityCacheDirty = true;
  }

  public setWaypointMode(mode: WaypointType): void {
    this.currentWaypointMode = mode;
    this.inputManager?.setWaypointMode(mode);
    this.selectionDirty = true;
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
    this.threeApp.orbit.setTarget(x, 0, y);
  }

  /** Capture the orbit camera's current framing in the portable
   *  `SceneCameraState` shape — 2D-equivalent zoom + the (x, y)
   *  world-space target point. */
  public captureCameraState(): SceneCameraState {
    const orbit = this.threeApp.orbit;
    return {
      x: orbit.target.x,
      y: orbit.target.z,
      zoom: this._baseDistance / orbit.distance,
      targetZ: orbit.target.y,
      yaw: orbit.yaw,
      pitch: orbit.pitch,
    };
  }

  /** Apply a captured camera state. Works with states captured from
   *  either renderer — the zoom scalar is in 2D-equivalent units and
   *  maps back to an orbit distance via the scene's base distance. */
  public applyCameraState(state: SceneCameraState): void {
    const orbit = this.threeApp.orbit;
    orbit.setState({
      targetX: state.x,
      targetY: state.targetZ ?? 0,
      targetZ: state.y,
      distance: this._baseDistance / Math.max(state.zoom, 0.001),
      yaw: state.yaw ?? orbit.yaw,
      pitch: state.pitch ?? orbit.pitch,
    });
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
    return {
      avgRate: this.snapTracker.getAvg(),
      worstRate: this.snapTracker.getLow(),
    };
  }

  /** Full-keyframe arrival rate. Only counts snaps where
   *  `state.isDelta === false`. Useful for spotting an aggressive
   *  keyframe ratio (full snaps every tick) vs a sparse one (full
   *  every few seconds). */
  public getFullSnapshotStats(): { avgRate: number; worstRate: number } {
    return {
      avgRate: this.fullSnapTracker.getAvg(),
      worstRate: this.fullSnapTracker.getLow(),
    };
  }

  /**
   * Tear down the scene. By default disconnects the GameConnection;
   * passing `{ keepConnection: true }` skips the disconnect so a live
   * renderer swap can reuse the same connection across the new scene.
   */
  public shutdown(opts: { keepConnection?: boolean } = {}): void {
    this.inputManager?.destroy();
    this.inputManager = null;
    this.healthBar3D?.destroy();
    this.healthBar3D = null;
    this.nameLabel3D?.destroy();
    this.nameLabel3D = null;
    this.waypoint3D?.destroy();
    this.waypoint3D = null;
    this.lodShellGround3D?.destroy();
    this.lodShellGround3D = null;
    this.lodGridCells2D?.destroy();
    this.lodGridCells2D = null;
    this.entityRenderer?.destroy();
    this.metalDepositRenderer?.dispose();
    this.metalDepositRenderer = null;
    this.contactShadowRenderer?.dispose();
    this.contactShadowRenderer = null;
    this.beamRenderer?.destroy();
    this.forceFieldRenderer?.destroy();
    this.captureTileRenderer?.destroy();
    this.waterRenderer?.destroy();
    this.explosionRenderer?.destroy();
    this.forceFieldImpactRenderer?.destroy();
    this.debrisRenderer?.destroy();
    this.burnMarkRenderer?.destroy();
    this.groundPrintRenderer?.destroy();
    this.lineDragRenderer?.destroy();
    this.buildGhostRenderer?.destroy();
    this.sprayRenderer?.destroy();
    this.smokeTrailRenderer?.destroy();
    this.longtaskTracker.destroy();
    this.audioScheduler.clear();
    if (!opts.keepConnection) {
      this.gameConnection?.disconnect();
    }
    this.snapshotBuffer.clear();
    this.localCommandQueue.clear();
    this.onPlayerChange = undefined;
    this.onSelectionChange = undefined;
    this.onEconomyChange = undefined;
    this.onMinimapUpdate = undefined;
    this.onCameraQuadUpdate = undefined;
    this.onGameOverUI = undefined;
    this.onGameRestart = undefined;
    this.onServerMetaUpdate = undefined;
  }
}
