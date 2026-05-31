// Entity → display-name resolution. The single entry point every
// renderer / HUD callsite goes through to ask "what should I label
// this entity (or sub-piece)?". Keeping the policy in one place means
// new sources of names (per-entity custom rename, AI personality flair,
// capture-tag branding, etc.) can land without touching the renderer.
//
// Commander labels always use the owning player's name. Otherwise the
// label is the entity's canonical blueprint name, gated by a
// per-type `name` toggle + the global selection HUD mode:
//   - name toggle OFF              → no label
//   - selected + mode 'never'      → no label
//   - selected + mode 'always'/    → label
//     'whenNotFull'                  (names have no fullness, so
//                                     whenNotFull never hides a name)
//   - not selected                 → label (per-type toggle drives it)
//
// The resolver intentionally takes a `lookupPlayerName` callback rather
// than the lobby roster directly, so the simulation layer doesn't need
// to know how the UI stores player metadata. Render3DEntities passes a
// thin closure that reads from ClientViewState's player table; tests
// can pass `() => null` for a no-op.

import type { Entity, PlayerId, Turret } from '../sim/types';
import type { SelectionHudMode } from '@/clientBarConfig';
import { getBuildingBlueprint } from '../sim/blueprints/buildings';
import { getUnitBlueprint } from '../sim/blueprints';

export type PlayerNameLookup = (playerId: PlayerId) => string | null;

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
    return entity.unit.unitBlueprintId;
  }
}

function buildingBlueprintName(entity: Entity): string | null {
  if (!entity.building || !entity.buildingBlueprintId) return null;
  try {
    return getBuildingBlueprint(entity.buildingBlueprintId).name;
  } catch {
    return entity.buildingBlueprintId;
  }
}

/** Body-entity label. `nameToggle` is the per-type `name` toggle for
 *  this entity's HUD type (unit / tower / building). Commander player
 *  names take priority and ignore the toggle/mode (a commander is
 *  always identified by its owner). */
export function resolveEntityDisplayName(
  entity: Entity,
  lookupPlayerName: PlayerNameLookup,
  nameToggle: boolean,
  mode: SelectionHudMode,
): string | null {
  if (entity.commander && entity.ownership) {
    const playerName = lookupPlayerName(entity.ownership.playerId);
    if (playerName !== null && playerName !== undefined && playerName.length > 0) {
      return playerName;
    }
  }

  const selected = entity.selectable?.selected === true;
  if (!nameAllowed(nameToggle, selected, mode)) return null;

  return unitBlueprintName(entity) ?? buildingBlueprintName(entity);
}

/** Turret sub-piece label. Turret blueprints carry no display name, so
 *  the label is the turret blueprint id. */
export function resolveTurretName(
  host: Entity,
  turret: Turret,
  nameToggle: boolean,
  mode: SelectionHudMode,
): string | null {
  const selected = host.selectable?.selected === true;
  if (!nameAllowed(nameToggle, selected, mode)) return null;
  return turret.config.turretBlueprintId;
}

/** Locomotion sub-piece label = the locomotion blueprint id. */
export function resolveLocomotionName(
  host: Entity,
  nameToggle: boolean,
  mode: SelectionHudMode,
): string | null {
  const loco = host.unit?.locomotion;
  if (!loco) return null;
  const selected = host.selectable?.selected === true;
  if (!nameAllowed(nameToggle, selected, mode)) return null;
  return loco.blueprintId;
}

/** Shot sub-piece label = the shot blueprint id. Shots are never
 *  selectable, so the selection mode only ever sees `selected=false`. */
export function resolveShotName(
  shot: Entity,
  nameToggle: boolean,
  mode: SelectionHudMode,
): string | null {
  const proj = shot.projectile;
  if (!proj) return null;
  const selected = shot.selectable?.selected === true;
  if (!nameAllowed(nameToggle, selected, mode)) return null;
  return proj.shotBlueprintId;
}
