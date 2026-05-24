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

type JsonLocomotionBlueprint = Omit<LocomotionBlueprint, 'pathfinding'>;

function buildLocomotionBlueprints(): Record<string, LocomotionBlueprint> {
  const raw = rawLocomotionBlueprints as Record<string, JsonLocomotionBlueprint>;
  const blueprints: Record<string, LocomotionBlueprint> = {};

  for (const [id, blueprint] of Object.entries(raw)) {
    if (!blueprint || typeof blueprint.type !== 'string') {
      throw new Error(`Invalid locomotion blueprint ${id}: missing type`);
    }
    if (typeof blueprint.pathfindingId !== 'string' || blueprint.pathfindingId.length === 0) {
      throw new Error(`Invalid locomotion blueprint ${id}: missing pathfindingId`);
    }
    const pathfinding = PATHFINDING_BLUEPRINTS[blueprint.pathfindingId];
    if (pathfinding === undefined) {
      throw new Error(
        `Invalid locomotion blueprint ${id}: unknown pathfindingId "${blueprint.pathfindingId}"`,
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
