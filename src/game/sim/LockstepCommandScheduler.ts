import type { Command, CommandBundle } from '../../types/commands';
import { COMMAND_SCHEMA_VERSION } from '../../types/commands';
import type { PlayerId } from '../../types/entityTypes';
import { CommandQueue } from './commands';

export type LockstepBundleAcceptResult =
  | { status: 'accepted'; bundle: CommandBundle }
  | { status: 'duplicate'; bundle: CommandBundle; existing: CommandBundle }
  | { status: 'invalid'; bundle: CommandBundle; reason: string }
  | { status: 'late'; bundle: CommandBundle; nextReleaseTick: number }
  | { status: 'unknownPeer'; bundle: CommandBundle; peerId: PlayerId };

export type LockstepTickReleaseResult =
  | { status: 'ready'; targetTick: number; commands: Command[] }
  | { status: 'waiting'; targetTick: number; missingPeerIds: PlayerId[] }
  | { status: 'alreadyReleased'; targetTick: number; nextReleaseTick: number };

export class LockstepCommandScheduler {
  private readonly peerIds: PlayerId[];
  private readonly peerSet: ReadonlySet<PlayerId>;
  private readonly bundlesByTick = new Map<number, Map<PlayerId, CommandBundle>>();
  private nextReleaseTick = 0;

  constructor(peerIds: readonly PlayerId[]) {
    const normalizedPeerIds = normalizePeerIds(peerIds);
    if (normalizedPeerIds.length === 0) {
      throw new Error('LockstepCommandScheduler requires at least one peer');
    }
    this.peerIds = normalizedPeerIds;
    this.peerSet = new Set(normalizedPeerIds);
  }

  acceptBundle(bundle: CommandBundle): LockstepBundleAcceptResult {
    const invalidReason = validateBundle(bundle);
    if (invalidReason !== null) return { status: 'invalid', bundle, reason: invalidReason };
    if (!this.peerSet.has(bundle.peerId)) {
      return { status: 'unknownPeer', bundle, peerId: bundle.peerId };
    }
    if (bundle.targetTick < this.nextReleaseTick) {
      return { status: 'late', bundle, nextReleaseTick: this.nextReleaseTick };
    }
    let bundlesForTick = this.bundlesByTick.get(bundle.targetTick);
    if (bundlesForTick === undefined) {
      bundlesForTick = new Map<PlayerId, CommandBundle>();
      this.bundlesByTick.set(bundle.targetTick, bundlesForTick);
    }
    const existing = bundlesForTick.get(bundle.peerId);
    if (existing !== undefined) return { status: 'duplicate', bundle, existing };
    bundlesForTick.set(bundle.peerId, bundle);
    return { status: 'accepted', bundle };
  }

  releaseTickToQueue(
    targetTick: number,
    commandQueue: CommandQueue,
  ): LockstepTickReleaseResult {
    if (targetTick < this.nextReleaseTick) {
      return { status: 'alreadyReleased', targetTick, nextReleaseTick: this.nextReleaseTick };
    }
    const bundlesForTick = this.bundlesByTick.get(targetTick);
    const missingPeerIds = this.missingPeerIds(bundlesForTick);
    if (missingPeerIds.length > 0) {
      return { status: 'waiting', targetTick, missingPeerIds };
    }

    const bundles = this.peerIds.map((peerId) => bundlesForTick!.get(peerId)!);
    const commands = orderedCommandsFromBundles(bundles);
    commandQueue.enqueueMany(commands);
    this.bundlesByTick.delete(targetTick);
    this.nextReleaseTick = Math.max(this.nextReleaseTick, targetTick + 1);
    return { status: 'ready', targetTick, commands };
  }

  getMissingPeerIds(targetTick: number): PlayerId[] {
    return this.missingPeerIds(this.bundlesByTick.get(targetTick));
  }

  getNextReleaseTick(): number {
    return this.nextReleaseTick;
  }

  clear(): void {
    this.bundlesByTick.clear();
    this.nextReleaseTick = 0;
  }

  private missingPeerIds(
    bundlesForTick: Map<PlayerId, CommandBundle> | undefined,
  ): PlayerId[] {
    if (bundlesForTick === undefined) return [...this.peerIds];
    const missing: PlayerId[] = [];
    for (const peerId of this.peerIds) {
      if (!bundlesForTick.has(peerId)) missing.push(peerId);
    }
    return missing;
  }
}

function normalizePeerIds(peerIds: readonly PlayerId[]): PlayerId[] {
  const unique = new Set<PlayerId>();
  for (const peerId of peerIds) {
    if (Number.isInteger(peerId) && peerId > 0) unique.add(peerId);
  }
  return [...unique].sort((a, b) => a - b);
}

function validateBundle(bundle: CommandBundle): string | null {
  if (bundle.schemaVersion !== COMMAND_SCHEMA_VERSION) return 'unsupported schema version';
  if (!Number.isInteger(bundle.targetTick) || bundle.targetTick < 0) return 'invalid targetTick';
  if (!Number.isInteger(bundle.peerId) || bundle.peerId <= 0) return 'invalid peerId';
  if (!Number.isInteger(bundle.seq) || bundle.seq < 0) return 'invalid seq';
  if (!Array.isArray(bundle.commands)) return 'commands must be an array';
  for (let i = 0; i < bundle.commands.length; i++) {
    if (bundle.commands[i].tick !== bundle.targetTick) {
      return `command ${i} tick does not match targetTick`;
    }
  }
  return null;
}

function orderedCommandsFromBundles(bundles: readonly CommandBundle[]): Command[] {
  const ordered = [...bundles].sort(compareBundlesForExecution);
  const commands: Command[] = [];
  for (const bundle of ordered) {
    for (const command of bundle.commands) commands.push(command);
  }
  return commands;
}

function compareBundlesForExecution(a: CommandBundle, b: CommandBundle): number {
  const tickDelta = a.targetTick - b.targetTick;
  if (tickDelta !== 0) return tickDelta;
  const peerDelta = a.peerId - b.peerId;
  if (peerDelta !== 0) return peerDelta;
  return a.seq - b.seq;
}
