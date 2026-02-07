import type { Entity, EntityId } from './types';

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

  /**
   * Rebuild the index from projectiles
   * Should be called once per frame with all current projectiles
   */
  rebuild(projectiles: Entity[], fixedTimestep: number): void {
    this.clear();

    for (const proj of projectiles) {
      if (!proj.projectile) continue;
      if (proj.projectile.projectileType !== 'beam') continue;

      // Skip beams that will expire this frame
      if (proj.projectile.timeAlive + fixedTimestep >= proj.projectile.maxLifespan) continue;

      const sourceId = proj.projectile.sourceEntityId;
      const weaponIndex = (proj.projectile.config as { weaponIndex?: number }).weaponIndex ?? 0;

      this.addBeam(sourceId, weaponIndex, proj.id);
    }
  }
}

// Singleton instance for the game
export const beamIndex = new BeamIndex();
