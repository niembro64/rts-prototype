// Contract: the ore region is a shaded region, and it must not be able to
// reshape terrain.
//
// This replaces the visual-clusters contract, which pinned how the deleted
// ore crowns merged and how high their caps floated. The region field makes
// both questions moot — overlapping deposits fuse because their cells union
// before the bake, and nothing floats. What is worth pinning now is the
// stuff that fails silently: a shader that reads a uniform nobody supplies
// (three.js hands it zero and the ore quietly vanishes), a size class that
// would move a deposit off its build-cell centre and drag the flat pad with
// it, and the specular gate that keeps ordinary ground looking untouched
// now that it shares a PBR material with metal.

import {
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
  metalDepositSurfaceFieldUniformDeclarations,
} from './MetalDepositSurfaceField3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[metal deposit surface field contract] ${message}`);
  }
}

/** The world x a deposit of `resourceCells` snaps to, given the build cell
 *  its raw placement fell in. Mirrors the Rust placement kernel and
 *  makeMetalDepositPlacementFromRawPoint, which must agree. */
function snappedWorldX(centerCell: number, resourceCells: number): number {
  const gridHalfCells = Math.floor(resourceCells / 2);
  const halfSize = (resourceCells * BUILD_GRID_CELL_SIZE) / 2;
  return (centerCell - gridHalfCells) * BUILD_GRID_CELL_SIZE + halfSize;
}

function checkSizeClassesCannotMoveTerrain(): void {
  const names = Object.keys(METAL_DEPOSIT_CONFIG.sizes);
  assertContract(names.length > 0, 'no ore size classes are authored');
  assertContract(
    names.includes(METAL_DEPOSIT_CONFIG.defaultSize),
    `defaultSize "${METAL_DEPOSIT_CONFIG.defaultSize}" is not in the sizes table`,
  );

  const centerCell = 265;
  const reference = snappedWorldX(centerCell, 1);
  for (const name of names) {
    const size = getMetalDepositSize(name);
    assertContract(
      size.resourceCells % 2 === 1,
      `size "${name}" has an even resourceCells (${size.resourceCells}); ` +
      'even footprints snap to a build-cell corner instead of its centre, so ' +
      'resizing a ring would move its flat pad and reshape the heightfield',
    );
    // The real invariant the odd rule exists to protect: retuning a ring's
    // size leaves its world position — and therefore its flat zone — alone.
    assertContract(
      snappedWorldX(centerCell, size.resourceCells) === reference,
      `size "${name}" moves a deposit placed in cell ${centerCell} to ` +
      `${snappedWorldX(centerCell, size.resourceCells)} instead of ${reference}`,
    );
    assertContract(
      size.resourceRadiusCells > 0 &&
      Math.PI * size.resourceRadiusCells * size.resourceRadiusCells >=
        size.resourceCells * size.resourceCells,
      `size "${name}" cannot fit ${size.resourceCells ** 2} cells inside a ` +
      `candidate circle of radius ${size.resourceRadiusCells}`,
    );
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
    'byte encoding covers, and zero would collapse every distance to one value',
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
  const coverage = metalDepositSurfaceFieldCoverage('vTerrainWorldPos');
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

  assertContract(
    METAL_SURFACE_REGION_GLSL.includes('float metalSurfaceRegionCoverage('),
    'the metal surface must define metalSurfaceRegionCoverage',
  );
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
  for (const [name, source] of Object.entries(METAL_SURFACE_LAYER_GLSL)) {
    assertContract(
      source.includes('metalCoverage'),
      `metal layer term "${name}" is not gated on metalCoverage, so it would ` +
      'apply to every fragment of the host surface',
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

export function runMetalDepositSurfaceField3DContractTest(): void {
  checkSizeClassesCannotMoveTerrain();
  checkSurfaceFieldConfig();
  checkShaderSourceContract();
  checkMetalLayerContract();
}
