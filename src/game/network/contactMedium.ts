/** Contact-level target-medium facts earned by the recipient's whole team.
 * These bits describe sensor provenance, not target classification: a
 * straddling body may carry both when radar and sonar independently cover it. */
export const CONTACT_MEDIUM_NONE = 0;
export const CONTACT_MEDIUM_AIR = 1 << 0;
export const CONTACT_MEDIUM_WATER = 1 << 1;
export const CONTACT_MEDIUM_BOTH = CONTACT_MEDIUM_AIR | CONTACT_MEDIUM_WATER;

export type ContactMediumMask =
  | typeof CONTACT_MEDIUM_NONE
  | typeof CONTACT_MEDIUM_AIR
  | typeof CONTACT_MEDIUM_WATER
  | typeof CONTACT_MEDIUM_BOTH;

/** Packed minimap-row flags for the sole current contact contract. */
export const MINIMAP_CONTACT_FLAG_RADAR_ONLY = 0x01;
export const MINIMAP_CONTACT_FLAG_WATER = 0x02;
export const MINIMAP_CONTACT_FLAG_AIR = 0x04;
export const MINIMAP_CONTACT_FLAG_ALTITUDE = 0x08;

export function normalizeContactMediumMask(value: number | null | undefined): ContactMediumMask {
  return ((value ?? 0) & CONTACT_MEDIUM_BOTH) as ContactMediumMask;
}

export function contactMediumMaskToMinimapFlags(mask: number): number {
  const normalized = normalizeContactMediumMask(mask);
  return (
    ((normalized & CONTACT_MEDIUM_AIR) !== 0 ? MINIMAP_CONTACT_FLAG_AIR : 0) |
    ((normalized & CONTACT_MEDIUM_WATER) !== 0 ? MINIMAP_CONTACT_FLAG_WATER : 0)
  );
}

export function contactMediumMaskFromMinimapFlags(flags: number): ContactMediumMask {
  let mask = CONTACT_MEDIUM_NONE;
  if ((flags & MINIMAP_CONTACT_FLAG_AIR) !== 0) mask |= CONTACT_MEDIUM_AIR;
  if ((flags & MINIMAP_CONTACT_FLAG_WATER) !== 0) mask |= CONTACT_MEDIUM_WATER;
  return mask as ContactMediumMask;
}
