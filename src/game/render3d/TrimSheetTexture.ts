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
  TRIM_BAND_PIXELS,
  TRIM_SHEET_PIXELS,
  type TrimBandId,
} from './SurfaceChart3D';
import {
  installDetailTextureDevDownloadHelper,
  makeSeededRng,
  randIn,
} from './detailTextureHelpers';

/** Neutral albedo multiplier — R at this level leaves the instance colour
 *  untouched. Bands are authored as departures from it. */
const NEUTRAL = 0.5;

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
function beginBand(layer: Layer, index: number, base: {
  albedo: number;
  height: number;
  bare: number;
}): BandRect {
  const slotY = index * TRIM_BAND_PIXELS;
  const rect: BandRect = {
    x: 0,
    y: slotY + TRIM_BAND_GUTTER_PIXELS,
    width: TRIM_SHEET_PIXELS,
    height: TRIM_BAND_PIXELS - TRIM_BAND_GUTTER_PIXELS * 2,
  };
  layer.albedo.fillStyle = gray(base.albedo);
  layer.albedo.fillRect(0, slotY, TRIM_SHEET_PIXELS, TRIM_BAND_PIXELS);
  layer.height.fillStyle = gray(base.height);
  layer.height.fillRect(0, slotY, TRIM_SHEET_PIXELS, TRIM_BAND_PIXELS);
  layer.bare.fillStyle = gray(base.bare);
  layer.bare.fillRect(0, slotY, TRIM_SHEET_PIXELS, TRIM_BAND_PIXELS);
  return rect;
}

/** Extend the band's own top and bottom content rows into its gutters. Mip
 *  levels average neighbouring rows; without this the bottom of one band
 *  bleeds into the top of the next two or three mips down, and a hull lobe
 *  starts showing nose facets at range. */
function fillBandGutters(layer: Layer, index: number, rect: BandRect): void {
  const slotY = index * TRIM_BAND_PIXELS;
  for (const ctx of [layer.albedo, layer.height, layer.bare]) {
    // putImageData rather than drawImage. Stretching a one-pixel-tall source
    // with drawImage runs it through the smoothing filter, which samples
    // outside the source row and lays down a gradient instead of a copy — the
    // gutter then no longer matches the edge it is supposed to extend.
    // putImageData never filters.
    const topRow = ctx.getImageData(0, rect.y, TRIM_SHEET_PIXELS, 1);
    const bottomRow = ctx.getImageData(0, rect.y + rect.height - 1, TRIM_SHEET_PIXELS, 1);
    for (let i = 0; i < TRIM_BAND_GUTTER_PIXELS; i++) {
      ctx.putImageData(topRow, 0, slotY + i);
      ctx.putImageData(bottomRow, 0, rect.y + rect.height + i);
    }
  }
}

/** Bevel a rectangle: bright along the top/left, dark along the bottom/right,
 *  with a matching height ramp. This single primitive is what makes plates,
 *  facets and collars read as raised solids rather than painted rectangles. */
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
  layer.albedo.fillRect(x, y, w, 1);
  layer.albedo.fillRect(x, y, 1, h);
  layer.albedo.fillStyle = gray(Math.max(0, face - bevel));
  layer.albedo.fillRect(x, y + h - 1, w, 1);
  layer.albedo.fillRect(x + w - 1, y, 1, h);

  // The height ramp is what the bump actually reads; the albedo bevel above is
  // there so the edge survives at mip levels where the ramp has averaged out.
  layer.height.fillStyle = gray(Math.min(1, faceHeight + 0.12));
  layer.height.fillRect(x, y, w, 1);
  layer.height.fillRect(x, y, 1, h);
  layer.height.fillStyle = gray(Math.max(0, faceHeight - 0.12));
  layer.height.fillRect(x, y + h - 1, w, 1);
  layer.height.fillRect(x + w - 1, y, 1, h);
}

