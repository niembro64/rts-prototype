export const BATTLE_CONFIG = {
  unitShortNames: {
    jackal: 'JKL',
    lynx: 'LNX',
    daddy: 'DDY',
    badger: 'BDG',
    mongoose: 'MGS',
    tick: 'TCK',
    mammoth: 'MMT',
    widow: 'WDW',
    tarantula: 'TRN',
  } as Record<string, string>,
  cap: {
    default: Math.pow(2, 10),
    options: [
      Math.pow(2, 2),
      Math.pow(2, 4),
      Math.pow(2, 6),
      Math.pow(2, 8),
      Math.pow(2, 10),
      Math.pow(2, 11),
      Math.pow(2, 12),
      Math.pow(2, 13),
    ] as readonly number[],
  },
  projVelInherit: { default: false },
  ffAccelUnits: { default: false },
  ffAccelShots: { default: true },
} as const;

// ── localStorage keys (module-private) ──
const STORAGE_DEMO_UNITS = 'rts-demo-units';
const STORAGE_MAX_TOTAL_UNITS = 'rts-max-total-units';
const STORAGE_PROJ_VEL_INHERIT = 'rts-proj-vel-inherit';
const STORAGE_FF_ACCEL_UNITS = 'rts-ff-accel-units';
const STORAGE_FF_ACCEL_SHOTS = 'rts-ff-accel-shots';

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
  if (units.length === 0) return;
  try { localStorage.setItem(STORAGE_DEMO_UNITS, JSON.stringify(units)); } catch { /* */ }
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
