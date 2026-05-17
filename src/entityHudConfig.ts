import type { EntityHudBlueprint } from './types/blueprints';
import entityHudConfig from './entityHudConfig.json';

/** Default per-blueprint HUD bar offsets, in world units above the
 *  entity's visual HUD top. Individual unit/building blueprints can
 *  override this by editing their `hud` block. Names are derived from
 *  the bar stack so they keep a fixed relationship to the bars. */
export const DEFAULT_UNIT_HUD_LAYOUT: EntityHudBlueprint = {
  barsOffsetAboveTop: entityHudConfig.defaultUnitHudLayout.barsOffsetAboveTop,
};

export const DEFAULT_BUILDING_HUD_LAYOUT: EntityHudBlueprint = {
  barsOffsetAboveTop: entityHudConfig.defaultBuildingHudLayout.barsOffsetAboveTop,
};

/** Distance between stacked HUD bars: HP, energy, mana, metal. */
export const ENTITY_HUD_BAR_STACK_GAP = entityHudConfig.barStackGap;

/** The full status stack is HP + three resource build bars. Name
 *  labels sit above this full potential stack so they do not move when
 *  a shell gains or loses visible resource bars. */
export const ENTITY_HUD_BAR_STACK_ROWS = entityHudConfig.barStackRows;

/** Visual air gap between the top edge of the full bar stack and the
 *  bottom edge of the name label sprite. */
export const ENTITY_HUD_NAME_GAP_ABOVE_BARS = entityHudConfig.nameGapAboveBars;
