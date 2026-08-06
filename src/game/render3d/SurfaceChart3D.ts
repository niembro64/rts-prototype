// SurfaceChart3D — the chart catalog: what each swath of a unit's surface IS,
// and where its detail lives on the shared trim sheet.
//
// Two different things get called "texture", and this file is where they are
// kept apart. See "Every Surface Is Textured, At One World Texel Density" in
// budget_design_philosophy.html.
//
//   SUBSTANCE GRAIN is what the surface is made OF — plating, panel breaks,
//   rivet rhythm, weld seams, wear. It has no relationship to a part's size or
//   shape, it tiles, and it is the term that carries the density invariant. It
//   is projected (see SurfaceChartMaterial3D) rather than charted, so it
//   reaches every face of every entity with no per-surface authoring at all:
//   box faces, cylinder end caps, cones, swept ribbons, generated hulls.
//
//   PLACED CHARTS are structure at a known place on a known part — a turret
//   head's pitch slot, a barrel's muzzle bore and breech collar, a strut's end
//   flanges, a livery band's piped edges. These need the part's own
//   parameterization, and they SCALE with the part: a bigger turret has a
//   bigger slot, not more slots.
//
// Charting the placed half is cheap here for a reason worth keeping in mind:
// in the general case you get an anonymous triangle soup and have to RECOVER
// its structure by fitting primitives to triangle clusters and unwrapping
// charts. We never lose that structure. Every surface in this renderer is
// emitted by a generator that knows exactly what it just made, and each of
// those primitives already ships its own natural parameterization as `uv`:
//
//   sphere    → (azimuth, polar)
//   cylinder  → (circumference, axial)
//   sweep     → (arc length, cross-section position)   [TeamOrnament3D]
//
// So segmentation collapses into bookkeeping: the call site that allocates an
// instance also declares which chart that instance is. There is no fitting
// tolerance to tune and no chart can ever be misassigned, because the label
// comes from the generator rather than from an analysis of its output.
//
// SUBSTANCE vs LIVERY is a hard split here, not a convention. Livery charts
// are the only ones allowed to carry team/player identity, which makes team
// color coverage a number this module can compute (see liveryAreaFraction in
// the contract test) instead of something a human eyeballs.

/** Bands of the trim sheet. Each is a packed rectangle; the packing below
 *  derives every rectangle from this list, so the layout and the generator
 *  can never disagree about where a band lives. */
export type TrimBandId =
  | 'substanceGrain'
  | 'sensorDome'
  | 'barrelShaft'
  | 'hydraulicStrut'
  | 'boltBoss'
  | 'liveryPiping'
  | 'liveryChevron';

export const TRIM_BAND_ORDER: readonly TrimBandId[] = [
  'substanceGrain',
  'sensorDome',
  'barrelShaft',
  'hydraulicStrut',
  'boltBoss',
  'liveryPiping',
  'liveryChevron',
];

export const TRIM_SHEET_PIXELS = 2048;

/**
 * TEXEL DENSITY — the constraint the whole layout exists to satisfy.
 *
 * Every textured surface resolves at exactly this many texels per world unit,
 * on BOTH axes, on every entity, with no per-blueprint override. That single
 * rule is what makes the roster look like one faction built out of one stock
 * of metal instead of a pile of unrelated models: no surface is sharper than
 * its neighbour, nothing is stretched along one axis, and a panel seam is the
 * same physical width wherever it appears.
 *
 * The consequence is deliberate: a large entity seen from far away carries
 * more texture than a small entity seen from close up, even at the same
 * on-screen size. Detail belongs to the object, not to the camera.
 *
 * It is not automatic. An earlier layout gave every band the full sheet width
 * regardless of what it wrapped, which forced u-density to be 2048/uExtent —
 * 9.6 texels per unit on a hull lobe and 325 on a barrel, a 34x spread between
 * bands and up to 93x skew WITHIN one. Bands are packed rectangles now, each
 * sized from the surface it describes, so density is uniform by construction
 * rather than by tuning.
 *
 * Raising this sharpens everything at once and costs area quadratically; the
 * packing assertion in the contract test is what tells you when it no longer
 * fits.
 */
export const TRIM_SHEET_TEXELS_PER_UNIT = 6;

/** Gutter around every side of a band, filled by extending (or wrapping) its
 *  own edge content. Mip levels average neighbouring texels, so without it one
 *  band bleeds into whatever was packed beside it a few mips down. */
export const TRIM_BAND_GUTTER_PIXELS = 16;

