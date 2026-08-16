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
    edgeSoftnessWorld: number;
  };
  shade: {
    colorHex: string;
    unseenDarknessPercent: number;
    radarDarknessPercent: number;
    unseenColorLossPercent: number;
    radarColorLossPercent: number;
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
  presentation.coverage.edgeSoftnessWorld,
  'fogConfig.presentation.coverage.edgeSoftnessWorld',
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
export const FOG_CONFIG = FOG_CONFIG_RAW;
