import type { CommandBundle } from '@/types/commands';
import type { GameServerConfig } from '@/types/game';
import {
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_VEL,
  type BattleManifest,
} from '@/types/network';
import {
  assertBattleManifestHash,
  hashBattleManifest,
} from '../network/BattleManifest';
import {
  CommandBundleDuplicateGuard,
  compareCommandBundlesForExecution,
  decodeCommandBundle,
  encodeCommandBundle,
} from '../network/commandBundleCodec';
import { beamIndex } from '../sim/BeamIndex';
import { resetProjectileBuffers } from '../sim/combat/projectileSystem';
import { resetDamageBuffers } from '../sim/damage/DamageSystem';
import { economyManager } from '../sim/economy';
import { SIM_STEP_SEC } from '../sim/fixedStep';
import { spatialGrid } from '../sim/SpatialGrid';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import type { WorldHashSample } from '../sim/worldHash';
import {
  ServerBootstrap,
  type BootstrappedServerWorld,
} from '../server/ServerBootstrap';
import { UnitForceSystem } from '../server/UnitForceSystem';
import { createPhysicsBodyForUnit } from '../server/unitPhysicsBody';

export type HeadlessReplayConfig = {
  backgroundMode?: boolean;
  aiPlayerIds?: PlayerId[];
  spawnDemoInitialState?: boolean;
  initialAllowedTypes?: string[];
  initialMaxTotalUnits?: number;
  converterTax?: number;
};

export type HeadlessReplayFixture = {
  name: string;
  manifest: BattleManifest;
  manifestHash?: string;
  ticks: number;
  config?: HeadlessReplayConfig;
  commandBundles: CommandBundle[];
  expectedHashes: WorldHashSample[];
};

export type HeadlessReplayResult = {
  name: string;
  manifestHash: string;
  ticks: number;
  hashes: WorldHashSample[];
};

class HeadlessReplaySession {
  private readonly boot: BootstrappedServerWorld;
  private readonly unitForceSystem: UnitForceSystem;
  private readonly physicsSyncUnitIdsBuf: EntityId[] = [];

  constructor(config: GameServerConfig) {
    this.boot = ServerBootstrap.bootstrap(config);
    this.unitForceSystem = new UnitForceSystem(
      this.boot.world,
      this.boot.simulation,
      this.boot.physics,
    );
    this.setupSimulationCallbacks();
  }

  enqueueCommandsForTick(bundles: readonly CommandBundle[], tick: number): void {
    for (const bundle of bundles) {
      if (bundle.targetTick !== tick) {
        throw new Error(
          `Replay bundle for tick ${bundle.targetTick} was offered at tick ${tick}`,
        );
      }
      this.boot.commandQueue.enqueueMany(bundle.commands);
    }
  }

  stepFixedTick(): WorldHashSample {
    const tick = this.boot.world.getTick();
    this.boot.simulation.update(tick);
    this.unitForceSystem.applyForces(SIM_STEP_SEC);
    this.boot.physics.step(SIM_STEP_SEC);
    this.syncFromPhysics();
    return this.boot.simulation.recordWorldHash();
  }

  dispose(): void {
    this.detachSimulationCallbacks();
    this.boot.physics.dispose();
    spatialGrid.clear();
    beamIndex.clear();
    economyManager.reset();
    this.boot.simulation.resetSessionState();
    resetProjectileBuffers();
    resetDamageBuffers();
    this.physicsSyncUnitIdsBuf.length = 0;
  }

  private setupSimulationCallbacks(): void {
    const { world, physics, simulation } = this.boot;
    world.onEntityRemoving = (entity: Entity) => {
      const bodySlot = entity.body;
      if (bodySlot === null) return;
      physics.removeBody(bodySlot.physicsBody);
      entity.body = null;
    };
    simulation.onUnitDeath = (deadUnitIds: EntityId[]) => {
      for (const id of deadUnitIds) world.removeEntity(id);
    };
    simulation.onBuildingDeath = (deadBuildingIds: EntityId[]) => {
      const constructionSystem = simulation.getConstructionSystem();
      for (const id of deadBuildingIds) {
        const entity = world.getEntity(id);
        if (entity !== undefined) {
          constructionSystem.onBuildingDestroyed(world, entity);
        }
        world.removeEntity(id);
      }
    };
    simulation.onUnitSpawn = (newUnits: Entity[]) => {
      for (const entity of newUnits) {
        createPhysicsBodyForUnit(world, physics, entity, {
          ignoreOverlappingBuildings: true,
          overlapPadding: undefined,
        });
      }
    };
  }

