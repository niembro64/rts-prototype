import type { TurretMount } from '@/types/blueprints';
import type { Vec3 } from '@/types/vec2';

export type RuntimeTurretMountSource = {
  mount: Vec3;
};

export function createRuntimeTurretMount(
  mount: TurretMount,
  bodyRadius: number,
): Vec3 {
  return {
    x: mount.mount.x * bodyRadius,
    y: mount.mount.y * bodyRadius,
    z: mount.mount.z * bodyRadius,
  };
}

export function getRuntimeTurretMount(
  turret: RuntimeTurretMountSource,
  out?: Vec3,
): Vec3 {
  const dst = out ?? { x: 0, y: 0, z: 0 };
  const mount = turret.mount;
  if (
    mount &&
    Number.isFinite(mount.x) &&
    Number.isFinite(mount.y) &&
    Number.isFinite(mount.z)
  ) {
    dst.x = mount.x;
    dst.y = mount.y;
    dst.z = mount.z;
    return dst;
  }

  throw new Error('Runtime turret is missing a finite blueprint-derived 3D mount');
}

export function getRuntimeTurretMountHeight(
  turret: RuntimeTurretMountSource,
): number {
  if (Number.isFinite(turret.mount.z)) return turret.mount.z;
  throw new Error('Runtime turret is missing a finite blueprint-derived mount height');
}
