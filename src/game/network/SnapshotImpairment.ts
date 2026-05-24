import type { NetworkServerSnapshot } from './NetworkTypes';

type SnapshotImpairmentConfig = {
  enabled: boolean;
  delayMs: number;
  jitterMs: number;
  dropEvery: number;
  dropDeltasOnly: boolean;
};

type SnapshotImpairmentStats = {
  received: number;
  delivered: number;
  delayed: number;
  dropped: number;
  maxDelayMs: number;
  pendingTimers: number;
};

type SnapshotImpairmentDebugApi = {
  config: () => SnapshotImpairmentConfig;
  stats: () => SnapshotImpairmentStats;
  reset: () => void;
};

type SnapshotDelivery = (state: NetworkServerSnapshot) => void;
type SnapshotClone = (state: NetworkServerSnapshot) => NetworkServerSnapshot;

const QUERY_ENABLE_KEYS = ['dp03impair', 'snapshotImpairment'];
const QUERY_DELAY_KEYS = ['dp03delay', 'dp03delayMs', 'snapshotDelayMs'];
const QUERY_JITTER_KEYS = ['dp03jitter', 'dp03jitterMs', 'snapshotJitterMs'];
const QUERY_DROP_EVERY_KEYS = ['dp03dropEvery', 'snapshotDropEvery'];
const QUERY_DROP_KEYFRAMES_KEYS = ['dp03dropKeyframes', 'snapshotDropKeyframes'];

const CONFIG = readSnapshotImpairmentConfig();
const GLOBAL_STATS: SnapshotImpairmentStats = {
  received: 0,
  delivered: 0,
  delayed: 0,
  dropped: 0,
  maxDelayMs: 0,
  pendingTimers: 0,
};

declare global {
  interface Window {
    __BA_DP03_SNAPSHOT_IMPAIRMENT__: SnapshotImpairmentDebugApi | undefined;
  }
}

export class SnapshotImpairmentQueue {
  private sequence = 0;
  private sawFirstKeyframe = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();

  get enabled(): boolean {
    return CONFIG.enabled;
  }

  schedule(
    state: NetworkServerSnapshot,
    deliver: SnapshotDelivery,
    cloneForDelay: SnapshotClone | undefined = undefined,
  ): void {
    if (!CONFIG.enabled) {
      deliver(state);
      return;
    }

    GLOBAL_STATS.received++;
    this.sequence++;

    const isFirstKeyframe = !this.sawFirstKeyframe && !state.isDelta;
    if (!state.isDelta) this.sawFirstKeyframe = true;

    if (!isFirstKeyframe && this.shouldDrop(state)) {
      GLOBAL_STATS.dropped++;
      return;
    }

    const delayMs = isFirstKeyframe ? 0 : this.delayForSequence(this.sequence);
    if (delayMs <= 0) {
      GLOBAL_STATS.delivered++;
      deliver(state);
      return;
    }

    GLOBAL_STATS.delayed++;
    GLOBAL_STATS.maxDelayMs = Math.max(GLOBAL_STATS.maxDelayMs, delayMs);
    const queuedState = cloneForDelay !== undefined ? cloneForDelay(state) : state;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      GLOBAL_STATS.pendingTimers = Math.max(0, GLOBAL_STATS.pendingTimers - 1);
      GLOBAL_STATS.delivered++;
      deliver(queuedState);
    }, delayMs);
    this.timers.add(timer);
    GLOBAL_STATS.pendingTimers++;
  }

  clear(): void {
    for (const timer of this.timers) clearTimeout(timer);
    GLOBAL_STATS.pendingTimers = Math.max(0, GLOBAL_STATS.pendingTimers - this.timers.size);
    this.timers.clear();
    this.sequence = 0;
    this.sawFirstKeyframe = false;
  }

  private shouldDrop(state: NetworkServerSnapshot): boolean {
    if (CONFIG.dropEvery <= 0) return false;
    if (CONFIG.dropDeltasOnly && !state.isDelta) return false;
    return this.sequence % CONFIG.dropEvery === 0;
  }

  private delayForSequence(sequence: number): number {
    if (CONFIG.delayMs <= 0 && CONFIG.jitterMs <= 0) return 0;
    const jitter = CONFIG.jitterMs > 0 ? deterministicJitter(sequence, CONFIG.jitterMs) : 0;
    return Math.max(0, Math.round(CONFIG.delayMs + jitter));
  }
}

