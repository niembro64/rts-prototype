// TrimSheetTexture — the procedurally generated hard-surface trim sheet.
//
// One texture holds a vertical stack of reusable detail strips (see
// SurfaceChart3D for the layout). Texturing a surface means choosing a strip
// and a repeat rate, which is the standard hard-surface workflow: it gives
// structured detail — plates, rivets, fluting, bolt rings — at a fixed memory
// cost no matter how many unit types adopt it, and it makes a faction read as
// one faction because every surface draws from the same vocabulary.
//
// CHANNEL PACKING. Alpha is deliberately unused: canvas backing stores are
// premultiplied, so a height field in the alpha channel would crush the colour
// channels wherever it went dark. Three data channels is plenty here because
// the sheet is not a colour map — the instance already carries the unit's
// player/team colour, and the sheet only modulates it.
//
//   R = albedo multiplier, 0.5 encoding neutral (the shader decodes ×2, so the
//       band can both darken to 0 and brighten to 2×)
//   G = height, for the derivative-based bump in SurfaceChartMaterial3D
//   B = bare-metal reveal — where paint has been worn or chipped away. The
//       shader lerps the instance colour toward raw metal BEFORE applying the
//       albedo multiplier, so a scratch through team paint shows steel rather
//       than a lighter shade of team colour. This ordering (substance under
//       livery under wear) is what stops procedural materials reading as
//       decals.
//
// The sheet is authored in LINEAR space and uploaded with NoColorSpace. These
// are multipliers and masks, not colours; running them through an sRGB decode
// would make "0.5 = neutral" false.

import * as THREE from 'three';
import {
  TRIM_BAND_GUTTER_PIXELS,
  TRIM_BAND_ORDER,
  TRIM_SHEET_PIXELS,
  TRIM_SHEET_TEXELS_PER_UNIT,
  bandFeatureCounts,
  bandRectPx,
  packedSheetHeight,
  type TrimBandId,
} from './SurfaceChart3D';
import {
  installDetailTextureDevDownloadHelper,
  makeSeededRng,
  randIn,
} from './detailTextureHelpers';

// R = 0.5 is the neutral albedo multiplier (the shader decodes x2), but bands
// are no longer authored as small departures from it: recesses run to black and
// machined edges to white, and it is the band's MEAN that should land near
// neutral. Compressing everything around 0.5 was what made earlier passes read
// as a flat wash rather than as plating.

/** One deterministic seed per band so editing one band's generator cannot
 *  reshuffle the noise in every other band. */
const BAND_SEEDS: Record<TrimBandId, number> = {
  armorPlate: 0x51a7e1,
  noseFacet: 0x2c9b34,
  sensorDome: 0x7f31d0,
  barrelShaft: 0x1de4a6,
  hydraulicStrut: 0x93b70c,
  boltBoss: 0x4a2f88,
  liveryPiping: 0xc16d21,
  liveryChevron: 0x38e5b9,
};

type Layer = {
  albedo: CanvasRenderingContext2D;
  height: CanvasRenderingContext2D;
  bare: CanvasRenderingContext2D;
};

/** A band's CONTENT rect inside its gutters, in sheet pixels. Bands are packed
 *  rectangles now, so `x` matters as much as `y`. */
type BandRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function gray(value: number): string {
  const byte = Math.round(Math.max(0, Math.min(1, value)) * 255);
  return `rgb(${byte}, ${byte}, ${byte})`;
}

function makeContext(size: number): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  // The gutter fill and the final channel pack both read pixels back, and the
  // browser warns (and stalls) on readback from a GPU-backed canvas.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx === null) throw new Error('[trim sheet] 2D context unavailable');
  return ctx;
}

/** Fill one band's full slot (gutters included) with a flat base so nothing is
 *  ever undefined, then hand back the content rect the band draws into. */
function beginBand(layer: Layer, band: TrimBandId, base: {
  albedo: number;
  height: number;
  bare: number;
}): BandRect {
  const slot = bandRectPx(band);
  const g = TRIM_BAND_GUTTER_PIXELS;
  const rect: BandRect = {
    x: slot.x + g,
    y: slot.y + g,
    width: slot.width - g * 2,
    height: slot.height - g * 2,
  };
  for (const [ctx, value] of [
    [layer.albedo, base.albedo],
    [layer.height, base.height],
    [layer.bare, base.bare],
  ] as [CanvasRenderingContext2D, number][]) {
    ctx.fillStyle = gray(value);
    ctx.fillRect(slot.x, slot.y, slot.width, slot.height);
  }
  return rect;
}

/** Extend the band's own top and bottom content rows into its gutters. Mip
 *  levels average neighbouring rows; without this the bottom of one band
 *  bleeds into the top of the next two or three mips down, and a hull lobe
 *  starts showing nose facets at range. */
function fillBandGutters(layer: Layer, rect: BandRect): void {
  const g = TRIM_BAND_GUTTER_PIXELS;
  for (const ctx of [layer.albedo, layer.height, layer.bare]) {
    // putImageData rather than drawImage. Stretching a one-pixel source with
    // drawImage runs it through the smoothing filter, which samples outside
    // the source and lays down a gradient instead of a copy — the gutter then
    // no longer matches the edge it is meant to extend. putImageData never
    // filters.
    //
    // The u gutters WRAP: a surface's u seam joins its right edge back to its
    // left, so the left gutter is filled from the right content edge and vice
    // versa, and mip filtering across the seam stays continuous. The v gutters
    // just extend, since v runs pole to pole or breech to muzzle and its two
    // ends are not the same place.
    const left = ctx.getImageData(rect.x, rect.y, 1, rect.height);
    const right = ctx.getImageData(rect.x + rect.width - 1, rect.y, 1, rect.height);
    for (let i = 0; i < g; i++) {
      ctx.putImageData(right, rect.x - g + i, rect.y);
      ctx.putImageData(left, rect.x + rect.width + i, rect.y);
    }
    const top = ctx.getImageData(rect.x - g, rect.y, rect.width + g * 2, 1);
    const bottom = ctx.getImageData(
      rect.x - g, rect.y + rect.height - 1, rect.width + g * 2, 1,
    );
    for (let i = 0; i < g; i++) {
      ctx.putImageData(top, rect.x - g, rect.y - g + i);
      ctx.putImageData(bottom, rect.x - g, rect.y + rect.height + i);
    }
  }
}

