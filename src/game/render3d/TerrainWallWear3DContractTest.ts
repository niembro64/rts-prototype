// Contract: the plateau wall rims wear, and a wall that was flattened into
// the terrain does not.
//
// Two halves fail silently and are pinned here. The shader interface, because
// an unsupplied uniform is zero and the treatment just stops. And the SAFETY
// PROPERTY, because its failure mode is not a missing effect but a wrong one:
// a map author flattens a terrace step flush into the ground to erase it, and
// a treatment that wears that rim anyway draws the step back. Nothing about
// the code that did it would look wrong.
//
// The geometry half is exercised against a hand-built mesh rather than a
// generated map, so the test states the invariant in the terms the invariant
// is actually about — angle in, wear out.

import {
  SURFACE_WEATHERING_GLSL,
} from './SurfaceWeathering3D';
import {
  TERRAIN_WALL_WEAR_GLSL,
  WALL_WEAR_RIM_STRIDE,
  computeTerrainWallWear,
  terrainWallWearFragment,
  terrainWallWearMatteCoverage,
  terrainWallWearUniformDeclarations,
  type TerrainWallWearMesh,
} from './TerrainWallWear3D';
import {
  TERRAIN_WALL_WEAR,
  TERRAIN_WALL_WEAR_MAX_ANGLE_DEGREES,
  TERRAIN_WALL_WEAR_MIN_ANGLE_DEGREES,
  TERRAIN_WALL_WEAR_REACH_WORLD_UNITS,
} from '../../config';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[terrain wall wear contract] ${message}`);
  }
}

/** A single terrace step: a flat top, a wall of `drop` height, and a flat
 *  bottom, built as a strip so every rim is a real shared edge. `drop` of 0
 *  is the flattened case — the wall triangles are still flagged as walls, and
 *  are geometrically coplanar with the ground, which is exactly the state a
 *  map author leaves behind when they blend a step away. */
function buildTerraceMesh(drop: number): TerrainWallWearMesh {
  //   z:   0        40       44        84      (x runs across the strip)
  //        top------top------bottom----bottom
  const rows = [
    { z: 0, height: drop, wall: false },
    { z: 40, height: drop, wall: true },
    { z: 44, height: 0, wall: true },
    { z: 84, height: 0, wall: false },
  ];
  const columns = 6;
  const vertexCoords: number[] = [];
  const vertexHeights: number[] = [];
  for (const row of rows) {
    for (let c = 0; c < columns; c++) {
      vertexCoords.push(c * 40, row.z);
      vertexHeights.push(row.height);
    }
  }
  const triangleIndices: number[] = [];
  const triangleWallFlags: number[] = [];
  for (let r = 0; r < rows.length - 1; r++) {
    // The wall band is the strip between the two rows the wall spans.
    const isWall = rows[r].wall && rows[r + 1].wall;
    for (let c = 0; c < columns - 1; c++) {
      const a = r * columns + c;
      const b = a + 1;
      const d = a + columns;
      const e = d + 1;
      triangleIndices.push(a, d, b, b, d, e);
      triangleWallFlags.push(isWall ? 1 : 0, isWall ? 1 : 0);
    }
  }
  return {
    vertexCount: vertexHeights.length,
    triangleCount: triangleWallFlags.length,
    vertexCoords,
    vertexHeights,
    triangleIndices,
    triangleWallFlags,
  };
}

function peakIntensity(mesh: TerrainWallWearMesh): { top: number; bottom: number } {
  const { rims } = computeTerrainWallWear(mesh);
  let top = 0;
  let bottom = 0;
  for (let v = 0; v < mesh.vertexCount; v++) {
    top = Math.max(top, rims[v * WALL_WEAR_RIM_STRIDE + 1]);
    bottom = Math.max(bottom, rims[v * WALL_WEAR_RIM_STRIDE + 4]);
  }
  return { top, bottom };
}

/** THE SAFETY PROPERTY. Walls are routinely flattened flush into the terrain
 *  on purpose; wearing those rims draws a step the map deliberately erased. */
function checkFlattenedWallWearsNothing(): void {
  const flat = peakIntensity(buildTerraceMesh(0));
  assertContract(
    flat.top === 0 && flat.bottom === 0,
    'a wall flattened flush into the terrain must wear NOTHING — its rims are ' +
    `still flagged as walls, so nothing but the measured dihedral angle can ` +
    `tell them apart from a real step (got top ${flat.top}, bottom ${flat.bottom})`,
  );

  // And it must be a ramp, not a switch: a partially flattened wall has to
  // fade along its own length rather than snap between two cases.
  const shallow = peakIntensity(buildTerraceMesh(3));
  const steep = peakIntensity(buildTerraceMesh(600));
  assertContract(
    steep.top > 0 && steep.bottom > 0,
    'a real terrace step must wear both rims',
  );
  assertContract(
    shallow.top < steep.top,
    'wear must grow with the dihedral angle; a barely-stepped rim reading as ' +
    'strongly as a cliff means the angle term is not connected',
  );
  assertContract(
    TERRAIN_WALL_WEAR_MAX_ANGLE_DEGREES > TERRAIN_WALL_WEAR_MIN_ANGLE_DEGREES,
    'the angle window must have width, or the intensity is a step function',
  );
}

/** The rim classification and the reach, which decide where wear lands. */
function checkRimGeometry(): void {
  const mesh = buildTerraceMesh(600);
  const { rims } = computeTerrainWallWear(mesh);
  let topRimVertices = 0;
  let bottomRimVertices = 0;
  for (let v = 0; v < mesh.vertexCount; v++) {
    const base = v * WALL_WEAR_RIM_STRIDE;
    if (rims[base] === 0 && rims[base + 1] > 0) topRimVertices++;
    if (rims[base + 3] === 0 && rims[base + 4] > 0) bottomRimVertices++;
  }
  assertContract(
    topRimVertices > 0 && bottomRimVertices > 0,
    'a terrace must produce both a top rim and a bottom rim; one of them ' +
    'missing means the height comparison that separates them is inverted',
  );

  // The two rims must be told apart, not merged. Seeding one vertex as both
  // would make a top spall and a bottom debris band land on top of each other
  // everywhere, which is one treatment wearing two names.
  for (let v = 0; v < mesh.vertexCount; v++) {
    const base = v * WALL_WEAR_RIM_STRIDE;
    assertContract(
      !(rims[base] === 0 && rims[base + 3] === 0),
      `vertex ${v} was seeded as both a top rim and a bottom rim`,
    );
  }

  assertContract(
    TERRAIN_WALL_WEAR_REACH_WORLD_UNITS > 0,
    'the wear reach must be positive',
  );
  assertContract(
    TERRAIN_WALL_WEAR.top.exposure > 0 && TERRAIN_WALL_WEAR.bottom.exposure > 0,
    'both rim exposures must be positive; zero would multiply the substance away',
  );
}

/** A shader interface is the one contract the type system cannot check. */
function checkShaderSourceContract(): void {
  const declarations = terrainWallWearUniformDeclarations();
  const source = [
    TERRAIN_WALL_WEAR_GLSL,
    terrainWallWearFragment('vTerrainWorldPos', 'normalize(vTerrainWorldNormal)'),
    terrainWallWearMatteCoverage('metalPbrCoverage'),
  ].join('\n');
  const uniformNames = Array.from(
    declarations.matchAll(/uniform\s+\w+\s+(u\w+);/g),
    (match) => match[1],
  );
  for (const read of source.matchAll(/\buWallWear\w*/g)) {
    assertContract(
      uniformNames.includes(read[0]),
      `the wall wear reads ${read[0]}, which its uniform block does not ` +
      'declare — an unsupplied uniform is silently zero',
    );
  }
  for (const name of uniformNames) {
    assertContract(
      source.includes(name),
      `uniform ${name} is declared by the wall wear but never read`,
    );
  }

  // It must reach the shared vocabulary rather than re-deriving it, or the
  // rims and the ore edge stop looking like the same weather where they meet
  // — and ore regularly runs off its flat pad and down a terrace.
  for (const shared of [
    'weatherSampleFields(',
    'weatherSurfacePlane(',
    'weatherDisplace(',
    'weatherJitterRamp(',
    'weatherGrimeBand(',
    'weatherApplyGrime(',
    'weatherSampleSoil(',
  ]) {
    assertContract(
      SURFACE_WEATHERING_GLSL.includes(shared),
      `SurfaceWeathering3D must define ${shared}`,
    );
    assertContract(
      source.includes(shared),
      `the wall wear must reach the shared ${shared} rather than re-deriving it`,
    );
  }
  // The crumble at the band's far edge belongs to the vocabulary now, so the
  // ore rim gets it too; a rim that dissolved its own ramp locally would be
  // the one site free to drift from the others.
  assertContract(
    !source.includes('weatherDissolve(') && !source.includes('weatherGrimeAmount('),
    'the wall wear must lay its bands through weatherGrimeBand rather than composing the dissolve itself',
  );

  // TWO RIMS, TWO WEATHERS. One field sample serving both rims thickened
  // and thinned the spall along the top and the debris at the base in
  // lockstep down the whole terrace — two bands wearing one pattern. The
  // bottom rim must read its own fields, through a lattice the top's is a
  // stranger to.
  assertContract(
    (source.match(/weatherSampleFields\(/g) ?? []).length >= 2 &&
      /bottomDistance, vTerrainWallRimBottom\.y, wallBottomFields,/.test(source) &&
      /topDistance, vTerrainWallRimTop\.y, wallFields,/.test(source),
    'the top and bottom rims must be shaped by separately sampled field sets',
  );

  // NOT world XZ, and NOT the geometric normal. Both were measured: sampling
  // the fields in XZ leaves them constant down a near-vertical face, and
  // feeding the plane the per-triangle face normal puts the mesh's own
  // triangle columns on the cliff as evenly spaced vertical stripes.
  assertContract(
    /weatherSurfacePlane\(vTerrainWorldPos, normalize\(vTerrainWorldNormal\)\)/.test(source),
    'the field plane must come from weatherSurfacePlane fed the SMOOTH world ' +
    'normal; world XZ streaks down a wall face and the geometric face normal ' +
    'stripes it by triangle column',
  );

  // The derivative must be the host's. Every function here runs under the
  // early-out branch, where a derivative is undefined.
  assertContract(
    !TERRAIN_WALL_WEAR_GLSL.includes('fwidth(') &&
    !terrainWallWearFragment('p', 'n').includes('fwidth('),
    'the wall wear runs under a branch, so it must take the screen width as a ' +
    'parameter rather than measuring it',
  );
}

export function runTerrainWallWear3DContractTest(): void {
  checkFlattenedWallWearsNothing();
  checkRimGeometry();
  checkShaderSourceContract();
}
