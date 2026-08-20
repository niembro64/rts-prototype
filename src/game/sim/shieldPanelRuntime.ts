import { NO_ENTITY_ID, type Entity, type Turret } from './types';
import { isEntityActive } from './buildableHelpers';

type ShieldPanelTurretRef = {
  turret: Turret;
  turretIndex: number;
};

export function isShieldPanelTurret(turret: Turret): boolean {
  const shot = turret.config.shot;
  return shot?.type === 'shield' && shot.barrier === undefined;
}

function findShieldPanelTurret(entity: Entity): ShieldPanelTurretRef | null {
  const combat = entity.combat;
  if (combat === null) return null;

  const turrets = combat.turrets;
  for (let turretIndex = 0; turretIndex < turrets.length; turretIndex++) {
    const turret = turrets[turretIndex];
    if (!isShieldPanelTurret(turret)) continue;
    return { turret, turretIndex };
  }
  return null;
}

export function getActiveShieldPanelTurret(entity: Entity): ShieldPanelTurretRef | null {
  const unit = entity.unit;
  if (unit === null || unit.hp <= 0 || unit.shieldPanels.length === 0) return null;

  const ref = findShieldPanelTurret(entity);
  if (ref === null) return null;

  const { turret } = ref;
  if (turret.id === NO_ENTITY_ID) return null;
  // Mirror plates are equipment on a finished hull: a shell that has merely
  // materialized its body is not yet reflecting anything.
  if (!isEntityActive(entity)) return null;
  // ...and equipment the SIDE is running. A mirror is force material in the
  // panel shape, so it is up only while the team has a Shield Generator
  // switched on, and it raises and lowers through the same authored
  // transition a dome does — `updateShieldState` writes that progress for
  // panel turrets exactly as it does for barrier turrets. A panel that
  // survived this gate on its own hp alone was the one piece of force
  // material in the game that ran for free (budget_design_philosophy.html,
  // "Shields are powered equipment, not a production unlock").
  if (turret.shield === null || turret.shield.transition <= 0) return null;
  return ref;
}
