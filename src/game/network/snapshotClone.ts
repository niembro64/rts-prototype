import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotAction,
  NetworkServerSnapshotCombatStats,
  NetworkServerSnapshotEconomy,
  NetworkServerSnapshotEntity,
  NetworkServerSnapshotGridCell,
  NetworkServerSnapshotProjectileDespawn,
  NetworkServerSnapshotProjectileSpawn,
  NetworkServerSnapshotBeamUpdate,
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

function cloneBeamUpdate(b: NetworkServerSnapshotBeamUpdate): NetworkServerSnapshotBeamUpdate {
  return {
    id: b.id,
    start: { x: b.start.x, y: b.start.y, z: b.start.z },
    end: { x: b.end.x, y: b.end.y, z: b.end.z },
    startVel: { x: b.startVel.x, y: b.startVel.y, z: b.startVel.z },
    endVel: { x: b.endVel.x, y: b.endVel.y, z: b.endVel.z },
    obstructionT: b.obstructionT,
    reflections: b.reflections?.map((r) => ({
      x: r.x,
      y: r.y,
      z: r.z,
      mirrorEntityId: r.mirrorEntityId,
    })),
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
      beamUpdates: state.projectiles.beamUpdates?.map(cloneBeamUpdate),
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
      ffAccel: { ...state.serverMeta.ffAccel },
      mirrorsEnabled: state.serverMeta.mirrorsEnabled,
      forceFieldsEnabled: state.serverMeta.forceFieldsEnabled,
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

type ReusableEntityUnit = NonNullable<NetworkServerSnapshotEntity['unit']>;
type ReusableEntityBuilding = NonNullable<NetworkServerSnapshotEntity['building']>;
type ReusableEntityShot = NonNullable<NetworkServerSnapshotEntity['shot']>;
type ReusableFactory = NonNullable<ReusableEntityBuilding['factory']>;

function copyActionInto(
  src: NetworkServerSnapshotAction,
  dst: NetworkServerSnapshotAction,
): NetworkServerSnapshotAction {
  dst.type = src.type;
  if (src.pos) {
    if (!dst.pos) dst.pos = { x: 0, y: 0 };
    dst.pos.x = src.pos.x;
    dst.pos.y = src.pos.y;
  } else {
    dst.pos = undefined;
  }
  dst.posZ = src.posZ;
  dst.pathExp = src.pathExp;
  dst.targetId = src.targetId;
  dst.buildingType = src.buildingType;
  if (src.grid) {
    if (!dst.grid) dst.grid = { x: 0, y: 0 };
    dst.grid.x = src.grid.x;
    dst.grid.y = src.grid.y;
  } else {
    dst.grid = undefined;
  }
  dst.buildingId = src.buildingId;
  return dst;
}

function copyTurretInto(
  src: NetworkServerSnapshotTurret,
  dst: NetworkServerSnapshotTurret,
): NetworkServerSnapshotTurret {
  dst.turret.id = src.turret.id;
  dst.turret.ranges.tracking.acquire = src.turret.ranges.tracking.acquire;
  dst.turret.ranges.tracking.release = src.turret.ranges.tracking.release;
  dst.turret.ranges.engage.acquire = src.turret.ranges.engage.acquire;
  dst.turret.ranges.engage.release = src.turret.ranges.engage.release;
  dst.turret.angular.rot = src.turret.angular.rot;
  dst.turret.angular.vel = src.turret.angular.vel;
  dst.turret.angular.acc = src.turret.angular.acc;
  dst.turret.angular.drag = src.turret.angular.drag;
  dst.turret.angular.pitch = src.turret.angular.pitch;
  dst.turret.pos.offset.x = src.turret.pos.offset.x;
  dst.turret.pos.offset.y = src.turret.pos.offset.y;
  dst.targetId = src.targetId;
  dst.state = src.state;
  dst.currentForceFieldRange = src.currentForceFieldRange;
  return dst;
}

function createReusableTurret(): NetworkServerSnapshotTurret {
  return {
    turret: {
      id: '',
      ranges: {
        tracking: { acquire: 0, release: 0 },
        engage: { acquire: 0, release: 0 },
      },
      angular: { rot: 0, vel: 0, acc: 0, drag: 0, pitch: 0 },
      pos: { offset: { x: 0, y: 0 } },
    },
    state: 0,
  };
}

function createReusableUnit(): ReusableEntityUnit {
  return {
    hp: { curr: 0, max: 0 },
    velocity: { x: 0, y: 0, z: 0 },
  };
}

function copyUnitInto(src: ReusableEntityUnit, dst: ReusableEntityUnit): ReusableEntityUnit {
  dst.unitType = src.unitType;
  dst.hp.curr = src.hp.curr;
  dst.hp.max = src.hp.max;
  if (src.collider) {
    if (!dst.collider) dst.collider = { scale: 0, shot: 0, push: 0 };
    dst.collider.scale = src.collider.scale;
    dst.collider.shot = src.collider.shot;
    dst.collider.push = src.collider.push;
  } else {
    dst.collider = undefined;
  }
  dst.moveSpeed = src.moveSpeed;
  dst.mass = src.mass;
  dst.velocity.x = src.velocity.x;
  dst.velocity.y = src.velocity.y;
  dst.velocity.z = src.velocity.z;
  dst.turretRotation = src.turretRotation;
  dst.isCommander = src.isCommander;
  dst.buildTargetId = src.buildTargetId;

  if (src.actions) {
    const actions = dst.actions ?? (dst.actions = []);
    actions.length = src.actions.length;
    for (let i = 0; i < src.actions.length; i++) {
      actions[i] = copyActionInto(src.actions[i], actions[i] ?? {});
    }
  } else {
    dst.actions = undefined;
  }

  if (src.turrets) {
    const turrets = dst.turrets ?? (dst.turrets = []);
    turrets.length = src.turrets.length;
    for (let i = 0; i < src.turrets.length; i++) {
      turrets[i] = copyTurretInto(src.turrets[i], turrets[i] ?? createReusableTurret());
    }
  } else {
    dst.turrets = undefined;
  }

  return dst;
}

function createReusableBuilding(): ReusableEntityBuilding {
  return {
    hp: { curr: 0, max: 0 },
    build: { progress: 0, complete: false },
  };
}

function copyFactoryInto(src: ReusableFactory, dst: ReusableFactory): ReusableFactory {
  dst.queue.length = src.queue.length;
  for (let i = 0; i < src.queue.length; i++) dst.queue[i] = src.queue[i];
  dst.progress = src.progress;
  dst.producing = src.producing;
  dst.waypoints.length = src.waypoints.length;
  for (let i = 0; i < src.waypoints.length; i++) {
    const sw = src.waypoints[i];
    let dw = dst.waypoints[i];
    if (!dw) {
      dw = { pos: { x: 0, y: 0 }, type: '' };
      dst.waypoints[i] = dw;
    }
    dw.pos.x = sw.pos.x;
    dw.pos.y = sw.pos.y;
    dw.posZ = sw.posZ;
    dw.type = sw.type;
  }
  return dst;
}

function copyBuildingInto(
  src: ReusableEntityBuilding,
  dst: ReusableEntityBuilding,
): ReusableEntityBuilding {
  dst.type = src.type;
  if (src.dim) {
    if (!dst.dim) dst.dim = { x: 0, y: 0 };
    dst.dim.x = src.dim.x;
    dst.dim.y = src.dim.y;
  } else {
    dst.dim = undefined;
  }
  dst.hp.curr = src.hp.curr;
  dst.hp.max = src.hp.max;
  dst.build.progress = src.build.progress;
  dst.build.complete = src.build.complete;
  if (src.solar) {
    if (!dst.solar) dst.solar = { open: true };
    dst.solar.open = src.solar.open;
  } else {
    dst.solar = undefined;
  }
  if (src.factory) {
    if (!dst.factory) dst.factory = { queue: [], progress: 0, producing: false, waypoints: [] };
    copyFactoryInto(src.factory, dst.factory);
  } else {
    dst.factory = undefined;
  }
  return dst;
}

function createReusableShot(): ReusableEntityShot {
  return { type: 0, source: 0 };
}

function copyShotInto(src: ReusableEntityShot, dst: ReusableEntityShot): ReusableEntityShot {
  dst.type = src.type;
  dst.source = src.source;
  dst.turretId = src.turretId;
  dst.turretIndex = src.turretIndex;
  if (src.velocity) {
    if (!dst.velocity) dst.velocity = { x: 0, y: 0, z: 0 };
    dst.velocity.x = src.velocity.x;
    dst.velocity.y = src.velocity.y;
    dst.velocity.z = src.velocity.z;
  } else {
    dst.velocity = undefined;
  }
  return dst;
}

function copyEntityInto(
  src: NetworkServerSnapshotEntity,
  dst: NetworkServerSnapshotEntity,
): NetworkServerSnapshotEntity {
  dst.id = src.id;
  dst.type = src.type;
  dst.pos.x = src.pos.x;
  dst.pos.y = src.pos.y;
  dst.pos.z = src.pos.z;
  dst.rotation = src.rotation;
  if (src.posEnd) {
    if (!dst.posEnd) dst.posEnd = { x: 0, y: 0, z: 0 };
    dst.posEnd.x = src.posEnd.x;
    dst.posEnd.y = src.posEnd.y;
    dst.posEnd.z = src.posEnd.z;
  } else {
    dst.posEnd = undefined;
  }
  dst.playerId = src.playerId;
  dst.changedFields = src.changedFields;
  dst.unit = src.unit
    ? copyUnitInto(src.unit, dst.unit ?? createReusableUnit())
    : undefined;
  dst.building = src.building
    ? copyBuildingInto(src.building, dst.building ?? createReusableBuilding())
    : undefined;
  dst.shot = src.shot
    ? copyShotInto(src.shot, dst.shot ?? createReusableShot())
    : undefined;
  return dst;
}

function createReusableEntity(): NetworkServerSnapshotEntity {
  return {
    id: 0,
    type: 'unit',
    pos: { x: 0, y: 0, z: 0 },
    rotation: 0,
    playerId: 1,
  };
}

type ReusableCaptureTile = NonNullable<NetworkServerSnapshot['capture']>['tiles'][number];

function createReusableSpray(): NetworkServerSnapshotSprayTarget {
  return {
    source: { id: 0, pos: { x: 0, y: 0 }, playerId: 1 },
    target: { id: 0, pos: { x: 0, y: 0 } },
    type: 'build',
    intensity: 0,
  };
}

function copySprayInto(
  src: NetworkServerSnapshotSprayTarget,
  dst: NetworkServerSnapshotSprayTarget,
): NetworkServerSnapshotSprayTarget {
  dst.source.id = src.source.id;
  dst.source.pos.x = src.source.pos.x;
  dst.source.pos.y = src.source.pos.y;
  dst.source.z = src.source.z;
  dst.source.playerId = src.source.playerId;
  dst.target.id = src.target.id;
  dst.target.pos.x = src.target.pos.x;
  dst.target.pos.y = src.target.pos.y;
  dst.target.z = src.target.z;
  if (src.target.dim) {
    if (!dst.target.dim) dst.target.dim = { x: 0, y: 0 };
    dst.target.dim.x = src.target.dim.x;
    dst.target.dim.y = src.target.dim.y;
  } else {
    dst.target.dim = undefined;
  }
  dst.target.radius = src.target.radius;
  dst.type = src.type;
  dst.intensity = src.intensity;
  return dst;
}

function createReusableSimEvent(): NetworkServerSnapshotSimEvent {
  return { type: 'fire', turretId: '', pos: { x: 0, y: 0, z: 0 } };
}

function copySimEventInto(
  src: NetworkServerSnapshotSimEvent,
  dst: NetworkServerSnapshotSimEvent,
): NetworkServerSnapshotSimEvent {
  dst.type = src.type;
  dst.turretId = src.turretId;
  dst.pos.x = src.pos.x;
  dst.pos.y = src.pos.y;
  dst.pos.z = src.pos.z;
  dst.entityId = src.entityId;
  dst.deathContext = src.deathContext ? { ...src.deathContext } : undefined;
  dst.impactContext = src.impactContext ? { ...src.impactContext } : undefined;
  return dst;
}

function createReusableSpawn(): NetworkServerSnapshotProjectileSpawn {
  return {
    id: 0,
    pos: { x: 0, y: 0, z: 0 },
    rotation: 0,
    velocity: { x: 0, y: 0, z: 0 },
    projectileType: 0,
    turretId: '',
    playerId: 1,
    sourceEntityId: 0,
    turretIndex: 0,
    barrelIndex: 0,
  };
}

function copySpawnInto(
  src: NetworkServerSnapshotProjectileSpawn,
  dst: NetworkServerSnapshotProjectileSpawn,
): NetworkServerSnapshotProjectileSpawn {
  dst.id = src.id;
  dst.pos.x = src.pos.x;
  dst.pos.y = src.pos.y;
  dst.pos.z = src.pos.z;
  dst.rotation = src.rotation;
  dst.velocity.x = src.velocity.x;
  dst.velocity.y = src.velocity.y;
  dst.velocity.z = src.velocity.z;
  dst.projectileType = src.projectileType;
  dst.maxLifespan = src.maxLifespan;
  dst.turretId = src.turretId;
  dst.playerId = src.playerId;
  dst.sourceEntityId = src.sourceEntityId;
  dst.turretIndex = src.turretIndex;
  dst.barrelIndex = src.barrelIndex;
  dst.isDGun = src.isDGun;
  dst.fromParentDetonation = src.fromParentDetonation;
  if (src.beam) {
    if (!dst.beam) dst.beam = { start: { x: 0, y: 0, z: 0 }, end: { x: 0, y: 0, z: 0 } };
    dst.beam.start.x = src.beam.start.x;
    dst.beam.start.y = src.beam.start.y;
    dst.beam.start.z = src.beam.start.z;
    dst.beam.end.x = src.beam.end.x;
    dst.beam.end.y = src.beam.end.y;
    dst.beam.end.z = src.beam.end.z;
  } else {
    dst.beam = undefined;
  }
  dst.targetEntityId = src.targetEntityId;
  dst.homingTurnRate = src.homingTurnRate;
  return dst;
}

function copyVelocityInto(
  src: NetworkServerSnapshotVelocityUpdate,
  dst: NetworkServerSnapshotVelocityUpdate,
): NetworkServerSnapshotVelocityUpdate {
  dst.id = src.id;
  dst.pos.x = src.pos.x;
  dst.pos.y = src.pos.y;
  dst.pos.z = src.pos.z;
  dst.velocity.x = src.velocity.x;
  dst.velocity.y = src.velocity.y;
  dst.velocity.z = src.velocity.z;
  return dst;
}

function createReusableVelocity(): NetworkServerSnapshotVelocityUpdate {
  return { id: 0, pos: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } };
}

function createReusableBeam(): NetworkServerSnapshotBeamUpdate {
  return {
    id: 0,
    start: { x: 0, y: 0, z: 0 },
    end: { x: 0, y: 0, z: 0 },
    startVel: { x: 0, y: 0, z: 0 },
    endVel: { x: 0, y: 0, z: 0 },
  };
}

function copyBeamInto(
  src: NetworkServerSnapshotBeamUpdate,
  dst: NetworkServerSnapshotBeamUpdate,
): NetworkServerSnapshotBeamUpdate {
  dst.id = src.id;
  dst.start.x = src.start.x;
  dst.start.y = src.start.y;
  dst.start.z = src.start.z;
  dst.end.x = src.end.x;
  dst.end.y = src.end.y;
  dst.end.z = src.end.z;
  dst.startVel.x = src.startVel.x;
  dst.startVel.y = src.startVel.y;
  dst.startVel.z = src.startVel.z;
  dst.endVel.x = src.endVel.x;
  dst.endVel.y = src.endVel.y;
  dst.endVel.z = src.endVel.z;
  dst.obstructionT = src.obstructionT;
  if (src.reflections && src.reflections.length > 0) {
    const reflections = dst.reflections ?? (dst.reflections = []);
    reflections.length = src.reflections.length;
    for (let i = 0; i < src.reflections.length; i++) {
      const sr = src.reflections[i];
      let dr = reflections[i];
      if (!dr) {
        dr = { x: 0, y: 0, z: 0, mirrorEntityId: 0 };
        reflections[i] = dr;
      }
      dr.x = sr.x;
      dr.y = sr.y;
      dr.z = sr.z;
      dr.mirrorEntityId = sr.mirrorEntityId;
    }
  } else {
    dst.reflections = undefined;
  }
  return dst;
}

function createReusableCell(): NetworkServerSnapshotGridCell {
  return { cell: { x: 0, y: 0, z: 0 }, players: [] };
}

function copyCellInto(
  src: NetworkServerSnapshotGridCell,
  dst: NetworkServerSnapshotGridCell,
): NetworkServerSnapshotGridCell {
  dst.cell.x = src.cell.x;
  dst.cell.y = src.cell.y;
  dst.cell.z = src.cell.z;
  dst.players.length = src.players.length;
  for (let i = 0; i < src.players.length; i++) dst.players[i] = src.players[i];
  return dst;
}

function createReusableCaptureTile(): ReusableCaptureTile {
  return { cx: 0, cy: 0, heights: {} };
}

function copyCaptureTileInto(src: ReusableCaptureTile, dst: ReusableCaptureTile): ReusableCaptureTile {
  dst.cx = src.cx;
  dst.cy = src.cy;
  const heights = dst.heights;
  for (const key in heights) delete heights[key];
  for (const key in src.heights) heights[key] = src.heights[key];
  return dst;
}

function copyEconomyInto(
  src: NetworkServerSnapshotEconomy,
  dst: NetworkServerSnapshotEconomy,
): NetworkServerSnapshotEconomy {
  dst.stockpile.curr = src.stockpile.curr;
  dst.stockpile.max = src.stockpile.max;
  dst.income.base = src.income.base;
  dst.income.production = src.income.production;
  dst.expenditure = src.expenditure;
  dst.mana.stockpile.curr = src.mana.stockpile.curr;
  dst.mana.stockpile.max = src.mana.stockpile.max;
  dst.mana.income.base = src.mana.income.base;
  dst.mana.income.territory = src.mana.income.territory;
  dst.mana.expenditure = src.mana.expenditure;
  dst.metal.stockpile.curr = src.metal.stockpile.curr;
  dst.metal.stockpile.max = src.metal.stockpile.max;
  dst.metal.income.base = src.metal.income.base;
  dst.metal.income.extraction = src.metal.income.extraction;
  dst.metal.expenditure = src.metal.expenditure;
  return dst;
}

/**
 * Reuses the destination snapshot/entity object graph across full-keyframe
 * clones. This is for local in-memory snapshots where the server serializer
 * reuses pooled objects, but allocating a fresh 10k-entity clone every
 * keyframe would create GC spikes on the render thread.
 */
export class ReusableNetworkSnapshotCloner {
  private snapshot: NetworkServerSnapshot = {
    tick: 0,
    entities: [],
    economy: {} as NetworkServerSnapshot['economy'],
    isDelta: false,
  };
  private economyKeys: string[] = [];
  private sprayTargets: NetworkServerSnapshotSprayTarget[] = [];
  private audioEvents: NetworkServerSnapshotSimEvent[] = [];
  private spawns: NetworkServerSnapshotProjectileSpawn[] = [];
  private despawns: NetworkServerSnapshotProjectileDespawn[] = [];
  private velocityUpdates: NetworkServerSnapshotVelocityUpdate[] = [];
  private beamUpdates: NetworkServerSnapshotBeamUpdate[] = [];
  private projectiles: NonNullable<NetworkServerSnapshot['projectiles']> = {};
  private grid: NonNullable<NetworkServerSnapshot['grid']> = { cells: [], searchCells: [], cellSize: 0 };
  private capture: NonNullable<NetworkServerSnapshot['capture']> = { tiles: [], cellSize: 0 };
  private gameState: NonNullable<NetworkServerSnapshot['gameState']> = { phase: 'battle' };
  private removedEntityIds: number[] = [];

  clear(): void {
    this.snapshot.entities.length = 0;
    for (let i = 0; i < this.economyKeys.length; i++) {
      delete this.snapshot.economy[Number(this.economyKeys[i]) as keyof NetworkServerSnapshot['economy']];
    }
    this.economyKeys.length = 0;
    this.sprayTargets.length = 0;
    this.audioEvents.length = 0;
    this.spawns.length = 0;
    this.despawns.length = 0;
    this.velocityUpdates.length = 0;
    this.beamUpdates.length = 0;
    this.projectiles.spawns = undefined;
    this.projectiles.despawns = undefined;
    this.projectiles.velocityUpdates = undefined;
    this.projectiles.beamUpdates = undefined;
    this.grid.cells.length = 0;
    this.grid.searchCells.length = 0;
    this.capture.tiles.length = 0;
    this.removedEntityIds.length = 0;
    this.snapshot.sprayTargets = undefined;
    this.snapshot.audioEvents = undefined;
    this.snapshot.projectiles = undefined;
    this.snapshot.grid = undefined;
    this.snapshot.capture = undefined;
    this.snapshot.gameState = undefined;
    this.snapshot.combatStats = undefined;
    this.snapshot.serverMeta = undefined;
    this.snapshot.removedEntityIds = undefined;
  }

  clone(state: NetworkServerSnapshot): NetworkServerSnapshot {
    const dst = this.snapshot;
    dst.tick = state.tick;
    const entities = dst.entities;
    entities.length = state.entities.length;
    for (let i = 0; i < state.entities.length; i++) {
      entities[i] = copyEntityInto(state.entities[i], entities[i] ?? createReusableEntity());
    }

    const economy = dst.economy;
    for (let i = 0; i < this.economyKeys.length; i++) {
      delete economy[Number(this.economyKeys[i]) as keyof NetworkServerSnapshot['economy']];
    }
    this.economyKeys.length = 0;
    for (const key in state.economy) {
      const playerId = Number(key) as keyof NetworkServerSnapshot['economy'];
      this.economyKeys.push(key);
      economy[playerId] = copyEconomyInto(
        state.economy[playerId],
        economy[playerId] ?? cloneEconomyEntry(state.economy[playerId]),
      );
    }
    dst.sprayTargets = this.copyArray(state.sprayTargets, this.sprayTargets, createReusableSpray, copySprayInto);
    dst.audioEvents = this.copyArray(state.audioEvents, this.audioEvents, createReusableSimEvent, copySimEventInto);
    if (state.projectiles) {
      this.projectiles.spawns = this.copyArray(state.projectiles.spawns, this.spawns, createReusableSpawn, copySpawnInto);
      this.projectiles.despawns = this.copyDespawnArray(state.projectiles.despawns);
      this.projectiles.velocityUpdates = this.copyArray(
        state.projectiles.velocityUpdates,
        this.velocityUpdates,
        createReusableVelocity,
        copyVelocityInto,
      );
      this.projectiles.beamUpdates = this.copyArray(
        state.projectiles.beamUpdates,
        this.beamUpdates,
        createReusableBeam,
        copyBeamInto,
      );
      dst.projectiles = this.projectiles;
    } else {
      dst.projectiles = undefined;
    }
    if (state.gameState) {
      this.gameState.phase = state.gameState.phase;
      this.gameState.winnerId = state.gameState.winnerId;
      dst.gameState = this.gameState;
    } else {
      dst.gameState = undefined;
    }
    dst.combatStats = state.combatStats ? cloneNetworkCombatStats(state.combatStats) : undefined;
    dst.serverMeta = state.serverMeta ? {
      ticks: { ...state.serverMeta.ticks },
      snaps: { ...state.serverMeta.snaps },
      server: { ...state.serverMeta.server },
      grid: state.serverMeta.grid,
      units: state.serverMeta.units ? {
        allowed: state.serverMeta.units.allowed?.slice(),
        max: state.serverMeta.units.max,
        count: state.serverMeta.units.count,
      } : {},
      ffAccel: { ...state.serverMeta.ffAccel },
      mirrorsEnabled: state.serverMeta.mirrorsEnabled,
      forceFieldsEnabled: state.serverMeta.forceFieldsEnabled,
      cpu: state.serverMeta.cpu ? { ...state.serverMeta.cpu } : undefined,
      simLod: state.serverMeta.simLod ? {
        picked: state.serverMeta.simLod.picked,
        effective: state.serverMeta.simLod.effective,
        signals: state.serverMeta.simLod.signals ? { ...state.serverMeta.simLod.signals } : undefined,
      } : undefined,
      wind: state.serverMeta.wind ? { ...state.serverMeta.wind } : undefined,
    } : undefined;
    if (state.grid) {
      this.grid.cells = this.copyRequiredArray(state.grid.cells, this.grid.cells, createReusableCell, copyCellInto);
      this.grid.searchCells = this.copyRequiredArray(state.grid.searchCells, this.grid.searchCells, createReusableCell, copyCellInto);
      this.grid.cellSize = state.grid.cellSize;
      dst.grid = this.grid;
    } else {
      dst.grid = undefined;
    }
    if (state.capture) {
      this.capture.tiles = this.copyRequiredArray(
        state.capture.tiles,
        this.capture.tiles,
        createReusableCaptureTile,
        copyCaptureTileInto,
      );
      this.capture.cellSize = state.capture.cellSize;
      dst.capture = this.capture;
    } else {
      dst.capture = undefined;
    }
    dst.isDelta = state.isDelta;
    if (state.removedEntityIds && state.removedEntityIds.length > 0) {
      this.removedEntityIds.length = state.removedEntityIds.length;
      for (let i = 0; i < state.removedEntityIds.length; i++) {
        this.removedEntityIds[i] = state.removedEntityIds[i];
      }
      dst.removedEntityIds = this.removedEntityIds;
    } else {
      dst.removedEntityIds = undefined;
    }
    return dst;
  }

  private copyRequiredArray<T>(
    src: readonly T[],
    dst: T[],
    create: () => T,
    copy: (src: T, dst: T) => T,
  ): T[] {
    dst.length = src.length;
    for (let i = 0; i < src.length; i++) {
      dst[i] = copy(src[i], dst[i] ?? create());
    }
    return dst;
  }

  private copyArray<T>(
    src: readonly T[] | undefined,
    dst: T[],
    create: () => T,
    copy: (src: T, dst: T) => T,
  ): T[] | undefined {
    if (!src || src.length === 0) return undefined;
    dst.length = src.length;
    for (let i = 0; i < src.length; i++) {
      dst[i] = copy(src[i], dst[i] ?? create());
    }
    return dst;
  }

  private copyDespawnArray(
    src: readonly NetworkServerSnapshotProjectileDespawn[] | undefined,
  ): NetworkServerSnapshotProjectileDespawn[] | undefined {
    if (!src || src.length === 0) return undefined;
    this.despawns.length = src.length;
    for (let i = 0; i < src.length; i++) {
      const out = this.despawns[i] ?? { id: 0 };
      out.id = src[i].id;
      this.despawns[i] = out;
    }
    return this.despawns;
  }
}
