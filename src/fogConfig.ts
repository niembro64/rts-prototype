import rawFogConfig from './fogConfig.json';

type FogPresentationConfig = {
  enabledByDefault: boolean;
  coverage: {
    supersample: number;
    maxTextureDimension: number;
    maxRegions: number;
    distanceFieldFeatherPixels: number;
    edgeSoftnessPixels: number;
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
assertPositive(
  presentation.coverage.distanceFieldFeatherPixels,
  'fogConfig.presentation.coverage.distanceFieldFeatherPixels',
);
assertPositive(
  presentation.coverage.edgeSoftnessPixels,
  'fogConfig.presentation.coverage.edgeSoftnessPixels',
);
assertCssHex(presentation.shade.colorHex, 'fogConfig.presentation.shade.colorHex');
assertPercent(presentation.shade.unseenDarknessPercent, 'fogConfig.presentation.shade.unseenDarknessPercent');
assertPercent(presentation.shade.radarDarknessPercent, 'fogConfig.presentation.shade.radarDarknessPercent');
assertPercent(presentation.shade.unseenColorLossPercent, 'fogConfig.presentation.shade.unseenColorLossPercent');
assertPercent(presentation.shade.radarColorLossPercent, 'fogConfig.presentation.shade.radarColorLossPercent');
export const FOG_CONFIG = FOG_CONFIG_RAW;

function assertBoolean(value: unknown, fieldName: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw new Error(`${fieldName} must be a boolean`);
}

function assertPositive(value: unknown, fieldName: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive finite number`);
  }
}

function assertPositiveInteger(value: unknown, fieldName: string): asserts value is number {
  assertPositive(value, fieldName);
  if (!Number.isInteger(value)) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
}

function assertPercent(value: unknown, fieldName: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${fieldName} must be a finite number from 0 through 100`);
  }
}

function assertCssHex(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`${fieldName} must be a six-digit CSS hex color`);
  }
}
