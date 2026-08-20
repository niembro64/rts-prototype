// MapPresetLabel3D — the stock-preset caption, standing on the map's info
// annex: the headland grown out of the middle of the map edge behind ally
// team 0 (see MapInfoAnnex3D). It is map signage, not HUD: it lives in world
// space, so it is occluded by terrain and grows/shrinks with zoom like
// everything else.
//
// The ground under it is no longer this file's problem. The caption used to
// carry its own plinth because it stood in the void outside the map; the
// annex is real map now — emitted into the terrain mesh, covered by the same
// liquid box — so all that is left here is the sign itself.
//
// THE SIGN IS SET, NOT LISTED. It is one centred block in three sections —
// the preset's name, the live map's settings, then a rule and the byline —
// and the settings arrive as FIELDS rather than as rows, because how many
// share a row is the one free variable that lets the block match the shape
// of the table it stands on. Only a block of the table's own aspect can be
// inset by the same gap on all four sides, so the painter wraps the fields,
// then grows the section leading, until the two aspects agree. What comes
// out is the largest type the headland can carry with an even margin.
//
// The letters are EXTRUDED off the annex's flat table rather than only
// printed on it, and they always rise to a fixed relief above WHICHEVER IS
// HIGHER, the ground they stand on or the liquid surface. On a dry headland
// that is exactly the relief the letters always had. On a submerged one they
// run up out of the water like pilings, readable from above the surface and
// still readable from under it. The painted caption caps them (mipmapped and
// anisotropic, which raw geometry is not), so at whole-map zoom the sign is
// carried by a filtered texture rather than by shimmering triangles.
//
// Exact presets show their authored name; changed settings show CUSTOM and
// continue describing the live map. One pooled canvas is repainted on change;
// per-frame work is one terrain sample, and only to notice when the annex's
// altitude has changed under the sign.

import * as THREE from 'three';
import { MAP_PRESET_LABEL_RENDER_CONFIG } from '@/config';
import { COLORS } from '@/colorsConfig';
import { NAME_LABEL_FONT_FAMILY } from '@/nameLabelConfig';
import { getTerrainMeshHeight, WATER_LEVEL } from '../sim/Terrain';
import {
  groupNestedContours,
  traceAlphaMaskContours,
  type MaskPolygon,
} from './AlphaMaskExtrusion3D';
import {
  mapInfoAnnexFlatHeight,
  mapInfoAnnexFlatSurfaceY,
  resolveMapInfoAnnexCaptionArea,
  resolveMapInfoAnnexFootprint,
  type MapInfoAnnexFootprint,
} from './MapInfoAnnex3D';
import type { MapPresetLabelCaption, MapPresetLabelTarget } from './presetMapLabel';
import { TRANSPARENT_RENDER_ORDER_3D } from './TransparentRenderOrder3D';

const STYLE = {
  titleFontPx: MAP_PRESET_LABEL_RENDER_CONFIG.titleFontPx,
  infoFontPx: MAP_PRESET_LABEL_RENDER_CONFIG.infoFontPx,
  bylineFontPx: MAP_PRESET_LABEL_RENDER_CONFIG.bylineFontPx,
  lineGapPx: MAP_PRESET_LABEL_RENDER_CONFIG.lineGapPx,
  sectionGapPx: MAP_PRESET_LABEL_RENDER_CONFIG.sectionGapPx,
  ruleThicknessPx: MAP_PRESET_LABEL_RENDER_CONFIG.ruleThicknessPx,
  ruleWidthInkFraction: MAP_PRESET_LABEL_RENDER_CONFIG.ruleWidthInkFraction,
  canvasPadPx: MAP_PRESET_LABEL_RENDER_CONFIG.canvasPadPx,
  strokeWidthPx: MAP_PRESET_LABEL_RENDER_CONFIG.strokeWidthPx,
  captionMarginAnnexDepthFraction:
    MAP_PRESET_LABEL_RENDER_CONFIG.captionMarginAnnexDepthFraction,
  letterReliefTitleFraction: MAP_PRESET_LABEL_RENDER_CONFIG.letterReliefTitleFraction,
  letterMaskSupersample: MAP_PRESET_LABEL_RENDER_CONFIG.letterMaskSupersample,
  letterMaskSimplifyPx: MAP_PRESET_LABEL_RENDER_CONFIG.letterMaskSimplifyPx,
  fillColor: COLORS.ui.mapPresetLabel.fillColor,
  strokeColor: COLORS.ui.mapPresetLabel.strokeColor,
};

