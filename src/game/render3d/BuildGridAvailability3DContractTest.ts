import { resolveBuildGridAvailabilityStatus } from './BuildGridAvailability3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[build grid availability] ${message}`);
}

const OPEN_FACTS = {
  occupied: false,
  groundBuildable: true,
  waterSurfaceClear: true,
  metal: false,
} as const;

export function runBuildGridAvailability3DContractTest(): void {
  assertContract(
    resolveBuildGridAvailabilityStatus('none', OPEN_FACTS) === 'hidden',
    'NONE must hide the whole-map availability overlay',
  );
  assertContract(
    resolveBuildGridAvailabilityStatus('ground', {
      ...OPEN_FACTS,
      groundBuildable: false,
    }) === 'blocked',
    'ground availability must honor authoritative terrain buildability',
  );
  assertContract(
    resolveBuildGridAvailabilityStatus('hover', {
      ...OPEN_FACTS,
      groundBuildable: false,
      waterSurfaceClear: false,
    }) === 'available',
    'hover availability must ignore ground slope and water depth',
  );
  assertContract(
    resolveBuildGridAvailabilityStatus('water-surface', {
      ...OPEN_FACTS,
      waterSurfaceClear: false,
    }) === 'blocked',
    'water-surface availability must honor seabed clearance',
  );
  for (const mode of ['ground', 'hover', 'water-surface'] as const) {
    assertContract(
      resolveBuildGridAvailabilityStatus(mode, {
        ...OPEN_FACTS,
        occupied: true,
      }) === 'blocked',
      `${mode} availability must reject occupied squares`,
    );
  }
  assertContract(
    resolveBuildGridAvailabilityStatus('ground', {
      ...OPEN_FACTS,
      metal: true,
    }) === 'metal',
    'ground availability must retain the metal-cell diagnostic',
  );
}
