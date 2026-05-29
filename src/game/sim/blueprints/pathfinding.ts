/**
 * Pathfinding blueprints.
 *
 * Locomotion blueprints reference these by pathfindingBlueprintId so physical
 * movement style and path traversal rules stay separately tunable.
 */

import rawPathfindingBlueprints from './pathfindingConfig.json';
import type { PathfindingBlueprint } from './types';
import { assertExplicitFields } from './jsonValidation';

export const PATHFINDING_BLUEPRINTS =
  rawPathfindingBlueprints as Record<string, PathfindingBlueprint>;

const PATHFINDING_EXPLICIT_FIELDS = [
  'pathfindingBlueprintId',
  'terrainMode',
  'maxSlopeDeg',
] as const;

for (const [id, blueprint] of Object.entries(PATHFINDING_BLUEPRINTS)) {
  assertExplicitFields(`pathfinding blueprint ${id}`, blueprint, PATHFINDING_EXPLICIT_FIELDS);
  if (blueprint.pathfindingBlueprintId !== id) {
    throw new Error(
      `Pathfinding blueprint key mismatch: key '${id}' has pathfindingBlueprintId '${blueprint.pathfindingBlueprintId}'`,
    );
  }
  if (blueprint.terrainMode !== 'land' && blueprint.terrainMode !== 'anywhere') {
    throw new Error(
      `Invalid pathfinding blueprint ${id}: terrainMode must be "land" or "anywhere"`,
    );
  }
  if (blueprint.terrainMode === 'land') {
    const maxSlopeDeg = blueprint.maxSlopeDeg;
    if (
      typeof maxSlopeDeg !== 'number' ||
      !Number.isFinite(maxSlopeDeg) ||
      maxSlopeDeg <= 0 ||
      maxSlopeDeg >= 90
    ) {
      throw new Error(
        `Invalid pathfinding blueprint ${id}: land maxSlopeDeg must be finite degrees in (0, 90)`,
      );
    }
  } else if (blueprint.maxSlopeDeg !== null) {
    throw new Error(
      `Invalid pathfinding blueprint ${id}: anywhere maxSlopeDeg must be null because terrain is ignored`,
    );
  }
}
