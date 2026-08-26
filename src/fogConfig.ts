import rawFogConfig from './fogConfig.json';
import {
  assertBoolean,
  assertFiniteNumberInRange,
  assertNonNegativeFiniteNumber as assertNonNegative,
  assertPositiveFiniteNumber as assertPositive,
  assertPositiveInteger,
  assertSixDigitCssHex as assertCssHex,
} from './configValidation';

type FogPresentationConfig = {
  enabledByDefault: boolean;
  coverage: {
    supersample: number;
    maxTextureDimension: number;
    maxRegions: number;
    fullSightEdgeSoftnessWorld: number;
    contactSightEdgeSoftnessWorld: number;
    jammerEdgeSoftnessWorld: number;
    entityShadowEdgeSoftnessWorld: number;
  };
  shade: {
    colorHex: string;
    unseenDarknessPercent: number;
    radarDarknessPercent: number;
    unseenColorLossPercent: number;
    radarColorLossPercent: number;
  };
  jammerTint: {
    colorHex: string;
    opacityPercent: number;
  };
};

type FogConfig = {
  presentation: FogPresentationConfig;
};

const FOG_CONFIG_RAW = rawFogConfig as FogConfig;
const presentation = FOG_CONFIG_RAW.presentation;

assertBoolean(presentation.enabledByDefault, 'fogConfig.presentation.enabledByDefault');
assertPositive(
  presentation.coverage.supersample,
  'fogConfig.presentation.coverage.supersample',
);
assertPositiveInteger(
  presentation.coverage.maxTextureDimension,
  'fogConfig.presentation.coverage.maxTextureDimension',
);
assertPositiveInteger(
  presentation.coverage.maxRegions,
  'fogConfig.presentation.coverage.maxRegions',
);
assertNonNegative(
  presentation.coverage.fullSightEdgeSoftnessWorld,
  'fogConfig.presentation.coverage.fullSightEdgeSoftnessWorld',
);
assertNonNegative(
  presentation.coverage.contactSightEdgeSoftnessWorld,
  'fogConfig.presentation.coverage.contactSightEdgeSoftnessWorld',
);
assertNonNegative(
  presentation.coverage.jammerEdgeSoftnessWorld,
  'fogConfig.presentation.coverage.jammerEdgeSoftnessWorld',
);
assertNonNegative(
  presentation.coverage.entityShadowEdgeSoftnessWorld,
  'fogConfig.presentation.coverage.entityShadowEdgeSoftnessWorld',
);
assertCssHex(presentation.shade.colorHex, 'fogConfig.presentation.shade.colorHex');
assertFiniteNumberInRange(
  presentation.shade.unseenDarknessPercent,
  'fogConfig.presentation.shade.unseenDarknessPercent',
  0,
  100,
);
assertFiniteNumberInRange(
  presentation.shade.radarDarknessPercent,
  'fogConfig.presentation.shade.radarDarknessPercent',
  0,
  100,
);
assertFiniteNumberInRange(
  presentation.shade.unseenColorLossPercent,
  'fogConfig.presentation.shade.unseenColorLossPercent',
  0,
  100,
);
assertFiniteNumberInRange(
  presentation.shade.radarColorLossPercent,
  'fogConfig.presentation.shade.radarColorLossPercent',
  0,
  100,
);
assertCssHex(
  presentation.jammerTint.colorHex,
  'fogConfig.presentation.jammerTint.colorHex',
);
assertFiniteNumberInRange(
  presentation.jammerTint.opacityPercent,
  'fogConfig.presentation.jammerTint.opacityPercent',
  0,
  100,
);
export const FOG_CONFIG = FOG_CONFIG_RAW;
