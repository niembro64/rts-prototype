// Base interface and utilities for unit renderers

import type { Entity, EntityId } from '../../sim/types';
import type { ColorPalette, UnitRenderContext } from '../types';
import { COLORS, LEG_STYLE_CONFIG } from '../types';
import type { TankTreadSetup, VehicleWheelSetup } from '../Tread';
import type { ArachnidLeg } from '../ArachnidLeg';

/**
 * Interface for unit renderer functions
 * All renderers follow this signature for consistency
 */
export interface UnitRenderer {
  (ctx: UnitRenderContext): void;
}

/**
 * Interface for leg accessor (passed to legged unit renderers)
 */
export interface LegAccessor {
  getOrCreateLegs: (entity: Entity, style: 'widow' | 'strider' | 'cricket') => ArachnidLeg[];
}

/**
 * Interface for tread/wheel accessor (passed to tracked/wheeled unit renderers)
 */
export interface TreadAccessor {
  getTankTreads: (entityId: EntityId) => TankTreadSetup | undefined;
  getVehicleWheels: (entityId: EntityId) => VehicleWheelSetup | undefined;
}

// Re-export constants for unit renderers
export { COLORS, LEG_STYLE_CONFIG };
export type { ColorPalette, UnitRenderContext };