/**
 * THE GRAIN TILE — the world footprint of one repeat of the substance band.
 *
 * This is the only number that decides how big plating, seams and rivets are
 * in the world, and it decides it for every entity at once. 128 world units is
 * larger than most units, so the repeat is invisible on a unit and only starts
 * to be a pattern across a large structure; at the sheet density it costs a
 * 768px square, which the packing has room for.
 *
 * Lowering it makes everything finer AND makes the tile repeat sooner. It is
 * not a quality dial — the quality dial is TRIM_SHEET_TEXELS_PER_UNIT.
 */
export const GRAIN_TILE_WORLD_UNITS = 128;

export const GRAIN_BAND: TrimBandId = 'substanceGrain';

/**
 * World-space size of the surface a band describes.
 *
 * For the grain this is literal: one band IS one 128-unit tile of material,
 * and it repeats.
 *
 * For placed charts it is the REFERENCE PART — the size the band's structure
 * was laid out against, which is what fixes the band's aspect ratio and how
 * many texels the sheet spends on it. A placed chart maps a part's own uv
 * across the whole rectangle, so mounting it on a part of a different size
 * scales the structure with the part, which is the intended behaviour: a
 * bigger turret has a bigger slot. The reference sizes below are the Formik's,
 * because the Formik is where hull, head, barrel, strut, joint and both livery
 * surfaces were authored together.
 *
 * Derived from the Formik: head radius 32, barrel 64 long by 2 across, leg
 * segments ~36-42 long with ~5 radius, hip/knee spheres 5.5/7.5. A sphere of
 * radius R has circumference 2*pi*R around and pi*R pole to pole.
 */
export type BandSurface = {
  /** Circumference or arc length the band wraps, in world units. */
  uExtent: number;
  /** Extent along the other axis, in world units. */
  vExtent: number;
  /** Target on-model size of one panel / plate, in world units. */
  featureSize: number;
};

export const BAND_SURFACE: Record<TrimBandId, BandSurface> = {
  substanceGrain: {
    uExtent: GRAIN_TILE_WORLD_UNITS,
    vExtent: GRAIN_TILE_WORLD_UNITS,
    // 8 world units per plate. This is the number that decides how much
    // texture a small unit gets: a radius-8 scout is 16 units across, so it
    // reads as two plates wide, while a Queen reads as twenty-odd. That
    // difference IS the density rule working.
    featureSize: 8,
  },
  sensorDome: { uExtent: 201, vExtent: 100, featureSize: 22 },
  // vExtent covers the 64-unit tube PLUS a reserved zone for the end faces.
  // The cap is a disc of radius 1, and its remapped v carries the radius from
  // centre to rim (see ChartedCylinderUv3D), so 3 units of band is ample.
  barrelShaft: { uExtent: 6.3, vExtent: 65.5, featureSize: 6 },
  hydraulicStrut: { uExtent: 32, vExtent: 39, featureSize: 11 },
  boltBoss: { uExtent: 47, vExtent: 24, featureSize: 12 },
  liveryPiping: { uExtent: 104, vExtent: 60, featureSize: 16 },
  // 37.8-unit collar plus a reserved zone for its forward face, which is a
  // 24.3-radius disc — big enough to be the first thing you see down the
  // barrel line, so it gets real radial resolution rather than a scrap.
  liveryChevron: { uExtent: 153, vExtent: 62.7, featureSize: 16 },
};

/**
 * Bands whose v axis WRAPS as well as its u.
 *
 * A placed band's v runs pole to pole or breech to muzzle: its two ends are
 * different places and must not be filtered into each other. The grain tile's
 * v is just more material, so it wraps, and its gutters have to be filled from
 * the opposite edge or the seam shows up as a line every 128 world units.
 */
export const BAND_WRAPS_V: ReadonlySet<TrimBandId> = new Set<TrimBandId>([
  'substanceGrain',
]);

/**
 * How a band splits between a cylinder's wall and its end faces.
 *
 * Only cylinders whose flat face is actually seen need this. The values are
 * fractions of the band's v, and they are the single source of truth shared by
 * the geometry's UV remap and the generator that paints the zone — if the two
 * disagreed, a face would sample the wall or vice versa.
 */
export type CapZone = {
  wallVEnd: number;
  capCenterV: number;
  capRimV: number;
};

// The cap zone is exactly the reference face's RADIUS worth of band, because
// the remap puts the radius on v: 1 world unit of radius is 1 world unit of
// band, so the face is laid out at the same rate as the tube it caps.
export const BAND_CAP_ZONES: Partial<Record<TrimBandId, CapZone>> = {
  // A DEAD GAP separates wallVEnd from capCenterV. With the two equal, the
  // face's centre row abuts the wall's last row, and bilinear filtering at the
  // exact centre of the face pulls in the tube's bright machined lip — a white
  // dot in the middle of the bore. Half a world unit of band is enough.
  //
  // 64-unit tube, 0.5 gap, then a 1-unit-radius muzzle face.
  barrelShaft: { wallVEnd: 64 / 65.5, capCenterV: 64.5 / 65.5, capRimV: 1 },
  // 37.8-unit collar, 0.6 gap, then its 24.3-radius forward face.
  liveryChevron: { wallVEnd: 37.8 / 62.7, capCenterV: 38.4 / 62.7, capRimV: 1 },
};

