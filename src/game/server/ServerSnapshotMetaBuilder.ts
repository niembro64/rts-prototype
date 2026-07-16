import type { NetworkServerSnapshotMeta } from '../network/NetworkTypes';
import type { SnapshotRate, TickRate } from '../../types/server';
import type { ShieldReflectionMode } from '../../types/shotTypes';
import type { UnitGroundNormalEmaMode } from '../../shellConfig';

type ServerSnapshotMetaInput = {
  tickAvg: number;
  tickLow: number;
  tickRateHz: TickRate;
  snapshotRate: SnapshotRate;
  ipAddress: string;
  allowedUnits: ReadonlySet<string> | undefined;
  maxUnits: number | undefined;
  unitCount: number | undefined;
  turretShieldPanelsEnabled: boolean | undefined;
  turretShieldSpheresEnabled: boolean | undefined;
  forceFieldsVisible: boolean | undefined;
  shieldsObstructSight: boolean | undefined;
  shieldReflectionMode: ShieldReflectionMode | undefined;
  fogOfWarEnabled: boolean | undefined;
  converterTax: number | undefined;
  tickMsAvg: number;
  tickMsHi: number;
  tickMsInitialized: boolean;
  wind: {
    x: number;
    y: number;
    z: number;
    speed: number;
    angle: number;
  };
  retainedPools: NetworkServerSnapshotMeta['retainedPools'];
  unitGroundNormalEmaMode: UnitGroundNormalEmaMode;
};

export class ServerSnapshotMetaBuilder {
  private lastServerTime = '';
  private lastServerTimeEpochSec = -1;
  private allowedUnitsSource: ReadonlySet<string> | undefined;
  private allowedUnitsCache: string[] | undefined;
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
      snaps: { rate: input.snapshotRate },
      server: { time: this.formatServerTime(), ip: input.ipAddress },
      units: {
        allowed: this.resolveAllowedUnits(input.allowedUnits),
        max: input.maxUnits,
        count: input.unitCount,
      },
      turretShieldPanelsEnabled: input.turretShieldPanelsEnabled,
      turretShieldSpheresEnabled: input.turretShieldSpheresEnabled,
      forceFieldsVisible: input.forceFieldsVisible,
      shieldsObstructSight: input.shieldsObstructSight,
      shieldReflectionMode: input.shieldReflectionMode,
      fogOfWarEnabled: input.fogOfWarEnabled,
      converterTax: input.converterTax,
      cpu: { avg: cpuAvg, hi: cpuHi },
      wind: {
        x: input.wind.x,
        y: input.wind.y,
        z: input.wind.z,
        speed: input.wind.speed,
        angle: input.wind.angle,
      },
      retainedPools: input.retainedPools,
      unitGroundNormalEma: input.unitGroundNormalEmaMode,
    };
  }

  private formatServerTime(): string {
    const nowMs = Date.now();
    const epochSec = Math.floor(nowMs / 1000);
    if (epochSec !== this.lastServerTimeEpochSec) {
      this.lastServerTimeEpochSec = epochSec;
      this.lastServerTime = this.timeFormatter.format(new Date(nowMs));
    }
    return this.lastServerTime;
  }

  private resolveAllowedUnits(allowedUnits: ReadonlySet<string> | undefined): string[] | undefined {
    if (allowedUnits === undefined) {
      this.allowedUnitsSource = undefined;
      this.allowedUnitsCache = undefined;
      return undefined;
    }
    const cached = this.allowedUnitsCache;
    if (
      allowedUnits === this.allowedUnitsSource &&
      cached !== undefined &&
      cached.length === allowedUnits.size
    ) {
      let index = 0;
      let matches = true;
      for (const unitBlueprintId of allowedUnits) {
        if (cached[index++] !== unitBlueprintId) {
          matches = false;
          break;
        }
      }
      if (matches) return cached;
    }
    const next: string[] = [];
    for (const unitBlueprintId of allowedUnits) next.push(unitBlueprintId);
    this.allowedUnitsSource = allowedUnits;
    this.allowedUnitsCache = next;
    return next;
  }
}
