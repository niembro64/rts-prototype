import type { NetworkServerSnapshot, NetworkServerSnapshotEntity } from './NetworkTypes';
import { createEmptyNetworkServerSnapshot } from './stateSerializer';

/** Shared fixture builders for the snapshot-pipeline contract tests
 *  (applier, render slab, publisher). Built on the production
 *  `createEmptyNetworkServerSnapshot` so a new snapshot field lands in
 *  exactly one empty-shell literal — the fixtures can never drift from
 *  what the serializer actually emits. */

/** All-null unit sub-snapshot: "nothing about the unit changed". */
export function emptyUnitSnapshot(): NonNullable<NetworkServerSnapshotEntity['unit']> {
  return {
    hp: null,
    velocity: null,
    radius: null,
    mass: null,
    supportPointOffsetZ: null,
    unitBlueprintCode: null,
    isCommander: null,
    surfaceNormal: null,
    orientation: null,
    angularVelocity3: null,
    fireState: null,
    trajectoryMode: null,
    repeatQueue: null,
    moveState: null,
    wantCloak: null,
    factory: null,
    cloaked: null,
    buildTargetId: null,
    buildTargetIdPresent: false,
    actions: null,
    turrets: null,
    build: null,
  };
}

/** A rich full snapshot carrying only the given entities at `tick`. */
export function snapshotAtTick(
  tick: number,
  entities: NetworkServerSnapshotEntity[],
): NetworkServerSnapshot {
  const state = createEmptyNetworkServerSnapshot(entities, {}, undefined);
  state.tick = tick;
  return state;
}

/** Same shell, marked as an entity-delta-only snapshot. */
export function entityDeltaSnapshotAtTick(
  tick: number,
  entities: NetworkServerSnapshotEntity[],
): NetworkServerSnapshot {
  const state = snapshotAtTick(tick, entities);
  state.entityDeltaOnly = true;
  return state;
}
