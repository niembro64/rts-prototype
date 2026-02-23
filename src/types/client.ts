import type {
  DefaultSetting,
  BooleanSetting,
  LabeledOptionsConfig,
  PlatformBooleanDefaults,
} from './bars';
import type { GraphicsQuality, RenderMode } from './graphics';

export type AudioScope = 'off' | 'window' | 'padded' | 'all';
export type DriftMode = 'snap' | 'fast' | 'slow';
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
  | 'build';
export type ProjRangeType = 'collision' | 'primary' | 'secondary';
export type UnitRadiusType = 'visual' | 'shot' | 'push';

export type SoundDefaults = Record<SoundCategory, boolean>;

export type ClientBarConfig = {
  readonly graphics: LabeledOptionsConfig<
    Exclude<GraphicsQuality, 'auto'>,
    GraphicsQuality
  >;
  readonly render: LabeledOptionsConfig<RenderMode>;
  readonly audio: LabeledOptionsConfig<Exclude<AudioScope, 'off'>>;
  readonly audioSmoothing: BooleanSetting;
  readonly driftMode: DefaultSetting<DriftMode>;
  readonly edgeScroll: BooleanSetting;
  readonly dragPan: BooleanSetting;
  readonly sounds: DefaultSetting<SoundDefaults>;
  readonly rangeToggles: BooleanSetting;
  readonly projRangeToggles: BooleanSetting;
  readonly unitRadiusToggles: BooleanSetting;
  readonly lobbyVisible: DefaultSetting<PlatformBooleanDefaults>;
};
