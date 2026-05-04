// Name-label visuals — billboarded text labels NameLabel3D paints
// above commanders (and any future per-entity rename targets). Kept
// separate from shellConfig because the label is a generic naming
// surface, not a shell-specific affordance — it shows on completed
// commanders, not just construction shells.

/** World-space height of the label's bounding box (sprite Y-extent).
 *  Width is data-driven from the rendered text length, capped by
 *  NAME_LABEL_WORLD_WIDTH_PER_CHAR × text.length. */
export const NAME_LABEL_WORLD_HEIGHT = 8;

/** Distance above the entity's HUD top in world units. Sits ABOVE
 *  the bar stack (HP + 3 resource bars) so a fresh shell shows bars
 *  + name without stacking math. */
export const NAME_LABEL_WORLD_OFFSET_ABOVE = 28;

/** Texture canvas size — wide enough for ~24 chars at the chosen
 *  font, kept square-ish for a compact GPU footprint. */
export const NAME_LABEL_CANVAS_WIDTH = 256;
export const NAME_LABEL_CANVAS_HEIGHT = 32;

/** Font: pixel-aligned, no anti-aliasing fuzz. Drawn at 2× canvas
 *  size for retina-clean edges; the sprite scale handles world fit. */
export const NAME_LABEL_FONT_PX = 22;
export const NAME_LABEL_FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export const NAME_LABEL_FILL_COLOR = '#ffffff';
export const NAME_LABEL_STROKE_COLOR = '#000000';
export const NAME_LABEL_STROKE_WIDTH_PX = 4;

/** Constant world-space width per character. Sprite scale.x is
 *  `chars × widthPerChar` so the label keeps the text crisp at any
 *  zoom — billboard sprites pixelate when scaled past their texture
 *  resolution, so we set a sensible cap rather than reading the
 *  measured pixel width back out of the canvas every frame. */
export const NAME_LABEL_WORLD_WIDTH_PER_CHAR = 5;
