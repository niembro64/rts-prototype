import type { UnitProductionDomain } from '../../../types/blueprintSchema.generated';

const FABRICATOR_TECH_LEVELS = [1, 2, 3] as const;
export type FabricatorTechLevel = typeof FABRICATOR_TECH_LEVELS[number];

export const FABRICATOR_DOMAINS = [
  'universal',
  'bot',
  'vehicle',
  'aircraft',
  'naval',
] as const satisfies readonly (UnitProductionDomain | 'universal')[];
export type FabricatorDomain = typeof FABRICATOR_DOMAINS[number];

export type FabricatorIdentity = Readonly<{
  techLevel: FabricatorTechLevel;
  domain: FabricatorDomain;
}>;

export function isFabricatorTechLevel(value: unknown): value is FabricatorTechLevel {
  return typeof value === 'number' && FABRICATOR_TECH_LEVELS.includes(
    value as FabricatorTechLevel,
  );
}

export function isFabricatorDomain(value: unknown): value is FabricatorDomain {
  return typeof value === 'string' && FABRICATOR_DOMAINS.includes(value as FabricatorDomain);
}

export function fabricatorIdentityKey(identity: FabricatorIdentity): string {
  return `${identity.techLevel}:${identity.domain}`;
}
