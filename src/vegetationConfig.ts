// Vegetation: trees, grass, and seaweed as playable energy deposits.
//
// BAR INHERITANCE. Beyond All Reason models trees as engine FEATURES
// (`features/enginetrees_override.lua`): `reclaimable = true`,
// `energy = 250`, `metal = 0`, `reclaimTime = 1500`, `damage = 250`
// (the feature's HP). `gamedata/modrules.lua` sets
// `reclaim.reclaimMethod = 0` (gradual — resources flow in as the
// feature is consumed, not in one lump at the end) and
// `reclaim.featureEnergyCostFactor = 0` (reclaiming a feature costs
// the reclaimer nothing). `multiReclaim = 1`, so several builders may
// work the same prop at once. We inherit all of that verbatim; only
// the NUMBERS are re-expressed in this game's economy.
//
// Spring/BAR `reclaimTime` is in build-time units: a builder of build
// power B consumes the feature in `reclaimTime / B` seconds. We keep
// that exact semantic (see `vegetationReclaimSecondsForRate`) so the
// authored values read the same way a BAR feature def does.
//
// Number derivation. BAR: solar = 20 e/s, T1 constructor build power
// 80, so one tree (250 e over 1500/80 = 18.75 s) is worth ~13.3 e/s,
// about 0.65 of a solar. This game: solar = 50 e/s (economyConfig.json)
// and a T1 constructor's `constructionRate` is 35, so the same 0.65
// solar lands at 700 energy over 750/35 = 21.4 s. Grass is a tenth of
// a tree in both value and duration — a quick nibble rather than a
// deposit. Seaweed pays slightly better per second than grass because
// its waterline elevation band makes it a less ubiquitous field.
//
// DETERMINISM. Every prop is a reclaimable resource now, so placement
// is simulation state, not decoration. The layout kernel lives in
// Rust (`rts-sim-wasm/src/vegetation.rs`) and runs off the installed
// authoritative terrain mesh; identical `(mapWidth, mapHeight,
// playerCount, metalDeposits)` inputs produce a bit-identical prop
// list on every peer, exactly like `generateMetalDeposits`.

import rawConfig from './vegetationConfig.json';

/** Placement medium for a vegetation kind. `land` props sit on dry
 *  ground above the waterline; `waterline` props root in the shoreline
 *  elevation slice derived from the main flat, waterline, and seabed. */
type VegetationMedium = 'land' | 'waterline';

/** Wire/array order. The Rust kernel, the renderer, and every packed
 *  row below index kinds by this ordinal, so the order is a contract —
 *  append new kinds, never reorder. */
export const VEGETATION_KIND_IDS = ['tree', 'grass', 'seaweed'] as const;
export type VegetationKindId = (typeof VEGETATION_KIND_IDS)[number];

type VegetationReclaimConfig = {
  /** Total energy the prop yields when fully reclaimed. */
  energy: number;
  /** Total metal the prop yields. BAR trees are pure energy (0). */
  metal: number;
  /** BAR build-time units: seconds-to-consume = reclaimTime / builder
   *  construction rate. */
  reclaimTime: number;
  /** The prop's work pool, i.e. BAR's feature `damage` field. Build
   *  power drains it and the payout is proportional to the HP removed,
   *  so this is what makes reclaim gradual rather than lump-sum. */
  hp: number;
};

type VegetationKindConfig = {
  /** Prop count at the default map area; other map sizes scale from
   *  this by area, clamped to [areaScaleMin, areaScaleMax]. */
  targetCount: number;
  medium: VegetationMedium;
  /** `land` only: world-unit clearance the prop keeps from any water. */
  waterBuffer: number;
  /** `waterline` only: fraction traveled from the waterline toward each
   *  side's terrain reference. At 0.5, the upper cutoff is halfway to
   *  the main 0-height flat and the lower cutoff is halfway to the
   *  seabed. */
  waterlineRangeFraction: number;
  /** Terrain-shader slope metric: 0 is flat, 1 is vertical. */
  minSlope: number;
  maxSlope: number;
  /** `land` only: reject ground above this world height (keeps props
   *  off mountain tops). */
  maxTerrainHeight: number;
  heightScaleMin: number;
  heightScaleMax: number;
  radiusScaleMin: number;
  radiusScaleMax: number;
  /** Sinks a prop's base by the terrain drop across this fraction of
   *  its radius so the downhill side does not reveal its underside. */
  slopeSinkRadiusFraction: number;
  slopeSinkMaxHeightFraction: number;
  reclaim: VegetationReclaimConfig;
};

