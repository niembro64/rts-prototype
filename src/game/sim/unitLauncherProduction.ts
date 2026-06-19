import { CT_TURRET_STATE_IDLE } from '../sim-wasm/init';
import { isBuildBlockingActivation } from './buildableHelpers';
import { readCombatTargetingTurretFsmInto, type CombatTargetingTurretFsmOut } from './combat/targetingInputStamping';
import type { ForceAccumulator } from './ForceAccumulator';
import type { Entity } from './types';
import type { WindState } from './wind';
import { decrementCooldown } from './combat/combatUtils';
import { rollTurretCooldownDuration } from './turretCooldown';
import {
  inheritProducedUnitIntent,
  isLiveUnitLauncherTarget,
  launchProducedUnitFromTurret,
  targetIdToLiveEnemyEntity,
} from './unitLauncher';
import type { WorldState } from './WorldState';

export type UnitLauncherProductionResult = {
  spawnedUnits: Entity[];
};

const _spawnedUnits: Entity[] = [];
const _fsm: CombatTargetingTurretFsmOut = {
  stateCode: CT_TURRET_STATE_IDLE,
  targetId: -1,
};
const STILL_AIR: WindState = { x: 0, y: 0, z: 0, speed: 0, angle: 0 };

class UnitLauncherProductionSystem {
  update(
    world: WorldState,
    dtMs: number,
    forceAccumulator: ForceAccumulator,
    wind: WindState = STILL_AIR,
  ): UnitLauncherProductionResult {
    _spawnedUnits.length = 0;
    const units = world.getUnits();
    for (let i = 0; i < units.length; i++) {
      const host = units[i];
      if (host.unit === null || host.ownership === null || host.combat === null) continue;
      if (host.unit.hp <= 0 || isBuildBlockingActivation(host.buildable)) continue;

      const turrets = host.combat.turrets;
      for (let turretIndex = 0; turretIndex < turrets.length; turretIndex++) {
        const turret = turrets[turretIndex];
        const launcher = turret.config.unitLauncher;
        if (launcher === null || !launcher.autoProduce) continue;

        turret.unitLauncherCooldownMs = decrementCooldown(
          turret.unitLauncherCooldownMs,
          dtMs,
        );

        const producedUnitBlueprintId = launcher.producedUnitBlueprintId;
        if (producedUnitBlueprintId === null) continue;

        const target = this.getLockedTarget(world, host, turretIndex);
        if (!isLiveUnitLauncherTarget(world, host, target)) continue;
        if (turret.unitLauncherCooldownMs > 0) continue;
        if (!world.canPlayerBuildUnit(host.ownership.playerId)) continue;

        const produced = world.createUnitFromBlueprint(
          host.transform.x,
          host.transform.y,
          host.ownership.playerId,
          producedUnitBlueprintId,
        );
        world.addEntity(produced);
        inheritProducedUnitIntent(world, host, produced, target);
        launchProducedUnitFromTurret(
          world,
          forceAccumulator,
          host,
          { turret, turretIndex },
          produced,
          dtMs,
          wind,
          target,
        );
        _spawnedUnits.push(produced);
        turret.unitLauncherCooldownMs = rollTurretCooldownDuration(
          turret.config.cooldown,
          () => world.rng.next(),
        );
      }
    }

    return { spawnedUnits: _spawnedUnits };
  }

  private getLockedTarget(
    world: WorldState,
    host: Entity,
    turretIndex: number,
  ): Entity | null {
    const turret = host.combat?.turrets[turretIndex];
    const allowBallisticFallback =
      turret?.config.unitLauncher?.aimMode === 'ballistic-or-waypoint';
    const hasTargetingFsm = readCombatTargetingTurretFsmInto(host, turretIndex, _fsm);
    if (hasTargetingFsm) {
      const target = targetIdToLiveEnemyEntity(world, host, _fsm.targetId);
      if (target !== null && (_fsm.stateCode !== CT_TURRET_STATE_IDLE || allowBallisticFallback)) {
        return target;
      }
      if (!allowBallisticFallback) return null;
    }

    if (turret?.target !== null && turret?.target !== undefined) {
      const target = targetIdToLiveEnemyEntity(world, host, turret.target);
      if (target !== null) return target;
    }

    const priorityTarget = targetIdToLiveEnemyEntity(world, host, host.combat?.priorityTargetId);
    if (priorityTarget !== null) return priorityTarget;

    const actionTargetId = host.unit?.actions[0]?.targetId;
    return targetIdToLiveEnemyEntity(world, host, actionTargetId);
  }
}

export const unitLauncherProductionSystem = new UnitLauncherProductionSystem();
