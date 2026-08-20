// Contract: the ore region is a shaded region, and it must not be able to
// reshape terrain.
//
// This replaces the visual-clusters contract, which pinned how the deleted
// ore crowns merged and how high their caps floated. The region field makes
// both questions moot — overlapping deposits fuse because their cells union
// before the bake, and nothing floats. What is worth pinning now is the
// stuff that fails silently: a shader that reads a uniform nobody supplies
// (three.js hands it zero and the ore quietly vanishes), a size class whose
// placement disc is too small to hold its own metal cells, and the specular
// gate that keeps ordinary ground looking untouched now that it shares a PBR
// material with metal.

import {
  METAL_DEPOSIT_CELL_PLACEMENT_MODES,
  METAL_DEPOSIT_CONFIG,
  getMetalDepositSize,
} from '../../metalDepositConfig';
import { BUILD_GRID_CELL_SIZE } from '../sim/buildGrid';
import {
  METAL_SURFACE_LAYER_GLSL,
  METAL_SURFACE_REGION_GLSL,
  METAL_SURFACE_RESPONSE_GLSL,
  metalSurfaceLayerUniformDeclarations,
  metalSurfaceOutgoingLightPatch,
} from './MetalSurfaceMaterial3D';
import {
  metalDepositSurfaceFieldCoverage,
  metalDepositSurfaceFieldDistance,
  metalDepositSurfaceFieldScreenWidth,
  metalDepositSurfaceFieldUniformDeclarations,
} from './MetalDepositSurfaceField3D';
import { SURFACE_WEATHERING_GLSL } from './SurfaceWeathering3D';
import {
  ORE_EDGE_BLEND_GLSL,
  metalBodyGrimeAlbedoFragment,
  metalBodyGrimeResolveFragment,
  oreEdgeAlbedoFragment,
  oreEdgeBlendUniformDeclarations,
  oreEdgeMatteCoverage,
  oreEdgeResolveFragment,
} from './MetalDepositEdgeBlend3D';
import { ORE_EDGE_INFLUENCE_WORLD_UNITS } from '../../config';
import {
  TERRAIN_OUTWARD_NORMAL_LEVELS,
  TERRAIN_OUTWARD_NORMAL_UNIFORM,
  terrainOutwardNormalFragment,
  terrainOutwardNormalUniformDeclaration,
} from './TerrainOutwardNormal3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[metal deposit surface field contract] ${message}`);
  }
}

/** Lattice points strictly inside a disc of `radiusCells` — the cells whose
 *  cosine probability is still non-zero, and therefore the only ones a
 *  deposit can put metal on. Mirrors metal_deposit_count_placement_candidates
 *  in Rust, which must agree. */
function placeableCellCount(radiusCells: number): number {
  const r2 = radiusCells * radiusCells;
  let count = 0;
  for (let dy = -radiusCells; dy <= radiusCells; dy++) {
    for (let dx = -radiusCells; dx <= radiusCells; dx++) {
      if (dx * dx + dy * dy < r2) count++;
    }
  }
  return count;
}

