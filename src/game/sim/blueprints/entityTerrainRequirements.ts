/**
 * Authored map-medium availability for units and buildings.
 *
 * These flags answer whether an entity belongs in a match roster at all. They
 * deliberately do not infer that decision from locomotion or placement:
 * amphibious recovery mechanics do not make a corvette useful on a dry map,
 * and a Universal Fabricator may support both placement surfaces without
 * requiring either one to exist.
 */
export type EntityTerrainRequirements = {
  requiresWater: boolean;
  requiresLand: boolean;
};

export function validateEntityTerrainRequirements(
  label: string,
  requirements: EntityTerrainRequirements,
): void {
  if (
    typeof requirements.requiresWater !== 'boolean' ||
    typeof requirements.requiresLand !== 'boolean'
  ) {
    throw new Error(
      `Invalid ${label}: requiresWater and requiresLand must both be explicit booleans`,
    );
  }
  if (requirements.requiresWater && requirements.requiresLand) {
    throw new Error(
      `Invalid ${label}: an entity cannot require both water and land`,
    );
  }
}
