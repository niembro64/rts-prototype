import type { PhysicsEngine3D } from './PhysicsEngine3D';

/** The spawn planner only needs the body coordinates, velocity slots, and
 *  surface-normal view. Keeping this harness pool-free makes spawn-path
 *  contracts runnable without booting the renderer or WASM physics worker.
 *  Shared by every contract test that drives the spawn path headlessly. */
export function createPhysicsHarness(): PhysicsEngine3D {
  let nextBodySlot = 0;
  return {
    // The spawn path checks pool headroom before creating bodies; the
    // harness pool is unbounded, so it always has room.
    hasBodyPoolHeadroom: () => true,
    createUnitBody(
      x: number,
      y: number,
      _radius: number,
      _groundOffset: number,
      _supportSurface: unknown,
      _mass: number,
      _label: string,
      _entityId: number,
      z: number | undefined,
    ) {
      const surfaceNormal = { nx: 0, ny: 0, nz: 1 };
      return {
        slot: nextBodySlot++,
        x,
        y,
        z: z ?? 0,
        vx: 0,
        vy: 0,
        vz: 0,
        createSurfaceNormalView: () => surfaceNormal,
      };
    },
  } as unknown as PhysicsEngine3D;
}
