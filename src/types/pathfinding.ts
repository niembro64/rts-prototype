export const PATHFINDING_CELL_CONSOLIDATION_OPTIONS = [1, 2, 3, 4, 5] as const;

export type PathfindingCellConsolidationMultiplier =
  (typeof PATHFINDING_CELL_CONSOLIDATION_OPTIONS)[number];

export const DEFAULT_PATHFINDING_CELL_CONSOLIDATION_MULTIPLIER:
  PathfindingCellConsolidationMultiplier = 3;

export function isPathfindingCellConsolidationMultiplier(
  value: unknown,
): value is PathfindingCellConsolidationMultiplier {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    PATHFINDING_CELL_CONSOLIDATION_OPTIONS.includes(
      value as PathfindingCellConsolidationMultiplier,
    );
}

export function normalizePathfindingCellConsolidationMultiplier(
  value: unknown,
): PathfindingCellConsolidationMultiplier {
  return isPathfindingCellConsolidationMultiplier(value)
    ? value
    : DEFAULT_PATHFINDING_CELL_CONSOLIDATION_MULTIPLIER;
}