/** A rivet: bright dome with a dark contact shadow. Rivets are the cheapest
 *  read at RTS range — they survive to low mips as a value rhythm even after
 *  the individual heads stop resolving. */
function rivet(layer: Layer, cx: number, cy: number, r: number): void {
  layer.albedo.fillStyle = gray(NEUTRAL - 0.16);
  layer.albedo.beginPath();
  layer.albedo.arc(cx, cy + 0.6, r + 0.8, 0, Math.PI * 2);
  layer.albedo.fill();
  layer.albedo.fillStyle = gray(NEUTRAL + 0.22);
  layer.albedo.beginPath();
  layer.albedo.arc(cx, cy, r, 0, Math.PI * 2);
  layer.albedo.fill();

  layer.height.fillStyle = gray(0.86);
  layer.height.beginPath();
  layer.height.arc(cx, cy, r, 0, Math.PI * 2);
  layer.height.fill();

  // Rivet heads are unpainted fasteners.
  layer.bare.fillStyle = gray(0.55);
  layer.bare.beginPath();
  layer.bare.arc(cx, cy, r * 0.8, 0, Math.PI * 2);
  layer.bare.fill();
}

/** Horizontal seam: a recessed gap with a lit lower lip. Runs the full width
 *  so it tiles in u without a seam of its own. */
function seamRow(layer: Layer, y: number, thickness: number): void {
  layer.albedo.fillStyle = gray(NEUTRAL - 0.3);
  layer.albedo.fillRect(0, y, TRIM_SHEET_PIXELS, thickness);
  layer.albedo.fillStyle = gray(NEUTRAL + 0.1);
  layer.albedo.fillRect(0, y + thickness, TRIM_SHEET_PIXELS, 1);
  layer.height.fillStyle = gray(0.22);
  layer.height.fillRect(0, y, TRIM_SHEET_PIXELS, thickness);
}

/** Wear scratch: a thin bright streak that also writes the bare-metal mask, so
 *  it cuts through whatever paint (substance or livery) is beneath it. */
function scratch(
  layer: Layer,
  rng: () => number,
  rect: BandRect,
  maxLength: number,
): void {
  const x = randIn(rng, 0, TRIM_SHEET_PIXELS);
  const y = randIn(rng, rect.y + 2, rect.y + rect.height - 2);
  const len = randIn(rng, maxLength * 0.3, maxLength);
  const angle = randIn(rng, -0.25, 0.25);
  const width = randIn(rng, 0.8, 2.0);
  for (const ctx of [layer.albedo, layer.bare]) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = ctx === layer.albedo ? gray(NEUTRAL + 0.2) : gray(0.85);
    ctx.fillRect(-len / 2, -width / 2, len, width);
    ctx.restore();
  }
}

// ── Bands ────────────────────────────────────────────────────────────────

/** Hull plating. Rows of bevelled plates with jittered column widths so the
 *  grid does not read as a checkerboard, rivets along the row seams, and a
 *  scattering of wear. Maps onto a spheroid as plate courses running around
 *  the azimuth and stacking pole to pole. */
function drawArmorPlate(layer: Layer, rect: BandRect, rng: () => number): void {
  const rows = 3;
  const rowHeight = rect.height / rows;
  for (let row = 0; row < rows; row++) {
    const y = rect.y + row * rowHeight;
    // Column count varies per row so plate seams never line up vertically
    // across the whole band — stacked seams read as a grid, offset seams read
    // as plating.
    const columns = 10 + Math.floor(rng() * 3);
    const columnWidth = TRIM_SHEET_PIXELS / columns;
    const phase = rng() * columnWidth;
    for (let col = -1; col < columns + 1; col++) {
      const x = col * columnWidth + phase;
      const face = NEUTRAL + randIn(rng, -0.07, 0.07);
      bevelRect(
        layer,
        x + 2, y + 2,
        columnWidth - 4, rowHeight - 4,
        face, 0.62, 0.16,
      );
    }
    seamRow(layer, y, 2);
    const rivetCount = Math.floor(columns * 1.5);
    for (let i = 0; i < rivetCount; i++) {
      rivet(
        layer,
        (i + 0.5) * (TRIM_SHEET_PIXELS / rivetCount),
        y + 6,
        1.9,
      );
    }
  }
  for (let i = 0; i < 40; i++) scratch(layer, rng, rect, 46);
}

