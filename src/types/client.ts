import type {
  DefaultSetting,
  BooleanSetting,
  LabeledOptionsConfig,
  PlatformBooleanDefaults,
} from './bars';
import type { RenderMode } from './graphics';
import type { BuildingPlacementSet } from './buildingTypes';

export type AudioScope = 'off' | 'window' | 'padded' | 'all';
export type MasterVolumePercent = number;
/** Light intensity as a PERCENT of the authored `worldRenderConfig` intensity,
 *  so 100 always means "whatever the config says" and stays meaningful if that
 *  config is retuned. */
export type LightIntensityPercent = number;
/** Four-mode smoothing space used by the unit-ground-normal and camera controls. */
export type DriftMode = 'snap' | 'fast' | 'mid' | 'slow';
export type CameraSmoothMode = 'snap' | 'fast' | 'mid' | 'slow';
export type CameraViewMode = 'overhead' | 'ta' | 'spring';
/** Camera follow behavior for a single selected unit.
 *    free          — camera is driven purely by mouse input (default).
 *    follow        — camera glides to keep the selected unit centered,
 *                    preserving the current distance, yaw, and pitch.
 *    follow-behind — like follow, but also rotates the camera to sit
 *                    behind the unit (looking down its forward axis),
 *                    still preserving distance and pitch.
 *  Only active while exactly one unit is selected. */
export type CameraFollowMode = 'free' | 'follow' | 'follow-behind';
/** Main camera vertical field of view, in degrees. BAR hotkeys may adjust
 *  the configured value in 5-degree steps at runtime. */
export type CameraFovDegrees = number;
/** Renderer visual LOD policy. AUTO uses projected screen coverage to select
 *  the same HIGH, MEDIUM, LOW, or MIN presentation as the manual modes. */
export type LodMode = 'auto' | 'high' | 'medium' | 'low' | 'min';
/** Geometric antialiasing pipeline.
 *    default — draw straight into the canvas; MSAA is whatever the browser
 *              granted the context's `antialias: true` hint (usually 4×).
 *    4x/8x   — draw into an explicit multisampled offscreen target with that
 *              many samples (clamped to the GPU's MAX_SAMPLES) and present it
 *              with a fullscreen copy pass.
 *    max     — the offscreen path at the GPU's MAX_SAMPLES. */
export type AntialiasMsaaMode = 'default' | '4x' | '8x' | 'max';
/** Render-resolution policy, as a PERCENT of the display's native
 *  devicePixelRatio. AUTO keeps the runtime profile's behavior (the adaptive
 *  pixel-ratio governor on browser desktop, the fixed profile cap on
 *  Tauri/mobile). A number pins the pixel ratio to native × percent/100 and
 *  suspends the governor — values over 100 supersample. */
export type AntialiasResolutionMode = 'auto' | number;
/** Presentation-only treatment of the map/water boundary.
 *    infinity             — extend water and perimeter terrain to a fake horizon.
 *    floating-square      — cut off the real map and render water as an
 *                           open-bottom perimeter curtain slightly larger
 *                           than the map footprint.
 *    floating-square-sea  — floating-square geometry with a solid sea-colored
 *                           background and no visible sky/sun disk. */
export type WaterBoundaryMode =
  | 'infinity'
  | 'floating-square'
  | 'floating-square-sea';
/** Waypoint visualization detail. SIMPLE shows user-issued command points and
 *  conventional intent connectors. DETAILED shows the exact remaining
 *  smoothed active plan consumed by locomotion, including snapped or partial
 *  endpoints; future command points remain markers until their legs are
 *  actually planned. */
export type WaypointDetail = 'simple' | 'detailed-sharp' | 'detailed-smooth';
export type PathingDebugMode = 'none' | 'waypoint' | 'move';
/** Exclusive whole-map view for each authoritative placement set. */
export type BuildGridDebugMode = 'none' | BuildingPlacementSet;
export type PathingDebugUnitId = string;
/** Entity-HUD entity classes. Each maps to a renderer category that
 *  can independently show / hide its name tag, health bar, and
 *  construction-progress bars. */
export type EntityHudType =
  | 'unit'
  | 'tower'
  | 'building'
  | 'turret'
  | 'shot';
/** The per-entity HUD elements that can be toggled. */
export type EntityHudElement = 'name' | 'healthBar';
/** Tri-state controlling enabled HUD elements on the CURRENT SELECTION.
 *  Per-type toggles remain the first gate.
 *    always      — show enabled selection bars even when full.
 *    never       — suppress enabled selection bars and names (hover can
 *                  still force the health bar for direct inspection).
 *    whenNotFull — show enabled bars only when damaged or under
 *                  construction; enabled names remain visible because
 *                  they have no fullness state. */
