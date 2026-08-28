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
// THE SIGN IS RAISED, NOT PRINTED. The letters are extruded geometry cut
// from the caption's own glyph mask, and nothing is drawn over them: the
// relief IS the sign. They rise to a fixed relief above WHICHEVER IS HIGHER,
// the ground they stand on or the liquid surface. On a dry headland that is
// exactly the relief the letters always had. On a submerged one they run up
// out of the water like pilings, readable from above the surface and still
// readable from under it.
//
// NOTHING IS DRAWN AROUND THE GLYPHS EITHER. The mask is filled, never
// stroked. An outline pen belongs to printed text — white letters needing a
// dark edge to survive any background — and drawing one into the mask costs
// twice: it fattens every glyph by half the pen on every side, and it eats
// that same distance OUT of every counter. At the shipped 9px title pen the
// capital A's counter came out at 1.5% of the glyph instead of 9%, the
// byline's counters closed completely, and neighbouring title letters fused
// into one extruded island rather than eleven. The letters get their outline
// from their own extruded sides, which is the whole point of standing them
// up; the face colour and the side colour are that outline.
//
// A painted caption used to cap that relief, and it is gone deliberately. It
// drew the same text a second time across the letter tops, so the shapes the
// mask had already cut were never seen as themselves — and they are the
// better read, because raised glyphs take the scene's own light, shade their
// own sides, and turn with the camera the way every other thing on the map
// does, while a flat print stays the same picture from every angle. What the
// texture bought was filtering at whole-map zoom, where it was mipmapped and
// anisotropic and the triangles are not; the frame's MSAA is what covers the
// glyph edges there now, which is the ordinary way this renderer resolves
// every other silhouette on the map.
//
// Exact presets show their authored name; changed settings show CUSTOM and
// continue describing the live map. The caption block is MEASURED at its
// authored scale rather than rasterized there; the one raster left is the
// supersampled glyph mask the extrusion traces. Per-frame work is one terrain
// sample, and only to notice when the annex's altitude has changed under the
// sign.

import * as THREE from 'three';
import { MAP_PRESET_LABEL_RENDER_CONFIG } from '@/config';
import { COLORS } from '@/colorsConfig';
import { NAME_LABEL_FONT_FAMILY } from '@/nameLabelConfig';
import { getTerrainMeshHeight } from '../sim/Terrain';
import { getLiquidSurfaceLevel } from '../sim/worldSurfaceState';
import {
  groupNestedContours,
  traceAlphaMaskContours,
  type MaskPolygon,
} from './AlphaMaskExtrusion3D';
import {
  mapInfoAnnexFlatHeight,
  mapInfoAnnexFlatSurfaceY,
  mapInfoAnnexSeamDeviation,
  mapInfoAnnexSettledDepth,
  resolveMapInfoAnnexCaptionArea,
  resolveMapInfoAnnexFootprint,
  type MapInfoAnnexFootprint,
} from './MapInfoAnnex3D';
import type { MapPresetLabelCaption, MapPresetLabelTarget } from './presetMapLabel';

