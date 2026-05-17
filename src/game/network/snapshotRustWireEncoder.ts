import { encode as msgpackEncode } from '@msgpack/msgpack';
import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotAction,
  NetworkServerSnapshotBeamUpdate,
  NetworkServerSnapshotEconomy,
  NetworkServerSnapshotEntity,
  NetworkServerSnapshotMinimapEntity,
  NetworkServerSnapshotProjectileSpawn,
  NetworkServerSnapshotMeta,
  NetworkServerSnapshotSimEvent,
  NetworkServerSnapshotSprayTarget,
  NetworkServerSnapshotTurret,
} from './NetworkTypes';
import {
  getSimWasm,
  SNAPSHOT_ENTITY_TYPE_BUILDING,
  SNAPSHOT_ENTITY_TYPE_UNIT,
  type SimWasm,
} from '../sim-wasm/init';

const SNAPSHOT_ENCODE_OPTIONS = { ignoreUndefined: true } as const;

type SnapshotEncodeApi = SimWasm['snapshotEncode'];
type SnapshotUnit = NonNullable<NetworkServerSnapshotEntity['unit']>;
type SnapshotBuilding = NonNullable<NetworkServerSnapshotEntity['building']>;
type SnapshotCapture = NonNullable<NetworkServerSnapshot['capture']>;
type SnapshotProjectiles = NonNullable<NetworkServerSnapshot['projectiles']>;
type SnapshotServerMeta = NetworkServerSnapshotMeta;

const _utf8 = new TextEncoder();

function hasValue<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function isUint(value: unknown, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value);
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

function isFiniteNumberOrString(value: unknown): value is number | string {
  return isFiniteNumber(value) || typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function writeStringsIntoScratch(
  sim: SimWasm,
  utf8Bytes: readonly Uint8Array[],
  totalBytes: number,
): void {
  const api = sim.snapshotEncode;
  api.stringScratchEnsureBytes(Math.max(totalBytes, 1));
  api.stringScratchEnsureTable(utf8Bytes.length);
  const bytesPtr = api.stringScratchBytesPtr();
  const tablePtr = api.stringScratchTablePtr();
  const bytesView = new Uint8Array(sim.memory.buffer, bytesPtr, totalBytes);
  const tableView = new Uint32Array(sim.memory.buffer, tablePtr, utf8Bytes.length * 2);

  let offset = 0;
  for (let i = 0; i < utf8Bytes.length; i++) {
    const bytes = utf8Bytes[i];
    bytesView.set(bytes, offset);
    tableView[i * 2] = offset;
    tableView[i * 2 + 1] = bytes.length;
    offset += bytes.length;
  }
}

function packStringsIntoScratch(
  sim: SimWasm,
  strings: readonly string[],
): Map<string, number> {
  const slotByString = new Map<string, number>();
  if (strings.length === 0) return slotByString;

  const utf8Bytes: Uint8Array[] = [];
  let totalBytes = 0;
  for (const s of strings) {
    if (slotByString.has(s)) continue;
    const bytes = _utf8.encode(s);
    slotByString.set(s, utf8Bytes.length);
    utf8Bytes.push(bytes);
    totalBytes += bytes.length;
  }

  writeStringsIntoScratch(sim, utf8Bytes, totalBytes);
  return slotByString;
}

function packOrderedStringsIntoScratch(sim: SimWasm, strings: readonly string[]): void {
  if (strings.length === 0) return;
  const utf8Bytes: Uint8Array[] = [];
  let totalBytes = 0;
  for (const s of strings) {
    const bytes = _utf8.encode(s);
    utf8Bytes.push(bytes);
    totalBytes += bytes.length;
  }
  writeStringsIntoScratch(sim, utf8Bytes, totalBytes);
}

function packActionsIntoScratch(
  sim: SimWasm,
  actions: readonly NetworkServerSnapshotAction[],
  stringSlots: Map<string, number>,
): void {
  if (actions.length === 0) return;
  const api = sim.snapshotEncode;
  api.actionScratchEnsure(actions.length);
  const view = new Float64Array(
    sim.memory.buffer,
    api.actionScratchPtr(),
    actions.length * api.actionScratchStride,
  );
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const base = i * api.actionScratchStride;
    view[base + 0] = action.type;
    view[base + 1] = action.pos !== undefined ? 1 : 0;
    view[base + 2] = action.pos?.x ?? 0;
    view[base + 3] = action.pos?.y ?? 0;
    view[base + 4] = action.posZ !== undefined ? 1 : 0;
    view[base + 5] = action.posZ ?? 0;
    view[base + 6] = action.pathExp === true ? 1 : 0;
    view[base + 7] = action.targetId !== undefined ? 1 : 0;
    view[base + 8] = action.targetId ?? 0;
    view[base + 9] = action.buildingType !== undefined ? 1 : 0;
    view[base + 10] = action.buildingType !== undefined
      ? stringSlots.get(action.buildingType) ?? 0
      : 0;
    view[base + 11] = action.grid !== undefined ? 1 : 0;
    view[base + 12] = action.grid?.x ?? 0;
    view[base + 13] = action.grid?.y ?? 0;
    view[base + 14] = action.buildingId !== undefined ? 1 : 0;
    view[base + 15] = action.buildingId ?? 0;
  }
}

function packTurretsIntoScratch(
  sim: SimWasm,
  turrets: readonly NetworkServerSnapshotTurret[],
): void {
  if (turrets.length === 0) return;
  const api = sim.snapshotEncode;
  api.turretScratchEnsure(turrets.length);
  const view = new Float64Array(
    sim.memory.buffer,
    api.turretScratchPtr(),
    turrets.length * api.turretScratchStride,
  );
  for (let i = 0; i < turrets.length; i++) {
    const src = turrets[i];
    const angular = src.turret.angular;
    const base = i * api.turretScratchStride;
    view[base + 0] = angular.rot;
    view[base + 1] = angular.vel;
    view[base + 2] = angular.acc;
    view[base + 3] = angular.pitch;
    view[base + 4] = angular.pitchVel;
    view[base + 5] = angular.pitchAcc;
    view[base + 6] = src.turret.id;
    view[base + 7] = src.state;
    view[base + 8] = src.targetId !== undefined ? 1 : 0;
    view[base + 9] = src.targetId ?? 0;
    view[base + 10] = src.currentForceFieldRange !== undefined ? 1 : 0;
    view[base + 11] = src.currentForceFieldRange ?? 0;
  }
}