/** Nose facets. Bigger, harder-edged, and directional: a leading bright edge
 *  with swept trapezoids behind it. The nose lobe is what the RTS camera sees
 *  first, so it carries the strongest read. */
function drawNoseFacet(layer: Layer, rect: BandRect, rng: () => number): void {
  const facets = 8;
  const width = TRIM_SHEET_PIXELS / facets;
  for (let i = 0; i < facets; i++) {
    const x = i * width;
    const face = NEUTRAL + randIn(rng, -0.05, 0.09);
    // Swept quad — leading edge tall, trailing edge short.
    layer.albedo.fillStyle = gray(face);
    layer.height.fillStyle = gray(0.66);
    // Facets butt against each other with only a seam between them: a wide
    // gap makes them read as separate cards floating on a dark backing rather
    // than as one faceted shell.
    for (const ctx of [layer.albedo, layer.height]) {
      ctx.beginPath();
      ctx.moveTo(x + 1, rect.y + 1);
      ctx.lineTo(x + width - 1, rect.y + rect.height * 0.18);
      ctx.lineTo(x + width - 1, rect.y + rect.height - 1);
      ctx.lineTo(x + 1, rect.y + rect.height * 0.82);
      ctx.closePath();
      ctx.fill();
    }
    layer.albedo.strokeStyle = gray(NEUTRAL + 0.26);
    layer.albedo.lineWidth = 1.5;
    layer.albedo.beginPath();
    layer.albedo.moveTo(x + 1, rect.y + 1);
    layer.albedo.lineTo(x + width - 1, rect.y + rect.height * 0.18);
    layer.albedo.stroke();
    rivet(layer, x + width * 0.5, rect.y + rect.height * 0.5, 2.6);
  }
  // Bright leading strip along the top of the band — on a nose lobe this lands
  // as a lit chine running around the front of the hull.
  layer.albedo.fillStyle = gray(NEUTRAL + 0.18);
  layer.albedo.fillRect(0, rect.y, TRIM_SHEET_PIXELS, 3);
  layer.height.fillStyle = gray(0.9);
  layer.height.fillRect(0, rect.y, TRIM_SHEET_PIXELS, 3);
  layer.bare.fillStyle = gray(0.4);
  layer.bare.fillRect(0, rect.y, TRIM_SHEET_PIXELS, 3);
  for (let i = 0; i < 26; i++) scratch(layer, rng, rect, 60);
}

/** Sensor housing. Ribbed collars at the poles, a lens row around the equator,
 *  and a perforated vent patch. On a sphere the band's v runs pole to pole, so
 *  horizontal features here become latitude rings. */
