import { validateTurretMountContracts } from '../src/game/sim/blueprints/index';

type TestMount = {
  mountId: unknown;
  turretBlueprintId: string;
  controlMode: unknown;
};

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
    validateTurretMountContracts('unit blueprint', name, mounts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${name}: expected validation to pass, got "${message}"`);
  }
}

assertDoesNotThrow('mixed-control-modes', [
  { mountId: 'mainGun', turretBlueprintId: 'turretGunLight', controlMode: 'host' },
  { mountId: 'pointDefense', turretBlueprintId: 'turretGunLight', controlMode: 'autonomous' },
  { mountId: 'special', turretBlueprintId: 'turretDisruptor', controlMode: 'manual' },
]);

assertThrows(
  'missing-control-mode',
  () => validateTurretMountContracts('unit blueprint', 'missing-control-mode', [
    { mountId: 'mainGun', turretBlueprintId: 'turretGunLight', controlMode: undefined },
  ]),
  /unknown controlMode/,
);

assertThrows(
  'duplicate-mount-id',
  () => validateTurretMountContracts('unit blueprint', 'duplicate-mount-id', [
    { mountId: 'gun', turretBlueprintId: 'turretGunLight', controlMode: 'host' },
    { mountId: 'gun', turretBlueprintId: 'turretGunBurst', controlMode: 'host' },
  ]),
  /duplicate mountId/,
);

console.log('turretMountContractValidation passed');
