#!/usr/bin/env node
// Headless reproduction harness for "loris shield panel never locks on".
//
// Boots the real sim (ServerBootstrap + WASM), spawns a Loris (p1) and an
// enemy Tick (p2, turretBeamMini — a turret the Loris panel is allowed to
// lock) close enough that the Tick beams the Loris. Reports each step
// whether (a) the Tick is firing at the Loris and (b) the Loris shield
// panel acquires that turret and rotates to bisect.
//
// Run: node scripts/lorisShieldHarness.mjs

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
    const turretInitMod = await server.ssrLoadModule('/src/game/sim/turretInit.ts');
    const stampMod = await server.ssrLoadModule('/src/game/sim/combat/targetingInputStamping.ts');
    const { readCombatTargetingTurretFsmInto } = stampMod;
    const sensorMod = await server.ssrLoadModule('/src/game/sim/sensorCoverage.ts');
    const { getEntityFullVisionRadius, getEntityRadarRadius } = sensorMod;
    const activityMod = await server.ssrLoadModule('/src/game/sim/combat/combatActivitySlab.ts');
    const { readActiveTurretMaskForUnit } = activityMod;

    const wasmBytes = await readFile(
      path.join(repoRoot, 'src/game/sim-wasm/pkg/rts_sim_wasm_bg.wasm'),
    );
    await simWasmMod.initSimWasm(wasmBytes);

    const { ServerBootstrap } = bootstrapMod;
    const { UnitForceSystem } = unitForceMod;
    const { createPhysicsBodyForUnit } = physBodyMod;
    const { aimTurretsToward } = turretInitMod;

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

    console.log('turretShieldPanelsEnabled =', world.turretShieldPanelsEnabled);
    console.log('shieldsObstructSight (initial) =', world.shieldsObstructSight);
    // Match the demo battle preset, which runs with shieldsObstructSight OFF.
    world.shieldsObstructSight = false;
    console.log('shieldsObstructSight (forced) =', world.shieldsObstructSight);

    const cx = world.mapWidth / 2;
    const cy = world.mapHeight / 2;

    for (const e of [...world.getAllEntities()]) world.removeEntity(e.id);

    const spawn = (playerId, blueprintId, x, y, faceX, faceY) => {
      const unit = world.createUnitFromBlueprint(x, y, playerId, blueprintId);
      aimTurretsToward(unit, faceX, faceY);
      world.addEntity(unit);
      createPhysicsBodyForUnit(world, physics, unit);
      return unit;
    };

    // Angled geometry: panel initialised facing +x (toward cx+100,cy),
    // but the threat sits BELOW on -y. A working bisect aim must rotate
    // the panel ~90 deg toward the attacker. Loris and attacker 130 apart.
    const loris = spawn(1, 'unitLoris', cx, cy, cx + 100, cy);
    const tick = spawn(2, 'unitHippo', cx, cy - 130, cx, cy);

    const lorisPanel = loris.combat.turrets[0];
    const tickGun = tick.combat.turrets[0];
    console.log('loris panel turret id =', lorisPanel.id,
      ' blueprint =', lorisPanel.config.turretBlueprintId,
      ' passive =', lorisPanel.config.passive,
      ' visualOnly =', lorisPanel.config.visualOnly,
      ' shotType =', lorisPanel.config.shot ? lorisPanel.config.shot.type : 'none',
      ' angleType =', lorisPanel.config.aimStyle.angleType);
    console.log('tick gun turret id =', tickGun.id,
      ' blueprint =', tickGun.config.turretBlueprintId);
    console.log('loris panel ranges =', JSON.stringify(lorisPanel.ranges));
    console.log('loris panel sustainedDps =', lorisPanel.sustainedDps,
      ' lockOnRelationshipIncludeMask =', lorisPanel.config.lockOnRelationshipIncludeMask,
      ' lockOnEntityFamilyIncludeMask =', lorisPanel.config.lockOnEntityFamilyIncludeMask,
      ' lockOnTurretIncludeMask =', lorisPanel.config.lockOnTurretIncludeMask);
    console.log('tick gun sustainedDps =', tickGun.sustainedDps,
      ' ranges =', JSON.stringify(tickGun.ranges));
    console.log('distance loris<->tick =', Math.hypot(loris.transform.x - tick.transform.x, loris.transform.y - tick.transform.y));
    console.log('fogOfWarEnabled =', world.fogOfWarEnabled);
    console.log('LORIS fullVision =', getEntityFullVisionRadius(loris), ' radar =', getEntityRadarRadius(loris), ' hp =', loris.unit.hp, ' buildable =', loris.buildable);
    console.log('TICK  fullVision =', getEntityFullVisionRadius(tick), ' radar =', getEntityRadarRadius(tick), ' hp =', tick.unit.hp, ' buildable =', tick.buildable);
    console.log('LORIS combat.fireEnabled =', loris.combat.fireEnabled, ' TICK combat.fireEnabled =', tick.combat.fireEnabled);

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

    let prevPanelRot = lorisPanel.rotation;
    let everAcquired = false;
    let everRotated = false;

    for (let t = 0; t < 240; t++) {
      stepOnce();
      const lorisAlive = !!world.getEntity(loris.id);
      const tickAlive = !!world.getEntity(tick.id);
      if (!lorisAlive || !tickAlive) {
        console.log(`tick ${t}: a unit died (lorisAlive=${lorisAlive} tickAlive=${tickAlive})`);
        break;
      }
      if (Math.abs(lorisPanel.rotation - prevPanelRot) > 1e-4) everRotated = true;
      prevPanelRot = lorisPanel.rotation;
      if (lorisPanel.target !== null && lorisPanel.target !== -1) everAcquired = true;

      if (t % 30 === 0) {
        const tickFsm = { stateCode: -9, targetId: -9 };
        const lorisFsm = { stateCode: -9, targetId: -9 };
        const tickOk = readCombatTargetingTurretFsmInto(tick, 0, tickFsm);
        const lorisOk = readCombatTargetingTurretFsmInto(loris, 0, lorisFsm);
        console.log(
          `t=${String(t).padStart(3)} | ` +
          `TICK slab(ok=${tickOk?1:0}): tgt=${tickFsm.targetId} st=${tickFsm.stateCode} | ` +
          `LORIS slab(ok=${lorisOk?1:0}): tgt=${lorisFsm.targetId} st=${lorisFsm.stateCode} | ` +
          `activeMask=${readActiveTurretMaskForUnit(loris)} ` +
          `panel.target=${lorisPanel.target} state=${lorisPanel.state} rot=${lorisPanel.rotation.toFixed(3)} ` +
          `aimYaw=${(lorisPanel.aimTargetYaw??0).toFixed(3)} angVel=${(lorisPanel.angularVelocity??0).toFixed(4)} | ` +
          `lorisHP=${loris.unit.hp.toFixed(0)}`
        );
      }
    }

    console.log('\n--- SUMMARY ---');
    console.log('Tick(enemy) gun ever targeted loris id', loris.id, '?',
      'final target =', tickGun.target);
    console.log('Loris panel EVER acquired a target?', everAcquired, ' final target =', lorisPanel.target);
    console.log('Loris panel EVER rotated?', everRotated);
    console.log('Done.');
  } finally {
    await server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
