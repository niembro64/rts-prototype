// Pins the ONE global textures switch (CLIENT TEX): one write flips the
// shared uniform, the trim-sheet chart, and every registered reader; a
// reader registered later is applied immediately; and the terrain fragment
// gate multiplies the switch into every texture term the terrain shader has.

import {
  TERRAIN_METAL_DETAIL_BRANCH,
  TERRAIN_TEXTURE_BLEND_UNIFORMS,
  TERRAIN_TEXTURE_ENABLE_UNIFORMS,
  areRenderTexturesEnabled,
  gateTerrainTexturesFragment,
  getRenderTexturesUniform,
  registerRenderTexturesReader,
  setRenderTexturesEnabled,
} from './RenderTextures3D';
import { isSurfaceChartEnabled } from './SurfaceChartMaterial3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[render textures] ${message}`);
  }
}

export function runRenderTextures3DContractTest(): void {
  const initial = areRenderTexturesEnabled();
  const seen: boolean[] = [];
  // Read through a function so the narrowing from one assertion does not
  // leak into the next comparison.
  const seenCount = (): number => seen.length;
  const unregister = registerRenderTexturesReader((enabled) => seen.push(enabled));
  try {
    assertContract(
      seenCount() === 1 && seen[0] === initial,
      'a reader is applied immediately with the current state on registration',
    );
    setRenderTexturesEnabled(false);
    assertContract(
      !areRenderTexturesEnabled() &&
        getRenderTexturesUniform().value === 0 &&
        !isSurfaceChartEnabled() &&
        seen[seen.length - 1] === false,
      'textures off zeroes the shared uniform, disables the surface chart, and notifies readers',
    );
    setRenderTexturesEnabled(false);
    assertContract(
      seenCount() === 2,
      'a redundant write is dropped so readers never redo a recompile for nothing',
    );
    setRenderTexturesEnabled(true);
    assertContract(
      areRenderTexturesEnabled() &&
        getRenderTexturesUniform().value === 1 &&
        isSurfaceChartEnabled() &&
        seen[seen.length - 1] === true,
      'textures on restores the shared uniform, the surface chart, and notifies readers',
    );
  } finally {
    unregister();
    setRenderTexturesEnabled(initial);
  }

  // The terrain gate: every enable branch, every field blend, and the ore
  // detail branch read the shared uniform in the composed fragment.
  const sample = [
    ...TERRAIN_TEXTURE_ENABLE_UNIFORMS.map((name) => `if (${name} > 0.0) { x(); }`),
    ...TERRAIN_TEXTURE_BLEND_UNIFORMS.map((name) => `y(base, macro, meso, plane, size, ${name})`),
    TERRAIN_METAL_DETAIL_BRANCH,
    'if (uSomethingElseEnabled > 0.0) { z(); }',
  ].join('\n');
  const gated = gateTerrainTexturesFragment(sample);
  for (const name of TERRAIN_TEXTURE_ENABLE_UNIFORMS) {
    assertContract(
      gated.includes(`${name} * uTexturesEnabled > 0.0`) && !gated.includes(`(${name} > 0.0)`),
      `${name} branch is gated by the global textures switch`,
    );
  }
  for (const name of TERRAIN_TEXTURE_BLEND_UNIFORMS) {
    assertContract(
      gated.includes(`${name} * uTexturesEnabled)`),
      `${name} blend is scaled by the global textures switch`,
    );
  }
  assertContract(
    gated.includes('if (metalCoverage > 0.0 && uTexturesEnabled > 0.0) {'),
    'the ore detail branch is gated by the global textures switch',
  );
  assertContract(
    gated.includes('if (uSomethingElseEnabled > 0.0) { z(); }'),
    'unrelated enable branches are left alone',
  );
}
