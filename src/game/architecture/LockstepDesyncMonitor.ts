import type { CanonicalServerStateHash } from './CanonicalStateHash';
import type { LockstepCompleteCommandFrame } from './LockstepFrameScheduler';
import type { PlayerId } from '../sim/types';

export type LockstepDesyncReport = {
  readonly schema: 'budget-annihilation.lockstep-desync-report.v1';
  readonly frame: number;
  readonly detectedAtMs: number;
  readonly localPlayerId: PlayerId;
  readonly remotePlayerId: PlayerId | null;
  readonly peerIds: readonly PlayerId[];
  readonly initializationHash: string;
  readonly localHash: CanonicalServerStateHash;
  readonly remoteHash: CanonicalServerStateHash | null;
  readonly hashesByPlayer: readonly {
    readonly playerId: PlayerId;
    readonly stateHash: CanonicalServerStateHash;
  }[];
  readonly recentCommandFrames: readonly LockstepCompleteCommandFrame[];
};

export type LockstepChecksumRecord = {
  readonly playerId: PlayerId;
  readonly frame: number;
  readonly stateHash: CanonicalServerStateHash;
};

export type LockstepDesyncMonitorOptions = {
  readonly localPlayerId: PlayerId;
  readonly peerIds: readonly PlayerId[];
  readonly initializationHash: string;
  readonly getRecentCommandFrames: () => readonly LockstepCompleteCommandFrame[];
  readonly nowMs?: () => number;
  readonly onDesync?: (report: LockstepDesyncReport) => void;
};

export type LockstepChecksumDiagnostics = {
  readonly latestChecksumFrame: number | null;
  readonly lastAgreedChecksumFrame: number | null;
  readonly latestChecksumFrameByPlayer: readonly {
    readonly playerId: PlayerId;
    readonly frame: number;
  }[];
};

export class LockstepDesyncMonitor {
  private readonly localPlayerId: PlayerId;
  private readonly peerIds: readonly PlayerId[];
  private readonly initializationHash: string;
  private readonly getRecentCommandFrames: () => readonly LockstepCompleteCommandFrame[];
  private readonly nowMs: () => number;
  private readonly onDesync: ((report: LockstepDesyncReport) => void) | undefined;
  private readonly checksumsByFrame = new Map<number, Map<PlayerId, CanonicalServerStateHash>>();
  private readonly latestChecksumFrameByPlayer = new Map<PlayerId, number>();
  private desyncReport: LockstepDesyncReport | null = null;
  private latestChecksumFrame: number | null = null;
  private lastAgreedChecksumFrame: number | null = null;

  constructor(options: LockstepDesyncMonitorOptions) {
    this.localPlayerId = options.localPlayerId;
    this.peerIds = [...options.peerIds].sort((a, b) => a - b);
    this.initializationHash = options.initializationHash;
    this.getRecentCommandFrames = options.getRecentCommandFrames;
    this.nowMs = options.nowMs ?? defaultNowMs;
    this.onDesync = options.onDesync;
  }

  recordChecksum(record: LockstepChecksumRecord): LockstepDesyncReport | null {
    if (this.desyncReport !== null) return this.desyncReport;
    if (!Number.isInteger(record.frame) || record.frame < 0) {
      throw new Error('[lockstep desync] checksum frame must be a non-negative integer');
    }

    let frameChecksums = this.checksumsByFrame.get(record.frame);
    if (frameChecksums === undefined) {
      frameChecksums = new Map<PlayerId, CanonicalServerStateHash>();
      this.checksumsByFrame.set(record.frame, frameChecksums);
    }

    const previousForPlayer = frameChecksums.get(record.playerId);
    if (previousForPlayer !== undefined && previousForPlayer.hash === record.stateHash.hash) {
      return null;
    }
    this.latestChecksumFrame = Math.max(this.latestChecksumFrame ?? record.frame, record.frame);
    this.latestChecksumFrameByPlayer.set(record.playerId, record.frame);

    for (const [playerId, stateHash] of frameChecksums) {
      if (stateHash.hash === record.stateHash.hash) continue;
      const report = this.createReport(
        record.frame,
        frameChecksums,
        record,
        playerId,
        stateHash,
      );
      this.desyncReport = report;
      this.onDesync?.(report);
      return report;
    }

    frameChecksums.set(record.playerId, record.stateHash);
    this.updateAgreedChecksumFrame(record.frame, frameChecksums);
    return null;
  }

