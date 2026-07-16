import type { PlayerId } from '../sim/types';
import {
  ENTITY_CHANGED_ACTIONS,
  ENTITY_CHANGED_BUILDING,
  ENTITY_CHANGED_COMBAT_MODE,
  ENTITY_CHANGED_FACTORY,
  ENTITY_CHANGED_HP,
  ENTITY_CHANGED_NORMAL,
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_ROT,
  ENTITY_CHANGED_TURRETS,
  ENTITY_CHANGED_VEL,
} from '../../types/network';
import type { NetworkServerSnapshot } from './NetworkTypes';
import { getEntitySnapshotWireSource } from './stateSerializerEntities';

export const SNAPSHOT_MATERIALIZATION_STAGES = [
  'lifecycleDrain',
  'meta',
  'visibility',
  'entityDtos',
  'projectiles',
  'minimap',
  'economy',
  'resources',
  'spray',
  'audio',
  'scanPulses',
  'gameState',
  'staticPayload',
  'wireEncode',
  'cloneMerge',
  'clientApply',
  'clientApplyPrelude',
  'clientApplyEntities',
  'clientApplyEntitiesTypedPlaceholder',
  'clientApplyEntitiesTypedFull',
  'clientApplyEntitiesBasicTyped',
  'clientApplyEntitiesMetadataTyped',
  'clientApplyEntitiesGeneric',
  'clientApplyEntitiesGenericTyped',
  'clientApplyEntitiesGenericDto',
  'clientApplyRemovals',
  'clientApplyProjectiles',
  'clientApplyProjectileSetup',
  'clientApplyProjectileSpawns',
  'clientApplyProjectileBeams',
  'clientApplyProjectileDespawns',
  'clientApplyProjectileMotion',
  'clientApplyStores',
  'total',
] as const;

export type SnapshotMaterializationStage =
  typeof SNAPSHOT_MATERIALIZATION_STAGES[number];

export type SnapshotMaterializationKind =
  | 'rich-full'
  | 'rich-delta'
  | 'sparse-delta';

export type SnapshotMaterializationStageDurations = Partial<
  Record<SnapshotMaterializationStage, number>
>;

export type SnapshotEntityRowComposition = {
  entityDtoRows: number;
  entityTypedRows: number;
  entityTypedPlaceholderRows: number;
  entityDtoBreakdown: SnapshotEntityDtoRowBreakdown;
};

export type SnapshotEntityDtoRowBreakdown = {
  fullRows: number;
  deltaRows: number;
  unitRows: number;
  buildingRows: number;
  towerRows: number;
  basicRows: number;
  motionRows: number;
  hpRows: number;
  buildRows: number;
  actionRows: number;
  factoryRows: number;
  turretRows: number;
  combatModeRows: number;
  otherDeltaRows: number;
};

export type SnapshotMaterializationMetadata = {
  kind: SnapshotMaterializationKind;
  tick: number;
  listener: string;
  playerId: PlayerId | null;
  entityRows: number;
  entityDtoRows: number;
  entityTypedRows: number;
  entityTypedPlaceholderRows: number;
  entityDtoBreakdown?: SnapshotEntityDtoRowBreakdown;
  removedRows: number;
  projectileRows: number;
  directWire: boolean;
  preencodedWire: boolean;
  stages: SnapshotMaterializationStageDurations;
};

const SNAPSHOT_MATERIALIZATION_METADATA = Symbol('snapshotMaterializationMetadata');

type SnapshotMaterializationCarrier = NetworkServerSnapshot & {
  [SNAPSHOT_MATERIALIZATION_METADATA]: SnapshotMaterializationMetadata | undefined;
};

export function createSnapshotMaterializationStageDurations(): SnapshotMaterializationStageDurations {
  return {};
}

