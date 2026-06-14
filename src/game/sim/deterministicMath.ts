import { ARCHITECTURE_CONFIG } from '@/architectureConfig';
import { getSimWasm } from '../sim-wasm/init';

function getDeterministicMathKernels() {
  return getSimWasm()?.deterministicMath;
}

type KernelName = keyof NonNullable<ReturnType<typeof getDeterministicMathKernels>>;
type DeterministicMathKernels = NonNullable<ReturnType<typeof getDeterministicMathKernels>>;

function requireKernel<K extends KernelName>(name: K): DeterministicMathKernels[K] | undefined {
  const kernels = getDeterministicMathKernels();
  const kernel = kernels?.[name];
  if (kernel !== undefined) return kernel;
  if (ARCHITECTURE_CONFIG.backend === 'deterministic-lockstep') {
    throw new Error(
      `deterministic-lockstep requires rts-sim-wasm deterministicMath.${name}; ` +
        'await initSimWasm() before stepping gameplay truth',
    );
  }
  return undefined;
}

export const deterministicMath = {
  sin(value: number): number {
    return requireKernel('sin')?.(value) ?? Math.sin(value);
  },

  cos(value: number): number {
    return requireKernel('cos')?.(value) ?? Math.cos(value);
  },

  atan2(y: number, x: number): number {
    return requireKernel('atan2')?.(y, x) ?? Math.atan2(y, x);
  },

  sqrt(value: number): number {
    return requireKernel('sqrt')?.(value) ?? Math.sqrt(value);
  },

  hypot(...values: readonly number[]): number {
    if (values.length === 2) {
      return requireKernel('hypot2')?.(values[0], values[1]) ?? Math.hypot(values[0], values[1]);
    }
    if (values.length === 3) {
      return requireKernel('hypot3')?.(values[0], values[1], values[2]) ??
        Math.hypot(values[0], values[1], values[2]);
    }
    if (ARCHITECTURE_CONFIG.backend === 'deterministic-lockstep') {
      throw new Error(
        `deterministic-lockstep requires a WASM hypot${values.length} kernel; ` +
          'add it before using this arity in gameplay truth',
      );
    }
    return Math.hypot(...values);
  },

  pow(base: number, exponent: number): number {
    return requireKernel('pow')?.(base, exponent) ?? Math.pow(base, exponent);
  },
} as const;