function drawSensorDome(layer: Layer, rect: BandRect, rng: () => number): void {
  for (let i = 0; i < 4; i++) {
    const y = rect.y + 3 + i * 5;
    layer.albedo.fillStyle = gray(NEUTRAL + (i % 2 === 0 ? 0.14 : -0.16));
    layer.albedo.fillRect(0, y, TRIM_SHEET_PIXELS, 3);
    layer.height.fillStyle = gray(i % 2 === 0 ? 0.82 : 0.3);
    layer.height.fillRect(0, y, TRIM_SHEET_PIXELS, 3);
    const yb = rect.y + rect.height - 6 - i * 5;
    layer.albedo.fillRect(0, yb, TRIM_SHEET_PIXELS, 3);
    layer.height.fillRect(0, yb, TRIM_SHEET_PIXELS, 3);
  }
  // Lens row.
  const lenses = 6;
  const spacing = TRIM_SHEET_PIXELS / lenses;
  const cy = rect.y + rect.height * 0.5;
  for (let i = 0; i < lenses; i++) {
    const cx = (i + 0.5) * spacing;
    const r = rect.height * 0.2;
    layer.albedo.fillStyle = gray(NEUTRAL + 0.24);
    layer.albedo.beginPath();
    layer.albedo.arc(cx, cy, r + 3, 0, Math.PI * 2);
    layer.albedo.fill();
    layer.albedo.fillStyle = gray(0.08);
    layer.albedo.beginPath();
    layer.albedo.arc(cx, cy, r, 0, Math.PI * 2);
    layer.albedo.fill();
    layer.height.fillStyle = gray(0.85);
    layer.height.beginPath();
    layer.height.arc(cx, cy, r + 3, 0, Math.PI * 2);
    layer.height.fill();
    layer.height.fillStyle = gray(0.2);
    layer.height.beginPath();
    layer.height.arc(cx, cy, r, 0, Math.PI * 2);
    layer.height.fill();
    // A lens is glass in a metal bezel, never painted.
    layer.bare.fillStyle = gray(0.7);
    layer.bare.beginPath();
    layer.bare.arc(cx, cy, r + 3, 0, Math.PI * 2);
    layer.bare.fill();
    for (let b = 0; b < 6; b++) {
      const a = (b / 6) * Math.PI * 2 + 0.3;
      rivet(layer, cx + Math.cos(a) * (r + 6), cy + Math.sin(a) * (r + 6), 1.5);
    }
  }
  // Vent perforations between lenses.
  for (let i = 0; i < lenses; i++) {
    const cx = (i + 1) * spacing;
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        const hx = cx + (col - 1.5) * 5 + (row % 2) * 2.5;
        const hy = cy + (row - 1.5) * 5;
        layer.albedo.fillStyle = gray(NEUTRAL - 0.3);
        layer.albedo.fillRect(hx, hy, 2.6, 2.6);
        layer.height.fillStyle = gray(0.12);
        layer.height.fillRect(hx, hy, 2.6, 2.6);
      }
    }
  }
  for (let i = 0; i < 18; i++) scratch(layer, rng, rect, 30);
}

/** Barrel. Fluting runs the full band height (constant in v), so on a cylinder
 *  it becomes grooves running the length of the barrel; the horizontal collars
 *  land at fixed fractions along the axis. Both ends get a collar because the
 *  barrel's axial direction is not knowable here — symmetric reads correctly
 *  whichever end is the muzzle. */
function drawBarrelShaft(layer: Layer, rect: BandRect, rng: () => number): void {
  const flutes = 24;
  const width = TRIM_SHEET_PIXELS / flutes;
  for (let i = 0; i < flutes; i++) {
    const x = i * width;
    layer.albedo.fillStyle = gray(NEUTRAL + 0.1);
    layer.albedo.fillRect(x, rect.y, width * 0.62, rect.height);
    layer.albedo.fillStyle = gray(NEUTRAL - 0.22);
    layer.albedo.fillRect(x + width * 0.62, rect.y, width * 0.38, rect.height);
    layer.height.fillStyle = gray(0.72);
    layer.height.fillRect(x, rect.y, width * 0.62, rect.height);
    layer.height.fillStyle = gray(0.28);
    layer.height.fillRect(x + width * 0.62, rect.y, width * 0.38, rect.height);
  }
  const collar = (y: number, h: number) => {
    bevelRect(layer, 0, y, TRIM_SHEET_PIXELS, h, NEUTRAL + 0.04, 0.92, 0.2);
    layer.bare.fillStyle = gray(0.5);
    layer.bare.fillRect(0, y, TRIM_SHEET_PIXELS, h);
    const bolts = 20;
    for (let i = 0; i < bolts; i++) {
      rivet(layer, (i + 0.5) * (TRIM_SHEET_PIXELS / bolts), y + h * 0.5, 2.0);
    }
  };
  collar(rect.y, rect.height * 0.2);
  collar(rect.y + rect.height * 0.8, rect.height * 0.2);
  // Cooling fins inboard of the breech collar.
  for (let i = 0; i < 5; i++) {
    const y = rect.y + rect.height * 0.24 + i * 4;
    layer.albedo.fillStyle = gray(NEUTRAL - 0.12);
    layer.albedo.fillRect(0, y, TRIM_SHEET_PIXELS, 2);
    layer.height.fillStyle = gray(0.9);
    layer.height.fillRect(0, y, TRIM_SHEET_PIXELS, 2);
  }
  // Muzzle soot: the outermost rows darken and lose paint.
  const sootRows = Math.floor(rect.height * 0.12);
  for (let i = 0; i < sootRows; i++) {
    const t = 1 - i / sootRows;
    layer.albedo.fillStyle = `rgba(0, 0, 0, ${(t * 0.55).toFixed(3)})`;
    layer.albedo.fillRect(0, rect.y + rect.height - 1 - i, TRIM_SHEET_PIXELS, 1);
  }
  for (let i = 0; i < 22; i++) scratch(layer, rng, rect, 34);
}