function unitNeedsRawFallback(unit: SnapshotUnit): boolean {
  return (
    (unit.unitType !== undefined && !isUint(unit.unitType, 0xFFFF_FFFF)) ||
    (unit.radius !== undefined && (
      !Number.isFinite(unit.radius.body) ||
      !Number.isFinite(unit.radius.shot) ||
      !Number.isFinite(unit.radius.push)
    )) ||
    (unit.bodyCenterHeight !== undefined && !Number.isFinite(unit.bodyCenterHeight)) ||
    (unit.mass !== undefined && !Number.isFinite(unit.mass)) ||
    (unit.jump !== undefined && unit.jump.enabled === undefined) ||
    unit.jump?.active === false ||
    unit.suspension?.legContact === false ||
    unit.fireEnabled === true ||
    unit.isCommander === false
  );
}

function encodeUnitEntity(sim: SimWasm, entity: NetworkServerSnapshotEntity, unit: SnapshotUnit): boolean {
  if (unitNeedsRawFallback(unit)) return false;
  if (!unit.hp || !unit.velocity) return false;

  const actions = unit.actions;
  const turrets = unit.turrets;
  const strings: string[] = [];
  if (actions) {
    for (const action of actions) {
      if (action.buildingType !== undefined) strings.push(action.buildingType);
    }
  }
  const stringSlots = packStringsIntoScratch(sim, strings);
  if (actions) packActionsIntoScratch(sim, actions, stringSlots);
  if (turrets) packTurretsIntoScratch(sim, turrets);

  const api = sim.snapshotEncode;
  const movementAccel = unit.movementAccel;
  const surfaceNormal = unit.surfaceNormal;
  const suspension = unit.suspension;
  const jump = unit.jump;
  const orientation = unit.orientation;
  const angularVelocity = unit.angularVelocity3;
  const angularAcceleration = unit.angularAcceleration3;
  const build = unit.build;
  api.encodeEntityUnit(
    entity.id,
    SNAPSHOT_ENTITY_TYPE_UNIT,
    entity.pos.x, entity.pos.y, entity.pos.z,
    entity.rotation,
    entity.playerId,
    entity.changedFields !== undefined ? 1 : 0,
    entity.changedFields ?? 0,
    unit.hp.curr,
    unit.hp.max,
    unit.velocity.x, unit.velocity.y, unit.velocity.z,
    unit.unitType !== undefined ? 1 : 0,
    unit.unitType ?? 0,
    unit.radius !== undefined ? 1 : 0,
    unit.radius?.body ?? 0,
    unit.radius?.shot ?? 0,
    unit.radius?.push ?? 0,
    unit.bodyCenterHeight !== undefined ? 1 : 0,
    unit.bodyCenterHeight ?? 0,
    unit.mass !== undefined ? 1 : 0,
    unit.mass ?? 0,
    movementAccel !== undefined ? 1 : 0,
    movementAccel?.x ?? 0,
    movementAccel?.y ?? 0,
    movementAccel?.z ?? 0,
    surfaceNormal !== undefined ? 1 : 0,
    surfaceNormal?.nx ?? 0,
    surfaceNormal?.ny ?? 0,
    surfaceNormal?.nz ?? 0,
    suspension !== undefined ? 1 : 0,
    suspension?.offset.x ?? 0,
    suspension?.offset.y ?? 0,
    suspension?.offset.z ?? 0,
    suspension?.velocity.x ?? 0,
    suspension?.velocity.y ?? 0,
    suspension?.velocity.z ?? 0,
    suspension?.legContact === true ? 1 : 0,
    jump !== undefined ? 1 : 0,
    jump?.enabled === true ? 1 : 0,
    jump?.active === true ? 1 : 0,
    jump?.launchSeq !== undefined ? 1 : 0,
    jump?.launchSeq ?? 0,
    orientation !== undefined ? 1 : 0,
    orientation?.x ?? 0,
    orientation?.y ?? 0,
    orientation?.z ?? 0,
    orientation?.w ?? 0,
    angularVelocity !== undefined ? 1 : 0,
    angularVelocity?.x ?? 0,
    angularVelocity?.y ?? 0,
    angularVelocity?.z ?? 0,
    angularAcceleration !== undefined ? 1 : 0,
    angularAcceleration?.x ?? 0,
    angularAcceleration?.y ?? 0,
    angularAcceleration?.z ?? 0,
    unit.fireEnabled === false ? 1 : 0,
    unit.isCommander === true ? 1 : 0,
    unit.buildTargetId !== undefined ? 1 : 0,
    unit.buildTargetId === null ? 1 : 0,
    typeof unit.buildTargetId === 'number' ? unit.buildTargetId : 0,
    actions !== undefined ? 1 : 0,
    actions?.length ?? 0,
    turrets !== undefined ? 1 : 0,
    turrets?.length ?? 0,
    build !== undefined ? 1 : 0,
    build?.complete === true ? 1 : 0,
    build?.paid.energy ?? 0,
    build?.paid.mana ?? 0,
    build?.paid.metal ?? 0,
  );
  return true;
}

function buildingNeedsRawFallback(building: SnapshotBuilding): boolean {
  return (
    !building.hp ||
    !building.build ||
    (building.type !== undefined && typeof building.type !== 'number') ||
    (building.factory?.queue.some((code) => !isUint(code, 0xFFFF_FFFF)) ?? false)
  );
}

function encodeBuildingEntity(
  sim: SimWasm,
  entity: NetworkServerSnapshotEntity,
  building: SnapshotBuilding,
): boolean {
  if (buildingNeedsRawFallback(building)) return false;

  const api = sim.snapshotEncode;
  const turrets = building.turrets;
  if (turrets) packTurretsIntoScratch(sim, turrets);

  const factory = building.factory;
  let stringSlots = new Map<string, number>();
  if (factory) {
    const strings = factory.waypoints.map((waypoint) => waypoint.type);
    stringSlots = packStringsIntoScratch(sim, strings);
    packFactoryQueueIntoScratch(sim, factory.queue);
    packWaypointsIntoScratch(sim, factory.waypoints, stringSlots);
  }

  api.encodeEntityBuilding(
    entity.id,
    entity.pos.x, entity.pos.y, entity.pos.z,
    entity.rotation,
    entity.playerId,
    entity.changedFields !== undefined ? 1 : 0,
    entity.changedFields ?? 0,
    building.type !== undefined ? 1 : 0,
    building.type ?? 0,
    building.dim !== undefined ? 1 : 0,
    building.dim?.x ?? 0,
    building.dim?.y ?? 0,
    building.hp.curr,
    building.hp.max,
    building.build.complete ? 1 : 0,
    building.build.paid.energy,
    building.build.paid.mana,
    building.build.paid.metal,
    building.metalExtractionRate !== undefined ? 1 : 0,
    building.metalExtractionRate ?? 0,
    building.solar !== undefined ? 1 : 0,
    building.solar?.open === true ? 1 : 0,
    turrets !== undefined ? 1 : 0,
    turrets?.length ?? 0,
    factory !== undefined ? 1 : 0,
    factory?.queue.length ?? 0,
    factory?.progress ?? 0,
    factory?.producing === true ? 1 : 0,
    factory?.energyRate ?? 0,
    factory?.manaRate ?? 0,
    factory?.metalRate ?? 0,
    factory?.waypoints.length ?? 0,
  );
  return true;
}

