import { NO_ENTITY_ID, type Entity, type Turret } from './types';
import { isConstructionPieceMaterialized } from './buildableHelpers';

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
  if (!isConstructionPieceMaterialized(entity, 'body')) return null;
  return ref;
}
