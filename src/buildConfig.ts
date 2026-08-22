import rawConfig from './buildConfig.json';
import { deterministicMath as DMath } from './game/sim/deterministicMath';

function validSlopeAngleDegrees(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value >= 90) {
    throw new Error(
      `buildConfig.maxBuildableSlopeAngleDegrees must be finite and in [0, 90); received ${value}`,
    );
  }
  return value;
}

const maxBuildableSlopeAngleDegrees = validSlopeAngleDegrees(
  rawConfig.maxBuildableSlopeAngleDegrees,
);

function nonNegativeSeconds(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`buildConfig.${label} must be finite and >= 0; received ${value}`);
  }
  return value;
}

function decayFractionPerSecond(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(
      `buildConfig.unfinishedBuildDecay.fractionPerSecond must be finite and in (0, 1]; received ${value}`,
    );
  }
  return value;
}

export const BUILD_CONFIG = {
  maxBuildableSlopeAngleDegrees,
  /** Unfinished shells rot when nobody is paying for them: after the delay
   *  they lose a constant fraction of their OWN full cost per second, and the
   *  frame is removed outright at zero progress. */
  unfinishedBuildDecay: {
    unfundedDelaySeconds: nonNegativeSeconds(
      rawConfig.unfinishedBuildDecay.unfundedDelaySeconds,
      'unfinishedBuildDecay.unfundedDelaySeconds',
    ),
    fractionPerSecond: decayFractionPerSecond(
      rawConfig.unfinishedBuildDecay.fractionPerSecond,
    ),
  },
} as const;


/** Lazily computed through the WASM libm cos kernel: this threshold decides
 *  what counts as buildable ground — gameplay truth that shapes extractor
 *  auto-placement from frame 0, so it may not ride a browser's own
 *  Math.cos. Lazy because module evaluation can run before the sim WASM
 *  initializes; every consumer runs during terrain/buildability baking,
 *  when it has. */
let _minBuildableSurfaceNormalUp: number | null = null;
export function minBuildableSurfaceNormalUp(): number {
  _minBuildableSurfaceNormalUp ??= DMath.cos(
    maxBuildableSlopeAngleDegrees * Math.PI / 180,
  );
  return _minBuildableSurfaceNormalUp;
}
