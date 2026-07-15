import type { EntityBaseLedger, EntityRadiusConfig } from './types';
import type { ResourceCost } from '../../../types/economyTypes';
import { deriveShotArmingRadius } from '../shotArmingRadius';



function assertFiniteNonNegative(label: string, field: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${label}: ${field} must be finite and non-negative`);
  }
}

function assertFinitePositive(label: string, field: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${label}: ${field} must be finite and positive`);
  }
}

function assertValidResourceCost(label: string, cost: ResourceCost): void {
  if (!cost || typeof cost !== 'object') {
    throw new Error(`Invalid ${label}: cost must be an object`);
  }
  assertFiniteNonNegative(label, 'cost.energy', cost.energy);
  assertFiniteNonNegative(label, 'cost.metal', cost.metal);
}

export function assertValidEntityRadius(label: string, radius: EntityRadiusConfig): void {
  if (!radius || typeof radius !== 'object') {
    throw new Error(`Invalid ${label}: radius must be an object`);
  }
  assertFinitePositive(label, 'radius.other', radius.other);
  assertFinitePositive(label, 'radius.hitbox', radius.hitbox);
  assertFinitePositive(label, 'radius.collision', radius.collision);
  if (radius.shotArmingRadius !== undefined) {
    assertFiniteNonNegative(label, 'radius.shotArmingRadius', radius.shotArmingRadius);
  }
}

export function assertValidShotArmingRadius(label: string, radius: EntityRadiusConfig): void {
  assertValidEntityRadius(label, radius);
  if (radius.shotArmingRadius === undefined) {
    throw new Error(`Invalid ${label}: radius.shotArmingRadius must be authored`);
  }
  assertFiniteNonNegative(label, 'radius.shotArmingRadius', radius.shotArmingRadius);
  const expected = deriveShotArmingRadius(radius.collision);
  if (Math.abs(radius.shotArmingRadius - expected) > 1e-6) {
    throw new Error(
      `Invalid ${label}: radius.shotArmingRadius must equal 1.5 × radius.collision ` +
      `(expected ${expected}, got ${radius.shotArmingRadius})`,
    );
  }
}

export function assertValidEntityBaseLedger(label: string, base: EntityBaseLedger): void {
  if (!base || typeof base !== 'object') {
    throw new Error(`Invalid ${label}: base ledger must be an object`);
  }
  assertValidResourceCost(label, base.cost);
  assertFinitePositive(label, 'base.mass', base.mass);
  assertFinitePositive(label, 'base.health', base.health);
  assertValidEntityRadius(label, base.radius);
  if (!base.deathExplosion || typeof base.deathExplosion !== 'object') {
    throw new Error(`Invalid ${label}: base.deathExplosion must be an object`);
  }
  assertFiniteNonNegative(label, 'base.deathExplosion.radius', base.deathExplosion.radius);
  assertFiniteNonNegative(label, 'base.deathExplosion.force', base.deathExplosion.force);
  assertFiniteNonNegative(label, 'base.deathExplosion.damage', base.deathExplosion.damage);
}

type EntityBaseLedgerAliasFields = {
  cost?: ResourceCost;
  mass?: number;
  health?: number;
  radius?: EntityRadiusConfig;
};

/** Reconcile legacy top-level body fields with the canonical base ledger.
 *
 *  The JSON still carries aliases such as unit.mass / unit.hp because
 *  runtime and UI consumers read those fields directly. During tuning,
 *  authors naturally edit the visible top-level value first. Treat that
 *  value as the authored override and mirror it into base so the app does
 *  not fail boot just because the duplicate ledger copy was not updated.
 */
export function normalizeEntityBaseLedgerFromAliases(
  label: string,
  base: EntityBaseLedger,
  aliases: EntityBaseLedgerAliasFields,
): EntityBaseLedger {
  assertValidEntityBaseLedger(label, base);
  const normalized: EntityBaseLedger = {
    ...base,
    cost: { ...base.cost },
    radius: { ...base.radius },
    deathExplosion: { ...base.deathExplosion },
  };

  if (aliases.cost !== undefined) {
    assertValidResourceCost(label, aliases.cost);
    normalized.cost = { ...aliases.cost };
  }
  if (aliases.mass !== undefined) {
    assertFinitePositive(label, 'mass', aliases.mass);
    normalized.mass = aliases.mass;
  }
  if (aliases.health !== undefined) {
    assertFinitePositive(label, 'health', aliases.health);
    normalized.health = aliases.health;
  }
  if (aliases.radius !== undefined) {
    assertValidEntityRadius(label, aliases.radius);
    normalized.radius = { ...aliases.radius };
  }
  return normalized;
}


