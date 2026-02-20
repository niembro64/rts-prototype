// LocomotionManager - manages arachnid legs, tank treads, and vehicle wheels
// Extracted from EntityRenderer to keep rendering code focused on drawing

import type { Entity, EntityId } from '../sim/types';
import { ArachnidLeg, type LegConfig } from './ArachnidLeg';
import {
  type TankTreadSetup,
  type VehicleWheelSetup,
  createTreadPair,
  createVehicleWheelSetup,
} from './Tread';
import { getUnitBlueprint } from '../sim/blueprints';
import { getGraphicsConfig } from './graphicsSettings';
import { LEG_STYLE_CONFIG } from './types';
import type { EntitySource } from './types';

export class LocomotionManager {
  // Arachnid legs storage (entity ID -> array of legs)
  private arachnidLegs: Map<EntityId, ArachnidLeg[]> = new Map();

  // Tank treads storage (entity ID -> left/right tread pair)
  private tankTreads: Map<EntityId, TankTreadSetup> = new Map();

  // Vehicle wheels storage (entity ID -> wheel array)
  private vehicleWheels: Map<EntityId, VehicleWheelSetup> = new Map();

  // Reusable Set for per-frame entity ID lookups (avoids allocating new Set + Array each frame)
  private _reusableIdSet: Set<EntityId> = new Set();

