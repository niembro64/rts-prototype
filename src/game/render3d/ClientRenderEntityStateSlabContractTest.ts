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
import type { Entity, PlayerId } from '../sim/types';
import type { WorldSupportSurface } from '../sim/supportSurface';
import type { FootprintBounds, ViewportFootprint } from '../ViewportFootprint';
import { ClientRenderEntityStateSlab } from './ClientRenderEntityStateSlab';
import {
  CLIENT_RENDER_TURRET_FLAG_SHIELD_FIELD,
  ClientRenderTurretStateSlab,
} from './ClientRenderTurretStateSlab';
import { UnitRenderPacket3D } from './EntityRenderPackets3D';
import { ShieldRenderPacket3D } from './ShieldRenderer3D';

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
    inScope: (x: number, y: number, padding = 0): boolean => (
      x + padding >= bounds.minX &&
      x - padding <= bounds.maxX &&
      y + padding >= bounds.minY &&
      y - padding <= bounds.maxY
    ),
  } as ViewportFootprint;
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
  assertContract(packet.turretStateAt(0)?.count === unit.combat!.turrets.length, 'packet must expose turret state rows');
  assertContract(packet.entityIdAt(0) === unit.id, 'packet id must come from the slab row');
  assertContract(packet.ownerIdAt(0) === 2, 'packet owner must come from the slab row');
  assertContract(packet.selectedAt(0), 'packet selected flag must come from slab flags');
  assertContract(packet.activePredictionAt(0), 'packet active-prediction bit must be composed');
  assertContract(packet.renderDirtyAt(0), 'packet render-dirty bit must be composed');
  assertContract(packet.lifecycleDirtyAt(0), 'packet lifecycle-dirty bit must be composed');
  assertContract(packet.x[0] === Math.fround(unit.transform.x), 'packet x must match slab x');
  assertContract(packet.velocityX[0] === Math.fround(unit.unit.velocityX), 'packet velocity must match slab velocity');

  slab.unsetEntity(unit.id);
  assertContract(slab.getSlot(unit.id) === undefined, 'unset must remove id-to-slot mapping');
  const reusedUnit = createTestUnit(11, 3 as PlayerId);
  const reusedSlot = slab.refreshUnit(reusedUnit);
  turretSlab.refreshHost(reusedUnit, reusedSlot!);
  assertContract(reusedSlot === slot, 'freed slots must be reused for stable bounded slabs');

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
