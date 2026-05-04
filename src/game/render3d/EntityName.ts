// Entity → display-name resolution. The single entry point every
// renderer / HUD callsite goes through to ask "what should I label
// this entity?". Keeping the policy in one place means new sources of
// names (per-entity custom rename, AI personality flair, capture-tag
// branding, etc.) can land without touching the renderer.
//
// Today the only source is "this entity is a commander, so use its
// owner's player name". The resolver returns null for everything else
// so NameLabel3D simply doesn't draw a label there. Future sources are
// listed in priority order in `resolveEntityDisplayName` below — earlier
// entries win.
//
// The resolver intentionally takes a `lookupPlayerName` callback rather
// than the lobby roster directly, so the simulation layer doesn't need
// to know how the UI stores player metadata. Render3DEntities passes a
// thin closure that reads from ClientViewState's player table; tests
// can pass `() => null` for a no-op.

import type { Entity, EntityId, PlayerId } from '../sim/types';

export type PlayerNameLookup = (playerId: PlayerId) => string | null;

/** Per-entity name override registry. Stored OUT-of-entity-state so the
 *  network protocol doesn't have to ship a string per entity until the
 *  rename feature actually lands; the override survives client-side as
 *  long as the entity exists. Future "rename your factory / unit" UI
 *  writes here via `setEntityNameOverride`; the resolver checks here
 *  first. */
const _entityNameOverrides = new Map<EntityId, string>();

export function setEntityNameOverride(id: EntityId, name: string | null): void {
  if (name === null || name.trim().length === 0) {
    _entityNameOverrides.delete(id);
  } else {
    _entityNameOverrides.set(id, name.trim());
  }
}

export function getEntityNameOverride(id: EntityId): string | null {
  return _entityNameOverrides.get(id) ?? null;
}

export function clearEntityNameOverrides(): void {
  _entityNameOverrides.clear();
}

/** Returns the string we should render above an entity, or null when
 *  no label should appear. Priority order:
 *    1. Per-entity rename (if the user / a future system has set one).
 *    2. Owner's player name, but only for COMMANDERS — labelling every
 *       unit by its owner would clutter the screen with redundant
 *       team-color text.
 *    3. null — no label.
 *  Building names follow the same rule: if a future "factory rename"
 *  feature lands it sets an override and this function picks it up
 *  automatically. */
export function resolveEntityDisplayName(
  entity: Entity,
  lookupPlayerName: PlayerNameLookup,
): string | null {
  const override = _entityNameOverrides.get(entity.id);
  if (override !== undefined) return override;

  if (entity.commander && entity.ownership) {
    const playerName = lookupPlayerName(entity.ownership.playerId);
    if (playerName !== null && playerName !== undefined && playerName.length > 0) {
      return playerName;
    }
  }

  return null;
}