export function snapshotEntityRowComposition(
  state: NetworkServerSnapshot,
): SnapshotEntityRowComposition {
  const entities = state.entities;
  const source = getEntitySnapshotWireSource(entities);
  let entityDtoRows = 0;
  const entityDtoBreakdown = createSnapshotEntityDtoRowBreakdown();
  if (source !== undefined && source.count === entities.length) {
    const nonPlaceholderIndices = source.nonPlaceholderEntityIndices;
    for (let i = 0; i < source.nonPlaceholderEntityRows; i++) {
      const netEntity = entities[nonPlaceholderIndices[i]];
      if (netEntity !== undefined) {
        entityDtoRows++;
        addSnapshotEntityDtoBreakdownRow(entityDtoBreakdown, netEntity);
      }
    }
  } else {
    for (let i = 0; i < entities.length; i++) {
      const netEntity = entities[i];
      if (netEntity !== undefined) {
        entityDtoRows++;
        addSnapshotEntityDtoBreakdownRow(entityDtoBreakdown, netEntity);
      }
    }
  }
  return {
    entityDtoRows,
    entityTypedRows: source?.typedEntityRows ?? 0,
    entityTypedPlaceholderRows: source?.typedPlaceholderRows ?? 0,
    entityDtoBreakdown,
  };
}

export function refreshSnapshotEntityRowComposition(
  state: NetworkServerSnapshot,
): void {
  const metadata = getSnapshotMaterializationMetadata(state);
  if (metadata === undefined) return;
  const composition = snapshotEntityRowComposition(state);
  metadata.entityRows = state.entities.length;
  metadata.entityDtoRows = composition.entityDtoRows;
  metadata.entityTypedRows = composition.entityTypedRows;
  metadata.entityTypedPlaceholderRows = composition.entityTypedPlaceholderRows;
  metadata.entityDtoBreakdown = copySnapshotEntityDtoRowBreakdown(composition.entityDtoBreakdown);
}

export function copySnapshotMaterializationStageDurations(
  stages: SnapshotMaterializationStageDurations,
): SnapshotMaterializationStageDurations {
  const out: SnapshotMaterializationStageDurations = {};
  for (let i = 0; i < SNAPSHOT_MATERIALIZATION_STAGES.length; i++) {
    const stage = SNAPSHOT_MATERIALIZATION_STAGES[i];
    const ms = stages[stage];
    if (ms !== undefined && Number.isFinite(ms) && ms >= 0) out[stage] = ms;
  }
  return out;
}

export function addSnapshotMaterializationStage(
  stages: SnapshotMaterializationStageDurations,
  stage: SnapshotMaterializationStage,
  ms: number,
): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  stages[stage] = (stages[stage] ?? 0) + ms;
}

export function addSnapshotMaterializationStageFromStart(
  stages: SnapshotMaterializationStageDurations,
  stage: SnapshotMaterializationStage,
  start: number,
): void {
  addSnapshotMaterializationStage(stages, stage, performance.now() - start);
}

