import type {
  DefaultSetting,
  BooleanSetting,
  LabeledOptionsConfig,
  PlatformBooleanDefaults,
} from './bars';
import type { RenderMode } from './graphics';

export type AudioScope = 'off' | 'window' | 'padded' | 'all';
export type MasterVolumePercent = number;
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
/** Renderer visual LOD policy. AUTO follows projected screen coverage.
 *  HIGH, MEDIUM, and LOW freeze visuals at the matching authored rung. */
export type LodMode = 'auto' | 'high' | 'medium' | 'low';
/** Presentation-only treatment of the map/water boundary.
 *    infinity             — extend water and perimeter terrain to a fake horizon.
 *    floating-square      — cut off the real map and render water as a shallow
 *                           cuboid slightly larger than the map footprint.
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
export type WaypointDetail = 'simple' | 'detailed';
export type PathingDebugUnitId = 'none' | string;
/** Entity-HUD entity classes. Each maps to a renderer category that
 *  can independently show / hide its name tag, health bar, and
 *  construction-progress bars. */
export type EntityHudType =
  | 'unit'
  | 'tower'
  | 'building'
  | 'turret'
  | 'shot';
/** The three per-entity HUD elements that can be toggled. */
export type EntityHudElement = 'name' | 'healthBar' | 'buildBars';
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
export type ProjRangeType = 'collision' | 'explosion';
export type UnitRadiusType = 'other' | 'hitbox' | 'collision' | 'shotArmingRadius';

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
  readonly audioSmoothing: BooleanSetting;
  /** Beam, laser, and dgun scorch trails drawn by BurnMark3D.
   *  Default off — scorches accumulate fast in long fights and the
   *  player typically wants the live battlefield, not its history. */
  readonly burnMarks: BooleanSetting;
  /** Wheel, tread, and footstep prints drawn by GroundPrint3D from
   *  unit movement. Default on — these decay quickly and read as
   *  part of the unit silhouettes' motion. */
  readonly locomotionMarks: BooleanSetting;
  /** Smoke-puff trails behind thrust-powered projectiles (rockets,
   *  missiles) rendered by SmokeTrail3D. Default on — toggle off to
   *  cut the visual clutter and the per-puff overdraw on heavy salvos. */
  readonly smokeTrails: BooleanSetting;
  /** Smoke-puff edge style. Off (default): legacy hard-edged translucent
   *  spheres. On: soft fog-style radial fade so puffs read as soft blobs.
   *  Purely a SmokeTrail3D shader swap; no effect when `smokeTrails` is
   *  off. */
  readonly smokeSoftEdges: BooleanSetting;
  /** World-attached fog-of-war shade over terrain and environment props.
   *  Presentation only; battle-level fog still owns authoritative
   *  visibility and snapshot filtering. */
  readonly fogShade: BooleanSetting;
  /** Client-only death material breakup: death fire puff plus part-based
   *  Debris3D chunks. Does not affect authoritative death, damage,
   *  knockback, or the dying shell materialization fade. */
  readonly materialExplosions: BooleanSetting;
  readonly triangleDebug: BooleanSetting;
  readonly wallTriangleDebug: BooleanSetting;
  readonly buildGridDebug: BooleanSetting;
  /** Draws selected units' configured surface-lift probe points and
   *  vertical lines to the sampled terrain/water/support surface. */
  readonly airLiftProbeDebug: BooleanSetting;
  readonly metalMap: BooleanSetting;
  readonly elevationMap: BooleanSetting;
  readonly pathingMap: BooleanSetting;
  readonly pathingDebugUnit: DefaultSetting<PathingDebugUnitId>;
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
  readonly cameraSmooth: LabeledOptionsConfig<CameraSmoothMode>;
  readonly cameraFollow: LabeledOptionsConfig<CameraFollowMode>;
  readonly cameraFov: LabeledOptionsConfig<CameraFovDegrees>;
  readonly waterBoundaryMode: LabeledOptionsConfig<WaterBoundaryMode>;
  readonly edgeScroll: BooleanSetting;
  readonly dragPan: BooleanSetting;
  readonly sounds: DefaultSetting<SoundDefaults>;
  readonly rangeToggles: BooleanSetting;
  readonly projRangeToggles: BooleanSetting;
  readonly unitRadiusToggles: BooleanSetting;
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
