// Entity → display-name resolution. The single entry point every
// renderer / HUD callsite goes through to ask "what should I label
// this entity?". Keeping the policy in one place means new sources of
// names (per-entity custom rename, AI personality flair, capture-tag
// branding, etc.) can land without touching the renderer.
//
// Commander labels use the owning player's name. Selected units and
// buildings use their canonical blueprint name.
//
// The resolver intentionally takes a `lookupPlayerName` callback rather
// than the lobby roster directly, so the simulation layer doesn't need
// to know how the UI stores player metadata. Render3DEntities passes a
// thin closure that reads from ClientViewState's player table; tests
// can pass `() => null` for a no-op.

import type { Entity, PlayerId } from '../sim/types';
import { getBuildingBlueprint } from '../sim/blueprints/buildings';
import { getUnitBlueprint } from '../sim/blueprints';

export type PlayerNameLookup = (playerId: PlayerId) => string | null;

/** Returns the string we should render above an entity, or null when
 *  no label should appear. Keep priority here explicit: commander
 *  player names win, then selected entity blueprint names. */
export function resolveEntityDisplayName(
  entity: Entity,
  lookupPlayerName: PlayerNameLookup,
): string | null {
  if (entity.commander && entity.ownership) {
    const playerName = lookupPlayerName(entity.ownership.playerId);
    if (playerName !== null && playerName !== undefined && playerName.length > 0) {
      return playerName;
    }
  }

  if (!entity.selectable?.selected) return null;

  if (entity.unit) {
    try {
      return getUnitBlueprint(entity.unit.unitType).name;
    } catch {
      return entity.unit.unitType;
    }
  }

  if (entity.building && entity.buildingType) {
    try {
      return getBuildingBlueprint(entity.buildingType).name;
    } catch {
      return entity.buildingType;
    }
  }

  return null;
}