type VegetationPlacementConfig = {
  seed: number;
  defaultMapWidth: number;
  defaultMapHeight: number;
  areaScaleMin: number;
  areaScaleMax: number;
  maxAttemptsPerTarget: number;
  edgeClearance: number;
  /** Adds +/- this fraction to each placed prop's resolved scale. */
  assetScaleJitter: number;
};

export const VEGETATION_PLACEMENT_CONFIG: VegetationPlacementConfig =
  rawConfig.placement;

const KIND_CONFIGS = rawConfig.kinds as Record<VegetationKindId, VegetationKindConfig>;

export function getVegetationKindConfig(kind: VegetationKindId): VegetationKindConfig {
  const config = KIND_CONFIGS[kind];
  if (config === undefined) {
    throw new Error(`vegetationConfig.json has no "${kind}" kind`);
  }
  return config;
}

export function vegetationKindIdFromIndex(index: number): VegetationKindId {
  const kind = VEGETATION_KIND_IDS[index];
  if (kind === undefined) {
    throw new Error(`Vegetation kind index ${index} is outside the authored kind list`);
  }
  return kind;
}

function validVegetationConfig(): void {
  const placement = VEGETATION_PLACEMENT_CONFIG;
  if (!Number.isFinite(placement.seed) || !Number.isInteger(placement.seed)) {
    throw new Error('vegetationConfig.json placement.seed must be a finite integer');
  }
  if (placement.defaultMapWidth <= 0 || placement.defaultMapHeight <= 0) {
    throw new Error('vegetationConfig.json placement default map dimensions must be positive');
  }
  if (placement.areaScaleMin <= 0 || placement.areaScaleMax < placement.areaScaleMin) {
    throw new Error('vegetationConfig.json placement area scale bounds must satisfy 0 < min <= max');
  }
  if (!Number.isFinite(placement.maxAttemptsPerTarget) || placement.maxAttemptsPerTarget < 1) {
    throw new Error('vegetationConfig.json placement.maxAttemptsPerTarget must be >= 1');
  }
  for (const kind of VEGETATION_KIND_IDS) {
    const config = getVegetationKindConfig(kind);
    if (config.medium !== 'land' && config.medium !== 'waterline') {
      throw new Error(`vegetationConfig.json "${kind}".medium must be "land" or "waterline"`);
    }
    if (config.targetCount < 0) {
      throw new Error(`vegetationConfig.json "${kind}".targetCount must be >= 0`);
    }
    if (config.minSlope < 0 || config.maxSlope > 1 || config.minSlope > config.maxSlope) {
      throw new Error(
        `vegetationConfig.json "${kind}" slope band must satisfy 0 <= minSlope <= maxSlope <= 1`,
      );
    }
    if (config.medium === 'waterline') {
      if (
        !Number.isFinite(config.waterlineRangeFraction) ||
        config.waterlineRangeFraction <= 0 ||
        config.waterlineRangeFraction > 1
      ) {
        throw new Error(
          `vegetationConfig.json "${kind}".waterlineRangeFraction must satisfy 0 < fraction <= 1`,
        );
      }
    } else if (config.waterlineRangeFraction !== 0) {
      throw new Error(
        `vegetationConfig.json "${kind}".waterlineRangeFraction must be 0 for land vegetation`,
      );
    }
    if (config.heightScaleMin <= 0 || config.heightScaleMax < config.heightScaleMin) {
      throw new Error(
        `vegetationConfig.json "${kind}" height scale bounds must satisfy 0 < min <= max`,
      );
    }
    if (config.radiusScaleMin <= 0 || config.radiusScaleMax < config.radiusScaleMin) {
      throw new Error(
        `vegetationConfig.json "${kind}" radius scale bounds must satisfy 0 < min <= max`,
      );
    }
    const reclaim = config.reclaim;
    if (reclaim.energy < 0 || reclaim.metal < 0) {
      throw new Error(`vegetationConfig.json "${kind}".reclaim yields must be >= 0`);
    }
    if (!Number.isFinite(reclaim.reclaimTime) || reclaim.reclaimTime <= 0) {
      throw new Error(`vegetationConfig.json "${kind}".reclaim.reclaimTime must be > 0`);
    }
    if (!Number.isFinite(reclaim.hp) || reclaim.hp <= 0) {
      throw new Error(`vegetationConfig.json "${kind}".reclaim.hp must be > 0`);
    }
  }
}

validVegetationConfig();
