import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotAction,
  NetworkServerSnapshotCombatStats,
  NetworkServerSnapshotEconomy,
  NetworkServerSnapshotEntity,
  NetworkServerSnapshotGridCell,
  NetworkServerSnapshotProjectileDespawn,
  NetworkServerSnapshotProjectileSpawn,
  NetworkServerSnapshotSimEvent,
  NetworkServerSnapshotSprayTarget,
  NetworkServerSnapshotTurret,
  NetworkServerSnapshotUnitTypeStats,
  NetworkServerSnapshotVelocityUpdate,
} from './NetworkTypes';

function cloneStats(s: NetworkServerSnapshotUnitTypeStats): NetworkServerSnapshotUnitTypeStats {
  return {
    damage: {
      dealt: { enemy: s.damage.dealt.enemy, friendly: s.damage.dealt.friendly },
      received: s.damage.received,
    },
    kills: { enemy: s.kills.enemy, friendly: s.kills.friendly },
    units: {
      produced: s.units.produced,
      lost: s.units.lost,
      resourceCost: s.units.resourceCost,
    },
  };
}

export function cloneNetworkCombatStats(stats: NetworkServerSnapshotCombatStats): NetworkServerSnapshotCombatStats {
  const players: NetworkServerSnapshotCombatStats['players'] = {};
  for (const playerId in stats.players) {
    const src = stats.players[playerId];
    const dst: Record<string, NetworkServerSnapshotUnitTypeStats> = {};
    for (const unitType in src) dst[unitType] = cloneStats(src[unitType]);
    players[Number(playerId)] = dst;
  }
  const global: NetworkServerSnapshotCombatStats['global'] = {};
  for (const unitType in stats.global) global[unitType] = cloneStats(stats.global[unitType]);
  return { players, global };
}

function cloneEconomyEntry(e: NetworkServerSnapshotEconomy): NetworkServerSnapshotEconomy {
  return {
    stockpile: { curr: e.stockpile.curr, max: e.stockpile.max },
    income: { base: e.income.base, production: e.income.production },
    expenditure: e.expenditure,
    mana: {
      stockpile: { curr: e.mana.stockpile.curr, max: e.mana.stockpile.max },
      income: { base: e.mana.income.base, territory: e.mana.income.territory },
      expenditure: e.mana.expenditure,
    },
    metal: {
      stockpile: { curr: e.metal.stockpile.curr, max: e.metal.stockpile.max },
      income: { base: e.metal.income.base, extraction: e.metal.income.extraction },
      expenditure: e.metal.expenditure,
    },
  };
}

function cloneAction(a: NetworkServerSnapshotAction): NetworkServerSnapshotAction {
  return {
    type: a.type,
    pos: a.pos ? { x: a.pos.x, y: a.pos.y } : undefined,
    posZ: a.posZ,
    pathExp: a.pathExp,
    targetId: a.targetId,
    buildingType: a.buildingType,
    grid: a.grid ? { x: a.grid.x, y: a.grid.y } : undefined,
    buildingId: a.buildingId,
  };
}

function cloneTurret(t: NetworkServerSnapshotTurret): NetworkServerSnapshotTurret {
  return {
    turret: {
      id: t.turret.id,
      ranges: {
        tracking: {
          acquire: t.turret.ranges.tracking.acquire,
          release: t.turret.ranges.tracking.release,
        },
        engage: {
          acquire: t.turret.ranges.engage.acquire,
          release: t.turret.ranges.engage.release,
        },
      },
      angular: {
        rot: t.turret.angular.rot,
        vel: t.turret.angular.vel,
        acc: t.turret.angular.acc,
        drag: t.turret.angular.drag,
        pitch: t.turret.angular.pitch,
      },
      pos: { offset: { x: t.turret.pos.offset.x, y: t.turret.pos.offset.y } },
    },
    targetId: t.targetId,
    state: t.state,
    currentForceFieldRange: t.currentForceFieldRange,
  };
}

