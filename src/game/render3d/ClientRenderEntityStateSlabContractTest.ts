import {
  ENTITY_CHANGED_HP,
  ENTITY_CHANGED_POS,
  buildingBlueprintIdToCode,
  unitBlueprintIdToCode,
} from '../../types/network';
import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotEntity,
} from '../network/NetworkTypes';
import { ClientViewState } from '../network/ClientViewState';
import { quantizeEntityPosition as qEntityPos } from '../network/snapshotQuantization';
import { createUnitFromBlueprintEntity } from '../sim/WorldUnitFactory';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import type { WorldSupportSurface } from '../sim/supportSurface';
import { type FootprintBounds, ViewportFootprint } from '../ViewportFootprint';
import {
  CLIENT_RENDER_ENTITY_FLAG_ACTIVE_PREDICTION,
  CLIENT_RENDER_ENTITY_FLAG_LIFECYCLE_DIRTY,
  CLIENT_RENDER_ENTITY_FLAG_RENDER_DIRTY,
  ClientRenderEntityStateSlab,
} from './ClientRenderEntityStateSlab';
import {
  CLIENT_RENDER_TURRET_FLAG_SHIELD_FIELD,
  ClientRenderTurretStateSlab,
} from './ClientRenderTurretStateSlab';
import {
  entityLodProxyGlyph3D,
  entityLodProxyRadius3D,
} from './EntityLod3D';
import {
  BuildingRenderPacket3D,
  UnitRenderPacket3D,
} from './EntityRenderPackets3D';
import { BodyHudRenderPacket3D } from './HealthBar3D';
import { PieceNameRenderPacket3D } from './NameLabel3D';
import { ShieldRenderPacket3D } from './ShieldRenderer3D';
import { ContactShadowRenderPacket3D } from './ContactShadowRenderer3D';
import { GroundPrintRenderPacket3D } from './GroundPrint3D';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[client render entity state contract] ${message}`);
  }
}

const FLAT_SUPPORT: WorldSupportSurface = {
  groundZ: 0,
  normalX: 0,
  normalY: 0,
  normalZ: 1,
  supportEntityId: null,
  supportKind: 'terrain',
  materialKind: 'solid',
  supportVelocityX: 0,
  supportVelocityY: 0,
  supportVelocityZ: 0,
  walkable: true,
  sourceKey: 0,
};

function emptyUnitSnapshot(): NonNullable<NetworkServerSnapshotEntity['unit']> {
  return {
    hp: null,
    velocity: null,
    radius: null,
    mass: null,
    bodyCenterHeight: null,
    unitBlueprintCode: null,
    isCommander: null,
    surfaceNormal: null,
    orientation: null,
    angularVelocity3: null,
    fireEnabled: null,
    fireState: null,
    trajectoryMode: null,
    repeatQueue: null,
    moveState: null,
    holdPosition: null,
    wantCloak: null,
    cloaked: null,
    buildTargetId: null,
    buildTargetIdPresent: false,
    actions: null,
    turrets: null,
    build: null,
  };
}

function snapshot(
  tick: number,
  entities: NetworkServerSnapshotEntity[],
): NetworkServerSnapshot {
  return {
    tick,
    entities,
    entityDeltaOnly: undefined,
    projectileDeltaOnly: undefined,
    minimapEntities: undefined,
    economy: {},
    resourceMovements: undefined,
    sprayTargets: undefined,
    audioEvents: undefined,
    scanPulses: undefined,
    shroud: undefined,
    projectiles: undefined,
    gameState: undefined,
    serverMeta: undefined,
    grid: undefined,
    terrain: undefined,
    buildability: undefined,
    visibilityFiltered: undefined,
    visionPlayerMask: undefined,
    removedEntityIds: undefined,
  };
}

function entityDeltaSnapshot(
  tick: number,
  entities: NetworkServerSnapshotEntity[],
): NetworkServerSnapshot {
  return {
    ...snapshot(tick, entities),
    entityDeltaOnly: true,
  };
}

function fullUnitEntity(
  id: number,
  hp: number,
  maxHp: number,
  x = 0,
  y = 0,
  z = 0,
): NetworkServerSnapshotEntity {
  return {
    id,
    type: 'unit',
    playerId: 1 as PlayerId,
    changedFields: null,
    pos: { x: qEntityPos(x), y: qEntityPos(y), z: qEntityPos(z) },
    rotation: 0,
    unit: {
      ...emptyUnitSnapshot(),
      unitBlueprintCode: unitBlueprintIdToCode('unitJackal'),
      hp: { curr: hp, max: maxHp },
      velocity: { x: 0, y: 0, z: 0 },
      surfaceNormal: { nx: 0, ny: 0, nz: 1000 },
    },
    building: null,
  };
}

function hpSparseUnitEntity(id: number, hp: number, maxHp: number): NetworkServerSnapshotEntity {
  return {
    id,
    type: 'unit',
    playerId: 1 as PlayerId,
    changedFields: ENTITY_CHANGED_HP,
    pos: null,
    rotation: null,
    unit: {
      ...emptyUnitSnapshot(),
      hp: { curr: hp, max: maxHp },
    },
    building: null,
  };
}

function fullBuildingEntity(
  id: number,
  hp: number,
  maxHp: number,
  x = 0,
  y = 0,
  z = 0,
): NetworkServerSnapshotEntity {
  return {
    id,
    type: 'building',
    playerId: 2 as PlayerId,
    changedFields: null,
    pos: { x: qEntityPos(x), y: qEntityPos(y), z: qEntityPos(z) },
    rotation: 0,
    unit: null,
    building: {
      buildingBlueprintCode: buildingBlueprintIdToCode('buildingSolar'),
      dim: null,
      hp: { curr: hp, max: maxHp },
      build: null,
      metalExtractionRate: null,
      solar: null,
      turrets: null,
      factory: null,
    },
  };
}

function posSparseBuildingEntity(
  id: number,
  x: number,
  y: number,
  z: number,
): NetworkServerSnapshotEntity {
  return {
    id,
    type: 'building',
    playerId: 2 as PlayerId,
    changedFields: ENTITY_CHANGED_POS,
    pos: { x: qEntityPos(x), y: qEntityPos(y), z: qEntityPos(z) },
    rotation: null,
    unit: null,
    building: null,
  };
}

function createTestUnit(id: number, playerId: PlayerId, unitBlueprintId = 'unitJackal') {
  let nextEntityId = id;
  const entity = createUnitFromBlueprintEntity(
    {
      generateEntityId: () => nextEntityId++,
      sampleSupportSurface: () => FLAT_SUPPORT,
    },
    10,
    20,
    playerId,
    unitBlueprintId,
    { allocateSubEntityIds: false },
  );
  entity.id = id;
  return entity;
}

function scopeFromBounds(bounds: FootprintBounds): ViewportFootprint {
  return {
    getMode: () => 'window',
    getCullingBounds: (padding = 0): FootprintBounds => ({
      minX: bounds.minX - padding,
      minY: bounds.minY - padding,
      maxX: bounds.maxX + padding,
      maxY: bounds.maxY + padding,
    }),
    inScope: (x: number, y: number, padding = 0): boolean => (
      x + padding >= bounds.minX &&
      x - padding <= bounds.maxX &&
      y + padding >= bounds.minY &&
      y - padding <= bounds.maxY
    ),
  } as ViewportFootprint;
}

function allScope(): ViewportFootprint {
  return {
    getMode: () => 'all',
    getCullingBounds: (): FootprintBounds => {
      throw new Error('all-scope authoritative slot packets must not request culling bounds');
    },
    inScope: () => true,
  } as unknown as ViewportFootprint;
}

function collectMinimalBuildingRenderPacket(view: ClientViewState): BuildingRenderPacket3D {
  const buildingRows = new BuildingRenderPacket3D();
  view.prepareRenderEntityPackets3D(
    {
      unitRows: new UnitRenderPacket3D(),
      buildingRows,
      bodyHud: new BodyHudRenderPacket3D(),
      shields: new ShieldRenderPacket3D(),
      pieceNames: new PieceNameRenderPacket3D(),
      contactShadows: new ContactShadowRenderPacket3D(),
      groundPrints: new GroundPrintRenderPacket3D(),
    },
    {
      renderScope: new ViewportFootprint(),
      includeBodyHud: false,
      includeBodyNames: false,
      includeShields: false,
      includeContactShadows: false,
      includeGroundPrints: false,
      hoveredEntity: null,
      scopedUnitsOut: [],
      scopedBuildingsOut: [],
      selectionHudMode: 'whenNotFull',
      getEntityHudToggle: () => false,
      lookupPlayerName: () => null,
      getGroundPrintLocomotionMesh: () => undefined,
    },
  );
  return buildingRows;
}

export function runClientRenderEntityStateSlabContractTest(): void {
  const slab = new ClientRenderEntityStateSlab();
  const turretSlab = new ClientRenderTurretStateSlab();
  const unit = createTestUnit(10, 2 as PlayerId);
  if (unit.unit === null) {
    throw new Error('[client render entity state contract] test unit must have a unit component');
  }
  unit.selectable!.selected = true;
  unit.transform.x = 123;
  unit.transform.y = 456;
  unit.transform.z = 21;
  unit.transform.rotation = 0.75;
  unit.unit.velocityX = 9;
  unit.unit.velocityY = -4;
  unit.unit.hp = 33;
  unit.unit.maxHp = 44;

  const slot = slab.refreshUnit(unit);
  assertContract(slot !== undefined, 'unit refresh must allocate a slot');
  const turretRows = turretSlab.refreshHost(unit, slot!);
  slab.assertParity(unit);
  turretSlab.assertParity(unit, slot!);
  assertContract(turretRows !== undefined, 'unit turret refresh must expose host rows');
  assertContract(turretRows!.count === unit.combat!.turrets.length, 'turret rows must match combat turret count');
  const firstTurretRow = turretRows!.start;
  assertContract(
    turretRows!.views.rotation[firstTurretRow] === Math.fround(unit.combat!.turrets[0].rotation),
    'turret rotation must be stored in typed rows',
  );

  const packet = new UnitRenderPacket3D();
  packet.pushEntityState(unit, slab.getViews(), slot!, turretSlab, true, true, true, false);
  assertContract(packet.count === 1, 'packet must accept a unit slab row');
  assertContract(packet.lodProxyCount === 0, 'full-detail packet must not count LOD proxy rows');
  assertContract(packet.turretStateAt(0)?.count === unit.combat!.turrets.length, 'packet must expose turret state rows');
  assertContract(packet.entityIdAt(0) === unit.id, 'packet id must come from the slab row');
  assertContract(packet.ownerIdAt(0) === 2, 'packet owner must come from the slab row');
  assertContract(packet.selectedAt(0), 'packet selected flag must come from slab flags');
  assertContract(packet.activePredictionAt(0), 'packet active-prediction bit must be composed');
  assertContract(packet.renderDirtyAt(0), 'packet render-dirty bit must be composed');
  assertContract(packet.lifecycleDirtyAt(0), 'packet lifecycle-dirty bit must be composed');
  assertContract(packet.x[0] === Math.fround(unit.transform.x), 'packet x must match slab x');
  assertContract(packet.velocityX[0] === Math.fround(unit.unit.velocityX), 'packet velocity must match slab velocity');
  assertContract(
    packet.lodProxyRadius[0] === Math.fround(entityLodProxyRadius3D(unit)),
    'packet LOD proxy radius must come from the slab row',
  );
  assertContract(
    packet.lodProxyGlyph[0] === entityLodProxyGlyph3D(unit),
    'packet LOD proxy glyph must come from the slab row',
  );
  const lodProxyPacket = new UnitRenderPacket3D();
  lodProxyPacket.pushEntityState(unit, slab.getViews(), slot!, turretSlab, false, false, false, true);
  assertContract(lodProxyPacket.count === 1, 'LOD proxy packet must accept a unit slab row');
  assertContract(lodProxyPacket.lodProxyCount === 1, 'LOD proxy packet must count proxy rows');
  assertContract(lodProxyPacket.lodProxyAt(0), 'LOD proxy packet must carry the proxy bit');
  assertContract(lodProxyPacket.entityAt(0) === undefined, 'LOD proxy packet must not retain an entity object');
  assertContract(lodProxyPacket.turretStateAt(0) === undefined, 'LOD proxy packet must skip turret rows');
  assertContract(
    lodProxyPacket.lodProxyRadius[0] === Math.fround(entityLodProxyRadius3D(unit)),
    'LOD proxy packet radius must come from typed slab state',
  );
  assertContract(
    lodProxyPacket.lodProxyGlyph[0] === entityLodProxyGlyph3D(unit),
    'LOD proxy packet glyph must come from typed slab state',
  );
  const directLodProxyPacket = new UnitRenderPacket3D();
  directLodProxyPacket.pushLodProxyState(slab.getViews(), slot!);
  assertContract(directLodProxyPacket.count === 1, 'direct LOD proxy packet must accept a unit slab row');
  assertContract(directLodProxyPacket.lodProxyCount === 1, 'direct LOD proxy packet must count proxy rows');
  assertContract(directLodProxyPacket.lodProxyAt(0), 'direct LOD proxy packet must carry the proxy bit');
  assertContract(
    directLodProxyPacket.entityAt(0) === undefined,
    'direct LOD proxy packet must not retain an entity object',
  );

  const slabFlagPacket = new UnitRenderPacket3D();
  slab.clearPacketFlags();
  slab.markPacketFlags(
    slot!,
    CLIENT_RENDER_ENTITY_FLAG_ACTIVE_PREDICTION |
      CLIENT_RENDER_ENTITY_FLAG_RENDER_DIRTY |
      CLIENT_RENDER_ENTITY_FLAG_LIFECYCLE_DIRTY,
  );
  slabFlagPacket.pushEntityState(unit, slab.getViews(), slot!, turretSlab, false, false, false, false);
  assertContract(slabFlagPacket.activePredictionAt(0), 'packet active-prediction bit must come from slab flags');
  assertContract(slabFlagPacket.renderDirtyAt(0), 'packet render-dirty bit must come from slab flags');
  assertContract(slabFlagPacket.lifecycleDirtyAt(0), 'packet lifecycle-dirty bit must come from slab flags');
  slab.clearPacketFlags();
  const clearedPacket = new UnitRenderPacket3D();
  clearedPacket.pushEntityState(unit, slab.getViews(), slot!, turretSlab, false, false, false, false);
  assertContract(!clearedPacket.activePredictionAt(0), 'packet active-prediction slab flag must clear');
  assertContract(!clearedPacket.renderDirtyAt(0), 'packet render-dirty slab flag must clear');
  assertContract(!clearedPacket.lifecycleDirtyAt(0), 'packet lifecycle-dirty slab flag must clear');

  unit.transform.x = 321;
  unit.transform.y = 654;
  unit.transform.z = 12;
  unit.transform.rotation = 1.2;
  unit.unit.velocityX = 7;
  unit.unit.velocityY = 8;
  unit.unit.bodyCenterHeight = 19;
  unit.unit.surfaceNormal.nx = 0.2;
  unit.unit.surfaceNormal.ny = 0.3;
  unit.unit.surfaceNormal.nz = 0.93;
  const poseRefresh = { slot: undefined as number | undefined, changed: false, spatialChanged: false };
  slab.refreshAuthoritativeUnitPose(
    unit,
    {
      groundY: 4.5,
      bodyOpacity: 0.42,
      bodyCenterHeight: 19,
    },
    poseRefresh,
  );
  assertContract(poseRefresh.slot === slot, 'authoritative unit pose refresh must reuse the existing slot');
  assertContract(poseRefresh.changed, 'authoritative unit pose refresh must report changed state');
  assertContract(poseRefresh.spatialChanged, 'authoritative unit pose refresh must report spatial changes');
  const poseViews = slab.getViews();
  assertContract(poseViews.x[slot!] === Math.fround(321), 'authoritative unit pose must update x');
  assertContract(poseViews.groundY[slot!] === Math.fround(4.5), 'authoritative unit pose must update groundY');
  assertContract(poseViews.bodyOpacity[slot!] === Math.fround(0.42), 'authoritative unit pose must update body opacity');
  assertContract(poseViews.velocityX[slot!] === Math.fround(7), 'authoritative unit pose must update velocity');
  assertContract(poseViews.unitBlueprintIds[slot!] === 'unitJackal', 'authoritative unit pose must preserve metadata');
  slab.refreshAuthoritativeUnitPose(
    unit,
    {
      groundY: 4.5,
      bodyOpacity: 0.42,
      bodyCenterHeight: 19,
    },
    poseRefresh,
  );
  assertContract(!poseRefresh.changed, 'unchanged authoritative unit pose refresh must report no change');
  assertContract(!poseRefresh.spatialChanged, 'unchanged authoritative unit pose refresh must not reindex spatial state');

  const proxyVelocityXBefore = poseViews.velocityX[slot!];
  const proxyNormalXBefore = poseViews.normalX[slot!];
  const proxyGroundYBefore = poseViews.groundY[slot!];
  slab.refreshAuthoritativeUnitProxyPoseSlot(
    slot!,
    { x: 333, y: 444, z: 55 },
    poseRefresh,
  );
  assertContract(poseRefresh.slot === slot, 'authoritative proxy pose refresh must reuse the existing slot');
  assertContract(poseRefresh.changed, 'authoritative proxy pose refresh must report position changes');
  assertContract(poseRefresh.spatialChanged, 'authoritative proxy pose refresh must report xy spatial changes');
  assertContract(poseViews.x[slot!] === Math.fround(333), 'authoritative proxy pose must update x');
  assertContract(poseViews.y[slot!] === Math.fround(444), 'authoritative proxy pose must update y');
  assertContract(poseViews.z[slot!] === Math.fround(55), 'authoritative proxy pose must update z');
  assertContract(
    poseViews.velocityX[slot!] === proxyVelocityXBefore,
    'authoritative proxy pose must not update velocity',
  );
  assertContract(
    poseViews.normalX[slot!] === proxyNormalXBefore,
    'authoritative proxy pose must not update normals',
  );
  assertContract(
    poseViews.groundY[slot!] === proxyGroundYBefore,
    'authoritative proxy pose must not update groundY',
  );

  const previousHeadRadius = turretRows!.views.headRadius[firstTurretRow];
  unit.combat!.turrets[0].rotation = 1.4;
  unit.combat!.turrets[0].pitch = 0.25;
  const turretPoseRefresh = { rows: undefined as typeof turretRows, changed: false };
  turretSlab.refreshHostPose(unit, slot!, turretPoseRefresh);
  const poseTurretRows = turretPoseRefresh.rows;
  assertContract(turretPoseRefresh.changed, 'turret pose refresh must report changed rows');
  assertContract(poseTurretRows?.start === turretRows!.start, 'turret pose refresh must keep the same row span');
  assertContract(
    poseTurretRows!.views.rotation[firstTurretRow] === Math.fround(1.4),
    'turret pose refresh must update rotation',
  );
  assertContract(
    poseTurretRows!.views.pitch[firstTurretRow] === Math.fround(0.25),
    'turret pose refresh must update pitch',
  );
  assertContract(
    poseTurretRows!.views.headRadius[firstTurretRow] === previousHeadRadius,
    'turret pose refresh must preserve static turret metadata',
  );
  turretSlab.refreshHostPose(unit, slot!, turretPoseRefresh);
  assertContract(!turretPoseRefresh.changed, 'unchanged turret pose refresh must report no change');

  slab.unsetEntity(unit.id);
  assertContract(slab.getSlot(unit.id) === undefined, 'unset must remove id-to-slot mapping');
  const reusedUnit = createTestUnit(11, 3 as PlayerId);
  const reusedSlot = slab.refreshUnit(reusedUnit);
  turretSlab.refreshHost(reusedUnit, reusedSlot!);
  assertContract(reusedSlot === slot, 'freed slots must be reused for stable bounded slabs');
  const missingIds: EntityId[] = [];
  slab.collectEntityIdsMissingFrom(new Set<EntityId>(), missingIds);
  assertContract(
    missingIds.length === 1 && missingIds[0] === reusedUnit.id,
    'missing-id collection must report live render rows',
  );
  slab.collectEntityIdsMissingFrom(new Set<EntityId>([reusedUnit.id]), missingIds);
  assertContract(missingIds.length === 0, 'missing-id collection must honor present ids');
  const highIdUnit = createTestUnit(1_000_005, 3 as PlayerId);
  slab.refreshUnit(highIdUnit);
  slab.collectEntityIdsMissingFromTypedWireRows(
    new Float64Array([reusedUnit.id, 0]),
    1,
    2,
    new Float64Array([highIdUnit.id, 0, 0]),
    1,
    3,
    new Float64Array(0),
    0,
    1,
    missingIds,
  );
  assertContract(missingIds.length === 0, 'typed-row missing-id collection must honor indexed and fallback ids');
  slab.collectEntityIdsMissingFromTypedWireRows(
    new Float64Array([reusedUnit.id, 0]),
    1,
    2,
    new Float64Array(0),
    0,
    1,
    new Float64Array(0),
    0,
    1,
    missingIds,
  );
  assertContract(
    missingIds.length === 1 && missingIds[0] === highIdUnit.id,
    'typed-row missing-id collection must report fallback ids absent from typed rows',
  );
  slab.collectEntityIdsMissingFromTypedWireRows(
    new Float64Array([reusedUnit.id, 0]),
    1,
    2,
    new Float64Array([reusedUnit.id, 0, 0]),
    1,
    3,
    new Float64Array(0),
    0,
    1,
    missingIds,
  );
  assertContract(
    missingIds.length === 1 && missingIds[0] === highIdUnit.id,
    'typed-row missing-id fast path must not hide duplicate incoming ids',
  );

  const shieldUnit = createTestUnit(12, 4 as PlayerId, 'unitDaddy');
  const shieldSlot = slab.refreshUnit(shieldUnit);
  assertContract(shieldSlot !== undefined, 'shield unit must allocate a render slot');
  const shieldTurretIndex = shieldUnit.combat!.turrets.findIndex((turret) =>
    turret.config.shot?.type === 'shield' && turret.config.shot.barrier !== undefined);
  assertContract(shieldTurretIndex >= 0, 'test shield unit must have a shield barrier turret');
  const shieldTurret = shieldUnit.combat!.turrets[shieldTurretIndex];
  shieldTurret.rotation = 0.5;
  shieldTurret.pitch = 0.1;
  shieldTurret.shield = { transition: 1, range: 0.75, onTimeMs: 100 };
  const shieldRows = turretSlab.refreshHost(shieldUnit, shieldSlot!);
  turretSlab.assertParity(shieldUnit, shieldSlot!);
  const shieldRow = shieldRows!.start + shieldTurretIndex;
  assertContract(
    (shieldRows!.views.flags[shieldRow] & CLIENT_RENDER_TURRET_FLAG_SHIELD_FIELD) !== 0,
    'shield turret row must carry the shield-field flag',
  );
  const shieldPacket = new ShieldRenderPacket3D();
  const wideScope = scopeFromBounds({ minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 });
  shieldPacket.pushUnitTurretState(slab.getViews(), shieldSlot!, shieldRows, wideScope);
  assertContract(shieldPacket.count === 1, 'shield packet must materialize from turret state rows');
  assertContract(shieldPacket.hostIds[0] === shieldUnit.id, 'shield packet host id must come from slab state');
  assertContract(shieldPacket.turretIndices[0] === shieldTurretIndex, 'shield packet turret index must match typed row');
  assertContract(shieldPacket.progress[0] === Math.fround(0.75), 'shield packet progress must come from typed shield range');

  const view = new ClientViewState();
  view.applyNetworkState(snapshot(1, [fullUnitEntity(77, 60, 100), fullBuildingEntity(88, 50, 200)]));
  assertContract(view.getRenderEntityStateSlot(77) !== undefined, 'full unit snapshot must populate render slab');
  assertContract(view.getRenderEntityStateSlot(88) !== undefined, 'full building snapshot must populate render slab');
  view.assertRenderEntityStateParity(77);
  view.assertRenderEntityStateParity(88);

  const authoritativeBuilding = view.getBuildings().find((entity) => entity.id === 88);
  assertContract(authoritativeBuilding !== undefined, 'snapshot building must be available for authoritative refresh');
  authoritativeBuilding!.transform.x = 22;
  authoritativeBuilding!.transform.y = 33;
  authoritativeBuilding!.transform.z = 44;
  view.refreshAuthoritativeRenderEntityState3D(authoritativeBuilding!, {
    kind: 'building',
    x: authoritativeBuilding!.transform.x,
    y: authoritativeBuilding!.transform.y,
    rotation: authoritativeBuilding!.transform.rotation,
    combatCenterZ: 66,
    baseY: 11,
    progress: 0.37,
    bodyOpacity: 0.64,
    turrets: authoritativeBuilding!.combat?.turrets,
  });
  const authoritativeBuildingRows = collectMinimalBuildingRenderPacket(view);
  let authoritativeBuildingRow = -1;
  for (let row = 0; row < authoritativeBuildingRows.count; row++) {
    if (authoritativeBuildingRows.entityIdAt(row) === 88) authoritativeBuildingRow = row;
  }
  assertContract(authoritativeBuildingRow >= 0, 'authoritative building refresh must keep the building renderable');
  assertContract(
    authoritativeBuildingRows.x[authoritativeBuildingRow] === Math.fround(22),
    'authoritative building refresh must update packet x',
  );
  assertContract(
    authoritativeBuildingRows.z[authoritativeBuildingRow] === Math.fround(66),
    'authoritative building refresh must update combat center z',
  );
  assertContract(
    authoritativeBuildingRows.baseY[authoritativeBuildingRow] === Math.fround(11),
    'authoritative building refresh must update baseY',
  );
  assertContract(
    authoritativeBuildingRows.progress[authoritativeBuildingRow] === Math.fround(0.37),
    'authoritative building refresh must carry interpolated construction progress',
  );
  assertContract(
    authoritativeBuildingRows.bodyOpacity[authoritativeBuildingRow] === Math.fround(0.64),
    'authoritative building refresh must carry interpolated body opacity',
  );
  assertContract(
    authoritativeBuildingRows.renderDirtyAt(authoritativeBuildingRow),
    'authoritative construction building refresh must queue a render-dirty packet row',
  );

  view.applyNetworkState(snapshot(2, [hpSparseUnitEntity(77, 80, 100)]));
  view.assertRenderEntityStateParity(77);

  view.selectEntity(77);
  view.assertRenderEntityStateParity(77);

  view.applyNetworkState(snapshot(3, []));
  assertContract(view.getRenderEntityStateSlot(77) === undefined, 'full reconciliation must remove unit slab row');
  assertContract(view.getRenderEntityStateSlot(88) === undefined, 'full reconciliation must remove building slab row');

  const scopedView = new ClientViewState();
  scopedView.applyNetworkState(snapshot(1, [
    fullUnitEntity(101, 100, 100, 100, 100),
    fullBuildingEntity(202, 200, 200, 1200, 100),
  ]));
  const units: Entity[] = [];
  const buildings: Entity[] = [];
  const nearBounds: FootprintBounds = { minX: 0, minY: 0, maxX: 400, maxY: 400 };
  scopedView.collectScopedRenderEntities(
    nearBounds,
    units,
    buildings,
    null,
    scopeFromBounds(nearBounds),
  );
  assertContract(units.length === 1 && units[0].id === 101, 'slot-backed scoped query returns the nearby unit');
  assertContract(buildings.length === 0, 'slot-backed scoped query excludes distant building');

  scopedView.applyNetworkState(entityDeltaSnapshot(2, [posSparseBuildingEntity(202, 180, 100, 0)]));
  scopedView.collectScopedRenderEntities(
    nearBounds,
    units,
    buildings,
    null,
    scopeFromBounds(nearBounds),
  );
  assertContract(buildings.length === 1 && buildings[0].id === 202, 'position delta must reindex building rows');

  const wideBounds: FootprintBounds = { minX: 0, minY: 0, maxX: 1500, maxY: 400 };
  scopedView.collectScopedRenderEntities(
    wideBounds,
    units,
    buildings,
    null,
    scopeFromBounds(wideBounds),
  );
  assertContract(units.length === 1 && units[0].id === 101, 'slot-backed wide query keeps unit rows');
  assertContract(buildings.length === 1 && buildings[0].id === 202, 'slot-backed wide query resolves building rows');

  const localAuthoritativeView = new ClientViewState();
  localAuthoritativeView.applyNetworkState(snapshot(1, [
    fullUnitEntity(301, 100, 100, 100, 100),
    fullUnitEntity(302, 100, 100, 1400, 100),
  ]));
  const localAuthoritativeUnitRows = new UnitRenderPacket3D();
  let localAuthoritativeHookCalls = 0;
  localAuthoritativeView.prepareRenderEntityPackets3D(
    {
      unitRows: localAuthoritativeUnitRows,
      buildingRows: new BuildingRenderPacket3D(),
      bodyHud: new BodyHudRenderPacket3D(),
      shields: new ShieldRenderPacket3D(),
      pieceNames: new PieceNameRenderPacket3D(),
      contactShadows: new ContactShadowRenderPacket3D(),
      groundPrints: new GroundPrintRenderPacket3D(),
    },
    {
      renderScope: scopeFromBounds(nearBounds),
      includeBodyHud: false,
      includeBodyNames: false,
      includeShields: false,
      includeContactShadows: false,
      includeGroundPrints: false,
      hoveredEntity: null,
      scopedUnitsOut: [],
      scopedBuildingsOut: [],
      selectionHudMode: 'whenNotFull',
      getEntityHudToggle: () => false,
      lookupPlayerName: () => null,
      getGroundPrintLocomotionMesh: () => undefined,
      refreshAuthoritativeRenderScope: (bounds, candidateUnits, candidateBuildings) => {
        localAuthoritativeHookCalls++;
        assertContract(bounds !== null, 'scoped authoritative hook must receive culling bounds');
        assertContract(
          candidateUnits.length === 1 && candidateUnits[0].id === 301,
          'scoped authoritative hook must receive stale client-scoped candidates',
        );
        assertContract(candidateBuildings.length === 0, 'scoped authoritative hook must not invent candidates');

        const staleUnit = localAuthoritativeView.getEntity(301);
        const movedInUnit = localAuthoritativeView.getEntity(302);
        assertContract(staleUnit?.unit !== null && staleUnit?.unit !== undefined, 'stale unit must exist');
        assertContract(movedInUnit?.unit !== null && movedInUnit?.unit !== undefined, 'moved-in unit must exist');

        staleUnit!.transform.x = 1400;
        staleUnit!.transform.y = 100;
        localAuthoritativeView.refreshAuthoritativeRenderEntityState3D(staleUnit!, {
          kind: 'unit',
          x: staleUnit!.transform.x,
          y: staleUnit!.transform.y,
          z: staleUnit!.transform.z,
          rotation: staleUnit!.transform.rotation,
          groundY: staleUnit!.transform.z,
          normalX: staleUnit!.unit!.surfaceNormal.nx,
          normalY: staleUnit!.unit!.surfaceNormal.ny,
          normalZ: staleUnit!.unit!.surfaceNormal.nz,
          velocityX: staleUnit!.unit!.velocityX,
          velocityY: staleUnit!.unit!.velocityY,
          yawRate: staleUnit!.unit!.angularVelocity3?.z ?? 0,
          bodyOpacity: 1,
          bodyCenterHeight: staleUnit!.unit!.bodyCenterHeight,
          turrets: staleUnit!.combat?.turrets,
        });

        movedInUnit!.transform.x = 100;
        movedInUnit!.transform.y = 100;
        localAuthoritativeView.refreshAuthoritativeRenderEntityState3D(movedInUnit!, {
          kind: 'unit',
          x: movedInUnit!.transform.x,
          y: movedInUnit!.transform.y,
          z: movedInUnit!.transform.z,
          rotation: movedInUnit!.transform.rotation,
          groundY: movedInUnit!.transform.z,
          normalX: movedInUnit!.unit!.surfaceNormal.nx,
          normalY: movedInUnit!.unit!.surfaceNormal.ny,
          normalZ: movedInUnit!.unit!.surfaceNormal.nz,
          velocityX: movedInUnit!.unit!.velocityX,
          velocityY: movedInUnit!.unit!.velocityY,
          yawRate: movedInUnit!.unit!.angularVelocity3?.z ?? 0,
          bodyOpacity: 1,
          bodyCenterHeight: movedInUnit!.unit!.bodyCenterHeight,
          turrets: movedInUnit!.combat?.turrets,
        });
      },
    },
  );
  assertContract(localAuthoritativeHookCalls === 1, 'scoped authoritative hook must run once per packet build');
  assertContract(
    localAuthoritativeUnitRows.count === 1 &&
      localAuthoritativeUnitRows.entityIdAt(0) === 302,
    'scoped authoritative refresh must recollect final rows after local pose updates',
  );

  const allAuthoritativeView = new ClientViewState();
  allAuthoritativeView.applyNetworkState(snapshot(1, [
    fullUnitEntity(401, 100, 100, 100, 100),
    fullUnitEntity(402, 100, 100, 1400, 100),
  ]));
  const allAuthoritativeRows = new UnitRenderPacket3D();
  let allAuthoritativeCollectorCalls = 0;
  allAuthoritativeView.prepareRenderEntityPackets3D(
    {
      unitRows: allAuthoritativeRows,
      buildingRows: new BuildingRenderPacket3D(),
      bodyHud: new BodyHudRenderPacket3D(),
      shields: new ShieldRenderPacket3D(),
      pieceNames: new PieceNameRenderPacket3D(),
      contactShadows: new ContactShadowRenderPacket3D(),
      groundPrints: new GroundPrintRenderPacket3D(),
    },
    {
      renderScope: allScope(),
      includeBodyHud: false,
      includeBodyNames: false,
      includeShields: false,
      includeContactShadows: false,
      includeGroundPrints: false,
      hoveredEntity: null,
      scopedUnitsOut: [],
      scopedBuildingsOut: [],
      selectionHudMode: 'whenNotFull',
      getEntityHudToggle: () => false,
      lookupPlayerName: () => null,
      getGroundPrintLocomotionMesh: () => undefined,
      collectAuthoritativeRenderSlots: (bounds, unitSlotsOut, buildingSlotsOut, _views) => {
        allAuthoritativeCollectorCalls++;
        assertContract(bounds === null, 'all-scope authoritative slot collector must receive null bounds');
        assertContract(buildingSlotsOut.length === 0, 'all-scope authoritative slot collector starts with empty building rows');
        const slot401 = allAuthoritativeView.getRenderEntityStateSlot(401);
        const slot402 = allAuthoritativeView.getRenderEntityStateSlot(402);
        assertContract(slot401 !== undefined && slot402 !== undefined, 'all-scope authoritative slots must already exist');
        if (slot401 === undefined || slot402 === undefined) return;
        unitSlotsOut.push(slot401, slot402);
      },
    },
  );
  assertContract(
    allAuthoritativeCollectorCalls === 1,
    'all-scope authoritative slot collector must run once',
  );
  assertContract(
    allAuthoritativeRows.count === 2 &&
      allAuthoritativeRows.entityIdAt(0) === 401 &&
      !allAuthoritativeRows.lodProxyAt(0) &&
      allAuthoritativeRows.x[0] === Math.fround(100) &&
      allAuthoritativeRows.y[0] === Math.fround(100),
    'all-scope authoritative slot packets must emit full detail rows',
  );

  scopedView.applyNetworkState(snapshot(2, []));
  scopedView.collectScopedRenderEntities(
    wideBounds,
    units,
    buildings,
    null,
    scopeFromBounds(wideBounds),
  );
  assertContract(units.length === 0 && buildings.length === 0, 'slot-backed scoped query drops removed rows');
}