  getOrCreateLegs(
    entity: Entity,
    legStyle: string = 'widow'
  ): ArachnidLeg[] {
    const existing = this.arachnidLegs.get(entity.id);
    if (existing) return existing;

    const radius = entity.unit?.collisionRadius ?? 40;
    let leftSideConfigs: LegConfig[];

    if (legStyle === 'daddy') {
      const legLength = radius * 10;
      const upperLen = legLength * 0.45;
      const lowerLen = upperLen * 1.2;

      leftSideConfigs = [
        { attachOffsetX: radius * 0.3, attachOffsetY: -radius * 0.2, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.46, snapTargetAngle: -Math.PI * 0.31, snapDistanceMultiplier: 0.74, extensionThreshold: 0.96 },
        { attachOffsetX: radius * 0.1, attachOffsetY: -radius * 0.25, upperLegLength: upperLen * 0.95, lowerLegLength: lowerLen * 0.95, snapTriggerAngle: Math.PI * 0.65, snapTargetAngle: -Math.PI * 0.39, snapDistanceMultiplier: 0.70, extensionThreshold: 0.97 },
        { attachOffsetX: -radius * 0.1, attachOffsetY: -radius * 0.4, upperLegLength: upperLen * 0.95, lowerLegLength: lowerLen * 0.95, snapTriggerAngle: Math.PI * 0.89, snapTargetAngle: -Math.PI * 0.40, snapDistanceMultiplier: 0.71, extensionThreshold: 0.98 },
        { attachOffsetX: -radius * 0.3, attachOffsetY: -radius * 0.3, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.99, snapTargetAngle: -Math.PI * 0.58, snapDistanceMultiplier: 0.50, extensionThreshold: 0.99 },
      ];
    } else if (legStyle === 'tarantula') {
      const legLength = radius * 1.9;
      const upperLen = legLength * 0.55;
      const lowerLen = upperLen * 1.2;

      leftSideConfigs = [
        { attachOffsetX: radius * 0.3, attachOffsetY: -radius * 0.2, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.46, snapTargetAngle: -Math.PI * 0.31, snapDistanceMultiplier: 0.74, extensionThreshold: 0.96 },
        { attachOffsetX: radius * 0.1, attachOffsetY: -radius * 0.2, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.65, snapTargetAngle: -Math.PI * 0.39, snapDistanceMultiplier: 0.70, extensionThreshold: 0.97 },
        { attachOffsetX: -radius * 0.1, attachOffsetY: -radius * 0.2, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.89, snapTargetAngle: -Math.PI * 0.40, snapDistanceMultiplier: 0.71, extensionThreshold: 0.98 },
        { attachOffsetX: -radius * 0.3, attachOffsetY: -radius * 0.2, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.99, snapTargetAngle: -Math.PI * 0.58, snapDistanceMultiplier: 0.50, extensionThreshold: 0.99 },
      ];
    } else if (legStyle === 'recluse') {
      // Recluse: tiny spider with short legs — 4 per side
      const legLength = radius * 1.0;
      const upperLen = legLength * 0.5;
      const lowerLen = upperLen * 1.1;

      leftSideConfigs = [
        { attachOffsetX: radius * 0.25, attachOffsetY: -radius * 0.15, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.46, snapTargetAngle: -Math.PI * 0.31, snapDistanceMultiplier: 0.74, extensionThreshold: 0.96 },
        { attachOffsetX: radius * 0.08, attachOffsetY: -radius * 0.18, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.65, snapTargetAngle: -Math.PI * 0.39, snapDistanceMultiplier: 0.70, extensionThreshold: 0.97 },
        { attachOffsetX: -radius * 0.08, attachOffsetY: -radius * 0.18, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.89, snapTargetAngle: -Math.PI * 0.40, snapDistanceMultiplier: 0.71, extensionThreshold: 0.98 },
        { attachOffsetX: -radius * 0.25, attachOffsetY: -radius * 0.15, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.99, snapTargetAngle: -Math.PI * 0.58, snapDistanceMultiplier: 0.50, extensionThreshold: 0.99 },
      ];
    } else if (legStyle === 'commander') {
      // Commander has 4 sturdy legs - 2 front, 2 back
      const legLength = radius * 2.2;
      const upperLen = legLength * 0.5;
      const lowerLen = upperLen * 1.2;

      leftSideConfigs = [
        // Front leg - forward facing (uses leg 0 averages)
        { attachOffsetX: radius * 0.4, attachOffsetY: -radius * 0.5, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.46, snapTargetAngle: -Math.PI * 0.31, snapDistanceMultiplier: 0.74, extensionThreshold: 0.96 },
        // Back leg - rear facing (uses leg 3 averages)
        { attachOffsetX: -radius * 0.4, attachOffsetY: -radius * 0.5, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.99, snapTargetAngle: -Math.PI * 0.58, snapDistanceMultiplier: 0.50, extensionThreshold: 0.99 },
      ];
    } else {
      // Widow: 4 legs per side, tuned to match daddy/tarantula snap behavior
      const legLength = radius * 1.9;
      const upperLen = legLength * 0.55;
      const lowerLen = upperLen * 1.2;

      leftSideConfigs = [
        { attachOffsetX: radius * 0.4, attachOffsetY: -radius * 0.4, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.46, snapTargetAngle: -Math.PI * 0.31, snapDistanceMultiplier: 0.74, extensionThreshold: 0.96 },
        { attachOffsetX: radius * 0.15, attachOffsetY: -radius * 0.45, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.65, snapTargetAngle: -Math.PI * 0.39, snapDistanceMultiplier: 0.70, extensionThreshold: 0.97 },
        { attachOffsetX: -radius * 0.15, attachOffsetY: -radius * 0.45, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.89, snapTargetAngle: -Math.PI * 0.40, snapDistanceMultiplier: 0.71, extensionThreshold: 0.98 },
        { attachOffsetX: -radius * 0.4, attachOffsetY: -radius * 0.4, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.99, snapTargetAngle: -Math.PI * 0.58, snapDistanceMultiplier: 0.50, extensionThreshold: 0.99 },
      ];
    }

    const styleConfig = LEG_STYLE_CONFIG[legStyle];
    const lerpSpeed = styleConfig.lerpSpeed;
    const leftWithLerp = leftSideConfigs.map((leg) => ({ ...leg, lerpSpeed }));
    const rightSideConfigs: LegConfig[] = leftWithLerp.map((leg) => ({
      ...leg,
      attachOffsetY: -leg.attachOffsetY,
      snapTargetAngle: -leg.snapTargetAngle,
    }));

    const legConfigs = [...leftWithLerp, ...rightSideConfigs];
    const legs = legConfigs.map((config) => new ArachnidLeg(config));

    const unitX = entity.transform.x;
    const unitY = entity.transform.y;
    const unitRotation = entity.transform.rotation;
    for (const leg of legs) {
      leg.initializeAt(unitX, unitY, unitRotation);
    }

    this.arachnidLegs.set(entity.id, legs);
    return legs;
  }

  private getOrCreateTreads(entity: Entity, unitType: string): TankTreadSetup {
    const existing = this.tankTreads.get(entity.id);
    if (existing) return existing;

    const radius = entity.unit?.collisionRadius ?? 24;
    const treads = createTreadPair(unitType, radius);

    treads.leftTread.initializeAt(entity.transform.x, entity.transform.y, entity.transform.rotation);
    treads.rightTread.initializeAt(entity.transform.x, entity.transform.y, entity.transform.rotation);

    this.tankTreads.set(entity.id, treads);
    return treads;
  }

