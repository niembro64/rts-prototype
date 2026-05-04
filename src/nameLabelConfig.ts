// Name-label visuals — billboarded text labels NameLabel3D paints
// above commanders and selected entities. Vertical placement is owned
// by unit/building blueprint `hud` blocks, not by this generic visual
// style file.

/** World-space height of the label sprite. The renderer measures each
 *  text's pixel width on a per-paint basis, sizes the canvas to fit
 *  exactly, and scales the sprite so its world aspect matches the
 *  canvas aspect. That's how characters keep consistent proportions
 *  whether the name is 3 chars or 20. */
export const NAME_LABEL_WORLD_HEIGHT = 8;

/** Font: pixel-aligned, no anti-aliasing fuzz. Drawn at 2× canvas
 *  size for retina-clean edges; the sprite scale handles world fit. */
export const NAME_LABEL_FONT_PX = 22;
export const NAME_LABEL_FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export const NAME_LABEL_FILL_COLOR = '#ffffff';
export const NAME_LABEL_STROKE_COLOR = '#000000';
export const NAME_LABEL_STROKE_WIDTH_PX = 4;

/** Per-paint canvas padding around the rendered text, in canvas
 *  pixels. The horizontal pad keeps the stroke from touching the
 *  texture edge; the vertical pad is the descender / ascender headroom
 *  above and below the glyph row. */
export const NAME_LABEL_CANVAS_PAD_X = 6;
export const NAME_LABEL_CANVAS_PAD_Y = 5;

/** Floor on the per-text canvas width so a single-character label
 *  doesn't render as a microscopic dot at typical zoom. */
export const NAME_LABEL_CANVAS_MIN_WIDTH = 32;