/** Ground-plane orientation for a readable sign at the default -Z camera.
 *  Canvas right maps toward world -X (screen-right from that camera), canvas
 *  top maps toward +Z (into the map), and the painted front normal points
 *  upward — so the letters extrude up local +Z. The annex's own `signYaw` is
 *  added to the Z term, which after the lay-flat X turn is a yaw about world
 *  +Y: it carries this frame onto whichever map edge the annex landed on, and
 *  is zero for the edge ally team 0 actually backs onto. */
export const MAP_PRESET_LABEL_ROTATION_X = -Math.PI / 2;
export const MAP_PRESET_LABEL_ROTATION_Z = Math.PI;

/** What separates two settings sharing a row. Wide enough to read as a list
 *  rather than as one run-on sentence. */
const FIELD_SEPARATOR = '  ·  ';

/** Clearance between the stacked coplanar layers of the sign (letter tops and
 *  the painted caption), as a fraction of the caption block. Only enough to
 *  settle depth-fighting: the caption must still read as printed on the
 *  letters, not as a second sign hovering over them. */
const CAPTION_SURFACE_LIFT_FRACTION = 0.004;
/** Alpha the glyph mask is cut at, and the smallest loop worth extruding
 *  (square mask pixels — well under a period's counter, well over the specks
 *  antialiasing leaves behind). */
const LETTER_MASK_THRESHOLD = 0.5;
const LETTER_MASK_MINIMUM_AREA = 6;
/** Mask budget. Supersampling buys smoother outlines but the trace is per
 *  texel, and the caption is repainted whenever a lobby setting changes. */
const LETTER_MASK_MAX_TEXELS = 2_400_000;
/** How far the annex's altitude has to move before the sign is re-seated.
 *  The terrain sample is exact once the baked mesh is installed; this only
 *  keeps float noise from re-seating the sign every frame. */
const ANNEX_ALTITUDE_EPSILON = 1e-3;
/** Ceiling on the leading the fit may add, as a multiple of the leading the
 *  block already has. Past it the sections read as scattered rows rather
 *  than as one sign, and an even margin is not worth that. */
const MAX_LEADING_GROWTH = 1.6;

/** Ink metrics a 2D context can decline to report. The font box is the
 *  fallback, and these are its usable split — enough to keep a caption laid
 *  out rather than collapsed if `actualBoundingBox*` is missing. */
const ASSUMED_ASCENT_FONT_FRACTION = 0.62;
const ASSUMED_DESCENT_FONT_FRACTION = 0.22;

function fontString(pixels: number): string {
  return `bold ${pixels}px ${NAME_LABEL_FONT_FAMILY}`;
}

/** The outline scales with its row, so a byline is not swallowed by a stroke
 *  authored for the title. */
