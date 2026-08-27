#!/usr/bin/env node
// Headless 4-bot skirmish that counts route outcomes, attributes planless
// units to the rule that blocks them, and prints the scheduler counters.
//
//   node scripts/pathfindingSkirmishProbe.mjs [ticks=1200] [landCells=53]
//
// This is the acceptance metric for pathfinding work: "unreachable" query
// spam, planless units with move orders, and slope-sliver traps are what a
// player experiences as units that will not move.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ticks = Number(process.argv[2] ?? 1200);
const cells = Number(process.argv[3] ?? 53);
const { createServer } = await import(pathToFileURL(path.join(repoRoot, 'node_modules/vite/dist/node/index.js')).href);
const server = await createServer({ root: repoRoot, configFile: path.join(repoRoot, 'vite.config.ts'), appType: 'custom', logLevel: 'error', server: { middlewareMode: true } });
try {
  const simWasm = await server.ssrLoadModule('/src/game/sim-wasm/init.ts');
  await simWasm.initSimWasm(await readFile(path.join(repoRoot, 'src/game/sim-wasm/pkg/rts_sim_wasm_bg.wasm')));
  const harness = await server.ssrLoadModule('/src/game/architecture/DeterministicReplayHarness.ts');
  const { ServerBootstrap } = await server.ssrLoadModule('/src/game/server/ServerBootstrap.ts');
  const { ServerSimulationCore } = await server.ssrLoadModule('/src/game/server/ServerSimulationCore.ts');
  const { LOCKSTEP_FIXED_DT_MS } = await server.ssrLoadModule('/src/game/architecture/LockstepFrameScheduler.ts');
  const ids = [1, 2, 3, 4];
  const config = { playerIds: ids, aiPlayerIds: ids, baseSeatPlayerIds: ids, allyTeamSeats: [1, 1, 1, 1], mapWidthLandCells: cells, mapLengthLandCells: cells };
  harness.resetReusableSimulationStateForDeterministicReplay();
  const boot = ServerBootstrap.bootstrap(config);
  const core = new ServerSimulationCore(boot);
  const sim = core.simulation;
  const wasm = simWasm.getSimWasm();
  const pf = wasm.pathfinder;
  console.log('grid', pf.gridWidth(), 'x', pf.gridHeight(), 'map', core.world.mapWidth, 'x', core.world.mapHeight);
  const statusNames = { 0: 'unreachable', 1: 'complete', 2: 'snapped', 3: 'partial', 4: 'pending' };
  const stratNames = { 0: 'none', 1: 'direct', 2: 'hierarchical', 3: 'local' };
  const status = {}, strat = {};
  let queries = 0, fineNodes = 0, coarseNodes = 0, hpaWorkTotal = 0, corridorTotal = 0;
  const origStatus = pf.lastResultStatus.bind(pf);
  pf.lastResultStatus = () => { const s = origStatus(); queries++; status[statusNames[s] ?? s] = (status[statusNames[s] ?? s] ?? 0) + 1; const st = stratNames[pf.lastSearchStrategy()] ?? '?'; strat[st] = (strat[st] ?? 0) + 1; fineNodes += pf.lastFineExpandedNodesThisSlice(); coarseNodes += pf.lastCoarseExpandedNodes(); hpaWorkTotal += pf.lastHpaWork(); corridorTotal += pf.lastCorridorClusters(); return s; };
  let validateCalls = 0, validateFails = 0;
  const origValidate = pf.validatePath.bind(pf);
  pf.validatePath = (...a) => { validateCalls++; const r = origValidate(...a); if (r !== 1) validateFails++; return r; };
  const sched = sim.pathPlanScheduler;
  let stuckReplans = 0; const stuckByBp = {};
  const origFresh = sched.requestFresh.bind(sched);
  sched.requestFresh = (e, forceLocal) => { if (forceLocal) { stuckReplans++; const bp = e.unit?.unitBlueprintId ?? '?'; stuckByBp[bp] = (stuckByBp[bp] ?? 0) + 1; } return origFresh(e, forceLocal); };
  const t0 = performance.now(); let pathMs = 0;
  for (let f = 0; f < ticks; f++) {
    core.stepFixedTick(LOCKSTEP_FIXED_DT_MS, []);
  }
  const wall = performance.now() - t0;
  const units = core.world.getUnits().filter((e) => e.unit && e.unit.hp > 0);
  const res = {}; let moving = 0, planless = 0;
  for (const e of units) { const a = e.unit.actions[0]; if (!a) continue; if (!['move','attack','guard','patrol','build','repair','reclaim'].includes(a.type)) continue; moving++; const p = e.unit.activePath; if (!p) { planless++; continue; } res[p.resolution] = (res[p.resolution] ?? 0) + 1; }
  console.log(JSON.stringify({ ticks, wallMsPerTick: +(wall / ticks).toFixed(2), units: units.length, unitsWithMoveOrders: moving, planless, activePathResolutions: res, queries, status, strategy: strat, workTotal: fineNodes, hpaWorkTotal, fineOnlyTotal: fineNodes - hpaWorkTotal, corridorClustersTotal: corridorTotal, abstractExpandedTotal: coarseNodes, routeOutcomes: Object.fromEntries(Object.entries(sim.getPathQueryOutcomeStats()).map(([k, v]) => [k, v instanceof Map ? Object.fromEntries(v) : v])), validateCalls, validateFails, stuckReplans, stuckByBlueprint: Object.fromEntries(Object.entries(stuckByBp).sort((a,b)=>b[1]-a[1]).slice(0,8)), scheduler: sim.getPathPlanSchedulerStats() }, null, 1));

  // ---- attribution: why can't planless units start? ----
  const pf2 = await server.ssrLoadModule('/src/game/sim/Pathfinder.ts');
  const W = core.world.mapWidth, H = core.world.mapHeight, sym = core.world.slopePathMode === 'symmetric';
  const reasons = {}; const byBp = {}; const samples = [];
  const clone = (o) => JSON.parse(JSON.stringify(o));
  for (const e of units) {
    const a = e.unit.actions[0]; if (!a || e.unit.activePath) continue;
    if (!['move','attack','guard','patrol','build','repair','reclaim'].includes(a.type)) continue;
    const filter = sim.pathTerrainFilterForUnit(e);
    const sx = e.transform.x, sy = e.transform.y; const r = e.unit.radius.collision;
    const bed = core.world.getTerrainBedZ(sx, sy);
    const test = (f) => pf2.isPathSegmentTraversable(sx, sy, { x: sx, y: sy, z: bed }, W, H, f, r, sym);
    let reason;
    if (test(filter)) reason = 'start-ok(other)';
    else {
      const noSlope = clone(filter); noSlope.minGroundNormalZ = 0; if (!noSlope.navigation) { reasons["no-filter"] = (reasons["no-filter"] ?? 0) + 1; continue; }
      const anyMedium = clone(filter); for (const k of ['waypoint','move']) { anyMedium.navigation[k].allowInWater = true; anyMedium.navigation[k].allowOnGround = true; }
      const both = clone(anyMedium); both.minGroundNormalZ = 0;
      const tiny = clone(filter);
      if (test(noSlope)) reason = 'slope';
      else if (test(anyMedium)) reason = 'medium';
      else if (test(both)) reason = 'slope+medium';
      else if (pf2.isPathSegmentTraversable(sx, sy, { x: sx, y: sy, z: bed }, W, H, both, 0.1, sym)) reason = 'clearance/building';
      else reason = 'edge-or-other';
    }
    reasons[reason] = (reasons[reason] ?? 0) + 1;
    const bp = e.unit.unitBlueprintId; byBp[bp] = byBp[bp] ?? {}; byBp[bp][reason] = (byBp[bp][reason] ?? 0) + 1;
    if (samples.length < 6) samples.push({ id: e.id, bp, reason, pos: [sx.toFixed(0), sy.toFixed(0), e.transform.z.toFixed(0)], bed: bed.toFixed(0), r, minNormal: filter.minGroundNormalZ == null ? null : filter.minGroundNormalZ.toFixed(3), water: filter.navigation.move.allowInWater, ground: filter.navigation.move.allowOnGround, act: a.type });
  }
  console.log('PLANLESS START ATTRIBUTION', JSON.stringify({ reasons, byBlueprint: byBp, samples }, null, 1));
} finally { await server.close(); }
