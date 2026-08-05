// SurfaceChart3D — the chart catalog: what each swath of a unit's surface IS,
// and where its detail lives on the shared trim sheet.
//
// This is the "segmentation + labelling + parameterization" half of the
// procedural texturing pipeline. In the general case those are hard problems:
// you get an anonymous triangle soup and have to RECOVER its structure by
// fitting primitives to triangle clusters and unwrapping charts.
//
// We never lose that structure. Every surface in this renderer is emitted by a
// generator that knows exactly what it just made — a sphere for a hull lobe, a
// cylinder for a barrel, a swept ribbon for a team strap — and each of those
// primitives already ships its own natural parameterization as `uv`:
//
//   sphere    → (azimuth, polar)
//   cylinder  → (circumference, axial)
//   sweep     → (arc length, cross-section position)   [FormikOrnament3D]
//
// So segmentation collapses into bookkeeping: the call site that allocates an
// instance also declares which chart that instance is. There is no fitting
// tolerance to tune and no chart can ever be misassigned, because the label
// comes from the generator rather than from an analysis of its output.
//
// A chart resolves to a horizontal BAND of the trim sheet plus a tiling rate.
// That is the standard hard-surface trim-sheet workflow: one texture holds a
// stack of reusable detail strips, and texturing a surface means choosing a
// strip and a repeat. Several charts may name the same band at different
// rates — a leg joint and a foot pad are both bolt bosses, just different
// sizes.
//
// SUBSTANCE vs LIVERY is a hard split here, not a convention. Livery charts
// are the only ones allowed to carry team/player identity, which makes team
// color coverage a number this module can compute (see liveryAreaFraction in
// the contract test) instead of something a human eyeballs.

/** Bands of the trim sheet, top to bottom. The order IS the v layout — the
 *  generator rasterizes them in this order and the packing below derives each
 *  band's v range from its index, so the two can never disagree. */
export type TrimBandId =
  | 'armorPlate'
  | 'noseFacet'
  | 'sensorDome'
  | 'barrelShaft'
  | 'hydraulicStrut'
  | 'boltBoss'
  | 'liveryPiping'
  | 'liveryChevron';

export const TRIM_BAND_ORDER: readonly TrimBandId[] = [
  'armorPlate',
  'noseFacet',
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
 * Every charted surface is textured at exactly this many texels per world unit,
 * on BOTH axes, with no exceptions. That single rule is what makes the
 * texturing look like one material system instead of eight unrelated ones: no
 * surface is sharper than its neighbour, nothing is stretched along one axis,
 * and a panel seam is the same physical width wherever it appears.
 *
 * It is not automatic. The previous layout gave every band the full sheet width
 * regardless of what it wrapped, which forced u-density to be 2048/uExtent —
 * 9.6 texels per unit on a hull lobe and 325 on a barrel, a 34x spread between
 * bands and up to 93x skew WITHIN one. Bands are packed rectangles now, each
 * sized from its own surface, so density is uniform by construction rather than
 * by tuning.
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
 * World-space size of the surface each band covers, for the Formik.
 *
 * These are FULL extents — one band is exactly one wrap of its surface, with no
 * tiling. Tiling was previously how a band's aspect got reconciled with its
 * surface's; sizing the rectangle from the surface itself removes the need, and
 * with it the fract() seam and the per-chart repeat counts.
 *
 * Derived from the Formik: unit radius 40, head radius 32, barrel 64 long by 2
 * across, leg segments ~36-42 long with ~5 radius, hip/knee spheres 5.5/7.5.
 * A sphere of radius R has circumference 2*pi*R around and pi*R pole to pole.
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
  armorPlate: { uExtent: 214, vExtent: 107, featureSize: 24 },
  noseFacet: { uExtent: 105, vExtent: 53, featureSize: 26 },
  sensorDome: { uExtent: 201, vExtent: 100, featureSize: 22 },
  // vExtent covers the 64-unit tube PLUS a reserved zone for the end faces.
  // The cap is a disc of radius 1, and its remapped v carries the radius from
  // centre to rim (see ChartedCylinderUv3D), so 3 units of band is ample.
  barrelShaft: { uExtent: 6.3, vExtent: 65, featureSize: 6 },
  hydraulicStrut: { uExtent: 32, vExtent: 39, featureSize: 11 },
  boltBoss: { uExtent: 47, vExtent: 24, featureSize: 12 },
  liveryPiping: { uExtent: 104, vExtent: 60, featureSize: 16 },
  // 37.8-unit collar plus a reserved zone for its forward face, which is a
  // 24.3-radius disc — big enough to be the first thing you see down the
  // barrel line, so it gets real radial resolution rather than a scrap.
  liveryChevron: { uExtent: 153, vExtent: 62.1, featureSize: 16 },
};

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

