import type { NetworkServerSnapshotMeta } from '../network/NetworkTypes';
import type { KeyframeRatio, SnapshotRate, TickRate } from '../../types/server';
import type { ForceFieldReflectionMode } from '../../types/shotTypes';
import type { TiltEmaMode } from '../../shellConfig';

export type ServerSnapshotMetaInput = {
  tickAvg: number;
  tickLow: number;
  tickRateHz: TickRate;
  snapshotRate: SnapshotRate;
  keyframeRatio: KeyframeRatio;
  ipAddress: string;
  gridEnabled: boolean;
  allowedUnits?: Iterable<string>;
  maxUnits?: number;
  unitCount?: number;
  mirrorsEnabled?: boolean;
  forceFieldsEnabled?: boolean;
  forceFieldsBlockTargeting?: boolean;
  forceFieldReflectionMode?: ForceFieldReflectionMode;
  fogOfWarEnabled?: boolean;
  tickMsAvg: number;
  tickMsHi: number;
  tickMsInitialized: boolean;
  wind: {
    x: number;
    y: number;
    speed: number;
    angle: number;
  };
  tiltEmaMode: TiltEmaMode;
};

export class ServerSnapshotMetaBuilder {
  private lastServerTime = '';
  private lastServerTimeSec = -1;
  private readonly timeFormatter = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  });

  build(input: ServerSnapshotMetaInput): NetworkServerSnapshotMeta {
    const tickBudgetMs = 1000 / input.tickRateHz;
    const cpuAvg = input.tickMsInitialized
      ? (input.tickMsAvg / tickBudgetMs) * 100
      : 0;
    const cpuHi = input.tickMsInitialized
      ? (input.tickMsHi / tickBudgetMs) * 100
      : 0;

    return {
      ticks: {
        avg: input.tickAvg,
        low: input.tickLow,
        rate: input.tickRateHz,
      },
      snaps: { rate: input.snapshotRate, keyframes: input.keyframeRatio },
      server: { time: this.formatServerTime(), ip: input.ipAddress },
      grid: input.gridEnabled,
      units: {
        allowed: input.allowedUnits ? [...input.allowedUnits] : undefined,
        max: input.maxUnits,
        count: input.unitCount,
      },
      mirrorsEnabled: input.mirrorsEnabled,
      forceFieldsEnabled: input.forceFieldsEnabled,
      forceFieldsBlockTargeting: input.forceFieldsBlockTargeting,
      forceFieldReflectionMode: input.forceFieldReflectionMode,
      fogOfWarEnabled: input.fogOfWarEnabled,
      cpu: { avg: cpuAvg, hi: cpuHi },
      wind: {
        x: input.wind.x,
        y: input.wind.y,
        speed: input.wind.speed,
        angle: input.wind.angle,
      },
      tiltEma: input.tiltEmaMode,
    };
  }

  private formatServerTime(): string {
    const now = new Date();
    const sec = now.getSeconds();
    if (sec !== this.lastServerTimeSec) {
      this.lastServerTimeSec = sec;
      this.lastServerTime = this.timeFormatter.format(now);
    }
    return this.lastServerTime;
  }
}