  private detachSimulationCallbacks(): void {
    this.boot.world.onEntityRemoving = null;
    this.boot.simulation.onUnitDeath = null;
    this.boot.simulation.onUnitSpawn = null;
    this.boot.simulation.onBuildingDeath = null;
    this.boot.simulation.onSimEvent = null;
    this.boot.simulation.onGameOver = null;
  }

  private syncFromPhysics(): void {
    const ids = this.physicsSyncUnitIdsBuf;
    ids.length = 0;
    this.boot.physics.collectLastStepEntityIds(ids);
    for (let i = 0; i < ids.length; i++) {
      const entity = this.boot.world.getEntity(ids[i]);
      if (entity === undefined || entity.unit === null || entity.body === null) continue;
      const body = entity.body.physicsBody;
      entity.transform.x = body.x;
      entity.transform.y = body.y;
      entity.transform.z = body.z;
      entity.unit.velocityX = body.vx;
      entity.unit.velocityY = body.vy;
      entity.unit.velocityZ = body.vz;
      this.boot.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_POS | ENTITY_CHANGED_VEL);
    }
  }
}

export function normalizeReplayBundles(
  bundles: readonly CommandBundle[],
): CommandBundle[] {
  const guard = new CommandBundleDuplicateGuard();
  return bundles
    .map((bundle) => guard.accept(decodeCommandBundle(encodeCommandBundle(bundle))))
    .sort(compareCommandBundlesForExecution);
}

export function runHeadlessReplayFixture(
  fixture: HeadlessReplayFixture,
): HeadlessReplayResult {
  if (!Number.isInteger(fixture.ticks) || fixture.ticks < 0) {
    throw new Error(`Replay fixture "${fixture.name}" has invalid tick count ${fixture.ticks}`);
  }
  const manifestHash = fixture.manifestHash === undefined
    ? hashBattleManifest(fixture.manifest)
    : assertBattleManifestHash(fixture.manifest, fixture.manifestHash);
  const bundlesByTick = groupBundlesByTick(
    normalizeReplayBundles(fixture.commandBundles),
    fixture.ticks,
  );
  const session = new HeadlessReplaySession(toServerConfig(fixture));
  try {
    const hashes: WorldHashSample[] = [];
    for (let tick = 0; tick < fixture.ticks; tick++) {
      session.enqueueCommandsForTick(bundlesByTick.get(tick) ?? [], tick);
      hashes.push(session.stepFixedTick());
    }
    assertExpectedHashes(fixture, hashes);
    return {
      name: fixture.name,
      manifestHash,
      ticks: fixture.ticks,
      hashes,
    };
  } finally {
    session.dispose();
  }
}

function toServerConfig(fixture: HeadlessReplayFixture): GameServerConfig {
  const playerIds = fixture.manifest.playerSlots.map((slot) => slot.playerId);
  const config = fixture.config;
  return {
    playerIds,
    manifest: fixture.manifest,
    backgroundMode: config?.backgroundMode,
    aiPlayerIds: config?.aiPlayerIds,
    spawnDemoInitialState: config?.spawnDemoInitialState,
    initialAllowedTypes: config?.initialAllowedTypes === undefined
      ? undefined
      : new Set(config.initialAllowedTypes),
    initialMaxTotalUnits: config?.initialMaxTotalUnits,
    converterTax: config?.converterTax,
  };
}

function groupBundlesByTick(
  bundles: readonly CommandBundle[],
  ticks: number,
): Map<number, CommandBundle[]> {
  const out = new Map<number, CommandBundle[]>();
  for (const bundle of bundles) {
    if (bundle.targetTick < 0 || bundle.targetTick >= ticks) {
      throw new Error(
        `Replay bundle targetTick ${bundle.targetTick} is outside replay length ${ticks}`,
      );
    }
    const list = out.get(bundle.targetTick);
    if (list === undefined) out.set(bundle.targetTick, [bundle]);
    else list.push(bundle);
  }
  return out;
}

function assertExpectedHashes(
  fixture: HeadlessReplayFixture,
  hashes: readonly WorldHashSample[],
): void {
  const byTick = new Map(hashes.map((sample) => [sample.tick, sample.hash]));
  for (const expected of fixture.expectedHashes) {
    const actual = byTick.get(expected.tick);
    if (actual !== expected.hash) {
      throw new Error(
        `Replay fixture "${fixture.name}" hash mismatch at tick ${expected.tick}: ` +
        `expected ${expected.hash}, got ${actual ?? 'missing'}`,
      );
    }
  }
}
