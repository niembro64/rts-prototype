import { getSimWasm } from '../sim-wasm/init';

function getDeterministicMathKernels() {
  return getSimWasm()?.deterministicMath;
}

type KernelName = keyof NonNullable<ReturnType<typeof getDeterministicMathKernels>>;
type DeterministicMathKernels = NonNullable<ReturnType<typeof getDeterministicMathKernels>>;

function requireKernel<K extends KernelName>(name: K): DeterministicMathKernels[K] {
  const kernels = getDeterministicMathKernels();
  const kernel = kernels?.[name];
  if (kernel !== undefined) return kernel;
  throw new Error(
    `deterministic-lockstep requires rts-sim-wasm deterministicMath.${name}; ` +
      'await initSimWasm() before stepping gameplay truth',
  );
}

export const deterministicMath = {
  sin(value: number): number {
    return requireKernel('sin')(value);
  },

  cos(value: number): number {
    return requireKernel('cos')(value);
  },

  atan2(y: number, x: number): number {
    return requireKernel('atan2')(y, x);
  },

  sqrt(value: number): number {
    return requireKernel('sqrt')(value);
  },

  hypot(...values: readonly number[]): number {
    if (values.length === 2) {
      return requireKernel('hypot2')(values[0], values[1]);
    }
    if (values.length === 3) {
      return requireKernel('hypot3')(values[0], values[1], values[2]);
    }
    throw new Error(
      `deterministic-lockstep requires a WASM hypot${values.length} kernel; ` +
        'add it before using this arity in gameplay truth',
    );
  },

  pow(base: number, exponent: number): number {
    return requireKernel('pow')(base, exponent);
  },
} as const;
