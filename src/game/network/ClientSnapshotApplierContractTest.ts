import { ENTITY_CHANGED_ACTIONS } from '../../types/network';
import type { NetworkServerSnapshotEntity } from './NetworkTypes';
import { snapClientNonVisualState } from './ClientSnapshotApplier';
import { createUnitFromBlueprintEntity } from '../sim/WorldUnitFactory';
import type { PlayerId } from '../sim/types';
import type { WorldSupportSurface } from '../sim/supportSurface';
import { refreshUnitActionHash } from '../sim/unitActions';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[client snapshot applier contract] ${message}`);
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

export function runClientSnapshotApplierContractTest(): void {
  let nextEntityId = 1;
  const entity = createUnitFromBlueprintEntity(
    {
      generateEntityId: () => nextEntityId++,
      sampleSupportSurface: () => FLAT_SUPPORT,
    },
    10,
    20,
    2 as PlayerId,
    'unitJackal',
    { allocateSubEntityIds: false },
  );
  if (entity.unit === null) {
    throw new Error('[client snapshot applier contract] test unit must have a unit component');
  }
  entity.unit.actions.push(
    { type: 'move', x: 100, y: 100, z: 0 },
    { type: 'move', x: 200, y: 200, z: 0 },
  );
  refreshUnitActionHash(entity.unit);

  const omittedActionSnapshot: NetworkServerSnapshotEntity = {
    id: entity.id,
    type: 'unit',
    playerId: 2 as PlayerId,
    changedFields: ENTITY_CHANGED_ACTIONS,
    pos: null,
    rotation: null,
    unit: {
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
    },
    building: null,
  };

  snapClientNonVisualState(entity, omittedActionSnapshot);
  assertContract(
    entity.unit.actions.length === 2 &&
      entity.unit.actions[0].x === 100 &&
      entity.unit.actions[1].x === 200,
    'omitted action details must not clear an existing local action queue',
  );

  const emptyActionSnapshot: NetworkServerSnapshotEntity = {
    ...omittedActionSnapshot,
    unit: {
      ...omittedActionSnapshot.unit!,
      actions: [],
    },
  };
  snapClientNonVisualState(entity, emptyActionSnapshot);
  assertContract(
    entity.unit.actions.length === 0,
    'explicit empty action arrays must clear the local action queue',
  );
}
