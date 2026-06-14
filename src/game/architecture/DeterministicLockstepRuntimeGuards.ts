import { getSimWasm, type SimWasm } from '../sim-wasm/init';
import { SIM_WASM_EXPECTED_VERSION } from './CanonicalMatchInitialization';

type RequiredKernel = readonly [label: string, resolve: (sim: SimWasm) => unknown];

const REQUIRED_LOCKSTEP_WASM_KERNELS: readonly RequiredKernel[] = [
  ['deterministicMath.sin', (sim) => sim.deterministicMath.sin],
  ['deterministicMath.cos', (sim) => sim.deterministicMath.cos],
  ['deterministicMath.atan2', (sim) => sim.deterministicMath.atan2],
  ['deterministicMath.sqrt', (sim) => sim.deterministicMath.sqrt],
  ['deterministicMath.hypot2', (sim) => sim.deterministicMath.hypot2],
  ['deterministicMath.hypot3', (sim) => sim.deterministicMath.hypot3],
  ['deterministicMath.pow', (sim) => sim.deterministicMath.pow],
  ['windSampleState', (sim) => sim.windSampleState],
  ['terrainBuildAdaptiveMesh', (sim) => sim.terrainBuildAdaptiveMesh],
  ['terrainBakeBuildabilityGrid', (sim) => sim.terrainBakeBuildabilityGrid],
  ['poolStepPackedProjectilesBatch', (sim) => sim.poolStepPackedProjectilesBatch],
  ['projectileIntegrateStepBatch', (sim) => sim.projectileIntegrateStepBatch],
  ['damageAreaOverlapBatch', (sim) => sim.damageAreaOverlapBatch],
  ['damageSegmentHitsBatch', (sim) => sim.damageSegmentHitsBatch],
  ['turretRotationStepBatch', (sim) => sim.turretRotationStepBatch],
  ['unitForceStepBatch', (sim) => sim.unitForceStepBatch],
  ['combatTargeting.rebuildObservationMasks', (sim) => sim.combatTargeting.rebuildObservationMasks],
  ['spatial.queryEnemyEntitiesInRadius', (sim) => sim.spatial.queryEnemyEntitiesInRadius],
  ['pathfinder.findPath', (sim) => sim.pathfinder.findPath],
];

export function assertDeterministicLockstepRuntimeReady(): SimWasm {
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error(
      'deterministic-lockstep requires initialized rts-sim-wasm before gameplay truth starts',
    );
  }
  if (sim.version !== SIM_WASM_EXPECTED_VERSION) {
    throw new Error(
      `deterministic-lockstep requires ${SIM_WASM_EXPECTED_VERSION}; loaded ${sim.version}`,
    );
  }
  let missing: string[] | null = null;
  for (const [label, resolve] of REQUIRED_LOCKSTEP_WASM_KERNELS) {
    if (typeof resolve(sim) !== 'function') {
      if (missing === null) missing = [];
      missing.push(label);
    }
  }
  if (missing !== null) {
    throw new Error(
      'deterministic-lockstep missing required deterministic WASM kernels: ' +
        missing.join(', '),
    );
  }
  return sim;
}
