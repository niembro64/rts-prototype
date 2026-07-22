import type { LegConfig } from '@/types/blueprints';
import type { ArachnidLegConfig } from '@/types/render';

type ResolvedLegLayout = {
  left: ArachnidLegConfig[];
  right: ArachnidLegConfig[];
  all: ArachnidLegConfig[];
  sides: number[];
};

function resolveLeftSideLegConfigs(
  config: LegConfig,
  radius: number,
): ArachnidLegConfig[] {
  const legs = new Array<ArachnidLegConfig>(config.leftSide.length);
  for (let i = 0; i < config.leftSide.length; i++) {
    const leg = config.leftSide[i];
    legs[i] = {
      attachOffsetX: leg.attachmentPoint.xUnitRadiusRatio * radius,
      attachOffsetY: leg.attachmentPoint.yUnitRadiusRatio * radius,
      upperLegLength: config.segments.upper.lengthUnitRadiusRatio * radius,
      lowerLegLength: config.segments.lower.lengthUnitRadiusRatio * radius,
      footSphereOriginExtensionRatio: config.footSphere.originExtensionRatio,
      footSphereRadiusLegLengthRatio: config.footSphere.radiusLegLengthRatio,
      lerpDuration: config.lerpDuration,
    };
  }
  return legs;
}

export function resolveMirroredLegConfigs(
  config: LegConfig,
  radius: number,
): ResolvedLegLayout {
  const left = resolveLeftSideLegConfigs(config, radius);
  const right = new Array<ArachnidLegConfig>(left.length);
  for (let i = 0; i < left.length; i++) {
    const leg = left[i];
    right[i] = {
      ...leg,
      attachOffsetY: -leg.attachOffsetY,
    };
  }
  const all = new Array<ArachnidLegConfig>(left.length + right.length);
  const sides = new Array<number>(all.length);
  for (let i = 0; i < left.length; i++) {
    all[i] = left[i];
    sides[i] = -1;
  }
  for (let i = 0; i < right.length; i++) {
    all[left.length + i] = right[i];
    sides[left.length + i] = 1;
  }
  return {
    left,
    right,
    all,
    sides,
  };
}