export function createSnapshotImpairmentQueue(_label: string): SnapshotImpairmentQueue {
  return new SnapshotImpairmentQueue();
}

function readSnapshotImpairmentConfig(): SnapshotImpairmentConfig {
  const delayMs = nonNegativeNumber(
    envNumber('VITE_BA_DP03_SNAPSHOT_DELAY_MS'),
    queryNumber(QUERY_DELAY_KEYS),
    0,
  );
  const jitterMs = nonNegativeNumber(
    envNumber('VITE_BA_DP03_SNAPSHOT_JITTER_MS'),
    queryNumber(QUERY_JITTER_KEYS),
    0,
  );
  const dropEvery = nonNegativeInteger(
    envNumber('VITE_BA_DP03_SNAPSHOT_DROP_EVERY'),
    queryNumber(QUERY_DROP_EVERY_KEYS),
    0,
  );
  const enabled =
    envFlag('VITE_BA_DP03_SNAPSHOT_IMPAIRMENT') ||
    queryFlag(QUERY_ENABLE_KEYS) ||
    delayMs > 0 ||
    jitterMs > 0 ||
    dropEvery > 0;
  return {
    enabled,
    delayMs,
    jitterMs,
    dropEvery,
    dropDeltasOnly: !queryFlag(QUERY_DROP_KEYFRAMES_KEYS),
  };
}

function envFlag(name: string): boolean {
  const value = import.meta.env[name];
  if (typeof value !== 'string') return false;
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes';
}

function queryFlag(names: readonly string[]): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  for (let i = 0; i < names.length; i++) {
    const value = params.get(names[i]);
    if (value === null) continue;
    if (value === '' || value === '1') return true;
    const normalized = value.toLowerCase();
    if (normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  }
  return false;
}

function envNumber(name: string): number | null {
  const value = import.meta.env[name];
  if (typeof value !== 'string') return null;
  return parseFiniteNumber(value);
}

function queryNumber(names: readonly string[]): number | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  for (let i = 0; i < names.length; i++) {
    const value = params.get(names[i]);
    const parsed = parseFiniteNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function parseFiniteNumber(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeNumber(primary: number | null, fallback: number | null, defaultValue: number): number {
  const value = primary !== null ? primary : fallback;
  if (value === null) return defaultValue;
  return Math.max(0, value);
}

function nonNegativeInteger(primary: number | null, fallback: number | null, defaultValue: number): number {
  return Math.floor(nonNegativeNumber(primary, fallback, defaultValue));
}

function deterministicJitter(sequence: number, jitterMs: number): number {
  const x = (sequence * 1103515245 + 12345) >>> 0;
  const unit = x / 0xFFFF_FFFF;
  return (unit * 2 - 1) * jitterMs;
}

function resetGlobalStats(): void {
  GLOBAL_STATS.received = 0;
  GLOBAL_STATS.delivered = 0;
  GLOBAL_STATS.delayed = 0;
  GLOBAL_STATS.dropped = 0;
  GLOBAL_STATS.maxDelayMs = 0;
  GLOBAL_STATS.pendingTimers = 0;
}

if (CONFIG.enabled && typeof window !== 'undefined') {
  window.__BA_DP03_SNAPSHOT_IMPAIRMENT__ = {
    config: () => ({ ...CONFIG }),
    stats: () => ({ ...GLOBAL_STATS }),
    reset: resetGlobalStats,
  };
}
