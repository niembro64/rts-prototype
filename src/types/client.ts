import type {
  DefaultSetting,
  BooleanSetting,
  LabeledOptionsConfig,
  PlatformBooleanDefaults,
} from './bars';
import type { RenderMode } from './graphics';

export type AudioScope = 'off' | 'window' | 'padded' | 'all';
export type MasterVolumePercent = number;
/** Legacy four-mode smoothing space (snap / fast / mid / slow) still
 *  used by the unit ground normal EMA and the camera-smoothing knob.
 *  Per-channel snapshot drift uses PositionDriftChannelMode /
 *  DriftChannelMode below (renames 'mid' → 'medium'). */
export type DriftMode = 'snap' | 'fast' | 'mid' | 'slow';
/** Position-channel drift smoothing mode. Position channels always
 *  apply authoritative correction; they can snap or EMA, but cannot
 *  ignore the latest stored snapshot value. */
export type PositionDriftChannelMode = 'snap' | 'fast' | 'medium' | 'slow';
/** Per-channel drift smoothing mode. Velocity channels add an
 *  'ignore' option because letting prediction keep its current
 *  derivative is meaningful there:
 *    ignore — never apply the stored snapshot value for this channel
 *             to the rendered entity. Prediction (if any) keeps
 *             running from the last applied value forever.
 *    snap   — every client tick, replace the rendered value with the
 *             latest stored snapshot value for this channel. No EMA.
 *    fast/medium/slow — every client tick, EMA the rendered value
 *             toward the latest stored snapshot value using a
 *             frame-rate-independent half-life (smaller = snappier,
 *             larger = softer).
 *  The most recent server snapshot for each channel is always stored;
 *  the per-channel mode controls only what to do with it per tick. */
export type DriftChannelMode = 'ignore' | PositionDriftChannelMode;
/** Client-side prediction physics order. Selected on the PLAYER
 *  CLIENT bar; the prediction integrator reads it before stepping
 *  position each frame.
 *    pos — snap straight to the snapshot position; do not integrate
 *          velocity. Lowest cpu, most jittery.
 *    vel — integrate position from velocity each frame. Smoothest
 *          inter-snapshot motion. The wire never carries acceleration
 *          (the server owns force inputs and only ships their
 *          integrated velocity), so there is no ACC mode. */
export type PredictionMode = 'pos' | 'vel';
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
/** Main camera vertical field of view, in degrees. Preset buttons use the
 *  configured common values, while BAR hotkeys adjust this in 5-degree steps. */
export type CameraFovDegrees = number;
/** Renderer entity LOD policy. AUTO switches between HIGH and LOW at the
 *  configured camera distance. HIGH keeps full meshes. LOW forces proxies. */
export type LodMode = 'auto' | 'high' | 'low';
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
/** Waypoint visualization detail. SIMPLE shows only the user-issued
 *  click points and shortcut lines between them — the convention in
 *  most RTS games. DETAILED shows every intermediate waypoint that
 *  the pathfinder inserted along the route, so the player can see
 *  how units route around obstacles. */
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
/** Global tri-state controlling HUD elements on the CURRENT SELECTION,
 *  overriding the per-type entity-HUD toggles for selected entities.
 *    always      — always show selection HUD elements.
 *    never       — never show them.
 *    whenNotFull — show bars only when the entity is damaged or under
 *                  construction. */
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
  /** Terrain-attached fog-of-war shade over currently unseen map areas.
   *  Presentation only; battle-level fog still owns authoritative
   *  visibility and snapshot filtering. */
  readonly fogShade: BooleanSetting;
  /** Soft fog-of-war cloud puffs. This is presentation only; the BATTLE
   *  fog-of-war control still owns authoritative visibility, snapshot
   *  filtering, and what enemy entity data reaches the client. */
  readonly fogClouds: BooleanSetting;
  /** Client-only death material breakup: death fire puff plus part-based
   *  Debris3D chunks. Does not affect authoritative death, damage,
   *  knockback, or the dying shell materialization fade. */
  readonly materialExplosions: BooleanSetting;
  readonly beamSnapToTurret: BooleanSetting;
  readonly triangleDebug: BooleanSetting;
  readonly wallTriangleDebug: BooleanSetting;
  readonly buildGridDebug: BooleanSetting;
  /** Draws selected hover/flying unit air-lift height probe points and
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
  /** Per-channel client-side drift EMAs. Position channels select from
   *  snap / fast / medium / slow. Velocity channels also allow ignore.
   *  The rendered entity always stores the most recent snapshot value
   *  for the channel; the mode decides per tick how to apply it. */
  readonly movementPosEma: LabeledOptionsConfig<PositionDriftChannelMode>;
  readonly movementVelEma: LabeledOptionsConfig<DriftChannelMode>;
  readonly rotationPosEma: LabeledOptionsConfig<PositionDriftChannelMode>;
  readonly rotationVelEma: LabeledOptionsConfig<DriftChannelMode>;
  /** Prediction physics order — POS / VEL. See PredictionMode for
   *  semantics. Default 'vel' integrates position from the last-seen
   *  velocity. There is no ACC mode (the wire does not carry
   *  acceleration). */
  readonly predictionMode: LabeledOptionsConfig<PredictionMode>;
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
};
