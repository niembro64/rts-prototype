import rawMapSizeConfig from './mapSizeConfig.json';

export type MapDimensionAxisOption = {
  readonly valueLandCells: number;
  readonly label: string;
};

export type MapLandCellDimensions = {
  readonly widthLandCells: number;
  readonly lengthLandCells: number;
};

type MapDimensionAxisConfig = {
  readonly default: number;
  readonly options: readonly MapDimensionAxisOption[];
};

// ── Authored map-size tuning lives in mapSizeConfig.json (Config Is Data,
//    Not Code). This module only validates the imported shape and derives
//    the option lists below from it. ──
type MapSizeConfigShape = {
  readonly landCellSize: number;
  readonly mapDimensionBaseLandCells: number;
  readonly mapDimensionAxisGrowth: number;
  readonly mapDimensionAxisOptionCount: number;
  readonly defaultMapWidthLandCells: number;
  readonly defaultMapLengthLandCells: number;
  readonly mapGenerationExtentFraction: number;
};

function requireMapSizePositiveFinite(label: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Invalid map size config ${label}: expected positive finite number, got ${value}`,
    );
  }
  return value;
}

function requireMapSizePositiveInteger(label: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `Invalid map size config ${label}: expected positive integer, got ${value}`,
    );
  }
  return value;
}

function validateMapSizeConfig(raw: MapSizeConfigShape): MapSizeConfigShape {
  requireMapSizePositiveFinite('landCellSize', raw.landCellSize);
  requireMapSizePositiveInteger('mapDimensionBaseLandCells', raw.mapDimensionBaseLandCells);
  if (!Number.isFinite(raw.mapDimensionAxisGrowth) || raw.mapDimensionAxisGrowth <= 1) {
    throw new Error(
      `Invalid map size config mapDimensionAxisGrowth: expected number > 1, got ${raw.mapDimensionAxisGrowth}`,
    );
  }
  requireMapSizePositiveInteger('mapDimensionAxisOptionCount', raw.mapDimensionAxisOptionCount);
  requireMapSizePositiveInteger('defaultMapWidthLandCells', raw.defaultMapWidthLandCells);
  requireMapSizePositiveInteger('defaultMapLengthLandCells', raw.defaultMapLengthLandCells);
  if (
    !Number.isFinite(raw.mapGenerationExtentFraction) ||
    raw.mapGenerationExtentFraction <= 0 ||
    raw.mapGenerationExtentFraction > 1
  ) {
    throw new Error(
      `Invalid map size config mapGenerationExtentFraction: expected fraction in (0, 1], got ${raw.mapGenerationExtentFraction}`,
    );
  }
  return raw;
}

const MAP_SIZE_CONFIG = validateMapSizeConfig(rawMapSizeConfig as MapSizeConfigShape);

// Canonical 2D land partition size. All broad ground-space systems
// should derive from this: host spatial-grid XY columns, capture
// tiles, terrain/water tiles, and client spatial groups.
export const LAND_CELL_SIZE: number = MAP_SIZE_CONFIG.landCellSize;

/** Single source for map-size option generation. Width and length both use
 *  this same base cell count, then grow by 1.5x per option. Keep generated
 *  sizes odd so maps have exactly one central land cell. */
const MAP_DIMENSION_BASE_LAND_CELLS: number =
  MAP_SIZE_CONFIG.mapDimensionBaseLandCells;
const MAP_DIMENSION_AXIS_GROWTH: number = MAP_SIZE_CONFIG.mapDimensionAxisGrowth;
const MAP_DIMENSION_AXIS_OPTION_COUNT: number = MAP_SIZE_CONFIG.mapDimensionAxisOptionCount;

// 7, 11, 15, 23, 35, 53, 79, 119
const DEFAULT_MAP_WIDTH_LAND_CELLS_VALUE: number = MAP_SIZE_CONFIG.defaultMapWidthLandCells;
const DEFAULT_MAP_LENGTH_LAND_CELLS_VALUE: number = MAP_SIZE_CONFIG.defaultMapLengthLandCells;

/** Fraction of the total map width/length used by generated radial
 *  terrain/layout features. The remaining outer band is buffer space
 *  around the playable/generated oval. */
export const MAP_GENERATION_EXTENT_FRACTION: number =
  MAP_SIZE_CONFIG.mapGenerationExtentFraction;

/** Round a land-cell axis count to the nearest positive odd integer.
 *  Map dimensions are required to be odd so every map has exactly
 *  one central land cell. */
export function nearestOddLandCellCount(value: number): number {
  const floor = Math.floor(value);
  const lowerOdd = floor % 2 === 1 ? floor : floor - 1;
  const ceil = Math.ceil(value);
  const upperOdd = ceil % 2 === 1 ? ceil : ceil + 1;
  const lowerDistance = Math.abs(value - lowerOdd);
  const upperDistance = Math.abs(value - upperOdd);
  return Math.max(1, lowerDistance <= upperDistance ? lowerOdd : upperOdd);
}

/** Hard-fail dev guard: a land-cell axis value must be a positive
 *  odd integer. Maps need exactly one central cell, which requires
 *  odd cell counts on both axes. */
function assertOddPositiveLandCellAxis(label: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0 || value % 2 !== 1) {
    throw new Error(
      `${label} (${value}) must be a positive odd integer (one central land cell required)`,
    );
  }
}

function buildMapDimensionAxisValues(): readonly number[] {
  assertOddPositiveLandCellAxis(
    'MAP_DIMENSION_BASE_LAND_CELLS',
    MAP_DIMENSION_BASE_LAND_CELLS,
  );

  const values: number[] = [];
  let value = MAP_DIMENSION_BASE_LAND_CELLS;
  for (let i = 0; i < MAP_DIMENSION_AXIS_OPTION_COUNT; i += 1) {
    const oddValue =
      i === 0 ? MAP_DIMENSION_BASE_LAND_CELLS : nearestOddLandCellCount(value);
    if (values[values.length - 1] !== oddValue) values.push(oddValue);
    value *= MAP_DIMENSION_AXIS_GROWTH;
  }
  return values;
}

const MAP_DIMENSION_AXIS_VALUES = buildMapDimensionAxisValues();

function validateDefaultMapDimension(axis: 'width' | 'length', valueLandCells: number): number {
  // Two-stage check: must be a valid land-cell axis value (odd
  // positive int — landGrid invariant) AND must appear in the
  // generated option list (so the lobby UI button matches the
  // persisted default).
  assertOddPositiveLandCellAxis(`Default map ${axis}`, valueLandCells);
  if (!MAP_DIMENSION_AXIS_VALUES.includes(valueLandCells)) {
    throw new Error(
      `Default map ${axis} (${valueLandCells}) must be one of ` +
        `MAP_DIMENSION_AXIS_VALUES: ${MAP_DIMENSION_AXIS_VALUES.join(', ')}`,
    );
  }
  return valueLandCells;
}

const DEFAULT_MAP_WIDTH_LAND_CELLS = validateDefaultMapDimension(
  'width',
  DEFAULT_MAP_WIDTH_LAND_CELLS_VALUE,
);
const DEFAULT_MAP_LENGTH_LAND_CELLS = validateDefaultMapDimension(
  'length',
  DEFAULT_MAP_LENGTH_LAND_CELLS_VALUE,
);

const MAP_DIMENSION_AXIS_OPTIONS: readonly MapDimensionAxisOption[] =
  MAP_DIMENSION_AXIS_VALUES.map((valueLandCells) => ({
    valueLandCells,
    label: String(valueLandCells),
  }));

export const MAP_DIMENSION_CONFIG = {
  width: {
    /** Default map width in canonical LAND_CELL_SIZE cells. */
    default: DEFAULT_MAP_WIDTH_LAND_CELLS,
    options: MAP_DIMENSION_AXIS_OPTIONS,
  },
  length: {
    /** Default map length in canonical LAND_CELL_SIZE cells. */
    default: DEFAULT_MAP_LENGTH_LAND_CELLS,
    options: MAP_DIMENSION_AXIS_OPTIONS,
  },
} as const satisfies {
  readonly width: MapDimensionAxisConfig;
  readonly length: MapDimensionAxisConfig;
};
