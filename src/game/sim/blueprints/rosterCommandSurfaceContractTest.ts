import {
  STRUCTURE_BLUEPRINT_IDS,
  UNIT_BLUEPRINT_IDS,
  type StructureBlueprintId,
  type UnitBlueprintId,
} from '../../../types/blueprintIds';
import {
  COMMAND_HOTKEY_IDS,
  COMMAND_HOTKEY_PRESET_IDS,
  commandHotkeyLabel,
  type CommandHotkeyId,
} from '../../input/commandHotkeys';
import { buildStructureMenuLayout } from '../../input/buildMenuLayout';
import { getUnitBuilderAllowedBuildBlueprintIds } from '../builderBuildRoster';
import { createTransportComponentForUnitBlueprint } from '../transports';
import { BUILDING_BLUEPRINTS } from './buildings';
import {
  structureRosterDisplay,
  unitRosterDisplay,
} from './displayRosters';
import { BUILDABLE_UNIT_BLUEPRINT_IDS } from './unitRoster';
import { UNIT_BLUEPRINTS } from './units';

const NON_PLAYER_BUILDABLE_STRUCTURE_BLUEPRINT_IDS = new Set<StructureBlueprintId>([
  'buildingExtractorT2',
]);

const REQUIRED_SPECIAL_COMMAND_IDS = [
  'command.dgun',
  'combat.loadTransport',
  'combat.unloadTransport',
  'combat.manualLaunch',
  'combat.towerTargetSet',
  'combat.towerTargetClear',
] as const satisfies readonly CommandHotkeyId[];

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[roster command surface contract] ${message}`);
  }
}

function assertSameMembers(
  label: string,
  actual: readonly string[],
  expected: readonly string[],
): void {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((id) => !actualSet.has(id));
  const extra = actual.filter((id) => !expectedSet.has(id));
  assertContract(
    missing.length === 0 && extra.length === 0,
    `${label} mismatch; missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`,
  );
}

function currentPlayerBuildableStructureIds(): StructureBlueprintId[] {
  return STRUCTURE_BLUEPRINT_IDS.filter(
    (id) => !NON_PLAYER_BUILDABLE_STRUCTURE_BLUEPRINT_IDS.has(id),
  );
}

export function runRosterCommandSurfaceContractTest(): void {
  const expectedBuildableUnits = UNIT_BLUEPRINT_IDS.filter(
    (id): id is Exclude<UnitBlueprintId, 'unitCommander'> => id !== 'unitCommander',
  );
  assertSameMembers(
    'buildable unit roster',
    BUILDABLE_UNIT_BLUEPRINT_IDS,
    expectedBuildableUnits,
  );
  assertSameMembers(
    'unit display roster',
    unitRosterDisplay.map((unit) => unit.unitBlueprintId),
    BUILDABLE_UNIT_BLUEPRINT_IDS,
  );

  const playerBuildableStructures = currentPlayerBuildableStructureIds();
  assertSameMembers(
    'structure display roster',
    structureRosterDisplay.map((structure) => structure.buildingBlueprintId),
    STRUCTURE_BLUEPRINT_IDS,
  );

  for (const structureBlueprintId of STRUCTURE_BLUEPRINT_IDS) {
    assertContract(
      BUILDING_BLUEPRINTS[structureBlueprintId] !== undefined,
      `stable structure ${structureBlueprintId} must have a static blueprint`,
    );
  }

  for (const unitBlueprintId of UNIT_BLUEPRINT_IDS) {
    const unitBlueprint = UNIT_BLUEPRINTS[unitBlueprintId];
    assertContract(unitBlueprint !== undefined, `stable unit ${unitBlueprintId} must have a blueprint`);
    if (unitBlueprint.builder === null) continue;
    const allowedBuildBlueprintIds = getUnitBuilderAllowedBuildBlueprintIds(unitBlueprint);
    assertSameMembers(
      `${unitBlueprintId} builder roster`,
      allowedBuildBlueprintIds,
      playerBuildableStructures,
    );

    const layout = buildStructureMenuLayout(allowedBuildBlueprintIds);
    assertSameMembers(
      `${unitBlueprintId} build menu`,
      layout.items.map((item) => item.buildingBlueprintId),
      playerBuildableStructures,
    );
    for (const item of layout.items) {
      assertContract(
        commandHotkeyLabel(item.commandId, 'bar-grid').length > 0,
        `${unitBlueprintId}.${item.buildingBlueprintId} must expose a BAR-grid build-slot hotkey label`,
      );
      assertContract(
        commandHotkeyLabel(item.commandId, 'bar-legacy').length > 0,
        `${unitBlueprintId}.${item.buildingBlueprintId} must expose a BAR-legacy build-slot hotkey label`,
      );
    }
  }

  const dgunUnitIds = UNIT_BLUEPRINT_IDS.filter(
    (unitBlueprintId) => UNIT_BLUEPRINTS[unitBlueprintId].dgun !== null,
  );
  assertSameMembers('authored dgun units', dgunUnitIds, ['unitCommander']);

  const transportUnitIds = UNIT_BLUEPRINT_IDS.filter(
    (unitBlueprintId) => createTransportComponentForUnitBlueprint(unitBlueprintId) !== null,
  );
  assertSameMembers('authored transport units', transportUnitIds, ['unitTransport']);

  for (const commandId of REQUIRED_SPECIAL_COMMAND_IDS) {
    assertContract(
      COMMAND_HOTKEY_IDS.includes(commandId),
      `${commandId} must be registered in the shared command-hotkey surface`,
    );
    for (const presetId of COMMAND_HOTKEY_PRESET_IDS) {
      assertContract(
        commandHotkeyLabel(commandId, presetId).length > 0,
        `${presetId}.${commandId} must have a visible hotkey label`,
      );
    }
  }
}
