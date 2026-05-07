import type { ConcreteGraphicsQuality } from '@/types/graphics';
import type { BuildingDetailMesh } from './BuildingShape3D';

const BUILDING_TIER_ORDER: Record<ConcreteGraphicsQuality, number> = {
  min: 0,
  low: 1,
  medium: 2,
  high: 3,
  max: 4,
};

export function buildingTierAtLeast(
  tier: ConcreteGraphicsQuality,
  minTier: ConcreteGraphicsQuality,
): boolean {
  return BUILDING_TIER_ORDER[tier] >= BUILDING_TIER_ORDER[minTier];
}

export function buildingDetailVisible(
  detail: BuildingDetailMesh,
  tier: ConcreteGraphicsQuality,
): boolean {
  const level = BUILDING_TIER_ORDER[tier];
  return level >= BUILDING_TIER_ORDER[detail.minTier]
    && (detail.maxTier === undefined || level <= BUILDING_TIER_ORDER[detail.maxTier]);
}
