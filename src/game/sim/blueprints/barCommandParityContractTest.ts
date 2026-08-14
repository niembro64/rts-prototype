// BAR command parity, enumerated from BAR and then verified against us.
//
// The goal this enforces is "at least work as in Beyond All Reason if not
// abstracted from that", so it runs in two phases and asserts a different
// thing in each direction:
//
//   Phase 1 -- ENUMERATE. barAnalogueCapabilities.json is extracted straight
//     from ../Beyond-All-Reason's unitDefs (canmove AND speed -- BAR factories
//     set canmove=true while standing still, so a yardmap plus zero speed is
//     what makes a host a building -- workertime, buildoptions,
//     onoffable, cancloak, cancapture, canresurrect, canmanualfire,
//     transportcapacity, hightrajectory, canareaattack, stockpile, removestop,
//     removewait, weapons, canattackground, AircraftBomb weapons) plus the
//     class each def lives in.
//     barRequiredCommands() turns those flags into the command categories BAR
//     itself would put on that host's order menu. Nothing here is hand-listed
//     per blueprint: change a flag in the data and the expectation moves.
//
//   Phase 2 -- VERIFY. For each of our blueprints with a BAR analogue, read the
//     command surface we actually expose, through the same capability
//     predicates the selection panel reads.
//
// Then:
//   * every BAR-required category MUST be present on our host -- that is the
//     floor, and a missing one is a parity gap;
//   * anything we expose beyond BAR must appear in DOCUMENTED_DIVERGENCES with
//     a reason -- that is the abstraction allowance, and an undocumented extra
//     is panel creep.
//
// Blueprints with no BAR analogue (the prototype-only roster) are listed
// explicitly so the mapping cannot silently lose one.