function strokeWidthForFont(fontPx: number): number {
  return STYLE.strokeWidthPx * (fontPx / STYLE.titleFontPx);
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** One line of the block, or the divider between its sections. `gapAbovePx`
 *  is the space between this item's box and the previous one's — CSS margins
 *  rather than baselines, so a section break is one number instead of a
 *  special case in the stack arithmetic. */
type CaptionItem =
  | {
    readonly kind: 'text';
    readonly text: string;
    readonly fontPx: number;
    readonly gapAbovePx: number;
  }
  | {
    readonly kind: 'rule';
    readonly gapAbovePx: number;
  };

type CaptionItemBox = {
  readonly item: CaptionItem;
  /** Top of the item's own box in the stack, before centring. */
  readonly top: number;
  readonly height: number;
  /** Painted extents relative to the stack, stroke included. */
  readonly inkTop: number;
  readonly inkBottom: number;
};

type CaptionLayout = {
  readonly boxes: readonly CaptionItemBox[];
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  /** Where the pen goes: every item is centred on this column. */
  readonly originX: number;
  /** Added to an item's box top to land it on the canvas. */
  readonly originY: number;
  readonly ruleHalfWidth: number;
};

export type MapPresetLabelPlacement = {
  readonly worldWidth: number;
  readonly worldHeight: number;
  readonly centerX: number;
  readonly centerZ: number;
  readonly annex: MapInfoAnnexFootprint;
};

/** The patch of headland the caption may cover: the annex's flat table inset
 *  by the authored margin on every side. Exported so the contract test can
 *  hold "entirely on the flat part, entirely off the map" without WebGL. */
export function resolveMapPresetLabelCaptionBox(
  mapWidth: number,
  mapHeight: number,
): {
  readonly annex: MapInfoAnnexFootprint;
  readonly centerX: number;
  readonly centerZ: number;
  readonly width: number;
  readonly depth: number;
} {
  const annex = resolveMapInfoAnnexFootprint(mapWidth, mapHeight);
  const area = resolveMapInfoAnnexCaptionArea(
    annex,
    annex.depth * STYLE.captionMarginAnnexDepthFraction,
  );
  return { annex, ...area };
}

/** Fit a block of `canvasAspect` into that box, largest size that keeps the
 *  aspect, centred. The painter's whole job is to arrive here with an aspect
 *  that already matches the box, in which case the fit is exact and the gap
 *  around the sign is the authored margin on all four sides. */
export function resolveMapPresetLabelPlacement(
  mapWidth: number,
  mapHeight: number,
  canvasAspect: number,
): MapPresetLabelPlacement {
  const box = resolveMapPresetLabelCaptionBox(mapWidth, mapHeight);
  const aspect = Math.max(1e-6, canvasAspect);
  const worldHeight = Math.min(box.depth, box.width / aspect);
  return {
    worldWidth: worldHeight * aspect,
    worldHeight,
    centerX: box.centerX,
    centerZ: box.centerZ,
    annex: box.annex,
  };
}

/**
 * Which wrap to set the settings in, given what each candidate's block shape
 * would be. The chosen block is the NARROWEST one still at least as wide as
 * the table wants: leading can always be added to bring a too-wide block down
 * onto the target aspect, and nothing can take leading away from a too-tall
 * one. Falls back to the widest candidate when every wrap comes out taller
 * than the table, which only happens for a caption of very few fields.
 *
 * Pure, and exported for the contract test.
 */
export function pickCaptionWrap(
  candidateAspects: readonly number[],
  targetAspect: number,
): number {
  let best = -1;
  for (let index = 0; index < candidateAspects.length; index++) {
    if (candidateAspects[index] < targetAspect) continue;
    if (best < 0 || candidateAspects[index] < candidateAspects[best]) best = index;
  }
  if (best >= 0) return best;
  for (let index = 0; index < candidateAspects.length; index++) {
    if (best < 0 || candidateAspects[index] > candidateAspects[best]) best = index;
  }
  return Math.max(0, best);
}

/** Break `fields` into `rowCount` rows of near-equal measured width, in
 *  order. Greedy against the average row width, which is what a flex-wrap
 *  container of that width would do. Exported for the contract test. */
export function wrapCaptionFields(
  measure: (text: string) => number,
  fields: readonly string[],
  rowCount: number,
): string[] {
  if (fields.length === 0) return [];
  const rows = Math.max(1, Math.min(Math.floor(rowCount), fields.length));
  if (rows === 1) return [fields.join(FIELD_SEPARATOR)];
  const separator = measure(FIELD_SEPARATOR);
  const widths = fields.map(measure);
  const total = widths.reduce((sum, width) => sum + width, 0)
    + separator * (fields.length - 1);
  const target = total / rows;

  const out: string[] = [];
  let current: string[] = [];
  let currentWidth = 0;
  for (let index = 0; index < fields.length; index++) {
    const added = (current.length > 0 ? separator : 0) + widths[index];
    const rowsLeft = rows - out.length;
    const fieldsLeft = fields.length - index;
    // Break when this field would push the row past its share — but never so
    // early that a later row would be left with nothing to set. Breaking here
    // closes one row and leaves `fieldsLeft` fields to fill `rowsLeft - 1`,
    // so that is exactly the count this field has to clear.
    if (
      current.length > 0 &&
      currentWidth + added > target &&
      rowsLeft > 1 &&
      fieldsLeft >= rowsLeft - 1
    ) {
      out.push(current.join(FIELD_SEPARATOR));
      current = [];
      currentWidth = 0;
    }
    current.push(fields[index]);
    currentWidth += (current.length > 1 ? separator : 0) + widths[index];
  }
  if (current.length > 0) out.push(current.join(FIELD_SEPARATOR));
  return out;
}

/** The sign's identity: what a repaint has to differ in to be worth doing. */
function captionKey(caption: MapPresetLabelCaption): string | null {
  if (caption === null) return null;
  const parts = [caption.title, ...caption.info, ...caption.byline]
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join('\n') : null;
}

export class MapPresetLabel3D implements MapPresetLabelTarget {
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly captionGeometry = new THREE.PlaneGeometry(1, 1);
  private readonly captionMaterial: THREE.MeshBasicMaterial;
  private readonly captionMesh: THREE.Mesh;
  /** Local frame shared by caption and letters: +X canvas-right, +Y
   *  canvas-up, +Z world-up. */
  private readonly group = new THREE.Group();
  private readonly letterMaterials: readonly THREE.MeshStandardMaterial[];
  private letterMesh: THREE.Mesh | null = null;
  private readonly mapWidth: number;
  private readonly mapHeight: number;
  /** The annex is a pure function of the map size, and update() runs every
   *  frame — resolve it once. */
  private readonly annex: MapInfoAnnexFootprint;
  private lastKey: string | null = null;
  /** The chosen setting of the current caption: its wrapped rows and the
   *  leading the fit added, so the supersampled glyph mask repaints the SAME
   *  block instead of re-deciding the wrap at a different measured width. */
  private items: readonly CaptionItem[] = [];
  private lastAnnexSurfaceY = Number.NaN;
  private destroyed = false;

  constructor(
    parent: THREE.Object3D,
    renderer: THREE.WebGLRenderer,
    mapWidth: number,
    mapHeight: number,
  ) {
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
    this.annex = resolveMapInfoAnnexFootprint(mapWidth, mapHeight);
    const ctx = this.canvas.getContext('2d');
    if (ctx === null) throw new Error('MapPresetLabel3D requires a 2D canvas context');
    this.ctx = ctx;
    // Non-zero starter dimensions keep the CanvasTexture valid before the
    // first paint; every paint resizes the canvas to fit its own text.
    this.canvas.width = 2;
    this.canvas.height = 2;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    // Whole-map zoom minifies this hard, so mipmaps + anisotropy are what
    // keep the caption from shimmering into noise as the camera pulls out.
    // The extruded letters have no such filtering, which is exactly why the
    // painted caption caps them instead of being replaced by them.
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    this.captionMaterial = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      // The quad caps the letters, so the camera sees whichever face the
      // current pitch presents — including from below, through the water.
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.captionMesh = new THREE.Mesh(this.captionGeometry, this.captionMaterial);
    this.captionMesh.name = 'MapPresetLabelCaption';
    this.captionMesh.renderOrder = TRANSPARENT_RENDER_ORDER_3D.aboveWaterEffects;

    // Letter faces take the painted fill colour and letter sides the painted
    // outline colour, so the relief reads as the printed caption lifted off
    // the annex rather than as a second, differently coloured sign.
    this.letterMaterials = [
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(STYLE.fillColor),
        roughness: 0.55,
        metalness: 0,
      }),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(STYLE.strokeColor),
        roughness: 0.8,
        metalness: 0,
      }),
    ];

    this.group.name = 'MapPresetLabel';
    // The extra half-turn around Z corrects both mirrored reading order and
    // vertical stacking after the group is laid flat on the ground plane.
    this.group.rotation.x = MAP_PRESET_LABEL_ROTATION_X;
    this.group.rotation.z = MAP_PRESET_LABEL_ROTATION_Z + this.annex.signYaw;
    this.group.visible = false;
    this.group.add(this.captionMesh);
    parent.add(this.group);
  }

  setMapPresetLabelCaption(caption: MapPresetLabelCaption): void {
    if (this.destroyed) return;
    const key = captionKey(caption);
    if (key === this.lastKey) return;
    this.lastKey = key;
    if (caption === null || key === null) {
      this.group.visible = false;
      return;
    }
    this.items = this.setCaption(caption);
    this.paint(this.ctx, this.canvas, this.items, 1);
    // New text, new glyph mask. placeSign only traces when there is no
    // letter mesh, which is what keeps an altitude-only re-seat cheap.
    this.disposeLetterMesh();
    this.placeSign();
    this.group.visible = true;
  }

  /** The annex's altitude is the terrain's, and the terrain mesh is not
   *  necessarily baked when this renderer is built — a lobby preview, a
   *  battle restart, or simply a caption that arrived first. One sample per
   *  frame is what keeps the sign standing ON the headland rather than at
   *  whatever height the analytic fallback guessed before the bake landed. */
  update(): void {
    if (this.destroyed || this.lastKey === null) return;
    const surfaceY = this.annexSurfaceY();
    if (Math.abs(surfaceY - this.lastAnnexSurfaceY) <= ANNEX_ALTITUDE_EPSILON) return;
    this.placeSign();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.group.parent?.remove(this.group);
    this.disposeLetterMesh();
    this.texture.dispose();
    this.captionMaterial.dispose();
    this.captionGeometry.dispose();
    for (const material of this.letterMaterials) material.dispose();
  }

  // ── internals ──

  /** The rendered altitude of the annex's flat table — the plane the letters
   *  stand on. */
  private annexSurfaceY(): number {
    return mapInfoAnnexFlatSurfaceY(
      mapInfoAnnexFlatHeight(this.annex, (x, z) =>
        getTerrainMeshHeight(x, z, this.mapWidth, this.mapHeight)),
    );
  }

  /**
   * Choose the setting: wrap the settings across rows, then add leading until
   * the block is exactly the shape of the table it has to fill.
   *
   * Both halves exist for the same reason. The gap around the sign is even on
   * all four sides only when the block and the inset table share an aspect,
   * and the block's aspect is what the wrap and the leading control. The wrap
   * is the coarse knob — one row fewer is a much wider block — and the
   * leading is the fine one. The leading only ever GROWS, so the type never
   * shrinks to buy the match.
   */
  private setCaption(caption: NonNullable<MapPresetLabelCaption>): CaptionItem[] {
    const box = resolveMapPresetLabelCaptionBox(this.mapWidth, this.mapHeight);
    const targetAspect = box.depth > 0 ? box.width / box.depth : 1;
    const measureInfo = (text: string): number => {
      this.ctx.font = fontString(STYLE.infoFontPx);
      return this.ctx.measureText(text).width;
    };

    const candidates: Array<{ items: CaptionItem[]; aspect: number }> = [];
    for (let rowCount = 1; rowCount <= Math.max(1, caption.info.length); rowCount++) {
      const items = buildCaptionItems(caption, measureInfo, rowCount);
      const layout = this.layOutCaption(this.ctx, items, 1);
      candidates.push({
        items,
        aspect: layout.canvasHeight > 0 ? layout.canvasWidth / layout.canvasHeight : 1,
      });
    }
    const chosen = candidates[
      pickCaptionWrap(candidates.map((candidate) => candidate.aspect), targetAspect)
    ];

    // The block is now at least as wide as the table wants; the depth it is
    // short becomes leading, shared out in proportion to the gaps already
    // there so the sections keep their relative weight.
    const layout = this.layOutCaption(this.ctx, chosen.items, 1);
    const wantedHeight = layout.canvasWidth / Math.max(1e-6, targetAspect);
    const extra = wantedHeight - layout.canvasHeight;
    const gapTotal = chosen.items.reduce((sum, item) => sum + item.gapAbovePx, 0);
    if (extra <= 0 || gapTotal <= 0 || extra > gapTotal * MAX_LEADING_GROWTH) {
      return chosen.items;
    }
    const growth = 1 + extra / gapTotal;
    return chosen.items.map((item) => ({ ...item, gapAbovePx: item.gapAbovePx * growth }));
  }

  /**
   * Measure the block: where every item's box sits in the stack, how far its
   * painted ink reaches out of that box, and the canvas that holds the lot
   * with THE SAME padding on all four sides.
   *
   * The padding is measured against the INK — the union of the glyphs' own
   * bounding boxes, grown by the outline stroked around them — and not
   * against the font box. A font box carries internal leading above the caps
   * and below the baseline that no glyph in this caption fills, so padding
   * against it puts a visibly fatter gap over the title than beside it.
   */
  private layOutCaption(
    ctx: CanvasRenderingContext2D,
    items: readonly CaptionItem[],
    scale: number,
  ): CaptionLayout {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const boxes: CaptionItemBox[] = [];
    let cursor = 0;
    let textInkHalfWidth = 0;
    for (const item of items) {
      cursor += item.gapAbovePx * scale;
      const top = cursor;
      if (item.kind === 'rule') {
        const height = STYLE.ruleThicknessPx * scale;
        cursor += height;
        boxes.push({ item, top, height, inkTop: top, inkBottom: top + height });
        continue;
      }
      const fontPx = item.fontPx * scale;
      ctx.font = fontString(fontPx);
      const metrics = ctx.measureText(item.text);
      const halfStroke = 0.5 * strokeWidthForFont(fontPx);
      const middle = top + fontPx / 2;
      const inkTop = middle
        - finiteOr(metrics.actualBoundingBoxAscent, fontPx * ASSUMED_ASCENT_FONT_FRACTION)
        - halfStroke;
      const inkBottom = middle
        + finiteOr(metrics.actualBoundingBoxDescent, fontPx * ASSUMED_DESCENT_FONT_FRACTION)
        + halfStroke;
      // Centred text reports its extents either side of the pen. The block is
      // symmetric about that pen, so the wider side is what the padding has
      // to clear on BOTH sides for the gap to come out even.
      const halfWidth = finiteOr(metrics.width, 0) / 2;
      const inkHalfWidth = Math.max(
        finiteOr(metrics.actualBoundingBoxLeft, halfWidth),
        finiteOr(metrics.actualBoundingBoxRight, halfWidth),
      ) + halfStroke;
      textInkHalfWidth = Math.max(textInkHalfWidth, inkHalfWidth);
      cursor += fontPx;
      boxes.push({ item, top, height: fontPx, inkTop, inkBottom });
    }

    const padding = STYLE.canvasPadPx * scale;
    let inkTop = 0;
    let inkBottom = 0;
    for (let index = 0; index < boxes.length; index++) {
      if (index === 0) {
        inkTop = boxes[index].inkTop;
        inkBottom = boxes[index].inkBottom;
        continue;
      }
      inkTop = Math.min(inkTop, boxes[index].inkTop);
      inkBottom = Math.max(inkBottom, boxes[index].inkBottom);
    }
    return {
      boxes,
      canvasWidth: Math.max(1, Math.ceil(2 * (textInkHalfWidth + padding))),
      canvasHeight: Math.max(1, Math.ceil(inkBottom - inkTop + 2 * padding)),
      originX: textInkHalfWidth + padding,
      originY: padding - inkTop,
      ruleHalfWidth: 0.5 * STYLE.ruleWidthInkFraction * 2 * textInkHalfWidth,
    };
  }

  /** Paint `items` into `canvas` at `scale`, resizing it to fit. Scale 1 is
   *  the caption texture; the glyph trace repaints the identical stack
   *  larger, so mask coordinates map onto the caption quad by ratio alone. */
  private paint(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    items: readonly CaptionItem[],
    scale: number,
  ): void {
    const layout = this.layOutCaption(ctx, items, scale);
    // Resizing wipes both the pixels and the context state, so everything the
    // draw depends on is set after it.
    canvas.width = layout.canvasWidth;
    canvas.height = layout.canvasHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = STYLE.strokeColor;
    ctx.fillStyle = STYLE.fillColor;
    for (const box of layout.boxes) {
      if (box.item.kind === 'rule') {
        ctx.fillRect(
          layout.originX - layout.ruleHalfWidth,
          layout.originY + box.top,
          2 * layout.ruleHalfWidth,
          box.height,
        );
        continue;
      }
      const fontPx = box.item.fontPx * scale;
      ctx.font = fontString(fontPx);
      ctx.lineWidth = strokeWidthForFont(fontPx);
      const middle = layout.originY + box.top + box.height / 2;
      ctx.strokeText(box.item.text, layout.originX, middle);
      ctx.fillText(box.item.text, layout.originX, middle);
    }
    if (canvas === this.canvas) this.texture.needsUpdate = true;
  }

  /** Seat the sign on the annex: size it to the flat table, stand it at the
   *  table's altitude, and stretch the letters up to clear the liquid. */
  private placeSign(): void {
    const placement = resolveMapPresetLabelPlacement(
      this.mapWidth,
      this.mapHeight,
      this.canvas.width / this.canvas.height,
    );
    const surfaceY = this.annexSurfaceY();
    this.lastAnnexSurfaceY = surfaceY;
    this.group.position.set(placement.centerX, surfaceY, placement.centerZ);
    this.captionMesh.scale.set(placement.worldWidth, placement.worldHeight, 1);

    const captionLift = placement.worldHeight * CAPTION_SURFACE_LIFT_FRACTION;
    // The relief is the letters' authored height above what they stand on.
    // What they stand on is the higher of the ground and the liquid surface —
    // lava and water share WATER_LEVEL — so a caption on a shallow seabed
    // still reads from a boat's-eye view instead of drowning in the shallows.
    const relief =
      (placement.worldHeight / this.canvas.height) *
      STYLE.titleFontPx *
      STYLE.letterReliefTitleFraction;
    const letterDepth = Math.max(surfaceY, WATER_LEVEL) + relief - surfaceY;

    if (this.letterMesh === null) {
      // The extrusion is authored one unit deep and SCALED to the depth the
      // liquid asks for, so re-seating the sign when the terrain bake lands
      // is a transform write rather than a second glyph trace.
      const letters = this.buildLetterGeometry(placement);
      if (letters !== null) {
        const mesh = new THREE.Mesh(
          letters,
          this.letterMaterials as THREE.MeshStandardMaterial[],
        );
        mesh.name = 'MapPresetLabelLetters';
        this.letterMesh = mesh;
        this.group.add(mesh);
      }
    }
    if (this.letterMesh !== null) {
      this.letterMesh.position.z = captionLift;
      this.letterMesh.scale.z = letterDepth;
    }
    // The painted caption caps the relief instead of lying under it. Printed
    // on the ground it showed around every raised letter as a second, offset
    // copy of the same text; capping the letters puts it exactly where their
    // top faces already are, so it reads as the letters' own printed surface
    // and still carries the sign at whole-map zoom, where mipmaps beat
    // geometry.
    this.captionMesh.position.set(
      0,
      0,
      this.letterMesh === null ? captionLift : captionLift + letterDepth + captionLift,
    );
  }

  /** Trace the painted glyphs and extrude them ONE UNIT off the sign plane.
   *  Returns null when the mask yields nothing to extrude (an empty caption,
   *  or a context that cannot hand back pixels) — the printed caption alone
   *  is then still a complete, readable sign. */
  private buildLetterGeometry(
    placement: MapPresetLabelPlacement,
  ): THREE.ExtrudeGeometry | null {
    const maskCanvas = document.createElement('canvas');
    const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
    if (maskCtx === null) return null;
    const supersample = Math.max(
      1,
      Math.min(
        STYLE.letterMaskSupersample,
        Math.sqrt(
          LETTER_MASK_MAX_TEXELS / Math.max(1, this.canvas.width * this.canvas.height),
        ),
      ),
    );
    this.paint(maskCtx, maskCanvas, this.items, supersample);
    let pixels: ImageData;
    try {
      pixels = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    } catch {
      return null;
    }
    const texelCount = maskCanvas.width * maskCanvas.height;
    const alpha = new Uint8Array(texelCount);
    for (let i = 0; i < texelCount; i++) alpha[i] = pixels.data[i * 4 + 3];

    const contours = traceAlphaMaskContours(
      alpha,
      maskCanvas.width,
      maskCanvas.height,
      {
        threshold: LETTER_MASK_THRESHOLD,
        simplifyTolerance: STYLE.letterMaskSimplifyPx * supersample,
        minimumArea: LETTER_MASK_MINIMUM_AREA * supersample * supersample,
      },
    );
    const groups = groupNestedContours(contours);
    if (groups.length === 0) return null;

    // Mask texel to local sign units. Integer mask coordinates are texel
    // CENTRES, so the half-texel shift keeps the extrusion registered on the
    // caption printed over it.
    const toLocal = (polygon: MaskPolygon): THREE.Vector2[] => {
      const points: THREE.Vector2[] = [];
      for (let i = 0; i < polygon.length; i += 2) {
        points.push(new THREE.Vector2(
          ((polygon[i] + 0.5) / maskCanvas.width - 0.5) * placement.worldWidth,
          (0.5 - (polygon[i + 1] + 0.5) / maskCanvas.height) * placement.worldHeight,
        ));
      }
      return points;
    };
    const shapes = groups.map((group) => {
      const shape = new THREE.Shape(toLocal(group.outline));
      shape.holes = group.holes.map((hole) => new THREE.Path(toLocal(hole)));
      return shape;
    });

    return new THREE.ExtrudeGeometry(shapes, {
      depth: 1,
      bevelEnabled: false,
      steps: 1,
      // The outlines are already polylines; there is no curve left to
      // resample, and a higher count would only duplicate their points.
      curveSegments: 1,
    });
  }

  private disposeLetterMesh(): void {
    if (this.letterMesh === null) return;
    this.group.remove(this.letterMesh);
    this.letterMesh.geometry.dispose();
    this.letterMesh = null;
  }
}