/** A band's pixel rectangle in the sheet, gutters included. */
export type BandRectPx = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function bandSlotSize(band: TrimBandId): { width: number; height: number } {
  const surface = BAND_SURFACE[band];
  const pad = TRIM_BAND_GUTTER_PIXELS * 2;
  return {
    width: Math.ceil(surface.uExtent * TRIM_SHEET_TEXELS_PER_UNIT) + pad,
    height: Math.ceil(surface.vExtent * TRIM_SHEET_TEXELS_PER_UNIT) + pad,
  };
}

/**
 * Shelf packing, tallest first, placing each band on the first OPEN shelf with
 * room rather than only the newest one.
 *
 * Deterministic and dependency-free, which matters more here than optimality:
 * the layout has to be identical every run or the charts and the generated
 * pixels disagree. Revisiting earlier shelves is worth the few extra lines —
 * strictly-newest-shelf packing wasted the 700px left beside each of the two
 * tallest bands and overflowed the sheet by 30 rows once the cylinder end
 * faces needed room.
 */
function packBands(): Record<TrimBandId, BandRectPx> {
  const order = [...TRIM_BAND_ORDER].sort((a, b) => {
    const delta = bandSlotSize(b).height - bandSlotSize(a).height;
    return delta !== 0 ? delta : a.localeCompare(b);
  });
  const rects = {} as Record<TrimBandId, BandRectPx>;
  const shelves: { y: number; height: number; used: number }[] = [];
  for (const band of order) {
    const { width, height } = bandSlotSize(band);
    if (width > TRIM_SHEET_PIXELS) {
      throw new Error(
        `[surface chart] ${band} needs ${width}px of sheet width at `
        + `${TRIM_SHEET_TEXELS_PER_UNIT} texels/unit; the sheet is `
        + `${TRIM_SHEET_PIXELS}px`,
      );
    }
    const shelf = shelves.find(
      (s) => s.used + width <= TRIM_SHEET_PIXELS && height <= s.height,
    );
    if (shelf !== undefined) {
      rects[band] = { x: shelf.used, y: shelf.y, width, height };
      shelf.used += width;
      continue;
    }
    const last = shelves[shelves.length - 1];
    const y = last === undefined ? 0 : last.y + last.height;
    shelves.push({ y, height, used: width });
    rects[band] = { x: 0, y, width, height };
  }
  return rects;
}

const BAND_RECTS = packBands();

export function bandRectPx(band: TrimBandId): BandRectPx {
  return BAND_RECTS[band];
}

/** Total rows the packing actually consumes. Must stay within the sheet. */
export function packedSheetHeight(): number {
  let bottom = 0;
  for (const band of TRIM_BAND_ORDER) {
    const rect = BAND_RECTS[band];
    if (rect.y + rect.height > bottom) bottom = rect.y + rect.height;
  }
  return bottom;
}

/** Charts a unit surface can be labelled with.
 *
 *  `none` is the default and means "no PLACED structure here" — not
 *  "untextured". A surface with no chart still receives the substance grain,
 *  which is projected rather than charted; there is no reachable state in
 *  which a face renders as flat colour. Hull shells, building walls, wheels,
 *  treads and ornament boxes are all deliberately chart-free: they are plain
 *  material, and plain material is exactly what the grain describes. */
export type SurfaceChartId =
  | 'none'
  | 'sensorDome'
  | 'barrelShaft'
  | 'legStrut'
  | 'legJoint'
  | 'liveryStrap'
  | 'liveryCollar';

type SurfaceChartDef = {
  band: TrimBandId;
  /** True for charts that carry team/player identity. Only these may be
   *  driven by a team color, and only these are counted toward the livery
   *  coverage budget. */
  livery: boolean;
};

// No tiling rates on placed charts. A chart maps a part's own uv straight
// across its rectangle, which is what makes it structure: one slot, one bore,
// one pair of end flanges, however big the part is. Tiling belongs to the
// grain, which is projected and has no chart at all.
const CHART_DEFS: Record<Exclude<SurfaceChartId, 'none'>, SurfaceChartDef> = {
  sensorDome: { band: 'sensorDome', livery: false },
  barrelShaft: { band: 'barrelShaft', livery: false },
  legStrut: { band: 'hydraulicStrut', livery: false },
  legJoint: { band: 'boltBoss', livery: false },
  liveryStrap: { band: 'liveryPiping', livery: true },
  liveryCollar: { band: 'liveryChevron', livery: true },
};