/** Bevelled panel face. Bright along the top/left, dark along the bottom/right,
 *  with a matching height ramp.
 *
 *  Contrast here is deliberately extreme — recesses go near black and lit edges
 *  near white — because the sheet's R channel is a MULTIPLIER (decoded x2), so
 *  0 kills the unit's colour entirely and 1 doubles it. Timid mid-greys waste
 *  most of that range and read as a flat wash on the model. */
function bevelRect(
  layer: Layer,
  x: number,
  y: number,
  w: number,
  h: number,
  face: number,
  faceHeight: number,
  bevel: number,
): void {
  layer.albedo.fillStyle = gray(face);
  layer.albedo.fillRect(x, y, w, h);
  layer.height.fillStyle = gray(faceHeight);
  layer.height.fillRect(x, y, w, h);

  layer.albedo.fillStyle = gray(Math.min(1, face + bevel));
  layer.albedo.fillRect(x, y, w, 1.4);
  layer.albedo.fillRect(x, y, 1.4, h);
  layer.albedo.fillStyle = gray(Math.max(0, face - bevel));
  layer.albedo.fillRect(x, y + h - 1.4, w, 1.4);
  layer.albedo.fillRect(x + w - 1.4, y, 1.4, h);

  // The height ramp is what the bump actually reads; the albedo bevel above is
  // there so the edge survives at mip levels where the ramp has averaged out.
  layer.height.fillStyle = gray(Math.min(1, faceHeight + 0.16));
  layer.height.fillRect(x, y, w, 1.4);
  layer.height.fillRect(x, y, 1.4, h);
  layer.height.fillStyle = gray(Math.max(0, faceHeight - 0.16));
  layer.height.fillRect(x, y + h - 1.4, w, 1.4);
  layer.height.fillRect(x + w - 1.4, y, 1.4, h);
}

/** A bolt: bright dome, hard contact shadow, bare metal head. Bolts are the
 *  cheapest read at RTS range — they survive to low mips as a value rhythm
 *  long after the individual heads stop resolving. */
/** A bolt: bright dome, hard contact shadow, bare-metal head.
 *
 *  `r` is the bolt's radius in MODEL terms, expressed in band rows; the
 *  horizontal radius is scaled by the band's pixel aspect so it lands round on
 *  the surface instead of as a vertical sliver. Bolts are the cheapest read at
 *  RTS range — they survive to low mips as a value rhythm long after the
 *  individual heads stop resolving — which is why they get the sheet's only
 *  near-white values. */
function rivet(layer: Layer, cx: number, cy: number, r: number): void {
  const disc = (
    ctx: CanvasRenderingContext2D,
    ox: number, oy: number, radius: number, fill: string,
  ) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(cx + ox, cy + oy, radius, 0, Math.PI * 2);
    ctx.fill();
  };
  disc(layer.albedo, 0, r * 0.22, r + 1.3, gray(0.03));
  disc(layer.albedo, 0, 0, r, gray(0.96));
  disc(layer.albedo, r * 0.22, r * 0.22, r * 0.55, gray(0.52));
  disc(layer.height, 0, 0, r, gray(0.96));
  disc(layer.bare, 0, 0, r * 0.85, gray(0.75));
}

/** Evenly spaced bolts across a band's full width. */
function boltRow(
  layer: Layer, rect: BandRect, y: number, count: number, r: number,
): void {
  const spacing = rect.width / count;
  for (let i = 0; i < count; i++) rivet(layer, rect.x + (i + 0.5) * spacing, y, r);
}

/** Recessed seam between panels: near-black gap with a lit lower lip. Runs the
 *  full width so it wraps in u without a seam of its own. */
function seamRow(
  layer: Layer, rect: BandRect, y: number, thickness: number,
): void {
  layer.albedo.fillStyle = gray(0.03);
  layer.albedo.fillRect(rect.x, y, rect.width, thickness);
  layer.albedo.fillStyle = gray(0.86);
  layer.albedo.fillRect(rect.x, y + thickness, rect.width, 1.2);
  layer.height.fillStyle = gray(0.05);
  layer.height.fillRect(rect.x, y, rect.width, thickness);
}

/** A pipe or cable run: dark body, bright top highlight, hard shadow beneath,
 *  and periodic clamps. Horizontal, so on a cylinder it rings the part and on a
 *  sphere it follows a latitude — either way it reads the same from every
 *  direction. */
function pipeRun(
  layer: Layer,
  rect: BandRect,
  y: number,
  thickness: number,
  clamps: number,
  bare: number,
): void {
  layer.albedo.fillStyle = gray(0.05);
  layer.albedo.fillRect(rect.x, y - 1, rect.width, thickness + 2);
  layer.albedo.fillStyle = gray(0.30);
  layer.albedo.fillRect(rect.x, y, rect.width, thickness);
  layer.albedo.fillStyle = gray(0.92);
  layer.albedo.fillRect(rect.x, y + thickness * 0.16, rect.width, thickness * 0.22);
  layer.height.fillStyle = gray(0.94);
  layer.height.fillRect(rect.x, y, rect.width, thickness);
  layer.bare.fillStyle = gray(bare);
  layer.bare.fillRect(rect.x, y, rect.width, thickness);
  const spacing = rect.width / clamps;
  for (let i = 0; i < clamps; i++) {
    const x = rect.x + (i + 0.5) * spacing;
    bevelRect(layer, x - 4, y - 2, 8, thickness + 4, 0.62, 0.98, 0.3);
    layer.bare.fillStyle = gray(0.6);
    layer.bare.fillRect(x - 4, y - 2, 8, thickness + 4);
  }
}

