import { validateTurretMountContracts } from '../src/game/sim/blueprints/index';

type TestMount = {
  mountId: unknown;
  turretBlueprintId: string;
  controlMode: unknown;
  slavedToMountId?: unknown;
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
  { mountId: 'mainGun', turretBlueprintId: 'turretGunLight', controlMode: 'hostPreferred' },
  { mountId: 'hostOnlyGun', turretBlueprintId: 'turretGunLight', controlMode: 'hostOnly' },
  { mountId: 'pointDefense', turretBlueprintId: 'turretGunLight', controlMode: 'autonomous' },
  { mountId: 'special', turretBlueprintId: 'turretDisruptor', controlMode: 'manual' },
  {
    mountId: 'wingGun',
    turretBlueprintId: 'turretGunLight',
    controlMode: 'slaved',
    slavedToMountId: 'mainGun',
  },
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
    { mountId: 'gun', turretBlueprintId: 'turretGunLight', controlMode: 'hostPreferred' },
    { mountId: 'gun', turretBlueprintId: 'turretGunBurst', controlMode: 'hostPreferred' },
  ]),
  /duplicate mountId/,
);

assertThrows(
  'unknown-slaved-mount',
  () => validateTurretMountContracts('unit blueprint', 'unknown-slaved-mount', [
    {
      mountId: 'wingGun',
      turretBlueprintId: 'turretGunLight',
      controlMode: 'slaved',
      slavedToMountId: 'missingGun',
    },
  ]),
  /unknown slavedToMountId/,
);

assertThrows(
  'self-slaved-mount',
  () => validateTurretMountContracts('unit blueprint', 'self-slaved-mount', [
    {
      mountId: 'wingGun',
      turretBlueprintId: 'turretGunLight',
      controlMode: 'slaved',
      slavedToMountId: 'wingGun',
    },
  ]),
  /slaved mounts require a different non-empty slavedToMountId/,
);

assertThrows(
  'cyclic-slaved-mounts',
  () => validateTurretMountContracts('unit blueprint', 'cyclic-slaved-mounts', [
    {
      mountId: 'leftGun',
      turretBlueprintId: 'turretGunLight',
      controlMode: 'slaved',
      slavedToMountId: 'rightGun',
    },
    {
      mountId: 'rightGun',
      turretBlueprintId: 'turretGunLight',
      controlMode: 'slaved',
      slavedToMountId: 'leftGun',
    },
  ]),
  /slaved mount cycle/,
);

console.log('turretMountContractValidation passed');