  getReport(): LockstepDesyncReport | null {
    return this.desyncReport;
  }

  getDiagnostics(): LockstepChecksumDiagnostics {
    const entries = [...this.latestChecksumFrameByPlayer.entries()].sort(([a], [b]) => a - b);
    const latestChecksumFrameByPlayer = new Array<LockstepChecksumDiagnostics['latestChecksumFrameByPlayer'][number]>(
      entries.length,
    );
    for (let i = 0; i < entries.length; i++) {
      const [playerId, frame] = entries[i];
      latestChecksumFrameByPlayer[i] = { playerId, frame };
    }
    return {
      latestChecksumFrame: this.latestChecksumFrame,
      lastAgreedChecksumFrame: this.lastAgreedChecksumFrame,
      latestChecksumFrameByPlayer,
    };
  }

  clear(): void {
    this.checksumsByFrame.clear();
    this.latestChecksumFrameByPlayer.clear();
    this.latestChecksumFrame = null;
    this.lastAgreedChecksumFrame = null;
    this.desyncReport = null;
  }

  private updateAgreedChecksumFrame(
    frame: number,
    frameChecksums: ReadonlyMap<PlayerId, CanonicalServerStateHash>,
  ): void {
    if (frameChecksums.size < this.peerIds.length) return;
    let agreedHash: string | null = null;
    for (const playerId of this.peerIds) {
      const stateHash = frameChecksums.get(playerId);
      if (stateHash === undefined) return;
      if (agreedHash === null) {
        agreedHash = stateHash.hash;
      } else if (stateHash.hash !== agreedHash) {
        return;
      }
    }
    this.lastAgreedChecksumFrame = Math.max(this.lastAgreedChecksumFrame ?? frame, frame);
  }

  private createReport(
    frame: number,
    frameChecksums: ReadonlyMap<PlayerId, CanonicalServerStateHash>,
    incoming: LockstepChecksumRecord,
    mismatchedPlayerId: PlayerId,
    mismatchedHash: CanonicalServerStateHash,
  ): LockstepDesyncReport {
    const entries = [
      ...frameChecksums.entries(),
      [incoming.playerId, incoming.stateHash] as const,
    ].sort(([a], [b]) => a - b);
    const hashesByPlayer = new Array<LockstepDesyncReport['hashesByPlayer'][number]>(entries.length);
    for (let i = 0; i < entries.length; i++) {
      const [playerId, stateHash] = entries[i];
      hashesByPlayer[i] = { playerId, stateHash };
    }
    const localHash = incoming.playerId === this.localPlayerId
      ? incoming.stateHash
      : frameChecksums.get(this.localPlayerId) ?? mismatchedHash;
    const remotePlayerId = incoming.playerId === this.localPlayerId
      ? mismatchedPlayerId
      : incoming.playerId;
    const remoteHash = incoming.playerId === this.localPlayerId
      ? mismatchedHash
      : incoming.stateHash;

    return {
      schema: 'budget-annihilation.lockstep-desync-report.v1',
      frame,
      detectedAtMs: this.nowMs(),
      localPlayerId: this.localPlayerId,
      remotePlayerId,
      peerIds: this.peerIds,
      initializationHash: this.initializationHash,
      localHash,
      remoteHash,
      hashesByPlayer,
      recentCommandFrames: this.getRecentCommandFrames(),
    };
  }
}

export function exportLockstepDesyncReport(report: LockstepDesyncReport): string {
  return JSON.stringify(report, null, 2);
}

function defaultNowMs(): number {
  return 0;
}