/** A louvered vent block — machinery, not stripes: it is bounded, bolted, and
 *  sits proud of the panel it is mounted on. */
function ventBlock(layer: Layer, x: number, y: number, w: number, h: number): void {
  bevelRect(layer, x, y, w, h, 0.46, 0.86, 0.34);
  const slats = Math.max(3, Math.floor(h / 4));
  for (let i = 0; i < slats; i++) {
    const sy = y + 3 + (i * (h - 6)) / slats;
    layer.albedo.fillStyle = gray(0.02);
    layer.albedo.fillRect(x + 3, sy, w - 6, 1.8);
    layer.albedo.fillStyle = gray(0.75);
    layer.albedo.fillRect(x + 3, sy + 1.8, w - 6, 0.9);
    layer.height.fillStyle = gray(0.06);
    layer.height.fillRect(x + 3, sy, w - 6, 1.8);
  }
  rivet(layer, x + 3, y + 3, 1.5);
  rivet(layer, x + w - 3, y + 3, 1.5);
  rivet(layer, x + 3, y + h - 3, 1.5);
  rivet(layer, x + w - 3, y + h - 3, 1.5);
}

/**
 * One course of bolted panels across the full width.
 *
 * Column widths are jittered and occasionally doubled so the result reads as
 * plating rather than as a grid or a stripe pattern: a uniform subdivision at a
 * uniform value is exactly what makes procedural hard-surface work look like
 * corrugation. Panels sit on a near-black recess, so every gap is a real dark
 * line rather than a slightly darker grey.
 */
function panelCourse(
  layer: Layer,
  rect: BandRect,
  y: number,
  height: number,
  columns: number,
  rng: () => number,
  options: {
    bolts?: boolean;
    vents?: boolean;
    faceJitter?: number;
  } = {},
): void {
  layer.albedo.fillStyle = gray(0.03);
  layer.albedo.fillRect(rect.x, y, rect.width, height);
  layer.height.fillStyle = gray(0.10);
  layer.height.fillRect(rect.x, y, rect.width, height);

  // Widths are drawn at random and then NORMALIZED to sum to exactly the sheet
  // width, so the course tiles in u. Walking left to right with random widths
  // instead leaves a part-width panel at the wrap, which shows up on the model
  // as one mismatched plate edge running the length of the seam.
  const weights: number[] = [];
  const wideFlags: boolean[] = [];
  for (let i = 0; i < columns; i++) {
    const wide = rng() < 0.18;
    wideFlags.push(wide);
    weights.push((wide ? 2 : 1) * randIn(rng, 0.88, 1.12));
  }
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  let x = rect.x;
  for (let index = 0; index < columns; index++) {
    const w = (weights[index] / totalWeight) * rect.width;
    const wide = wideFlags[index];
    // Per-panel value variation leaks into the low harmonics when there are
    // few panels, so courses with big plates keep it tighter — see the
    // baked-directional-shading check.
    const jitter = options.faceJitter ?? 0.13;
    const face = 0.53 + randIn(rng, -jitter, jitter);
    bevelRect(layer, x + 2, y + 2.5, w - 4, height - 5, face, 0.66, 0.30);
    if (options.bolts !== false) {
      // No aspect correction anywhere in this file any more. The sheet has a
      // single texel density on both axes, so a pixel IS a fixed world
      // distance and a circle drawn round arrives round. Every compensation
      // factor that used to be threaded through here existed only because the
      // old strip layout let density differ per band and per axis.
      const inset = Math.min(height * 0.15, 14);
      const insetX = inset;
      const insetY = inset;
      const r = Math.min(height * 0.075, 7);
      // TWO bolts per panel, on one diagonal. Four puts a bolt at every panel
      // corner, and since neighbouring panels share corners the surface ends
      // up ringed with doubled bolts — the single biggest contributor to the
      // busy, gaudy read.
      rivet(layer, x + insetX, y + insetY, r);
      rivet(layer, x + w - insetX, y + height - insetY, r);
    }
    if (options.vents === true && wide && height > 22) {
      ventBlock(layer, x + w * 0.3, y + height * 0.28, w * 0.4, height * 0.44);
    }
    x += w;
  }
}

/** Wear scratch: a bright streak that also writes the bare-metal mask, so it
 *  cuts through whatever paint (substance or livery) is beneath it. */
function scratch(
  layer: Layer,
  rng: () => number,
  rect: BandRect,
  maxLength: number,
): void {
  const x = randIn(rng, rect.x, rect.x + rect.width);
  const y = randIn(rng, rect.y + 2, rect.y + rect.height - 2);
  const len = randIn(rng, maxLength * 0.3, maxLength);
  const angle = randIn(rng, -0.25, 0.25);
  const width = randIn(rng, 0.8, 1.8);
  for (const ctx of [layer.albedo, layer.bare]) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = ctx === layer.albedo ? gray(0.9) : gray(0.85);
    ctx.fillRect(-len / 2, -width / 2, len, width);
    ctx.restore();
  }
}

// ── Bands ────────────────────────────────────────────────────────────────

/** Hull plating: three courses of bolted panels separated by recessed seams,
 *  with a conduit run crossing the middle course. */
function drawArmorPlate(
  layer: Layer, rect: BandRect, rng: () => number, band: TrimBandId,
): void {
  const { columns, courses } = bandFeatureCounts(band);
  const courseHeight = rect.height / courses;
  for (let c = 0; c < courses; c++) {
    const y = rect.y + c * courseHeight;
    panelCourse(layer, rect, y, courseHeight, columns, rng, { vents: c === 1 });
    seamRow(layer, rect, y, 4);
  }
  pipeRun(layer, rect, rect.y + courseHeight * (courses - 0.32), 9, columns, 0.10);
  for (let i = 0; i < 34; i++) scratch(layer, rng, rect, 90);
}

