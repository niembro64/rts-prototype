import type { EntityMesh } from './EntityMesh3D';
import type { TeamTrimRenderer3D } from './TeamTrimRenderer3D';
import {
  EntityDeathDisassembly3D,
  type EntityDeathBlast3D,
  type EntityDeathRenderablePart3D,
} from './EntityDeathDisassembly3D';

/** Capture the few building surfaces that live outside the building group. */
function captureBuildingRendererOwnedParts3D(
  mesh: EntityMesh,
  teamTrim: TeamTrimRenderer3D | null,
): EntityDeathRenderablePart3D[] {
  const parts: EntityDeathRenderablePart3D[] = [];
  for (const turret of mesh.turrets) {
    const slot = turret.teamCollar?.slot;
    if (slot === undefined) continue;
    const part = teamTrim?.captureDeathPart(slot);
    if (part !== undefined && part !== null) parts.push(part);
  }
  return parts;
}

/**
 * Building adapter around the shared death disassembly. Every visible Mesh in
 * the authored structure hierarchy, plus each renderer-owned turret collar,
 * becomes an independently launched and tumbled part.
 */
export class DyingBuildingScatter3D {
  private readonly disassembly = new EntityDeathDisassembly3D();

  constructor(private readonly teamTrim: TeamTrimRenderer3D | null) {}

  prepare(mesh: EntityMesh, blast: EntityDeathBlast3D): number {
    return this.disassembly.prepare(
      mesh,
      blast,
      captureBuildingRendererOwnedParts3D(mesh, this.teamTrim),
    );
  }

  advance(mesh: EntityMesh, dtMs: number): void {
    this.disassembly.advance(mesh, dtMs);
  }

  forget(mesh: EntityMesh): void {
    this.disassembly.forget(mesh);
  }
}
