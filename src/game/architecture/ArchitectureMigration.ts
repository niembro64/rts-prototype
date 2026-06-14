import {
  disposeCheckpointCore,
  importCanonicalCheckpoint,
  type CanonicalCheckpoint,
  type ImportedCanonicalCheckpoint,
} from './CanonicalCheckpoint';

export type ArchitectureMigrationDirection =
  | 'authoritative-server-to-deterministic-lockstep'
  | 'deterministic-lockstep-to-authoritative-server';

export type ArchitectureMigrationOptions = {
  readonly direction: ArchitectureMigrationDirection;
  readonly checkpoint: CanonicalCheckpoint;
  readonly agreedNextFrame: number;
  readonly onPauseSource: () => void;
  readonly onCommit: (imported: ImportedCanonicalCheckpoint) => void;
  readonly onRollback: (reason: string) => void;
};

export type ArchitectureMigrationResult =
  | {
      readonly ok: true;
      readonly direction: ArchitectureMigrationDirection;
      readonly agreedNextFrame: number;
      readonly imported: ImportedCanonicalCheckpoint;
    }
  | {
      readonly ok: false;
      readonly direction: ArchitectureMigrationDirection;
      readonly agreedNextFrame: number;
      readonly reason: string;
    };

export function migrateArchitectureCheckpoint(
  options: ArchitectureMigrationOptions,
): ArchitectureMigrationResult {
  try {
    if (!Number.isInteger(options.agreedNextFrame) || options.agreedNextFrame < 0) {
      throw new Error('agreed next frame must be a non-negative integer');
    }
    if (options.checkpoint.frame !== options.agreedNextFrame) {
      throw new Error(
        `checkpoint frame ${options.checkpoint.frame} does not match agreed next frame ` +
          `${options.agreedNextFrame}`,
      );
    }

    options.onPauseSource();
    const imported = importCanonicalCheckpoint(options.checkpoint);
    try {
      if (imported.verifiedHash.hash !== options.checkpoint.stateHash.hash) {
        throw new Error('imported checkpoint hash did not match agreed hash');
      }
      options.onCommit(imported);
      return {
        ok: true,
        direction: options.direction,
        agreedNextFrame: options.agreedNextFrame,
        imported,
      };
    } catch (err) {
      disposeCheckpointCore(imported.core);
      throw err;
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    options.onRollback(reason);
    return {
      ok: false,
      direction: options.direction,
      agreedNextFrame: options.agreedNextFrame,
      reason,
    };
  }
}