/** Nose armour: heavier, fewer, thicker-bolted plates than the hull, with a
 *  bright lit chine along the leading course. */
function drawNoseFacet(
  layer: Layer, rect: BandRect, rng: () => number, band: TrimBandId,
): void {
  const { columns, courses } = bandFeatureCounts(band);
  const courseHeight = rect.height / courses;
  for (let c = 0; c < courses; c++) {
    const y = rect.y + c * courseHeight;
    panelCourse(layer, rect, y, courseHeight, columns, rng, { faceJitter: 0.06 });
    seamRow(layer, rect, y, 5);
  }
  boltRow(layer, rect, rect.y + courseHeight * 0.5, columns, 5);
  // Lit chine along the leading edge.
  layer.albedo.fillStyle = gray(0.97);
  layer.albedo.fillRect(rect.x, rect.y, rect.width, 5);
  layer.height.fillStyle = gray(0.98);
  layer.height.fillRect(rect.x, rect.y, rect.width, 5);
  layer.bare.fillStyle = gray(0.40);
  layer.bare.fillRect(rect.x, rect.y, rect.width, 5);
  for (let i = 0; i < 24; i++) scratch(layer, rng, rect, 120);
}

// ── Spherical layout helpers ─────────────────────────────────────────────
//
// The sensor dome band maps onto a sphere ONCE, pole to pole (chart tileV = 1),
// which makes it the one band whose horizontal axis is not uniform: at
// band-local fraction `f` the row represents a latitude circle whose
// circumference is only sin(pi*f) of the equator's. Anything drawn at a fixed
// pixel width therefore narrows toward the poles.
//
// f = 0 is the SOUTH pole and f = 1 the NORTH pole. THREE.SphereGeometry emits
// uv.y = 1 at +Y and the shader maps uv.y linearly across the band, so the
// band's first content row is -Y.

/** Latitude scale at band-local fraction `f`: 1 at the equator, 0 at a pole. */
function latitudeScale(f: number): number {
  return Math.sin(Math.PI * f);
}

/**
 * Half-width in pixels of a band of constant great-circle arc half-width
 * `arcHalf` (radians), centred on a meridian, at band fraction `f`.
 *
 * A point at azimuth offset dPhi from the meridian lies at great-circle
 * distance asin(sin(theta)*sin(dPhi)) from it, so holding that distance
 * constant gives dPhi = asin(sin(arcHalf) / sin(theta)). The band therefore
 * FLARES toward the poles — a constant pixel width would instead pinch to
 * nothing there, which is exactly the wedge shape a naive stripe produces.
 *
 * Once sin(theta) drops below sin(arcHalf) the whole latitude circle is within
 * the band: the polar cap is entirely inside it, and the slot closes over the
 * pole as a rounded end rather than a point.
 */
function meridianBandHalfWidthPx(
  f: number, arcHalf: number, bandWidth: number,
): number {
  const s = latitudeScale(f);
  const sinArc = Math.sin(arcHalf);
  if (s <= sinArc) return bandWidth * 0.5;
  return (Math.asin(sinArc / s) / (Math.PI * 2)) * bandWidth;
}

/** Paint one row of a meridian band, wrapping across the band's own width. */
function meridianRow(
  ctx: CanvasRenderingContext2D,
  rect: BandRect,
  y: number,
  centerX: number,
  halfWidthPx: number,
): void {
  if (halfWidthPx >= rect.width * 0.5) {
    ctx.fillRect(rect.x, y, rect.width, 1);
    return;
  }
  // Clipped to the band: bands are packed side by side now, so a slot that
  // wrapped past the edge would paint into whatever was packed next to it.
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, y, rect.width, 1);
  ctx.clip();
  for (const offset of [-rect.width, 0, rect.width]) {
    ctx.fillRect(centerX + offset - halfWidthPx, y, halfWidthPx * 2, 1);
  }
  ctx.restore();
}

/** THE PITCH SLOT.
 *
 *  The barrel assembly pivots through the head's centre and sweeps the full
 *  half-circle from straight up to straight down, so the head needs a channel
 *  it can travel in. Without one the barrels and their team collar just slide
 *  across an unbroken sphere with nothing to slide *in*.
 *
 *  Centred on local +X — SphereGeometry puts +X at u = 0.5 — because that is
 *  the turret's forward axis and the plane the pitch group rotates in.
 *
 *  Width is authored, not derived, because the sheet is shared by every
 *  charted surface and cannot know a particular turret's proportions. For
 *  reference the Formik's head radius is 32 and its barrels are 2 across, so
 *  one barrel subtends 2/32 = 0.0625 rad. A slot that narrow is ~10 px in the
 *  sheet and sub-pixel on screen at any real camera distance, so it is opened
 *  to roughly three barrel widths to stay readable. This is the knob to turn.
 */
const PITCH_SLOT_ARC_HALF_WIDTH = 0.10;
const PITCH_SLOT_CENTER_U = 0.5;

function drawPitchSlot(layer: Layer, rect: BandRect): void {
  const centerX = rect.x + PITCH_SLOT_CENTER_U * rect.width;
  for (let i = 0; i < rect.height; i++) {
    const y = rect.y + i;
    const f = (i + 0.5) / rect.height;
    const half = meridianBandHalfWidthPx(f, PITCH_SLOT_ARC_HALF_WIDTH, rect.width);
    // A machined lip just outside the opening, so the slot reads as a cut edge
    // rather than a painted stripe.
    layer.albedo.fillStyle = gray(0.93);
    meridianRow(layer.albedo, rect, y, centerX, half + 3);
    layer.height.fillStyle = gray(0.9);
    meridianRow(layer.height, rect, y, centerX, half + 3);
    layer.bare.fillStyle = gray(0.55);
    meridianRow(layer.bare, rect, y, centerX, half + 3);
    // The opening itself: black, deeply recessed, and NOT bare metal — a hole
    // is an absence of surface, so nothing shows through it.
    layer.albedo.fillStyle = gray(0.02);
    meridianRow(layer.albedo, rect, y, centerX, half);
    layer.height.fillStyle = gray(0.01);
    meridianRow(layer.height, rect, y, centerX, half);
    layer.bare.fillStyle = gray(0);
    meridianRow(layer.bare, rect, y, centerX, half);
  }
}

