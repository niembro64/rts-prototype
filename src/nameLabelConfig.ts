// Name-label visuals — billboarded text labels NameLabel3D paints
// above commanders and selected entities. Vertical placement is owned
// by unit/building blueprint `hud` blocks, not by this generic visual
// style file.

import nameLabelConfig from './nameLabelConfig.json';
import { COLORS } from './colorsConfig';

/** On-screen height of the label sprite, in pixels. Billboarded labels
 *  are rescaled per frame so they hold this pixel height at any zoom
 *  (see HudScreenSpace). The renderer measures each text's pixel width
 *  per-paint, sizes the canvas to fit, and scales the sprite so its
 *  aspect matches the canvas — so characters keep consistent
 *  proportions whether the name is 3 chars or 20. */
export const NAME_LABEL_PX_HEIGHT = nameLabelConfig.pxHeight;

/** Font: pixel-aligned, no anti-aliasing fuzz. Drawn at 2× canvas
 *  size for retina-clean edges; the sprite scale handles world fit. */
export const NAME_LABEL_FONT_PX = nameLabelConfig.fontPx;
export const NAME_LABEL_FONT_FAMILY = nameLabelConfig.fontFamily;

export const NAME_LABEL_FILL_COLOR = COLORS.ui.nameLabel.fillColor;
export const NAME_LABEL_STROKE_COLOR = COLORS.ui.nameLabel.strokeColor;
export const NAME_LABEL_STROKE_WIDTH_PX = nameLabelConfig.strokeWidthPx;

/** Per-paint canvas padding around the rendered text, in canvas
 *  pixels. The horizontal pad keeps the stroke from touching the
 *  texture edge; the vertical pad is the descender / ascender headroom
 *  above and below the glyph row. */
export const NAME_LABEL_CANVAS_PAD_X = nameLabelConfig.canvasPadX;
export const NAME_LABEL_CANVAS_PAD_Y = nameLabelConfig.canvasPadY;

/** Floor on the per-text canvas width so a single-character label
 *  doesn't render as a microscopic dot at typical zoom. */
export const NAME_LABEL_CANVAS_MIN_WIDTH = nameLabelConfig.canvasMinWidth;
