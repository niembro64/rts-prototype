// Shield Tech production gating.
//
// A blueprint "has a shield" when any of its turret mounts references a
// turret blueprint whose emission is shield material. The sets are
// derived from blueprint data once at load, so any future blueprint
// that mounts a shield emitter is gated automatically — there is no
// hand-maintained roster to forget.
//
// While a player owns no completed Shield Tech building
// (WorldState.playerHasShieldTech), producing or placing these
// blueprints is rejected at command execution; the UI mirrors the same
// rule through the shieldTechPlayerMask snapshot meta.

import type { BuildingBlueprintId, UnitBlueprintId } from '../../../types/blueprintIds';
import { BUILDING_BLUEPRINTS } from './buildings';
import { TURRET_BLUEPRINTS } from './turrets';
import { UNIT_BLUEPRINTS } from './units';

type ShieldedTurretMount = { turretBlueprintId: string };

function mountsShieldTurret(turrets: readonly ShieldedTurretMount[]): boolean {
  for (const mount of turrets) {
    const turret = TURRET_BLUEPRINTS[mount.turretBlueprintId as keyof typeof TURRET_BLUEPRINTS];
    if (turret !== undefined && turret.emissionKind === 'shield') return true;
  }
  return false;
}

function buildShieldedUnitBlueprintIds(): ReadonlySet<UnitBlueprintId> {
  const ids = new Set<UnitBlueprintId>();
  for (const blueprint of Object.values(UNIT_BLUEPRINTS)) {
    if (mountsShieldTurret(blueprint.turrets)) ids.add(blueprint.unitBlueprintId);
  }
  return ids;
}

function buildShieldedBuildingBlueprintIds(): ReadonlySet<BuildingBlueprintId> {
  const ids = new Set<BuildingBlueprintId>();
  for (const blueprint of Object.values(BUILDING_BLUEPRINTS)) {
    if (mountsShieldTurret(blueprint.turrets)) ids.add(blueprint.buildingBlueprintId);
  }
  return ids;
}

const SHIELDED_UNIT_BLUEPRINT_IDS: ReadonlySet<string> =
  buildShieldedUnitBlueprintIds();
const SHIELDED_BUILDING_BLUEPRINT_IDS: ReadonlySet<string> =
  buildShieldedBuildingBlueprintIds();

export function unitBlueprintHasShield(unitBlueprintId: string): boolean {
  return SHIELDED_UNIT_BLUEPRINT_IDS.has(unitBlueprintId);
}

export function buildingBlueprintHasShield(buildingBlueprintId: string): boolean {
  return SHIELDED_BUILDING_BLUEPRINT_IDS.has(buildingBlueprintId);
}
