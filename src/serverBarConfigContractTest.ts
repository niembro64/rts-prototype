import serverBarConfig from './serverBarConfig.json';
import {
  HOST_SNAPSHOT_RATE_DEFAULT,
  HOST_SNAPSHOT_RATE_NORMAL_MAX,
  HOST_SNAPSHOT_RATE_NORMAL_MIN,
  SERVER_CONFIG,
  isNormalSnapshotRate,
  isSnapshotRateOption,
} from './serverBarConfig';

type HostSnapshotDefaultKey = 'demoDefault' | 'realDefault';

const HOST_SNAPSHOT_DEFAULT_KEYS: readonly HostSnapshotDefaultKey[] = [
  'demoDefault',
  'realDefault',
];

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[server bar config contract] ${message}`);
  }
}

export function runServerBarConfigContractTest(): void {
  for (const key of HOST_SNAPSHOT_DEFAULT_KEYS) {
    const rate = serverBarConfig.hostSnapshotRate[key];
    assertContract(
      isSnapshotRateOption(rate),
      `hostSnapshotRate.${key} must be one of the authored snapshot options`,
    );
    assertContract(
      isNormalSnapshotRate(rate),
      `hostSnapshotRate.${key} must stay within the normal ${HOST_SNAPSHOT_RATE_NORMAL_MIN}-${HOST_SNAPSHOT_RATE_NORMAL_MAX} Hz band`,
    );
  }

  assertContract(
    isNormalSnapshotRate(HOST_SNAPSHOT_RATE_DEFAULT),
    'HOST_SNAPSHOT_RATE_DEFAULT must stay inside the normal snapshot band',
  );
  assertContract(
    SERVER_CONFIG.snapshot.default === HOST_SNAPSHOT_RATE_DEFAULT,
    'SERVER_CONFIG.snapshot.default must resolve to HOST_SNAPSHOT_RATE_DEFAULT',
  );
}