import barAnalogueCapabilities from './barAnalogueCapabilities.json';
import { STRUCTURE_BLUEPRINT_IDS, UNIT_BLUEPRINT_IDS } from '../../../types/blueprintIds';
import type { StructureBlueprintId, UnitBlueprintId } from '../../../types/blueprintIds';
import { WorldState } from '../WorldState';
import { applyBuildingBlueprintRuntime } from '../buildingEntityRuntime';
import { getBuildingConfig } from '../buildConfigs';
import { getStructureFactoryAllowedUnitBlueprintIds } from '../factoryProductionRoster';
import { getUnitBuilderAllowedBuildBlueprintIds } from '../hostCapabilities';
import { buildingBlueprintHasActiveState } from '../buildingActiveState';
import { createTransportComponentForUnitBlueprint } from '../transports';
import { BUILD_GRID_CELL_SIZE } from '../buildGrid';
import { UNIT_BLUEPRINTS } from './units';
import type { Entity, PlayerId } from '../types';
import {
  entityCanBarAttackGround,
  entityHasBarAreaAttackCommand,
  entityHasBarAttackCommand,
  entityHasBarBuilderPriorityCommand,
  entityHasBarCaptureCommand,
  entityHasBarFactoryGuardCommand,
  entityHasBarFireControlCommand,
  entityHasBarMoveStateCommand,
  entityHasBarSetTargetCommand,
  entityHasBarStopCommand,
  entityHasBarTrajectoryCommand,
  entityCanIssueResurrectCommand,
  entityHasCloakCommand,
} from '../unitCommandCapabilities';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[BAR command parity contract] ${message}`);
  }
}

type BarAnalogue = {
  barUnitDef: string;
  barClass: string;
  canMove: boolean;
  speed: number;
  hasYardMap: boolean;
  workerTime: number;
  buildDistance: number;
  hasBuildOptions: boolean;
  onOffable: boolean | null;
  canCloak: boolean;
  canCapture: boolean;
  canResurrect: boolean;
  canManualFire: boolean;
  transportCapacity: number;
  highTrajectory: boolean;
  canAreaAttack: boolean;
  stockpile: boolean;
  removeStop: boolean;
  removeWait: boolean;
  hasWeapons: boolean;
  canAttackGround: boolean | null;
  hasAircraftBombWeapon: boolean;
};

const ANALOGUES = barAnalogueCapabilities as Record<string, BarAnalogue>;

/** Our roster entries with no BAR analogue. Listed rather than inferred so a
 *  new blueprint cannot quietly join this set by being forgotten. */
const PROTOTYPE_ONLY_BLUEPRINTS: ReadonlySet<string> = new Set([
  'unitMammoth', 'unitDaddy', 'unitWidow', 'unitFormik', 'unitHippo', 'unitLoris',
  'unitSeaTurtle', 'unitOrca', 'unitDuck', 'unitConstructionSubmarine',
  'unitQueenBee', 'unitQueenTick', 'unitHuman', 'unitRex',
  'buildingShieldTargetingTech', 'buildingShieldTech',
]);

/** Categories a host can expose. Same vocabulary as the audit's matrix and the
 *  philosophy's "Selection Menus Are Uniform Per Host Kind". */
type CommandCategory =
  | 'move' | 'fight' | 'patrol' | 'guard' | 'stop' | 'wait' | 'moveState'
  | 'attack' | 'attackGround' | 'areaAttack' | 'fireState' | 'trajectory' | 'setTarget'
  | 'dgun' | 'cloak' | 'capture' | 'resurrect' | 'stockpile'
  | 'buildMenu' | 'repairReclaim' | 'builderPriority'
  | 'productionMenu' | 'factoryGuard'
  | 'transport' | 'onOff' | 'selfDestruct';

/** PHASE 1: what BAR itself would offer on this host, derived from its flags. */
function barRequiredCommands(bar: BarAnalogue): Set<CommandCategory> {
  const required = new Set<CommandCategory>(['selfDestruct']);
  const isBuilder = bar.workerTime > 0 && bar.hasBuildOptions;

  if (bar.canMove) {
    required.add('move');
    required.add('fight');
    required.add('patrol');
    required.add('guard');
    required.add('stop');
    // BAR's unit_bomber_hide_move_state.lua strips CMD.MOVE_STATE from any
    // unitDef carrying an AircraftBomb weapon, so a bomber's order menu has no
    // move state to match.
    if (!bar.hasAircraftBombWeapon) required.add('moveState');
  }
  if (!bar.removeWait) required.add('wait');
  if (!bar.removeStop) required.add('stop');

  if (bar.hasWeapons) {
    required.add('attack');
    required.add('fireState');
    required.add('setTarget');
    if (bar.canAttackGround !== false) required.add('attackGround');
  }
  if (bar.canAreaAttack) required.add('areaAttack');
  if (bar.highTrajectory) required.add('trajectory');
  if (bar.canCloak) required.add('cloak');
  if (bar.canCapture) required.add('capture');
  if (bar.canResurrect) required.add('resurrect');
  if (bar.canManualFire) required.add('dgun');
  if (bar.stockpile) required.add('stockpile');
  if (bar.transportCapacity > 0) required.add('transport');
  if (bar.onOffable === true) required.add('onOff');

  if (isBuilder && bar.canMove) {
    required.add('buildMenu');
    required.add('repairReclaim');
    required.add('builderPriority');
  }
  if (isBuilder && !bar.canMove) {
    required.add('productionMenu');
    required.add('builderPriority');
    required.add('factoryGuard');
  }
  return required;
}

/** PHASE 2: what we actually expose, read through the panel's own predicates. */
function actualCommands(entity: Entity, blueprintId: string, kind: 'unit' | 'building'): Set<CommandCategory> {
  const actual = new Set<CommandCategory>(['selfDestruct']);
  const isUnit = entity.unit !== null;

  if (isUnit) {
    actual.add('move');
    actual.add('fight');
    actual.add('patrol');
    actual.add('guard');
    if (entityHasBarMoveStateCommand(entity)) actual.add('moveState');
  }
  // Wait belongs to anything with a queue, which is every unit plus a factory
  // (the panel's factory section carries its own Wait button).
  if (isUnit || entity.factory !== null) actual.add('wait');
  if (entityHasBarStopCommand(entity)) actual.add('stop');
  if (entityHasBarAttackCommand(entity)) actual.add('attack');
  if (entityCanBarAttackGround(entity)) actual.add('attackGround');
  if (entityHasBarAreaAttackCommand(entity)) actual.add('areaAttack');
  if (entityHasBarFireControlCommand(entity)) actual.add('fireState');
  if (entityHasBarSetTargetCommand(entity)) actual.add('setTarget');
  if (entityHasBarTrajectoryCommand(entity)) actual.add('trajectory');
  if (entityHasCloakCommand(entity)) actual.add('cloak');
  if (entityHasBarCaptureCommand(entity)) actual.add('capture');
  if (entityCanIssueResurrectCommand(entity)) actual.add('resurrect');
  if (entity.commander !== null) actual.add('dgun');
  if (entityHasBarBuilderPriorityCommand(entity)) actual.add('builderPriority');
  if (entityHasBarFactoryGuardCommand(entity)) actual.add('factoryGuard');
  if (kind === 'unit' && createTransportComponentForUnitBlueprint(blueprintId) !== null) {
    actual.add('transport');
  }
  if (entity.builder !== null) {
    actual.add('repairReclaim');
    if (kind === 'unit' &&
      getUnitBuilderAllowedBuildBlueprintIds(UNIT_BLUEPRINTS[blueprintId as UnitBlueprintId]).length > 0) {
      actual.add('buildMenu');
    }
  }
  if (entity.factory !== null) actual.add('productionMenu');
  if (kind === 'building' && buildingBlueprintHasActiveState(entity.buildingBlueprintId)) {
    actual.add('onOff');
  }
  return actual;
}

/** Every place we deliberately differ from the BAR floor, with the reason.
 *  `extra` is what we expose beyond BAR; `missing` is a BAR category we do not
 *  offer. Both need a reason, and section 6 of bar_command_parity_audit.txt
 *  carries the long form. */
const DOCUMENTED_DIVERGENCES: Readonly<Record<string, {
  extra?: readonly CommandCategory[];
  missing?: readonly CommandCategory[];
  reason: string;
}>> = {
  buildingWind: {
    extra: ['onOff'],
    reason: 'armwin has no onoffable, but our wind turbine carries the real active-state fortify tradeoff (production stops, incoming damage x0.1), so the toggle is capability-gated here',
  },
  buildingRadar: {
    extra: ['onOff'],
    reason: 'armrad sets onoffable=false; our radar gates powered contact coverage and the fortify tradeoff on the same state',
  },
  buildingSonar: {
    extra: ['onOff'],
    reason: 'armsonar sets onoffable=false; same active-state mechanic as radar',
  },
  buildingResourceConverter: {
    extra: ['onOff'],
    reason: 'armmakr has no onoffable; our converter gates the energy-to-metal swap on the same active state',
  },
  unitCommander: {
    extra: ['resurrect'],
    reason: 'armcom has no canresurrect, but wreck resurrection is a real authoritative system here and the commander is its host; BAR presets still hide the button',
  },
  towerFabricator: {
    missing: ['stop'],
    reason: 'armap sets neither removestop nor removewait, so BAR shows CMD.STOP alongside its custom Clear Queue; we expose stopFactoryProduction (queue + quotas) and Wait, which covers the same authoritative behaviour under BAR\'s own command name',
  },
};

function createHostEntity(world: WorldState, blueprintId: string, kind: 'unit' | 'building'): Entity {
  if (kind === 'unit') {
    const entity = world.createUnitFromBlueprint(
      200, 200, 1 as PlayerId, blueprintId as UnitBlueprintId, { allocateSubEntityIds: false },
    );
    world.addEntity(entity);
    return entity;
  }
  const config = getBuildingConfig(blueprintId as StructureBlueprintId);
  const entity = world.createBuilding(
    200,
    200,
    config.gridWidth * BUILD_GRID_CELL_SIZE,
    config.gridHeight * BUILD_GRID_CELL_SIZE,
    config.gridDepth * BUILD_GRID_CELL_SIZE,
    1 as PlayerId,
    0,
  );
  applyBuildingBlueprintRuntime(entity, blueprintId as StructureBlueprintId);
  if (getStructureFactoryAllowedUnitBlueprintIds(blueprintId as StructureBlueprintId).length > 0) {
    entity.factory = { productionQueue: [] } as unknown as Entity['factory'];
  }
  world.addEntity(entity);
  return entity;
}

export function runBarCommandParityContractTest(): void {
  const hosts: { id: string; kind: 'unit' | 'building' }[] = [
    ...UNIT_BLUEPRINT_IDS.map((id) => ({ id: id as string, kind: 'unit' as const })),
    ...STRUCTURE_BLUEPRINT_IDS.map((id) => ({ id: id as string, kind: 'building' as const })),
  ];

  // The mapping must account for every blueprint: analogue or explicitly
  // prototype-only, never silently unclassified.
  for (const host of hosts) {
    assertContract(
      ANALOGUES[host.id] !== undefined || PROTOTYPE_ONLY_BLUEPRINTS.has(host.id),
      `${host.id} has neither a BAR analogue in barAnalogueCapabilities.json nor a place in PROTOTYPE_ONLY_BLUEPRINTS`,
    );
  }
  for (const id of Object.keys(ANALOGUES)) {
    assertContract(
      hosts.some((host) => host.id === id),
      `barAnalogueCapabilities.json maps ${id}, which is no longer in the roster`,
    );
  }
  for (const id of PROTOTYPE_ONLY_BLUEPRINTS) {
    assertContract(
      ANALOGUES[id] === undefined,
      `${id} is listed prototype-only but now has a BAR analogue; move it out of the list`,
    );
  }

  let comparedHosts = 0;
  for (const host of hosts) {
    const bar = ANALOGUES[host.id];
    if (bar === undefined) continue;
    comparedHosts++;

    const world = new WorldState(4711, 1024, 1024);
    const entity = createHostEntity(world, host.id, host.kind);
    const required = barRequiredCommands(bar);
    const actual = actualCommands(entity, host.id, host.kind);
    const divergence = DOCUMENTED_DIVERGENCES[host.id];

    const missing = [...required].filter((category) => !actual.has(category));
    const undocumentedMissing = missing.filter(
      (category) => !(divergence?.missing ?? []).includes(category),
    );
    assertContract(
      undocumentedMissing.length === 0,
      `${host.id} (BAR ${bar.barUnitDef}, ${bar.barClass}) is missing BAR command(s) ` +
        `[${undocumentedMissing.join(', ')}] -- BAR is the floor, so either expose them or ` +
        'record the difference in DOCUMENTED_DIVERGENCES with a reason',
    );

    const extra = [...actual].filter((category) => !required.has(category));
    const undocumentedExtra = extra.filter(
      (category) => !(divergence?.extra ?? []).includes(category),
    );
    assertContract(
      undocumentedExtra.length === 0,
      `${host.id} (BAR ${bar.barUnitDef}, ${bar.barClass}) exposes command(s) ` +
        `[${undocumentedExtra.join(', ')}] that its BAR analogue does not -- abstracting above BAR ` +
        'is allowed, but it has to be recorded in DOCUMENTED_DIVERGENCES with a reason',
    );

    // A divergence entry that no longer describes reality is worse than none.
    for (const category of divergence?.extra ?? []) {
      assertContract(
        actual.has(category) && !required.has(category),
        `${host.id} documents an extra "${category}" it no longer exposes above BAR; drop the entry`,
      );
    }
    for (const category of divergence?.missing ?? []) {
      assertContract(
        required.has(category) && !actual.has(category),
        `${host.id} documents a missing "${category}" that is no longer missing; drop the entry`,
      );
    }
  }

  assertContract(
    comparedHosts === Object.keys(ANALOGUES).length,
    `every mapped analogue must be compared; compared ${comparedHosts} of ${Object.keys(ANALOGUES).length}`,
  );
}
