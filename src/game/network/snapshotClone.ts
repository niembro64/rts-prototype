import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotEconomy,
  NetworkServerSnapshotEntity,
  NetworkServerSnapshotProjectileDespawn,
  NetworkServerSnapshotProjectileSpawn,
  NetworkServerSnapshotBeamUpdate,
  NetworkServerSnapshotSimEvent,
  NetworkServerSnapshotSprayTarget,
  NetworkServerSnapshotVelocityUpdate,
} from './NetworkTypes';
import type { TerrainBuildabilityGrid, TerrainTileMap } from '@/types/terrain';
import {
  copyActionInto,
  copyBeamInto,
  copyCellInto,
  copySimEventInto,
  copySpawnInto,
  copySprayInto,
  copyTurretInto,
  copyVelocityInto,
  copyWaypointInto,
  createActionDto,
  createBeamDto,
  createCellDto,
  createSimEventDto,
  createSpawnDto,
  createSprayDto,
  createTurretDto,
  createVelocityDto,
  createWaypointDto,
} from './snapshotDtoCopy';

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

/** Pass-through. TerrainTileMap is immutable per match (see the
 *  contract on the type definition); the previous deep-clone was
 *  copying ~14k–60k height samples per full keyframe per listener
 *  for no benefit since no consumer mutates the map. Sharing the
 *  reference is safe and saves a predictable allocation spike on
 *  every keyframe. */
function cloneTerrainTileMap(map: TerrainTileMap): TerrainTileMap {
  return map;
}

function cloneTerrainBuildabilityGrid(grid: TerrainBuildabilityGrid): TerrainBuildabilityGrid {
  return grid;
}

type ReusableEntityUnit = NonNullable<NetworkServerSnapshotEntity['unit']>;
type ReusableEntityBuilding = NonNullable<NetworkServerSnapshotEntity['building']>;
type ReusableFactory = NonNullable<ReusableEntityBuilding['factory']>;
type ReusableBuildState = NonNullable<ReusableEntityUnit['build']>;
type ReusableSuspensionState = NonNullable<ReusableEntityUnit['suspension']>;

function createReusableUnit(): ReusableEntityUnit {
  return {
    hp: { curr: 0, max: 0 },
    velocity: { x: 0, y: 0, z: 0 },
  };
}

function copyVec3OptionalInto(
  src: { x: number; y: number; z: number } | undefined,
  dst: { x: number; y: number; z: number } | undefined,
): { x: number; y: number; z: number } | undefined {
  if (!src) return undefined;
  const out = dst ?? { x: 0, y: 0, z: 0 };
  out.x = src.x;
  out.y = src.y;
  out.z = src.z;
  return out;
}

function copyBuildStateInto(
  src: ReusableBuildState,
  dst: ReusableBuildState,
): ReusableBuildState {
  dst.complete = src.complete;
  dst.paid.energy = src.paid.energy;
  dst.paid.mana = src.paid.mana;
  dst.paid.metal = src.paid.metal;
  return dst;
}

function createReusableBuildState(): ReusableBuildState {
  return {
    complete: false,
    paid: { energy: 0, mana: 0, metal: 0 },
  };
}

function createReusableSuspensionState(): ReusableSuspensionState {
  return {
    offset: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
  };
}

function copyUnitInto(src: ReusableEntityUnit, dst: ReusableEntityUnit): ReusableEntityUnit {
  dst.unitType = src.unitType;
  dst.hp.curr = src.hp.curr;
  dst.hp.max = src.hp.max;
  if (src.radius) {
    if (!dst.radius) dst.radius = { body: 0, shot: 0, push: 0 };
    dst.radius.body = src.radius.body;
    dst.radius.shot = src.radius.shot;
    dst.radius.push = src.radius.push;
  } else {
    dst.radius = undefined;
  }
  dst.bodyCenterHeight = src.bodyCenterHeight;
  dst.mass = src.mass;
  dst.velocity.x = src.velocity.x;
  dst.velocity.y = src.velocity.y;
  dst.velocity.z = src.velocity.z;
  dst.movementAccel = copyVec3OptionalInto(
    src.movementAccel,
    dst.movementAccel,
  );
  if (src.surfaceNormal) {
    if (!dst.surfaceNormal) dst.surfaceNormal = { nx: 0, ny: 0, nz: 1 };
    dst.surfaceNormal.nx = src.surfaceNormal.nx;
    dst.surfaceNormal.ny = src.surfaceNormal.ny;
    dst.surfaceNormal.nz = src.surfaceNormal.nz;
  } else {
    dst.surfaceNormal = undefined;
  }
  if (src.suspension) {
    const suspension = dst.suspension ?? (dst.suspension = createReusableSuspensionState());
    suspension.offset.x = src.suspension.offset.x;
    suspension.offset.y = src.suspension.offset.y;
    suspension.offset.z = src.suspension.offset.z;
    suspension.velocity.x = src.suspension.velocity.x;
    suspension.velocity.y = src.suspension.velocity.y;
    suspension.velocity.z = src.suspension.velocity.z;
    suspension.jumpActive = src.suspension.jumpActive;
    suspension.legContact = src.suspension.legContact;
  } else {
    dst.suspension = undefined;
  }
  dst.isCommander = src.isCommander;
  dst.buildTargetId = src.buildTargetId;
  dst.build = src.build
    ? copyBuildStateInto(src.build, dst.build ?? createReusableBuildState())
    : undefined;

  if (src.actions) {
    const actions = dst.actions ?? (dst.actions = []);
    actions.length = src.actions.length;
    for (let i = 0; i < src.actions.length; i++) {
      actions[i] = copyActionInto(src.actions[i], actions[i] ?? createActionDto());
    }
  } else {
    dst.actions = undefined;
  }

  if (src.turrets) {
    const turrets = dst.turrets ?? (dst.turrets = []);
    turrets.length = src.turrets.length;
    for (let i = 0; i < src.turrets.length; i++) {
      turrets[i] = copyTurretInto(
        src.turrets[i],
        turrets[i] ?? createTurretDto(),
      );
    }
  } else {
    dst.turrets = undefined;
  }

  return dst;
}

