// Entity → display-name resolution. The single entry point every
// renderer / HUD callsite goes through to ask "what should I label
// this entity?". Keeping the policy in one place means new sources of
// names (per-entity custom rename, AI personality flair, capture-tag
// branding, etc.) can land without touching the renderer.
//
// Today the only source is "this entity is a commander, so use its
// owner's player name". The resolver returns null for everything else
// so NameLabel3D simply doesn't draw a label there.
//
// The resolver intentionally takes a `lookupPlayerName` callback rather
// than the lobby roster directly, so the simulation layer doesn't need
// to know how the UI stores player metadata. Render3DEntities passes a
// thin closure that reads from ClientViewState's player table; tests
// can pass `() => null` for a no-op.

import type { Entity, PlayerId } from '../sim/types';

export type PlayerNameLookup = (playerId: PlayerId) => string | null;

/** Returns the string we should render above an entity, or null when
 *  no label should appear. Today the only positive case is "labels
 *  on commanders show their owner's player name." Add new sources
 *  here in priority order if/when a per-entity rename or capture-tag
 *  branding feature actually lands. */
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

  return null;
}