function checkSizeClassesCannotMoveTerrain(): void {
  const names = Object.keys(METAL_DEPOSIT_CONFIG.sizes);
  assertContract(names.length > 0, 'no ore size classes are authored');
  assertContract(
    names.includes(METAL_DEPOSIT_CONFIG.defaultSize),
    `defaultSize "${METAL_DEPOSIT_CONFIG.defaultSize}" is not in the sizes table`,
  );
  assertContract(
    METAL_DEPOSIT_CELL_PLACEMENT_MODES.includes(
      METAL_DEPOSIT_CONFIG.cellPlacementMode,
    ),
    `cellPlacementMode "${METAL_DEPOSIT_CONFIG.cellPlacementMode}" is not a known mode`,
  );

  // A deposit snaps to the CENTRE of the build cell its raw ring point fell
  // in, reading nothing from the size class. That is what keeps a purely
  // cosmetic retune from moving a flat pad and reshaping the heightfield —
  // pinned here because the snap lives in two places (the Rust placement
  // kernel and makeMetalDepositPlacementFromRawPoint) and neither may drift
  // back toward sizing the position off the ore body.
  const centerCell = 265;
  const reference = (centerCell + 0.5) * BUILD_GRID_CELL_SIZE;
  for (const name of names) {
    const size = getMetalDepositSize(name);
    assertContract(
      (centerCell + 0.5) * BUILD_GRID_CELL_SIZE === reference,
      `size "${name}" moves a deposit placed in cell ${centerCell} off ${reference}`,
    );
    // Every authored metal cell has to land, in EITHER placement mode, so
    // both discs must have room for the whole body. Pinning both is what
    // keeps flipping cellPlacementMode from throwing at map build time.
    for (const field of ['scatterRadiusCells', 'growthRadiusCells'] as const) {
      const radiusCells = size[field];
      const placeable = placeableCellCount(radiusCells);
      assertContract(
        radiusCells > 0 && placeable >= size.metalCellCount,
        `size "${name}" places ${size.metalCellCount} metal cells into a ` +
        `${field} disc of radius ${radiusCells}, which holds only ${placeable}`,
      );
    }
  }
}

function checkSurfaceFieldConfig(): void {
  const cfg = METAL_DEPOSIT_CONFIG.surfaceField;
  assertContract(cfg.texelWorldSize > 0, 'surfaceField.texelWorldSize must be positive');
  assertContract(
    cfg.maxTextureDimension >= 1,
    'surfaceField.maxTextureDimension must be at least 1',
  );
  assertContract(
    cfg.edgeRangeWorldUnits > 0,
    'surfaceField.edgeRangeWorldUnits must be positive — it is the ± span the ' +
    '16-bit encoding covers, and zero would collapse every distance to one value',
  );
  assertContract(
    cfg.smoothPasses >= 0 && Number.isInteger(cfg.smoothPasses),
    'surfaceField.smoothPasses must be a non-negative integer',
  );
  assertContract(
    cfg.edgeFeatherWorldUnits >= 0,
    'surfaceField.edgeFeatherWorldUnits must be non-negative',
  );
  // A feather wider than the encoded range reads past where the field still
  // carries a real distance, so the edge would soften into saturated values.
  assertContract(
    cfg.edgeFeatherWorldUnits <= cfg.edgeRangeWorldUnits,
    'surfaceField.edgeFeatherWorldUnits must not exceed edgeRangeWorldUnits',
  );
}

/** A shader interface is a contract the type system cannot check: every
 *  uniform the source reads must be declared, or three.js supplies zero and
 *  the effect silently disappears. Parse the strings the terrain shader is
 *  assembled from and prove the two halves line up. */
