// Shared ordering contract for transparent world geometry that also writes
// depth. The order is semantic, not arbitrary:
//   faded entity parts -> through-water effects -> water surface ->
//   above-water particles.
// A submerged faded/instanced body must populate color+depth before water
// blends over it. Effects that must remain visible through water draw before
// the water plane while still testing against solid depth; effects that must
// be clipped by the surface draw afterward.

export const TRANSPARENT_RENDER_ORDER_3D = {
  entityParts: 4,
  throughWaterEffects: 4.25,
  waterSurface: 4.5,
  aboveWaterEffects: 5,
} as const;