// The cap zone is exactly the face's RADIUS worth of band, because the remap
// puts the radius on v: 1 world unit of radius is 1 world unit of band, so the
// face is textured at the sheet density like everything else.
export const BAND_CAP_ZONES: Partial<Record<TrimBandId, CapZone>> = {
  // 64-unit tube, then a 1-unit-radius muzzle face.
  barrelShaft: { wallVEnd: 64 / 65, capCenterV: 64 / 65, capRimV: 1 },
  // 37.8-unit collar, then its 24.3-radius forward face.
  liveryChevron: { wallVEnd: 37.8 / 62.1, capCenterV: 37.8 / 62.1, capRimV: 1 },
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
 * faces needed room. Best-fit lands the same set in 1711 rows.
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

/** How many times wider than tall a band pixel is on the model. Drawing code
 *  multiplies horizontal radii by this so circles come out round. */
/** Charts a unit surface can be labelled with. `none` is the default and means
 *  "untextured" — it takes a branch in the shader that leaves the fragment
 *  exactly as it was, which is what every non-Formik entity currently gets. */
export type SurfaceChartId =
  | 'none'
  | 'hullShell'
  | 'hullNose'
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

// No tiling rates. A band is exactly one wrap of its surface at the sheet's
// single texel density, so a chart is a straight rectangle lookup: there is
// nothing left to stretch, skew, or zoom. Every rate that used to live here
// was compensation for a band whose aspect did not match its surface's, and
// sizing the rectangle from the surface removes the mismatch at the source.
const CHART_DEFS: Record<Exclude<SurfaceChartId, 'none'>, SurfaceChartDef> = {
  hullShell: { band: 'armorPlate', livery: false },
  hullNose: { band: 'noseFacet', livery: false },
  sensorDome: { band: 'sensorDome', livery: false },
  barrelShaft: { band: 'barrelShaft', livery: false },
  legStrut: { band: 'hydraulicStrut', livery: false },
  legJoint: { band: 'boltBoss', livery: false },
  liveryStrap: { band: 'liveryPiping', livery: true },
  liveryCollar: { band: 'liveryChevron', livery: true },
};

export function bandIndex(band: TrimBandId): number {
  const index = TRIM_BAND_ORDER.indexOf(band);
  if (index < 0) throw new Error(`[surface chart] unknown trim band ${band}`);
  return index;
}

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

export function isLiveryChart(chart: SurfaceChartId): boolean {
  return chart !== 'none' && CHART_DEFS[chart].livery;
}

/** Per-instance shader payload: the chart's rectangle (u0, v0, uSpan, vSpan).
 *
 *  The shader maps the surface's own uv straight into this rectangle — no
 *  tiling, no fract, no wrap. `vSpan === 0` is the sentinel for "no chart", so
 *  an unwritten (zero-filled) attribute slot is correctly untextured without
 *  any initialization pass. */
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
 *  `featureSize` world units on the model. Because density is uniform the
 *  result is square in texels as well as in world units. */
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

// ── Formik assignment ────────────────────────────────────────────────────
//
// The Formik is the first unit through the pipeline. Everything below is the
// semantic labelling step for it, and it is deliberately a data table rather
// than logic scattered across the builders: this is the file to read to learn
// what the unit is made of.
//
// Body is a 3-part composite authored in units.json — abdomen oval, mid oval,
// forward circle. The forward lobe is the nose and reads as the "face" of the
// unit from the RTS camera, so it gets the harder-edged facet band while the
// two body lobes share plated armour.

export const FORMIK_BODY_PART_CHARTS: readonly SurfaceChartId[] = [
  'hullShell',
  'hullShell',
  'hullNose',
];

/** Chart for a Formik body part by index, tolerant of a body shape that gains
 *  or loses parts — extra parts fall back to plated shell rather than throwing
 *  or silently going untextured. */
export function formikBodyPartChart(partIndex: number): SurfaceChartId {
  return FORMIK_BODY_PART_CHARTS[partIndex] ?? 'hullShell';
}

/** Charts for one legged unit's instanced locomotion slots. The leg pools are
 *  role-separated already (upper cylinder / lower cylinder / joint sphere), so
 *  this is a straight role → chart table rather than anything per-instance. */
export type LegSurfaceCharts = {
  upper: SurfaceChartId;
  lower: SurfaceChartId;
  joint: SurfaceChartId;
};

export const FORMIK_LEG_CHARTS: LegSurfaceCharts = {
  upper: 'legStrut',
  lower: 'legStrut',
  joint: 'legJoint',
};

/** Every surface the Formik carries, for coverage auditing. Kept beside the
 *  assignments above so a new Formik chart cannot be added without appearing
 *  in the audit. */
export const FORMIK_CHARTS: readonly SurfaceChartId[] = [
  ...FORMIK_BODY_PART_CHARTS,
  'sensorDome',
  'barrelShaft',
  FORMIK_LEG_CHARTS.upper,
  FORMIK_LEG_CHARTS.lower,
  FORMIK_LEG_CHARTS.joint,
  'liveryStrap',
  'liveryCollar',
];
