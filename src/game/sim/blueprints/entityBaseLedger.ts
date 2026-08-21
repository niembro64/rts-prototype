import type { EntityBaseLedger, EntityRadiusConfig } from './types';
import type { ResourceCost } from '../../../types/economyTypes';
import {
  assertNonNegativeFiniteNumber,
  assertPositiveFiniteNumber,
} from '../../../configValidation';

function assertFiniteNonNegative(label: string, field: string, value: number): void {
  assertNonNegativeFiniteNumber(value, `Invalid ${label}: ${field}`);
}

function assertFinitePositive(label: string, field: string, value: number): void {
  assertPositiveFiniteNumber(value, `Invalid ${label}: ${field}`);
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

/**
 * Every unit and building dies in a blast sized by its own body:
 * deathExplosion.radius = this multiple of radius.hitbox.
 *
 * The RULE is the source, not the JSON: the authored per-blueprint radius
 * numbers had drifted into folklore (the commander's blast was smaller than
 * its own hurtbox), so the radius is derived here at the one choke point
 * both units and buildings pass through. Force and damage stay authored —
 * how HARD something explodes is still a per-blueprint gameplay decision;
 * how FAR is anatomy. Shots keep their own authored splash: a projectile's
 * explosion is its payload, not its corpse.
 */
export const DEATH_EXPLOSION_HITBOX_RADIUS_MULT = 1.4;

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
  // After the aliases settle, so a tuned top-level radius moves the blast
  // with it. Deterministic: a pure function of blueprint data, identical on
  // every peer.
  normalized.deathExplosion.radius =
    normalized.radius.hitbox * DEATH_EXPLOSION_HITBOX_RADIUS_MULT;
  return normalized;
}
