/**
 * Turret blueprints.
 *
 * Authored data lives in turrets.json. This module keeps the existing
 * TypeScript API as a thin resolver/validator while the data becomes
 * language-neutral for the Rust/WASM port.
 */

import {
  isShotBlueprintId,
  isTurretBlueprintId,
  isUnitBlueprintId,
  type TurretBlueprintId,
} from '../../../types/blueprintIds';
import {
  WEAPON_KINDS,
} from '../../../types/blueprints';
import rawTurretBlueprints from './turrets.json';
import { resolveBlueprintRefs } from './jsonRefs';
import { assertExplicitFields, isObject } from './jsonValidation';
import type { LockOnInclusionObject, TurretBlueprint } from './types';
import { assertNoInlineLockOnInclusionFields } from './lockOnValidation';
import {
  assertTurretLockOnInclusionConfigIds,
  getTurretLockOnInclusions,
} from './lockOnConfig';

const TURRET_EXPLICIT_FIELDS = [
  'name',
  'emissionKind',
  'emissionBlueprintId',
  'rangeVolume',
  'cooldown',
  'launchForce',
  'isManualFire',
  'passive',
  'requiresNonObstructedLineOfSight',
  'spread',
  'burst',
  'shieldPanels',
  'audio',
  'verticalLauncher',
  'idlePitch',
  'groundAimFraction',
  'headOnly',
  'constructionEmitter',
  'kind',
] as const;

const WEAPON_KIND_SET: ReadonlySet<string> = new Set(WEAPON_KINDS);

type JsonTurretBlueprint = Omit<TurretBlueprint, keyof LockOnInclusionObject>;

const TURRET_COOLDOWN_FIELDS = ['duration', 'durationRandomness'] as const;
const TURRET_SUBMUNITION_EXPLICIT_FIELDS = [
  'shotBlueprintId',
  'launchForce',
  'cooldown',
  'spread',
] as const;
const TURRET_SUBMUNITION_SPREAD_FIELDS = ['angle', 'pelletCount'] as const;
const TURRET_UNIT_LAUNCHER_FIELDS = [
  'aimMode',
  'producedUnitBlueprintId',
  'autoProduce',
] as const;
const TURRET_UNIT_LAUNCHER_AIM_MODES = new Set([
  'ballistic-or-waypoint',
  'direct-target',
]);

function validateTurretCooldown(label: string, cooldown: unknown): void {
  if (cooldown === null) return;
  if (!isObject(cooldown)) {
    throw new Error(`Invalid ${label}.cooldown: expected object or null`);
  }

  assertExplicitFields(`${label}.cooldown`, cooldown, TURRET_COOLDOWN_FIELDS);
  for (const field of Object.keys(cooldown)) {
    if (!TURRET_COOLDOWN_FIELDS.includes(field as typeof TURRET_COOLDOWN_FIELDS[number])) {
      throw new Error(`Invalid ${label}.cooldown: unexpected field "${field}"`);
    }
  }

  const duration = cooldown.duration;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    throw new Error(
      `Invalid ${label}.cooldown.duration: expected finite positive milliseconds, got ${duration}`,
    );
  }

  const durationRandomness = cooldown.durationRandomness;
  if (
    typeof durationRandomness !== 'number' ||
    !Number.isFinite(durationRandomness) ||
    durationRandomness < 0 ||
    durationRandomness >= 1
  ) {
    throw new Error(
      `Invalid ${label}.cooldown.durationRandomness: expected finite [0,1), got ${durationRandomness}`,
    );
  }
}

function validateTurretSubmunitions(label: string, value: unknown): void {
  if (value == null) return;
  assertExplicitFields(label, value, TURRET_SUBMUNITION_EXPLICIT_FIELDS);
  if (!isObject(value)) throw new Error(`Invalid ${label}: expected object or null`);
  if (typeof value.shotBlueprintId !== 'string' || !isShotBlueprintId(value.shotBlueprintId)) {
    throw new Error(
      `Invalid ${label}.shotBlueprintId: unknown shot blueprint ${String(value.shotBlueprintId)}`,
    );
  }
  if (
    typeof value.launchForce !== 'number' ||
    !Number.isFinite(value.launchForce) ||
    value.launchForce < 0
  ) {
    throw new Error(`Invalid ${label}.launchForce: expected finite non-negative number`);
  }
  if (value.cooldown === null) {
    throw new Error(`Invalid ${label}.cooldown: expected object`);
  }
  validateTurretCooldown(label, value.cooldown);
  const spread = value.spread;
  assertExplicitFields(`${label}.spread`, spread, TURRET_SUBMUNITION_SPREAD_FIELDS);
  if (!isObject(spread)) throw new Error(`Invalid ${label}.spread: expected object`);
  if (
    typeof spread.angle !== 'number' ||
    !Number.isFinite(spread.angle) ||
    spread.angle < 0
  ) {
    throw new Error(`Invalid ${label}.spread.angle: expected finite non-negative radians`);
  }
  if (
    typeof spread.pelletCount !== 'number' ||
    !Number.isInteger(spread.pelletCount) ||
    spread.pelletCount <= 0
  ) {
    throw new Error(`Invalid ${label}.spread.pelletCount: expected positive integer`);
  }
}

