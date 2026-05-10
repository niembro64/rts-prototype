import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotGridCell,
} from './NetworkManager';

const gridBuf: NonNullable<NetworkServerSnapshot['grid']> = {
  cells: [],
  searchCells: [],
  cellSize: 0,
};

export function serializeGridSnapshot(
  gridCells?: NetworkServerSnapshotGridCell[],
  gridSearchCells?: NetworkServerSnapshotGridCell[],
  gridCellSize?: number,
): NonNullable<NetworkServerSnapshot['grid']> | undefined {
  if (!gridCells) return undefined;

  gridBuf.cells = gridCells;
  gridBuf.searchCells = gridSearchCells ?? [];
  gridBuf.cellSize = gridCellSize ?? 0;
  return gridBuf;
}
