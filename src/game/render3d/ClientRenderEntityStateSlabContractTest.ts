import {
  ENTITY_CHANGED_HP,
  buildingBlueprintIdToCode,
  unitBlueprintIdToCode,
} from '../../types/network';
import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotEntity,
} from '../network/NetworkTypes';
import { ClientViewState } from '../network/ClientViewState';
import { createUnitFromBlueprintEntity } from '../sim/WorldUnitFactory';
import type { PlayerId } from '../sim/types';
import type { WorldSupportSurface } from '../sim/supportSurface';
import { ClientRenderEntityStateSlab } from './ClientRenderEntityStateSlab';
import { UnitRenderPacket3D } from './EntityRenderPackets3D';

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

function fullUnitEntity(id: number, hp: number, maxHp: number): NetworkServerSnapshotEntity {
  return {
    id,
    type: 'unit',
    playerId: 1 as PlayerId,
    changedFields: null,
    pos: { x: 0, y: 0, z: 0 },
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

function fullBuildingEntity(id: number, hp: number, maxHp: number): NetworkServerSnapshotEntity {
  return {
    id,
    type: 'building',
    playerId: 2 as PlayerId,
    changedFields: null,
    pos: { x: 0, y: 0, z: 0 },
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

function createTestUnit(id: number, playerId: PlayerId) {
  let nextEntityId = id;
  const entity = createUnitFromBlueprintEntity(
    {
      generateEntityId: () => nextEntityId++,
      sampleSupportSurface: () => FLAT_SUPPORT,
    },
    10,
    20,
    playerId,
    'unitJackal',
    { allocateSubEntityIds: false },
  );
  entity.id = id;
  return entity;
}

export function runClientRenderEntityStateSlabContractTest(): void {
  const slab = new ClientRenderEntityStateSlab();
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
  slab.assertParity(unit);

  const packet = new UnitRenderPacket3D();
  packet.pushEntityState(unit, slab.getViews(), slot!, true, true, true, false);
  assertContract(packet.count === 1, 'packet must accept a unit slab row');
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
  assertContract(reusedSlot === slot, 'freed slots must be reused for stable bounded slabs');

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
}