function createReusableBuilding(): ReusableEntityBuilding {
  return {
    hp: { curr: 0, max: 0 },
    build: {
      complete: false,
      paid: { energy: 0, mana: 0, metal: 0 },
    },
  };
}

function copyFactoryInto(src: ReusableFactory, dst: ReusableFactory): ReusableFactory {
  dst.queue.length = src.queue.length;
  for (let i = 0; i < src.queue.length; i++) dst.queue[i] = src.queue[i];
  dst.progress = src.progress;
  dst.producing = src.producing;
  dst.energyRate = src.energyRate;
  dst.manaRate = src.manaRate;
  dst.metalRate = src.metalRate;
  dst.waypoints.length = src.waypoints.length;
  for (let i = 0; i < src.waypoints.length; i++) {
    let dw = dst.waypoints[i];
    if (!dw) {
      dw = createWaypointDto();
      dst.waypoints[i] = dw;
    }
    copyWaypointInto(src.waypoints[i], dw);
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
  copyBuildStateInto(src.build, dst.build);
  dst.metalExtractionRate = src.metalExtractionRate;
  if (src.solar) {
    if (!dst.solar) dst.solar = { open: true };
    dst.solar.open = src.solar.open;
  } else {
    dst.solar = undefined;
  }
  if (src.turrets) {
    const turrets = dst.turrets ?? (dst.turrets = []);
    turrets.length = src.turrets.length;
    for (let i = 0; i < src.turrets.length; i++) {
      turrets[i] = copyTurretInto(
        src.turrets[i],
        turrets[i] ?? createTurretDto(),
      );
    }
  } else {
    dst.turrets = undefined;
  }
  if (src.factory) {
    if (!dst.factory) {
      dst.factory = {
        queue: [],
        progress: 0,
        producing: false,
        energyRate: 0,
        manaRate: 0,
        metalRate: 0,
        waypoints: [],
      };
    }
    copyFactoryInto(src.factory, dst.factory);
  } else {
    dst.factory = undefined;
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
  dst.playerId = src.playerId;
  dst.changedFields = src.changedFields;
  dst.unit = src.unit
    ? copyUnitInto(src.unit, dst.unit ?? createReusableUnit())
    : undefined;
  dst.building = src.building
    ? copyBuildingInto(src.building, dst.building ?? createReusableBuilding())
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
    this.snapshot.terrain = undefined;
    this.snapshot.buildability = undefined;
    this.snapshot.gameState = undefined;
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
    dst.sprayTargets = this.copyArray(state.sprayTargets, this.sprayTargets, createSprayDto, copySprayInto);
    dst.audioEvents = this.copyArray(state.audioEvents, this.audioEvents, createSimEventDto, copySimEventInto);
    if (state.projectiles) {
      this.projectiles.spawns = this.copyArray(state.projectiles.spawns, this.spawns, createSpawnDto, copySpawnInto);
      this.projectiles.despawns = this.copyDespawnArray(state.projectiles.despawns);
      this.projectiles.velocityUpdates = this.copyArray(
        state.projectiles.velocityUpdates,
        this.velocityUpdates,
        createVelocityDto,
        copyVelocityInto,
      );
      this.projectiles.beamUpdates = this.copyArray(
        state.projectiles.beamUpdates,
        this.beamUpdates,
        createBeamDto,
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
      mirrorsEnabled: state.serverMeta.mirrorsEnabled,
      forceFieldsEnabled: state.serverMeta.forceFieldsEnabled,
      cpu: state.serverMeta.cpu ? { ...state.serverMeta.cpu } : undefined,
      simLod: state.serverMeta.simLod ? {
        picked: state.serverMeta.simLod.picked,
        effective: state.serverMeta.simLod.effective,
        signals: state.serverMeta.simLod.signals ? { ...state.serverMeta.simLod.signals } : undefined,
      } : undefined,
      wind: state.serverMeta.wind ? { ...state.serverMeta.wind } : undefined,
      tiltEma: state.serverMeta.tiltEma,
    } : undefined;
    if (state.grid) {
      this.grid.cells = this.copyRequiredArray(state.grid.cells, this.grid.cells, createCellDto, copyCellInto);
      this.grid.searchCells = this.copyRequiredArray(state.grid.searchCells, this.grid.searchCells, createCellDto, copyCellInto);
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
    dst.terrain = state.terrain ? cloneTerrainTileMap(state.terrain) : undefined;
    dst.buildability = state.buildability
      ? cloneTerrainBuildabilityGrid(state.buildability)
      : undefined;
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

export function cloneNetworkSnapshot(state: NetworkServerSnapshot): NetworkServerSnapshot {
  return new ReusableNetworkSnapshotCloner().clone(state);
}