function encodeEntity(sim: SimWasm, entity: NetworkServerSnapshotEntity): boolean {
  if (
    !isUint(entity.id, 0xFFFF_FFFF) ||
    !isUint(entity.playerId, 0xFF) ||
    entity.changedFields === null ||
    (entity.changedFields !== undefined && !isUint(entity.changedFields, 0xFFFF_FFFF))
  ) {
    return false;
  }
  if (entity.type === 'unit') {
    if (entity.building !== undefined) return false;
    if (entity.unit !== undefined) return encodeUnitEntity(sim, entity, entity.unit);
    sim.snapshotEncode.encodeEntityBasic(
      entity.id,
      SNAPSHOT_ENTITY_TYPE_UNIT,
      entity.pos.x, entity.pos.y, entity.pos.z,
      entity.rotation,
      entity.playerId,
      entity.changedFields !== undefined ? 1 : 0,
      entity.changedFields ?? 0,
    );
    return true;
  }
  if (entity.type === 'building') {
    if (entity.unit !== undefined) return false;
    if (entity.building !== undefined) return encodeBuildingEntity(sim, entity, entity.building);
    sim.snapshotEncode.encodeEntityBasic(
      entity.id,
      SNAPSHOT_ENTITY_TYPE_BUILDING,
      entity.pos.x, entity.pos.y, entity.pos.z,
      entity.rotation,
      entity.playerId,
      entity.changedFields !== undefined ? 1 : 0,
      entity.changedFields ?? 0,
    );
    return true;
  }
  return false;
}

function packFactoryQueueIntoScratch(sim: SimWasm, queue: readonly number[]): void {
  if (queue.length === 0) return;
  const api = sim.snapshotEncode;
  api.factoryQueueScratchEnsure(queue.length);
  const view = new Uint32Array(sim.memory.buffer, api.factoryQueueScratchPtr(), queue.length);
  for (let i = 0; i < queue.length; i++) view[i] = queue[i];
}

function packWaypointsIntoScratch(
  sim: SimWasm,
  waypoints: NonNullable<SnapshotBuilding['factory']>['waypoints'],
  stringSlots: Map<string, number>,
): void {
  if (waypoints.length === 0) return;
  const api = sim.snapshotEncode;
  api.waypointScratchEnsure(waypoints.length);
  const view = new Float64Array(
    sim.memory.buffer,
    api.waypointScratchPtr(),
    waypoints.length * api.waypointScratchStride,
  );
  for (let i = 0; i < waypoints.length; i++) {
    const waypoint = waypoints[i];
    const base = i * api.waypointScratchStride;
    view[base + 0] = waypoint.pos.x;
    view[base + 1] = waypoint.pos.y;
    view[base + 2] = waypoint.posZ !== undefined ? 1 : 0;
    view[base + 3] = waypoint.posZ ?? 0;
    view[base + 4] = stringSlots.get(waypoint.type) ?? 0;
  }
}

function packMinimapIntoScratch(
  sim: SimWasm,
  entries: readonly NetworkServerSnapshotMinimapEntity[],
): void {
  if (entries.length === 0) return;
  const api = sim.snapshotEncode;
  api.minimapScratchEnsure(entries.length);
  const view = new Float64Array(
    sim.memory.buffer,
    api.minimapScratchPtr(),
    entries.length * api.minimapScratchStride,
  );
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const base = i * api.minimapScratchStride;
    view[base + 0] = entry.id;
    view[base + 1] = entry.pos.x;
    view[base + 2] = entry.pos.y;
    view[base + 3] = entry.type === 'unit'
      ? SNAPSHOT_ENTITY_TYPE_UNIT
      : SNAPSHOT_ENTITY_TYPE_BUILDING;
    view[base + 4] = entry.playerId;
    let packed = 0;
    if (entry.radarOnly !== undefined) {
      packed |= 0x01;
      if (entry.radarOnly) packed |= 0x02;
    }
    view[base + 5] = packed;
  }
}

function packEconomyIntoScratch(
  sim: SimWasm,
  economy: Record<number, NetworkServerSnapshotEconomy>,
): number {
  const ids = Object.keys(economy).map(Number).sort((a, b) => a - b);
  if (ids.length === 0) return 0;
  const api = sim.snapshotEncode;
  api.economyScratchEnsure(ids.length);
  const view = new Float64Array(
    sim.memory.buffer,
    api.economyScratchPtr(),
    ids.length * api.economyScratchStride,
  );
  for (let i = 0; i < ids.length; i++) {
    const playerId = ids[i];
    const src = economy[playerId];
    const base = i * api.economyScratchStride;
    view[base + 0] = playerId;
    view[base + 1] = src.stockpile.curr;
    view[base + 2] = src.stockpile.max;
    view[base + 3] = src.income.base;
    view[base + 4] = src.income.production;
    view[base + 5] = src.expenditure;
    view[base + 6] = src.mana.stockpile.curr;
    view[base + 7] = src.mana.stockpile.max;
    view[base + 8] = src.mana.income.base;
    view[base + 9] = src.mana.income.territory;
    view[base + 10] = src.mana.expenditure;
    view[base + 11] = src.metal.stockpile.curr;
    view[base + 12] = src.metal.stockpile.max;
    view[base + 13] = src.metal.income.base;
    view[base + 14] = src.metal.income.extraction;
    view[base + 15] = src.metal.expenditure;
  }
  return ids.length;
}