export type SelectionHudMode = 'always' | 'never' | 'whenNotFull';
export type SoundCategory =
  | 'fire'
  | 'hit'
  | 'dead'
  | 'beam'
  | 'field'
  | 'music';

export type RangeType =
  | 'trackAcquire'
  | 'trackRelease'
  | 'engageAcquire'
  | 'engageRelease'
  | 'engageMinAcquire'
  | 'engageMinRelease'
  | 'build';
/** One debug-volume category, applied to EVERY entity that carries that
 *  kind of volume rather than to one entity class. Units, buildings,
 *  projectiles, and vegetation props each contribute whichever of these
 *  they actually have:
 *
 *    selection — the mouse-pick volume (sphere / box / torus / prop cylinder)
 *    hit       — damage volume + the target-acquisition cylinder
 *    collision — the physics volume
 *    arming    — the enlarged HIT-shaped host volume a shot clears before arming
 *    explosion — the splash volume a shot detonates with
 *    turretLockOn — every 3D tracking/engagement range shell around each turret
 */
export type VolumeType =
  | 'selection'
  | 'hit'
  | 'collision'
  | 'arming'
  | 'explosion'
  | 'turretLockOn';

export type SoundDefaults = Record<SoundCategory, boolean>;

/** Per-entity-type HUD element toggles. One flag per HUD element for
 *  each entity class. Persisted as a single localStorage JSON blob,
 *  mirroring `soundToggles`. */
export type EntityHudToggles = Record<
  EntityHudType,
  Record<EntityHudElement, boolean>
>;

/** Soft presentation budgets used only to scale CLIENT-bar utilization
 *  meters. They are tuning targets, not renderer-enforced limits. */
export type ClientTelemetryBudgets = {
  readonly drawCallsPerFrame: number;
  readonly trianglesPerFrame: number;
  readonly bufferUploadCallsPerFrame: number;
  readonly bufferUploadBytesPerFrame: number;
};

