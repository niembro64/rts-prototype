import type { PlayerId } from '../sim/types';
import type { NetworkServerSnapshot } from './NetworkTypes';
import { getEntitySnapshotWireSource } from './stateSerializerEntities';

export const SNAPSHOT_MATERIALIZATION_STAGES = [
  'lifecycleDrain',
  'meta',
  'grid',
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
  'clientApplyEntitiesBasicTyped',
  'clientApplyEntitiesMetadataTyped',
  'clientApplyEntitiesGeneric',
  'clientApplyEntitiesGenericTyped',
  'clientApplyEntitiesGenericDto',
  'clientApplyRemovals',
  'clientApplyProjectiles',
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
  if (source !== undefined && source.count === entities.length) {
    const nonPlaceholderIndices = source.nonPlaceholderEntityIndices;
    for (let i = 0; i < source.nonPlaceholderEntityRows; i++) {
      if (entities[nonPlaceholderIndices[i]] !== undefined) entityDtoRows++;
    }
  } else {
    for (let i = 0; i < entities.length; i++) {
      if (entities[i] !== undefined) entityDtoRows++;
    }
  }
  return {
    entityDtoRows,
    entityTypedRows: source?.typedEntityRows ?? 0,
    entityTypedPlaceholderRows: source?.typedPlaceholderRows ?? 0,
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
    removedRows: metadata.removedRows,
    projectileRows: metadata.projectileRows,
    directWire: metadata.directWire,
    preencodedWire: metadata.preencodedWire,
    stages: copySnapshotMaterializationStageDurations(metadata.stages),
  };
}
