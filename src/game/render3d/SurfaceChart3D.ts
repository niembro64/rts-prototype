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
  | 'substanceGrain'
  | 'armorPlate'
  | 'noseFacet'
  | 'sensorDome'
  | 'barrelShaft'
  | 'hydraulicStrut'
  | 'boltBoss'
  | 'liveryPiping'
  | 'liveryChevron'
  | 'tyreTread'
  | 'trackRunning'
  | 'trackGrouser'
  | 'trackBeltPlate';

export const TRIM_BAND_ORDER: readonly TrimBandId[] = [
  'substanceGrain',
  'armorPlate',
  'noseFacet',
  'sensorDome',
  'barrelShaft',
  'hydraulicStrut',
  'boltBoss',
  'liveryPiping',
  'liveryChevron',
  'tyreTread',
  'trackRunning',
  'trackGrouser',
  'trackBeltPlate',
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
 * THE REFERENCE HOST — the Formik.
 *
 * Every band in this sheet was drawn against the Formik: its hull lobes fixed
 * the plate size, its head fixed the dome, its barrel the tube, its legs the
 * strut and knuckle, its strap and collar the livery. That makes the Formik
 * the unit whose charts are ONE WRAP of their surfaces, and it is why a chart
 * mounted on any other host repeats by that host's size relative to these
 * numbers: a plate is 24 world units on a scout, on the Formik, and on a
 * Queen, because the repeat is the only thing that changes.
 *
 * Changing either number re-scales the whole roster except the Formik, which
 * is exactly the wrong way round. They are the sheet's origin, not a tuning
 * knob.
 */
export const REFERENCE_HOST_RADIUS = 40;
export const REFERENCE_TURRET_HEAD_RADIUS = 32;

/**
 * Reference locomotion hardware — the Mammoth's track and the Mongoose's
 * wheel, because those are the largest of each and therefore the ones whose
 * detail has to survive being looked at.
 *
 * Wheels and tracks get their own bands rather than the hull's plating for
 * the same reason a barrel does: they are not armour. A tyre is a moulded
 * rubber carcass with lugs around its crown and a bolted hub on its face; a
 * track is a chain of steel grousers running over a plated side frame.
 * Dressing either in bolted hull plate reads as a unit built out of one
 * material and then chopped into parts.
 */
export const REFERENCE_WHEEL_RADIUS = 4.4;
export const REFERENCE_TRACK_LENGTH = 48;

/** World footprint of one repeat of the projected grain. Four plates across
 *  at the hull's own 24-unit plate size. */
export const GRAIN_TILE_WORLD_UNITS = 96;

export const GRAIN_BAND: TrimBandId = 'substanceGrain';

/**
 * Which of a band's axes may REPEAT when the chart is mounted on a part bigger
 * than the reference one.
 *
 * This is the whole of the generalization, and it is per-axis because it is
 * decided by what the band DRAWS on that axis:
 *
 *   An axis carrying only material — panel columns, courses, bolt rhythm —
 *   repeats. That is what holds a plate at 24 world units whatever it is
 *   bolted to.
 *
 *   An axis carrying a PLACED feature cannot. The sensor dome's pitch slot is
 *   one opening at one azimuth running one full meridian; repeat either axis
 *   and the head grows a ring of slots or a stack of them. The barrel's breech
 *   sits at one end and its bore at the other, in a reserved zone. A strut's
 *   collars are at its two ends; a knuckle's flange is at its middle. Those
 *   bands hold their placed axis at one wrap and let the structure scale with
 *   the part, which is what a bigger turret having a bigger slot means.
 */
export type BandTileAxes = { u: boolean; v: boolean };

export const BAND_TILE_AXES: Record<TrimBandId, BandTileAxes> = {
  // Projected, never charted; listed for completeness.
  substanceGrain: { u: true, v: true },
  // Pure material on both axes: columns around, courses down.
  armorPlate: { u: true, v: true },
  noseFacet: { u: true, v: true },
  // The pitch slot is placed in BOTH u (one azimuth) and v (one meridian).
  sensorDome: { u: false, v: false },
  // Breech at one end, bore at the other, cap zone reserved in v.
  barrelShaft: { u: false, v: false },
  // Collars at both ends of v; panels repeat around u.
  hydraulicStrut: { u: true, v: false },
  // Flange ringing the middle of v; bolts repeat around u.
  boltBoss: { u: true, v: false },
  // u is arc length along the strap and repeats; v is its cross-section.
  liveryPiping: { u: true, v: false },
  // u is around the collar; v carries the reserved forward-face zone.
  liveryChevron: { u: true, v: false },
  // Lugs repeat around the crown; the shoulders and the hub zone are placed.
  tyreTread: { u: true, v: false },
  // Plain running gear. Nothing along u, and v's shoulders are its edges.
  trackRunning: { u: false, v: false },
  trackGrouser: { u: false, v: false },
  // Link seams repeat along the frame; its top and bottom rails are placed
  // at the v edges.
  trackBeltPlate: { u: true, v: false },
};

/**
 * Bands whose u axis is CLOSED — it wraps around the surface and meets
 * itself: a sphere's azimuth, a cylinder's circumference, a belt's loop.
 *
 * A closed u must repeat a WHOLE number of times or the wrap does not line
 * up. The band's content is authored to be continuous across its own edge,
 * so at 2.35 repeats the surface's seam lands 35% into the band and the
 * plating visibly mismatches along one meridian. Rounding to the nearest
 * whole repeat moves the feature size by at most half a repeat — invisible —
 * and removes the seam entirely.
 *
 * An OPEN u has two real ends and needs no rounding: the livery strap runs
 * from the hull's tail to its nose and terminates in caps at both.
 */
export const BAND_CLOSED_U: ReadonlySet<TrimBandId> = new Set<TrimBandId>([
  'armorPlate',
  'noseFacet',
  'hydraulicStrut',
  'boltBoss',
  'liveryChevron',
  'tyreTread',
  'trackBeltPlate',
]);

/** Bands whose v repeats, and whose v gutters must therefore WRAP rather than
 *  extend — a tiling axis' two ends are the same place. */
export const BAND_WRAPS_V: ReadonlySet<TrimBandId> = new Set<TrimBandId>(
  (Object.keys(BAND_TILE_AXES) as TrimBandId[]).filter((band) => BAND_TILE_AXES[band].v),
);

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
  // The grain is not a chart — it is projected (see SurfaceChartMaterial3D) and
  // only ever lands where no chart did. Its plate is deliberately the SAME 24
  // world units as the hull's, so a building wall and a Formik hull lobe are
  // visibly the same stock of metal at the same scale.
  substanceGrain: {
    uExtent: GRAIN_TILE_WORLD_UNITS,
    vExtent: GRAIN_TILE_WORLD_UNITS,
    featureSize: 24,
  },
  armorPlate: { uExtent: 214, vExtent: 107, featureSize: 24 },
  noseFacet: { uExtent: 105, vExtent: 53, featureSize: 26 },
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
  // TYRE. u is the crown's circumference (2*pi*4.4), v runs across the tread
  // face and then into a reserved zone for the wheel's flat sides — the
  // sidewall and hub, which on a wheel lying on its axle are the two faces
  // you actually see from an RTS camera.
  tyreTread: { uExtent: 27.65, vExtent: 12.4, featureSize: 4 },
  // THE BELT — the rubber-and-steel band the grousers are bolted to. DARK,
  // and dark is the point: a cleat sitting on a belt of the same value is a
  // cleat nobody can see, and the two together are most of what a track reads
  // as in motion.
  //
  // Deliberately plain otherwise. Both this and the grouser band dress
  // surfaces seen edge-on from an RTS camera — a cleat is a bar a couple of
  // world units deep, the belt is a strip glimpsed between cleats. Detail
  // there is detail nobody can resolve, and on a moving track it flickers.
  //
  // Only v carries anything, which is what lets these bands stay legible at
  // any track size: v is the track's WIDTH on both pieces, while u is the
  // belt's whole loop on one and a single bar's depth on the other — two
  // world spans that share no scale and, drawn this way, never have to.
  trackRunning: { uExtent: 4, vExtent: 16, featureSize: 4 },
  // THE GROUSERS — the bars that bite the ground. LIGHT against the belt:
  // unpainted steel, polished where it grinds. The value gap between this
  // band and the one above it is what makes a track read as a chain of
  // separate cleats rather than as one extruded ribbon.
  trackGrouser: { uExtent: 4, vExtent: 16, featureSize: 4 },
  // TRACK SIDE FRAME — the flat outer face of the track, and the ONE track
  // surface with real area facing the camera. u runs along the frame and
  // repeats; v is its height.
  trackBeltPlate: { uExtent: REFERENCE_TRACK_LENGTH, vExtent: 10, featureSize: 8 },
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
  // A DEAD GAP separates wallVEnd from capCenterV. With the two equal, the
  // face's centre row abuts the wall's last row, and bilinear filtering at the
  // exact centre of the face pulls in the tube's bright machined lip — a white
  // dot in the middle of the bore. Half a world unit of band is enough.
  //
  // 64-unit tube, 0.5 gap, then a 1-unit-radius muzzle face.
  barrelShaft: { wallVEnd: 64 / 65.5, capCenterV: 64.5 / 65.5, capRimV: 1 },
  // 37.8-unit collar, 0.6 gap, then its 24.3-radius forward face.
  liveryChevron: { wallVEnd: 37.8 / 62.7, capCenterV: 38.4 / 62.7, capRimV: 1 },
  // 6-unit-wide tread face, a 2-unit dead gap, then the wheel's own
  // 4.4-radius side. Unlike a barrel, BOTH of a wheel's faces are seen — they
  // are the sidewall and hub you look straight at from an RTS camera — and
  // they share the zone.
  //
  // The gap is four times the barrel's on purpose. A wheel's face is a large
  // disc on a low-segment cap, so its centre resolves at a coarse mip; with
  // the barrel's half-unit gap the hub filtered in the tread's lug pattern
  // and the face came out striped.
  tyreTread: { wallVEnd: 6 / 12.4, capCenterV: 8 / 12.4, capRimV: 1 },
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

/** Charts a surface can be labelled with.
 *
 *  `none` means "no PLACED structure here" rather than "untextured": a surface
 *  with no chart still receives the projected substance grain, at the same
 *  plate size the hull band was drawn at. Building walls, wheels, treads, fans
 *  and ornament boxes are deliberately chart-free — they are plain material,
 *  and plain material is exactly what the grain describes. */
export type SurfaceChartId =
  | 'none'
  | 'hullShell'
  | 'hullNose'
  | 'sensorDome'
  | 'barrelShaft'
  | 'legStrut'
  | 'legJoint'
  | 'liveryStrap'
  | 'liveryCollar'
  | 'wheelTyre'
  | 'trackRun'
  | 'trackCleat'
  | 'trackBelt';

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
  wheelTyre: { band: 'tyreTread', livery: false },
  trackRun: { band: 'trackRunning', livery: false },
  trackCleat: { band: 'trackGrouser', livery: false },
  trackBelt: { band: 'trackBeltPlate', livery: false },
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

export function isLiveryChart(chart: SurfaceChartId): boolean {
  return chart !== 'none' && CHART_DEFS[chart].livery;
}

/**
 * How many times this chart's band repeats across the surface it is mounted
 * on, given that surface's size relative to the reference part.
 *
 * `hostScale` is the part's size as a multiple of the Formik's — a Queen's
 * hull is 94/40 = 2.35 — and an axis that may tile takes it directly. That is
 * the entire mechanism by which a plate stays 24 world units across the
 * roster: the band is unchanged, the surface just wraps it more times.
 *
 * A scale of exactly 1 reproduces the reference host's charts to the texel,
 * because the shader clamps rather than wraps at or below one repeat. The
 * Formik is therefore not a special case in code and still renders exactly as
 * it was drawn.
 */
export function chartRepeat(chart: SurfaceChartId, hostScale: number): [number, number] {
  if (chart === 'none') return [1, 1];
  const band = CHART_DEFS[chart].band;
  const axes = BAND_TILE_AXES[band];
  let repeatU = axes.u ? hostScale : 1;
  // A closed u has to come out whole, or the surface's own seam lands
  // mid-band and the wrap mismatches along one meridian. See BAND_CLOSED_U.
  if (axes.u && BAND_CLOSED_U.has(band)) repeatU = Math.max(1, Math.round(repeatU));
  return [repeatU, axes.v ? hostScale : 1];
}

/** Every band's rectangle, in TRIM_BAND_ORDER, as the shader's uniform array
 *  wants it. The chart attribute carries a band CODE rather than a rectangle,
 *  which is what leaves room in one vec4 for the repeats. */
export function bandRectUniformArray(): Float32Array {
  const out = new Float32Array(TRIM_BAND_ORDER.length * 4);
  for (let i = 0; i < TRIM_BAND_ORDER.length; i++) {
    const rect = bandContentRect(TRIM_BAND_ORDER[i]);
    out[i * 4] = rect.u0;
    out[i * 4 + 1] = rect.v0;
    out[i * 4 + 2] = rect.uSpan;
    out[i * 4 + 3] = rect.vSpan;
  }
  return out;
}

/** Per-instance shader payload: (band code + 1, repeat u, repeat v, unused).
 *
 *  The band is a CODE into the uniform rectangle array rather than the
 *  rectangle itself, which is what leaves room in one vec4 for the repeats —
 *  and adding a band no longer changes what every pool has to carry.
 *
 *  ZERO MEANS NO CHART, and it has to mean that under two different kinds of
 *  "unwritten". A never-touched Float32Array slot is all zeroes; a geometry
 *  with no `aChart` attribute at all reads WebGL's default generic vertex
 *  attribute, which is (0, 0, 0, 1). The active test is on the band code in
 *  `.x`, which is zero in both cases. */
export function packChart(
  chart: SurfaceChartId,
  out: Float32Array,
  offset: number,
  hostScale = 1,
): void {
  if (chart === 'none') {
    out[offset] = 0;
    out[offset + 1] = 0;
    out[offset + 2] = 0;
    out[offset + 3] = 0;
    return;
  }
  const [repeatU, repeatV] = chartRepeat(chart, hostScale);
  out[offset] = TRIM_BAND_ORDER.indexOf(CHART_DEFS[chart].band) + 1;
  out[offset + 1] = repeatU;
  out[offset + 2] = repeatV;
  out[offset + 3] = 0;
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

// ── Roster-wide assignment ───────────────────────────────────────────────
//
// The Formik is the reference, not a special case. Every band on this sheet
// was drawn against one of its parts, so what those parts ARE becomes the role
// table the whole roster is charted from: a hull lobe is plated armour, the
// forward lobe is a nose facet, a turret head is a sensor dome, a barrel is a
// barrel shaft, a leg segment is a hydraulic strut and its knuckle a bolt
// boss, and the team kit is livery. No code branches on a blueprint id; a new
// unit is charted because it has those parts, not because it was listed.
//
// The only thing that changes from host to host is the REPEAT (see
// chartRepeat), which is what holds every one of those features at the size it
// was drawn at.

/** Chart for a body lobe. The forward-most lobe of a composite is the unit's
 *  face from the RTS camera, so it takes the harder-edged facet band while
 *  everything behind it shares plated armour — which is precisely the split
 *  the Formik's three lobes were drawn with. */
export function bodyLobeChart(isForwardLobe: boolean): SurfaceChartId {
  return isForwardLobe ? 'hullNose' : 'hullShell';
}

/** Charts for one unit's instanced locomotion slots. The leg pools are
 *  role-separated already (upper cylinder / lower cylinder / joint sphere), so
 *  this is a straight role -> chart table rather than anything per-instance. */
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
  'hullShell',
  'hullNose',
  'sensorDome',
  'barrelShaft',
  LEG_CHARTS.upper,
  LEG_CHARTS.lower,
  LEG_CHARTS.joint,
  'liveryStrap',
  'liveryCollar',
  'wheelTyre',
  'trackRun',
  'trackCleat',
  'trackBelt',
];