/** The item stack for one candidate wrap, at scale 1: title, the settings
 *  wrapped into `infoRowCount` rows, then the rule and the byline. */
function buildCaptionItems(
  caption: NonNullable<MapPresetLabelCaption>,
  measureInfo: (text: string) => number,
  infoRowCount: number,
): CaptionItem[] {
  const items: CaptionItem[] = [];
  if (caption.title.length > 0) {
    items.push({
      kind: 'text',
      text: caption.title,
      fontPx: STYLE.titleFontPx,
      gapAbovePx: 0,
    });
  }
  const infoRows = wrapCaptionFields(
    measureInfo,
    caption.info.filter((field) => field.length > 0),
    infoRowCount,
  );
  for (let row = 0; row < infoRows.length; row++) {
    items.push({
      kind: 'text',
      text: infoRows[row],
      fontPx: STYLE.infoFontPx,
      gapAbovePx:
        items.length === 0 ? 0 : row === 0 ? STYLE.sectionGapPx : STYLE.lineGapPx,
    });
  }
  const byline = caption.byline.filter((entry) => entry.length > 0);
  if (byline.length > 0) {
    if (items.length > 0) items.push({ kind: 'rule', gapAbovePx: STYLE.sectionGapPx });
    items.push({
      kind: 'text',
      text: byline.join(FIELD_SEPARATOR),
      fontPx: STYLE.bylineFontPx,
      gapAbovePx: items.length === 0 ? 0 : STYLE.sectionGapPx,
    });
  }
  return items;
}
