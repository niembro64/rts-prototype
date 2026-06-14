// Shared contract constants for the Rust reflector-intersection batch
// (`projectile_reflector_intersections_batch`). One source of truth for
// every consumer — the plasma/rocket collision handler and the beam
// tracer both reflect off the same stamped surfaces through the same
// kernel, so these values must never fork per caller.

/** out_kind value meaning "no reflector hit on this row". */
export const REFLECTOR_HIT_KIND_NONE = 0;

export const SHIELD_REFLECTION_ENTITY_PLASMA = 0;
export const SHIELD_REFLECTION_ENTITY_ROCKET = 1;
export const SHIELD_REFLECTION_ENTITY_BEAM = 2;
export const SHIELD_REFLECTION_ENTITY_LASER = 3;

/** Broadphase-only pad (world units) added around mirror panel arrays when
 *  querying reflector candidates. This must not inflate the actual panel
 *  hit: flat shields are single-plane contacts, and reflection vertices
 *  must lie exactly on that panel plane. */
export const SHIELD_PANEL_PROJECTILE_QUERY_PAD = 96;
