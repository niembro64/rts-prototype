/**
 * Turret blueprints.
 *
 * Authored data lives in turrets.json. This module keeps the existing
 * TypeScript API as a thin resolver/validator while the data becomes
 * language-neutral for the Rust/WASM port.
 */

import { isTurretId, type TurretId } from '../../../types/blueprintIds';
import rawTurretBlueprints from './turrets.json';
import { resolveBlueprintRefs } from './jsonRefs';
import { assertExplicitFields } from './jsonValidation';
import type { TurretBlueprint } from './types';

const TURRET_EXPLICIT_FIELDS = [
  'projectileId',
  'cooldown',
  'launchForce',
  'isManualFire',
  'passive',
  'mountMode',
  'spread',
  'burst',
  'forceField',
  'mirrorPanels',
  'audio',
  'verticalLauncher',
  'idlePitch',
  'groundAimFraction',
  'constructionEmitter',
] as const;

export const TURRET_BLUEPRINTS = resolveBlueprintRefs(
  rawTurretBlueprints,
) as unknown as Record<TurretId, TurretBlueprint>;

export const CONSTRUCTION_TURRET_HEAD_RADIUS =
  TURRET_BLUEPRINTS.constructionTurret.radius.body;

export function getTurretBlueprint(id: string): TurretBlueprint {
  if (!isTurretId(id)) throw new Error(`Unknown weapon blueprint: ${id}`);
  const turretBlueprint = TURRET_BLUEPRINTS[id];
  return turretBlueprint;
}

for (const [id, blueprint] of Object.entries(TURRET_BLUEPRINTS)) {
  if (blueprint.id !== id) {
    throw new Error(
      `Turret blueprint key/id mismatch: ${id} contains ${blueprint.id}`,
    );
  }
  assertExplicitFields(`turret blueprint ${id}`, blueprint, TURRET_EXPLICIT_FIELDS);
}