  getTankTreads(entityId: EntityId): TankTreadSetup | undefined {
    return this.tankTreads.get(entityId);
  }

  private getOrCreateVehicleWheels(entity: Entity): VehicleWheelSetup | null {
    const existing = this.vehicleWheels.get(entity.id);
    if (existing) return existing;

    const radius = entity.unit?.collisionRadius ?? 10;
    const unitType = entity.unit?.unitType;

    if (!unitType) return null;
    const wheelSetup = createVehicleWheelSetup(unitType, radius);

    for (const wheel of wheelSetup.wheels) {
      wheel.initializeAt(entity.transform.x, entity.transform.y, entity.transform.rotation);
    }

    this.vehicleWheels.set(entity.id, wheelSetup);
    return wheelSetup;
  }

  getVehicleWheels(entityId: EntityId): VehicleWheelSetup | undefined {
    return this.vehicleWheels.get(entityId);
  }

  /**
   * Combined locomotion update — legs, treads, and wheels in a single pass over units.
   * Replaces separate updateArachnidLegs() + updateTreads() calls.
   */
  updateLocomotion(entitySource: EntitySource, dtMs: number): void {
    const gfxConfig = getGraphicsConfig();
    const legsDisabled = gfxConfig.legs === 'none';

    // Build live unit ID set once (shared for all locomotion cleanup)
    this._reusableIdSet.clear();
    for (const e of entitySource.getUnits()) {
      this._reusableIdSet.add(e.id);
    }

    // Clean up stale entries from all locomotion maps
    if (legsDisabled) {
      this.arachnidLegs.clear();
    } else {
      for (const id of this.arachnidLegs.keys()) {
        if (!this._reusableIdSet.has(id)) this.arachnidLegs.delete(id);
      }
    }
    for (const id of this.tankTreads.keys()) {
      if (!this._reusableIdSet.has(id)) this.tankTreads.delete(id);
    }
    for (const id of this.vehicleWheels.keys()) {
      if (!this._reusableIdSet.has(id)) this.vehicleWheels.delete(id);
    }

    // Single pass: update all locomotion types
    for (const entity of entitySource.getUnits()) {
      if (!entity.unit) continue;

      const unitType = entity.unit.unitType;

      // Commanders always get legs
      if (entity.commander) {
        if (!legsDisabled) {
          const legs = this.getOrCreateLegs(entity, 'commander');
          const velX = (entity.unit.velocityX ?? 0) * 60;
          const velY = (entity.unit.velocityY ?? 0) * 60;
          for (const leg of legs) {
            leg.update(entity.transform.x, entity.transform.y, entity.transform.rotation, velX, velY, dtMs);
          }
        }
        continue;
      }

      if (!unitType) continue;
      let bp;
      try { bp = getUnitBlueprint(unitType); } catch { continue; }

      if (bp.locomotion.type === 'legs' && !legsDisabled) {
        const legStyle = bp.locomotion.style ?? 'widow';
        const legs = this.getOrCreateLegs(entity, legStyle);
        const velX = (entity.unit.velocityX ?? 0) * 60;
        const velY = (entity.unit.velocityY ?? 0) * 60;
        for (const leg of legs) {
          leg.update(entity.transform.x, entity.transform.y, entity.transform.rotation, velX, velY, dtMs);
        }
      } else if (bp.locomotion.type === 'treads') {
        const treads = this.getOrCreateTreads(entity, unitType);
        treads.leftTread.update(entity.transform.x, entity.transform.y, entity.transform.rotation, dtMs);
        treads.rightTread.update(entity.transform.x, entity.transform.y, entity.transform.rotation, dtMs);
      } else if (bp.locomotion.type === 'wheels') {
        const wheelSetup = this.getOrCreateVehicleWheels(entity);
        if (wheelSetup) {
          for (const wheel of wheelSetup.wheels) {
            wheel.update(entity.transform.x, entity.transform.y, entity.transform.rotation, dtMs);
          }
        }
      }
    }
  }

  clear(): void {
    this.arachnidLegs.clear();
    this.tankTreads.clear();
    this.vehicleWheels.clear();
    this._reusableIdSet.clear();
  }
}
