import { ARCHITECTURE_CONFIG } from '@/architectureConfig';
import type { NetworkRole } from '../network/NetworkTypes';
import type { PlayerId } from '../sim/types';

export type LockstepSupportBoundaries = {
  readonly realBattlesOnly: true;
  readonly aiPlayers: false;
  readonly backgroundBattles: false;
  readonly spectators: 'frame-0-only-roster-seat-required';
  readonly lateJoin: false;
  readonly reconnect: false;
  readonly hostMigration: false;
  readonly hostRole: 'coordinator-relay-only';
  readonly automaticResync: false;
};

export const LOCKSTEP_SUPPORT_BOUNDARIES: LockstepSupportBoundaries = {
  realBattlesOnly: true,
  aiPlayers: false,
  backgroundBattles: false,
  spectators: 'frame-0-only-roster-seat-required',
  lateJoin: false,
  reconnect: false,
  hostMigration: false,
  hostRole: 'coordinator-relay-only',
  automaticResync: false,
};

type LockstepSupportCheckOptions = {
  readonly playerIds: readonly PlayerId[];
  readonly aiPlayerIds: readonly PlayerId[] | undefined;
  readonly localPlayerId: PlayerId;
  readonly networkRole: NetworkRole | null;
  readonly battleKind: 'real';
};

export function assertDeterministicLockstepSupported(
  options: LockstepSupportCheckOptions,
): void {
  if (options.battleKind !== 'real') {
    throw new Error('deterministic-lockstep currently supports real battles only');
  }
  if ((options.aiPlayerIds?.length ?? 0) > 0) {
    throw new Error('deterministic-lockstep first release does not support AI players');
  }
  if (!options.playerIds.includes(options.localPlayerId)) {
    throw new Error(
      'deterministic-lockstep first release does not support spectators or late joins; ' +
        'the local player must be in the frame-0 roster',
    );
  }
  if (ARCHITECTURE_CONFIG.lockstep.allowLateJoin !== false) {
    throw new Error('deterministic-lockstep late join must remain disabled until resync is implemented');
  }
}
