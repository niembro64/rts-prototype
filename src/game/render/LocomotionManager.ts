// LocomotionManager - manages arachnid legs, tank treads, and vehicle wheels
// Extracted from EntityRenderer to keep rendering code focused on drawing

import type { Entity, EntityId } from '../sim/types';
import { ArachnidLeg, type LegConfig } from './ArachnidLeg';
import {
  type TankTreadSetup,
  type VehicleWheelSetup,
  createTankTreads,
  createBrawlTreads,
  createScoutWheelSetup,
  createBurstWheelSetup,
  createMortarWheelSetup,
  createFourWheelSetup,
} from './Tread';
import { getUnitDefinition } from '../sim/unitDefinitions';
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
    legStyle: 'widow' | 'daddy' | 'tarantula' | 'commander' = 'widow'
  ): ArachnidLeg[] {
    const existing = this.arachnidLegs.get(entity.id);
    if (existing) return existing;

    const radius = entity.unit?.collisionRadius ?? 40;
    let leftSideConfigs: LegConfig[];

    if (legStyle === 'daddy') {
      const legLength = radius * 10;
      const upperLen = legLength * 0.3;
      const lowerLen = legLength * 0.6;

      leftSideConfigs = [
        { attachOffsetX: radius * 0.3, attachOffsetY: -radius * 0.4, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.3, snapTargetAngle: -Math.PI * 0.2, snapDistanceMultiplier: 0.9, extensionThreshold: 0.82 },
        { attachOffsetX: radius * 0.1, attachOffsetY: -radius * 0.4, upperLegLength: upperLen * 0.95, lowerLegLength: lowerLen * 0.95, snapTriggerAngle: Math.PI * 0.55, snapTargetAngle: -Math.PI * 0.25, snapDistanceMultiplier: 0.9, extensionThreshold: 0.84 },
        { attachOffsetX: -radius * 0.1, attachOffsetY: -radius * 0.4, upperLegLength: upperLen * 0.95, lowerLegLength: lowerLen * 0.95, snapTriggerAngle: Math.PI * 0.85, snapTargetAngle: -Math.PI * 0.45, snapDistanceMultiplier: 0.85, extensionThreshold: 0.9 },
        { attachOffsetX: -radius * 0.3, attachOffsetY: -radius * 0.3, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.99, snapTargetAngle: -Math.PI * 0.65, snapDistanceMultiplier: 0.55, extensionThreshold: 0.99 },
      ];
    } else if (legStyle === 'tarantula') {
      const legLength = radius * 1.9;
      const upperLen = legLength * 0.55;
      const lowerLen = legLength * 0.55;

      leftSideConfigs = [
        { attachOffsetX: radius * 0.3, attachOffsetY: -radius * 0.2, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.4, snapTargetAngle: -Math.PI * 0.15, snapDistanceMultiplier: 0.99, extensionThreshold: 0.99 },
        { attachOffsetX: radius * 0.1, attachOffsetY: -radius * 0.2, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.55, snapTargetAngle: -Math.PI * 0.25, snapDistanceMultiplier: 0.92, extensionThreshold: 0.99 },
        { attachOffsetX: -radius * 0.1, attachOffsetY: -radius * 0.2, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.8, snapTargetAngle: -Math.PI * 0.35, snapDistanceMultiplier: 0.8, extensionThreshold: 0.99 },
        { attachOffsetX: -radius * 0.3, attachOffsetY: -radius * 0.2, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.99, snapTargetAngle: -Math.PI * 0.5, snapDistanceMultiplier: 0.6, extensionThreshold: 0.99 },
      ];
    } else if (legStyle === 'commander') {
      // Commander has 4 sturdy legs - 2 front, 2 back
      const legLength = radius * 2.2;
      const upperLen = legLength * 0.5;
      const lowerLen = legLength * 0.5;

      leftSideConfigs = [
        // Front leg - forward facing
        { attachOffsetX: radius * 0.4, attachOffsetY: -radius * 0.5, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.45, snapTargetAngle: -Math.PI * 0.15, snapDistanceMultiplier: 0.95, extensionThreshold: 0.9 },
        // Back leg - rear facing
        { attachOffsetX: -radius * 0.4, attachOffsetY: -radius * 0.5, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.85, snapTargetAngle: -Math.PI * 0.55, snapDistanceMultiplier: 0.7, extensionThreshold: 0.95 },
      ];
    } else {
      // Widow: 4 legs per side, tuned to match daddy/tarantula snap behavior
      const legLength = radius * 1.9;
      const upperLen = legLength * 0.55;
      const lowerLen = legLength * 0.55;

      leftSideConfigs = [
        { attachOffsetX: radius * 0.4, attachOffsetY: -radius * 0.4, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.35, snapTargetAngle: -Math.PI * 0.15, snapDistanceMultiplier: 0.95, extensionThreshold: 0.85 },
        { attachOffsetX: radius * 0.15, attachOffsetY: -radius * 0.45, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.55, snapTargetAngle: -Math.PI * 0.28, snapDistanceMultiplier: 0.88, extensionThreshold: 0.88 },
        { attachOffsetX: -radius * 0.15, attachOffsetY: -radius * 0.45, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.8, snapTargetAngle: -Math.PI * 0.42, snapDistanceMultiplier: 0.78, extensionThreshold: 0.92 },
        { attachOffsetX: -radius * 0.4, attachOffsetY: -radius * 0.4, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.99, snapTargetAngle: -Math.PI * 0.6, snapDistanceMultiplier: 0.55, extensionThreshold: 0.99 },
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

  private getOrCreateTreads(entity: Entity, unitType: 'mammoth' | 'badger'): TankTreadSetup {
    const existing = this.tankTreads.get(entity.id);
    if (existing) return existing;

    const radius = entity.unit?.collisionRadius ?? 24;
    const treads = unitType === 'mammoth' ? createTankTreads(radius, 2.0) : createBrawlTreads(radius, 2.0);

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

    let wheelSetup: VehicleWheelSetup | null = null;
    switch (unitType) {
      case 'jackal': wheelSetup = createScoutWheelSetup(radius, 2.0); break;
      case 'lynx': wheelSetup = createBurstWheelSetup(radius, 2.0); break;
      case 'scorpion': wheelSetup = createMortarWheelSetup(radius, 2.0); break;
      case 'viper': wheelSetup = createFourWheelSetup(radius, 2.0); break;
      default: return null;
    }

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
      const definition = getUnitDefinition(unitType);
      if (!definition) continue;

      if (definition.locomotion === 'legs' && !legsDisabled) {
        const legStyle = definition.legStyle ?? 'widow';
        const legs = this.getOrCreateLegs(entity, legStyle);
        const velX = (entity.unit.velocityX ?? 0) * 60;
        const velY = (entity.unit.velocityY ?? 0) * 60;
        for (const leg of legs) {
          leg.update(entity.transform.x, entity.transform.y, entity.transform.rotation, velX, velY, dtMs);
        }
      } else if (definition.locomotion === 'treads') {
        const treadType = unitType as 'mammoth' | 'badger';
        const treads = this.getOrCreateTreads(entity, treadType);
        treads.leftTread.update(entity.transform.x, entity.transform.y, entity.transform.rotation, dtMs);
        treads.rightTread.update(entity.transform.x, entity.transform.y, entity.transform.rotation, dtMs);
      } else if (definition.locomotion === 'wheels') {
        const wheelSetup = this.getOrCreateVehicleWheels(entity);
        if (wheelSetup) {
          for (const wheel of wheelSetup.wheels) {
            wheel.update(entity.transform.x, entity.transform.y, entity.transform.rotation, dtMs);
          }
        }
      }
    }
  }
}
