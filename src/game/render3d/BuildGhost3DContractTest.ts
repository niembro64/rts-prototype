import { resolveBuildAbilitySquarePose } from './BuildGhost3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[build ghost contract] ${message}`);
  }
}

export function runBuildGhost3DContractTest(): void {
  const terrainPose = resolveBuildAbilitySquarePose({
    x: 100,
    y: 200,
  }, 20);
  // A submerged square is still based on the terrain-bed height supplied by
  // the caller; it must never be promoted to the water plane or a prop top.
  const seabedPose = resolveBuildAbilitySquarePose({
    x: 100,
    y: 200,
  }, -80);

  assertContract(terrainPose.fillY > 20, 'terrain squares should sit above terrain');
  assertContract(terrainPose.borderY > terrainPose.fillY, 'terrain borders should sit above fills');
  assertContract(
    Math.abs((seabedPose.fillY + 80) - (terrainPose.fillY - 20)) < 1e-6,
    'seabed and dry-terrain squares must use the same terrain-relative lift',
  );
  assertContract(seabedPose.fillY < 0, 'submerged build squares must remain on the seabed');
  assertContract(seabedPose.borderY > seabedPose.fillY, 'seabed borders should sit above fills');
}
