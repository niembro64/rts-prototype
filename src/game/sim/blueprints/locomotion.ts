/**
 * Locomotion blueprints.
 *
 * Authored locomotion data lives in locomotion.json. Runtime systems
 * still consume the existing TypeScript export while Rust/WASM gains a
 * direct data file to load.
 */

import rawLocomotionBlueprints from './locomotion.json';
import type { LocomotionBlueprint } from './types';
import { PATHFINDING_BLUEPRINTS } from './pathfinding';
import { isLocomotionBlueprintId } from '../../../types/blueprintIds';
import { assertValidEntityBaseLedger } from './entityBaseLedger';

type JsonLocomotionBlueprint = Omit<LocomotionBlueprint, 'pathfinding'>;

function buildLocomotionBlueprints(): Record<string, LocomotionBlueprint> {
  const raw = rawLocomotionBlueprints as Record<string, JsonLocomotionBlueprint>;
  const blueprints: Record<string, LocomotionBlueprint> = {};

  for (const [id, blueprint] of Object.entries(raw)) {
    if (!blueprint || typeof blueprint.type !== 'string') {
      throw new Error(`Invalid locomotion blueprint ${id}: missing type`);
    }
    if (!isLocomotionBlueprintId(id)) {
      throw new Error(`Invalid locomotion blueprint ${id}: id is not in stable blueprintIds`);
    }
    if (blueprint.locomotionBlueprintId !== id) {
      throw new Error(
        `Locomotion blueprint key/id mismatch: ${id} contains ${blueprint.locomotionBlueprintId}`,
      );
    }
    assertValidEntityBaseLedger(`locomotion blueprint ${id}`, blueprint.base);
    if (
      typeof blueprint.pathfindingBlueprintId !== 'string' ||
      blueprint.pathfindingBlueprintId.length === 0
    ) {
      throw new Error(`Invalid locomotion blueprint ${id}: missing pathfindingBlueprintId`);
    }
    const pathfinding = PATHFINDING_BLUEPRINTS[blueprint.pathfindingBlueprintId];
    if (pathfinding === undefined) {
      throw new Error(
        `Invalid locomotion blueprint ${id}: unknown pathfindingBlueprintId "${blueprint.pathfindingBlueprintId}"`,
      );
    }
    if (
      !blueprint.physics ||
      !Number.isFinite(blueprint.physics.driveForce) ||
      blueprint.physics.driveForce <= 0
    ) {
      throw new Error(`Invalid locomotion blueprint ${id}: driveForce must be positive`);
    }
    if (Object.prototype.hasOwnProperty.call(blueprint.physics, 'maxSlopeDeg')) {
      throw new Error(
        `Invalid locomotion blueprint ${id}: physics.maxSlopeDeg moved to pathfindingConfig.json`,
      );
    }
    blueprints[id] = {
      ...blueprint,
      pathfinding,
    } as LocomotionBlueprint;
  }

  return blueprints;
}

export const UNIT_LOCOMOTION_BLUEPRINTS = buildLocomotionBlueprints();
