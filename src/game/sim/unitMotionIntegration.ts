import { getSimWasm } from '../sim-wasm/init';

export function advanceUnitMotionPredictionBatchMutable(
  count: number,
  motions: Float64Array,
  groundOffsets: Float64Array,
  groundZ: Float64Array,
  groundNormals: Float64Array,
  airDragCoefficients: Float64Array,
  invMass: Float64Array,
  dtSec: number,
  groundDamp: number,
  windX: number,
  windY: number,
  windZ: number,
  restPenetrationEpsilon: number,
  restSpeedSq: number,
): void {
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error(
      'advanceUnitMotionPredictionBatchMutable: sim-wasm not initialised. ' +
        'await initSimWasm() before stepping client unit prediction — WASM ' +
        'is the single owner of unit physics and there is no TypeScript fallback.',
    );
  }
  sim.clientPredictUnitMotionBatch(
    count,
    motions,
    groundOffsets,
    groundZ,
    groundNormals,
    airDragCoefficients,
    invMass,
    dtSec,
    groundDamp,
    windX,
    windY,
    windZ,
    restPenetrationEpsilon,
    restSpeedSq,
  );
}
