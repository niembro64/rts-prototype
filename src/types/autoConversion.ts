// Auto-conversion slider points for resource converter buildings.
//
// Each resource carries ONE per-player point, a fraction of its storage:
// above it the resource converts away toward the other resource, and
// conversion may never fill a resource past its own point. The two
// directions are therefore mutually exclusive each tick and conversion
// can never create convert-away surplus, so no ping-pong burns tax.
// The Rust kernel (economy_compute_converter_transfer_value) is the
// authority on these semantics; UI sliders and the sanitizer share the
// clamp below so every surface agrees on the legal range.

export const DEFAULT_AUTO_CONVERSION_ENERGY_AT = 0.75;
export const DEFAULT_AUTO_CONVERSION_METAL_AT = 0.75;

/** Non-finite input fails CLOSED (1 = never convert this resource away),
 *  mirroring the Rust kernel's economy_normalized_fraction. */
export function clampAutoConversionThreshold(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}
