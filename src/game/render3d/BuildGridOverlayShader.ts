import type * as THREE from 'three';

export type BuildGridOverlayUniforms = {
  map: { value: THREE.DataTexture };
  mapSize: { value: THREE.Vector2 };
  worldSize: { value: THREE.Vector2 };
  cellSize: { value: number };
  enabled: { value: number };
};

type ShaderWithUniforms = {
  uniforms: Record<string, { value: unknown }>;
};

export function assignBuildGridOverlayUniforms(
  shader: ShaderWithUniforms,
  uniforms: BuildGridOverlayUniforms,
): void {
  shader.uniforms.uBuildGridMap = uniforms.map;
  shader.uniforms.uBuildGridMapSize = uniforms.mapSize;
  shader.uniforms.uBuildGridWorldSize = uniforms.worldSize;
  shader.uniforms.uBuildGridCellSize = uniforms.cellSize;
  shader.uniforms.uBuildGridEnabled = uniforms.enabled;
}

export function buildGridOverlayUniformDeclarations(): string {
  return [
    'uniform sampler2D uBuildGridMap;',
    'uniform vec2 uBuildGridMapSize;',
    'uniform vec2 uBuildGridWorldSize;',
    'uniform float uBuildGridCellSize;',
    'uniform float uBuildGridEnabled;',
  ].join('\n');
}

export function buildGridOverlayFragment(worldPositionExpr: string): string {
  return [
    `if (uBuildGridEnabled > 0.0 &&`,
    `    ${worldPositionExpr}.x >= 0.0 && ${worldPositionExpr}.z >= 0.0 &&`,
    `    ${worldPositionExpr}.x < uBuildGridWorldSize.x &&`,
    `    ${worldPositionExpr}.z < uBuildGridWorldSize.y) {`,
    `  vec2 buildGridCoord = ${worldPositionExpr}.xz / uBuildGridCellSize;`,
    '  vec2 buildGridCell = floor(buildGridCoord);',
    '  vec2 buildUv = (buildGridCell + vec2(0.5)) / uBuildGridMapSize;',
    '  vec4 buildColor = texture2D(uBuildGridMap, clamp(buildUv, vec2(0.0), vec2(1.0)));',
    '  vec2 buildCellFrac = abs(fract(buildGridCoord) - vec2(0.5));',
    '  float buildBorder = step(0.455, max(buildCellFrac.x, buildCellFrac.y));',
    '  vec3 buildBorderColor = min(buildColor.rgb * 3.25 + vec3(0.02), vec3(1.0));',
    '  vec3 buildRgb = mix(buildColor.rgb, buildBorderColor, buildBorder);',
    '  float buildAlpha = buildColor.a * mix(0.42, 0.95, buildBorder);',
    '  diffuseColor.rgb = mix(diffuseColor.rgb, buildRgb, buildAlpha);',
    '}',
  ].join('\n');
}