function cloneEntity(e: NetworkServerSnapshotEntity): NetworkServerSnapshotEntity {
  return {
    id: e.id,
    type: e.type,
    pos: { x: e.pos.x, y: e.pos.y, z: e.pos.z },
    rotation: e.rotation,
    posEnd: e.posEnd ? { x: e.posEnd.x, y: e.posEnd.y, z: e.posEnd.z } : undefined,
    playerId: e.playerId,
    changedFields: e.changedFields,
    unit: e.unit ? {
      unitType: e.unit.unitType,
      hp: { curr: e.unit.hp.curr, max: e.unit.hp.max },
      collider: e.unit.collider ? {
        scale: e.unit.collider.scale,
        shot: e.unit.collider.shot,
        push: e.unit.collider.push,
      } : undefined,
      moveSpeed: e.unit.moveSpeed,
      mass: e.unit.mass,
      velocity: { x: e.unit.velocity.x, y: e.unit.velocity.y, z: e.unit.velocity.z },
      turretRotation: e.unit.turretRotation,
      isCommander: e.unit.isCommander,
      buildTargetId: e.unit.buildTargetId,
      actions: e.unit.actions?.map(cloneAction),
      turrets: e.unit.turrets?.map(cloneTurret),
    } : undefined,
    building: e.building ? {
      type: e.building.type,
      dim: e.building.dim ? { x: e.building.dim.x, y: e.building.dim.y } : undefined,
      hp: { curr: e.building.hp.curr, max: e.building.hp.max },
      build: { progress: e.building.build.progress, complete: e.building.build.complete },
      solar: e.building.solar ? { open: e.building.solar.open } : undefined,
      factory: e.building.factory ? {
        queue: e.building.factory.queue.slice(),
        progress: e.building.factory.progress,
        producing: e.building.factory.producing,
        waypoints: e.building.factory.waypoints.map((w) => ({
          pos: { x: w.pos.x, y: w.pos.y },
          posZ: w.posZ,
          type: w.type,
        })),
      } : undefined,
    } : undefined,
    shot: e.shot ? {
      type: e.shot.type,
      source: e.shot.source,
      turretId: e.shot.turretId,
      turretIndex: e.shot.turretIndex,
      velocity: e.shot.velocity ? { x: e.shot.velocity.x, y: e.shot.velocity.y, z: e.shot.velocity.z } : undefined,
    } : undefined,
  };
}

function cloneSpray(s: NetworkServerSnapshotSprayTarget): NetworkServerSnapshotSprayTarget {
  return {
    source: {
      id: s.source.id,
      pos: { x: s.source.pos.x, y: s.source.pos.y },
      z: s.source.z,
      playerId: s.source.playerId,
    },
    target: {
      id: s.target.id,
      pos: { x: s.target.pos.x, y: s.target.pos.y },
      z: s.target.z,
      dim: s.target.dim ? { x: s.target.dim.x, y: s.target.dim.y } : undefined,
      radius: s.target.radius,
    },
    type: s.type,
    intensity: s.intensity,
  };
}

function cloneSimEvent(e: NetworkServerSnapshotSimEvent): NetworkServerSnapshotSimEvent {
  return {
    type: e.type,
    turretId: e.turretId,
    pos: { x: e.pos.x, y: e.pos.y, z: e.pos.z },
    entityId: e.entityId,
    deathContext: e.deathContext ? { ...e.deathContext } : undefined,
    impactContext: e.impactContext ? { ...e.impactContext } : undefined,
  };
}

function cloneSpawn(s: NetworkServerSnapshotProjectileSpawn): NetworkServerSnapshotProjectileSpawn {
  return {
    id: s.id,
    pos: { x: s.pos.x, y: s.pos.y, z: s.pos.z },
    rotation: s.rotation,
    velocity: { x: s.velocity.x, y: s.velocity.y, z: s.velocity.z },
    projectileType: s.projectileType,
    maxLifespan: s.maxLifespan,
    turretId: s.turretId,
    playerId: s.playerId,
    sourceEntityId: s.sourceEntityId,
    turretIndex: s.turretIndex,
    barrelIndex: s.barrelIndex,
    isDGun: s.isDGun,
    fromParentDetonation: s.fromParentDetonation,
    beam: s.beam ? {
      start: { x: s.beam.start.x, y: s.beam.start.y, z: s.beam.start.z },
      end: { x: s.beam.end.x, y: s.beam.end.y, z: s.beam.end.z },
    } : undefined,
    targetEntityId: s.targetEntityId,
    homingTurnRate: s.homingTurnRate,
  };
}

