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

/** Single source for map-size option generation. Width and length both use
 *  this same base cell count, then grow by 1.5x per option. Keep generated
 *  sizes odd so maps have exactly one central land/mana cell. */
export const MAP_DIMENSION_BASE_LAND_CELLS = 15;
const MAP_DIMENSION_AXIS_GROWTH = 1.5;
const MAP_DIMENSION_AXIS_OPTION_COUNT = 8;

const DEFAULT_MAP_WIDTH_LAND_CELLS_VALUE = 113;
const DEFAULT_MAP_LENGTH_LAND_CELLS_VALUE = 75;

/** Fraction of the total map width/length used by generated radial
 *  terrain/layout features. The remaining outer band is buffer space
 *  around the playable/generated oval. */
export const MAP_GENERATION_EXTENT_FRACTION = 0.85;

function nearestOddLandCellCount(value: number): number {
  const floor = Math.floor(value);
  const lowerOdd = floor % 2 === 1 ? floor : floor - 1;
  const ceil = Math.ceil(value);
  const upperOdd = ceil % 2 === 1 ? ceil : ceil + 1;
  const lowerDistance = Math.abs(value - lowerOdd);
  const upperDistance = Math.abs(value - upperOdd);
  return Math.max(1, lowerDistance <= upperDistance ? lowerOdd : upperOdd);
}

function buildMapDimensionAxisValues(): readonly number[] {
  if (
    !Number.isInteger(MAP_DIMENSION_BASE_LAND_CELLS) ||
    MAP_DIMENSION_BASE_LAND_CELLS <= 0 ||
    MAP_DIMENSION_BASE_LAND_CELLS % 2 !== 1
  ) {
    throw new Error(
      `MAP_DIMENSION_BASE_LAND_CELLS must be a positive odd integer; got ${MAP_DIMENSION_BASE_LAND_CELLS}`,
    );
  }

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
