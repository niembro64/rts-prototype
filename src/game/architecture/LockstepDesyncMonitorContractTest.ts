import type { CanonicalServerStateHash } from './CanonicalStateHash';
import {
  exportLockstepDesyncReport,
  LockstepDesyncMonitor,
} from './LockstepDesyncMonitor';
import type { LockstepCompleteCommandFrame } from './LockstepFrameScheduler';
import type { PlayerId } from '../sim/types';

function assertContract(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[lockstep desync monitor contract] ${message}`);
  }
}

export function runLockstepDesyncMonitorContractTest(): void {
  const recentFrames: LockstepCompleteCommandFrame[] = [
    { frame: 58, frameSequence: 58, commands: [] },
    { frame: 59, frameSequence: 59, commands: [] },
  ];
  const reports: unknown[] = [];
  const monitor = new LockstepDesyncMonitor({
    localPlayerId: 1 as PlayerId,
    peerIds: [1 as PlayerId, 2 as PlayerId, 3 as PlayerId],
    initializationHash: 'init-hash',
    getRecentCommandFrames: () => recentFrames,
    nowMs: () => 12345,
    onDesync: (report) => reports.push(report),
  });

  assertContract(
    monitor.recordChecksum({ playerId: 1 as PlayerId, frame: 60, stateHash: hash('same') }) === null,
    'first checksum for a frame must not report desync',
  );
  assertContract(
    monitor.recordChecksum({ playerId: 2 as PlayerId, frame: 60, stateHash: hash('same') }) === null,
    'matching peer checksum must not report desync',
  );

  const report = monitor.recordChecksum({
    playerId: 3 as PlayerId,
    frame: 60,
    stateHash: hash('different'),
  });
  assertContract(report !== null, 'mismatched peer checksum must report desync');
  assertContract(reports.length === 1, 'desync callback must fire exactly once');
  assertContract(report.schema === 'budget-annihilation.lockstep-desync-report.v1', 'report schema must be versioned');
  assertContract(report.frame === 60 && report.detectedAtMs === 12345, 'report must include frame and detection time');
  assertContract(report.initializationHash === 'init-hash', 'report must include initialization hash');
  assertContract(report.localHash.hash === 'same', 'report must include local state hash');
  assertContract(report.remoteHash?.hash === 'different', 'report must include remote state hash');
  assertContract(report.remotePlayerId === 3, 'report must identify mismatched peer');
  assertContract(report.recentCommandFrames.length === 2, 'report must include recent command frames');
  assertContract(
    report.hashesByPlayer.map((entry) => entry.playerId).join(',') === '1,2,3',
    'report must include all known hashes for the frame',
  );

  const exported = exportLockstepDesyncReport(report);
  const parsed = JSON.parse(exported) as { schema?: string; frame?: number };
  assertContract(
    parsed.schema === report.schema && parsed.frame === report.frame,
    'exported desync report must be parseable JSON',
  );

  monitor.recordChecksum({ playerId: 2 as PlayerId, frame: 60, stateHash: hash('other') });
  assertContract(reports.length === 1, 'monitor must keep the first desync report stable');

  const watcherReports: unknown[] = [];
  const watcherMonitor = new LockstepDesyncMonitor({
    localPlayerId: 0 as PlayerId,
    peerIds: [],
    initializationHash: 'watcher-init-hash',
    getRecentCommandFrames: () => recentFrames,
    onDesync: (watcherReport) => watcherReports.push(watcherReport),
  });
  assertContract(
    watcherMonitor.recordChecksum({
      playerId: 0 as PlayerId,
      frame: 60,
      stateHash: hash('watcher-replay'),
    }) === null &&
      watcherMonitor.recordChecksum({
        playerId: 1 as PlayerId,
        frame: 60,
        stateHash: hash('seated-world'),
      }) === null &&
      watcherMonitor.recordChecksum({
        playerId: 2 as PlayerId,
        frame: 60,
        stateHash: hash('another-seated-world'),
      }) === null &&
      watcherReports.length === 0,
    'a spectator must store its replay checksum without entering or running the seated-player desync comparison',
  );
  assertContract(
    watcherMonitor.getLatestLocalChecksum()?.stateHash.hash === 'watcher-replay' &&
      watcherMonitor.getDiagnostics().lastAgreedChecksumFrame === null,
    'spectator replay verification must remain available without claiming a seated checksum agreement',
  );

  const scopedReports: unknown[] = [];
  const scopedMonitor = new LockstepDesyncMonitor({
    localPlayerId: 1 as PlayerId,
    peerIds: [1 as PlayerId, 2 as PlayerId],
    initializationHash: 'scoped-init-hash',
    getRecentCommandFrames: () => recentFrames,
    onDesync: (scopedReport) => scopedReports.push(scopedReport),
  });
  scopedMonitor.recordChecksum({ playerId: 0 as PlayerId, frame: 90, stateHash: hash('stray') });
  scopedMonitor.recordChecksum({ playerId: 1 as PlayerId, frame: 90, stateHash: hash('agreed') });
  scopedMonitor.recordChecksum({ playerId: 2 as PlayerId, frame: 90, stateHash: hash('agreed') });
  assertContract(
    scopedReports.length === 0 && scopedMonitor.getDiagnostics().lastAgreedChecksumFrame === 90,
    'checksums outside the explicit seated comparison set must not create false mismatches or block agreement',
  );
}

function hash(value: string): CanonicalServerStateHash {
  return {
    hash: value,
    sections: {
      world: `${value}:world`,
      simulation: `${value}:simulation`,
      economy: `${value}:economy`,
      commands: `${value}:commands`,
      entities: `${value}:entities`,
    },
  };
}
