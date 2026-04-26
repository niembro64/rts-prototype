import type { BattleBarConfig } from './types/battle';
import { persist, persistJson, readPersisted } from './persistence';

export const BATTLE_CONFIG = {
  units: {
    jackal: { shortName: 'JKL', default: false },
    lynx: { shortName: 'LNX', default: true },
    daddy: { shortName: 'DDY', default: false },
    badger: { shortName: 'BDG', default: true },
    mongoose: { shortName: 'MGS', default: true },
    tick: { shortName: 'TCK', default: true },
    mammoth: { shortName: 'MMT', default: false },
    widow: { shortName: 'WDW', default: true },
    hippo: { shortName: 'HPO', default: true },
    tarantula: { shortName: 'TRN', default: false },
    loris: { shortName: 'LRS', default: false },
    commander: { shortName: 'CMD', default: true },
  } as Record<string, { shortName: string; default: boolean }>,
  cap: {
    default: Math.pow(2, 12),
    options: [
      Math.pow(2, 2),
      Math.pow(2, 4),
      Math.pow(2, 6),
      Math.pow(2, 8),
      Math.pow(2, 10),
      Math.pow(2, 12),
      Math.pow(2, 14),
    ] as readonly number[],
  },
  projVelInherit: { default: false },
  firingForce: { default: false },
  hitForce: { default: false },
  ffAccelUnits: { default: false },
  ffAccelShots: { default: true },
} as const satisfies BattleBarConfig;

// Default caps per mode (must be values from BATTLE_CONFIG.cap.options)
export const DEMO_CAP_DEFAULT = Math.pow(2, 8);   // 256 ≈ 3e+2
export const REAL_CAP_DEFAULT = Math.pow(2, 12);   // 4096 ≈ 4e+3

// ── localStorage keys (module-private) ──
const STORAGE_DEMO_UNITS = 'rts-demo-units';
const STORAGE_DEMO_CAP = 'rts-demo-cap';
const STORAGE_REAL_CAP = 'rts-real-cap';
const STORAGE_DEMO_GRID = 'rts-demo-grid';
const STORAGE_REAL_GRID = 'rts-real-grid';
const STORAGE_PROJ_VEL_INHERIT = 'rts-proj-vel-inherit';
const STORAGE_FIRING_FORCE = 'rts-firing-force';
const STORAGE_HIT_FORCE = 'rts-hit-force';
const STORAGE_FF_ACCEL_UNITS = 'rts-ff-accel-units';
const STORAGE_FF_ACCEL_SHOTS = 'rts-ff-accel-shots';

/** "true"/"false" → boolean, null otherwise. Keeps each loader a
 *  one-liner now that the try/catch is pushed into readPersisted. */
function loadBool(key: string): boolean | null {
  const s = readPersisted(key);
  if (s === 'true') return true;
  if (s === 'false') return false;
  return null;
}

/** "<positive-number>" → number, null otherwise. */
function loadPosNum(key: string): number | null {
  const s = readPersisted(key);
  if (!s) return null;
  const n = Number(s);
  return !isNaN(n) && n > 0 ? n : null;
}

export function loadStoredDemoUnits(): string[] | null {
  const stored = readPersisted(STORAGE_DEMO_UNITS);
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* malformed JSON */ }
  return null;
}

export function saveDemoUnits(units: string[]): void {
  persistJson(STORAGE_DEMO_UNITS, units);
}

export function getDefaultDemoUnits(): string[] {
  return Object.entries(BATTLE_CONFIG.units)
    .filter(([, cfg]) => cfg.default)
    .map(([id]) => id);
}

export function loadStoredDemoCap(): number {
  return loadPosNum(STORAGE_DEMO_CAP) ?? DEMO_CAP_DEFAULT;
}

export function saveDemoCap(value: number): void {
  persist(STORAGE_DEMO_CAP, String(value));
}

export function loadStoredRealCap(): number {
  return loadPosNum(STORAGE_REAL_CAP) ?? REAL_CAP_DEFAULT;
}

export function saveRealCap(value: number): void {
  persist(STORAGE_REAL_CAP, String(value));
}

export function loadStoredDemoGrid(): boolean {
  return loadBool(STORAGE_DEMO_GRID) ?? true; // default ON for demo
}

export function saveDemoGrid(enabled: boolean): void {
  persist(STORAGE_DEMO_GRID, String(enabled));
}

export function loadStoredRealGrid(): boolean {
  return loadBool(STORAGE_REAL_GRID) ?? false; // default OFF for real
}

export function saveRealGrid(enabled: boolean): void {
  persist(STORAGE_REAL_GRID, String(enabled));
}

export function loadStoredProjVelInherit(): boolean {
  return loadBool(STORAGE_PROJ_VEL_INHERIT) ?? BATTLE_CONFIG.projVelInherit.default;
}

export function saveProjVelInherit(enabled: boolean): void {
  persist(STORAGE_PROJ_VEL_INHERIT, String(enabled));
}

export function loadStoredFiringForce(): boolean {
  return loadBool(STORAGE_FIRING_FORCE) ?? BATTLE_CONFIG.firingForce.default;
}

export function saveFiringForce(enabled: boolean): void {
  persist(STORAGE_FIRING_FORCE, String(enabled));
}

export function loadStoredHitForce(): boolean {
  return loadBool(STORAGE_HIT_FORCE) ?? BATTLE_CONFIG.hitForce.default;
}

export function saveHitForce(enabled: boolean): void {
  persist(STORAGE_HIT_FORCE, String(enabled));
}

export function loadStoredFfAccelUnits(): boolean {
  return loadBool(STORAGE_FF_ACCEL_UNITS) ?? BATTLE_CONFIG.ffAccelUnits.default;
}

export function saveFfAccelUnits(enabled: boolean): void {
  persist(STORAGE_FF_ACCEL_UNITS, String(enabled));
}

export function loadStoredFfAccelShots(): boolean {
  return loadBool(STORAGE_FF_ACCEL_SHOTS) ?? BATTLE_CONFIG.ffAccelShots.default;
}

export function saveFfAccelShots(enabled: boolean): void {
  persist(STORAGE_FF_ACCEL_SHOTS, String(enabled));
}
