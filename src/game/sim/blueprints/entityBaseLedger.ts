import type { EntityBaseLedger, EntityRadiusConfig } from './types';
import type { ResourceCost } from '../../../types/economyTypes';

const EPSILON = 1e-6;

export function addResourceCosts(...costs: ResourceCost[]): ResourceCost {
  let energy = 0;
  let metal = 0;
  for (const cost of costs) {
    energy += cost.energy;
    metal += cost.metal;
  }
  return { energy, metal };
}

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

export function assertValidResourceCost(label: string, cost: ResourceCost): void {
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
  assertFinitePositive(label, 'radius.visual', radius.visual);
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

export function assertResourceCostEquals(
  label: string,
  actual: ResourceCost,
  expected: ResourceCost,
): void {
  if (
    Math.abs(actual.energy - expected.energy) > EPSILON ||
    Math.abs(actual.metal - expected.metal) > EPSILON
  ) {
    throw new Error(
      `Invalid ${label}: cost must equal assembled base ledger cost ` +
        `(expected energy=${expected.energy}, metal=${expected.metal}; ` +
        `got energy=${actual.energy}, metal=${actual.metal})`,
    );
  }
}

export function assertRadiusEquals(
  label: string,
  actual: EntityRadiusConfig,
  expected: EntityRadiusConfig,
): void {
  if (
    Math.abs(actual.visual - expected.visual) > EPSILON ||
    Math.abs(actual.hitbox - expected.hitbox) > EPSILON ||
    Math.abs(actual.collision - expected.collision) > EPSILON
  ) {
    throw new Error(
      `Invalid ${label}: radius must match base.radius ` +
        `(expected visual=${expected.visual}, hitbox=${expected.hitbox}, collision=${expected.collision}; ` +
        `got visual=${actual.visual}, hitbox=${actual.hitbox}, collision=${actual.collision})`,
    );
  }
}

export function assertNumberEquals(
  label: string,
  field: string,
  actual: number,
  expected: number,
): void {
  if (Math.abs(actual - expected) > EPSILON) {
    throw new Error(
      `Invalid ${label}: ${field} must match base.${field} ` +
        `(expected ${expected}, got ${actual})`,
    );
  }
}
