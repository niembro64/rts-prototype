import type {
  UnitSuspensionConfig,
  UnitSuspensionState,
} from '@/types/unitLocomotionTypes';

function cloneSuspensionConfig(config: UnitSuspensionConfig): UnitSuspensionConfig {
  return {
    stiffness: config.stiffness,
    dampingRatio: config.dampingRatio,
    massScale: config.massScale,
    maxOffset: config.maxOffset
      ? {
          x: config.maxOffset.x,
          y: config.maxOffset.y,
          z: config.maxOffset.z,
        }
      : undefined,
  };
}

export function createUnitSuspension(
  config: UnitSuspensionConfig | null | undefined,
): UnitSuspensionState | null {
  if (!config) return null;
  return {
    config: cloneSuspensionConfig(config),
    offsetX: 0,
    offsetY: 0,
    offsetZ: 0,
    velocityX: 0,
    velocityY: 0,
    velocityZ: 0,
    legContact: true,
    anchorVelocityX: 0,
    anchorVelocityY: 0,
    anchorVelocityZ: 0,
    anchorVelocityInitialized: false,
  };
}