export function setSnapshotMaterializationMetadata(
  state: NetworkServerSnapshot,
  metadata: SnapshotMaterializationMetadata,
): void {
  Object.defineProperty(state, SNAPSHOT_MATERIALIZATION_METADATA, {
    value: copySnapshotMaterializationMetadataValue(metadata),
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

export function getSnapshotMaterializationMetadata(
  state: NetworkServerSnapshot,
): SnapshotMaterializationMetadata | undefined {
  return (state as SnapshotMaterializationCarrier)[SNAPSHOT_MATERIALIZATION_METADATA];
}

export function copySnapshotMaterializationMetadata(
  src: NetworkServerSnapshot,
  dst: NetworkServerSnapshot,
): void {
  const metadata = getSnapshotMaterializationMetadata(src);
  if (metadata === undefined) {
    clearSnapshotMaterializationMetadata(dst);
    return;
  }
  setSnapshotMaterializationMetadata(dst, metadata);
}

export function addSnapshotClientMaterializationStage(
  state: NetworkServerSnapshot,
  stage: 'cloneMerge' | 'clientApply',
  ms: number,
): void {
  addSnapshotMaterializationStageToSnapshot(state, stage, ms);
}

export function addSnapshotMaterializationStageToSnapshot(
  state: NetworkServerSnapshot,
  stage: SnapshotMaterializationStage,
  ms: number,
): void {
  const metadata = getSnapshotMaterializationMetadata(state);
  if (metadata === undefined) return;
  const stages = metadata.stages;
  addSnapshotMaterializationStage(stages, stage, ms);
}

function clearSnapshotMaterializationMetadata(state: NetworkServerSnapshot): void {
  Object.defineProperty(state, SNAPSHOT_MATERIALIZATION_METADATA, {
    value: undefined,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

function copySnapshotMaterializationMetadataValue(
  metadata: SnapshotMaterializationMetadata,
): SnapshotMaterializationMetadata {
  return {
    kind: metadata.kind,
    tick: metadata.tick,
    listener: metadata.listener,
    playerId: metadata.playerId,
    entityRows: metadata.entityRows,
    entityDtoRows: metadata.entityDtoRows,
    entityTypedRows: metadata.entityTypedRows,
    entityTypedPlaceholderRows: metadata.entityTypedPlaceholderRows,
    entityDtoBreakdown: metadata.entityDtoBreakdown === undefined
      ? undefined
      : copySnapshotEntityDtoRowBreakdown(metadata.entityDtoBreakdown),
    removedRows: metadata.removedRows,
    projectileRows: metadata.projectileRows,
    directWire: metadata.directWire,
    preencodedWire: metadata.preencodedWire,
    stages: copySnapshotMaterializationStageDurations(metadata.stages),
  };
}

export function createSnapshotEntityDtoRowBreakdown(): SnapshotEntityDtoRowBreakdown {
  return {
    fullRows: 0,
    deltaRows: 0,
    unitRows: 0,
    buildingRows: 0,
    towerRows: 0,
    basicRows: 0,
    motionRows: 0,
    hpRows: 0,
    buildRows: 0,
    actionRows: 0,
    factoryRows: 0,
    turretRows: 0,
    combatModeRows: 0,
    otherDeltaRows: 0,
  };
}

export function copySnapshotEntityDtoRowBreakdown(
  src: SnapshotEntityDtoRowBreakdown,
): SnapshotEntityDtoRowBreakdown {
  return {
    fullRows: src.fullRows,
    deltaRows: src.deltaRows,
    unitRows: src.unitRows,
    buildingRows: src.buildingRows,
    towerRows: src.towerRows,
    basicRows: src.basicRows,
    motionRows: src.motionRows,
    hpRows: src.hpRows,
    buildRows: src.buildRows,
    actionRows: src.actionRows,
    factoryRows: src.factoryRows,
    turretRows: src.turretRows,
    combatModeRows: src.combatModeRows,
    otherDeltaRows: src.otherDeltaRows,
  };
}

function addSnapshotEntityDtoBreakdownRow(
  breakdown: SnapshotEntityDtoRowBreakdown,
  netEntity: NetworkServerSnapshot['entities'][number],
): void {
  if (netEntity === undefined) return;
  switch (netEntity.type) {
    case 'unit':
      breakdown.unitRows++;
      break;
    case 'building':
      breakdown.buildingRows++;
      break;
    case 'tower':
      breakdown.towerRows++;
      break;
    default:
      breakdown.basicRows++;
      break;
  }

  const changedFields = netEntity.changedFields;
  if (changedFields === null) {
    breakdown.fullRows++;
    return;
  }

  breakdown.deltaRows++;
  let classified = false;
  if ((changedFields & (ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT | ENTITY_CHANGED_VEL | ENTITY_CHANGED_NORMAL)) !== 0) {
    breakdown.motionRows++;
    classified = true;
  }
  if ((changedFields & ENTITY_CHANGED_HP) !== 0) {
    breakdown.hpRows++;
    classified = true;
  }
  if ((changedFields & ENTITY_CHANGED_BUILDING) !== 0) {
    breakdown.buildRows++;
    classified = true;
  }
  if ((changedFields & ENTITY_CHANGED_ACTIONS) !== 0) {
    breakdown.actionRows++;
    classified = true;
  }
  if ((changedFields & ENTITY_CHANGED_FACTORY) !== 0) {
    breakdown.factoryRows++;
    classified = true;
  }
  if ((changedFields & ENTITY_CHANGED_TURRETS) !== 0) {
    breakdown.turretRows++;
    classified = true;
  }
  if ((changedFields & ENTITY_CHANGED_COMBAT_MODE) !== 0) {
    breakdown.combatModeRows++;
    classified = true;
  }
  if (!classified) breakdown.otherDeltaRows++;
}
