import type { EntityMesh } from './EntityMesh3D';
import type { LegInstancedRenderer } from './LegInstancedRenderer';
import type { TeamTrimRenderer3D } from './TeamTrimRenderer3D';
import type { UnitDetailInstanceRenderer3D } from './UnitDetailInstanceRenderer3D';
import {
  EntityDeathDisassembly3D,
  type EntityDeathBlast3D,
  type EntityDeathRenderablePart3D,
} from './EntityDeathDisassembly3D';

/**
 * Capture the unit surfaces that live in renderer-wide instance pools rather
 * than below `mesh.group`. Any render-only whole-unit motion must update these
 * handles alongside the scene-graph root or the visual will pull apart.
 */
export function captureUnitRendererOwnedParts3D(
  mesh: EntityMesh,
  legRenderer: LegInstancedRenderer,
  unitDetailInstances: UnitDetailInstanceRenderer3D,
  teamTrim: TeamTrimRenderer3D | null,
): EntityDeathRenderablePart3D[] {
  const rendererParts: EntityDeathRenderablePart3D[] = [
    ...unitDetailInstances.captureEntityDeathParts(mesh),
  ];
  if (mesh.locomotion?.type === 'crawler') {
    rendererParts.push(...legRenderer.captureEntityDeathParts(mesh.locomotion));
  }
  if (mesh.teamTrimSlot !== undefined) {
    const part = teamTrim?.captureDeathPart(mesh.teamTrimSlot);
    if (part !== undefined && part !== null) rendererParts.push(part);
  }
  for (const turret of mesh.turrets) {
    const slot = turret.teamCollar?.slot;
    if (slot === undefined) continue;
    const part = teamTrim?.captureDeathPart(slot);
    if (part !== undefined && part !== null) rendererParts.push(part);
  }
  return rendererParts;
}

/**
 * Unit adapter around the shared death disassembly. Every renderer-owned
 * instance is captured alongside every ordinary Mesh descendant, so a smooth
 * hull lobe, each barrel, each leg segment/joint/foot, each shield panel, and
 * each team ornament has its own physical death motion.
 */
export class DyingUnitScatter3D {
  private readonly disassembly = new EntityDeathDisassembly3D();

  constructor(
    private readonly legRenderer: LegInstancedRenderer,
    private readonly unitDetailInstances: UnitDetailInstanceRenderer3D,
    private readonly teamTrim: TeamTrimRenderer3D | null,
  ) {}

  prepare(mesh: EntityMesh, blast: EntityDeathBlast3D): number {
    const rendererParts = captureUnitRendererOwnedParts3D(
      mesh,
      this.legRenderer,
      this.unitDetailInstances,
      this.teamTrim,
    );
    return this.disassembly.prepare(mesh, blast, rendererParts);
  }

  advance(mesh: EntityMesh, dtMs: number): void {
    this.disassembly.advance(mesh, dtMs);
  }

  forget(mesh: EntityMesh): void {
    this.disassembly.forget(mesh);
  }
}
