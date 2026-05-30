/**
 * Force-field material blueprints.
 *
 * Materials own the physical + visual contract for force-field surfaces.
 * Turret shots reference these by id; panel and sphere geometry only decide
 * where the material is projected.
 */

import {
  isForceFieldMaterialId,
  type ForceFieldMaterialId,
} from '../../../types/blueprintIds';
import {
  FORCE_FIELD_SURFACE_RESPONSES,
  isForceFieldReflectionMode,
  type ForceFieldMaterialBlueprint,
  type ForceFieldSurfaceResponse,
} from './types';
import rawForceFieldMaterials from './forceFieldMaterials.json';
import { assertExplicitFields } from './jsonValidation';

const MATERIAL_EXPLICIT_FIELDS = [
  'reflection',
  'occlusion',
  'projectileResponse',
  'hitReaction',
  'visual',
] as const;

const FORCE_FIELD_SURFACE_RESPONSE_SET =
  new Set<ForceFieldSurfaceResponse>(FORCE_FIELD_SURFACE_RESPONSES);

export const FORCE_FIELD_MATERIALS = rawForceFieldMaterials as unknown as Record<
  ForceFieldMaterialId,
  ForceFieldMaterialBlueprint
>;

export const REFLECTIVE_FORCE_FIELD_MATERIAL =
  FORCE_FIELD_MATERIALS.reflectiveForceField;

export function getForceFieldMaterial(id: string): ForceFieldMaterialBlueprint {
  if (!isForceFieldMaterialId(id)) {
    throw new Error(`Unknown force-field material: ${id}`);
  }
  return FORCE_FIELD_MATERIALS[id];
}

function assertSurfaceResponse(
  materialId: string,
  shotType: keyof ForceFieldMaterialBlueprint['projectileResponse'],
  response: unknown,
): void {
  if (!FORCE_FIELD_SURFACE_RESPONSE_SET.has(response as ForceFieldSurfaceResponse)) {
    throw new Error(
      `Force-field material ${materialId} has invalid ${shotType} response: ${String(response)}`,
    );
  }
}

for (const [id, material] of Object.entries(FORCE_FIELD_MATERIALS)) {
  if (material.materialId !== id) {
    throw new Error(
      `Force-field material key/id mismatch: ${id} contains ${material.materialId}`,
    );
  }
  assertExplicitFields(
    `force-field material ${id}`,
    material,
    MATERIAL_EXPLICIT_FIELDS,
  );
  if (!isForceFieldReflectionMode(material.reflection.mode)) {
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
  if (typeof material.occlusion.blocksLineOfSight !== 'boolean') {
    throw new Error(
      `Force-field material ${id} must define boolean occlusion.blocksLineOfSight`,
    );
  }
  assertSurfaceResponse(id, 'plasma', material.projectileResponse.plasma);
  assertSurfaceResponse(id, 'rocket', material.projectileResponse.rocket);
  assertSurfaceResponse(id, 'beam', material.projectileResponse.beam);
  assertSurfaceResponse(id, 'laser', material.projectileResponse.laser);
  if (material.hitReaction.impactEvent !== 'forceFieldImpact') {
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