/** Sensor housing: bolted panel courses banding the head, small armoured
 *  ports, and the pitch slot the barrel assembly travels in. This band maps
 *  onto the sphere exactly once, so its horizontal axis is a latitude circle
 *  and round features must be compensated by `latitudeScale`. */
function drawSensorDome(
  layer: Layer, rect: BandRect, rng: () => number, band: TrimBandId,
): void {
  // Panel courses. Horizontal here means a full ring around the head, so these
  // read the same from every direction and cost nothing at the poles.
  const { columns, courses } = bandFeatureCounts(band);
  const courseHeight = rect.height / courses;
  for (let c = 0; c < courses; c++) {
    const y = rect.y + c * courseHeight;
    panelCourse(layer, rect, y, courseHeight, columns, rng);
    seamRow(layer, rect, y, 4);
  }
  boltRow(layer, rect, rect.y + courseHeight * 0.5, columns, 5);
  boltRow(layer, rect, rect.y + rect.height - courseHeight * 0.5, columns, 5);

  // Equatorial armoured ports. At the equator one unit of surface is this many
  // times wider in pixels than it is tall, so a circle must be drawn as an
  // ellipse stretched by that factor or it comes out as a smear on the sphere.
  const ports = 5;
  const spacing = rect.width / ports;
  const cy = rect.y + rect.height * 0.5;
  const equatorAspect = (rect.width / (Math.PI * 2)) / (rect.height / Math.PI);
  // Sized from the HORIZONTAL budget, not the vertical one: the compensation
  // multiplies the x radius by the aspect, so picking a comfortable-looking
  // vertical radius first produces ports wider than their own spacing and the
  // ring merges into one black band around the head.
  const portRx = spacing * 0.16;
  const portRy = portRx / equatorAspect;
  const ellipse = (
    ctx: CanvasRenderingContext2D,
    cx: number, rx: number, ry: number, fill: string,
  ) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  };
  for (let i = 0; i < ports; i++) {
    const cx = rect.x + (i + 0.5) * spacing;
    ellipse(layer.albedo, cx, portRx * 1.4, portRy * 1.4, gray(0.9));
    ellipse(layer.albedo, cx, portRx, portRy, gray(0.06));
    ellipse(layer.height, cx, portRx * 1.4, portRy * 1.4, gray(0.9));
    ellipse(layer.height, cx, portRx, portRy, gray(0.1));
    ellipse(layer.bare, cx, portRx * 1.4, portRy * 1.4, gray(0.6));
    for (let b = 0; b < 4; b++) {
      const a = (b / 4) * Math.PI * 2 + 0.4;
      rivet(layer, cx + Math.cos(a) * portRx * 1.9,
        cy + Math.sin(a) * portRy * 1.9,
        4);
    }
  }
  for (let i = 0; i < 16; i++) scratch(layer, rng, rect, 80);

  // Last, so nothing is drawn over the opening.
  drawPitchSlot(layer, rect);
}

/** Barrel: a bolted breech collar at each end, cooling fin stacks, and plated
 *  shaft between them. Horizontal features ring the barrel; the panel courses
 *  repeat many times around it, so nothing here depends on view direction. */
/**
 * Barrel: a pale machined tube, dirtied by use, with a bright muzzle rim and a
 * black bore at the tip.
 *
 * The barrel is the one surface deliberately NOT showing much of the unit's
 * colour: it reads as bare white-hot-worked metal, so `bare` runs high across
 * the whole band and the albedo sits near white. Everything else on the unit
 * goes the other way.
 *
 * ORIENTATION: TurretMesh3D aligns the cylinder's +Y with base->tip, and
 * THREE.CylinderGeometry emits uv.y = 1 at +Y, so v = 1 — the LAST rows of this
 * band — is the muzzle. The breech is the first rows.
 *
 * The flat end cap samples a disc around the band's centre rather than its
 * edge, so the rim and bore below are authored on the tube wall where they are
 * actually seen; at 2 units across, the cap itself is a couple of pixels.
 */
