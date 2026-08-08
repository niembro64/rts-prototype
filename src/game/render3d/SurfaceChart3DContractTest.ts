// Contract test for the procedural texturing pipeline: the chart catalog, the
// trim sheet's layout, and the channel encoding the shader depends on.
//
// The invariants here are the ones whose violation is INVISIBLE in review and
// obvious only as a rendering artifact three steps downstream — a band that
// overlaps its neighbour, an alpha channel that silently premultiplies the
// colour channels away, a livery band dark enough to kill the team read.

import * as THREE from 'three';
import {
  applyEntityGroupFade,
  DyingMeshFade,
  disposeEntityGroupFade,
  patchInstancedFadeMaterial,
} from './EntityFade3D';
import type { EntityId } from '../sim/types';
import { patchSurfaceChartMaterial } from './SurfaceChartMaterial3D';
import {
  BAND_COARSE_TIER,
  BAND_FINE_TIER,
  BAND_SURFACE,
  BAND_CLOSED_U,
  BAND_TILE_AXES,
  BAND_WRAPS_V,
  GRAIN_BAND,
  GRAIN_TILE_WORLD_UNITS,
  LEG_CHARTS,
  ROSTER_CHARTS,
  CHART_TIER_TOLERANCE,
  bandRepeatsForHost,
  chartBandForHost,
  chartRepeat,
  TRIM_BAND_GUTTER_PIXELS,
  TRIM_BAND_ORDER,
  TRIM_SHEET_PIXELS,
  TRIM_SHEET_TEXELS_PER_UNIT,
  bandContentRect,
  bandFeatureCounts,
  bandRectPx,
  bandRectUniformArray,
  packedSheetHeight,
  isLiveryChart,
  packChart,
  type BaseTrimBandId,
  type SurfaceChartId,
  type TrimBandId,
} from './SurfaceChart3D';
import { buildTrimSheetCanvasForTest, getTrimSheetTexture } from './TrimSheetTexture';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[surface chart contract] ${message}`);
}

/** A band's CONTENT bounds in sheet pixels. Bands are packed rectangles, so
 *  every pixel scan below has to walk the band's own x range — scanning the
 *  full sheet width would sample whatever was packed beside it. */
function bandPixelBounds(band: TrimBandId): {
  x0: number; x1: number; y0: number; y1: number; width: number; height: number;
} {
  const rect = bandRectPx(band);
  const g = TRIM_BAND_GUTTER_PIXELS;
  const x0 = rect.x + g;
  const y0 = rect.y + g;
  const width = rect.width - g * 2;
  const height = rect.height - g * 2;
  return { x0, x1: x0 + width, y0, y1: y0 + height, width, height };
}

/** The only two charts allowed to carry team identity. */
const LIVERY_CHARTS: readonly SurfaceChartId[] = ['liveryStrap', 'liveryCollar'];

/**
 * Host sizes to check density at, as multiples of the reference part.
 *
 * The roster's real sizes are in here — hull radii 9 to 94 against the
 * Formik's 40, legs 10 to 94, wheels 2.24 against 4.4 — and then a sweep
 * BETWEEN them, because the next unit anyone adds will land somewhere we did
 * not pick. Density is a property of a size, not of a blueprint, so the check
 * is over sizes.
 */
const ROSTER_HOST_SCALES: readonly number[] = [
  0.225, 0.25, 0.275, 0.325, 0.4, 0.45, 0.5, 0.509, 0.7, 0.75, 0.85, 1, 1.9, 2.3, 2.35,
  ...Array.from({ length: 45 }, (_, i) => 0.2 + i * 0.05),
];

/**
 * How far off the sheet's texel density any host may land.
 *
 * 1.5, and that number is structural rather than chosen. A closed axis has to
 * repeat a whole number of times, so a host landing between two whole repeats
 * is quantized to the nearer one, and the worst place to stand is just under
 * one-and-a-half wraps: the truth is 1.49 and the nearest whole number is 1,
 * so the host wears half again the detail it should. Rounding DOWN at a low
 * repeat count is the expensive direction — at 2.5 wraps the same half-repeat
 * miss is only 1.25 — which is why the small end of the roster is the end that
 * needed a second tier at all.
 *
 * Nothing beats 1.5 with two tiers. A third would, by putting another repeat
 * boundary inside the gap; it would also cost another band's sheet area and
 * another motif for a big hull to repeat. The roster's real sizes all come in
 * under 1.30 today, so that bill has not come due.
 */
const MAX_TEXEL_DENSITY_ERROR = 1.5;

function bandOf(chart: SurfaceChartId): TrimBandId | null {
  if (chart === 'none') return null;
  const packed = new Float32Array(4);
  packChart(chart, packed, 0);
  return TRIM_BAND_ORDER[Math.round(packed[0]) - 1] ?? null;
}

function checkCatalog(): void {
  assertContract(
    new Set(TRIM_BAND_ORDER).size === TRIM_BAND_ORDER.length,
    'every trim band must appear exactly once in the layout order',
  );

  // THE HEADLINE INVARIANT. Every charted surface is textured at one texel
  // density, on both axes. Uniformity is what makes the set read as a single
  // material system; a band sharper, softer, or stretched relative to its
  // neighbours announces itself immediately on the model. The old full-width
  // strip layout could not hold this — density there was 2048/uExtent, a 34x
  // spread between bands and up to 93x skew within one.
  for (const band of TRIM_BAND_ORDER) {
    const surface = BAND_SURFACE[band];
    const rect = bandRectPx(band);
    const du = (rect.width - TRIM_BAND_GUTTER_PIXELS * 2) / surface.uExtent;
    const dv = (rect.height - TRIM_BAND_GUTTER_PIXELS * 2) / surface.vExtent;
    for (const [axis, density] of [['u', du], ['v', dv]] as [string, number][]) {
      assertContract(
        Math.abs(density - TRIM_SHEET_TEXELS_PER_UNIT) < 0.35,
        `${band} resolves ${density.toFixed(2)} texels per world unit along `
          + `${axis}, not the sheet's ${TRIM_SHEET_TEXELS_PER_UNIT}`,
      );
    }
    assertContract(
      Math.abs(du / dv - 1) < 0.06,
      `${band} is skewed ${(du / dv).toFixed(2)}:1 between its own axes`,
    );
  }

  // The packing must fit, and no two bands may overlap — they would bleed into
  // each other under mip filtering.
  assertContract(
    packedSheetHeight() <= TRIM_SHEET_PIXELS,
    `band packing needs ${packedSheetHeight()} rows of a ${TRIM_SHEET_PIXELS} sheet`,
  );
  for (const a of TRIM_BAND_ORDER) {
    const ra = bandRectPx(a);
    for (const b of TRIM_BAND_ORDER) {
      if (a === b) continue;
      const rb = bandRectPx(b);
      const overlaps = ra.x < rb.x + rb.width && rb.x < ra.x + ra.width
        && ra.y < rb.y + rb.height && rb.y < ra.y + ra.height;
      assertContract(!overlaps, `${a} and ${b} overlap in the packed sheet`);
    }
    assertContract(
      ra.x + ra.width <= TRIM_SHEET_PIXELS && ra.y + ra.height <= TRIM_SHEET_PIXELS,
      `${a} runs off the sheet`,
    );
    assertContract(
      ra.width > TRIM_BAND_GUTTER_PIXELS * 2 + 16
        && ra.height > TRIM_BAND_GUTTER_PIXELS * 2 + 16,
      `${a} must leave a usable content area inside its gutters`,
    );
  }


  // 'none' must pack to all zeroes. The shader's active test is on BOTH spans
  // (z and w) together, which is what makes two different kinds of "unwritten"
  // resolve to "no placed chart": a never-touched Float32Array slot, and a
  // geometry with no aChart attribute at all — WebGL hands the latter its
  // default generic attribute (0, 0, 0, 1), so a test on w alone would read it
  // as a real chart and sample a garbage rectangle. Most surfaces in the game
  // now wear this material without a chart buffer.
  const packed = new Float32Array(4);
  packChart('none', packed, 0);
  assertContract(
    packed.every((value) => value === 0),
    'the "none" chart must pack to all zeroes — an unwritten slot depends on it',
  );

  const usedBands = new Set<TrimBandId>([GRAIN_BAND]);
  for (const chart of ROSTER_CHARTS) {
    packChart(chart, packed, 0);
    assertContract(packed[0] >= 1, `${chart} must resolve to a real band code`);
    const band = bandOf(chart);
    assertContract(band !== null, `${chart} must resolve to a real band`);
    // Across the ROSTER's sizes, not just the reference host's. A band has two
    // size tiers and which one a chart lands on is decided by the host, so
    // "used" can only be answered by asking every host the roster has.
    for (const scale of ROSTER_HOST_SCALES) usedBands.add(chartBandForHost(chart, scale));

    // THE REFERENCE HOST IS NOT A SPECIAL CASE, and this is what keeps that
    // true without letting it drift. A host the same size as the one every
    // band was drawn against must resolve to exactly one wrap on both axes,
    // which is what makes its charts identical to the band as drawn — the
    // shader clamps rather than wraps at or below one repeat, so 1 means "as
    // authored". Everything else here is the generalization; this is the fixed
    // point it generalizes FROM.
    const [refU, refV] = chartRepeat(chart, 1);
    assertContract(
      refU === 1 && refV === 1,
      `${chart} must be exactly one wrap at reference scale — got ${refU}x${refV}`,
    );

    // ...and a host twice the size must repeat on every axis the band allows,
    // because that is the only thing holding its features at the size they
    // were drawn. An axis that refuses to tile is stating that it carries a
    // PLACED feature (see BAND_TILE_AXES); one that tiles must actually do it.
    const axes = BAND_TILE_AXES[band];
    const [bigU, bigV] = chartRepeat(chart, 2);
    assertContract(
      bigU === (axes.u ? 2 : 1) && bigV === (axes.v ? 2 : 1),
      `${chart} repeats ${bigU}x${bigV} at twice reference scale, which does `
        + `not match its band's declared tiling (${axes.u}, ${axes.v})`,
    );
  }

  // A tiling v axis has to have wrapping v gutters, or the repeat shows up as
  // a filtered line every time the band comes round.
  for (const band of TRIM_BAND_ORDER) {
    assertContract(
      BAND_WRAPS_V.has(band) === BAND_TILE_AXES[band].v,
      `${band}'s v gutters and its v tiling disagree`,
    );
  }

  // A CLOSED u MUST REPEAT A WHOLE NUMBER OF TIMES. The band's content is
  // authored continuous across its own edge, so on a sphere's azimuth or a
  // cylinder's circumference a fractional repeat lands the surface's seam
  // mid-band and the plating mismatches along one meridian — a hairline of
  // wrong texture running pole to pole, which reads as a modelling error
  // rather than a texturing one. Rounding costs at most half a repeat of
  // feature size and removes it entirely.
  for (const chart of ROSTER_CHARTS) {
    packChart(chart, packed, 0);
    const band = bandOf(chart);
    if (band === null || !BAND_CLOSED_U.has(band)) continue;
    for (const scale of [0.4, 1, 1.37, 2.35, 6.8]) {
      const [repeatU] = chartRepeat(chart, scale);
      assertContract(
        repeatU >= 1 && Number.isInteger(repeatU),
        `${chart} wraps a closed surface, so its u repeat must be a whole `
          + `number — at host scale ${scale} it is ${repeatU}`,
      );
    }
  }
  // TEXEL DENSITY, MEASURED, ACROSS THE WHOLE ROSTER.
  //
  // Everything above checks the MECHANISM — whole repeats, tiling axes, the
  // reference host being one wrap. None of it checks the thing the mechanism
  // is for, and that is exactly how a real bug shipped: `trackBeltPlate` was
  // marked closed-u, every rule above still passed, and a Lynx wore its whole
  // side frame at 3x the sheet's density. This asks the only question that
  // matters — how many texels per world unit does this host actually get —
  // and it asks it of every host size the roster contains.
  //
  // The bound is not 1.0 because a closed axis cannot hit 1.0: it has to come
  // out whole, so a host between two whole repeats is quantized to one of
  // them. Two size tiers a quarter apart bound that miss at 1.3x, which is
  // where this sits. One tier bounded it at 4.4x, which is what it was.
  for (const chart of ROSTER_CHARTS) {
    const referenceBand = bandOf(chart);
    if (referenceBand === null || !BAND_TILE_AXES[referenceBand].u) continue;
    for (const scale of ROSTER_HOST_SCALES) {
      const band = chartBandForHost(chart, scale);
      const [repeatU] = chartRepeat(chart, scale);
      // The host's own u extent is the reference part's, scaled by the host.
      const hostExtent = BAND_SURFACE[referenceBand].uExtent * scale;
      const density = (BAND_SURFACE[band].uExtent * repeatU) / hostExtent;
      const error = density >= 1 ? density : 1 / density;
      assertContract(
        error <= MAX_TEXEL_DENSITY_ERROR,
        `${chart} on a host of scale ${scale} lands at ${density.toFixed(2)}x the `
          + `sheet's texel density (band ${band}, ${repeatU} wraps) — the whole `
          + 'point of the trim sheet is that this number is 1',
      );

      // AND THE TIER PICKED IS THE BETTER ONE. The bound above is satisfiable
      // by a mechanism that picks tiers badly and happens to stay inside it,
      // which is exactly the state this started in — one tier, no choice, and
      // every rule passing. Once the coarse tier is out of tolerance the only
      // defensible answer is whichever tier actually lands closer.
      const other = BAND_COARSE_TIER[band as never] !== undefined
        ? referenceBand
        : BAND_FINE_TIER[referenceBand as BaseTrimBandId];
      if (other === undefined || other === band) continue;
      const otherDensity = (BAND_SURFACE[other].uExtent * bandRepeatsForHost(other, scale)[0])
        / hostExtent;
      const otherError = otherDensity >= 1 ? otherDensity : 1 / otherDensity;
      // The epsilon is real: a host sitting exactly on the tolerance has its
      // error computed here from extents and there from a ratio of repeats,
      // and the two land either side of 1.2 in the last bit.
      assertContract(
        error <= otherError || error <= CHART_TIER_TOLERANCE + 1e-9,
        `${chart} on a host of scale ${scale} took band ${band} at ${error.toFixed(2)}x `
          + `when ${other} would have landed at ${otherError.toFixed(2)}x`,
      );
    }
  }

  // A band nothing references is a band nobody will notice is broken.
  for (const band of TRIM_BAND_ORDER) {
    assertContract(
      usedBands.has(band),
      `trim band ${band} is generated but no chart uses it`,
    );
  }

  // THE BAND RECTANGLE UNIFORM is what the chart attribute's band code indexes
  // into. If the array and the packing ever disagreed, every charted surface
  // in the game would sample a neighbouring band at once — and it would look
  // like the wrong texture rather than like a bug.
  const uniforms = bandRectUniformArray();
  for (let i = 0; i < TRIM_BAND_ORDER.length; i++) {
    const rect = bandContentRect(TRIM_BAND_ORDER[i]);
    assertContract(
      uniforms[i * 4] === rect.u0 && uniforms[i * 4 + 1] === rect.v0 &&
        uniforms[i * 4 + 2] === rect.uSpan && uniforms[i * 4 + 3] === rect.vSpan,
      `band uniform ${i} does not address ${TRIM_BAND_ORDER[i]}`,
    );
  }

  // The grain is PROJECTED, not charted, so its band must be square in world
  // terms: the projection divides both axes by one world size, and a
  // non-square band would grain one axis finer than the other everywhere.
  const grain = BAND_SURFACE[GRAIN_BAND];
  assertContract(
    grain.uExtent === GRAIN_TILE_WORLD_UNITS && grain.vExtent === GRAIN_TILE_WORLD_UNITS,
    'the grain tile must be square — the shader divides both axes by one '
      + 'world size, so a non-square band skews every surface in the game',
  );
  // And its plate must be the HULL's plate. The grain is what an uncharted
  // surface — a building wall, a wheel, a fan — is made of, and if its plate
  // were a different size from the charted hull's, a structure and the unit
  // parked beside it would visibly be different stock.
  assertContract(
    grain.featureSize === BAND_SURFACE.armorPlate.featureSize,
    `the grain's plate is ${grain.featureSize} world units against the hull's `
      + `${BAND_SURFACE.armorPlate.featureSize} — uncharted surfaces must be `
      + 'made of the same metal at the same scale as charted ones',
  );
}

