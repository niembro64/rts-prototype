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
  controlOptions: {
    unseenDarknessPercent: number[];
    radarDarknessPercent: number[];
    unseenColorLossPercent: number[];
    radarColorLossPercent: number[];
    edgeSoftnessWorld: number[];
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
assertPercentOptions(
  presentation.controlOptions.unseenDarknessPercent,
  'fogConfig.presentation.controlOptions.unseenDarknessPercent',
);
assertPercentOptions(
  presentation.controlOptions.radarDarknessPercent,
  'fogConfig.presentation.controlOptions.radarDarknessPercent',
);
assertPercentOptions(
  presentation.controlOptions.unseenColorLossPercent,
  'fogConfig.presentation.controlOptions.unseenColorLossPercent',
);
assertPercentOptions(
  presentation.controlOptions.radarColorLossPercent,
  'fogConfig.presentation.controlOptions.radarColorLossPercent',
);
assertNonNegativeOptions(
  presentation.controlOptions.edgeSoftnessWorld,
  'fogConfig.presentation.controlOptions.edgeSoftnessWorld',
);
assertOptionIncludes(
  presentation.controlOptions.unseenDarknessPercent,
  presentation.shade.unseenDarknessPercent,
  'fogConfig.presentation.controlOptions.unseenDarknessPercent',
);
assertOptionIncludes(
  presentation.controlOptions.radarDarknessPercent,
  presentation.shade.radarDarknessPercent,
  'fogConfig.presentation.controlOptions.radarDarknessPercent',
);
assertOptionIncludes(
  presentation.controlOptions.unseenColorLossPercent,
  presentation.shade.unseenColorLossPercent,
  'fogConfig.presentation.controlOptions.unseenColorLossPercent',
);
assertOptionIncludes(
  presentation.controlOptions.radarColorLossPercent,
  presentation.shade.radarColorLossPercent,
  'fogConfig.presentation.controlOptions.radarColorLossPercent',
);
assertOptionIncludes(
  presentation.controlOptions.edgeSoftnessWorld,
  presentation.shade.edgeSoftnessWorld,
  'fogConfig.presentation.controlOptions.edgeSoftnessWorld',
);

export const FOG_CONFIG = FOG_CONFIG_RAW;

export function fogControlOptions(values: readonly number[]): ReadonlyArray<{
  value: number;
  label: string;
}> {
  return values.map((value) => ({ value, label: String(value) }));
}

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

function assertPercentOptions(values: unknown, fieldName: string): asserts values is number[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${fieldName} must be a non-empty array`);
  }
  for (let i = 0; i < values.length; i++) assertPercent(values[i], `${fieldName}[${i}]`);
}

function assertNonNegativeOptions(values: unknown, fieldName: string): asserts values is number[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${fieldName} must be a non-empty array`);
  }
  for (let i = 0; i < values.length; i++) assertNonNegative(values[i], `${fieldName}[${i}]`);
}

function assertOptionIncludes(values: readonly number[], value: number, fieldName: string): void {
  if (!values.includes(value)) {
    throw new Error(`${fieldName} must include the authored default ${value}`);
  }
}
