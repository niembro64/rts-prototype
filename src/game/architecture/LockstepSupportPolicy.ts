import type { NetworkRole } from '../network/NetworkTypes';
import type { PlayerId } from '../sim/types';

export type LockstepSupportBoundaries = {
  readonly realBattlesOnly: true;
  readonly aiPlayers: false;
  readonly backgroundBattles: false;
  readonly hostMigration: false;
  readonly hostRole: 'coordinator-relay-only';
  readonly automaticResync: false;
};

export const LOCKSTEP_SUPPORT_BOUNDARIES: LockstepSupportBoundaries = {
  realBattlesOnly: true,
  aiPlayers: false,
  backgroundBattles: false,
  hostMigration: false,
  hostRole: 'coordinator-relay-only',
  automaticResync: false,
};

type LockstepSupportCheckOptions = {
  readonly playerIds: readonly PlayerId[];
  readonly aiPlayerIds: readonly PlayerId[] | undefined;
  /** The SEAT this client holds, or undefined when it is watching. A watcher
   *  is a first-class participant now: it simulates every frame and is simply
   *  never in the roster, so a roster that does not contain it is correct
   *  rather than an error. */
  readonly localPlayerId: PlayerId | undefined;
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
    throw new Error('deterministic-lockstep does not support AI players');
  }
  if (options.playerIds.length === 0) {
    throw new Error('deterministic-lockstep requires at least one seated player');
  }
  if (
    options.localPlayerId !== undefined &&
    !options.playerIds.includes(options.localPlayerId)
  ) {
    throw new Error(
      `deterministic-lockstep seat ${options.localPlayerId} is not in the frame-0 roster ` +
        `[${options.playerIds.join(',')}]; a client holding a seat must be in it`,
    );
  }
}