function canEncodeServerMeta(meta: SnapshotServerMeta): boolean {
  if (
    !meta.ticks ||
    !isFiniteNumber(meta.ticks.avg) ||
    !isFiniteNumber(meta.ticks.low) ||
    !isFiniteNumber(meta.ticks.rate) ||
    !isFiniteNumber(meta.ticks.target) ||
    !meta.snaps ||
    !isFiniteNumberOrString(meta.snaps.rate) ||
    !isFiniteNumberOrString(meta.snaps.keyframes) ||
    !meta.server ||
    typeof meta.server.time !== 'string' ||
    typeof meta.server.ip !== 'string' ||
    typeof meta.grid !== 'boolean' ||
    !meta.units ||
    (meta.units.allowed !== undefined && !isStringArray(meta.units.allowed)) ||
    !isOptionalFiniteNumber(meta.units.max) ||
    !isOptionalFiniteNumber(meta.units.count) ||
    !isOptionalBoolean(meta.mirrorsEnabled) ||
    !isOptionalBoolean(meta.forceFieldsEnabled) ||
    !isOptionalBoolean(meta.forceFieldsBlockTargeting) ||
    (
      meta.forceFieldReflectionMode !== undefined &&
      typeof meta.forceFieldReflectionMode !== 'string'
    ) ||
    !isOptionalBoolean(meta.fogOfWarEnabled) ||
    !meta.cpu ||
    !isFiniteNumber(meta.cpu.avg) ||
    !isFiniteNumber(meta.cpu.hi) ||
    !meta.simLod ||
    typeof meta.simLod.picked !== 'string' ||
    typeof meta.simLod.effective !== 'string' ||
    !meta.simLod.signals ||
    typeof meta.simLod.signals.tps !== 'string' ||
    typeof meta.simLod.signals.cpu !== 'string' ||
    typeof meta.simLod.signals.units !== 'string' ||
    !meta.wind ||
    !isFiniteNumber(meta.wind.x) ||
    !isFiniteNumber(meta.wind.y) ||
    !isFiniteNumber(meta.wind.speed) ||
    !isFiniteNumber(meta.wind.angle) ||
    typeof meta.tiltEma !== 'string'
  ) {
    return false;
  }

  return true;
}

function emitServerMeta(sim: SimWasm, meta: SnapshotServerMeta): void {
  const strings: string[] = [];
  const pushString = (value: string): number => {
    const slot = strings.length;
    strings.push(value);
    return slot;
  };

  const serverTimeSlot = pushString(meta.server.time);
  const serverIpSlot = pushString(meta.server.ip);

  const unitsAllowed = meta.units.allowed;
  const unitsAllowedSlotStart = strings.length;
  if (unitsAllowed !== undefined) {
    for (const unitType of unitsAllowed) pushString(unitType);
  }

  const snapsRate = meta.snaps.rate;
  let snapsRateSlot = 0;
  if (typeof snapsRate === 'string') {
    snapsRateSlot = pushString(snapsRate);
  }

  const snapsKeyframes = meta.snaps.keyframes;
  let snapsKeyframesSlot = 0;
  if (typeof snapsKeyframes === 'string') {
    snapsKeyframesSlot = pushString(snapsKeyframes);
  }

  let forceFieldReflectionModeSlot = 0;
  if (meta.forceFieldReflectionMode !== undefined) {
    forceFieldReflectionModeSlot = pushString(meta.forceFieldReflectionMode);
  }

  const simLodPickedSlot = pushString(meta.simLod!.picked);
  const simLodEffectiveSlot = pushString(meta.simLod!.effective);
  const simLodSignalTpsSlot = pushString(meta.simLod!.signals!.tps);
  const simLodSignalCpuSlot = pushString(meta.simLod!.signals!.cpu);
  const simLodSignalUnitsSlot = pushString(meta.simLod!.signals!.units);
  const tiltEmaSlot = pushString(meta.tiltEma!);
  packOrderedStringsIntoScratch(sim, strings);

  sim.snapshotEncode.emitServerMeta(
    meta.ticks.avg,
    meta.ticks.low,
    meta.ticks.rate,
    meta.ticks.target,
    typeof snapsRate === 'string' ? 1 : 0,
    typeof snapsRate === 'string' ? 0 : snapsRate,
    snapsRateSlot,
    typeof snapsKeyframes === 'string' ? 1 : 0,
    typeof snapsKeyframes === 'string' ? 0 : snapsKeyframes,
    snapsKeyframesSlot,
    serverTimeSlot,
    serverIpSlot,
    meta.grid ? 1 : 0,
    unitsAllowed !== undefined ? 1 : 0,
    unitsAllowedSlotStart,
    unitsAllowed?.length ?? 0,
    meta.units.max !== undefined ? 1 : 0,
    meta.units.max ?? 0,
    meta.units.count !== undefined ? 1 : 0,
    meta.units.count ?? 0,
    meta.mirrorsEnabled !== undefined ? 1 : 0,
    meta.mirrorsEnabled === true ? 1 : 0,
    meta.forceFieldsEnabled !== undefined ? 1 : 0,
    meta.forceFieldsEnabled === true ? 1 : 0,
    meta.forceFieldsBlockTargeting !== undefined ? 1 : 0,
    meta.forceFieldsBlockTargeting === true ? 1 : 0,
    meta.forceFieldReflectionMode !== undefined ? 1 : 0,
    forceFieldReflectionModeSlot,
    meta.fogOfWarEnabled !== undefined ? 1 : 0,
    meta.fogOfWarEnabled === true ? 1 : 0,
    meta.cpu!.avg,
    meta.cpu!.hi,
    simLodPickedSlot,
    simLodEffectiveSlot,
    simLodSignalTpsSlot,
    simLodSignalCpuSlot,
    simLodSignalUnitsSlot,
    meta.wind!.x,
    meta.wind!.y,
    meta.wind!.speed,
    meta.wind!.angle,
    tiltEmaSlot,
  );
}

function packSprayTargetsIntoScratch(
  sim: SimWasm,
  sprays: readonly NetworkServerSnapshotSprayTarget[],
): void {
  if (sprays.length === 0) return;
  const api = sim.snapshotEncode;
  api.sprayScratchEnsure(sprays.length);
  const view = new Float64Array(
    sim.memory.buffer,
    api.sprayScratchPtr(),
    sprays.length * api.sprayScratchStride,
  );
  for (let i = 0; i < sprays.length; i++) {
    const spray = sprays[i];
    const base = i * api.sprayScratchStride;
    view[base + 0] = spray.source.id;
    view[base + 1] = spray.source.pos.x;
    view[base + 2] = spray.source.pos.y;
    view[base + 3] = spray.source.z ?? 0;
    view[base + 4] = spray.source.playerId;
    view[base + 5] = spray.target.id;
    view[base + 6] = spray.target.pos.x;
    view[base + 7] = spray.target.pos.y;
    view[base + 8] = spray.target.z ?? 0;
    view[base + 9] = spray.target.dim?.x ?? 0;
    view[base + 10] = spray.target.dim?.y ?? 0;
    view[base + 11] = spray.target.radius ?? 0;
    view[base + 12] = spray.intensity;
    view[base + 13] = spray.speed ?? 0;
    view[base + 14] = spray.particleRadius ?? 0;
    let flags = 0;
    if (spray.type === 'heal') flags |= 0x01;
    if (spray.source.z !== undefined) flags |= 0x02;
    if (spray.target.z !== undefined) flags |= 0x04;
    if (spray.target.dim !== undefined) flags |= 0x08;
    if (spray.target.radius !== undefined) flags |= 0x10;
    if (spray.speed !== undefined) flags |= 0x20;
    if (spray.particleRadius !== undefined) flags |= 0x40;
    view[base + 15] = flags;
  }
}

