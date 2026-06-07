import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotGridCell,
} from './NetworkManager';
import {
  createFloat64WireRows,
  reserveFloat64WireRows,
  type Float64WireRows,
} from './snapshotWireRows';

export const GRID_CELL_WIRE_STRIDE = 4;

export type GridSnapshotWireSource = {
  cells: Float64WireRows;
  searchCells: Float64WireRows;
};

const gridBuf: NonNullable<NetworkServerSnapshot['grid']> = {
  cells: [],
  searchCells: [],
  cellSize: 0,
};
const directGridBuf: NonNullable<NetworkServerSnapshot['grid']> = {
  cells: [],
  searchCells: [],
  cellSize: 0,
};
const gridWireSource: GridSnapshotWireSource = {
  cells: createFloat64WireRows(),
  searchCells: createFloat64WireRows(),
};
const directGridWireSource: GridSnapshotWireSource = {
  cells: createFloat64WireRows(),
  searchCells: createFloat64WireRows(),
};
const gridWireSources = new WeakMap<object, GridSnapshotWireSource>();

function playerMask(players: readonly number[]): number {
  let mask = 0;
  for (let i = 0; i < players.length; i++) {
    const playerId = players[i];
    if (playerId >= 1 && playerId <= 31) mask |= 1 << (playerId - 1);
  }
  return mask >>> 0;
}

function appendGridCellWireRow(
  rows: Float64WireRows,
  cell: NetworkServerSnapshotGridCell,
): void {
  const rowIndex = reserveFloat64WireRows(rows, 1, GRID_CELL_WIRE_STRIDE);
  const values = rows.values;
  const base = rowIndex * GRID_CELL_WIRE_STRIDE;
  values[base + 0] = cell.cell.x;
  values[base + 1] = cell.cell.y;
  values[base + 2] = cell.cell.z;
  values[base + 3] = playerMask(cell.players);
}

function writeGridCellRows(
  rows: Float64WireRows,
  cells: readonly NetworkServerSnapshotGridCell[] | undefined,
): number {
  rows.count = 0;
  if (cells === undefined) return 0;
  for (let i = 0; i < cells.length; i++) {
    appendGridCellWireRow(rows, cells[i]);
  }
  return rows.count;
}

export function getGridSnapshotWireSource(
  grid: NonNullable<NetworkServerSnapshot['grid']>,
): GridSnapshotWireSource | undefined {
  return gridWireSources.get(grid);
}

export function serializeGridSnapshot(
  gridCells: NetworkServerSnapshotGridCell[] | undefined,
  gridSearchCells: NetworkServerSnapshotGridCell[] | undefined,
  gridCellSize: number | undefined,
): NonNullable<NetworkServerSnapshot['grid']> | undefined {
  if (gridCells === undefined) return undefined;

  gridBuf.cells = gridCells;
  gridBuf.searchCells = gridSearchCells ?? [];
  gridBuf.cellSize = gridCellSize ?? 0;
  writeGridCellRows(gridWireSource.cells, gridCells);
  writeGridCellRows(gridWireSource.searchCells, gridSearchCells);
  gridWireSources.set(gridBuf, gridWireSource);
  return gridBuf;
}

export function writeGridSnapshotWireRowsDirect(
  gridCells: NetworkServerSnapshotGridCell[] | undefined,
  gridSearchCells: NetworkServerSnapshotGridCell[] | undefined,
  gridCellSize: number | undefined,
  cellPlaceholders: NetworkServerSnapshotGridCell[],
  searchCellPlaceholders: NetworkServerSnapshotGridCell[],
): NonNullable<NetworkServerSnapshot['grid']> | undefined {
  cellPlaceholders.length = 0;
  searchCellPlaceholders.length = 0;
  if (gridCells === undefined) return undefined;

  const cellCount = writeGridCellRows(directGridWireSource.cells, gridCells);
  const searchCellCount = writeGridCellRows(directGridWireSource.searchCells, gridSearchCells);
  cellPlaceholders.length = cellCount;
  searchCellPlaceholders.length = searchCellCount;
  directGridBuf.cells = cellPlaceholders;
  directGridBuf.searchCells = searchCellPlaceholders;
  directGridBuf.cellSize = gridCellSize ?? 0;
  gridWireSources.set(directGridBuf, directGridWireSource);
  return directGridBuf;
}