function drawBarrelShaft(layer: Layer, rect: BandRect, rng: () => number): void {
  // Pale machined tube.
  layer.albedo.fillStyle = gray(0.92);
  layer.albedo.fillRect(rect.x, rect.y, rect.width, rect.height);
  layer.height.fillStyle = gray(0.62);
  layer.height.fillRect(rect.x, rect.y, rect.width, rect.height);
  layer.bare.fillStyle = gray(0.92);
  layer.bare.fillRect(rect.x, rect.y, rect.width, rect.height);

  // Used, not pristine: irregular blotches of duller metal along the tube.
  // Wear runs ALONG the tube, as full rings of varying grime, rather than as
  // patches around it. These barrels spin: a patch broad enough to vary across
  // the circumference would sweep past as a rotating dark blotch, which is the
  // same failure mode as a baked highlight even though the grime itself is a
  // real surface feature. Rings are constant in u and so rotate invisibly.
  //
  // Sizes are in WORLD units scaled by the sheet's density, not in raw pixels.
  // The barrel is 2 units across, so its band is only ~38 texels around; a
  // "few pixel" pit authored against a full-width strip is wider here than the
  // entire circumference.
  const px = TRIM_SHEET_TEXELS_PER_UNIT;
  for (let i = 0; i < 70; i++) {
    const y = randIn(rng, rect.y, rect.y + rect.height);
    const h = randIn(rng, 0.3, 1.5) * px;
    layer.albedo.fillStyle = `rgba(0, 0, 0, ${randIn(rng, 0.05, 0.20).toFixed(3)})`;
    layer.albedo.fillRect(rect.x, y, rect.width, h);
  }
  // A few small pits, kept narrow so they stay high-frequency around the tube.
  // Clipped to the band. Bands are packed rectangles in a shared atlas now, so
  // anything drawn in whole-sheet coordinates scatters across its neighbours —
  // these pits were landing on the sensor dome's gutter and breaking its seam.
  layer.albedo.save();
  layer.albedo.beginPath();
  layer.albedo.rect(rect.x, rect.y, rect.width, rect.height);
  layer.albedo.clip();
  for (let i = 0; i < 90; i++) {
    const y = randIn(rng, rect.y, rect.y + rect.height);
    const h = randIn(rng, 0.3, 0.9) * px;
    const x = rect.x + randIn(rng, 0, rect.width);
    const w = randIn(rng, 0.2, 0.5) * px;
    layer.albedo.fillStyle = `rgba(0, 0, 0, ${randIn(rng, 0.08, 0.24).toFixed(3)})`;
    layer.albedo.fillRect(x, y, w, h);
    layer.albedo.fillRect(x - rect.width, y, w, h);
  }
  layer.albedo.restore();
  // Machining marks: fine rings around the tube, high frequency along it.
  for (let y = rect.y; y < rect.y + rect.height; y += 1.2 * px) {
    layer.albedo.fillStyle = `rgba(0, 0, 0, ${randIn(rng, 0.05, 0.16).toFixed(3)})`;
    layer.albedo.fillRect(rect.x, y, rect.width, 1.4);
  }

  // Breech collar and cooling fins at the root.
  //
  // No individual bolts here. The barrel is 2 world units across against 64
  // long, so its band is ~70:1 in pixels per model unit; a bolt sized in model
  // units comes out hundreds of pixels wide, and a row of them merges into one
  // white band. A fastener that small would be sub-pixel on screen regardless,
  // so the collar carries its detail as machined rings instead.
  bevelRect(layer, rect.x, rect.y, rect.width, rect.height * 0.1, 0.55, 0.96, 0.38);
  for (let i = 0; i < 7; i++) {
    const y = rect.y + rect.height * 0.12 + i * 1.5 * px;
    layer.albedo.fillStyle = gray(0.05);
    layer.albedo.fillRect(rect.x, y, rect.width, 0.5 * px);
    layer.albedo.fillStyle = gray(0.98);
    layer.albedo.fillRect(rect.x, y + 0.5 * px, rect.width, 0.34 * px);
    layer.height.fillStyle = gray(0.98);
    layer.height.fillRect(rect.x, y, rect.width, 0.84 * px);
  }

  // Muzzle soot creeping back from the tip.
  const sootRows = Math.floor(rect.height * 0.16);
  for (let i = 0; i < sootRows; i++) {
    const t = 1 - i / sootRows;
    layer.albedo.fillStyle = `rgba(0, 0, 0, ${(t * t * 0.75).toFixed(3)})`;
    layer.albedo.fillRect(rect.x, rect.y + rect.height - 1 - i, rect.width, 1);
  }

  // THE TIP: a bright machined rim, then the black bore at the very end.
  //
  // Sized as a fraction of the BARREL, not of the band. The band's 224 content
  // rows span 64 world units, so a rim that looks generous in the sheet is
  // under three units long on the model and vanishes at any real camera
  // distance. These work out to roughly a 5-unit rim and a 4-unit bore on a
  // barrel 2 units across, which is the proportion a real muzzle has.
  const rimHeight = rect.height * 0.075;
  const boreHeight = rect.height * 0.055;
  const rimY = rect.y + rect.height - rimHeight - boreHeight;
  // A hard shadow line where the rim steps proud of the tube, so the rim reads
  // as a machined lip rather than as the tube simply going pale.
  layer.albedo.fillStyle = gray(0.04);
  layer.albedo.fillRect(rect.x, rimY - 0.7 * px, rect.width, 0.7 * px);
  layer.height.fillStyle = gray(0.1);
  layer.height.fillRect(rect.x, rimY - 0.7 * px, rect.width, 0.7 * px);
  // Bore first, rim outermost. The rim has to be the LAST thing on the tube so
  // it forms a bright lip right at the mouth with the dark bore inside it;
  // drawn the other way round the tube simply ends in black and the rim is
  // lost against the pale shaft.
  layer.albedo.fillStyle = gray(0.01);
  layer.albedo.fillRect(rect.x, rimY, rect.width, boreHeight);
  layer.height.fillStyle = gray(0.0);
  layer.height.fillRect(rect.x, rimY, rect.width, boreHeight);
  // A bore is an opening: nothing shows through it, bare metal included.
  layer.bare.fillStyle = gray(0);
  layer.bare.fillRect(rect.x, rimY, rect.width, boreHeight);

  layer.albedo.fillStyle = gray(0.99);
  layer.albedo.fillRect(rect.x, rimY + boreHeight, rect.width, rimHeight);
  layer.height.fillStyle = gray(0.99);
  layer.height.fillRect(rect.x, rimY + boreHeight, rect.width, rimHeight);
  layer.bare.fillStyle = gray(1);
  layer.bare.fillRect(rect.x, rimY + boreHeight, rect.width, rimHeight);
}

/** Leg strut: bolted end collars, a plated mid section, and hydraulic lines
 *  ringing it.
 *
 *  NO BAKED DIRECTIONAL SHADING. A band feature whose period is the FULL
 *  circumference is a fake light source welded to the geometry: it lands at
 *  fixed angles in the strut's own frame, so as the leg swings you see its dark
 *  side facing the camera and its bright side facing away. That reads as
 *  looking at the back of the segment. Everything here is either constant
 *  around the circumference (collars, pipe rings) or repeats many times around
 *  it (panels, bolts), both of which look the same from every direction. */
