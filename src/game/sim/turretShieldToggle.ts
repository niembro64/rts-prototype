import { ENTITY_CHANGED_TURRETS } from '@/types/network';
import { resetDisabledTurretJsOnlyFields } from './combat/combatActivity';
import type { WorldState } from './WorldState';

export function setTurretShieldPanelsEnabled(
  world: WorldState,
  enabled: boolean,
): void {
  if (world.turretShieldPanelsEnabled === enabled) return;
  world.turretShieldPanelsEnabled = enabled;
  if (enabled) return;
  for (const unit of world.getShieldPanelUnits()) {
    const combat = unit.combat;
    if (combat === null) continue;
    const turrets = combat.turrets;
    for (let i = 0; i < turrets.length; i++) {
      const turret = turrets[i];
      if (!turret.config.passive) continue;
      turret.target = null;
      turret.state = 'idle';
      resetDisabledTurretJsOnlyFields(turret);
    }
    world.markSnapshotDirty(unit.id, ENTITY_CHANGED_TURRETS);
  }
}

export function setTurretShieldSpheresEnabled(
  world: WorldState,
  enabled: boolean,
): void {
  if (world.turretShieldSpheresEnabled === enabled) return;
  world.turretShieldSpheresEnabled = enabled;
  if (enabled) return;
  for (const unit of world.getShieldUnits()) {
    const combat = unit.combat;
    if (combat === null) continue;
    const turrets = combat.turrets;
    for (let i = 0; i < turrets.length; i++) {
      const turret = turrets[i];
      const shot = turret.config.shot;
      if (shot === null || shot.type !== 'shield') continue;
      turret.target = null;
      turret.state = 'idle';
      resetDisabledTurretJsOnlyFields(turret);
    }
    world.markSnapshotDirty(unit.id, ENTITY_CHANGED_TURRETS);
  }
}
