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

export const TRIM_SHEET_PIXELS = 1024;
export const TRIM_BAND_PIXELS = TRIM_SHEET_PIXELS / TRIM_BAND_ORDER.length;

/** Gutter at the top and bottom of every band, filled by extending the band's
 *  own edge content. Mip levels average neighbouring texels, so without a
 *  gutter the bottom of `armorPlate` bleeds into the top of `noseFacet` two or
 *  three mips down and a hull lobe picks up nose facets at distance. */
export const TRIM_BAND_GUTTER_PIXELS = 12;

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
  /** Repeats across the surface's own u axis (around a cylinder, around a
   *  sphere's azimuth, along a sweep's arc length). */
  tileU: number;
  /** Repeats across v (along a cylinder's axis, pole-to-pole on a sphere,
   *  across a sweep's cross-section). Usually 1: most bands are authored to
   *  span their surface once so features land at a chosen place rather than
   *  repeating into a stripe pattern. */
  tileV: number;
  /** True for charts that carry team/player identity. Only these may be
   *  driven by a team color, and only these are counted toward the livery
   *  coverage budget. */
  livery: boolean;
};

// TILING RATES ARE AN ASPECT-RATIO PROBLEM, not a taste one.
//
// A band is TRIM_SHEET_PIXELS wide by roughly an eighth of that tall — about
// 10:1. Mapping that onto a surface whose own parameterization is nearer 1:1
// stretches every feature tenfold along u, and plates, facets and rivets all
// smear into a vertical comb. The rates below undo that.
//
// For a SPHERE, u covers the circumference C and one v repeat covers the
// half-meridian C/2, so texel densities are 1024/C across and
// tileV·(band height)/(C/2) down. Square cells therefore want
// tileV ≈ 1024 / (2 · bandHeight) ≈ 5. Values a little under that leave
// plate courses slightly wider than tall, which is what real plating does.
//
// For a CYLINDER the ratio depends on radius against length, and thin
// cylinders (barrels, leg struts) genuinely want the band compressed around
// the circumference — that is what turns the authored column rhythm into
// fluting. Those keep tileU 1.
const CHART_DEFS: Record<Exclude<SurfaceChartId, 'none'>, SurfaceChartDef> = {
  hullShell: { band: 'armorPlate', tileU: 1, tileV: 3, livery: false },
  hullNose: { band: 'noseFacet', tileU: 1, tileV: 2, livery: false },
  sensorDome: { band: 'sensorDome', tileU: 1, tileV: 3, livery: false },
  barrelShaft: { band: 'barrelShaft', tileU: 1, tileV: 1, livery: false },
  legStrut: { band: 'hydraulicStrut', tileU: 1, tileV: 1, livery: false },
  legJoint: { band: 'boltBoss', tileU: 1, tileV: 2, livery: false },
  // The strap sweep parameterizes u by arc length and v across a narrow
  // cross-section, so one band repeat over the whole run is already close to
  // square — the authored clamp count becomes the clamp count on the strap.
  liveryStrap: { band: 'liveryPiping', tileU: 1, tileV: 1, livery: true },
  liveryCollar: { band: 'liveryChevron', tileU: 2, tileV: 1, livery: true },
};

export function bandIndex(band: TrimBandId): number {
  const index = TRIM_BAND_ORDER.indexOf(band);
  if (index < 0) throw new Error(`[surface chart] unknown trim band ${band}`);
  return index;
}

/** The v range of a band's CONTENT — inside its gutters. Fragments never
 *  sample the gutter directly; it exists only so mip filtering has same-band
 *  texels to average into. */
export function bandContentRange(band: TrimBandId): { v0: number; vSpan: number } {
  const index = bandIndex(band);
  const top = index * TRIM_BAND_PIXELS + TRIM_BAND_GUTTER_PIXELS;
  const height = TRIM_BAND_PIXELS - TRIM_BAND_GUTTER_PIXELS * 2;
  return { v0: top / TRIM_SHEET_PIXELS, vSpan: height / TRIM_SHEET_PIXELS };
}

export function isLiveryChart(chart: SurfaceChartId): boolean {
  return chart !== 'none' && CHART_DEFS[chart].livery;
}

/** Per-instance shader payload: (v0, vSpan, tileU, tileV).
 *
 *  Carrying the band's v range directly rather than an index into a uniform
 *  table means the shader needs no lookup and JS stays the sole owner of the
 *  sheet layout. `vSpan === 0` is the sentinel for "no chart" — the shader
 *  tests exactly that, so an unwritten (zero-filled) attribute slot is
 *  correctly untextured without any initialization pass. */
export function packChart(chart: SurfaceChartId, out: Float32Array, offset: number): void {
  if (chart === 'none') {
    out[offset] = 0;
    out[offset + 1] = 0;
    out[offset + 2] = 0;
    out[offset + 3] = 0;
    return;
  }
  const def = CHART_DEFS[chart];
  const { v0, vSpan } = bandContentRange(def.band);
  out[offset] = v0;
  out[offset + 1] = vSpan;
  out[offset + 2] = def.tileU;
  out[offset + 3] = def.tileV;
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
