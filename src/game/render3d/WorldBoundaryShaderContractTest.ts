import { buildGridOverlayFragment } from './BuildGridOverlayShader';
import { pathfindingHierarchyOverlayFragment } from './PathfindingHierarchyOverlayShader';
import { worldShadeFragment } from './WorldShade3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[world boundary shader contract] ${message}`);
}

export function runWorldBoundaryShaderContractTest(): void {
  const shade = worldShadeFragment('vTerrainWorldPos', true);
  assertContract(
    shade.includes('worldShadeEdgeTolerance') &&
      shade.includes('uWorldShadeWorldSize.x + worldShadeEdgeTolerance.x') &&
      shade.includes('uWorldShadeBoundsSize.x + worldShadeEdgeTolerance.x'),
    'fog/shadow coverage must tolerate interpolation around positive map boundaries',
  );

  const verticalFaceGuard = 'abs(geomNormal.y) > 0.01';
  const build = buildGridOverlayFragment(
    'vTerrainWorldPos',
    'diffuseColor.rgb',
    verticalFaceGuard,
  );
  const hierarchy = pathfindingHierarchyOverlayFragment(
    'vTerrainWorldPos',
    'diffuseColor.rgb',
    verticalFaceGuard,
  );
  assertContract(
    build.includes(`if (${verticalFaceGuard} && uBuildGridEnabled`),
    'BUILD must reject vertical world-box faces before its exact map bounds',
  );
  assertContract(
    hierarchy.includes(`if (${verticalFaceGuard} && uPathfindingHierarchyEnabled`),
    'HIER must reject vertical world-box faces before its exact map bounds',
  );
}
