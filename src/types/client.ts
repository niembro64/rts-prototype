import type {
  DefaultSetting,
  BooleanSetting,
  LabeledOptionsConfig,
  PlatformBooleanDefaults,
} from './bars';
import type { ConcreteGraphicsQuality, GraphicsQuality, RenderMode } from './graphics';

export type AudioScope = 'off' | 'window' | 'padded' | 'all';
export type DriftMode = 'snap' | 'fast' | 'mid' | 'slow';
export type CameraSmoothMode = 'snap' | 'fast' | 'mid' | 'slow';
export type CameraFovDegrees = 10 | 20 | 30 | 60 | 120;
export type GridOverlay = 'off' | 'zero' | 'low' | 'medium' | 'high';
/** Waypoint visualization detail. SIMPLE shows only the user-issued
 *  click points and shortcut lines between them — the convention in
 *  most RTS games. DETAILED shows every intermediate waypoint that
 *  the pathfinder inserted along the route, so the player can see
 *  how units route around obstacles. */
export type WaypointDetail = 'simple' | 'detailed';
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
export type UnitRadiusType = 'visual' | 'shot' | 'push';

export type SoundDefaults = Record<SoundCategory, boolean>;

export type ClientBarConfig = {
  readonly graphics: LabeledOptionsConfig<
    ConcreteGraphicsQuality,
    GraphicsQuality
  >;
  readonly render: LabeledOptionsConfig<RenderMode>;
  readonly audio: LabeledOptionsConfig<Exclude<AudioScope, 'off'>>;
  readonly audioSmoothing: BooleanSetting;
  /** Single toggle gating ALL ground-plane marks: beam/laser scorches
   *  drawn by BurnMark3D AND wheel/tread/foot prints drawn by
   *  GroundPrint3D. Off by default — turning it on enables every mark
   *  type at once (LOD tiers still cap density). */
  readonly groundMarks: BooleanSetting;
  /** When ON, the BeamRenderer overrides the first beam segment's
   *  start with the live world position of the firing barrel's tip,
   *  sampled from the same matrix chain that places the rendered
   *  cylinder. Eliminates the small gap between the visible barrel
   *  mouth and the beam origin caused by sim/render pose desync
   *  (chassis-tilt EMA, turret yaw/pitch prediction, snapshot-vertex
   *  linearization). */
  readonly beamSnapToBarrel: BooleanSetting;
  readonly lodShellRings: BooleanSetting;
  readonly lodGridBorders: BooleanSetting;
  readonly triangleDebug: BooleanSetting;
  readonly buildGridDebug: BooleanSetting;
  /** "BASE" toggle: when on, the chosen MIN/LOW/MED/HI/MAX tier is
   *  applied to every entity uniformly (camera-sphere distance
   *  resolution disabled). When off (default), tiers behave as today
   *  — they cap a per-entity object-tier resolved from camera distance. */
  readonly baseLodMode: BooleanSetting;
  readonly driftMode: DefaultSetting<DriftMode>;
  /** Per-frame chassis-tilt EMA on the client. Layered on top of the
   *  HOST SERVER tilt EMA. Same SNAP/FAST/MID/SLOW shape as
   *  driftMode (DriftMode) so the half-life table is reused. */
  readonly tiltEma: LabeledOptionsConfig<DriftMode>;
  readonly legsRadius: BooleanSetting;
  readonly cameraSmooth: LabeledOptionsConfig<CameraSmoothMode>;
  readonly cameraFov: LabeledOptionsConfig<CameraFovDegrees>;
  readonly edgeScroll: BooleanSetting;
  readonly dragPan: BooleanSetting;
  readonly sounds: DefaultSetting<SoundDefaults>;
  readonly rangeToggles: BooleanSetting;
  readonly projRangeToggles: BooleanSetting;
  readonly unitRadiusToggles: BooleanSetting;
  readonly lobbyVisible: DefaultSetting<PlatformBooleanDefaults>;
  readonly unitCapFallback: DefaultSetting<number>;
  readonly gridOverlay: LabeledOptionsConfig<GridOverlay>;
  readonly waypointDetail: LabeledOptionsConfig<WaypointDetail>;
};