function cloneVelocityUpdate(v: NetworkServerSnapshotVelocityUpdate): NetworkServerSnapshotVelocityUpdate {
  return {
    id: v.id,
    pos: { x: v.pos.x, y: v.pos.y, z: v.pos.z },
    velocity: { x: v.velocity.x, y: v.velocity.y, z: v.velocity.z },
  };
}

function cloneCell(c: NetworkServerSnapshotGridCell): NetworkServerSnapshotGridCell {
  return {
    cell: { x: c.cell.x, y: c.cell.y, z: c.cell.z },
    players: c.players.slice(),
  };
}

export function cloneNetworkSnapshot(state: NetworkServerSnapshot): NetworkServerSnapshot {
  const economy = {} as NetworkServerSnapshot['economy'];
  for (const key in state.economy) {
    const playerId = Number(key) as keyof NetworkServerSnapshot['economy'];
    economy[playerId] = cloneEconomyEntry(state.economy[playerId]);
  }

  return {
    tick: state.tick,
    entities: state.entities.map(cloneEntity),
    economy,
    sprayTargets: state.sprayTargets?.map(cloneSpray),
    audioEvents: state.audioEvents?.map(cloneSimEvent),
    projectiles: state.projectiles ? {
      spawns: state.projectiles.spawns?.map(cloneSpawn),
      despawns: state.projectiles.despawns?.map((d: NetworkServerSnapshotProjectileDespawn) => ({ id: d.id })),
      velocityUpdates: state.projectiles.velocityUpdates?.map(cloneVelocityUpdate),
    } : undefined,
    gameState: state.gameState ? { phase: state.gameState.phase, winnerId: state.gameState.winnerId } : undefined,
    combatStats: state.combatStats ? cloneNetworkCombatStats(state.combatStats) : undefined,
    serverMeta: state.serverMeta ? {
      ticks: { ...state.serverMeta.ticks },
      snaps: { ...state.serverMeta.snaps },
      server: { ...state.serverMeta.server },
      grid: state.serverMeta.grid,
      units: state.serverMeta.units ? {
        allowed: state.serverMeta.units.allowed?.slice(),
        max: state.serverMeta.units.max,
        count: state.serverMeta.units.count,
      } : {},
      projVelInherit: state.serverMeta.projVelInherit,
      firingForce: state.serverMeta.firingForce,
      hitForce: state.serverMeta.hitForce,
      ffAccel: { ...state.serverMeta.ffAccel },
      cpu: state.serverMeta.cpu ? { ...state.serverMeta.cpu } : undefined,
      simLod: state.serverMeta.simLod ? {
        picked: state.serverMeta.simLod.picked,
        effective: state.serverMeta.simLod.effective,
        signals: state.serverMeta.simLod.signals ? { ...state.serverMeta.simLod.signals } : undefined,
      } : undefined,
      wind: state.serverMeta.wind ? { ...state.serverMeta.wind } : undefined,
    } : undefined,
    grid: state.grid ? {
      cells: state.grid.cells.map(cloneCell),
      searchCells: state.grid.searchCells.map(cloneCell),
      cellSize: state.grid.cellSize,
    } : undefined,
    capture: state.capture ? {
      tiles: state.capture.tiles.map((tile) => ({
        cx: tile.cx,
        cy: tile.cy,
        heights: { ...tile.heights },
      })),
      cellSize: state.capture.cellSize,
    } : undefined,
    isDelta: state.isDelta,
    removedEntityIds: state.removedEntityIds?.slice(),
  };
}
