// localStorage persistence for control bar settings.
// Each load function returns the stored value or a default, never throws.

import {
  CONTROL_BARS,
  type SnapshotRate,
  type KeyframeRatio,
  type TickRate,
} from '../controlBarConfig';

export function loadStoredSnapshotRate(): SnapshotRate {
  try {
    const stored = localStorage.getItem(CONTROL_BARS.storage.snapshotRate);
    if (stored === 'none') return 'none';
    if (stored) {
      const num = Number(stored);
      if (!isNaN(num) && num > 0) return num;
    }
  } catch { /* localStorage unavailable */ }
  return CONTROL_BARS.server.snapshot.default;
}

export function saveSnapshotRate(rate: SnapshotRate): void {
  try { localStorage.setItem(CONTROL_BARS.storage.snapshotRate, String(rate)); } catch { /* */ }
}

export function loadStoredKeyframeRatio(): KeyframeRatio {
  try {
    const stored = localStorage.getItem(CONTROL_BARS.storage.keyframeRatio);
    if (stored === 'ALL') return 'ALL';
    if (stored === 'NONE') return 'NONE';
    if (stored) {
      const num = Number(stored);
      if (!isNaN(num)) return num;
    }
  } catch { /* localStorage unavailable */ }
  return CONTROL_BARS.server.keyframe.default;
}

export function saveKeyframeRatio(ratio: KeyframeRatio): void {
  try { localStorage.setItem(CONTROL_BARS.storage.keyframeRatio, String(ratio)); } catch { /* */ }
}

export function loadStoredTickRate(): TickRate {
  try {
    const stored = localStorage.getItem(CONTROL_BARS.storage.tickRate);
    if (stored) {
      const num = Number(stored);
      if (!isNaN(num) && num > 0) return num;
    }
  } catch { /* localStorage unavailable */ }
  return CONTROL_BARS.server.tickRate.default;
}

export function saveTickRate(rate: TickRate): void {
  try { localStorage.setItem(CONTROL_BARS.storage.tickRate, String(rate)); } catch { /* */ }
}

export function loadStoredDemoUnits(): string[] | null {
  try {
    const stored = localStorage.getItem(CONTROL_BARS.storage.demoUnits);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch { /* localStorage unavailable */ }
  return null;
}

export function saveDemoUnits(units: string[]): void {
  if (units.length === 0) return;
  try { localStorage.setItem(CONTROL_BARS.storage.demoUnits, JSON.stringify(units)); } catch { /* */ }
}

export function loadStoredMaxTotalUnits(): number {
  try {
    const stored = localStorage.getItem(CONTROL_BARS.storage.maxTotalUnits);
    if (stored) {
      const num = Number(stored);
      if (!isNaN(num) && num > 0) return num;
    }
  } catch { /* localStorage unavailable */ }
  return CONTROL_BARS.battle.cap.default;
}

export function saveMaxTotalUnits(value: number): void {
  try { localStorage.setItem(CONTROL_BARS.storage.maxTotalUnits, String(value)); } catch { /* */ }
}

export function loadStoredProjVelInherit(): boolean {
  try {
    const stored = localStorage.getItem(CONTROL_BARS.storage.projVelInherit);
    if (stored === 'false') return false;
    if (stored === 'true') return true;
  } catch { /* localStorage unavailable */ }
  return CONTROL_BARS.battle.projVelInherit.default;
}

export function saveProjVelInherit(enabled: boolean): void {
  try { localStorage.setItem(CONTROL_BARS.storage.projVelInherit, String(enabled)); } catch { /* */ }
}