const AUDIO_EVENT_TYPE_CODES: Record<NetworkServerSnapshotSimEvent['type'], number> = {
  fire: 0,
  hit: 1,
  death: 2,
  laserStart: 3,
  laserStop: 4,
  forceFieldStart: 5,
  forceFieldStop: 6,
  forceFieldImpact: 7,
  ping: 8,
  attackAlert: 9,
  projectileExpire: 10,
};

const AUDIO_EVENT_SOURCE_TYPE_CODES: Record<string, number> = {
  turret: 0,
  unit: 1,
  building: 2,
  system: 3,
};

function packDeathContextsIntoScratch(
  sim: SimWasm,
  events: readonly NetworkServerSnapshotSimEvent[],
  stringSlots: Map<string, number>,
): void {
  const eventsWithDeath = events.filter((event) => event.deathContext !== undefined);
  if (eventsWithDeath.length === 0) return;

  const api = sim.snapshotEncode;
  api.deathContextScratchEnsure(eventsWithDeath.length);
  const view = new Float64Array(
    sim.memory.buffer,
    api.deathContextScratchPtr(),
    eventsWithDeath.length * api.deathContextScratchStride,
  );

  let totalPoses = 0;
  for (const event of eventsWithDeath) {
    totalPoses += event.deathContext?.turretPoses?.length ?? 0;
  }
  let poseView: Float64Array | undefined;
  if (totalPoses > 0) {
    api.turretPoseScratchEnsure(totalPoses);
    poseView = new Float64Array(
      sim.memory.buffer,
      api.turretPoseScratchPtr(),
      totalPoses * api.turretPoseScratchStride,
    );
  }

  let poseOffset = 0;
  for (let i = 0; i < eventsWithDeath.length; i++) {
    const context = eventsWithDeath[i].deathContext!;
    const base = i * api.deathContextScratchStride;
    view[base + 0] = context.unitVel.x;
    view[base + 1] = context.unitVel.y;
    view[base + 2] = context.hitDir.x;
    view[base + 3] = context.hitDir.y;
    view[base + 4] = context.projectileVel.x;
    view[base + 5] = context.projectileVel.y;
    view[base + 6] = context.attackMagnitude;
    view[base + 7] = context.radius;
    view[base + 8] = context.color;
    view[base + 9] = context.visualRadius ?? 0;
    view[base + 10] = context.pushRadius ?? 0;
    view[base + 11] = context.baseZ ?? 0;
    view[base + 12] = context.rotation ?? 0;
    view[base + 13] = context.unitType !== undefined
      ? stringSlots.get(context.unitType) ?? 0
      : 0;
    view[base + 14] = context.turretPoses?.length ?? 0;
    let flags = 0;
    if (context.visualRadius !== undefined) flags |= 0x01;
    if (context.pushRadius !== undefined) flags |= 0x02;
    if (context.baseZ !== undefined) flags |= 0x04;
    if (context.unitType !== undefined) flags |= 0x08;
    if (context.rotation !== undefined) flags |= 0x10;
    if (context.turretPoses !== undefined) flags |= 0x20;
    view[base + 15] = flags;

    if (context.turretPoses && poseView) {
      for (let p = 0; p < context.turretPoses.length; p++) {
        const pose = context.turretPoses[p];
        const poseBase = (poseOffset + p) * api.turretPoseScratchStride;
        poseView[poseBase + 0] = pose.rotation;
        poseView[poseBase + 1] = pose.pitch;
      }
      poseOffset += context.turretPoses.length;
    }
  }
}

function packImpactContextsIntoScratch(
  sim: SimWasm,
  events: readonly NetworkServerSnapshotSimEvent[],
): void {
  const eventsWithImpact = events.filter((event) => event.impactContext !== undefined);
  if (eventsWithImpact.length === 0) return;
  const api = sim.snapshotEncode;
  api.impactContextScratchEnsure(eventsWithImpact.length);
  const view = new Float64Array(
    sim.memory.buffer,
    api.impactContextScratchPtr(),
    eventsWithImpact.length * api.impactContextScratchStride,
  );
  for (let i = 0; i < eventsWithImpact.length; i++) {
    const context = eventsWithImpact[i].impactContext!;
    const base = i * api.impactContextScratchStride;
    view[base + 0] = context.collisionRadius;
    view[base + 1] = context.explosionRadius;
    view[base + 2] = context.projectile.pos.x;
    view[base + 3] = context.projectile.pos.y;
    view[base + 4] = context.projectile.vel.x;
    view[base + 5] = context.projectile.vel.y;
    view[base + 6] = context.entity.vel.x;
    view[base + 7] = context.entity.vel.y;
    view[base + 8] = context.entity.collisionRadius;
    view[base + 9] = context.penetrationDir.x;
    view[base + 10] = context.penetrationDir.y;
  }
}

function packAudioEventsIntoScratch(
  sim: SimWasm,
  events: readonly NetworkServerSnapshotSimEvent[],
  stringSlots: Map<string, number>,
): void {
  if (events.length === 0) return;
  const api = sim.snapshotEncode;
  api.audioEventScratchEnsure(events.length);
  const view = new Float64Array(
    sim.memory.buffer,
    api.audioEventScratchPtr(),
    events.length * api.audioEventScratchStride,
  );
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const base = i * api.audioEventScratchStride;
    view[base + 0] = AUDIO_EVENT_TYPE_CODES[event.type];
    view[base + 1] = event.pos.x;
    view[base + 2] = event.pos.y;
    view[base + 3] = event.pos.z;
    view[base + 4] = event.playerId ?? 0;
    view[base + 5] = event.entityId ?? 0;
    view[base + 6] = event.killerPlayerId ?? 0;
    view[base + 7] = event.victimPlayerId ?? 0;
    view[base + 8] = event.forceFieldImpact?.normal.x ?? 0;
    view[base + 9] = event.forceFieldImpact?.normal.y ?? 0;
    view[base + 10] = event.forceFieldImpact?.normal.z ?? 0;
    view[base + 11] = event.forceFieldImpact?.playerId ?? 0;
    view[base + 12] = event.sourceType ? AUDIO_EVENT_SOURCE_TYPE_CODES[event.sourceType] : 0;
    view[base + 13] = stringSlots.get(event.turretId) ?? 0;
    view[base + 14] = event.sourceKey !== undefined
      ? stringSlots.get(event.sourceKey) ?? 0
      : 0;
    let flags = 0;
    if (event.sourceType !== undefined) flags |= 0x001;
    if (event.sourceKey !== undefined) flags |= 0x002;
    if (event.playerId !== undefined) flags |= 0x004;
    if (event.entityId !== undefined) flags |= 0x008;
    if (event.forceFieldImpact !== undefined) flags |= 0x010;
    if (event.killerPlayerId !== undefined) flags |= 0x020;
    if (event.victimPlayerId !== undefined) flags |= 0x040;
    if (event.audioOnly !== undefined) {
      flags |= 0x080;
      if (event.audioOnly) flags |= 0x100;
    }
    if (event.deathContext !== undefined) flags |= 0x200;
    if (event.impactContext !== undefined) flags |= 0x400;
    view[base + 15] = flags;
  }
}

