#!/usr/bin/env node
// Headless reproduction harness for "patrolling eagles don't fight".
//
// Boots the real sim (ServerBootstrap + WASM), spawns exactly two enemy
// Eagles, and drives the SAME tick loop GameServer uses
// (simulation.update -> unitForceSystem.applyForces -> physics.step ->
// syncFromPhysics). Reports whether the two units ever acquire, aim, and
// FIRE at each other.
//
// Scenarios:
//   A) two enemy eagles held near each other (no orders -> loiter)
//   B) two enemy eagles patrolling past each other on the same line
//
// Run: node scripts/eagleCombatHarness.mjs

import { createServer } from 'vite';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

const TICK_MS = 1000 / 60;
const TICK_SEC = TICK_MS / 1000;

async function main() {
  const server = await createServer({
    root: repoRoot,
    configFile: path.join(repoRoot, 'vite.config.ts'),
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true },
  });

  try {
    const simWasmMod = await server.ssrLoadModule('/src/game/sim-wasm/init.ts');
    const bootstrapMod = await server.ssrLoadModule('/src/game/server/ServerBootstrap.ts');
    const unitForceMod = await server.ssrLoadModule('/src/game/server/UnitForceSystem.ts');
    const physBodyMod = await server.ssrLoadModule('/src/game/server/unitPhysicsBody.ts');
    const unitActionsMod = await server.ssrLoadModule('/src/game/sim/unitActions.ts');
    const turretInitMod = await server.ssrLoadModule('/src/game/sim/turretInit.ts');
    const spawnMod = await server.ssrLoadModule('/src/game/sim/spawn.ts');
    const pathfinderMod = await server.ssrLoadModule('/src/game/sim/Pathfinder.ts');

    const wasmBytes = await readFile(
      path.join(repoRoot, 'src/game/sim-wasm/pkg/rts_sim_wasm_bg.wasm'),
    );
    await simWasmMod.initSimWasm(wasmBytes);

    const { ServerBootstrap } = bootstrapMod;
    const { UnitForceSystem } = unitForceMod;
    const { createPhysicsBodyForUnit } = physBodyMod;
    const { setUnitActions } = unitActionsMod;
    const { aimTurretsToward } = turretInitMod;
    const { spawnInitialBases } = spawnMod;
    const { expandMultiLegPathActions, pathTerrainFilterForLocomotion } = pathfinderMod;

    // Flat 15x15 square map, 2 players, no AI/demo spawns.
    const boot = ServerBootstrap.bootstrap({
      playerIds: [1, 2],
      backgroundMode: false,
      terrainMapShape: 'square',
      centerMagnitude: 0,
      dividersMagnitude: 0,
      terrainDTerrain: 0,
      metalDepositStep: 0,
      terrainDetail: 1,
      mapWidthLandCells: 15,
      mapLengthLandCells: 15,
    });
    const { world, simulation, physics } = boot;
    const unitForce = new UnitForceSystem(world, simulation, physics);

    const cx = world.mapWidth / 2;
    const cy = world.mapHeight / 2;

    const clearWorld = () => {
      for (const e of [...world.getAllEntities()]) world.removeEntity(e.id);
    };

    const syncFromPhysics = () => {
      const ids = [];
      physics.collectLastStepEntityIds(ids);
      for (const id of ids) {
        const entity = world.getEntity(id);
        if (!entity || entity.body === null) continue;
        const b = entity.body.physicsBody;
        entity.transform.x = b.x;
        entity.transform.y = b.y;
        entity.transform.z = b.z;
        if (entity.unit !== null) {
          entity.unit.velocityX = b.vx;
          entity.unit.velocityY = b.vy;
          entity.unit.velocityZ = b.vz;
        }
      }
    };

    const stepOnce = () => {
      simulation.update(TICK_MS);
      unitForce.applyForces(TICK_SEC);
      physics.step(TICK_SEC);
      syncFromPhysics();
    };

    const spawnEagle = (playerId, x, y, faceX, faceY, actions) => {
      const unit = world.createUnitFromBlueprint(x, y, playerId, 'unitEagle');
      turretInitMod && aimTurretsToward(unit, faceX, faceY);
      if (unit.unit && actions) {
        setUnitActions(unit.unit, actions);
        const patrolStart = actions.findIndex((a) => a.type === 'patrol');
        if (patrolStart >= 0) unit.unit.patrolStartIndex = patrolStart;
      }
      world.addEntity(unit);
      createPhysicsBodyForUnit(world, physics, unit);
      return unit;
    };

    const summarizeTurret = (unit) => {
      const w = unit.combat?.turrets?.[0];
      if (!w) return {};
      return {
        target: w.target,
        ballisticInRange: w.ballisticAimInRange,
        aimErrYaw: Number((w.aimErrorYaw ?? 0).toFixed(3)),
      };
    };

    const runScenario = (name, setup, ticks = 600) => {
      clearWorld();
      const tracked = setup(); // array of {unit, label}
      const startHp = tracked.map((u) => u.unit.unit.hp);
      const startTotalHp = startHp.reduce((s, h) => s + h, 0);
      const seenProjectiles = new Set();
      let firstFireTick = -1;

      for (let t = 0; t < ticks; t++) {
        stepOnce();
        for (const p of world.getProjectiles()) {
          if (!seenProjectiles.has(p.id)) {
            seenProjectiles.add(p.id);
            if (firstFireTick < 0) firstFireTick = t;
          }
        }
      }

      const endTotalHp = tracked.reduce(
        (s, u) => s + (world.getEntity(u.unit.id) ? u.unit.unit.hp : 0),
        0,
      );

      console.log(`\n=== Scenario ${name} ===`);
      console.log(`units=${tracked.length}  ticks=${ticks}`);
      console.log(`totalRoundsFired=${seenProjectiles.size}  firstFireTick=${firstFireTick}`);
      console.log(`totalHP: ${startTotalHp} -> ${endTotalHp} (combined damage dealt ≈ ${startTotalHp - endTotalHp})`);
    };

    // Scenario B: two enemy eagles patrolling past each other (sanity:
    // patrol-mode combat works in isolation).
    runScenario('B: patrolling past each other', () => {
      const a = spawnEagle(1, cx - 400, cy, cx + 400, cy, [
        { type: 'patrol', x: cx + 400, y: cy },
        { type: 'patrol', x: cx - 400, y: cy },
      ]);
      const b = spawnEagle(2, cx + 400, cy, cx - 400, cy, [
        { type: 'patrol', x: cx - 400, y: cy },
        { type: 'patrol', x: cx + 400, y: cy },
      ]);
      return [{ unit: a }, { unit: b }];
    }, 900);

    // ── Fabricator default-waypoint inspection ──────────────────────
    // Spawn the REAL demo bases (mode 'demo') and read a towerFabricator's
    // server-side defaultWaypoints, then expand them exactly the way
    // FactoryProductionSystem.activateShell does. This answers: do
    // produced units get fight + 2 patrol, or only the fight leg?
    console.log('\n=== Fabricator default-waypoint inspection (demo mode) ===');
    clearWorld();
    const constructionSystem = simulation.getConstructionSystem();
    const grid = constructionSystem.getGrid();
    spawnInitialBases(world, constructionSystem, [1, 2], 'demo');

    const fabricators = world
      .getAllEntities()
      .filter((e) => e.building && e.factory && e.factory.defaultWaypoints);
    console.log(`fabricators with defaultWaypoints: ${fabricators.length}`);
    const fab = fabricators[0];
    if (fab) {
      const wps = fab.factory.defaultWaypoints;
      console.log(`fabricator #${fab.id} defaultWaypoints (${wps.length}):`);
      for (const w of wps) console.log(`   ${w.type} -> (${w.x.toFixed(0)}, ${w.y.toFixed(0)})`);
      console.log(`rallyType (serialized to client) = ${fab.factory.rallyType}`);

      // Replicate activateShell's expansion for a produced eagle.
      const probe = world.createUnitFromBlueprint(
        fab.transform.x, fab.transform.y, fab.ownership.playerId, 'unitEagle',
      );
      const { actions, patrolStartIndex } = expandMultiLegPathActions(
        fab.transform.x, fab.transform.y,
        wps,
        world.mapWidth, world.mapHeight, grid,
        pathTerrainFilterForLocomotion(probe.unit.locomotion),
      );
      const typeCounts = {};
      for (const a of actions) typeCounts[a.type] = (typeCounts[a.type] ?? 0) + 1;
      console.log(`expanded queue: ${actions.length} actions  byType=${JSON.stringify(typeCounts)}  patrolStartIndex=${patrolStartIndex}`);
    }

    console.log('\nDone.');
  } finally {
    await server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
