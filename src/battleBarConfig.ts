import type { BattleBarConfig } from './types/battle';

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
  ffAccelUnits: { default: false },
  ffAccelShots: { default: true },
  ffDmgUnits: { default: false },
} as const satisfies BattleBarConfig;

// Default caps per mode (must be values from BATTLE_CONFIG.cap.options)
export const DEMO_CAP_DEFAULT = Math.pow(2, 8);   // 256 ≈ 3e+2
export const REAL_CAP_DEFAULT = Math.pow(2, 12);   // 4096 ≈ 4e+3

// ── localStorage keys (module-private) ──
const STORAGE_DEMO_UNITS = 'rts-demo-units';
const STORAGE_MAX_TOTAL_UNITS = 'rts-max-total-units';
const STORAGE_DEMO_CAP = 'rts-demo-cap';
const STORAGE_REAL_CAP = 'rts-real-cap';
const STORAGE_DEMO_GRID = 'rts-demo-grid';
const STORAGE_REAL_GRID = 'rts-real-grid';
const STORAGE_PROJ_VEL_INHERIT = 'rts-proj-vel-inherit';
const STORAGE_FF_ACCEL_UNITS = 'rts-ff-accel-units';
const STORAGE_FF_ACCEL_SHOTS = 'rts-ff-accel-shots';
const STORAGE_FF_DMG_UNITS = 'rts-ff-dmg-units';

export function loadStoredDemoUnits(): string[] | null {
  try {
    const stored = localStorage.getItem(STORAGE_DEMO_UNITS);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch { /* localStorage unavailable */ }
  return null;
}

export function saveDemoUnits(units: string[]): void {
  try { localStorage.setItem(STORAGE_DEMO_UNITS, JSON.stringify(units)); } catch { /* */ }
}

export function getDefaultDemoUnits(): string[] {
  return Object.entries(BATTLE_CONFIG.units)
    .filter(([, cfg]) => cfg.default)
    .map(([id]) => id);
}

export function loadStoredMaxTotalUnits(): number {
  try {
    const stored = localStorage.getItem(STORAGE_MAX_TOTAL_UNITS);
    if (stored) {
      const num = Number(stored);
      if (!isNaN(num) && num > 0) return num;
    }
  } catch { /* localStorage unavailable */ }
  return BATTLE_CONFIG.cap.default;
}

export function saveMaxTotalUnits(value: number): void {
  try { localStorage.setItem(STORAGE_MAX_TOTAL_UNITS, String(value)); } catch { /* */ }
}

export function loadStoredDemoCap(): number {
  try {
    const stored = localStorage.getItem(STORAGE_DEMO_CAP);
    if (stored) {
      const num = Number(stored);
      if (!isNaN(num) && num > 0) return num;
    }
  } catch { /* localStorage unavailable */ }
  return DEMO_CAP_DEFAULT;
}

export function saveDemoCap(value: number): void {
  try { localStorage.setItem(STORAGE_DEMO_CAP, String(value)); } catch { /* */ }
}

export function loadStoredRealCap(): number {
  try {
    const stored = localStorage.getItem(STORAGE_REAL_CAP);
    if (stored) {
      const num = Number(stored);
      if (!isNaN(num) && num > 0) return num;
    }
  } catch { /* localStorage unavailable */ }
  return REAL_CAP_DEFAULT;
}

export function saveRealCap(value: number): void {
  try { localStorage.setItem(STORAGE_REAL_CAP, String(value)); } catch { /* */ }
}

export function loadStoredDemoGrid(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_DEMO_GRID);
    if (stored === 'false') return false;
    if (stored === 'true') return true;
  } catch { /* localStorage unavailable */ }
  return true; // default ON for demo
}

export function saveDemoGrid(enabled: boolean): void {
  try { localStorage.setItem(STORAGE_DEMO_GRID, String(enabled)); } catch { /* */ }
}

export function loadStoredRealGrid(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_REAL_GRID);
    if (stored === 'false') return false;
    if (stored === 'true') return true;
  } catch { /* localStorage unavailable */ }
  return false; // default OFF for real
}

export function saveRealGrid(enabled: boolean): void {
  try { localStorage.setItem(STORAGE_REAL_GRID, String(enabled)); } catch { /* */ }
}

export function loadStoredProjVelInherit(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_PROJ_VEL_INHERIT);
    if (stored === 'false') return false;
    if (stored === 'true') return true;
  } catch { /* localStorage unavailable */ }
  return BATTLE_CONFIG.projVelInherit.default;
}

export function saveProjVelInherit(enabled: boolean): void {
  try { localStorage.setItem(STORAGE_PROJ_VEL_INHERIT, String(enabled)); } catch { /* */ }
}

export function loadStoredFfAccelUnits(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_FF_ACCEL_UNITS);
    if (stored === 'false') return false;
    if (stored === 'true') return true;
  } catch { /* localStorage unavailable */ }
  return BATTLE_CONFIG.ffAccelUnits.default;
}

export function saveFfAccelUnits(enabled: boolean): void {
  try { localStorage.setItem(STORAGE_FF_ACCEL_UNITS, String(enabled)); } catch { /* */ }
}

export function loadStoredFfAccelShots(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_FF_ACCEL_SHOTS);
    if (stored === 'false') return false;
    if (stored === 'true') return true;
  } catch { /* localStorage unavailable */ }
  return BATTLE_CONFIG.ffAccelShots.default;
}

export function saveFfAccelShots(enabled: boolean): void {
  try { localStorage.setItem(STORAGE_FF_ACCEL_SHOTS, String(enabled)); } catch { /* */ }
}

export function loadStoredFfDmgUnits(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_FF_DMG_UNITS);
    if (stored === 'false') return false;
    if (stored === 'true') return true;
  } catch { /* localStorage unavailable */ }
  return BATTLE_CONFIG.ffDmgUnits.default;
}

export function saveFfDmgUnits(enabled: boolean): void {
  try { localStorage.setItem(STORAGE_FF_DMG_UNITS, String(enabled)); } catch { /* */ }
}
