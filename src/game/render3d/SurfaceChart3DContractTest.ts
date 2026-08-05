// Contract test for the procedural texturing pipeline: the chart catalog, the
// trim sheet's layout, and the channel encoding the shader depends on.
//
// The invariants here are the ones whose violation is INVISIBLE in review and
// obvious only as a rendering artifact three steps downstream — a band that
// overlaps its neighbour, an alpha channel that silently premultiplies the
// colour channels away, a livery band dark enough to kill the team read.

import {
  FORMIK_BODY_PART_CHARTS,
  FORMIK_CHARTS,
  FORMIK_LEG_CHARTS,
  TRIM_BAND_GUTTER_PIXELS,
  TRIM_BAND_ORDER,
  TRIM_BAND_PIXELS,
  TRIM_SHEET_PIXELS,
  bandContentRange,
  isLiveryChart,
  packChart,
  type SurfaceChartId,
  type TrimBandId,
} from './SurfaceChart3D';
import { buildTrimSheetCanvasForTest } from './TrimSheetTexture';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[surface chart contract] ${message}`);
}

/** Charts the Formik actually carries, in the order the catalog lists them. */
const LIVERY_CHARTS: readonly SurfaceChartId[] = ['liveryStrap', 'liveryCollar'];

function bandOf(chart: SurfaceChartId): TrimBandId | null {
  if (chart === 'none') return null;
  const packed = new Float32Array(4);
  packChart(chart, packed, 0);
  for (const band of TRIM_BAND_ORDER) {
    const range = bandContentRange(band);
    if (Math.abs(range.v0 - packed[0]) < 1e-9) return band;
  }
  return null;
}

function checkCatalog(): void {
  assertContract(
    TRIM_SHEET_PIXELS % TRIM_BAND_ORDER.length === 0,
    'band count must divide the sheet evenly, or bands land on fractional rows',
  );
  assertContract(
    TRIM_BAND_PIXELS > TRIM_BAND_GUTTER_PIXELS * 2 + 8,
    'gutters must leave a usable content strip',
  );
  assertContract(
    new Set(TRIM_BAND_ORDER).size === TRIM_BAND_ORDER.length,
    'every trim band must appear exactly once in the layout order',
  );

  // Content ranges must be disjoint AND separated, since the whole point of
  // the gutter is that mip filtering never mixes two bands.
  let previousEnd = -1;
  for (const band of TRIM_BAND_ORDER) {
    const { v0, vSpan } = bandContentRange(band);
    assertContract(vSpan > 0, `${band} must have content`);
    assertContract(
      v0 > previousEnd,
      `${band} content overlaps the band above it`,
    );
    if (previousEnd >= 0) {
      const gapPixels = (v0 - previousEnd) * TRIM_SHEET_PIXELS;
      assertContract(
        gapPixels >= TRIM_BAND_GUTTER_PIXELS * 2 - 1e-6,
        `${band} must be separated from its neighbour by both gutters — `
          + `got ${gapPixels.toFixed(1)}px`,
      );
    }
    previousEnd = v0 + vSpan;
  }
  assertContract(previousEnd <= 1 + 1e-9, 'the last band must fit in the sheet');

  // 'none' must pack to all zeroes: the shader's active test is `vChart.y > 0`,
  // which is what makes a zero-filled (never-written) slot correctly untextured
  // and keeps every non-charted entity pixel-identical to before.
  const packed = new Float32Array(4);
  packChart('none', packed, 0);
  assertContract(
    packed.every((value) => value === 0),
    'the "none" chart must pack to all zeroes — an unwritten slot depends on it',
  );

  const usedBands = new Set<TrimBandId>();
  for (const chart of FORMIK_CHARTS) {
    packChart(chart, packed, 0);
    assertContract(
      packed[1] > 0,
      `${chart} is assigned to the Formik but packs as untextured`,
    );
    assertContract(
      packed[2] > 0 && packed[3] > 0,
      `${chart} must tile at a positive rate on both axes`,
    );
    const band = bandOf(chart);
    assertContract(band !== null, `${chart} must resolve to a real band`);
    usedBands.add(band);
  }
  // A band nothing references is a band nobody will notice is broken.
  for (const band of TRIM_BAND_ORDER) {
    assertContract(
      usedBands.has(band),
      `trim band ${band} is generated but no chart uses it`,
    );
  }
}

/** SUBSTANCE vs LIVERY is the split that makes team-colour coverage auditable
 *  rather than eyeballed. It only holds if the two sets stay disjoint. */
function checkLiverySeparation(): void {
  for (const chart of LIVERY_CHARTS) {
    assertContract(isLiveryChart(chart), `${chart} must be marked as livery`);
  }
  const substance = FORMIK_CHARTS.filter((chart) => !LIVERY_CHARTS.includes(chart));
  for (const chart of substance) {
    assertContract(
      !isLiveryChart(chart),
      `${chart} is a substance surface and must not be marked livery — `
        + 'livery is the only thing allowed to carry team identity',
    );
  }
  assertContract(
    FORMIK_BODY_PART_CHARTS.every((chart) => !isLiveryChart(chart)),
    'the hull is player-coloured; no hull lobe may be a livery surface',
  );
  assertContract(
    !isLiveryChart(FORMIK_LEG_CHARTS.upper) &&
      !isLiveryChart(FORMIK_LEG_CHARTS.lower) &&
      !isLiveryChart(FORMIK_LEG_CHARTS.joint),
    'locomotion is substance, not livery',
  );
}

type BandStats = {
  meanR: number;
  minR: number;
  maxR: number;
  meanG: number;
  meanB: number;
};

function bandStats(pixels: Uint8ClampedArray, band: TrimBandId): BandStats {
  const { v0, vSpan } = bandContentRange(band);
  const top = Math.round(v0 * TRIM_SHEET_PIXELS);
  const bottom = Math.round((v0 + vSpan) * TRIM_SHEET_PIXELS);
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let minR = 255;
  let maxR = 0;
  let count = 0;
  for (let y = top; y < bottom; y++) {
    for (let x = 0; x < TRIM_SHEET_PIXELS; x++) {
      const i = (y * TRIM_SHEET_PIXELS + x) * 4;
      const r = pixels[i];
      sumR += r;
      sumG += pixels[i + 1];
      sumB += pixels[i + 2];
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      count++;
    }
  }
  return {
    meanR: sumR / count,
    minR,
    maxR,
    meanG: sumG / count,
    meanB: sumB / count,
  };
}

function checkTrimSheet(): void {
  const canvas = buildTrimSheetCanvasForTest();
  assertContract(
    canvas.width === TRIM_SHEET_PIXELS && canvas.height === TRIM_SHEET_PIXELS,
    'trim sheet must be generated at its declared size',
  );
  const context = canvas.getContext('2d');
  assertContract(context !== null, 'trim sheet canvas exposes a 2D context');
  const pixels = context.getImageData(0, 0, TRIM_SHEET_PIXELS, TRIM_SHEET_PIXELS).data;

  // ALPHA MUST BE OPAQUE EVERYWHERE. Canvas backing stores are premultiplied,
  // so any texel with alpha < 255 would have its colour channels scaled down on
  // the way in — silently corrupting the height and wear masks that live in G
  // and B. This is the check that keeps the channel packing honest.
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] !== 255) {
      const texel = (i - 3) / 4;
      throw new Error(
        `[surface chart contract] trim sheet texel ${texel % TRIM_SHEET_PIXELS},`
        + `${Math.floor(texel / TRIM_SHEET_PIXELS)} is not opaque (alpha `
        + `${pixels[i]}). Canvas premultiplies, so a transparent texel would `
        + 'crush the packed height/wear channels.',
      );
    }
  }

  for (const band of TRIM_BAND_ORDER) {
    const stats = bandStats(pixels, band);
    const isLivery = band === 'liveryPiping' || band === 'liveryChevron';

    assertContract(
      stats.maxR - stats.minR > 40,
      `${band} has almost no albedo structure (range ${stats.maxR - stats.minR}) `
        + '— a flat band is a tint, not a texture',
    );

    if (isLivery) {
      // Livery exists to be read as team colour at a glance. The albedo
      // multiplier decodes as texel/255 × 2, so a mean of 128 is neutral;
      // drifting dark here dims exactly the signal the band carries.
      assertContract(
        stats.meanR > 108 && stats.meanR < 168,
        `${band} must stay near neutral so the team colour survives — `
          + `mean R ${stats.meanR.toFixed(1)} (128 is neutral)`,
      );
      // Wear may cut through livery, but only sparsely: a strap that is mostly
      // bare metal is no longer a team marker.
      assertContract(
        stats.meanB < 48,
        `${band} reveals too much bare metal (mean B ${stats.meanB.toFixed(1)}) `
          + '— wear must cut through team paint, not replace it',
      );
    }

    // Height has to actually vary or the derivative bump is a no-op and the
    // whole band renders as a flat decal.
    assertContract(
      stats.meanG > 8 && stats.meanG < 248,
      `${band} height field is saturated (mean ${stats.meanG.toFixed(1)}) — `
        + 'the bump reads its gradient, so a constant height does nothing',
    );
  }

  // Gutters must be a copy of the band's own edge row, not the neighbour's
  // content. Sample the row just outside the content and compare to the row
  // just inside it.
  for (let index = 0; index < TRIM_BAND_ORDER.length; index++) {
    const band = TRIM_BAND_ORDER[index];
    const { v0, vSpan } = bandContentRange(band);
    const contentTop = Math.round(v0 * TRIM_SHEET_PIXELS);
    const contentBottom = Math.round((v0 + vSpan) * TRIM_SHEET_PIXELS) - 1;
    for (const [outside, inside] of [
      [contentTop - 2, contentTop],
      [contentBottom + 2, contentBottom],
    ]) {
      let diff = 0;
      for (let x = 0; x < TRIM_SHEET_PIXELS; x += 37) {
        const a = (outside * TRIM_SHEET_PIXELS + x) * 4;
        const b = (inside * TRIM_SHEET_PIXELS + x) * 4;
        diff += Math.abs(pixels[a] - pixels[b]);
      }
      assertContract(
        diff === 0,
        `${band} gutter at row ${outside} does not mirror its edge row `
          + `${inside} — mip filtering will bleed the neighbouring band in`,
      );
    }
  }
}

export function runSurfaceChart3DContractTest(): void {
  checkCatalog();
  checkLiverySeparation();
  checkTrimSheet();
}
