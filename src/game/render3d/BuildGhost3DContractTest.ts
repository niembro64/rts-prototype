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
    metalCovered: false,
  }, 20);
  // A deposit cell's surfaceY is the coin top (resolved higher than the
  // buried pad); the pose itself applies the SAME small lift as terrain.
  const depositPose = resolveBuildAbilitySquarePose({
    x: 100,
    y: 200,
    metalCovered: true,
  }, 80);

  assertContract(terrainPose.fillY > 20, 'terrain squares should sit above terrain');
  assertContract(terrainPose.borderY > terrainPose.fillY, 'terrain borders should sit above fills');
  assertContract(
    Math.abs((depositPose.fillY - 80) - (terrainPose.fillY - 20)) < 1e-6,
    'deposit squares use the same lift as terrain squares; only their coin-top surfaceY differs',
  );
  assertContract(depositPose.borderY > depositPose.fillY, 'deposit borders should sit above fills');
}