/** A band's CONTENT rectangle in normalized texture space — inside its
 *  gutters. Fragments never sample the gutter directly; it exists only so mip
 *  filtering has same-band texels to average into. */
export function bandContentRect(band: TrimBandId): {
  u0: number;
  v0: number;
  uSpan: number;
  vSpan: number;
} {
  const rect = bandRectPx(band);
  const g = TRIM_BAND_GUTTER_PIXELS;
  return {
    u0: (rect.x + g) / TRIM_SHEET_PIXELS,
    v0: (rect.y + g) / TRIM_SHEET_PIXELS,
    uSpan: (rect.width - g * 2) / TRIM_SHEET_PIXELS,
    vSpan: (rect.height - g * 2) / TRIM_SHEET_PIXELS,
  };
}

/** The grain tile's rectangle, as the shader's uniform wants it. Uploaded
 *  once; every surface in the game samples this one rectangle. */
export function grainContentRect(): [number, number, number, number] {
  const rect = bandContentRect(GRAIN_BAND);
  return [rect.u0, rect.v0, rect.uSpan, rect.vSpan];
}

export function isLiveryChart(chart: SurfaceChartId): boolean {
  return chart !== 'none' && CHART_DEFS[chart].livery;
}

/** Per-instance shader payload: the chart's rectangle (u0, v0, uSpan, vSpan).
 *
 *  The shader maps the surface's own uv straight into this rectangle — no
 *  tiling, no fract, no wrap.
 *
 *  ZERO MEANS NO CHART, and it has to mean that under two different kinds of
 *  "unwritten". A never-touched slot in a Float32Array is all zeroes; a
 *  geometry that has no `aChart` attribute at all reads WebGL's default
 *  generic vertex attribute, which is (0, 0, 0, 1). The shader's active test
 *  is therefore on the two SPANS (z and w) together, and both are zero here,
 *  so neither case can accidentally sample a garbage rectangle. That matters
 *  now that the chart material is worn by every entity surface in the game,
 *  most of which carry no per-instance chart buffer. */
export function packChart(chart: SurfaceChartId, out: Float32Array, offset: number): void {
  if (chart === 'none') {
    out[offset] = 0;
    out[offset + 1] = 0;
    out[offset + 2] = 0;
    out[offset + 3] = 0;
    return;
  }
  const rect = bandContentRect(CHART_DEFS[chart].band);
  out[offset] = rect.u0;
  out[offset + 1] = rect.v0;
  out[offset + 2] = rect.uSpan;
  out[offset + 3] = rect.vSpan;
}

/** Panels across and courses down for a band, sized so each lands at
 *  `featureSize` world units on the reference part. Because density is uniform
 *  the result is square in texels as well as in world units. */
export function bandFeatureCounts(band: TrimBandId): {
  columns: number;
  courses: number;
} {
  const surface = BAND_SURFACE[band];
  return {
    columns: Math.max(2, Math.round(surface.uExtent / surface.featureSize)),
    courses: Math.max(1, Math.round(surface.vExtent / surface.featureSize)),
  };
}

// ── Roster-wide assignment ───────────────────────────────────────────────
//
// Placed charts are assigned by SURFACE ROLE, never by blueprint. Every turret
// head in the game is a sensor dome, every barrel is a barrel, every leg
// segment is a strut and every joint a bolt boss, whichever unit or building
// mounts it — so this is a role table rather than a per-unit one, and a new
// blueprint cannot ship unlabelled because it never had to be listed.
//
// Hull shells, building walls, wheels, treads, fans and ornament boxes carry
// no placed structure on purpose: they are plain material, and the projected
// grain is what plain material looks like.

/** Charts for one unit's instanced locomotion slots. The leg pools are
 *  role-separated already (upper cylinder / lower cylinder / joint sphere), so
 *  this is a straight role → chart table rather than anything per-instance. */
export type LegSurfaceCharts = {
  upper: SurfaceChartId;
  lower: SurfaceChartId;
  joint: SurfaceChartId;
};

export const LEG_CHARTS: LegSurfaceCharts = {
  upper: 'legStrut',
  lower: 'legStrut',
  joint: 'legJoint',
};

/** Every placed chart the roster can produce, for coverage auditing. Kept
 *  beside the assignments above so a new chart cannot be added without
 *  appearing in the audit. */
export const ROSTER_CHARTS: readonly SurfaceChartId[] = [
  'sensorDome',
  'barrelShaft',
  LEG_CHARTS.upper,
  LEG_CHARTS.lower,
  LEG_CHARTS.joint,
  'liveryStrap',
  'liveryCollar',
];
