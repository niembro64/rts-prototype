import type { EntityMesh } from './EntityMesh3D';
import type {
  EntityDeathPartDelta3D,
  EntityDeathRenderablePart3D,
} from './EntityDeathDisassembly3D';

export type VanishingUnitVelocity3D = Readonly<{
  x: number;
  y: number;
  z: number;
}>;

type VanishingUnitMotionState3D = {
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  rendererParts: readonly EntityDeathRenderablePart3D[];
};

/**
 * Presentation-only inertial continuation for a unit that just left vision.
 * The simulation entity is already unavailable, so the retained visual coasts
 * at its last known linear velocity for the short alpha-fade interval.
 */
export class VanishingUnitMotion3D {
  private readonly states = new WeakMap<EntityMesh, VanishingUnitMotionState3D>();
  private readonly delta: EntityDeathPartDelta3D = {
    dx: 0,
    dy: 0,
    dz: 0,
    drx: 0,
    dry: 0,
    drz: 0,
  };

  prepare(
    mesh: EntityMesh,
    velocity: VanishingUnitVelocity3D,
    rendererParts: readonly EntityDeathRenderablePart3D[],
  ): void {
    this.states.set(mesh, {
      velocityX: finiteOrZero(velocity.x),
      velocityY: finiteOrZero(velocity.y),
      velocityZ: finiteOrZero(velocity.z),
      rendererParts,
    });
  }

  advance(mesh: EntityMesh, dtMs: number): void {
    const state = this.states.get(mesh);
    if (state === undefined || !Number.isFinite(dtMs) || dtMs <= 0) return;
    const dtSec = dtMs / 1000;
    const delta = this.delta;
    delta.dx = state.velocityX * dtSec;
    delta.dy = state.velocityY * dtSec;
    delta.dz = state.velocityZ * dtSec;

    // Ordinary meshes inherit the root translation. Renderer-owned instances
    // are world-parented, so apply the identical world delta to each handle.
    mesh.group.position.x += delta.dx;
    mesh.group.position.y += delta.dy;
    mesh.group.position.z += delta.dz;
    for (const part of state.rendererParts) part.applyDelta(delta);
  }

  forget(mesh: EntityMesh): void {
    this.states.delete(mesh);
  }
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
