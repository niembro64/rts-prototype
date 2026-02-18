import type { EntityId } from './types';

/**
 * Index for O(1) beam lookup by source unit and weapon index.
 * Replaces the O(n) hasActiveWeaponBeam() function.
 */
export class BeamIndex {
  // Map<unitId, Map<weaponIndex, beamEntityId>>
  private beamsByWeapon: Map<EntityId, Map<number, EntityId>> = new Map();

  /**
   * Clear the index (call at start of each frame before rebuilding)
   */
  clear(): void {
    this.beamsByWeapon.clear();
  }

  /**
   * Add a beam to the index
   */
  addBeam(sourceUnitId: EntityId, weaponIndex: number, beamEntityId: EntityId): void {
    let weaponMap = this.beamsByWeapon.get(sourceUnitId);
    if (!weaponMap) {
      weaponMap = new Map();
      this.beamsByWeapon.set(sourceUnitId, weaponMap);
    }
    weaponMap.set(weaponIndex, beamEntityId);
  }

  /**
   * Check if a unit's weapon has an active beam (O(1) lookup)
   */
  hasActiveBeam(unitId: EntityId, weaponIndex: number): boolean {
    const weaponMap = this.beamsByWeapon.get(unitId);
    if (!weaponMap) return false;
    return weaponMap.has(weaponIndex);
  }

  /**
   * Get the beam entity ID for a unit's weapon (O(1) lookup)
   */
  getBeam(unitId: EntityId, weaponIndex: number): EntityId | undefined {
    const weaponMap = this.beamsByWeapon.get(unitId);
    if (!weaponMap) return undefined;
    return weaponMap.get(weaponIndex);
  }

  /**
   * Remove a beam from the index
   */
  removeBeam(sourceUnitId: EntityId, weaponIndex: number): void {
    const weaponMap = this.beamsByWeapon.get(sourceUnitId);
    if (weaponMap) {
      weaponMap.delete(weaponIndex);
      if (weaponMap.size === 0) {
        this.beamsByWeapon.delete(sourceUnitId);
      }
    }
  }

}

// Singleton instance for the game
export const beamIndex = new BeamIndex();