/** Leg strut. A polished mid shaft between two bolted collars, with hydraulic
 *  lines running along the strut (vertical in band space → axial on the
 *  cylinder is horizontal, so these lines run AROUND it as ribs; the polished
 *  shaft is what reads at range). */
function drawHydraulicStrut(layer: Layer, rect: BandRect, rng: () => number): void {
  // Polished shaft — a broad soft highlight around the circumference.
  const shaftTop = rect.y + rect.height * 0.2;
  const shaftHeight = rect.height * 0.6;
  const gradient = layer.albedo.createLinearGradient(0, 0, TRIM_SHEET_PIXELS, 0);
  gradient.addColorStop(0, gray(NEUTRAL - 0.14));
  gradient.addColorStop(0.28, gray(NEUTRAL + 0.3));
  gradient.addColorStop(0.5, gray(NEUTRAL + 0.02));
  gradient.addColorStop(0.72, gray(NEUTRAL + 0.3));
  gradient.addColorStop(1, gray(NEUTRAL - 0.14));
  layer.albedo.fillStyle = gradient;
  layer.albedo.fillRect(0, shaftTop, TRIM_SHEET_PIXELS, shaftHeight);
  layer.height.fillStyle = gray(0.6);
  layer.height.fillRect(0, shaftTop, TRIM_SHEET_PIXELS, shaftHeight);
  // A polished piston is bare steel, not painted bodywork.
  layer.bare.fillStyle = gray(0.72);
  layer.bare.fillRect(0, shaftTop, TRIM_SHEET_PIXELS, shaftHeight);

  // Hydraulic lines: raised tubes running around the strut.
  for (let i = 0; i < 3; i++) {
    const y = shaftTop + shaftHeight * (0.22 + i * 0.28);
    layer.albedo.fillStyle = gray(NEUTRAL - 0.26);
    layer.albedo.fillRect(0, y, TRIM_SHEET_PIXELS, 4);
    layer.albedo.fillStyle = gray(NEUTRAL + 0.12);
    layer.albedo.fillRect(0, y, TRIM_SHEET_PIXELS, 1.5);
    layer.height.fillStyle = gray(0.9);
    layer.height.fillRect(0, y, TRIM_SHEET_PIXELS, 4);
    layer.bare.fillStyle = gray(0.1);
    layer.bare.fillRect(0, y, TRIM_SHEET_PIXELS, 4);
  }

  const collarHeight = rect.height * 0.2;
  for (const y of [rect.y, rect.y + rect.height - collarHeight]) {
    bevelRect(layer, 0, y, TRIM_SHEET_PIXELS, collarHeight, NEUTRAL - 0.02, 0.95, 0.22);
    const bolts = 16;
    for (let i = 0; i < bolts; i++) {
      rivet(layer, (i + 0.5) * (TRIM_SHEET_PIXELS / bolts), y + collarHeight * 0.5, 2.4);
    }
  }
  for (let i = 0; i < 20; i++) scratch(layer, rng, rect, 28);
}

