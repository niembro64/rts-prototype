// Shared ordering contract for transparent world geometry that also writes
// depth. The order is semantic, not arbitrary:
//   faded entity parts -> water surface -> above-water particles.
// A submerged faded/instanced body must populate color+depth before water
// blends over it; particles draw afterward and use the water depth to reject
// fragments physically below the surface.

export const TRANSPARENT_RENDER_ORDER_3D = {
  entityParts: 4,
  waterSurface: 4.5,
  aboveWaterEffects: 5,
} as const;