function drawHydraulicStrut(
  layer: Layer, rect: BandRect, rng: () => number, band: TrimBandId,
): void {
  const { columns, courses } = bandFeatureCounts(band);
  layer.albedo.fillStyle = gray(0.04);
  layer.albedo.fillRect(rect.x, rect.y, rect.width, rect.height);
  layer.height.fillStyle = gray(0.18);
  layer.height.fillRect(rect.x, rect.y, rect.width, rect.height);

  const collarHeight = rect.height * 0.13;
  const shaftTop = rect.y + collarHeight;
  const shaftHeight = rect.height - collarHeight * 2;
  const midCourses = Math.max(1, courses - 1);
  const courseHeight = shaftHeight / midCourses;
  for (let c = 0; c < midCourses; c++) {
    const y = shaftTop + c * courseHeight;
    panelCourse(layer, rect, y, courseHeight, columns, rng);
    seamRow(layer, rect, y, 5);
  }
  // Only the machined bits are unpainted. Painted plate keeps the unit's
  // colour, which is what carries ownership at a glance.
  layer.bare.fillStyle = gray(0.18);
  layer.bare.fillRect(rect.x, shaftTop, rect.width, shaftHeight);

  pipeRun(layer, rect, shaftTop + shaftHeight * 0.34, 11, columns, 0.06);
  pipeRun(layer, rect, shaftTop + shaftHeight * 0.72, 9, columns, 0.06);

  for (const y of [rect.y, rect.y + rect.height - collarHeight]) {
    bevelRect(layer, rect.x, y, rect.width, collarHeight, 0.55, 0.97, 0.38);
    layer.bare.fillStyle = gray(0.4);
    layer.bare.fillRect(rect.x, y, rect.width, collarHeight);
    boltRow(layer, rect, y + collarHeight * 0.5, columns * 2, 5.5);
  }
  for (let i = 0; i < 16; i++) scratch(layer, rng, rect, 70);
}

/** Bolt boss — joints. A heavy bolted flange ringing the middle with plated
 *  shoulders above and below, so a sphere reads as a machined knuckle. */
function drawBoltBoss(
  layer: Layer, rect: BandRect, rng: () => number, band: TrimBandId,
): void {
  const { columns } = bandFeatureCounts(band);
  // Few panels around a small sphere, so per-panel value variation is held
  // tight: with only a handful of columns it lands in the low harmonics and
  // reads as a light baked into the knuckle rather than as plating.
  const opts = { faceJitter: 0.05 };
  panelCourse(layer, rect, rect.y, rect.height * 0.32, columns, rng, opts);
  panelCourse(layer, rect, rect.y + rect.height * 0.68, rect.height * 0.32, columns, rng, opts);

  const ringHeight = rect.height * 0.38;
  const ringY = rect.y + (rect.height - ringHeight) * 0.5;
  bevelRect(layer, rect.x, ringY, rect.width, ringHeight, 0.6, 0.98, 0.38);
  layer.bare.fillStyle = gray(0.42);
  layer.bare.fillRect(rect.x, ringY, rect.width, ringHeight);
  boltRow(layer, rect, ringY + ringHeight * 0.5, columns, 8);
  seamRow(layer, rect, ringY - 3, 3);
  seamRow(layer, rect, ringY + ringHeight, 3);
  for (let i = 0; i < 14; i++) scratch(layer, rng, rect, 60);
}

/** Team piping — the strap kit's livery.
 *
 *  Livery bands stay near neutral ON AVERAGE on purpose: the whole job of these
 *  surfaces is to read as team colour at a glance, and a band that halves their
 *  brightness destroys exactly the signal it exists to carry. That is a
 *  constraint on the MEAN, not on the range — full-black seams and near-white
 *  bolt heads are what give the team colour something to sit on, so long as
 *  they balance. */
function drawLiveryPiping(
  layer: Layer, rect: BandRect, rng: () => number, band: TrimBandId,
): void {
  const plateCount = bandFeatureCounts(band).columns;
  // Same bolted plating as everything else. Earlier passes drew the plates at
  // the SAME value as the band base, so only the hairline separators showed
  // and the strap read as flat colour — the one surface on the unit with no
  // machinery on it at all.
  const { courses } = bandFeatureCounts(band);
  const courseHeight = rect.height / courses;
  for (let c = 0; c < courses; c++) {
    const y = rect.y + c * courseHeight;
    panelCourse(layer, rect, y, courseHeight, plateCount, rng, { faceJitter: 0.07 });
    seamRow(layer, rect, y, 4);
  }
  // Piped edges: hard black shadow line with a bright machined lip.
  for (const y of [rect.y + 1, rect.y + rect.height - 5]) {
    layer.albedo.fillStyle = gray(0.03);
    layer.albedo.fillRect(rect.x, y, rect.width, 2.5);
    layer.albedo.fillStyle = gray(0.95);
    layer.albedo.fillRect(rect.x, y + 2.5, rect.width, 1.5);
    layer.height.fillStyle = gray(0.98);
    layer.height.fillRect(rect.x, y, rect.width, 4);
    layer.bare.fillStyle = gray(0.3);
    layer.bare.fillRect(rect.x, y, rect.width, 4);
  }
  for (let i = 0; i < 10; i++) scratch(layer, rng, rect, 18);
}

/** Team collar — the turret collar's livery. Same neutrality discipline as the
 *  piping band: bolted plates and hard seams rather than broad value shifts. */
function drawLiveryChevron(
  layer: Layer, rect: BandRect, rng: () => number, band: TrimBandId,
): void {
  const plateCount = bandFeatureCounts(band).columns;

  const { courses } = bandFeatureCounts(band);
  const courseHeight = rect.height / courses;
  for (let c = 0; c < courses; c++) {
    const y = rect.y + c * courseHeight;
    panelCourse(layer, rect, y, courseHeight, plateCount, rng, { faceJitter: 0.07 });
    seamRow(layer, rect, y, 4);
  }
  for (const y of [rect.y, rect.y + rect.height - 4]) {
    layer.albedo.fillStyle = gray(0.03);
    layer.albedo.fillRect(rect.x, y, rect.width, 2.5);
    layer.albedo.fillStyle = gray(0.95);
    layer.albedo.fillRect(rect.x, y + 2.5, rect.width, 1.5);
    layer.height.fillStyle = gray(0.98);
    layer.height.fillRect(rect.x, y, rect.width, 4);
    layer.bare.fillStyle = gray(0.35);
    layer.bare.fillRect(rect.x, y, rect.width, 4);
  }
  for (let i = 0; i < 10; i++) scratch(layer, rng, rect, 16);
}

