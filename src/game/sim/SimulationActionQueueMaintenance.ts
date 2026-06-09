import { ENTITY_CHANGED_ACTIONS } from '@/types/network';
import { isBuildInProgress } from './buildableHelpers';
import { isBuildTargetInRange } from './builderRange';
import { isCapturableTarget } from './capture';
import { isReclaimableTarget } from './reclaim';
import { isResurrectableWreck } from './wrecks';
import { getActionIntentStart, getUnitActionTargetId } from './unitActionIntents';
import { spliceUnitActions } from './unitActions';
import { NO_ENTITY_ID } from './types';
import type { Entity, UnitAction } from './types';
import type { WorldState } from './WorldState';

export class SimulationActionQueueMaintenance {
  private readonly world: WorldState;
  private readonly advanceAction: (entity: Entity) => void;

  constructor(world: WorldState, advanceAction: (entity: Entity) => void) {
    this.world = world;
    this.advanceAction = advanceAction;
  }

  sweepInvalidTargetActions(entity: Entity): boolean {
    const unit = entity.unit;
    if (!unit) return false;

    let changed = false;
    const actions = unit.actions;
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      if (!this.isTargetedActionInvalid(entity, action)) continue;

      const targetId = getUnitActionTargetId(action);
      const removeStart = getActionIntentStart(actions, i);
      spliceUnitActions(unit, removeStart, i - removeStart + 1);
      const builder = entity.builder;
      if (targetId !== undefined && builder !== null && builder.currentBuildTarget === targetId) {
        builder.currentBuildTarget = NO_ENTITY_ID;
      }
      changed = true;
      i = removeStart - 1;
    }

    if (changed) {
      const patrolStartIndex = actions.findIndex((action) => action.type === 'patrol');
      unit.patrolStartIndex = patrolStartIndex >= 0 ? patrolStartIndex : null;
    }
    return changed;
  }

  promoteReachableBuildAction(entity: Entity): void {
    const unit = entity.unit;
    if (!unit || !entity.builder || unit.actions.length === 0) return;

    const actions = unit.actions;
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      if (
        action.type !== 'build' &&
        action.type !== 'repair' &&
        action.type !== 'reclaim' &&
        action.type !== 'capture' &&
        action.type !== 'resurrect'
      ) {
        if (!action.isPathExpansion) return;
        continue;
      }

      const targetId = action.type === 'build' ? action.buildingId : action.targetId;
      const target = targetId !== undefined ? this.world.getEntity(targetId) : undefined;
      if (!target || !isBuildTargetInRange(entity, target)) return;

      if (i > 0) {
        spliceUnitActions(unit, 0, i);
        this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
      }
      return;
    }
  }

  advanceCompletedConstructionActions(completedBuildings: readonly Entity[]): void {
    if (completedBuildings.length === 0) return;
    for (const completed of completedBuildings) {
      const completedId = completed.id;
      for (const entity of this.world.getBuilderUnits()) {
        const unit = entity.unit;
        if (!unit || unit.actions.length === 0) continue;
        const action = unit.actions[0];
        const targetId = action.type === 'build'
          ? action.buildingId
          : action.type === 'repair'
            ? action.targetId
            : undefined;
        if (targetId === completedId) {
          this.advanceAction(entity);
        }
      }
    }
  }

  private isTargetedActionInvalid(entity: Entity, action: UnitAction): boolean {
    if (
      action.type !== 'attack' &&
      action.type !== 'build' &&
      action.type !== 'repair' &&
      action.type !== 'reclaim' &&
      action.type !== 'capture' &&
      action.type !== 'resurrect' &&
      action.type !== 'guard'
    ) {
      return false;
    }

    const targetId = getUnitActionTargetId(action);
    const target = targetId !== undefined ? this.world.getEntity(targetId) : undefined;
    if (!target) return true;

    if (action.type === 'attack') {
      return !this.isAliveAttackTarget(target);
    }

    if (action.type === 'build') {
      return !this.isIncompleteBuildableTarget(target);
    }

    if (action.type === 'guard') {
      return !this.isAliveAttackTarget(target);
    }

    if (action.type === 'reclaim') {
      return !isReclaimableTarget(target);
    }

    if (action.type === 'capture') {
      const playerId = entity.ownership?.playerId;
      return playerId === undefined || !isCapturableTarget(target, playerId);
    }

    if (action.type === 'resurrect') {
      return !isResurrectableWreck(target);
    }

    return !this.isIncompleteBuildableTarget(target) && !this.isDamagedRepairUnit(target);
  }

  private isAliveAttackTarget(target: Entity): boolean {
    return !!(
      (target.unit && target.unit.hp > 0) ||
      (target.building && target.building.hp > 0)
    );
  }

  private isIncompleteBuildableTarget(target: Entity): boolean {
    return !!(isBuildInProgress(target.buildable) &&
      ((target.building && target.building.hp > 0) ||
        (target.unit && target.unit.hp > 0)));
  }

  private isDamagedRepairUnit(target: Entity): boolean {
    return !!(target.unit && target.unit.hp > 0 && target.unit.hp < target.unit.maxHp);
  }
}