/** Bolt boss — joints and foot pads. A heavy bolt ring around the equator with
 *  radial ribs above and below, so a sphere reads as a machined knuckle. */
function drawBoltBoss(layer: Layer, rect: BandRect, rng: () => number): void {
  const ribs = 32;
  const width = TRIM_SHEET_PIXELS / ribs;
  for (let i = 0; i < ribs; i++) {
    const x = i * width;
    bevelRect(layer, x + 1, rect.y, width - 2, rect.height, NEUTRAL + randIn(rng, -0.05, 0.05), 0.58, 0.14);
  }
  const ringHeight = rect.height * 0.34;
  const ringY = rect.y + (rect.height - ringHeight) * 0.5;
  bevelRect(layer, 0, ringY, TRIM_SHEET_PIXELS, ringHeight, NEUTRAL + 0.06, 0.94, 0.24);
  layer.bare.fillStyle = gray(0.45);
  layer.bare.fillRect(0, ringY, TRIM_SHEET_PIXELS, ringHeight);
  const bolts = 12;
  for (let i = 0; i < bolts; i++) {
    rivet(layer, (i + 0.5) * (TRIM_SHEET_PIXELS / bolts), ringY + ringHeight * 0.5, 3.4);
  }
  for (let i = 0; i < 16; i++) scratch(layer, rng, rect, 24);
}

/** Team piping — the strap kit's livery. Livery bands stay close to neutral on
 *  purpose: the whole job of these surfaces is to read as team colour at a
 *  glance, and a band that darkens them by 40% destroys exactly the signal it
 *  is there to carry. All the structure is in height and in narrow high-
 *  contrast edges, not in broad value shifts. */
function drawLiveryPiping(layer: Layer, rect: BandRect, rng: () => number): void {
  // Raised centre spine, piped edges.
  layer.height.fillStyle = gray(0.72);
  layer.height.fillRect(0, rect.y, TRIM_SHEET_PIXELS, rect.height);
  for (const y of [rect.y + 2, rect.y + rect.height - 5]) {
    layer.albedo.fillStyle = gray(NEUTRAL - 0.24);
    layer.albedo.fillRect(0, y, TRIM_SHEET_PIXELS, 3);
    layer.height.fillStyle = gray(0.96);
    layer.height.fillRect(0, y, TRIM_SHEET_PIXELS, 3);
    layer.bare.fillStyle = gray(0.35);
    layer.bare.fillRect(0, y, TRIM_SHEET_PIXELS, 3);
  }
  // Periodic clamps along the run of the strap.
  const clamps = 12;
  const spacing = TRIM_SHEET_PIXELS / clamps;
  for (let i = 0; i < clamps; i++) {
    const x = i * spacing;
    bevelRect(layer, x, rect.y + 6, spacing * 0.18, rect.height - 12, NEUTRAL - 0.1, 0.9, 0.2);
    layer.bare.fillStyle = gray(0.5);
    layer.bare.fillRect(x, rect.y + 6, spacing * 0.18, rect.height - 12);
    rivet(layer, x + spacing * 0.09, rect.y + rect.height * 0.5, 2.2);
  }
  // A faint bright inner stripe keeps the team colour from reading flat.
  layer.albedo.fillStyle = gray(NEUTRAL + 0.12);
  layer.albedo.fillRect(0, rect.y + rect.height * 0.42, TRIM_SHEET_PIXELS, 2);
  for (let i = 0; i < 12; i++) scratch(layer, rng, rect, 20);
}

/** Team chevrons — the turret collar's livery. Same neutrality discipline as
 *  the piping band, with directional chevrons that read as an aiming cue when
 *  they wrap the collar. */