const BAND_DRAWERS: Record<
  TrimBandId,
  {
    base: { albedo: number; height: number; bare: number };
    draw: (
      layer: Layer,
      rect: BandRect,
      rng: () => number,
      band: TrimBandId,
    ) => void;
  }
> = {
  armorPlate: { base: { albedo: 0.03, height: 0.12, bare: 0.04 }, draw: drawArmorPlate },
  noseFacet: { base: { albedo: 0.03, height: 0.12, bare: 0.06 }, draw: drawNoseFacet },
  sensorDome: { base: { albedo: 0.04, height: 0.15, bare: 0.10 }, draw: drawSensorDome },
  barrelShaft: { base: { albedo: 0.92, height: 0.62, bare: 0.92 }, draw: drawBarrelShaft },
  hydraulicStrut: { base: { albedo: 0.04, height: 0.18, bare: 0.15 }, draw: drawHydraulicStrut },
  boltBoss: { base: { albedo: 0.04, height: 0.18, bare: 0.20 }, draw: drawBoltBoss },
  liveryPiping: { base: { albedo: 0.62, height: 0.74, bare: 0.02 }, draw: drawLiveryPiping },
  liveryChevron: { base: { albedo: 0.60, height: 0.66, bare: 0.02 }, draw: drawLiveryChevron },
};

let cachedCanvas: HTMLCanvasElement | null = null;
let cachedTexture: THREE.CanvasTexture | null = null;

function buildTrimSheetCanvas(): HTMLCanvasElement {
  const packedHeight = packedSheetHeight();
  if (packedHeight > TRIM_SHEET_PIXELS) {
    throw new Error(
      `[trim sheet] band packing needs ${packedHeight} rows but the sheet is `
      + `${TRIM_SHEET_PIXELS}. Lower TRIM_SHEET_TEXELS_PER_UNIT or shrink a `
      + 'surface extent — do not let bands overlap, they would bleed.',
    );
  }
  const layer: Layer = {
    albedo: makeContext(TRIM_SHEET_PIXELS),
    height: makeContext(TRIM_SHEET_PIXELS),
    bare: makeContext(TRIM_SHEET_PIXELS),
  };

  for (const band of TRIM_BAND_ORDER) {
    const spec = BAND_DRAWERS[band];
    const rect = beginBand(layer, band, spec.base);
    spec.draw(layer, rect, makeSeededRng(BAND_SEEDS[band]), band);
    fillBandGutters(layer, rect);
  }

  // Combine the three grayscale layers into the packed RGB sheet. Alpha stays
  // fully opaque — see the channel note at the top of this file.
  const out = makeContext(TRIM_SHEET_PIXELS);
  const albedoData = layer.albedo.getImageData(0, 0, TRIM_SHEET_PIXELS, TRIM_SHEET_PIXELS).data;
  const heightData = layer.height.getImageData(0, 0, TRIM_SHEET_PIXELS, TRIM_SHEET_PIXELS).data;
  const bareData = layer.bare.getImageData(0, 0, TRIM_SHEET_PIXELS, TRIM_SHEET_PIXELS).data;
  const packed = out.createImageData(TRIM_SHEET_PIXELS, TRIM_SHEET_PIXELS);
  const pixels = packed.data;
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = albedoData[i];
    pixels[i + 1] = heightData[i];
    pixels[i + 2] = bareData[i];
    pixels[i + 3] = 255;
  }
  out.putImageData(packed, 0, 0);
  return out.canvas;
}

/** The shared trim sheet. Built once on first use and reused by every material
 *  that adopts a chart, so the whole system costs one texture regardless of
 *  how many unit types are wired into it. */
export function getTrimSheetTexture(): THREE.CanvasTexture {
  if (cachedTexture !== null) return cachedTexture;
  cachedCanvas = buildTrimSheetCanvas();
  const texture = new THREE.CanvasTexture(cachedCanvas);
  // u tiles (bands are authored to wrap horizontally); v must clamp, or a
  // fragment at the edge of a band would filter into its neighbour.
  // Clamp on BOTH axes: charts are rectangles inside a packed atlas and the
  // shader maps uv straight into them, so nothing ever samples outside its own
  // rectangle. Repeat wrapping here would let a chart at the sheet edge fetch
  // from the opposite side.
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  // THE SHEET IS AUTHORED IN CANVAS-ROW SPACE. `bandContentRange` derives each
  // band's v range straight from the rows it was rasterized into, so row r must
  // land at v = r/size. three.js flips textures on upload by default, which
  // maps row r to v = 1 - r/size instead — that MIRRORS the whole band stack,
  // and every chart silently samples the band opposite its own (the hull drew
  // chevrons, the collar drew hull plating). Nothing looks broken; it just
  // looks like the wrong texture, which is far harder to spot.
  texture.flipY = false;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  // Multipliers and masks, not colour: an sRGB decode here would make the
  // "0.5 is neutral" encoding false.
  texture.colorSpace = THREE.NoColorSpace;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  cachedTexture = texture;
  return texture;
}

/** Test seam: builds the sheet without touching the THREE texture cache, so a
 *  contract test can inspect pixels without leaving a live texture behind. */
export function buildTrimSheetCanvasForTest(): HTMLCanvasElement {
  return buildTrimSheetCanvas();
}

export function disposeTrimSheetTexture(): void {
  cachedTexture?.dispose();
  cachedTexture = null;
  cachedCanvas = null;
}

installDetailTextureDevDownloadHelper(
  'trim-sheet.png',
  () => cachedCanvas,
  '__downloadTrimSheet',
);