const STYLE = {
  titleFontPx: MAP_PRESET_LABEL_RENDER_CONFIG.titleFontPx,
  infoFontPx: MAP_PRESET_LABEL_RENDER_CONFIG.infoFontPx,
  bylineFontPx: MAP_PRESET_LABEL_RENDER_CONFIG.bylineFontPx,
  lineGapPx: MAP_PRESET_LABEL_RENDER_CONFIG.lineGapPx,
  sectionGapPx: MAP_PRESET_LABEL_RENDER_CONFIG.sectionGapPx,
  ruleThicknessPx: MAP_PRESET_LABEL_RENDER_CONFIG.ruleThicknessPx,
  ruleWidthInkFraction: MAP_PRESET_LABEL_RENDER_CONFIG.ruleWidthInkFraction,
  canvasPadPx: MAP_PRESET_LABEL_RENDER_CONFIG.canvasPadPx,
  fontWeight: MAP_PRESET_LABEL_RENDER_CONFIG.fontWeight,
  captionMarginAnnexDepthFraction:
    MAP_PRESET_LABEL_RENDER_CONFIG.captionMarginAnnexDepthFraction,
  captionFlatToleranceAnnexDepthFraction:
    MAP_PRESET_LABEL_RENDER_CONFIG.captionFlatToleranceAnnexDepthFraction,
  captionMinAspect: MAP_PRESET_LABEL_RENDER_CONFIG.captionMinAspect,
  letterReliefTitleFraction: MAP_PRESET_LABEL_RENDER_CONFIG.letterReliefTitleFraction,
  letterMaskSupersample: MAP_PRESET_LABEL_RENDER_CONFIG.letterMaskSupersample,
  letterMaskSimplifyPx: MAP_PRESET_LABEL_RENDER_CONFIG.letterMaskSimplifyPx,
  faceColor: COLORS.ui.mapPresetLabel.faceColor,
  sideColor: COLORS.ui.mapPresetLabel.sideColor,
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

/** Clearance between the letters' base and the flat table they stand on, as a
 *  fraction of the caption block. Only enough to settle depth-fighting
 *  between two coplanar surfaces: the letters must still read as standing on
 *  the headland, not as hovering over it. */
const LETTER_SURFACE_LIFT_FRACTION = 0.004;
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
/** How far the fit may open or close the authored leading to land the block
 *  on the table's shape. Past the ceiling the sections read as scattered rows
 *  rather than as one sign; under the floor they crowd into a slab. An even
 *  margin is worth a good deal of leading, but not either of those. */
const MAX_LEADING_FACTOR = 1.6;
const MIN_LEADING_FACTOR = 0.55;

/** Ink metrics a 2D context can decline to report. The font box is the
 *  fallback, and these are its usable split — enough to keep a caption laid
 *  out rather than collapsed if `actualBoundingBox*` is missing. */
const ASSUMED_ASCENT_FONT_FRACTION = 0.62;
const ASSUMED_DESCENT_FONT_FRACTION = 0.22;

/** The weight is authored rather than pinned at `bold`, because the letters
 *  are read as SOLIDS: their dark sides show around every glyph from any
 *  camera above grazing, so a face that measures right flat comes out heavier
 *  on the headland. The knob is what lets that be judged in the world instead
 *  of on a canvas. */
function fontString(pixels: number): string {
  return `${STYLE.fontWeight} ${pixels}px ${NAME_LABEL_FONT_FAMILY}`;
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
  /** Painted extents relative to the stack — the glyphs' own ink. */
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

type MapPresetLabelPlacement = {
  readonly worldWidth: number;
  readonly worldHeight: number;
  readonly centerX: number;
  readonly centerZ: number;
  readonly annex: MapInfoAnnexFootprint;
};

/** The patch of headland the caption may cover: everything past the annex's
 *  ramp off the coast, inset by the authored margin on every side.
 *  `settledDepth` is how much of that ramp actually rises — zero on a map
 *  whose edge is already at the table's altitude, which hands the sign the
 *  whole headland. Exported so the contract test can hold "entirely on the
 *  flat part, entirely off the map" without WebGL. */
export function resolveMapPresetLabelCaptionBox(
  mapWidth: number,
  mapHeight: number,
  settledDepth: number,
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
    settledDepth,
    STYLE.captionMinAspect,
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
  settledDepth: number,
): MapPresetLabelPlacement {
  const box = resolveMapPresetLabelCaptionBox(mapWidth, mapHeight, settledDepth);
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

/** What one candidate wrap measures, and what the fit would have to do to it
 *  to land the block on the table's shape. */
type CaptionWrapCandidate = {
  /** Block width and height in canvas pixels, at the authored leading. */
  readonly width: number;
  readonly height: number;
  /** The leading in that height — the part the fit can move. */
  readonly leading: number;
};

/**
 * Which wrap to set the settings in, and by how much to open or close its
 * leading.
 *
 * The gap around the sign is even on all four sides only when the block and
 * the inset table share an aspect. The wrap is the coarse knob — one row
 * fewer is a much wider block, and the steps between row counts are big — so
 * the leading is what closes the remaining distance, opened or CLOSED as
 * needed. Setting a page a little tight to make it fit is what a compositor
 * does; refusing to and leaving a band of empty rock down two sides is not.
 *
 * Among the wraps the leading can reach, the winner is the one that needs the
 * least of it, so the authored rhythm survives wherever it can. If none is
 * reachable the block closest in shape is set at its authored leading and the
 * fit simply centres it.
 *
 * Pure, and exported for the contract test.
 */
export function pickCaptionSetting(
  candidates: readonly CaptionWrapCandidate[],
  targetAspect: number,
  minLeadingFactor: number,
  maxLeadingFactor: number,
): { readonly index: number; readonly leadingFactor: number } {
  let best = -1;
  let bestFactor = 1;
  let bestDistortion = Infinity;
  let closest = -1;
  let closestAspectDistance = Infinity;
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    if (!(candidate.height > 0) || !(candidate.width > 0)) continue;
    const aspectDistance = Math.abs(
      Math.log(candidate.width / candidate.height) - Math.log(targetAspect),
    );
    if (aspectDistance < closestAspectDistance) {
      closestAspectDistance = aspectDistance;
      closest = index;
    }
    if (!(candidate.leading > 0)) continue;
    const wantedHeight = candidate.width / targetAspect;
    const factor = 1 + (wantedHeight - candidate.height) / candidate.leading;
    if (factor < minLeadingFactor || factor > maxLeadingFactor) continue;
    const distortion = Math.abs(Math.log(factor));
    if (distortion < bestDistortion) {
      bestDistortion = distortion;
      bestFactor = factor;
      best = index;
    }
  }
  if (best >= 0) return { index: best, leadingFactor: bestFactor };
  return { index: Math.max(0, closest), leadingFactor: 1 };
}

/**
 * Break `fields` into at most `rowCount` rows, BALANCED: the widest row is as
 * narrow as it can be for that many rows.
 *
 * Not greedy-to-an-average, which is what a first pass reaches for and what
 * makes a caption look thrown together — packing to the average overshoots on
 * every row, so the early rows come out short, the fields run out, and the
 * last row is left holding everything nobody else took. Binary-searching the
 * row WIDTH instead and packing to it is the classic minimum-largest-row
 * partition, and it is also exactly what a page does: rows of one measure,
 * broken where the measure runs out.
 *
 * A row count the fields cannot actually be split into comes back as fewer
 * rows, which is honest — that setting simply is the shorter one.
 *
 * Exported for the contract test.
 */
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

  const packAt = (limit: number): string[][] => {
    const packed: string[][] = [];
    let current: string[] = [];
    let currentWidth = 0;
    for (let index = 0; index < fields.length; index++) {
      const added = (current.length > 0 ? separator : 0) + widths[index];
      if (current.length > 0 && currentWidth + added > limit) {
        packed.push(current);
        current = [];
        currentWidth = widths[index];
      } else {
        currentWidth += added;
      }
      current.push(fields[index]);
    }
    if (current.length > 0) packed.push(current);
    return packed;
  };

  let tooNarrow = widths.reduce((widest, width) => Math.max(widest, width), 0);
  let wideEnough = widths.reduce((sum, width) => sum + width, 0)
    + separator * (fields.length - 1);
  // 32 halvings resolves the measure to well under a pixel at any font size
  // this caption uses, and the packing is a single pass over eleven fields.
  for (let step = 0; step < 32; step++) {
    const middle = (tooNarrow + wideEnough) / 2;
    if (packAt(middle).length <= rows) wideEnough = middle;
    else tooNarrow = middle;
  }
  return packAt(wideEnough).map((row) => row.join(FIELD_SEPARATOR));
}

/** The sign's identity: what a repaint has to differ in to be worth doing. */
function captionKey(caption: MapPresetLabelCaption): string | null {
  if (caption === null) return null;
  const parts = [caption.title, ...caption.info, ...caption.byline]
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join('\n') : null;
}

export class MapPresetLabel3D implements MapPresetLabelTarget {
  /** Measuring context only — the block is laid out against it and the mask
   *  is painted into its own canvas, so this one is never rasterized. */
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  /** The letters' local frame: +X block-right, +Y block-up, +Z world-up. */
  private readonly group = new THREE.Group();
  private readonly letterMaterials: readonly THREE.MeshStandardMaterial[];
  private letterMesh: THREE.Mesh | null = null;
  private readonly mapWidth: number;
  private readonly mapHeight: number;
  /** The annex is a pure function of the map size, and update() runs every
   *  frame — resolve it once. */
  private readonly annex: MapInfoAnnexFootprint;
  private lastKey: string | null = null;
  private caption: NonNullable<MapPresetLabelCaption> =
    { title: '', info: [], byline: [] };
  /** The chosen setting of the current caption: its wrapped rows and the
   *  leading the fit added, so the supersampled glyph mask repaints the SAME
   *  block instead of re-deciding the wrap at a different measured width. */
  private items: readonly CaptionItem[] = [];
  /** The chosen block at scale 1, in the units the layout measures in. It is
   *  the sign's proportions — what the placement fits to the table — and the
   *  scale the authored font sizes are relative to. */
  private blockWidthPx = 1;
  private blockHeightPx = 1;
  private lastAnnexSurfaceY = Number.NaN;
  /** How much of the annex's ramp off the coast actually rises, in world
   *  units — resampled with the altitude, because both come from the same
   *  terrain that may not be baked yet. */
  private settledDepth = 0;
  private destroyed = false;
  private updateStride = 0;

  constructor(parent: THREE.Object3D, mapWidth: number, mapHeight: number) {
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
    this.annex = resolveMapInfoAnnexFootprint(mapWidth, mapHeight);
    const ctx = this.canvas.getContext('2d');
    if (ctx === null) throw new Error('MapPresetLabel3D requires a 2D canvas context');
    this.ctx = ctx;

    // The face reads the sign and the sides outline it. That is why they are
    // named for the surfaces they land on rather than for a fill and a pen:
    // there is no pen any more, and the dark is geometry.
    this.letterMaterials = [
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(STYLE.faceColor),
        roughness: 0.55,
        metalness: 0,
      }),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(STYLE.sideColor),
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
    this.caption = caption;
    this.refreshSettledDepth();
    this.setBlock(caption);
    // New text, new glyph mask. placeSign only traces when there is no
    // letter mesh, which is what keeps an altitude-only re-seat cheap.
    this.disposeLetterMesh();
    this.placeSign();
  }

  /** The annex's altitude is the terrain's, and the terrain mesh is not
   *  necessarily baked when this renderer is built — a lobby preview, a
   *  battle restart, or simply a caption that arrived first. One sample per
   *  frame is what keeps the sign standing ON the headland rather than at
   *  whatever height the analytic fallback guessed before the bake landed. */
  update(): void {
    if (this.destroyed || this.lastKey === null) return;
    // P2-06: the altitude only moves once, when the terrain bake lands.
    // Sampling every ~half second keeps the sign re-seating within a blink
    // of the bake without paying a terrain sample per display frame forever.
    if (++this.updateStride < 30) return;
    this.updateStride = 0;
    const surfaceY = this.annexSurfaceY();
    if (Math.abs(surfaceY - this.lastAnnexSurfaceY) <= ANNEX_ALTITUDE_EPSILON) return;
    // The altitude moved, so the coast under the seam did too: the block's
    // target shape can have changed with it, and that is a re-set, not a
    // re-seat. Rare — once, when the bake lands.
    const previousSettledDepth = this.settledDepth;
    this.refreshSettledDepth();
    if (Math.abs(this.settledDepth - previousSettledDepth) > ANNEX_ALTITUDE_EPSILON) {
      this.disposeLetterMesh();
      this.setBlock(this.caption);
    }
    this.placeSign();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.group.parent?.remove(this.group);
    this.disposeLetterMesh();
    for (const material of this.letterMaterials) material.dispose();
  }

  // ── internals ──

  /** The rendered altitude of the annex's flat table — the plane the letters
   *  stand on. */
  private annexSurfaceY(): number {
    return mapInfoAnnexFlatSurfaceY(this.annexFlatHeight());
  }

  private annexFlatHeight(): number {
    return mapInfoAnnexFlatHeight(this.annex, (x, z) =>
      getTerrainMeshHeight(x, z, this.mapWidth, this.mapHeight));
  }

  /** Resample the coast the annex grows out of and turn the worst rise it
   *  hands the ramp into the distance the caption has to stand back. */
  private refreshSettledDepth(): void {
    const flatHeight = this.annexFlatHeight();
    this.settledDepth = mapInfoAnnexSettledDepth(
      this.annex,
      mapInfoAnnexSeamDeviation(this.annex, flatHeight, (x, z) =>
        getTerrainMeshHeight(x, z, this.mapWidth, this.mapHeight)),
      this.annex.depth * STYLE.captionFlatToleranceAnnexDepthFraction,
    );
  }

  /** Set the caption and measure what came out. The block is only measured
   *  here — the sign's proportions and the scale its authored font sizes are
   *  relative to — because the only pixels this renderer needs are the
   *  supersampled ones the glyph trace paints for itself. */
  private setBlock(caption: NonNullable<MapPresetLabelCaption>): void {
    this.items = this.chooseSetting(caption);
    const layout = this.layOutCaption(this.ctx, this.items, 1);
    this.blockWidthPx = layout.canvasWidth;
    this.blockHeightPx = layout.canvasHeight;
  }

  /**
   * Choose the setting: wrap the settings across rows, then open or close the
   * leading until the block is exactly the shape of the table it has to fill.
   *
   * Both halves exist for the same reason — the gap around the sign is even
   * on all four sides only when the block and the inset table share an
   * aspect, and the block's aspect is what the wrap and the leading control.
   * The leading is shared out in proportion to the gaps already there, so
   * whichever way it moves, the sections keep their relative weight.
   */
  private chooseSetting(caption: NonNullable<MapPresetLabelCaption>): CaptionItem[] {
    const box = resolveMapPresetLabelCaptionBox(
      this.mapWidth,
      this.mapHeight,
      this.settledDepth,
    );
    const targetAspect = box.depth > 0 ? box.width / box.depth : 1;
    const measureInfo = (text: string): number => {
      this.ctx.font = fontString(STYLE.infoFontPx);
      return this.ctx.measureText(text).width;
    };

    const settings: CaptionItem[][] = [];
    const candidates: CaptionWrapCandidate[] = [];
    for (let rowCount = 1; rowCount <= Math.max(1, caption.info.length); rowCount++) {
      const items = buildCaptionItems(caption, measureInfo, rowCount);
      const layout = this.layOutCaption(this.ctx, items, 1);
      settings.push(items);
      candidates.push({
        width: layout.canvasWidth,
        height: layout.canvasHeight,
        leading: items.reduce((sum, item) => sum + item.gapAbovePx, 0),
      });
    }
    const chosen = pickCaptionSetting(
      candidates,
      targetAspect,
      MIN_LEADING_FACTOR,
      MAX_LEADING_FACTOR,
    );
    const items = settings[chosen.index];
    if (Math.abs(chosen.leadingFactor - 1) < 1e-6) return items;
    return items.map((item) => ({
      ...item,
      gapAbovePx: item.gapAbovePx * chosen.leadingFactor,
    }));
  }

  /**
   * Measure the block: where every item's box sits in the stack, how far its
   * painted ink reaches out of that box, and the canvas that holds the lot
   * with THE SAME padding on all four sides.
   *
   * The padding is measured against the INK — the union of the glyphs' own
   * bounding boxes — and not against the font box. A font box carries
   * internal leading above the caps and below the baseline that no glyph in
   * this caption fills, so padding against it puts a visibly fatter gap over
   * the title than beside it.
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
      const middle = top + fontPx / 2;
      const inkTop = middle
        - finiteOr(metrics.actualBoundingBoxAscent, fontPx * ASSUMED_ASCENT_FONT_FRACTION);
      const inkBottom = middle
        + finiteOr(metrics.actualBoundingBoxDescent, fontPx * ASSUMED_DESCENT_FONT_FRACTION);
      // Centred text reports its extents either side of the pen. The block is
      // symmetric about that pen, so the wider side is what the padding has
      // to clear on BOTH sides for the gap to come out even.
      const halfWidth = finiteOr(metrics.width, 0) / 2;
      const inkHalfWidth = Math.max(
        finiteOr(metrics.actualBoundingBoxLeft, halfWidth),
        finiteOr(metrics.actualBoundingBoxRight, halfWidth),
      );
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

  /** Paint `items` into `canvas` at `scale`, resizing it to fit. The only
   *  caller is the glyph trace, which paints the block supersampled; because
   *  it is the same stack the layout measured at scale 1, mask coordinates
   *  map onto the sign's local frame by ratio alone. */
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
    ctx.fillStyle = STYLE.faceColor;
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
      const middle = layout.originY + box.top + box.height / 2;
      ctx.fillText(box.item.text, layout.originX, middle);
    }
  }

  /** Seat the sign on the annex: size it to the flat table, stand it at the
   *  table's altitude, and stretch the letters up to clear the liquid. */
  private placeSign(): void {
    const placement = resolveMapPresetLabelPlacement(
      this.mapWidth,
      this.mapHeight,
      this.blockWidthPx / this.blockHeightPx,
      this.settledDepth,
    );
    const surfaceY = this.annexSurfaceY();
    this.lastAnnexSurfaceY = surfaceY;
    this.group.position.set(placement.centerX, surfaceY, placement.centerZ);

    const letterLift = placement.worldHeight * LETTER_SURFACE_LIFT_FRACTION;
    // The relief is the letters' authored height above what they stand on.
    // What they stand on is the higher of the ground and the liquid surface —
    // lava and water share WATER_LEVEL — so a caption on a shallow seabed
    // still reads from a boat's-eye view instead of drowning in the shallows.
    const relief =
      (placement.worldHeight / this.blockHeightPx) *
      STYLE.titleFontPx *
      STYLE.letterReliefTitleFraction;
    const letterDepth = Math.max(surfaceY, getLiquidSurfaceLevel()) + relief - surfaceY;

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
      this.letterMesh.position.z = letterLift;
      this.letterMesh.scale.z = letterDepth;
    }
    // The letters are the whole sign, so a mask that traced nothing leaves
    // nothing to show. Resolved here rather than at the caption doorway
    // because the trace runs from here, and a re-set on a terrain bake can
    // land on a different answer than the first one did.
    this.group.visible = this.letterMesh !== null;
  }

  /** Trace the painted glyphs and extrude them ONE UNIT off the sign plane.
   *  Returns null when the mask yields nothing to extrude (an empty caption,
   *  or a context that cannot hand back pixels), which leaves no sign at all
   *  — the relief is the only thing the headland carries. */
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
          LETTER_MASK_MAX_TEXELS / Math.max(1, this.blockWidthPx * this.blockHeightPx),
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
    // CENTRES, so the half-texel shift keeps the glyphs centred in the block
    // the placement sized, rather than off by half a mask texel.
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