function checkShaderSourceContract(): void {
  const declarations = metalDepositSurfaceFieldUniformDeclarations();
  // Every expression the host assembles the ore path from. They are checked
  // together because the uniform block serves all three, and a uniform that
  // moved from one expression to another must still be read by SOMETHING.
  const coverage = [
    metalDepositSurfaceFieldDistance('vTerrainWorldPos'),
    metalDepositSurfaceFieldScreenWidth('oreDistance'),
    metalDepositSurfaceFieldCoverage('oreDistance', 'oreDistanceWidth'),
  ].join('\n');
  const uniformNames = Array.from(
    declarations.matchAll(/uniform\s+\w+\s+(u\w+);/g),
    (match) => match[1],
  );
  assertContract(
    uniformNames.length >= 5,
    `expected the region field to declare its full uniform block; found ${uniformNames.length}`,
  );
  for (const name of uniformNames) {
    assertContract(
      coverage.includes(name),
      `uniform ${name} is declared but never read by the coverage expression`,
    );
  }
  for (const read of coverage.matchAll(/\bu[A-Z]\w*/g)) {
    assertContract(
      uniformNames.includes(read[0]),
      `coverage expression reads ${read[0]}, which no declaration supplies — ` +
      'an unsupplied uniform is silently zero, so the ore would just not draw',
    );
  }

  for (const definition of [
    'float metalSurfaceRegionDistance(',
    'float metalSurfaceRegionScreenWidth(',
    'float metalSurfaceRegionCoverage(',
  ]) {
    assertContract(
      METAL_SURFACE_REGION_GLSL.includes(definition),
      `the metal surface must define ${definition}`,
    );
  }
  assertContract(
    coverage.includes('metalSurfaceRegionCoverage('),
    'the coverage expression must call the shared metal surface definition ' +
    'rather than re-deriving ore coverage of its own',
  );
  // fwidth on a value read from the field is only meaningful between one
  // texel and the encoded range; unbounded, a zoomed-out frame reads noise.
  assertContract(
    /clamp\(\s*fwidth\(/.test(METAL_SURFACE_REGION_GLSL),
    'the ore edge derivative must be bounded, not raw fwidth',
  );
  // THE DERIVATIVE MUST BE ALONE IN ITS OWN FUNCTION. Both the coverage
  // resolve and the whole edge treatment run under branches, and a
  // derivative in non-uniform control flow is undefined — it compiles, and
  // it works on whichever GPU the author happened to have. Keeping fwidth
  // out of everything except metalSurfaceRegionScreenWidth is what makes
  // "called at top level" a property a reader can check locally.
  const fwidthOwner = METAL_SURFACE_REGION_GLSL.split(
    'float metalSurfaceRegionScreenWidth(',
  );
  assertContract(
    fwidthOwner.length === 2 && !fwidthOwner[0].includes('fwidth('),
    'fwidth must appear only inside metalSurfaceRegionScreenWidth; the other ' +
    'region functions are called under branches, where a derivative is undefined',
  );
  assertContract(
    !ORE_EDGE_BLEND_GLSL.includes('fwidth(') &&
    !ORE_EDGE_BLEND_GLSL.includes('dFdx(') &&
    !ORE_EDGE_BLEND_GLSL.includes('dFdy('),
    'the edge treatment runs entirely under the host\'s early-out branch, so ' +
    'it must take the screen width as a parameter rather than measuring it',
  );
  assertContract(
    METAL_SURFACE_RESPONSE_GLSL.includes('metalSurfaceRoughness('),
    'the metal surface response must still own the roughness term the ' +
    'terrain layers in by ore coverage',
  );
}

/** The metal layer reads uniforms and assigns to identifiers the host
 *  declares; both directions can break silently. */
function checkMetalLayerContract(): void {
  const declarations = metalSurfaceLayerUniformDeclarations();
  const layer = [
    METAL_SURFACE_LAYER_GLSL.roughness,
    METAL_SURFACE_LAYER_GLSL.metalness,
    METAL_SURFACE_LAYER_GLSL.specularGate,
    METAL_SURFACE_LAYER_GLSL.litColor,
  ].join('\n');
  for (const read of layer.matchAll(/\bu[A-Z]\w*/g)) {
    assertContract(
      declarations.includes(`${read[0]};`),
      `the metal layer reads ${read[0]}, which its uniform block does not ` +
      'declare — an unsupplied uniform is silently zero',
    );
  }

  // Every layer term is gated on coverage. A term that forgot it would
  // apply metal to the whole host surface, which is exactly the bug the
  // region field exists to prevent.
  //
  // And it must be the PBR coverage, not the geometric one. The two differ
  // only across the ore's dirty rim, where the geometric coverage would
  // hand the dirt a full metal reflection — a specular highlight tracing
  // the ore boundary exactly, which is the crisp edge the whole treatment
  // exists to break, surviving underneath however much dirt is painted on.
  // `metalPbrCoverage` does not contain `metalCoverage` as a substring, so
  // this test cannot be satisfied by the wrong one.
  for (const [name, source] of Object.entries(METAL_SURFACE_LAYER_GLSL)) {
    assertContract(
      source.includes('metalPbrCoverage'),
      `metal layer term "${name}" is not gated on metalPbrCoverage, so it ` +
      'would apply to every fragment of the host surface',
    );
    assertContract(
      !/\bmetalCoverage\b/.test(source),
      `metal layer term "${name}" reads the geometric metalCoverage; the PBR ` +
      'terms must take metalPbrCoverage so the dirty rim comes out matte',
    );
  }

  // ORDER. `totalSpecular *= metalCoverage` and the lit-colour blend are
  // plain assignments: putting the gate after the declaration that consumes
  // totalSpecular, or the blend before outgoingLight exists, still compiles
  // and silently does nothing (or fails to compile with no visible report —
  // three.js only surfaces shader errors under ?shaderErrors=1).
  const declaration = 'vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;';
  const patch = metalSurfaceOutgoingLightPatch(declaration, ['outgoingLight *= hostTerm;']);
  const gateAt = patch.indexOf(METAL_SURFACE_LAYER_GLSL.specularGate);
  const declaredAt = patch.indexOf(declaration);
  const litAt = patch.indexOf(METAL_SURFACE_LAYER_GLSL.litColor);
  const hostAt = patch.indexOf('outgoingLight *= hostTerm;');
  assertContract(gateAt >= 0 && declaredAt >= 0 && litAt >= 0 && hostAt >= 0,
    'the outgoing-light patch dropped one of its parts');
  assertContract(
    gateAt < declaredAt,
    'the specular gate must run BEFORE outgoingLight is summed from ' +
    'totalSpecular; after it the assignment is a no-op and every non-ore ' +
    'surface silently gains a specular sheen',
  );
  assertContract(
    litAt > declaredAt,
    'the lit-colour blend must run AFTER outgoingLight is declared',
  );
  assertContract(
    hostAt > litAt,
    "the host's own post-lighting terms must run after the metal layer",
  );
}

/** The terrain is drawn by its back faces, so three inverts the authored
 *  upward normal before lighting. Ore is lit THROUGH that normal, so the
 *  correction below is the difference between ore that catches the sun on its
 *  sunward slope and ore that catches it on the shadowed one. Both failure
 *  modes here are silent: they compile. */
function checkOutwardNormalContract(): void {
  const declaration = terrainOutwardNormalUniformDeclaration();
  const fragment = terrainOutwardNormalFragment();

  assertContract(
    declaration.includes(`${TERRAIN_OUTWARD_NORMAL_UNIFORM};`),
    'the outward-normal uniform block must declare the uniform its fragment reads',
  );
  for (const read of fragment.matchAll(/\bu[A-Z]\w*/g)) {
    assertContract(
      read[0] === TERRAIN_OUTWARD_NORMAL_UNIFORM,
      `outward-normal fragment reads ${read[0]}, which its declaration does not supply`,
    );
  }

  // It must multiply the normal by faceDirection — that is the whole
  // correction; three squared it away and this undoes it.
  assertContract(
    /normal \*= mix\(1\.0, faceDirection, /.test(fragment),
    'the correction must restore the authored normal by multiplying through ' +
    'faceDirection a second time',
  );

  // THE TRAP: the ore scope must STEP on coverage, never interpolate. Mixing
  // the multiplier between 1 and -1 passes through zero, which hands the
  // lighting a zero-length normal across the whole anti-aliased ore edge —
  // a band of black fragments produced by code that compiles cleanly.
  assertContract(
    fragment.includes('step(0.5, metalCoverage)'),
    'the ore scope must step on metalCoverage; interpolating the normal ' +
    'multiplier passes through zero and produces a degenerate normal at the edge',
  );
  assertContract(
    !/mix\([^)]*metalCoverage[^)]*\)/.test(fragment),
    'the normal multiplier must not be mixed by metalCoverage directly',
  );

  assertContract(
    TERRAIN_OUTWARD_NORMAL_LEVELS.off === 0 &&
    TERRAIN_OUTWARD_NORMAL_LEVELS.ore === 1 &&
    TERRAIN_OUTWARD_NORMAL_LEVELS.terrain === 2,
    'outward-normal scope levels must match the ordering the fragment compares against',
  );
  // The fragment's thresholds have to agree with those levels, or a scope
  // silently resolves to the wrong branch.
  assertContract(
    fragment.includes(`${TERRAIN_OUTWARD_NORMAL_UNIFORM} >= 2.0`) &&
    fragment.includes(`${TERRAIN_OUTWARD_NORMAL_UNIFORM} >= 1.0`),
    'the fragment must branch on the same scope levels the host encodes',
  );
}

/** The ore edge treatment. Its failures are all quiet ones: an undeclared
 *  uniform reads zero and the effect simply stops, and a term that reaches
 *  past the field's encoded range produces a shape that looks authored. */
function checkOreEdgeBlendContract(): void {
  const declarations = oreEdgeBlendUniformDeclarations();
  // Every string the host assembles the edge path from. The uniform block
  // serves all of them together, so they are checked together — a uniform
  // that moved from one fragment to another must still be read by SOMETHING.
  const resolveFragment = oreEdgeResolveFragment('vTerrainWorldPos', 'uMetalRegionEnabled');
  const albedoFragment = oreEdgeAlbedoFragment('vTerrainWorldPos', 'geomNormal');
  const bodyResolveFragment = metalBodyGrimeResolveFragment('vTerrainWorldPos');
  const bodyAlbedoFragment = metalBodyGrimeAlbedoFragment('vTerrainWorldPos', 'geomNormal');
  const source = [
    ORE_EDGE_BLEND_GLSL,
    resolveFragment,
    bodyResolveFragment,
    oreEdgeMatteCoverage('metalCoverage'),
    bodyAlbedoFragment,
    albedoFragment,
  ].join('\n');
  const uniformNames = Array.from(
    declarations.matchAll(/uniform\s+\w+\s+(u\w+);/g),
    (match) => match[1],
  );

  // Both directions. A uniform the source never reads is dead weight the
  // next reader has to disprove; a uniform the source reads and nobody
  // declares is silently zero, which for `uOreEdgeInfluence` means the
  // early-out never fires and for `uOreEdgeBandMax` means every transition
  // collapses to its minimum width.
  for (const read of source.matchAll(/\bu(?:OreEdge|MetalGrime)\w*/g)) {
    assertContract(
      uniformNames.includes(read[0]),
      `the edge treatment reads ${read[0]}, which its uniform block does not ` +
      'declare — an unsupplied uniform is silently zero',
    );
  }
  for (const name of uniformNames) {
    assertContract(
      source.includes(name),
      `uniform ${name} is declared by the edge treatment but never read`,
    );
  }

  // The resolve block is the only writer of the coverage the metal surface
  // then reads, and the only declarer of the grime the matte and albedo
  // halves read. Losing either wiring compiles as long as the host happens
  // to declare something by the same name.
  const resolve = resolveFragment;
  assertContract(
    resolve.includes('oreRegionCoverage = oreEdgeCoverage('),
    'the resolve block must overwrite the coverage the region field produced; ' +
    'without that the ore keeps the field\'s own clean contour and only the ' +
    'dirt band moves',
  );
  assertContract(
    resolve.includes('float oreEdgeGrime = 0.0;'),
    'the resolve block must declare oreEdgeGrime and default it to zero, so ' +
    'a fragment that takes the early-out is ungrimed rather than undefined',
  );

  // THE BODY GRIME. It must declare its own default-zero local (same reason
  // as above), the matte must read it (dirt with a live metal reflection
  // under it reads as clean plate however dark it is painted), and it must
  // never read the region field's distance — its independence from the
  // field is exactly what makes it legal on a SURFACE = METAL world, where
  // the distance is meaningless.
  assertContract(
    bodyResolveFragment.includes('float metalBodyGrime = 0.0;'),
    'the body grime block must declare metalBodyGrime and default it to zero',
  );
  assertContract(
    oreEdgeMatteCoverage('metalCoverage').includes('metalBodyGrime'),
    'the matte coverage must suppress the metal reflection under the body ' +
    'grime, not just under the edge band',
  );
  assertContract(
    !/\boreDistance\b/.test(bodyResolveFragment),
    'the body grime must not read the region field distance — it has to work ' +
    'on a SURFACE = METAL world, where that distance is meaningless',
  );

  for (const definition of ['float oreEdgeCoverage(', 'float oreEdgeGrimeBand(']) {
    assertContract(
      ORE_EDGE_BLEND_GLSL.includes(definition),
      `the edge treatment must define ${definition}`,
    );
  }

  // THE MATHS IS SHARED. The ore edge, the plateau wall rims and the
  // vegetation all weather by the same mechanism, so the displacement,
  // dissolve, band ramp, grime shaping and substance projection live in
  // SurfaceWeathering3D and every treatment calls them. A treatment that
  // re-derived one of these locally would drift from the others, and two
  // weathered boundaries that meet on screen would stop looking like the
  // same weather.
  for (const shared of [
    'weatherSampleFields(',
    'weatherDisplace(',
    'weatherDissolve(',
    'weatherBandRamp(',
    'weatherGrimeAmount(',
    'weatherApplyGrime(',
    'weatherSampleSubstance(',
  ]) {
    assertContract(
      SURFACE_WEATHERING_GLSL.includes(`float ${shared}`) ||
      SURFACE_WEATHERING_GLSL.includes(`vec3 ${shared}`) ||
      SURFACE_WEATHERING_GLSL.includes(`WeatherFields ${shared}`),
      `SurfaceWeathering3D must define ${shared}`,
    );
  }
  const oreSource = [
    ORE_EDGE_BLEND_GLSL,
    resolveFragment,
    bodyResolveFragment,
    bodyAlbedoFragment,
    albedoFragment,
  ].join('\n');
  for (const shared of [
    'weatherSampleFields(',
    'weatherDisplace(',
    'weatherDissolve(',
    'weatherBandRamp(',
    'weatherGrimeAmount(',
    'weatherApplyGrime(',
    'weatherSampleSubstance(',
  ]) {
    assertContract(
      oreSource.includes(shared),
      `the ore edge must reach the shared ${shared} rather than re-deriving it`,
    );
  }

  // THE SATURATION TRAP. The region field encodes distance over
  // ±edgeRangeWorldUnits and saturates past it, so a term reaching further
  // reads a distance that has stopped varying: its falloff flattens and the
  // band ends in a perfectly circular hard ring at the radius the encoding
  // ran out. That reads as a rendering bug, not as a tuning mistake, and
  // nothing about the code that produced it looks wrong.
  const edgeRange = METAL_DEPOSIT_CONFIG.surfaceField.edgeRangeWorldUnits;
  assertContract(
    ORE_EDGE_INFLUENCE_WORLD_UNITS <= edgeRange,
    `the edge treatment reaches ${ORE_EDGE_INFLUENCE_WORLD_UNITS} world units ` +
    `from the contour but the region field only encodes ±${edgeRange}; past ` +
    'that the distance saturates and the band terminates in a hard ring',
  );

  // The early-out is the whole reason five extra texture taps are
  // affordable on a full-screen surface, and it is only correct if the
  // radius it tests against is the one every term is bounded by.
  assertContract(
    source.includes('uOreEdgeInfluence'),
    'the edge treatment must expose the influence radius the host early-outs ' +
    'on, or every terrain fragment on the map pays for the ore edge',
  );
}

export function runMetalDepositSurfaceField3DContractTest(): void {
  checkSizeClassesCannotMoveTerrain();
  checkSurfaceFieldConfig();
  checkShaderSourceContract();
  checkMetalLayerContract();
  checkOreEdgeBlendContract();
  checkOutwardNormalContract();
}
