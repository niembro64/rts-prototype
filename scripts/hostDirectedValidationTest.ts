import { validateHostDirectedMounts } from '../src/game/sim/blueprints/index';

type TestMount = { turretBlueprintId: string; hostDirected: unknown };

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

assertDoesNotThrow('one-host-directed-per-kind', [
  { turretBlueprintId: 'turretGunLight', hostDirected: true },
  { turretBlueprintId: 'turretGunLight', hostDirected: false },
]);

assertDoesNotThrow('zero-host-directed-for-kind', [
  { turretBlueprintId: 'turretGunLight', hostDirected: false },
]);

assertDoesNotThrow('two-host-directed-for-kind', [
  { turretBlueprintId: 'turretGunLight', hostDirected: true },
  { turretBlueprintId: 'turretGunLight', hostDirected: true },
]);

assertThrows(
  'missing-host-directed-flag',
  () => validateHostDirectedMounts('unit blueprint', 'missing-host-directed-flag', [
    { turretBlueprintId: 'turretGunLight', hostDirected: undefined },
  ]),
  /must define a boolean hostDirected/,
);

console.log('hostDirectedValidationTest passed');
