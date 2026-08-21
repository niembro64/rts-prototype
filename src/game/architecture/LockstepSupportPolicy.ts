import type { NetworkRole } from '../network/NetworkTypes';
import type { PlayerId } from '../sim/types';

export type LockstepSupportBoundaries = {
  readonly realBattlesOnly: true;
  /** Bots ARE supported — as seats driven entirely by the deterministic
   *  simulation (src/game/sim/agentSeat.ts). They issue no commands, appear
   *  in no completion/ack/checksum set, and add zero wire traffic; every
   *  peer simulates them identically because their identity is hashed into
   *  the canonical initialization. What remains unsupported is any bot that
   *  would need out-of-sim inputs (wall clocks, its own network presence). */
  readonly bots: 'deterministic-sim-only';
  readonly backgroundBattles: false;
  readonly hostMigration: false;
  readonly hostRole: 'coordinator-relay-only';
  readonly automaticResync: false;
};

export const LOCKSTEP_SUPPORT_BOUNDARIES: LockstepSupportBoundaries = {
  realBattlesOnly: true,
  bots: 'deterministic-sim-only',
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
  if (options.playerIds.length === 0) {
    throw new Error('deterministic-lockstep requires at least one seated player');
  }
  const bots = new Set(options.aiPlayerIds ?? []);
  for (const botId of bots) {
    if (!options.playerIds.includes(botId)) {
      throw new Error(
        `deterministic-lockstep bot seat ${botId} is not in the frame-0 roster ` +
          `[${options.playerIds.join(',')}]; a bot is a seat like any other`,
      );
    }
  }
  if (bots.size >= options.playerIds.length) {
    // The completion set is HUMAN seats; a match of only bots would have
    // nobody to complete a frame and nothing to wait for.
    throw new Error(
      'deterministic-lockstep requires at least one human seat; every seat is a bot',
    );
  }
  if (options.localPlayerId !== undefined && bots.has(options.localPlayerId)) {
    throw new Error(
      `deterministic-lockstep seat ${options.localPlayerId} is a bot; ` +
        'a connection cannot hold a bot seat',
    );
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
