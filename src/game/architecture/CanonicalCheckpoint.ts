import type { GameServerConfig } from '@/types/game';
import type { Command } from '../sim/commands';
import { ServerBootstrap } from '../server/ServerBootstrap';
import { ServerSimulationCore } from '../server/ServerSimulationCore';
import {
  hashCanonicalValue,
  SIM_WASM_EXPECTED_VERSION,
} from './CanonicalMatchInitialization';
import type { CanonicalServerStateHash } from './CanonicalStateHash';
import { LOCKSTEP_FIXED_DT_MS } from './LockstepFrameScheduler';
import { resetReusableSimulationStateForDeterministicReplay } from './DeterministicReplayHarness';

export type CanonicalCheckpointCommandFrame = {
  readonly frame: number;
  readonly frameSequence: number;
  readonly commands: readonly Command[];
};

export type CanonicalCheckpoint = {
  readonly schema: 'budget-annihilation.canonical-checkpoint.v1';
  readonly format: 'deterministic-command-log.v1';
  readonly frame: number;
  readonly fixedDtMs: number;
  readonly initializationHash: string;
  readonly config: GameServerConfig;
  readonly commandFrames: readonly CanonicalCheckpointCommandFrame[];
  readonly stateHash: CanonicalServerStateHash;
  readonly content: {
    readonly simWasmExpectedVersion: string;
    readonly configHash: string;
    readonly commandLogHash: string;
  };
};

type ExportCanonicalCheckpointOptions = {
  readonly core: ServerSimulationCore;
  readonly config: GameServerConfig;
  readonly commandFrames: readonly CanonicalCheckpointCommandFrame[];
  readonly initializationHash: string;
  readonly fixedDtMs?: number;
};

type ImportedCanonicalCheckpoint = {
  readonly core: ServerSimulationCore;
  readonly verifiedHash: CanonicalServerStateHash;
};

export function exportCanonicalCheckpoint(
  options: ExportCanonicalCheckpointOptions,
): CanonicalCheckpoint {
  const frame = options.core.world.getTick();
  const fixedDtMs = options.fixedDtMs ?? LOCKSTEP_FIXED_DT_MS;
  assertFrameInteger(frame, 'checkpoint frame');
  const config = cloneJson(options.config);
  const commandFrames = normalizeCommandFrames(options.commandFrames)
    .filter((entry) => entry.frame < frame);
  const stateHash = options.core.getCanonicalStateHash();

  return {
    schema: 'budget-annihilation.canonical-checkpoint.v1',
    format: 'deterministic-command-log.v1',
    frame,
    fixedDtMs,
    initializationHash: options.initializationHash,
    config,
    commandFrames,
    stateHash,
    content: {
      simWasmExpectedVersion: SIM_WASM_EXPECTED_VERSION,
      configHash: hashCanonicalValue(config),
      commandLogHash: hashCanonicalValue(commandFrames),
    },
  };
}

export function importCanonicalCheckpoint(
  checkpoint: CanonicalCheckpoint,
): ImportedCanonicalCheckpoint {
  validateCheckpoint(checkpoint);
  resetReusableSimulationStateForDeterministicReplay();
  const boot = ServerBootstrap.bootstrap(cloneJson(checkpoint.config));
  const core = new ServerSimulationCore(boot);
  try {
    const commandsByFrame = new Map<number, readonly Command[]>();
    for (const frame of checkpoint.commandFrames) {
      commandsByFrame.set(frame.frame, frame.commands);
    }

    for (let frame = 0; frame < checkpoint.frame; frame++) {
      core.stepFixedTick(checkpoint.fixedDtMs, commandsByFrame.get(frame) ?? []);
    }

    const verifiedHash = core.getCanonicalStateHash();
    if (verifiedHash.hash !== checkpoint.stateHash.hash) {
      throw new Error(
        '[canonical checkpoint] imported hash mismatch: ' +
          `${verifiedHash.hash} !== ${checkpoint.stateHash.hash}`,
      );
    }
    return { core, verifiedHash };
  } catch (err) {
    disposeCheckpointCore(core);
    throw err;
  }
}

export function disposeCheckpointCore(core: ServerSimulationCore): void {
  core.clearPendingCommandsAndStepBuffers();
  core.resetSessionState();
  core.detachSimulationCallbacks();
  core.dispose();
  resetReusableSimulationStateForDeterministicReplay();
}

function validateCheckpoint(checkpoint: CanonicalCheckpoint): void {
  if (checkpoint.schema !== 'budget-annihilation.canonical-checkpoint.v1') {
    throw new Error('[canonical checkpoint] unsupported schema');
  }
  if (checkpoint.format !== 'deterministic-command-log.v1') {
    throw new Error('[canonical checkpoint] unsupported format');
  }
  assertFrameInteger(checkpoint.frame, 'checkpoint frame');
  if (!Number.isFinite(checkpoint.fixedDtMs) || checkpoint.fixedDtMs <= 0) {
    throw new Error('[canonical checkpoint] fixedDtMs must be positive');
  }
  if (checkpoint.content.simWasmExpectedVersion !== SIM_WASM_EXPECTED_VERSION) {
    throw new Error(
      '[canonical checkpoint] incompatible sim-wasm version: ' +
        `${checkpoint.content.simWasmExpectedVersion} !== ${SIM_WASM_EXPECTED_VERSION}`,
    );
  }
  const configHash = hashCanonicalValue(checkpoint.config);
  if (checkpoint.content.configHash !== configHash) {
    throw new Error('[canonical checkpoint] config hash mismatch');
  }
  const normalizedCommandFrames = normalizeCommandFrames(checkpoint.commandFrames);
  const commandLogHash = hashCanonicalValue(normalizedCommandFrames);
  if (checkpoint.content.commandLogHash !== commandLogHash) {
    throw new Error('[canonical checkpoint] command log hash mismatch');
  }
}

function normalizeCommandFrames(
  frames: readonly CanonicalCheckpointCommandFrame[],
): CanonicalCheckpointCommandFrame[] {
  return frames
    .map((frame) => {
      assertFrameInteger(frame.frame, 'command frame');
      assertFrameInteger(frame.frameSequence, 'command frame sequence');
      return {
        frame: frame.frame,
        frameSequence: frame.frameSequence,
        commands: cloneJson(frame.commands),
      };
    })
    .sort((a, b) => a.frame - b.frame || a.frameSequence - b.frameSequence);
}

function assertFrameInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`[canonical checkpoint] ${label} must be a non-negative integer`);
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
