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
  const depositPose = resolveBuildAbilitySquarePose({
    x: 100,
    y: 200,
    metalCovered: true,
  }, 20);

  assertContract(terrainPose.fillY > 20, 'terrain squares should sit above terrain');
  assertContract(terrainPose.borderY > terrainPose.fillY, 'terrain borders should sit above fills');
  assertContract(
    depositPose.fillY >= terrainPose.fillY + 5,
    'metal deposit squares should clear the coin top more aggressively than terrain squares',
  );
  assertContract(depositPose.borderY > depositPose.fillY, 'deposit borders should sit above fills');
}
