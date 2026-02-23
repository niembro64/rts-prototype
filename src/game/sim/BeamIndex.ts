import type { EntityId } from './types';

/**
 * Index for O(1) beam lookup by source unit and turret index.
 * Replaces the O(n) hasActiveWeaponBeam() function.
 */
export class BeamIndex {
  // Map<unitId, Map<turretIndex, beamEntityId>>
  private beamsByTurret: Map<EntityId, Map<number, EntityId>> = new Map();

  /**
   * Clear the index (call at start of each frame before rebuilding)
   */
  clear(): void {
    this.beamsByTurret.clear();
  }

  /**
   * Add a beam to the index
   */
  addBeam(sourceUnitId: EntityId, turretIndex: number, beamEntityId: EntityId): void {
    let turretMap = this.beamsByTurret.get(sourceUnitId);
    if (!turretMap) {
      turretMap = new Map();
      this.beamsByTurret.set(sourceUnitId, turretMap);
    }
    turretMap.set(turretIndex, beamEntityId);
  }

  /**
   * Check if a unit's weapon has an active beam (O(1) lookup)
   */
  hasActiveBeam(unitId: EntityId, turretIndex: number): boolean {
    const turretMap = this.beamsByTurret.get(unitId);
    if (!turretMap) return false;
    return turretMap.has(turretIndex);
  }

  /**
   * Get the beam entity ID for a unit's weapon (O(1) lookup)
   */
  getBeam(unitId: EntityId, turretIndex: number): EntityId | undefined {
    const turretMap = this.beamsByTurret.get(unitId);
    if (!turretMap) return undefined;
    return turretMap.get(turretIndex);
  }

  /**
   * Remove a beam from the index
   */
  removeBeam(sourceUnitId: EntityId, turretIndex: number): void {
    const turretMap = this.beamsByTurret.get(sourceUnitId);
    if (turretMap) {
      turretMap.delete(turretIndex);
      if (turretMap.size === 0) {
        this.beamsByTurret.delete(sourceUnitId);
      }
    }
  }

}

// Singleton instance for the game
export const beamIndex = new BeamIndex();
