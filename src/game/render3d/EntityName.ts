// Entity → display-name resolution. The single entry point every
// renderer / HUD callsite goes through to ask "what should I label
// this entity (or sub-piece)?". Keeping the policy in one place means
// new sources of names (per-entity custom rename, AI personality flair,
// capture-tag branding, etc.) can land without touching the renderer.
//
// Body labels always use the entity's canonical blueprint display
// name, gated by a per-type `name` toggle + the global selection HUD
// mode:
//   - name toggle OFF              → no label
//   - selected + mode 'never'      → no label
//   - selected + mode 'always'/    → label
//     'whenNotFull'                  (names have no fullness, so
//                                     whenNotFull never hides a name)
//   - not selected                 → label (per-type toggle drives it)
//
// Commander owner names are a separate owner-label line, not a body
// label override. The resolver intentionally takes a `lookupPlayerName`
// callback rather than the lobby roster directly, so the simulation
// layer doesn't need to know how the UI stores player metadata.

import type { Entity, PlayerId, Turret } from '../sim/types';
import type { SelectionHudMode } from '@/clientBarConfig';
import { getBuildingBlueprint } from '../sim/blueprints/buildings';
import { getUnitBlueprint } from '../sim/blueprints';
import { getLocomotionBlueprint } from '../sim/blueprints/locomotion';
import { getShotBlueprint } from '../sim/blueprints/shots';
import { getTurretBlueprint } from '../sim/blueprints/turrets';

export type PlayerNameLookup = (playerId: PlayerId) => string | null;

const UNKNOWN_UNIT_NAME = 'Unknown Unit';
const UNKNOWN_BUILDING_NAME = 'Unknown Building';
const UNKNOWN_TURRET_NAME = 'Unknown Turret';
const UNKNOWN_LOCOMOTION_NAME = 'Unknown Locomotion';
const UNKNOWN_SHOT_NAME = 'Unknown Shot';

/** Names have no current/max, so the only thing the selection mode can
 *  do is suppress a SELECTED entity's name in 'never'. Unselected
 *  entities are governed purely by the per-type toggle. */
function nameAllowed(
  nameToggle: boolean,
  selected: boolean,
  mode: SelectionHudMode,
): boolean {
  if (!nameToggle) return false;
  if (selected && mode === 'never') return false;
  return true;
}

function unitBlueprintName(entity: Entity): string | null {
  if (!entity.unit) return null;
  try {
    return getUnitBlueprint(entity.unit.unitBlueprintId).name;
  } catch {
    return UNKNOWN_UNIT_NAME;
  }
}

function buildingBlueprintName(entity: Entity): string | null {
  if (!entity.building || !entity.buildingBlueprintId) return null;
  try {
    return getBuildingBlueprint(entity.buildingBlueprintId).name;
  } catch {
    return UNKNOWN_BUILDING_NAME;
  }
}

/** Body-entity label. `nameToggle` is the per-type `name` toggle for
 *  this entity's HUD type (unit / tower / building). Commander owner
 *  names are resolved separately by resolveCommanderOwnerName so the
 *  body label never changes kind from blueprint name to player name. */
export function resolveEntityDisplayName(
  entity: Entity,
  nameToggle: boolean,
  mode: SelectionHudMode,
): string | null {
  const selected = entity.selectable?.selected === true;
  if (!nameAllowed(nameToggle, selected, mode)) return null;

  return unitBlueprintName(entity) ?? buildingBlueprintName(entity);
}

/** Commander owner label. It uses the same per-type name toggle/mode
 *  as the commander body label, but renders as a separate owner style. */
export function resolveCommanderOwnerName(
  entity: Entity,
  lookupPlayerName: PlayerNameLookup,
  nameToggle: boolean,
  mode: SelectionHudMode,
): string | null {
  if (!entity.commander || !entity.ownership) return null;
  const selected = entity.selectable?.selected === true;
  if (!nameAllowed(nameToggle, selected, mode)) return null;
  const playerName = lookupPlayerName(entity.ownership.playerId);
  if (playerName === null || playerName.trim().length === 0) return null;
  return `Player: ${playerName}`;
}

/** Turret sub-piece label from the turret blueprint display name. */
export function resolveTurretName(
  host: Entity,
  turret: Turret,
  nameToggle: boolean,
  mode: SelectionHudMode,
): string | null {
  const selected = host.selectable?.selected === true;
  if (!nameAllowed(nameToggle, selected, mode)) return null;
  try {
    return getTurretBlueprint(turret.config.turretBlueprintId).name;
  } catch {
    return UNKNOWN_TURRET_NAME;
  }
}

/** Locomotion sub-piece label from the locomotion blueprint display name. */
export function resolveLocomotionName(
  host: Entity,
  nameToggle: boolean,
  mode: SelectionHudMode,
): string | null {
  const loco = host.unit?.locomotion;
  if (!loco) return null;
  const selected = host.selectable?.selected === true;
  if (!nameAllowed(nameToggle, selected, mode)) return null;
  try {
    return getLocomotionBlueprint(loco.blueprintId).name;
  } catch {
    return UNKNOWN_LOCOMOTION_NAME;
  }
}

/** Shot sub-piece label from the shot blueprint display name. Shots
 *  are never selectable, so the selection mode only ever sees
 *  `selected=false`. */
export function resolveShotName(
  shot: Entity,
  nameToggle: boolean,
  mode: SelectionHudMode,
): string | null {
  const proj = shot.projectile;
  if (!proj) return null;
  const selected = shot.selectable?.selected === true;
  if (!nameAllowed(nameToggle, selected, mode)) return null;
  try {
    return getShotBlueprint(proj.shotBlueprintId).name;
  } catch {
    return UNKNOWN_SHOT_NAME;
  }
}
