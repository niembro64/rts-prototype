/**
 * Pathfinding blueprints.
 *
 * Locomotion blueprints reference these by pathfindingBlueprintId so physical
 * movement style and route-domain policy stay separately tunable. Ground
 * slope capability is deliberately derived from authoritative physics.
 */

import rawPathfindingBlueprints from './pathfindingConfig.json';
import type { PathfindingBlueprint } from './types';
import { assertExplicitFields } from './jsonValidation';

export const PATHFINDING_BLUEPRINTS =
  rawPathfindingBlueprints as Record<string, PathfindingBlueprint>;

const PATHFINDING_EXPLICIT_FIELDS = [
  'pathfindingBlueprintId',
  'terrainMode',
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
}
