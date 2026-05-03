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
  readonly burnMarks: BooleanSetting;
  readonly lodShellRings: BooleanSetting;
  readonly lodGridBorders: BooleanSetting;
  readonly driftMode: DefaultSetting<DriftMode>;
  readonly legsRadius: BooleanSetting;
  readonly cameraSmooth: LabeledOptionsConfig<CameraSmoothMode>;
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
