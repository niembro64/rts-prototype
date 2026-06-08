import { VISION_FADE_IN_MS } from '@/visionConfig';
import type { EntityId } from '../sim/types';
import { applyEntityGroupFade } from './EntityFade3D';
import type { EntityMesh } from './EntityMesh3D';
import type { LegInstancedRenderer } from './LegInstancedRenderer';
import { fadeLocomotion } from './Locomotion3D';
import type { UnitDetailInstanceRenderer3D } from './UnitDetailInstanceRenderer3D';

export function advanceUnitVisionFadeIn(
  spawnFadeElapsed: Map<EntityId, number>,
  id: EntityId,
  dtMs: number,
): number {
  if (VISION_FADE_IN_MS <= 0) return 1;
  const prev = spawnFadeElapsed.get(id);
  if (prev === VISION_FADE_IN_MS) return 1;
  const elapsed = Math.min((prev ?? 0) + dtMs, VISION_FADE_IN_MS);
  spawnFadeElapsed.set(id, elapsed);
  return elapsed / VISION_FADE_IN_MS;
}

export function applyUnitEntityFade3D(
  mesh: EntityMesh,
  bodyFade: number,
  turretFades: readonly number[] | null,
  unitDetailInstances: UnitDetailInstanceRenderer3D,
  legRenderer: LegInstancedRenderer,
): void {
  const bodyFadeActive = bodyFade < 1;
  const specificTurretFadeActive = hasSpecificUnitTurretFade(mesh, bodyFade, turretFades);
  if (bodyFadeActive || specificTurretFadeActive || mesh.unitFadeActive === true) {
    unitDetailInstances.writeEntityFade(mesh, bodyFade, turretFades);
    fadeLocomotion(mesh.locomotion, bodyFade, legRenderer);
    mesh.unitFadeActive = bodyFadeActive || specificTurretFadeActive;
  }

  if (bodyFadeActive || mesh.unitGroupFadeActive === true) {
    applyEntityGroupFade(mesh.group, bodyFade);
    mesh.unitGroupFadeActive = bodyFadeActive;
  }

  if (turretFades === null) return;
  const previousTurretStates = mesh.unitTurretGroupFadeActive;
  if (!specificTurretFadeActive && previousTurretStates === undefined) return;
  const turretStates = previousTurretStates ?? [];
  let anyTurretFadeActive = false;
  for (let i = 0; i < mesh.turrets.length; i++) {
    const fade = turretFades[i] ?? bodyFade;
    const hasSpecificFade = fade < 1 && fade !== bodyFade;
    if (hasSpecificFade || turretStates[i] === true) {
      applyEntityGroupFade(mesh.turrets[i].root, fade);
      turretStates[i] = hasSpecificFade;
    }
    if (hasSpecificFade) anyTurretFadeActive = true;
  }
  mesh.unitTurretGroupFadeActive = anyTurretFadeActive ? turretStates : undefined;
}

function hasSpecificUnitTurretFade(
  mesh: EntityMesh,
  bodyFade: number,
  turretFades: readonly number[] | null,
): boolean {
  if (turretFades === null) return false;
  for (let i = 0; i < mesh.turrets.length; i++) {
    const fade = turretFades[i] ?? bodyFade;
    if (fade < 1 && fade !== bodyFade) return true;
  }
  return false;
}