function emitAudioEvents(sim: SimWasm, events: readonly NetworkServerSnapshotSimEvent[]): void {
  const strings: string[] = [];
  for (const event of events) {
    strings.push(event.turretId);
    if (event.sourceKey !== undefined) strings.push(event.sourceKey);
    if (event.deathContext?.unitType !== undefined) strings.push(event.deathContext.unitType);
  }
  const stringSlots = packStringsIntoScratch(sim, strings);
  packAudioEventsIntoScratch(sim, events, stringSlots);
  packDeathContextsIntoScratch(sim, events, stringSlots);
  packImpactContextsIntoScratch(sim, events);
  sim.snapshotEncode.emitAudioEvents(events.length);
}

function canEncodeAudioEvents(events: readonly NetworkServerSnapshotSimEvent[]): boolean {
  for (const event of events) {
    if (AUDIO_EVENT_TYPE_CODES[event.type] === undefined) return false;
    if (
      event.sourceType !== undefined &&
      AUDIO_EVENT_SOURCE_TYPE_CODES[event.sourceType] === undefined
    ) {
      return false;
    }
  }
  return true;
}

function packProjSpawnsIntoScratch(
  sim: SimWasm,
  spawns: readonly NetworkServerSnapshotProjectileSpawn[],
): void {
  if (spawns.length === 0) return;
  const api = sim.snapshotEncode;
  api.projSpawnScratchEnsure(spawns.length);
  const view = new Float64Array(
    sim.memory.buffer,
    api.projSpawnScratchPtr(),
    spawns.length * api.projSpawnScratchStride,
  );
  for (let i = 0; i < spawns.length; i++) {
    const spawn = spawns[i];
    const base = i * api.projSpawnScratchStride;
    view[base + 0] = spawn.id;
    view[base + 1] = spawn.pos.x;
    view[base + 2] = spawn.pos.y;
    view[base + 3] = spawn.pos.z;
    view[base + 4] = spawn.rotation;
    view[base + 5] = spawn.velocity.x;
    view[base + 6] = spawn.velocity.y;
    view[base + 7] = spawn.velocity.z;
    view[base + 8] = spawn.projectileType;
    view[base + 9] = spawn.maxLifespan ?? 0;
    view[base + 10] = spawn.turretId;
    view[base + 11] = spawn.shotId ?? 0;
    view[base + 12] = spawn.sourceTurretId ?? 0;
    view[base + 13] = spawn.playerId;
    view[base + 14] = spawn.sourceEntityId;
    view[base + 15] = spawn.turretIndex;
    view[base + 16] = spawn.barrelIndex;
    view[base + 17] = spawn.beam?.start.x ?? 0;
    view[base + 18] = spawn.beam?.start.y ?? 0;
    view[base + 19] = spawn.beam?.start.z ?? 0;
    view[base + 20] = spawn.beam?.end.x ?? 0;
    view[base + 21] = spawn.beam?.end.y ?? 0;
    view[base + 22] = spawn.beam?.end.z ?? 0;
    view[base + 23] = spawn.targetEntityId ?? 0;
    view[base + 24] = spawn.homingTurnRate ?? 0;
    view[base + 25] = 0;
    let flags = 0;
    if (spawn.maxLifespan !== undefined) flags |= 0x01;
    if (spawn.shotId !== undefined) flags |= 0x02;
    if (spawn.sourceTurretId !== undefined) flags |= 0x04;
    if (spawn.isDGun === true) flags |= 0x08;
    if (spawn.fromParentDetonation === true) flags |= 0x10;
    if (spawn.beam !== undefined) flags |= 0x20;
    if (spawn.targetEntityId !== undefined) flags |= 0x40;
    if (spawn.homingTurnRate !== undefined) flags |= 0x80;
    view[base + 26] = flags;
  }
}

function packProjDespawnsIntoScratch(sim: SimWasm, ids: readonly number[]): void {
  if (ids.length === 0) return;
  const api = sim.snapshotEncode;
  api.projDespawnScratchEnsure(ids.length);
  const view = new Uint32Array(sim.memory.buffer, api.projDespawnScratchPtr(), ids.length);
  for (let i = 0; i < ids.length; i++) view[i] = ids[i];
}

function packProjVelocityUpdatesIntoScratch(
  sim: SimWasm,
  updates: NonNullable<SnapshotProjectiles['velocityUpdates']>,
): void {
  if (updates.length === 0) return;
  const api = sim.snapshotEncode;
  api.projVelScratchEnsure(updates.length);
  const view = new Float64Array(
    sim.memory.buffer,
    api.projVelScratchPtr(),
    updates.length * api.projVelScratchStride,
  );
  for (let i = 0; i < updates.length; i++) {
    const update = updates[i];
    const base = i * api.projVelScratchStride;
    view[base + 0] = update.id;
    view[base + 1] = update.pos.x;
    view[base + 2] = update.pos.y;
    view[base + 3] = update.pos.z;
    view[base + 4] = update.velocity.x;
    view[base + 5] = update.velocity.y;
    view[base + 6] = update.velocity.z;
  }
}