/** SUBSTANCE vs LIVERY is the split that makes team-colour coverage auditable
 *  rather than eyeballed. It only holds if the two sets stay disjoint. */
function checkLiverySeparation(): void {
  for (const chart of LIVERY_CHARTS) {
    assertContract(isLiveryChart(chart), `${chart} must be marked as livery`);
  }
  const substance = ROSTER_CHARTS.filter(
    (chart: SurfaceChartId) => !LIVERY_CHARTS.includes(chart),
  );
  for (const chart of substance) {
    assertContract(
      !isLiveryChart(chart),
      `${chart} is a substance surface and must not be marked livery — `
        + 'livery is the only thing allowed to carry team identity',
    );
  }
  assertContract(
    !isLiveryChart('hullShell') && !isLiveryChart('hullNose'),
    'the hull is player-coloured; no hull lobe may be a livery surface',
  );
  assertContract(
    !isLiveryChart(LEG_CHARTS.upper) &&
      !isLiveryChart(LEG_CHARTS.lower) &&
      !isLiveryChart(LEG_CHARTS.joint),
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
  const b = bandPixelBounds(band);
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let minR = 255;
  let maxR = 0;
  let count = 0;
  for (let y = b.y0; y < b.y1; y++) {
    for (let x = b.x0; x < b.x1; x++) {
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

/** The sheet is authored in canvas-row space, so row r must land at texture
 *  v = r/size. three.js flips textures on upload by default, which mirrors the
 *  whole band stack and makes every chart sample the band opposite its own —
 *  the hull drawing chevrons, the collar drawing hull plating. Nothing renders
 *  as obviously broken, so this is load-bearing and pinned. */
function checkSheetOrientation(): void {
  const texture = getTrimSheetTexture();
  assertContract(
    texture.flipY === false,
    'the trim sheet must upload unflipped — bandContentRange derives each '
      + 'band\'s v range from the canvas rows it was drawn into, and a flip '
      + 'mirrors the entire band stack',
  );
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

    // THE GRAIN MULTIPLIES EVERY SURFACE IN THE GAME. Its R channel decodes
    // x2, so a mean away from 128 does not darken one part — it shifts the
    // brightness of the entire roster, terrain excepted, and it does it in a
    // way that reads as a lighting change rather than as a texture bug.
    if (band === GRAIN_BAND) {
      assertContract(
        stats.meanR > 112 && stats.meanR < 144,
        `the substance grain must average neutral — mean R ${stats.meanR.toFixed(1)} `
          + '(128 is x1). It multiplies every surface in the game, so drifting '
          + 'here re-lights the whole roster.',
      );
    }

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

  checkNoBakedDirectionalShading(pixels);
  checkBaseColourSurvives(pixels);
  checkPitchSlot(pixels);

  // Gutters, all four sides. The v gutters extend the band's own edge rows;
  // the u gutters WRAP — a surface's u seam joins its right edge to its left,
  // so the left gutter is filled from the right content edge and vice versa.
  // Both exist so mip filtering never averages in a neighbouring band.
  for (const band of TRIM_BAND_ORDER) {
    const b = bandPixelBounds(band);
    const at = (x: number, y: number): number =>
      pixels[(y * TRIM_SHEET_PIXELS + x) * 4];

    // A TILING band's v gutters wrap from the opposite edge, exactly as its u
    // gutters do — its top and bottom are the same place on the surface. A
    // PLACED band's v runs pole to pole and only extends. Getting this
    // backwards on the grain would put a filtered line across every entity in
    // the game once every tile.
    const wrapsV = BAND_WRAPS_V.has(band);
    for (const [outside, inside] of wrapsV
      ? [[b.y0 - 2, b.y1 - 1], [b.y1 + 1, b.y0]]
      : [[b.y0 - 2, b.y0], [b.y1 + 1, b.y1 - 1]]
    ) {
      let diff = 0;
      for (let x = b.x0; x < b.x1; x += 37) diff += Math.abs(at(x, outside) - at(x, inside));
      assertContract(
        diff === 0,
        `${band} v gutter at row ${outside} does not ${wrapsV ? 'wrap from' : 'extend'} `
          + `row ${inside}`,
      );
    }
    for (const [outside, inside] of [
      [b.x0 - 2, b.x1 - 1],
      [b.x1 + 1, b.x0],
    ]) {
      let diff = 0;
      for (let y = b.y0; y < b.y1; y += 37) diff += Math.abs(at(outside, y) - at(inside, y));
      assertContract(
        diff === 0,
        `${band} u gutter at column ${outside} does not wrap from column `
          + `${inside} — mip filtering across the surface's u seam will show it`,
      );
    }
  }
}

/**
 * A charted material's shader source differs from an uncharted one's, so its
 * program cache key MUST differ too. three.js caches compiled programs by that
 * key: two materials that share a key share a program, and whichever compiles
 * first silently wins for both.
 *
 * That is not hypothetical. The chassis/turret/barrel pools apply the chart
 * patch and then the instanced-fade patch, and the fade patch used to
 * OVERWRITE the key with a constant — so the charted close/mid pools and the
 * uncharted far pool all reported the same key, and the body rendered with the
 * far tier's untextured program. Both orders are asserted because pools use
 * one and per-Mesh surfaces the other.
 */
function checkProgramCacheKeys(): void {
  const orders: [string, () => THREE.Material][] = [
    ['chart then fade (pool order)', () => {
      const material = new THREE.MeshLambertMaterial();
      patchSurfaceChartMaterial(material, { bump: true });
      patchInstancedFadeMaterial(material);
      return material;
    }],
    ['fade then chart', () => {
      const material = new THREE.MeshLambertMaterial();
      patchInstancedFadeMaterial(material);
      patchSurfaceChartMaterial(material, { bump: true });
      return material;
    }],
  ];
  const keys: string[] = [];
  for (const [label, build] of orders) {
    const material = build();
    const key = material.customProgramCacheKey?.() ?? '';
    assertContract(
      key.includes('chartBump'),
      `${label}: chart patch must survive in the program cache key — got `
        + `"${key}". A patcher that overwrites the key makes a charted and an `
        + 'uncharted material share one compiled program.',
    );
    assertContract(
      key.includes('entityFadeInstancedAlpha'),
      `${label}: fade patch must survive in the program cache key — got "${key}"`,
    );
    keys.push(key);
    material.dispose();
  }

  // An unpatched faded material — the far tier — must not collide with either.
  const plain = new THREE.MeshLambertMaterial();
  patchInstancedFadeMaterial(plain);
  const plainKey = plain.customProgramCacheKey?.() ?? '';
  for (const key of keys) {
    assertContract(
      key !== plainKey,
      'a charted material must not share a program cache key with an '
        + `uncharted faded one — both reported "${plainKey}"`,
    );
  }
  plain.dispose();
}

/**
 * No band may bake a directional highlight.
 *
 * A feature whose period is the FULL width of the band becomes, on a cylinder,
 * a light source welded to the geometry: it sits at fixed angles in the
 * surface's own frame, so as the part rotates you see its dark side facing the
 * camera. Legs are unlit, so there is no real shading to cover for it — this
 * is what made leg segments read as though you were looking at their backs.
 *
 * Structure must therefore be either constant across u or repeat MANY times
 * across it; both look identical from every direction.
 *
 * The test is a frequency one, and specifically a RATIO: what share of a band's
 * horizontal variance sits in the three lowest harmonics (period = the whole
 * circumference, or half, or a third). A smooth gradient puts essentially all
 * of its energy there. Bolted plating puts almost none — its energy lives at
 * the panel and bolt frequencies, an order of magnitude higher — even though
 * irregular panel widths and per-panel value variation do leak a little
 * downward. An absolute amplitude limit cannot separate those two: raise it
 * enough to permit honest plating and it stops catching a gradient.
 *
 * A half-band mean comparison does not work either, and was the first thing
 * tried: the offending gradient covered only the middle 60% of the band, so
 * averaging the collars in with it diluted the signal below any threshold.
 */
// A gradient trips BOTH of these; nothing else trips both.
//
// The share alone is not enough. A band that is almost perfectly uniform around
// its circumference — which is the ideal, and what the barrel's axial wear
// achieves — has almost no horizontal variance at all, so whatever little it
// has lands in the low bins and the SHARE spikes while the actual deviation
// stays invisible. The absolute amplitude alone is not enough either, for the
// reason above. Requiring both is what separates "a light baked into the
// surface" from "a nearly uniform surface" and from "honest plating".
const MAX_LOW_HARMONIC_SHARE = 0.30;
const MAX_LOW_HARMONIC_AMPLITUDE = 8;

function lowHarmonicStats(
  pixels: Uint8ClampedArray,
  band: TrimBandId,
): { share: number; amplitude: number } {
  const b = bandPixelBounds(band);
  let lowPower = 0;
  let totalPower = 0;
  let peakAmplitude = 0;
  for (let y = b.y0; y < b.y1; y++) {
    let mean = 0;
    for (let x = b.x0; x < b.x1; x++) {
      mean += pixels[(y * TRIM_SHEET_PIXELS + x) * 4];
    }
    mean /= b.width;
    for (let x = b.x0; x < b.x1; x++) {
      const dv = pixels[(y * TRIM_SHEET_PIXELS + x) * 4] - mean;
      totalPower += dv * dv;
    }
    for (let harmonic = 1; harmonic <= 3; harmonic++) {
      let re = 0;
      let im = 0;
      for (let x = 0; x < b.width; x++) {
        const value = pixels[(y * TRIM_SHEET_PIXELS + b.x0 + x) * 4];
        const angle = (2 * Math.PI * harmonic * x) / b.width;
        re += value * Math.cos(angle);
        im -= value * Math.sin(angle);
      }
      // Parseval: a real bin's contribution to the sum of squared deviations.
      lowPower += (2 * (re * re + im * im)) / b.width;
      const amplitude = (2 * Math.hypot(re, im)) / b.width;
      if (amplitude > peakAmplitude) peakAmplitude = amplitude;
    }
  }
  return {
    share: totalPower > 0 ? lowPower / totalPower : 0,
    amplitude: peakAmplitude,
  };
}

/** Bands that legitimately carry a feature at the circumference's own period.
 *
 *  The rule this check enforces is "do not bake LIGHTING into the surface",
 *  not "do not vary around the circumference". A hole is part of the object and
 *  is supposed to sit at a fixed azimuth in the object's frame; a highlight is
 *  not part of the object and must not. `sensorDome` carries the barrel pitch
 *  slot, which is a hole at local +X by construction. */
const DIRECTIONAL_EXEMPT_BANDS: ReadonlySet<TrimBandId> = new Set<TrimBandId>([
  'sensorDome',
]);

function checkNoBakedDirectionalShading(pixels: Uint8ClampedArray): void {
  for (const band of TRIM_BAND_ORDER) {
    if (DIRECTIONAL_EXEMPT_BANDS.has(band)) continue;
    const { share, amplitude } = lowHarmonicStats(pixels, band);
    assertContract(
      share < MAX_LOW_HARMONIC_SHARE || amplitude < MAX_LOW_HARMONIC_AMPLITUDE,
      `${band} puts ${(share * 100).toFixed(0)}% of its horizontal variance in `
        + `the three lowest harmonics, at amplitude ${amplitude.toFixed(1)}/255. `
        + 'That is a baked directional highlight: it locks to the geometry and '
        + 'turns its dark side to the camera as the part rotates, which reads '
        + 'as looking at the back of the surface.',
    );
  }
}

/** Dev aid: the measured low-harmonic share per band, for tuning the threshold
 *  above against real content rather than guesswork. */
export function measureBandLowHarmonics(): Record<string, string> {
  const canvas = buildTrimSheetCanvasForTest();
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('no 2D context');
  const pixels = context.getImageData(0, 0, TRIM_SHEET_PIXELS, TRIM_SHEET_PIXELS).data;
  const out: Record<string, string> = {};
  for (const band of TRIM_BAND_ORDER) {
    const { share, amplitude } = lowHarmonicStats(pixels, band);
    out[band] = `${(share * 100).toFixed(1)}% @ ${amplitude.toFixed(1)}`;
  }
  return out;
}

/**
 * The barrel pitch slot.
 *
 * Two things have to hold and neither is obvious from looking at the band:
 *
 * 1. It must run the FULL half-meridian, pole to pole. That is what lets the
 *    barrels travel from +90 degrees to -90 degrees without ever leaving it,
 *    and it is why `sensorDome` must keep tileV = 1 — any repeat stacks
 *    several short slots up the head instead.
 *
 * 2. Its width must be constant in ARC, not in pixels. A stripe of fixed pixel
 *    width narrows with sin(latitude) and comes out as a wedge that pinches
 *    shut at both poles — the exact failure the user would see as the slot
 *    "closing up" at the top and bottom of its travel.
 */
function checkPitchSlot(pixels: Uint8ClampedArray): void {
  const b = bandPixelBounds('sensorDome');
  const top = b.y0;
  const height = b.height;
  const DARK = 40;

  // The CONTIGUOUS dark run through the slot's centre, not every dark pixel in
  // the row: lenses and vents are dark too, and counting them would measure
  // the band's whole dark area rather than the slot.
  const centerX = Math.round(b.x0 + 0.5 * b.width);
  const isDark = (y: number, x: number): boolean => {
    const local = (((x - b.x0) % b.width) + b.width) % b.width;
    return pixels[(y * TRIM_SHEET_PIXELS + b.x0 + local) * 4] <= DARK;
  };
  const darkRun: number[] = [];
  for (let i = 0; i < height; i++) {
    const y = top + i;
    assertContract(
      isDark(y, centerX),
      `pitch slot is absent at row ${i}/${height} of the sensor dome — the `
        + 'barrels would leave the slot partway through their travel',
    );
    let run = 1;
    for (let d = 1; d <= b.width / 2 && isDark(y, centerX - d); d++) run++;
    for (let d = 1; d <= b.width / 2 && isDark(y, centerX + d); d++) run++;
    darkRun.push(Math.min(run, b.width));
  }

  // THE PIXEL WIDTH MUST NOT SHRINK TOWARD EITHER POLE. This is the direct
  // statement of the requirement: constant arc width on a sphere means the
  // stripe has to FLARE in texture space, because a latitude circle near a
  // pole is shorter. A stripe that instead holds its pixel width is the wedge
  // that visibly pinches shut at the top and bottom of the barrel's travel.
  const equator = Math.floor(height / 2);
  const slack = 2;
  for (let i = equator; i + 1 < height; i++) {
    assertContract(
      darkRun[i + 1] >= darkRun[i] - slack,
      `pitch slot narrows toward the north pole (row ${i}: ${darkRun[i]}px, `
        + `row ${i + 1}: ${darkRun[i + 1]}px)`,
    );
  }
  for (let i = equator; i > 0; i--) {
    assertContract(
      darkRun[i - 1] >= darkRun[i] - slack,
      `pitch slot narrows toward the south pole (row ${i}: ${darkRun[i]}px, `
        + `row ${i - 1}: ${darkRun[i - 1]}px)`,
    );
  }

  // Where the flare is still narrow enough to invert unambiguously, the arc
  // width itself must be constant. Wide near-pole rows are excluded on
  // purpose: once the band passes a quarter turn in azimuth it has wrapped
  // over the pole, and asin() no longer recovers the width from the run.
  const arcWidths: number[] = [];
  for (let i = 0; i < height; i++) {
    if (darkRun[i] > b.width / 3) continue;
    const halfPhi = (Math.PI * darkRun[i]) / b.width;
    const latitude = Math.sin((Math.PI * (i + 0.5)) / height);
    arcWidths.push(2 * Math.asin(Math.min(1, latitude * Math.sin(halfPhi))));
  }
  assertContract(
    arcWidths.length > height * 0.5,
    `pitch slot must be narrow enough to measure over most of its run — only `
      + `${arcWidths.length}/${height} rows qualified`,
  );
  const min = Math.min(...arcWidths);
  const max = Math.max(...arcWidths);
  assertContract(
    max - min < 0.04,
    `pitch slot must hold a constant ARC width — measured ${min.toFixed(3)} to `
      + `${max.toFixed(3)} rad across the rows where it is directly measurable`,
  );

  // And it has to be a hole, not a dark stripe: recessed in height, and not
  // reporting bare metal, because there is no surface there to be bare.
  // Sampled across the slot's own run — the equatorial lenses are dark too,
  // and including them measures glass rather than the opening.
  let holeHeight = 0;
  let holeBare = 0;
  let samples = 0;
  const midIndex = Math.floor(height / 2);
  const midRow = top + midIndex;
  const halfRun = Math.floor(darkRun[midIndex] / 2);
  for (let d = -halfRun; d <= halfRun; d++) {
    const local = (((centerX + d - b.x0) % b.width) + b.width) % b.width;
    const i = (midRow * TRIM_SHEET_PIXELS + b.x0 + local) * 4;
    if (pixels[i] > DARK) continue;
    holeHeight += pixels[i + 1];
    holeBare += pixels[i + 2];
    samples++;
  }
  assertContract(samples > 0, 'pitch slot has width at the equator');
  assertContract(
    holeHeight / samples < 24,
    `pitch slot must read as recessed — mean height ${(holeHeight / samples).toFixed(1)}`,
  );
  assertContract(
    holeBare / samples < 8,
    `pitch slot must not reveal bare metal — a hole is an absence of surface `
      + `(mean ${(holeBare / samples).toFixed(1)})`,
  );
}

/**
 * Features must land square and legible ON THE MODEL, not in the band.
 *
 * A band is roughly 9:1 in pixels while the surfaces it wraps are nearer 1:1,
 * so a panel drawn square in the band becomes a tall thin sliver, and a
 * "column" count chosen by eye against the band produces 3-unit panels on a
 * 32-unit leg. Both were visible as texturing that read tight, stretched and
 * gaudy. Counts are derived from BAND_SURFACE instead; this pins that the
 * derivation stays inside sane physical bounds.
 */
// The small strut is not plated at all — see drawHydraulicStrutFine. Its
// coarse tier IS, so this one cannot be derived from a tier pair.
const NO_PANEL_GRID_EXTRA_BANDS: readonly TrimBandId[] = ['hydraulicStrutFine'];

const NO_PANEL_GRID_BASE_BANDS: readonly BaseTrimBandId[] = [
  'barrelShaft',
  // Neither of these is a plated surface: a tyre is a moulded carcass with
  // lugs, and the running band is deliberately plain steel. Panel counts are
  // meaningless for both.
  'tyreTread',
  'trackRunning',
  'trackGrouser',
];

// Whether a band is a plated grid is a fact about the SURFACE, not about which
// size of it a host wears — a small wheel's tyre is still a moulded carcass.
// Listing only the coarse tiers here let the fine tyre be judged as plating
// and fail on lug size, which is the drift withFineTiers exists to stop.
const NO_PANEL_GRID_BANDS: ReadonlySet<TrimBandId> = new Set<TrimBandId>([
  ...NO_PANEL_GRID_BASE_BANDS,
  ...NO_PANEL_GRID_EXTRA_BANDS,
  ...NO_PANEL_GRID_BASE_BANDS.map((band) => BAND_FINE_TIER[band]).filter(
    (band): band is NonNullable<typeof band> => band !== undefined,
  ),
]);

function checkFeatureScale(): void {
  for (const band of TRIM_BAND_ORDER) {
    const surface = BAND_SURFACE[band];
    const { columns, courses } = bandFeatureCounts(band);
    const panelWidth = surface.uExtent / columns;
    const panelHeight = surface.vExtent / courses;

    // The barrel is one continuous machined tube with a breech and a muzzle,
    // not a plated surface; panel counts are meaningless for it.
    if (NO_PANEL_GRID_BANDS.has(band)) continue;

    assertContract(
      panelWidth > 4 && panelHeight > 4,
      `${band} panels are ${panelWidth.toFixed(1)}x${panelHeight.toFixed(1)} `
        + 'world units — too small to read as plating rather than noise',
    );
    const ratio = Math.max(panelWidth / panelHeight, panelHeight / panelWidth);
    assertContract(
      ratio < 2.2,
      `${band} panels land ${panelWidth.toFixed(1)}x${panelHeight.toFixed(1)} `
        + `on the model (${ratio.toFixed(1)}:1). Features must not be stretched.`,
    );

    // Density itself is asserted in checkCatalog; here we only care that the
    // panel counts land at a sane physical size.
  }
}

/**
 * The unit's own colour has to survive.
 *
 * `bare` lerps the instance colour toward neutral metal before the albedo
 * multiplier, so a band that runs it high hides ownership — which is the one
 * thing unit colour exists to communicate. Barrels are the deliberate
 * exception: they read as bare worked metal by design.
 */
const BARE_METAL_BANDS: ReadonlySet<TrimBandId> = new Set(['barrelShaft']);

function checkBaseColourSurvives(pixels: Uint8ClampedArray): void {
  for (const band of TRIM_BAND_ORDER) {
    const b = bandPixelBounds(band);
    let sum = 0;
    let count = 0;
    for (let y = b.y0; y < b.y1; y++) {
      for (let x = b.x0; x < b.x1; x++) {
        sum += pixels[(y * TRIM_SHEET_PIXELS + x) * 4 + 2];
        count++;
      }
    }
    const meanBare = sum / count / 255;
    if (BARE_METAL_BANDS.has(band)) {
      assertContract(
        meanBare > 0.6,
        `${band} is meant to read as bare metal — mean bare ${meanBare.toFixed(2)}`,
      );
      continue;
    }
    assertContract(
      meanBare < 0.32,
      `${band} covers ${(meanBare * 100).toFixed(0)}% of itself in bare metal, `
        + 'leaving too little of the unit colour showing',
    );
  }
}

/**
 * The chart shader's interface contract: what it declares must match what the
 * TypeScript side actually supplies, and the band code must not be a value the
 * hardware is free to reinterpolate.
 *
 * EVERY UNIFORM THE SHADER DECLARES MUST ALSO BE UPLOADED.
 *
 * three only sends what is in `shader.uniforms`; anything declared in the
 * source but missing there is left at GL's default of ZERO. That is silent —
 * the program links, the material renders, and the value is simply wrong.
 *
 * It has already bitten once: `uChartMaxGradTexels` shipped declared and used
 * but unassigned, so the sampler's gradient ceiling was zero, every gradient
 * scaled to nothing, and the whole sheet pinned to mip 0 — the exact inverse
 * of the fix it belonged to, and visible only as worse aliasing on the one
 * machine already reporting aliasing.
 */
function checkShaderInterfaceContract(): void {
  const material = new THREE.MeshLambertMaterial();
  patchSurfaceChartMaterial(material, { bump: true });
  const shader = {
    uniforms: {} as Record<string, unknown>,
    vertexShader: '#include <common>\n#include <project_vertex>',
    fragmentShader:
      '#include <common>\n#include <color_fragment>\n#include <normal_fragment_begin>',
  };
  material.onBeforeCompile(
    shader as unknown as THREE.WebGLProgramParametersWithUniforms,
    null as unknown as THREE.WebGLRenderer,
  );
  // THE BAND CODE MUST NOT BE INTERPOLATED. It selects which rectangle of the
  // atlas a fragment reads, so a value that lands one ulp below its integer
  // decodes to the NEIGHBOURING band and samples somewhere unrelated. For a
  // leg strut that neighbour is `barrelShaft`, the whitest band on the sheet,
  // which is why the symptom was white specks on legged units — and it only
  // appeared on some GPUs, because whether interpolation returns the exact
  // integer is a property of the hardware, not of the shader.
  for (const source of [shader.vertexShader, shader.fragmentShader]) {
    assertContract(
      /flat\s+varying\s+vec4\s+vChart\s*;/.test(source),
      'vChart must be declared flat in BOTH stages — it carries a band code '
        + 'and repeat counts, which are per-primitive constants, and '
        + 'interpolating them lets a fragment decode the wrong band',
    );
  }

  const declared = [...shader.fragmentShader.matchAll(/^uniform\s+\w+\s+(\w+)/gm)]
    .map((match) => match[1]);
  assertContract(
    declared.length > 0,
    'the chart fragment source must declare its uniforms where this can see them',
  );
  for (const name of declared) {
    assertContract(
      shader.uniforms[name] !== undefined,
      `${name} is declared in the chart fragment shader but never uploaded — `
        + 'GL will leave it at zero and the material will render wrong silently',
    );
  }
  material.dispose();
}

/** A visibility/death fade must wrap the already-charted material rather than
 *  swapping to an untextured transparent substitute. Cover both the ordinary
 *  one-material case and meshes whose faces use a material array. */
function checkTexturedFadeComposition(): void {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const bases = [new THREE.MeshLambertMaterial(), new THREE.MeshLambertMaterial()];
  patchSurfaceChartMaterial(bases[0], { bump: true });
  patchSurfaceChartMaterial(bases[1], { bump: false });
  const mesh = new THREE.Mesh(geometry, bases);
  const group = new THREE.Group();
  group.add(mesh);
  applyEntityGroupFade(group, 0.5);
  assertContract(
    Array.isArray(mesh.material) && mesh.material.length === 2,
    'a multi-material entity part must retain and fade every material slot',
  );
  for (const faded of mesh.material as THREE.Material[]) {
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: '#include <common>\n#include <begin_vertex>\n#include <project_vertex>',
      fragmentShader: [
        '#include <common>',
        '#include <color_fragment>',
        '#include <normal_fragment_begin>',
        '#include <opaque_fragment>',
      ].join('\n'),
    };
    faded.onBeforeCompile(
      shader as unknown as THREE.WebGLProgramParametersWithUniforms,
      null as unknown as THREE.WebGLRenderer,
    );
    assertContract(
      shader.fragmentShader.includes('sampleSubstanceGrain') &&
        shader.fragmentShader.includes('diffuseColor.a *= clamp(uFade'),
      'surface-chart albedo/bump and lifecycle alpha must coexist in the same faded shader',
    );
    assertContract(
      shader.uniforms.uTrimSheet !== undefined && shader.uniforms.uFade !== undefined,
      'a faded textured material must upload both chart and fade uniforms',
    );
  }
  disposeEntityGroupFade(group);
  assertContract(
    mesh.material === bases,
    'finishing/disposing a fade must restore the exact real textured material array',
  );
  geometry.dispose();
  for (const material of bases) material.dispose();
}

/** Reversing from reveal to conceal/death must continue from the opacity that
 * is already on screen. Restarting at one produces a one-frame opaque flash. */
function checkLifecycleFadeContinuity(): void {
  let appliedFade = -1;
  const fade = new DyingMeshFade<{ readonly name: string }>(
    1_000,
    (_mesh, alpha) => { appliedFade = alpha; },
    () => undefined,
  );
  fade.markDying(1 as EntityId, { name: 'partially revealed' }, 0.35);
  fade.update(100);
  assertContract(
    Math.abs(appliedFade - 0.25) < 1e-9,
    `fade-out must continue from the current 0.35 opacity — got ${appliedFade}`,
  );
  fade.destroyAll();
}

export function runSurfaceChart3DContractTest(): void {
  checkCatalog();
  checkShaderInterfaceContract();
  checkTexturedFadeComposition();
  checkLifecycleFadeContinuity();
  checkLiverySeparation();
  checkProgramCacheKeys();
  checkFeatureScale();
  checkSheetOrientation();
  checkTrimSheet();
}
