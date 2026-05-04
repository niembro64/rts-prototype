import type { LegConfig } from '@/types/blueprints';
import type { ArachnidLegConfig } from '@/types/render';

export type ResolvedLegLayout = {
  left: ArachnidLegConfig[];
  right: ArachnidLegConfig[];
  all: ArachnidLegConfig[];
  sides: number[];
};

export function resolveLeftSideLegConfigs(
  config: LegConfig,
  radius: number,
): ArachnidLegConfig[] {
  return config.leftSide.map((leg) => ({
    attachOffsetX: leg.attachOffsetXFrac * radius,
    attachOffsetY: leg.attachOffsetYFrac * radius,
    upperLegLength: leg.upperLegLengthFrac * radius,
    lowerLegLength: leg.lowerLegLengthFrac * radius,
    snapTriggerAngle: leg.snapTriggerAngle,
    snapTargetAngle: leg.snapTargetAngle,
    snapDistanceMultiplier: leg.snapDistanceMultiplier,
    extensionThreshold: leg.extensionThreshold,
    lerpDuration: config.lerpDuration,
  }));
}

export function resolveMirroredLegConfigs(
  config: LegConfig,
  radius: number,
): ResolvedLegLayout {
  const left = resolveLeftSideLegConfigs(config, radius);
  const right = left.map((leg) => ({
    ...leg,
    attachOffsetY: -leg.attachOffsetY,
    snapTargetAngle: -leg.snapTargetAngle,
  }));
  return {
    left,
    right,
    all: [...left, ...right],
    sides: [
      ...left.map(() => -1),
      ...right.map(() => 1),
    ],
  };
}