function packBeamUpdatesIntoScratch(
  sim: SimWasm,
  updates: readonly NetworkServerSnapshotBeamUpdate[],
): void {
  if (updates.length === 0) return;
  const api = sim.snapshotEncode;
  api.beamUpdateScratchEnsure(updates.length);
  let totalPoints = 0;
  for (const update of updates) totalPoints += update.points.length;
  if (totalPoints > 0) api.beamPointScratchEnsure(totalPoints);

  const headerView = new Float64Array(
    sim.memory.buffer,
    api.beamUpdateScratchPtr(),
    updates.length * api.beamUpdateScratchStride,
  );
  const pointView = totalPoints > 0
    ? new Float64Array(
        sim.memory.buffer,
        api.beamPointScratchPtr(),
        totalPoints * api.beamPointScratchStride,
      )
    : new Float64Array(0);

  let pointOffset = 0;
  for (let i = 0; i < updates.length; i++) {
    const update = updates[i];
    const headerBase = i * api.beamUpdateScratchStride;
    headerView[headerBase + 0] = update.id;
    let flags = 0;
    if (update.obstructionT !== undefined) flags |= 0x01;
    if (update.endpointDamageable === false) flags |= 0x02;
    headerView[headerBase + 1] = flags;
    headerView[headerBase + 2] = update.obstructionT ?? 0;
    headerView[headerBase + 3] = update.points.length;

    for (let p = 0; p < update.points.length; p++) {
      const point = update.points[p];
      const pointBase = (pointOffset + p) * api.beamPointScratchStride;
      pointView[pointBase + 0] = point.x;
      pointView[pointBase + 1] = point.y;
      pointView[pointBase + 2] = point.z;
      pointView[pointBase + 3] = point.vx;
      pointView[pointBase + 4] = point.vy;
      pointView[pointBase + 5] = point.vz;
      pointView[pointBase + 6] = point.ax;
      pointView[pointBase + 7] = point.ay;
      pointView[pointBase + 8] = point.az;
      let pointFlags = 0;
      if (point.mirrorEntityId !== undefined) pointFlags |= 0x01;
      if (point.reflectorKind !== undefined) {
        pointFlags |= 0x02;
        if (point.reflectorKind === 'forceField') pointFlags |= 0x04;
      }
      if (point.reflectorPlayerId !== undefined) pointFlags |= 0x08;
      if (point.normalX !== undefined) pointFlags |= 0x10;
      if (point.normalY !== undefined) pointFlags |= 0x20;
      if (point.normalZ !== undefined) pointFlags |= 0x40;
      pointView[pointBase + 9] = pointFlags;
      pointView[pointBase + 10] = point.mirrorEntityId ?? 0;
      pointView[pointBase + 11] = point.reflectorPlayerId ?? 0;
      pointView[pointBase + 12] = point.normalX ?? 0;
      pointView[pointBase + 13] = point.normalY ?? 0;
      pointView[pointBase + 14] = point.normalZ ?? 0;
    }
    pointOffset += update.points.length;
  }
}

function emitProjectiles(sim: SimWasm, projectiles: SnapshotProjectiles): void {
  const spawns = projectiles.spawns;
  const despawns = projectiles.despawns;
  const velocityUpdates = projectiles.velocityUpdates;
  const beamUpdates = projectiles.beamUpdates;
  if (spawns) packProjSpawnsIntoScratch(sim, spawns);
  if (despawns) packProjDespawnsIntoScratch(sim, despawns.map((despawn) => despawn.id));
  if (velocityUpdates) packProjVelocityUpdatesIntoScratch(sim, velocityUpdates);
  if (beamUpdates) packBeamUpdatesIntoScratch(sim, beamUpdates);
  sim.snapshotEncode.emitProjectiles(
    spawns !== undefined ? 1 : 0,
    spawns?.length ?? 0,
    despawns !== undefined ? 1 : 0,
    despawns?.length ?? 0,
    velocityUpdates !== undefined ? 1 : 0,
    velocityUpdates?.length ?? 0,
    beamUpdates !== undefined ? 1 : 0,
    beamUpdates?.length ?? 0,
  );
}

function canEncodeProjectiles(projectiles: SnapshotProjectiles): boolean {
  const spawns = projectiles.spawns;
  if (spawns) {
    for (const spawn of spawns) {
      if (spawn.isDGun === false || spawn.fromParentDetonation === false) return false;
    }
  }
  const beamUpdates = projectiles.beamUpdates;
  if (beamUpdates) {
    for (const beam of beamUpdates) {
      if (beam.endpointDamageable === true) return false;
    }
  }
  return true;
}

function packScanPulsesIntoScratch(
  sim: SimWasm,
  pulses: NonNullable<NetworkServerSnapshot['scanPulses']>,
): void {
  if (pulses.length === 0) return;
  const api = sim.snapshotEncode;
  api.scanPulseScratchEnsure(pulses.length);
  const view = new Float64Array(
    sim.memory.buffer,
    api.scanPulseScratchPtr(),
    pulses.length * api.scanPulseScratchStride,
  );
  for (let i = 0; i < pulses.length; i++) {
    const pulse = pulses[i];
    const base = i * api.scanPulseScratchStride;
    view[base + 0] = pulse.playerId;
    view[base + 1] = pulse.x;
    view[base + 2] = pulse.y;
    view[base + 3] = pulse.z;
    view[base + 4] = pulse.radius;
    view[base + 5] = pulse.expiresAtTick;
  }
}

function packShroudIntoScratch(sim: SimWasm, shroud: NonNullable<NetworkServerSnapshot['shroud']>): void {
  if (shroud.bitmap.length === 0) return;
  const api = sim.snapshotEncode;
  api.shroudScratchEnsure(shroud.bitmap.length);
  new Uint8Array(sim.memory.buffer, api.shroudScratchPtr(), shroud.bitmap.length)
    .set(shroud.bitmap);
}

function packCaptureIntoScratch(sim: SimWasm, capture: SnapshotCapture): void {
  if (capture.tiles.length === 0) return;
  let totalHeights = 0;
  for (const tile of capture.tiles) totalHeights += Object.keys(tile.heights).length;

  const api = sim.snapshotEncode;
  api.captureTileScratchEnsure(capture.tiles.length);
  if (totalHeights > 0) api.captureHeightScratchEnsure(totalHeights);
  const tileView = new Float64Array(
    sim.memory.buffer,
    api.captureTileScratchPtr(),
    capture.tiles.length * api.captureTileScratchStride,
  );
  const heightView = totalHeights > 0
    ? new Float64Array(
        sim.memory.buffer,
        api.captureHeightScratchPtr(),
        totalHeights * api.captureHeightScratchStride,
      )
    : new Float64Array(0);

  let heightOffset = 0;
  for (let i = 0; i < capture.tiles.length; i++) {
    const tile = capture.tiles[i];
    const tileBase = i * api.captureTileScratchStride;
    tileView[tileBase + 0] = tile.cx;
    tileView[tileBase + 1] = tile.cy;
    const playerIds = Object.keys(tile.heights).map(Number).sort((a, b) => a - b);
    tileView[tileBase + 2] = playerIds.length;
    for (let j = 0; j < playerIds.length; j++) {
      const heightBase = (heightOffset + j) * api.captureHeightScratchStride;
      heightView[heightBase + 0] = playerIds[j];
      heightView[heightBase + 1] = tile.heights[playerIds[j]];
    }
    heightOffset += playerIds.length;
  }
}

function packRemovedIdsIntoScratch(sim: SimWasm, ids: readonly number[]): void {
  if (ids.length === 0) return;
  const api = sim.snapshotEncode;
  api.removedIdsScratchEnsure(ids.length);
  const view = new Uint32Array(sim.memory.buffer, api.removedIdsScratchPtr(), ids.length);
  for (let i = 0; i < ids.length; i++) view[i] = ids[i];
}

export type RustSnapshotEncodeResult = {
  bytes: Uint8Array;
  rustEntityCount: number;
  rawEntityCount: number;
  rawTopLevelKeys: string[];
};

