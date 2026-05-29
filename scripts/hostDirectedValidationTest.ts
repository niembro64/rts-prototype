import { validateHostDirectedMounts } from '../src/game/sim/blueprints/index';

type TestMount = { turretId: string; hostDirected: unknown };

function assertThrows(name: string, fn: () => void, pattern: RegExp): void {
  try {
    fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!pattern.test(message)) {
      throw new Error(`${name}: expected ${pattern}, got "${message}"`);
    }
    return;
  }
  throw new Error(`${name}: expected validation to throw`);
}

function assertDoesNotThrow(name: string, mounts: readonly TestMount[]): void {
  try {
    validateHostDirectedMounts('unit blueprint', name, mounts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${name}: expected validation to pass, got "${message}"`);
  }
}

assertDoesNotThrow('one-primary-per-kind', [
  { turretId: 'turretGunLight', hostDirected: true },
  { turretId: 'turretGunLight', hostDirected: false },
]);

assertThrows(
  'zero-primary-for-kind',
  () => validateHostDirectedMounts('unit blueprint', 'zero-primary-for-kind', [
    { turretId: 'turretGunLight', hostDirected: false },
  ]),
  /has 0 host-directed mount\(s\); exactly one is required/,
);

assertThrows(
  'two-primaries-for-kind',
  () => validateHostDirectedMounts('unit blueprint', 'two-primaries-for-kind', [
    { turretId: 'turretGunLight', hostDirected: true },
    { turretId: 'turretGunLight', hostDirected: true },
  ]),
  /has 2 host-directed mount\(s\); exactly one is required/,
);

assertThrows(
  'missing-host-directed-flag',
  () => validateHostDirectedMounts('unit blueprint', 'missing-host-directed-flag', [
    { turretId: 'turretGunLight', hostDirected: undefined },
  ]),
  /must define a boolean hostDirected/,
);

console.log('hostDirectedValidationTest passed');
