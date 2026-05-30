// Command parameter clamps shared between the command sanitizer and
// command execution. Pure data lives in commandLimits.json so both
// TypeScript and (eventually) Rust/WASM can load the same source of
// truth.

import commandLimits from './commandLimits.json';

export const REPAIR_AREA_MAX_RADIUS = commandLimits.repairAreaMaxRadius;
export const ATTACK_AREA_MAX_RADIUS = commandLimits.attackAreaMaxRadius;