function emitRawKeyValue(api: SnapshotEncodeApi, key: string, value: unknown): void {
  api.emitRawKeyValue(key, msgpackEncode(value, SNAPSHOT_ENCODE_OPTIONS));
}

function emitTopLevelKey(
  sim: SimWasm,
  key: string,
  value: unknown,
  rawTopLevelKeys: string[],
): void {
  const api = sim.snapshotEncode;
  switch (key) {
    case 'minimapEntities': {
      const entries = value as NetworkServerSnapshotMinimapEntity[];
      packMinimapIntoScratch(sim, entries);
      api.emitMinimap(entries.length);
      return;
    }
    case 'economy': {
      const playerCount = packEconomyIntoScratch(
        sim,
        value as Record<number, NetworkServerSnapshotEconomy>,
      );
      api.emitEconomy(playerCount);
      return;
    }
    case 'serverMeta': {
      const meta = value as SnapshotServerMeta;
      if (!canEncodeServerMeta(meta)) {
        rawTopLevelKeys.push(key);
        emitRawKeyValue(api, key, value);
        return;
      }
      emitServerMeta(sim, meta);
      return;
    }
    case 'sprayTargets': {
      const sprays = value as NetworkServerSnapshotSprayTarget[];
      packSprayTargetsIntoScratch(sim, sprays);
      api.emitSprayTargets(sprays.length);
      return;
    }
    case 'audioEvents': {
      const events = value as NetworkServerSnapshotSimEvent[];
      if (!canEncodeAudioEvents(events)) {
        rawTopLevelKeys.push(key);
        emitRawKeyValue(api, key, value);
        return;
      }
      emitAudioEvents(sim, events);
      return;
    }
    case 'projectiles': {
      const projectiles = value as SnapshotProjectiles;
      if (!canEncodeProjectiles(projectiles)) {
        rawTopLevelKeys.push(key);
        emitRawKeyValue(api, key, value);
        return;
      }
      emitProjectiles(sim, projectiles);
      return;
    }
    case 'scanPulses': {
      const pulses = value as NonNullable<NetworkServerSnapshot['scanPulses']>;
      packScanPulsesIntoScratch(sim, pulses);
      api.emitScanPulses(pulses.length);
      return;
    }
    case 'shroud': {
      const shroud = value as NonNullable<NetworkServerSnapshot['shroud']>;
      packShroudIntoScratch(sim, shroud);
      api.emitShroud(shroud.gridW, shroud.gridH, shroud.cellSize, shroud.bitmap.length);
      return;
    }
    case 'capture': {
      const capture = value as SnapshotCapture;
      packCaptureIntoScratch(sim, capture);
      api.emitCapture(capture.tiles.length, capture.cellSize);
      return;
    }
    default:
      rawTopLevelKeys.push(key);
      emitRawKeyValue(api, key, value);
  }
}

function emitEnvelopeTail(
  sim: SimWasm,
  state: NetworkServerSnapshot,
  keys: readonly string[],
  startIndex: number,
): number {
  const api = sim.snapshotEncode;
  let index = startIndex;
  let hasGameState = 0;
  let gameStatePhaseSlot = 0;
  let hasWinnerId = 0;
  let winnerId = 0;

  if (keys[index] === 'gameState') {
    const gameState = state.gameState;
    if (
      gameState === undefined ||
      typeof gameState.phase !== 'string' ||
      (gameState.winnerId !== undefined && !isUint(gameState.winnerId, 0xFF))
    ) {
      return startIndex;
    }
    const stringSlots = packStringsIntoScratch(sim, [gameState.phase]);
    gameStatePhaseSlot = stringSlots.get(gameState.phase) ?? 0;
    hasGameState = 1;
    if (gameState.winnerId !== undefined) {
      hasWinnerId = 1;
      winnerId = gameState.winnerId;
    }
    index++;
  }

  if (keys[index] !== 'isDelta' || typeof state.isDelta !== 'boolean') return startIndex;
  index++;

  let hasRemovedEntityIds = 0;
  let removedEntityIdCount = 0;
  if (keys[index] === 'removedEntityIds') {
    const ids = state.removedEntityIds;
    if (ids === undefined) return startIndex;
    for (let i = 0; i < ids.length; i++) {
      if (!isUint(ids[i], 0xFFFF_FFFF)) return startIndex;
    }
    packRemovedIdsIntoScratch(sim, ids);
    hasRemovedEntityIds = 1;
    removedEntityIdCount = ids.length;
    index++;
  }

  let hasVisibilityFiltered = 0;
  let visibilityFiltered = 0;
  if (keys[index] === 'visibilityFiltered') {
    if (typeof state.visibilityFiltered !== 'boolean') return startIndex;
    hasVisibilityFiltered = 1;
    visibilityFiltered = state.visibilityFiltered ? 1 : 0;
    index++;
  }

  api.envelopeContinue(
    hasGameState,
    gameStatePhaseSlot,
    hasWinnerId,
    winnerId,
    state.isDelta ? 1 : 0,
    hasRemovedEntityIds,
    removedEntityIdCount,
    hasVisibilityFiltered,
    visibilityFiltered,
  );
  return index;
}

export function encodeNetworkSnapshotWithRustFallback(
  state: NetworkServerSnapshot,
): RustSnapshotEncodeResult | null {
  const sim = getSimWasm();
  if (!sim) return null;

  const keys = Object.keys(state).filter((key) => hasValue((state as Record<string, unknown>)[key]));
  if (keys[0] !== 'tick' || keys[1] !== 'entities') return null;

  const api = sim.snapshotEncode;
  api.envelopeBegin(state.tick, state.entities.length, keys.length);

  let rustEntityCount = 0;
  let rawEntityCount = 0;
  for (const entity of state.entities) {
    if (encodeEntity(sim, entity)) {
      rustEntityCount++;
    } else {
      rawEntityCount++;
      api.appendRawValue(msgpackEncode(entity, SNAPSHOT_ENCODE_OPTIONS));
    }
  }

  const rawTopLevelKeys: string[] = [];
  for (let i = 2; i < keys.length; i++) {
    const key = keys[i];
    if (key === 'gameState' || key === 'isDelta') {
      const nextIndex = emitEnvelopeTail(sim, state, keys, i);
      if (nextIndex !== i) {
        i = nextIndex - 1;
        continue;
      }
    }
    emitTopLevelKey(sim, key, (state as Record<string, unknown>)[key], rawTopLevelKeys);
  }

  const bytes = new Uint8Array(
    sim.memory.buffer,
    api.writerPtr(),
    api.writerLen(),
  ).slice();
  return { bytes, rustEntityCount, rawEntityCount, rawTopLevelKeys };
}
