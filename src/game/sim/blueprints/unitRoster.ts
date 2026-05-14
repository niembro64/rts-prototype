/** Buildable unit roster.
 *
 *  Kept dependency-free so UI config, server spawning, factories, and
 *  selection panels can all derive their unit inventory from the same
 *  source without pulling in the full blueprint/config graph. */
export const BUILDABLE_UNIT_IDS = [
  'jackal',
  'lynx',
  'badger',
  'mongoose',
  'mammoth',
  'tick',
  'tarantula',
  'loris',
  'daddy',
  'widow',
  'formik',
  'hippo',
  'hovercraft',
] as const;

export type BuildableUnitId = typeof BUILDABLE_UNIT_IDS[number];

const BUILDABLE_UNIT_ID_SET = new Set<string>(BUILDABLE_UNIT_IDS);
const DEFAULT_DISABLED_DEMO_UNIT_IDS = new Set<string>([
  'daddy',
]);

export function isDemoUnitEnabledByDefault(unitId: string): boolean {
  return !DEFAULT_DISABLED_DEMO_UNIT_IDS.has(unitId);
}

export function isBuildableUnitId(unitId: string): unitId is BuildableUnitId {
  return BUILDABLE_UNIT_ID_SET.has(unitId);
}
