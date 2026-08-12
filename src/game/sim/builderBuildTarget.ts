import { ENTITY_CHANGED_ACTIONS } from '@/types/network';
import { NO_ENTITY_ID } from './types';
import type { Entity, EntityId } from './types';
import type { WorldState } from './WorldState';

/** The build site a builder is ACTIVELY constructing: the target of its
 *  HEAD build order, and nothing else.
 *
 *  A queued build further down the list is intent, not work (see
 *  "Waypoints are intent; pathfinding points are disposable"). Reading the
 *  most recently *placed* nanoframe instead would make a shift-queued build
 *  list fund whichever site was authored last while the builder is still
 *  walking to the first one — and fund nothing at all once that site
 *  completes or sits out of range. */
export function getActiveBuildTargetId(entity: Entity): EntityId {
  const unit = entity.unit;
  if (unit === null || unit.actions.length === 0) return NO_ENTITY_ID;
  const action = unit.actions[0];
  if (action.type !== 'build') return NO_ENTITY_ID;
  const buildingId = action.buildingId;
  return buildingId === undefined ? NO_ENTITY_ID : buildingId;
}

/** Refresh `builder.currentBuildTarget` from the head build order. The field
 *  is a per-tick mirror of {@link getActiveBuildTargetId} — the action queue
 *  is the truth — kept on the component so snapshots, the renderer's
 *  construction emitters, and the bot rig's construction arm can read it
 *  without walking the queue. This is the ONLY writer. */
export function syncBuilderActiveBuildTarget(world: WorldState, entity: Entity): EntityId {
  const builder = entity.builder;
  if (builder === null) return NO_ENTITY_ID;
  const targetId = getActiveBuildTargetId(entity);
  if (builder.currentBuildTarget !== targetId) {
    builder.currentBuildTarget = targetId;
    world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
  }
  return targetId;
}