function drawLiveryChevron(layer: Layer, rect: BandRect, rng: () => number): void {
  layer.height.fillStyle = gray(0.6);
  layer.height.fillRect(0, rect.y, TRIM_SHEET_PIXELS, rect.height);
  const chevrons = 16;
  const spacing = TRIM_SHEET_PIXELS / chevrons;
  const midY = rect.y + rect.height * 0.5;
  for (let i = 0; i < chevrons; i++) {
    const x = i * spacing;
    for (const ctx of [layer.albedo, layer.height]) {
      ctx.fillStyle = ctx === layer.albedo ? gray(NEUTRAL - 0.2) : gray(0.92);
      ctx.beginPath();
      ctx.moveTo(x, rect.y + 4);
      ctx.lineTo(x + spacing * 0.34, midY);
      ctx.lineTo(x, rect.y + rect.height - 4);
      ctx.lineTo(x - spacing * 0.16, rect.y + rect.height - 4);
      ctx.lineTo(x + spacing * 0.18, midY);
      ctx.lineTo(x - spacing * 0.16, rect.y + 4);
      ctx.closePath();
      ctx.fill();
    }
  }
  for (const y of [rect.y, rect.y + rect.height - 3]) {
    layer.albedo.fillStyle = gray(NEUTRAL - 0.28);
    layer.albedo.fillRect(0, y, TRIM_SHEET_PIXELS, 3);
    layer.height.fillStyle = gray(0.98);
    layer.height.fillRect(0, y, TRIM_SHEET_PIXELS, 3);
    layer.bare.fillStyle = gray(0.4);
    layer.bare.fillRect(0, y, TRIM_SHEET_PIXELS, 3);
  }
  for (let i = 0; i < 10; i++) scratch(layer, rng, rect, 18);
}

const BAND_DRAWERS: Record<
  TrimBandId,
  {
    base: { albedo: number; height: number; bare: number };
    draw: (layer: Layer, rect: BandRect, rng: () => number) => void;
  }
> = {
  armorPlate: { base: { albedo: NEUTRAL - 0.2, height: 0.3, bare: 0.04 }, draw: drawArmorPlate },
  noseFacet: { base: { albedo: NEUTRAL - 0.22, height: 0.28, bare: 0.06 }, draw: drawNoseFacet },
  sensorDome: { base: { albedo: NEUTRAL, height: 0.55, bare: 0.1 }, draw: drawSensorDome },
  barrelShaft: { base: { albedo: NEUTRAL, height: 0.5, bare: 0.22 }, draw: drawBarrelShaft },
  hydraulicStrut: { base: { albedo: NEUTRAL, height: 0.5, bare: 0.15 }, draw: drawHydraulicStrut },
  boltBoss: { base: { albedo: NEUTRAL, height: 0.5, bare: 0.2 }, draw: drawBoltBoss },
  liveryPiping: { base: { albedo: NEUTRAL + 0.04, height: 0.6, bare: 0.02 }, draw: drawLiveryPiping },
  liveryChevron: { base: { albedo: NEUTRAL + 0.04, height: 0.6, bare: 0.02 }, draw: drawLiveryChevron },
};

let cachedCanvas: HTMLCanvasElement | null = null;
let cachedTexture: THREE.CanvasTexture | null = null;

function buildTrimSheetCanvas(): HTMLCanvasElement {
  const layer: Layer = {
    albedo: makeContext(TRIM_SHEET_PIXELS),
    height: makeContext(TRIM_SHEET_PIXELS),
    bare: makeContext(TRIM_SHEET_PIXELS),
  };

  for (let i = 0; i < TRIM_BAND_ORDER.length; i++) {
    const band = TRIM_BAND_ORDER[i];
    const spec = BAND_DRAWERS[band];
    const rect = beginBand(layer, i, spec.base);
    spec.draw(layer, rect, makeSeededRng(BAND_SEEDS[band]));
    fillBandGutters(layer, i, rect);
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
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
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
