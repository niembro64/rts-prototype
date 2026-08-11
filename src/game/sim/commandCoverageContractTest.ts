// Per-blueprint command coverage certification.
//
// The roster/selection-panel contracts assert which commands each blueprint
// EXPOSES. That is only half of "Commands require real systems": a button can
// be exposed and still do nothing, because the sanitizer drops the payload, the
// authorizer refuses it, or the executor no-ops on that host kind. This test
// closes the other half by driving every exposed command for every unit and
// building blueprint through the real path --
//
//   sanitizeCommand -> authorizeGameServerGameplayCommand -> executeCommand
//
// -- and requiring an observable change in authoritative state. Nothing here
// reaches into the executor's internals; the observation is the same field the
// renderer and the snapshot read.
//
// It also asserts the inverse for the capability-gated commands: a host that
// lacks the capability must NOT have the command take effect, so a gate that
// silently stops gating shows up as a failure rather than as a new button.
//
// Scenario shape matters and is easy to get wrong (see the notes on the
// helpers): a bare Simulation kills a commander-less side on tick one, and
// updateUnits skips body-less entities, so both are set up explicitly.

import { UNIT_BLUEPRINT_IDS, STRUCTURE_BLUEPRINT_IDS } from '../../types/blueprintIds';
import type { StructureBlueprintId, UnitBlueprintId } from '../../types/blueprintIds';
import type { Command } from './commands';
import { executeCommand, type CommandContext } from './commandExecution';
import { sanitizeCommand } from '../server/commandSanitizer';
import { authorizeGameServerGameplayCommand } from '../server/ServerCommandAuthorizer';
import { ConstructionSystem } from './construction';
import { WorldState } from './WorldState';
import { PhysicsEngine3D } from '../server/PhysicsEngine3D';
import { createPhysicsBodyForUnit } from '../server/unitPhysicsBody';
import { applyBuildingBlueprintRuntime } from './buildingEntityRuntime';
import { getBuildingConfig } from './buildConfigs';
import {
  getFactoryAllowedUnitBlueprintIds,
  getStructureFactoryAllowedUnitBlueprintIds,
} from './factoryProductionRoster';
import { getUnitBuilderAllowedBuildBlueprintIds } from './hostCapabilities';
import { UNIT_BLUEPRINTS } from './blueprints/units';
import { createTransportComponentForUnitBlueprint } from './transports';
import { buildingBlueprintHasActiveState } from './buildingActiveState';
import { isBallisticArcWeapon } from './combat/combatUtils';
import { BUILD_GRID_CELL_SIZE } from './buildGrid';
import { getBuildingPlacementDiagnosticsForGrid } from './buildPlacementValidation';
import type { Entity, PlayerId } from './types';
import {
  entityHasBarAreaAttackCommand,
  entityHasBarAttackCommand,
  entityHasBarBuilderPriorityCommand,
  entityHasBarCaptureCommand,
  entityHasBarCarrierSpawnCommand,
  entityHasBarFireControlCommand,
  entityHasBarManualLaunchCommand,
  entityHasBarSetTargetCommand,
  entityHasBarMoveStateCommand,
  entityHasBarTrajectoryCommand,
  entityHasCloakCommand,
  entityCanBarAttackGround,
  entityCanBarAttackTarget,
  entityCanIssueResurrectCommand,
} from './unitCommandCapabilities';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[command coverage contract] ${message}`);
  }
}

/** One command the player can reach, its capability gate, and the
 *  authoritative state change that proves it landed. */
type CommandProbe = {
  /** Label used in failure messages; matches the audit's category names. */
  readonly name: string;
  /** True when this host is supposed to expose the command. */
  readonly applies: (scenario: Scenario) => boolean;
  /** Build the command exactly as the input layer would. */
  readonly command: (scenario: Scenario) => Command;
  /** Read the observable that the command must change. */
  readonly observe: (scenario: Scenario) => unknown;
  /** Seed state the command needs something to act on (Stop needs a queue to
   *  clear, Clear Target needs a live lock). Runs after the queue reset. */
  readonly prepare?: (scenario: Scenario) => void;
  /** Set false when command() reads capability-specific data (a builder's
   *  roster, a factory's roster) and therefore cannot be built for a host
   *  that lacks the capability. Everything else is also run against hosts
   *  that should NOT accept it, and must leave their state untouched. */
  readonly absenceCheckable?: boolean;
  /** Some commands only settle once the sim steps (host lock-on stamping). */
  readonly stepSim?: boolean;
};

type Scenario = {
  world: WorldState;
  construction: ConstructionSystem;
  ctx: CommandContext;
  /** The blueprint under test, owned by player 1. */
  subject: Entity;
  /** Live ground enemy owned by player 2, in range of the subject. */
  enemy: Entity;
  /** Live AIR enemy owned by player 2. BAR fighters (armfig/unitEagle) set
   *  onlytargetcategory=VTOL, so an air-only host must be probed against an
   *  air target or the authorizer correctly refuses the order. */
  enemyAir: Entity;
  /** Damaged friendly unit owned by player 1, for repair/guard/load. */
  ally: Entity;
  /** Player-2 wreck for reclaim/resurrect. */
  wreck: Entity;
  /** Player-1 metal extractor, for the ON/OFF and mex-upgrade probes. */
  extractor: Entity;
  blueprintId: string;
  kind: 'unit' | 'building';
  /** A grid cell the construction system will actually accept for this
   *  builder's first roster entry. Hardcoding one is order-dependent: metal
   *  deposits and occupied cells differ once earlier contract tests have run
   *  against the shared world/terrain modules. */
  buildCell: { gridX: number; gridY: number; blueprintId: StructureBlueprintId } | null;
};

/** A bare Simulation resolves the commander win condition on its first tick
 *  and zeroes every entity belonging to a commander-less side, so every
 *  scenario keeps a living commander per player. Placed far from the subject
 *  so it never becomes an incidental command target. */
function keepMatchLive(world: WorldState, physics: PhysicsEngine3D, playerIds: readonly PlayerId[]): void {
  for (let i = 0; i < playerIds.length; i++) {
    const commander = world.createUnitFromBlueprint(
      900 - (i * 40),
      900,
      playerIds[i],
      'unitCommander',
      { allocateSubEntityIds: false },
    );
    world.addEntity(commander);
    createPhysicsBodyForUnit(world, physics, commander);
  }
}

function createWreck(world: WorldState, x: number, y: number): Entity {
  const wreck = world.createBuilding(x, y, 24, 24, 12, 1 as PlayerId);
  wreck.wreck = {
    source: { kind: 'unit', unitBlueprintId: 'unitJackal' },
    originalOwnerId: 2 as PlayerId,
    resurrectProgressMs: 0,
    resurrectRequiredMs: 1000,
  } as NonNullable<Entity['wreck']>;
  world.addEntity(wreck);
  return wreck;
}

function createFactoryComponent(entity: Entity, rallyX: number, rallyY: number): void {
  entity.factory = {
    selectedUnitBlueprintId: null,
    lowPriority: true,
    carrierSpawnEnabled: true,
    moveState: 'holdPosition',
    airIdleState: 'land',
    repeatProduction: false,
    paused: false,
    productionQueue: [],
    productionQuotas: {},
    productionQuotaCounts: {},
    resumeRepeatUnitBlueprintId: null,
    currentShellId: null,
    currentBuildProgress: 0,
    defaultWaypoints: null,
    rallyX,
    rallyY,
    rallyZ: null,
    rallyType: 'move',
    guardTargetId: entity.id,
    isProducing: false,
    energyRateFraction: 0,
    metalRateFraction: 0,
  } as Entity['factory'];
}

/** Ask the construction system's own placement diagnostic for a cell it will
 *  accept, using the same arguments startBuilding() passes. Scans outward from
 *  a clear corner of the map so nothing in the scenario occupies it. */
function findPlaceableBuildCell(
  world: WorldState,
  construction: ConstructionSystem,
  blueprintId: string,
  kind: 'unit' | 'building',
): Scenario['buildCell'] {
  if (kind !== 'unit') return null;
  const roster = getUnitBuilderAllowedBuildBlueprintIds(UNIT_BLUEPRINTS[blueprintId as UnitBlueprintId]);
  if (roster.length === 0) return null;
  const grid = construction.getGrid();
  for (const candidate of roster) {
    for (let gridY = 24; gridY < 48; gridY += 4) {
      for (let gridX = 24; gridX < 48; gridX += 4) {
        const diagnostics = getBuildingPlacementDiagnosticsForGrid(
          candidate,
          gridX,
          gridY,
          world.mapWidth,
          world.mapHeight,
          world.metalDeposits,
          (gx, gy) => grid.getCell(gx, gy)?.occupied === true,
          null,
          0,
          { includeMetalDiagnostics: false, ignoreTerrain: false },
        );
        if (diagnostics.canPlace) return { gridX, gridY, blueprintId: candidate };
      }
    }
  }
  return null;
}

function buildScenario(blueprintId: string, kind: 'unit' | 'building'): Scenario {
  const world = new WorldState(7331, 1024, 1024);
  const construction = new ConstructionSystem(world.mapWidth, world.mapHeight);
  const physics = new PhysicsEngine3D(world.mapWidth, world.mapHeight);
  physics.setGroundLookup(
    (x, y) => world.getGroundZ(x, y),
    (x, y) => world.getCachedSurfaceNormal(x, y),
  );
  keepMatchLive(world, physics, [1 as PlayerId, 2 as PlayerId]);

  let subject: Entity;
  if (kind === 'unit') {
    subject = world.createUnitFromBlueprint(200, 200, 1 as PlayerId, blueprintId as UnitBlueprintId, {
      allocateSubEntityIds: false,
    });
    world.addEntity(subject);
    createPhysicsBodyForUnit(world, physics, subject);
    if (getStructureFactoryAllowedUnitBlueprintIds('towerFabricator').length > 0 && subject.factory !== null) {
      // Mobile factories (queens) arrive with their own factory component.
    }
  } else {
    const config = getBuildingConfig(blueprintId as StructureBlueprintId);
    subject = world.createBuilding(
      200,
      200,
      config.gridWidth * BUILD_GRID_CELL_SIZE,
      config.gridHeight * BUILD_GRID_CELL_SIZE,
      config.gridDepth * BUILD_GRID_CELL_SIZE,
      1 as PlayerId,
      0,
    );
    applyBuildingBlueprintRuntime(subject, blueprintId as StructureBlueprintId);
    if (getStructureFactoryAllowedUnitBlueprintIds(blueprintId as StructureBlueprintId).length > 0) {
      createFactoryComponent(subject, 240, 240);
    }
    world.addEntity(subject);
  }

  const enemy = world.createUnitFromBlueprint(260, 200, 2 as PlayerId, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  world.addEntity(enemy);
  createPhysicsBodyForUnit(world, physics, enemy);

  const enemyAir = world.createUnitFromBlueprint(260, 240, 2 as PlayerId, 'unitBee', {
    allocateSubEntityIds: false,
  });
  world.addEntity(enemyAir);
  createPhysicsBodyForUnit(world, physics, enemyAir);

  const ally = world.createUnitFromBlueprint(220, 240, 1 as PlayerId, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  world.addEntity(ally);
  createPhysicsBodyForUnit(world, physics, ally);
  if (ally.unit !== null) ally.unit.hp = Math.floor(ally.unit.maxHp / 2);

  const wreck = createWreck(world, 180, 260);

  const extractorConfig = getBuildingConfig('buildingExtractor');
  const extractor = world.createBuilding(
    300,
    300,
    extractorConfig.gridWidth * BUILD_GRID_CELL_SIZE,
    extractorConfig.gridHeight * BUILD_GRID_CELL_SIZE,
    extractorConfig.gridDepth * BUILD_GRID_CELL_SIZE,
    1 as PlayerId,
    0,
  );
  applyBuildingBlueprintRuntime(extractor, 'buildingExtractor');
  world.addEntity(extractor);
  if (extractor.building?.activeState != null) extractor.building.activeState.open = true;

  return {
    world,
    construction,
    buildCell: findPlaceableBuildCell(world, construction, blueprintId, kind),
    ctx: {
      world,
      constructionSystem: construction,
      pendingProjectileSpawns: [],
      pendingSimEvents: [],
      onSimEvent: null,
    },
    subject,
    enemy,
    enemyAir,
    ally,
    wreck,
    extractor,
    blueprintId,
    kind,
  };
}

const isMobile = (s: Scenario): boolean => s.subject.unit !== null;
const isBuilder = (s: Scenario): boolean => s.subject.builder !== null;
const isFactory = (s: Scenario): boolean => s.subject.factory !== null;
const subjectIds = (s: Scenario): number[] => [s.subject.id];

/** The enemy this host is actually allowed to shoot. Air-only fighters and
 *  ground-only bombers each refuse the other's target category. */
function legalAttackTarget(s: Scenario): Entity {
  return entityCanBarAttackTarget(s.subject, s.enemy) ? s.enemy : s.enemyAir;
}

/** Every reachable command, its gate, and its observable. The gates are the
 *  same functions the selection panel reads, so this list and the panel cannot
 *  disagree about who owns what. */
const PROBES: readonly CommandProbe[] = [
  {
    name: 'move',
    applies: isMobile,
    command: (s) => ({ type: 'move', tick: 0, entityIds: subjectIds(s), targetX: 320, targetY: 320, waypointType: 'move', queue: false }),
    observe: (s) => s.subject.unit?.actions[0]?.type,
  },
  {
    name: 'fight',
    applies: isMobile,
    command: (s) => ({ type: 'move', tick: 0, entityIds: subjectIds(s), targetX: 340, targetY: 320, waypointType: 'fight', queue: false }),
    observe: (s) => s.subject.unit?.actions[0]?.type,
  },
  {
    name: 'patrol',
    applies: isMobile,
    command: (s) => ({ type: 'move', tick: 0, entityIds: subjectIds(s), targetX: 360, targetY: 320, waypointType: 'patrol', queue: false }),
    observe: (s) => s.subject.unit?.actions[0]?.type,
  },
  {
    name: 'guard',
    applies: isMobile,
    command: (s) => ({ type: 'guard', tick: 0, entityIds: subjectIds(s), targetId: s.ally.id, queue: false }),
    observe: (s) => s.subject.unit?.actions[0]?.type,
  },
  {
    name: 'wait',
    applies: isMobile,
    command: (s) => ({ type: 'wait', tick: 0, entityIds: subjectIds(s), queue: false }),
    observe: (s) => s.subject.unit?.actions[0]?.type,
  },
  {
    name: 'stop',
    applies: isMobile,
    prepare: (s) => {
      executeCommand(s.ctx, {
        type: 'move', tick: 0, entityIds: subjectIds(s),
        targetX: 320, targetY: 320, waypointType: 'move', queue: false,
      });
    },
    command: (s) => ({ type: 'stop', tick: 0, entityIds: subjectIds(s) }),
    observe: (s) => s.subject.unit?.actions.length,
  },
  {
    name: 'setRepeatQueue',
    applies: isMobile,
    command: (s) => ({
      type: 'setRepeatQueue', tick: 0, entityIds: subjectIds(s),
      enabled: !(s.subject.unit?.repeatQueue ?? false),
    }),
    observe: (s) => s.subject.unit?.repeatQueue,
  },
  {
    name: 'setUnitMoveState',
    applies: (s) => isMobile(s) && entityHasBarMoveStateCommand(s.subject),
    command: (s) => ({
      type: 'setUnitMoveState',
      tick: 0,
      entityIds: subjectIds(s),
      moveState: s.subject.unit?.moveState === 'roam' ? 'holdPosition' : 'roam',
    }),
    observe: (s) => s.subject.unit?.moveState,
  },
  {
    name: 'attack',
    applies: (s) => entityHasBarAttackCommand(s.subject),
    command: (s) => ({ type: 'attack', tick: 0, entityIds: subjectIds(s), targetId: legalAttackTarget(s).id, queue: false }),
    observe: (s) => (s.subject.unit !== null
      ? s.subject.unit.actions[0]?.type
      : s.subject.combat?.priorityTargetId),
  },
  {
    name: 'attackGround',
    applies: (s) => entityCanBarAttackGround(s.subject),
    command: (s) => ({ type: 'attackGround', tick: 0, entityIds: subjectIds(s), targetX: 280, targetY: 280, queue: false }),
    observe: (s) => (s.subject.unit !== null
      ? s.subject.unit.actions[0]?.type
      : s.subject.combat?.priorityTargetPoint?.x),
  },
  {
    name: 'attackArea',
    applies: (s) => entityHasBarAreaAttackCommand(s.subject),
    command: (s) => ({ type: 'attackArea', tick: 0, entityIds: subjectIds(s), targetX: 260, targetY: 200, radius: 90, queue: false }),
    observe: (s) => s.subject.unit?.actions[0]?.type,
  },
  {
    name: 'setFireEnabled',
    applies: (s) => entityHasBarFireControlCommand(s.subject),
    command: (s) => ({
      type: 'setFireEnabled', tick: 0, entityIds: subjectIds(s),
      fireState: s.subject.combat?.fireState === 'holdFire' ? 'fireAtWill' : 'holdFire',
    }),
    observe: (s) => s.subject.combat?.fireState,
  },
  {
    // BAR presets gate this on the armart analogue; prototype presets expose
    // it for any host with a ballistic arc weapon, and the sim accepts that
    // broader set. Reachability is the union, so the probe uses the union.
    name: 'setTrajectoryMode',
    applies: (s) => entityHasBarTrajectoryCommand(s.subject) ||
      (s.subject.combat?.turrets.some((turret) => isBallisticArcWeapon(turret)) ?? false),
    command: (s) => ({
      type: 'setTrajectoryMode', tick: 0, entityIds: subjectIds(s),
      trajectoryMode: s.subject.combat?.trajectoryMode === 'low' ? 'high' : 'low',
    }),
    observe: (s) => s.subject.combat?.trajectoryMode,
  },
  {
    name: 'setTowerTarget',
    applies: (s) => entityHasBarAttackCommand(s.subject),
    command: (s) => ({ type: 'setTowerTarget', tick: 0, entityIds: subjectIds(s), targetId: legalAttackTarget(s).id }),
    observe: (s) => s.subject.combat?.priorityTargetId,
  },
  {
    name: 'setCloakState',
    applies: (s) => entityHasCloakCommand(s.subject),
    command: (s) => ({
      type: 'setCloakState', tick: 0, entityIds: subjectIds(s),
      enabled: !(s.subject.unit?.wantCloak ?? false),
    }),
    observe: (s) => s.subject.unit?.wantCloak,
  },
  {
    name: 'fireDGun',
    applies: (s) => s.subject.commander != null,
    command: (s) => ({ type: 'fireDGun', tick: 0, commanderId: s.subject.id, targetX: 260, targetY: 200 }),
    observe: (s) => s.subject.combat?.priorityTargetPoint?.x ?? s.ctx.pendingProjectileSpawns.length,
  },
  {
    // BAR presets gate this on canmanualfire (no local analogue has it, so the
    // button is hidden there); prototype presets show it for any host with
    // Set Target, which is also the executor's own gate. Union again.
    name: 'manualLaunch',
    applies: (s) => entityHasBarManualLaunchCommand(s.subject) ||
      entityHasBarSetTargetCommand(s.subject),
    command: (s) => ({ type: 'manualLaunch', tick: 0, entityIds: subjectIds(s), targetX: 260, targetY: 200 }),
    observe: (s) => s.subject.combat?.manualLaunchActive,
  },
  {
    name: 'startBuild',
    applies: (s) => isBuilder(s) && s.buildCell !== null,
    absenceCheckable: false,
    command: (s) => ({
      type: 'startBuild',
      tick: 0,
      builderId: s.subject.id,
      buildingBlueprintId: s.buildCell!.blueprintId,
      gridX: s.buildCell!.gridX,
      gridY: s.buildCell!.gridY,
      queue: false,
    }),
    observe: (s) => s.subject.unit?.actions[0]?.type,
  },
  {
    name: 'repair',
    applies: isBuilder,
    command: (s) => ({ type: 'repair', tick: 0, commanderId: s.subject.id, targetId: s.ally.id, queue: false }),
    observe: (s) => s.subject.unit?.actions[0]?.type,
  },
  {
    name: 'reclaim',
    applies: isBuilder,
    command: (s) => ({ type: 'reclaim', tick: 0, commanderId: s.subject.id, targetId: s.wreck.id, queue: false }),
    observe: (s) => s.subject.unit?.actions[0]?.type,
  },
  {
    name: 'capture',
    applies: (s) => entityHasBarCaptureCommand(s.subject),
    command: (s) => ({ type: 'capture', tick: 0, commanderId: s.subject.id, targetId: s.enemy.id, queue: false }),
    observe: (s) => s.subject.unit?.actions[0]?.type,
  },
  {
    name: 'resurrect',
    applies: (s) => entityCanIssueResurrectCommand(s.subject),
    command: (s) => ({ type: 'resurrect', tick: 0, commanderId: s.subject.id, targetId: s.wreck.id, queue: false }),
    observe: (s) => s.subject.unit?.actions[0]?.type,
  },
  {
    name: 'setBuilderPriority',
    applies: (s) => entityHasBarBuilderPriorityCommand(s.subject),
    absenceCheckable: false,
    command: (s) => ({
      type: 'setBuilderPriority',
      tick: 0,
      entityIds: subjectIds(s),
      lowPriority: !(s.subject.builder?.lowPriority ?? s.subject.factory?.lowPriority ?? false),
    }),
    observe: (s) => (s.subject.builder?.lowPriority ?? s.subject.factory?.lowPriority),
  },
  {
    name: 'loadTransport',
    applies: (s) => s.subject.transport != null,
    command: (s) => ({ type: 'loadTransport', tick: 0, transportId: s.subject.id, targetId: s.ally.id, queue: false }),
    observe: (s) => s.subject.unit?.actions[0]?.type,
  },
  {
    name: 'unloadTransport',
    applies: (s) => s.subject.transport != null,
    command: (s) => ({ type: 'unloadTransport', tick: 0, transportIds: subjectIds(s), targetX: 340, targetY: 340, queue: false }),
    observe: (s) => s.subject.unit?.actions[0]?.type,
  },
  {
    name: 'queueUnit',
    applies: isFactory,
    absenceCheckable: false,
    command: (s) => ({
      type: 'queueUnit',
      tick: 0,
      factoryId: s.subject.id,
      // Mobile factories (queens) author their own roster, so read it off the
      // host rather than assuming the Fabricator's.
      unitBlueprintId: getFactoryAllowedUnitBlueprintIds(s.subject)[0],
    }),
    // The first selection lands on selectedUnitBlueprintId; later ones append
    // to productionQueue. Watch both so either shape counts as working.
    observe: (s) => `${s.subject.factory?.selectedUnitBlueprintId ?? ''}|${s.subject.factory?.productionQueue.length ?? -1}`,
  },
  {
    name: 'setFactoryRepeatProduction',
    applies: isFactory,
    absenceCheckable: false,
    command: (s) => ({
      type: 'setFactoryRepeatProduction', tick: 0, factoryId: s.subject.id,
      enabled: !(s.subject.factory?.repeatProduction ?? false),
    }),
    observe: (s) => s.subject.factory?.repeatProduction,
  },
  {
    name: 'setRallyPoint',
    applies: isFactory,
    absenceCheckable: false,
    command: (s) => ({ type: 'setRallyPoint', tick: 0, factoryId: s.subject.id, rallyX: 400, rallyY: 400, waypointType: 'move', queue: false }),
    observe: (s) => s.subject.factory?.rallyX,
  },
  {
    name: 'setCarrierSpawn',
    applies: (s) => entityHasBarCarrierSpawnCommand(s.subject),
    command: (s) => ({
      type: 'setCarrierSpawn',
      tick: 0,
      entityIds: subjectIds(s),
      enabled: !(s.subject.factory?.carrierSpawnEnabled ?? true),
    }),
    observe: (s) => s.subject.factory?.carrierSpawnEnabled,
  },
  {
    name: 'setBuildingActive',
    applies: (s) => s.kind === 'building' && buildingBlueprintHasActiveState(s.subject.buildingBlueprintId),
    prepare: (s) => {
      const state = s.subject.building?.activeState;
      if (state != null) state.open = true;
    },
    command: (s) => ({ type: 'setBuildingActive', tick: 0, entityIds: subjectIds(s), open: false }),
    observe: (s) => s.subject.building?.activeState?.open,
  },
  {
    name: 'selfDestruct',
    applies: () => true,
    absenceCheckable: false,
    command: (s) => ({ type: 'selfDestruct', tick: 0, entityIds: subjectIds(s) }),
    observe: (s) => s.world.armedSelfDestructs.has(s.subject.id),
  },
];

/** Run one probe through the whole authoritative path and report whether the
 *  observable moved. Returns null on success, or the stage that dropped it. */
function runProbe(probe: CommandProbe, scenario: Scenario): string | null {
  // Every probe starts from a clean queue so the observable is unambiguous.
  if (scenario.subject.unit !== null) {
    scenario.subject.unit.actions.length = 0;
  }
  probe.prepare?.(scenario);
  const before = probe.observe(scenario);
  const raw = probe.command(scenario);
  const sanitized = sanitizeCommand(raw, scenario.world);
  if (sanitized === null) return 'sanitizer dropped it';
  const authorized = authorizeGameServerGameplayCommand(scenario.world, sanitized, {
    mode: 'local-offline',
    playerId: 1 as PlayerId,
  });
  if (authorized === null) return 'authorizer refused it';
  executeCommand(scenario.ctx, authorized);
  const after = probe.observe(scenario);
  if (after === before) return `executed but ${JSON.stringify(before)} did not change`;
  return null;
}

export function runCommandCoverageContractTest(): void {
  const transportUnitIds = new Set<string>(
    UNIT_BLUEPRINT_IDS.filter((id) => createTransportComponentForUnitBlueprint(id) !== null),
  );
  let exercised = 0;

  const hosts: { id: string; kind: 'unit' | 'building' }[] = [
    ...UNIT_BLUEPRINT_IDS.map((id) => ({ id: id as string, kind: 'unit' as const })),
    ...STRUCTURE_BLUEPRINT_IDS.map((id) => ({ id: id as string, kind: 'building' as const })),
  ];

  for (const host of hosts) {
    const scenario = buildScenario(host.id, host.kind);
    assertContract(
      scenario.subject.ownership?.playerId === 1,
      `${host.id} scenario subject must be owned by the issuing player`,
    );
    // Transports are authored per blueprint; the scenario must agree with the
    // roster so the load/unload probe is not silently skipped for a transport.
    assertContract(
      host.kind !== 'unit' || (scenario.subject.transport != null) === transportUnitIds.has(host.id),
      `${host.id} transport component must match the authored transport roster`,
    );

    let applicable = 0;
    for (const probe of PROBES) {
      if (probe.applies(scenario)) {
        applicable++;
        exercised++;
        const failure = runProbe(probe, scenario);
        assertContract(
          failure === null,
          `${host.kind} ${host.id}: exposed command "${probe.name}" is not working -- ${failure}`,
        );
        continue;
      }
      // Absence direction: a host without the capability must not have the
      // command take effect. A gate that stops gating shows up here rather
      // than as a silently-new button.
      if (probe.absenceCheckable === false) continue;
      exercised++;
      const leaked = runProbe(probe, scenario);
      assertContract(
        leaked !== null,
        `${host.kind} ${host.id}: command "${probe.name}" took effect on a host that does not expose it`,
      );
    }
    assertContract(
      applicable > 0,
      `${host.kind} ${host.id} must expose at least one working command`,
    );
    // A builder with no placeable cell would silently skip its build probe,
    // which is the exact failure mode this test exists to catch.
    assertContract(
      scenario.subject.builder === null || scenario.buildCell !== null,
      `${host.id} is a builder but no cell in the scan window accepts any of its roster`,
    );
  }

  // 1030 pairs at the time of writing (39 hosts x presence + absence probes).
  // The floor catches a roster or probe list that quietly shrinks; it is not a
  // target, so raise it when the roster grows.
  assertContract(
    exercised > 900,
    `command coverage must exercise the whole roster; only ${exercised} host/command pairs ran`,
  );
}
