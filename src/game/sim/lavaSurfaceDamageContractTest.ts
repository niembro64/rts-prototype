import { UNIT_HP_MULTIPLIER } from '../../config';
import { getUnitLocomotion } from './blueprints';
import { getAllUnitBlueprints } from './blueprints/units';
import {
  applyLavaSurfaceDamage,
  lavaDamagePerSecondFor,
} from './lavaSurfaceDamage';
import { WATER_LEVEL } from './terrain/terrainConfig';
import type { PlayerId } from './types';
import { WorldState } from './WorldState';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[lava surface damage contract] ${message}`);
}

function assertNear(actual: number, expected: number, message: string): void {
  if (Math.abs(actual - expected) > 1e-6) {
    throw new Error(
      `[lava surface damage contract] ${message}: expected ${expected}, received ${actual}`,
    );
  }
}

export function runLavaSurfaceDamageContractTest(): void {
  for (const blueprint of getAllUnitBlueprints()) {
    const locomotion = getUnitLocomotion(blueprint.unitBlueprintId);
    const multiplier = locomotion.environmentalHazards.lavaDamageMultiplier;
    const isRex = blueprint.unitBlueprintId === 'unitRex';
    assertContract(
      multiplier === (isRex ? 0 : 1),
      `${blueprint.unitBlueprintId} resolves the intended lava-damage multiplier`,
    );
    const maxHp = blueprint.hp * UNIT_HP_MULTIPLIER;
    const lavaDps = lavaDamagePerSecondFor(maxHp, multiplier);
    if (isRex) {
      assertContract(lavaDps === 0, 'the Rex titan is explicitly heat-proof');
      continue;
    }
    assertContract(lavaDps > 0, `${blueprint.unitBlueprintId} is killed by lava`);
    const waterDps = locomotion.environmentalHazards.waterDamagePerSecond;
    if (waterDps > 0) {
      assertContract(
        maxHp / lavaDps < maxHp / waterDps,
        `${blueprint.unitBlueprintId} dies in lava faster than it drowns`,
      );
    }
  }

  const world = new WorldState(91, 512, 512);
  world.liquidSurfaceMode = 'lava';
  const jackal = world.createUnitFromBlueprint(
    128,
    128,
    1 as PlayerId,
    'unitJackal',
    { allocateSubEntityIds: false },
  );
  const rex = world.createUnitFromBlueprint(
    192,
    128,
    1 as PlayerId,
    'unitRex',
    { allocateSubEntityIds: false },
  );
  const elevated = world.createUnitFromBlueprint(
    256,
    128,
    1 as PlayerId,
    'unitJackal',
    { allocateSubEntityIds: false },
  );
  jackal.transform.z = WATER_LEVEL;
  rex.transform.z = WATER_LEVEL;
  elevated.transform.z = WATER_LEVEL + 1;
  world.addEntity(jackal);
  world.addEntity(rex);
  world.addEntity(elevated);

  const dtMs = 250;
  const jackalStartHp = jackal.unit!.hp;
  const rexStartHp = rex.unit!.hp;
  const elevatedStartHp = elevated.unit!.hp;
  applyLavaSurfaceDamage(world, dtMs);
  assertNear(
    jackal.unit!.hp,
    Math.max(
      0,
      jackalStartHp - lavaDamagePerSecondFor(jackal.unit!.maxHp, 1) * dtMs / 1000,
    ),
    'a unit touching lava takes health-scaled damage on the fixed step',
  );
  assertNear(rex.unit!.hp, rexStartHp, 'the heat-proof Rex takes no lava damage');
  assertNear(
    elevated.unit!.hp,
    elevatedStartHp,
    'a body origin above the liquid plane takes no lava damage',
  );

  world.liquidSurfaceMode = 'water';
  const afterLavaHp = jackal.unit!.hp;
  applyLavaSurfaceDamage(world, dtMs);
  assertNear(jackal.unit!.hp, afterLavaHp, 'the lava pass is inert in a water match');
}
