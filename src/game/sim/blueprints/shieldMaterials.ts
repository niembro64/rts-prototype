/**
 * Force-field material blueprints.
 *
 * Materials own the physical + visual contract for shield surfaces.
 * Turret shots reference these by id; panel and sphere geometry only decide
 * where the material is projected.
 */

import {
  isShieldMaterialId,
  type ShieldMaterialId,
} from '../../../types/blueprintIds';
import {
  SHIELD_SURFACE_RESPONSES,
  isShieldReflectionMode,
  type ShieldMaterialBlueprint,
  type ShieldSurfaceResponse,
} from './types';
import rawShieldMaterials from './shieldMaterials.json';
import { assertExplicitFields } from './jsonValidation';

const MATERIAL_EXPLICIT_FIELDS = [
  'reflection',
  'projectileResponse',
  'hitReaction',
  'visual',
] as const;

const SHIELD_SURFACE_RESPONSE_SET =
  new Set<ShieldSurfaceResponse>(SHIELD_SURFACE_RESPONSES);

const SHIELD_MATERIALS = rawShieldMaterials as unknown as Record<
  ShieldMaterialId,
  ShieldMaterialBlueprint
>;

export const REFLECTIVE_SHIELD_MATERIAL =
  SHIELD_MATERIALS.reflectiveShield;

export function getShieldMaterial(id: string): ShieldMaterialBlueprint {
  if (!isShieldMaterialId(id)) {
    throw new Error(`Unknown shield material: ${id}`);
  }
  return SHIELD_MATERIALS[id];
}

function assertSurfaceResponse(
  materialId: string,
  shotType: keyof ShieldMaterialBlueprint['projectileResponse'],
  response: unknown,
): void {
  if (!SHIELD_SURFACE_RESPONSE_SET.has(response as ShieldSurfaceResponse)) {
    throw new Error(
      `Force-field material ${materialId} has invalid ${shotType} response: ${String(response)}`,
    );
  }
}

for (const [id, material] of Object.entries(SHIELD_MATERIALS)) {
  if (material.materialId !== id) {
    throw new Error(
      `Force-field material key/id mismatch: ${id} contains ${material.materialId}`,
    );
  }
  assertExplicitFields(
    `shield material ${id}`,
    material,
    MATERIAL_EXPLICIT_FIELDS,
  );
  if (!isShieldReflectionMode(material.reflection.mode)) {
    throw new Error(
      `Force-field material ${id} has invalid reflection.mode: ${String(material.reflection.mode)}`,
    );
  }
  if (
    !Number.isFinite(material.reflection.reflectivity) ||
    material.reflection.reflectivity < 0
  ) {
    throw new Error(
      `Force-field material ${id} must define non-negative finite reflectivity`,
    );
  }
  assertSurfaceResponse(id, 'plasma', material.projectileResponse.plasma);
  assertSurfaceResponse(id, 'rocket', material.projectileResponse.rocket);
  assertSurfaceResponse(id, 'beam', material.projectileResponse.beam);
  assertSurfaceResponse(id, 'laser', material.projectileResponse.laser);
  // Materials describe what happens after a shield policy accepts a ray
  // hit. Per-shield reflection.entities may still opt a ray family out
  // before the material response is reached.
  for (const rayShotType of ['beam', 'laser'] as const) {
    if (material.projectileResponse[rayShotType] !== 'reflect') {
      throw new Error(
        `Force-field material ${id} must use 'reflect' for ${rayShotType}: accepted ray shield hits are reflective; use shield reflection.entities to opt a ray family out`,
      );
    }
  }
  if (material.hitReaction.impactEvent !== 'shieldImpact') {
    throw new Error(
      `Force-field material ${id} has invalid hitReaction.impactEvent: ${String(material.hitReaction.impactEvent)}`,
    );
  }
  if (
    !Number.isFinite(material.visual.color) ||
    !Number.isFinite(material.visual.alpha) ||
    !Number.isFinite(material.visual.particleAlpha)
  ) {
    throw new Error(
      `Force-field material ${id} must define finite visual color/alpha/particleAlpha`,
    );
  }
}