export type ClientBarConfig = {
  readonly render: LabeledOptionsConfig<RenderMode>;
  readonly audio: LabeledOptionsConfig<Exclude<AudioScope, 'off'>>;
  readonly masterVolume: LabeledOptionsConfig<MasterVolumePercent>;
  readonly environmentLight: LabeledOptionsConfig<LightIntensityPercent>;
  readonly ambientLight: LabeledOptionsConfig<LightIntensityPercent>;
  readonly skyLight: LabeledOptionsConfig<LightIntensityPercent>;
  readonly exposure: LabeledOptionsConfig<LightIntensityPercent>;
  readonly directionalLight: LabeledOptionsConfig<LightIntensityPercent>;
  readonly audioSmoothing: BooleanSetting;
  /** Beam, laser, and dgun scorch trails drawn by BurnMark3D.
   *  Default off — scorches accumulate fast in long fights and the
   *  player typically wants the live battlefield, not its history. */
  readonly burnMarks: BooleanSetting;
  readonly windParticles: BooleanSetting;
  /** Wheel, tread, and footstep prints drawn by GroundPrint3D from
   *  unit movement. Default on — these decay quickly and read as
   *  part of the unit silhouettes' motion. */
  readonly locomotionMarks: BooleanSetting;
  /** Team-colored ORNAMENTATION — the extra trim geometry bolted onto
   *  entities to show their side (a unit's fin, a building's roof band).
   *  Off by default while the shapes are still being designed. Identity
   *  colors themselves are not gated by this: bodies stay player-colored
   *  and turret accents stay team-colored either way, because those
   *  recolor existing geometry rather than adding any. */
  readonly teamTrim: BooleanSetting;
  readonly surfaceTexture: BooleanSetting;
  /** Smoke-puff trails behind thrust-powered projectiles (rockets,
   *  missiles) rendered by SmokeTrail3D. Default on — toggle off to
   *  cut the visual clutter and the per-puff overdraw on heavy salvos. */
  readonly smokeTrails: BooleanSetting;
  /** Smoke-puff edge style. Off (default): legacy hard-edged translucent
   *  spheres. On: soft fog-style radial fade so puffs read as soft blobs.
   *  Purely a SmokeTrail3D shader swap; no effect when `smokeTrails` is
   *  off. */
  readonly smokeSoftEdges: BooleanSetting;
  /** Client-side entity grounding shadows in the shared world coverage
   *  texture. Presentation only; disabling also skips shadow packet work. */
  readonly entityShadows: BooleanSetting;
  /** Local presentation of shield panels, spheres, and impact flashes. */
  readonly forceFieldsVisible: BooleanSetting;
  /** World-attached fog-of-war shade over terrain and environment props.
   *  Presentation only; battle-level fog still owns authoritative
   *  visibility and snapshot filtering. */
  readonly fogShade: BooleanSetting;
  /** Client-only death material breakup: fire blast plus blast-biased
   *  motion of the entity's actual textured render parts. Does not affect
   *  authoritative death, damage, or knockback. */
  readonly materialExplosions: BooleanSetting;
  readonly triangleDebug: BooleanSetting;
  /** Draws the actual indexed triangle edges in the rendered water mesh. */
  readonly waterTriangleDebug: BooleanSetting;
  readonly wallTriangleDebug: BooleanSetting;
  /** Exclusive whole-map build-square availability view. All modes are
   *  projected onto the terrain mesh, including submerged seabed terrain. */
  readonly buildGridDebug: LabeledOptionsConfig<BuildGridDebugMode>;
  /** Draws level-1 hierarchical pathfinding chunk boundaries and nominal
   *  representative centers over the terrain. */
  readonly pathingHierarchyDebug: BooleanSetting;
  /** Draws selected units' configured surface-lift probe points and
   *  vertical lines to the sampled terrain/water/support surface. */
  readonly airLiftProbeDebug: BooleanSetting;
  /** Shows the exact center + two eight-point terrain sample rings used by
   *  the most recent relative camera zoom event. */
  readonly zoomPointsDebug: BooleanSetting;
  readonly metalMap: BooleanSetting;
  readonly elevationMap: BooleanSetting;
  readonly pathingMap: BooleanSetting;
  readonly pathingDebugUnit: DefaultSetting<PathingDebugUnitId>;
  /** Exclusive selected-unit pathability overlay. WAYPOINT shows cells where
   * orders may terminate; MOVE shows every physically traversable cell. */
  readonly pathingDebugMode: DefaultSetting<PathingDebugMode>;
  /** Draws the local player's current sight/sensor boundary on the
   *  terrain. This is a presentation/debug overlay only; authoritative
   *  fog filtering still lives on the host. */
  readonly sightBoundary: BooleanSetting;
  /** Draws the local player's radar-level coverage boundary on the
   *  terrain. Radar-level coverage includes all full-sight coverage
   *  plus radar-only sensor coverage. */
  readonly radarBoundary: BooleanSetting;
  /** Per-frame unit ground normal EMA on the client. Layered on top of
   *  the HOST SERVER unit ground normal EMA. Uses DriftMode
   *  (snap / fast / mid / slow). */
  readonly unitGroundNormalEma: LabeledOptionsConfig<DriftMode>;
  readonly legsRadius: BooleanSetting;
  /** Draws each leg's hip-centered mechanical reach sphere and its
   *  authored hip-to-rest direction. */
  readonly legsReach: BooleanSetting;
  readonly cameraSmooth: LabeledOptionsConfig<CameraSmoothMode>;
  readonly cameraFollow: LabeledOptionsConfig<CameraFollowMode>;
  readonly cameraFov: LabeledOptionsConfig<CameraFovDegrees>;
  readonly waterBoundaryMode: LabeledOptionsConfig<WaterBoundaryMode>;
  readonly dragPan: BooleanSetting;
  readonly sounds: DefaultSetting<SoundDefaults>;
  readonly rangeToggles: BooleanSetting;
  /** One default for the whole unified VOLUMES group. */
  readonly volumeToggles: BooleanSetting;
  readonly lobbyVisible: DefaultSetting<PlatformBooleanDefaults>;
  readonly waypointDetail: LabeledOptionsConfig<WaypointDetail>;
  /** Per-entity-type HUD element toggles (name / health bar /
   *  construction-progress bars). Persisted as a single JSON blob,
   *  like `sounds`. */
  readonly entityHud: DefaultSetting<EntityHudToggles>;
  /** Global tri-state for HUD elements on the current selection.
   *  ALL / OFF / DMG (whenNotFull). */
  readonly selectionHudMode: LabeledOptionsConfig<SelectionHudMode>;
  readonly telemetryBudgets: ClientTelemetryBudgets;
};
