// Command parameter clamps shared between the command sanitizer and
// command execution. Pure data lives in commandLimits.json so both
// TypeScript and (eventually) Rust/WASM can load the same source of
// truth.

import commandLimits from './commandLimits.json';

export const REPAIR_AREA_MAX_RADIUS = commandLimits.repairAreaMaxRadius;
export const RECLAIM_AREA_MAX_RADIUS = commandLimits.reclaimAreaMaxRadius;
export const ATTACK_AREA_MAX_RADIUS = commandLimits.attackAreaMaxRadius;
export const METAL_EXTRACTOR_UPGRADE_AREA_MAX_RADIUS =
  commandLimits.metalExtractorUpgradeAreaMaxRadius;
