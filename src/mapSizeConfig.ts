export type MapDimensionAxisOption = {
  readonly valueLandCells: number;
  readonly label: string;
};

export type MapLandCellDimensions = {
  readonly widthLandCells: number;
  readonly lengthLandCells: number;
};

export type MapDimensionAxisConfig = {
  readonly default: number;
  readonly options: readonly MapDimensionAxisOption[];
};

// Canonical 2D land partition size. All broad ground-space systems
// should derive from this: host spatial-grid XY columns, capture/mana
// tiles, terrain/water tiles, and player-client object LOD cells.
export const LAND_CELL_SIZE = 200;

/** Single source for map-size option generation. Width and length both use
 *  this same base cell count, then grow by 1.5x per option. Keep generated
 *  sizes odd so maps have exactly one central land/mana cell. */
export const MAP_DIMENSION_BASE_LAND_CELLS = 7;
const MAP_DIMENSION_AXIS_GROWTH = 1.5;
const MAP_DIMENSION_AXIS_OPTION_COUNT = 8;

const DEFAULT_MAP_WIDTH_LAND_CELLS_VALUE = 53;
const DEFAULT_MAP_LENGTH_LAND_CELLS_VALUE = 35;

/** Fraction of the total map width/length used by generated radial
 *  terrain/layout features. The remaining outer band is buffer space
 *  around the playable/generated oval. */
export const MAP_GENERATION_EXTENT_FRACTION = 0.85;

/** Round a land-cell axis count to the nearest positive odd integer.
 *  Map dimensions are required to be odd so every map has exactly
 *  one central land/mana cell. */
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
export function assertOddPositiveLandCellAxis(label: string, value: number): void {
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

export const DEFAULT_MAP_WIDTH_LAND_CELLS = validateDefaultMapDimension(
  'width',
  DEFAULT_MAP_WIDTH_LAND_CELLS_VALUE,
);
export const DEFAULT_MAP_LENGTH_LAND_CELLS = validateDefaultMapDimension(
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
