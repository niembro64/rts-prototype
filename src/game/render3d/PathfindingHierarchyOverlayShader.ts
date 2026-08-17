import type * as THREE from 'three';
import { BUILD_GRID_CELL_SIZE } from '../sim/buildGrid';
import { PATHFINDING_HIERARCHICAL_CLUSTER_SIZE_CELLS } from '../sim/pathfindingTuning';

export const PATHFINDING_HIERARCHY_CLUSTER_WORLD_SIZE_WU =
  PATHFINDING_HIERARCHICAL_CLUSTER_SIZE_CELLS * BUILD_GRID_CELL_SIZE;

export type PathfindingHierarchyOverlayUniforms = {
  enabled: { value: number };
  worldSize: { value: THREE.Vector2 };
  clusterWorldSize: { value: number };
  fineCellSize: { value: number };
};

type ShaderWithUniforms = {
  uniforms: Record<string, { value: unknown }>;
};

export function assignPathfindingHierarchyOverlayUniforms(
  shader: ShaderWithUniforms,
  uniforms: PathfindingHierarchyOverlayUniforms,
): void {
  shader.uniforms.uPathfindingHierarchyEnabled = uniforms.enabled;
  shader.uniforms.uPathfindingHierarchyWorldSize = uniforms.worldSize;
  shader.uniforms.uPathfindingHierarchyClusterWorldSize = uniforms.clusterWorldSize;
  shader.uniforms.uPathfindingHierarchyFineCellSize = uniforms.fineCellSize;
}

export function pathfindingHierarchyOverlayUniformDeclarations(): string {
  return [
    'uniform float uPathfindingHierarchyEnabled;',
    'uniform vec2 uPathfindingHierarchyWorldSize;',
    'uniform float uPathfindingHierarchyClusterWorldSize;',
    'uniform float uPathfindingHierarchyFineCellSize;',
  ].join('\n');
}

/**
 * Draw the level-1 hierarchy directly from world coordinates. This deliberately
 * does not allocate meshes or query the planner: it is a presentation-only view
 * of the same fixed cluster partition used by WASM. Center dots mark each
 * cluster's nominal representative cell; the actual query-local representative
 * can move to the nearest passable cell when that nominal cell is blocked.
 */
export function pathfindingHierarchyOverlayFragment(
  worldPositionExpr: string,
  targetColorExpr = 'diffuseColor.rgb',
  surfaceEligibilityExpr = 'true',
): string {
  return [
    `if (${surfaceEligibilityExpr} && uPathfindingHierarchyEnabled > 0.0 &&`,
    `    ${worldPositionExpr}.x >= 0.0 && ${worldPositionExpr}.z >= 0.0 &&`,
    `    ${worldPositionExpr}.x < uPathfindingHierarchyWorldSize.x &&`,
    `    ${worldPositionExpr}.z < uPathfindingHierarchyWorldSize.y) {`,
    `  vec2 hierarchyWorld = ${worldPositionExpr}.xz;`,
    '  vec2 hierarchyCoord = hierarchyWorld / uPathfindingHierarchyClusterWorldSize;',
    '  vec2 hierarchyChunk = floor(hierarchyCoord);',
    '  float hierarchyParity = mod(hierarchyChunk.x + hierarchyChunk.y, 2.0);',
    '  vec3 hierarchyFillA = vec3(0.025, 0.23, 0.28);',
    '  vec3 hierarchyFillB = vec3(0.16, 0.055, 0.25);',
    '  vec3 hierarchyFill = mix(hierarchyFillA, hierarchyFillB, hierarchyParity);',
    `  ${targetColorExpr} = mix(${targetColorExpr}, hierarchyFill, 0.14);`,
    '',
    '  vec2 hierarchyWithinChunk = fract(hierarchyCoord);',
    '  vec2 hierarchyChunkEdgeDistance = min(',
    '    hierarchyWithinChunk,',
    '    vec2(1.0) - hierarchyWithinChunk',
    '  ) * uPathfindingHierarchyClusterWorldSize;',
    '  vec2 hierarchyMapEdgeDistance = min(',
    '    hierarchyWorld,',
    '    uPathfindingHierarchyWorldSize - hierarchyWorld',
    '  );',
    '  float hierarchyEdgeDistance = min(',
    '    min(hierarchyChunkEdgeDistance.x, hierarchyChunkEdgeDistance.y),',
    '    min(hierarchyMapEdgeDistance.x, hierarchyMapEdgeDistance.y)',
    '  );',
    '  float hierarchyWorldAa = max(length(fwidth(hierarchyWorld)), 0.75);',
    '  float hierarchyBorder = 1.0 - smoothstep(',
    '    2.25,',
    '    2.25 + hierarchyWorldAa,',
    '    hierarchyEdgeDistance',
    '  );',
    '  vec3 hierarchyBorderColor = vec3(0.08, 0.94, 1.0);',
    `  ${targetColorExpr} = mix(${targetColorExpr}, hierarchyBorderColor, hierarchyBorder * 0.92);`,
    '',
    '  float hierarchyCellsPerChunk =',
    '    uPathfindingHierarchyClusterWorldSize / uPathfindingHierarchyFineCellSize;',
    '  vec2 hierarchyFineGridSize = ceil(',
    '    uPathfindingHierarchyWorldSize / uPathfindingHierarchyFineCellSize',
    '  );',
    '  vec2 hierarchyClusterCellMin = hierarchyChunk * hierarchyCellsPerChunk;',
    '  vec2 hierarchyClusterCellMax = min(',
    '    (hierarchyChunk + vec2(1.0)) * hierarchyCellsPerChunk,',
    '    hierarchyFineGridSize',
    '  );',
    '  vec2 hierarchyCenterCell = floor(',
    '    (hierarchyClusterCellMin + hierarchyClusterCellMax - vec2(1.0)) * 0.5',
    '  );',
    '  vec2 hierarchyCenterWorld =',
    '    (hierarchyCenterCell + vec2(0.5)) * uPathfindingHierarchyFineCellSize;',
    '  float hierarchyCenterDistance = distance(hierarchyWorld, hierarchyCenterWorld);',
    '  float hierarchyCenterRadius = max(4.0, uPathfindingHierarchyFineCellSize * 0.34);',
    '  float hierarchyCenter = 1.0 - smoothstep(',
    '    hierarchyCenterRadius,',
    '    hierarchyCenterRadius + hierarchyWorldAa,',
    '    hierarchyCenterDistance',
    '  );',
    '  vec3 hierarchyCenterColor = vec3(1.0, 0.50, 0.055);',
    `  ${targetColorExpr} = mix(${targetColorExpr}, hierarchyCenterColor, hierarchyCenter * 0.96);`,
    '}',
  ].join('\n');
}
