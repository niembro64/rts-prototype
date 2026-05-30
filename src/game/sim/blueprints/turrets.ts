/**
 * Turret blueprints.
 *
 * Authored data lives in turrets.json. This module keeps the existing
 * TypeScript API as a thin resolver/validator while the data becomes
 * language-neutral for the Rust/WASM port.
 */

import { isTurretBlueprintId, type TurretBlueprintId } from '../../../types/blueprintIds';
import {
  WEAPON_KINDS,
} from '../../../types/blueprints';
import rawTurretBlueprints from './turrets.json';
import { resolveBlueprintRefs } from './jsonRefs';
import { assertExplicitFields } from './jsonValidation';
import type { LockOnExclusionObject, TurretBlueprint } from './types';
import { assertNoInlineLockOnExclusionFields } from './lockOnValidation';
import {
  assertTurretLockOnExclusionConfigIds,
  getTurretLockOnExclusions,
} from './lockOnConfig';

const TURRET_EXPLICIT_FIELDS = [
  'shotBlueprintId',
  'cooldown',
  'launchForce',
  'isManualFire',
  'passive',
  'requiresNonObstructedLineOfSight',
  'spread',
  'burst',
  'forceFieldPanels',
  'audio',
  'verticalLauncher',
  'idlePitch',
  'groundAimFraction',
  'headOnly',
  'constructionEmitter',
  'kind',
] as const;

const WEAPON_KIND_SET: ReadonlySet<string> = new Set(WEAPON_KINDS);

type JsonTurretBlueprint = Omit<TurretBlueprint, keyof LockOnExclusionObject>;

const RESOLVED_TURRET_BLUEPRINTS = resolveBlueprintRefs(
  rawTurretBlueprints,
) as unknown as Record<TurretBlueprintId, JsonTurretBlueprint>;

assertTurretLockOnExclusionConfigIds(Object.keys(RESOLVED_TURRET_BLUEPRINTS));

export const TURRET_BLUEPRINTS = Object.fromEntries(
  Object.entries(RESOLVED_TURRET_BLUEPRINTS).map(([id, blueprint]) => {
    assertNoInlineLockOnExclusionFields(`turret blueprint ${id}`, blueprint);
    return [
      id,
      {
        ...blueprint,
        ...getTurretLockOnExclusions(id),
      },
    ];
  }),
) as Record<TurretBlueprintId, TurretBlueprint>;

export const CONSTRUCTION_TURRET_HEAD_RADIUS =
  TURRET_BLUEPRINTS.turretConstruction.radius.visual;

export function getTurretBlueprint(id: string): TurretBlueprint {
  if (!isTurretBlueprintId(id)) throw new Error(`Unknown weapon blueprint: ${id}`);
  const turretBlueprint = TURRET_BLUEPRINTS[id];
  return turretBlueprint;
}

for (const [id, blueprint] of Object.entries(TURRET_BLUEPRINTS)) {
  if (blueprint.turretBlueprintId !== id) {
    throw new Error(
      `Turret blueprint key/id mismatch: ${id} contains ${blueprint.turretBlueprintId}`,
    );
  }
  assertExplicitFields(`turret blueprint ${id}`, blueprint, TURRET_EXPLICIT_FIELDS);
  if (Object.prototype.hasOwnProperty.call(blueprint, 'forceField')) {
    throw new Error(
      `Invalid turret blueprint ${id}: forceField emission data belongs in shots.json and must be referenced by shotBlueprintId`,
    );
  }
  if (blueprint.forceFieldPanels.length > 0) {
    throw new Error(
      `Invalid turret blueprint ${id}: force-field panel geometry belongs on the host mount, not the turret blueprint`,
    );
  }

  const label = `turret blueprint ${id}`;
  if (!WEAPON_KIND_SET.has(blueprint.kind)) {
    throw new Error(
      `Invalid ${label}: kind "${blueprint.kind}" is not one of [${[...WEAPON_KIND_SET].join(', ')}]`,
    );
  }
}
