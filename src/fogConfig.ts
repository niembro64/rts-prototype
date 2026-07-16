import rawFogConfig from './fogConfig.json';

type FogPresentationConfig = {
  enabledByDefault: boolean;
  coverage: {
    cellSizeWorld: number;
  };
  shade: {
    colorHex: string;
    unseenDarknessPercent: number;
    radarDarknessPercent: number;
    unseenColorLossPercent: number;
    radarColorLossPercent: number;
    edgeSoftnessWorld: number;
  };
};

type FogConfig = {
  presentation: FogPresentationConfig;
};

const FOG_CONFIG_RAW = rawFogConfig as FogConfig;
const presentation = FOG_CONFIG_RAW.presentation;

assertBoolean(presentation.enabledByDefault, 'fogConfig.presentation.enabledByDefault');
assertPositive(presentation.coverage.cellSizeWorld, 'fogConfig.presentation.coverage.cellSizeWorld');
assertCssHex(presentation.shade.colorHex, 'fogConfig.presentation.shade.colorHex');
assertPercent(presentation.shade.unseenDarknessPercent, 'fogConfig.presentation.shade.unseenDarknessPercent');
assertPercent(presentation.shade.radarDarknessPercent, 'fogConfig.presentation.shade.radarDarknessPercent');
assertPercent(presentation.shade.unseenColorLossPercent, 'fogConfig.presentation.shade.unseenColorLossPercent');
assertPercent(presentation.shade.radarColorLossPercent, 'fogConfig.presentation.shade.radarColorLossPercent');
assertNonNegative(presentation.shade.edgeSoftnessWorld, 'fogConfig.presentation.shade.edgeSoftnessWorld');
export const FOG_CONFIG = FOG_CONFIG_RAW;

function assertBoolean(value: unknown, fieldName: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw new Error(`${fieldName} must be a boolean`);
}

function assertPositive(value: unknown, fieldName: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive finite number`);
  }
}

function assertNonNegative(value: unknown, fieldName: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative finite number`);
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