function validateTurretUnitLauncher(label: string, value: unknown): void {
  if (value == null) return;
  assertExplicitFields(label, value, TURRET_UNIT_LAUNCHER_FIELDS);
  if (!isObject(value)) throw new Error(`Invalid ${label}: expected object or null`);

  if (
    typeof value.aimMode !== 'string' ||
    !TURRET_UNIT_LAUNCHER_AIM_MODES.has(value.aimMode)
  ) {
    throw new Error(
      `Invalid ${label}.aimMode: expected "ballistic-or-waypoint" or "direct-target"`,
    );
  }

  const producedUnitBlueprintId = value.producedUnitBlueprintId;
  if (
    producedUnitBlueprintId !== null &&
    (
      typeof producedUnitBlueprintId !== 'string' ||
      !isUnitBlueprintId(producedUnitBlueprintId)
    )
  ) {
    throw new Error(
      `Invalid ${label}.producedUnitBlueprintId: unknown unit blueprint ${String(producedUnitBlueprintId)}`,
    );
  }

  if (typeof value.autoProduce !== 'boolean') {
    throw new Error(`Invalid ${label}.autoProduce: expected boolean`);
  }
  if (value.autoProduce && producedUnitBlueprintId === null) {
    throw new Error(`Invalid ${label}: autoProduce requires producedUnitBlueprintId`);
  }
}

const RESOLVED_TURRET_BLUEPRINTS = resolveBlueprintRefs(
  rawTurretBlueprints,
) as unknown as Record<TurretBlueprintId, JsonTurretBlueprint>;

assertTurretLockOnInclusionConfigIds(Object.keys(RESOLVED_TURRET_BLUEPRINTS));

function buildTurretBlueprints(): Record<TurretBlueprintId, TurretBlueprint> {
  const blueprints = {} as Record<TurretBlueprintId, TurretBlueprint>;
  const ids = Object.keys(RESOLVED_TURRET_BLUEPRINTS) as TurretBlueprintId[];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const blueprint = RESOLVED_TURRET_BLUEPRINTS[id];
    assertNoInlineLockOnInclusionFields(`turret blueprint ${id}`, blueprint);
    blueprints[id] = {
      ...blueprint,
      ...getTurretLockOnInclusions(id),
    };
  }
  return blueprints;
}

export const TURRET_BLUEPRINTS = buildTurretBlueprints();

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
  if (Object.prototype.hasOwnProperty.call(blueprint, 'shield')) {
    throw new Error(
      `Invalid turret blueprint ${id}: shield emission data belongs in shields.json and must be referenced by emissionBlueprintId`,
    );
  }
  if (blueprint.shieldPanels.length > 0) {
    throw new Error(
      `Invalid turret blueprint ${id}: shield panel geometry belongs on the host mount, not the turret blueprint`,
    );
  }

  const label = `turret blueprint ${id}`;
  if (typeof blueprint.name !== 'string' || blueprint.name.trim().length === 0) {
    throw new Error(`Invalid ${label}: missing display name`);
  }
  if (!WEAPON_KIND_SET.has(blueprint.kind)) {
    throw new Error(
      `Invalid ${label}: kind "${blueprint.kind}" is not one of [${[...WEAPON_KIND_SET].join(', ')}]`,
    );
  }
  validateTurretCooldown(label, blueprint.cooldown);
  validateTurretSubmunitions(`${label}.submunitions`, blueprint.submunitions);
  validateTurretUnitLauncher(`${label}.unitLauncher`, blueprint.unitLauncher);
  if (blueprint.submunitions != null && blueprint.emissionKind !== 'shield') {
    throw new Error(
      `Invalid ${label}: submunitions are currently supported only for shield-emission turrets`,
    );
  }
  if (blueprint.unitLauncher != null) {
    if (blueprint.emissionKind !== null || blueprint.emissionBlueprintId !== null) {
      throw new Error(`Invalid ${label}: unitLauncher turrets must not define an emission`);
    }
    if (blueprint.constructionEmitter !== null) {
      throw new Error(`Invalid ${label}: unitLauncher and constructionEmitter are separate turret roles`);
    }
  }
}
