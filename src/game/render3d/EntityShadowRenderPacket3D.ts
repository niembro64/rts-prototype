import { ENTITY_SHADOW_RENDER_CONFIG } from '../../config';
import type { Entity } from '../sim/types';
import type { ViewportFootprint } from '../ViewportFootprint';
import { getLocomotionSurfaceHeight } from './LocomotionTerrainSampler';
import { SUN_DIRECTION_SIM } from './SunLighting';

const SUN_HORIZONTAL_LENGTH = Math.max(
  1.0e-6,
  Math.hypot(SUN_DIRECTION_SIM.x, SUN_DIRECTION_SIM.y),
);
const SUN_HORIZONTAL_X = SUN_DIRECTION_SIM.x / SUN_HORIZONTAL_LENGTH;
const SUN_HORIZONTAL_Y = SUN_DIRECTION_SIM.y / SUN_HORIZONTAL_LENGTH;
// SUN_DIRECTION_SIM points from the world toward the sun. A cast shadow
// continues in the opposite direction, with horizontal travel determined by
// the same elevation used by the Three.js directional light.
const SHADOW_OFFSET_PER_ALTITUDE =
  SUN_HORIZONTAL_LENGTH / Math.max(1.0e-6, SUN_DIRECTION_SIM.z);

/** Batched projected map-space shadow footprints consumed by WorldShade3D.
 * Unit altitude changes only the center projected opposite the shared sun;
 * strength, size, and softness remain shared and altitude-independent. */
export class EntityShadowRenderPacket3D {
  readonly x = new Float32Array(ENTITY_SHADOW_RENDER_CONFIG.maxInstances);
  readonly y = new Float32Array(ENTITY_SHADOW_RENDER_CONFIG.maxInstances);
  readonly crossRadius = new Float32Array(ENTITY_SHADOW_RENDER_CONFIG.maxInstances);
  readonly sunRadius = new Float32Array(ENTITY_SHADOW_RENDER_CONFIG.maxInstances);
  count = 0;

  reset(): void {
    this.count = 0;
  }

  pushUnit(
    entity: Entity,
    mapWidth: number,
    mapHeight: number,
    scope: ViewportFootprint,
  ): void {
    const unit = entity.unit;
    if (unit === null || unit.hp <= 0) return;
    this.pushUnitState(
      entity.id,
      entity.transform.x,
      entity.transform.y,
      entity.transform.z,
      unit.hp,
      unit.radius.hitbox,
      unit.supportPointOffsetZ ?? unit.radius.other,
      mapWidth,
      mapHeight,
      scope,
    );
  }

  pushUnitState(
    entityId: number,
    x: number,
    y: number,
    z: number,
    hp: number,
    radiusHitbox: number,
    restHeight: number,
    mapWidth: number,
    mapHeight: number,
    scope: ViewportFootprint,
  ): void {
    if (hp <= 0) return;
    const crossRadius = Math.max(
      1,
      radiusHitbox * ENTITY_SHADOW_RENDER_CONFIG.unitHitboxRadiusMultiplier,
    );
    const sunRadius = crossRadius * ENTITY_SHADOW_RENDER_CONFIG.unitSunStretch;
    const groundZ = getLocomotionSurfaceHeight(
      x,
      y,
      mapWidth,
      mapHeight,
      entityId,
    );
    const altitude = Math.max(0, z - groundZ - Math.max(1, restHeight));
    const shadowOffset = altitude * SHADOW_OFFSET_PER_ALTITUDE;
    const shadowX = x - SUN_HORIZONTAL_X * shadowOffset;
    const shadowY = y - SUN_HORIZONTAL_Y * shadowOffset;
    if (!scope.inScope(shadowX, shadowY, Math.max(crossRadius, sunRadius))) return;
    this.push(shadowX, shadowY, crossRadius, sunRadius);
  }

  pushBuilding(entity: Entity, scope: ViewportFootprint): void {
    const building = entity.building;
    if (building === null || building.hp <= 0) return;
    this.pushBuildingState(
      entity.transform.x,
      entity.transform.y,
      building.hp,
      building.width,
      building.height,
      scope,
    );
  }

  pushBuildingState(
    x: number,
    y: number,
    hp: number,
    width: number,
    footprintDepth: number,
    scope: ViewportFootprint,
  ): void {
    if (hp <= 0) return;
    const crossRadius = Math.max(
      ENTITY_SHADOW_RENDER_CONFIG.minBuildingRadius,
      width * 0.5 * ENTITY_SHADOW_RENDER_CONFIG.buildingRadiusMultiplier,
    );
    const sunRadius = Math.max(
      ENTITY_SHADOW_RENDER_CONFIG.minBuildingRadius,
      footprintDepth * 0.5 * ENTITY_SHADOW_RENDER_CONFIG.buildingRadiusMultiplier,
    ) * ENTITY_SHADOW_RENDER_CONFIG.buildingSunStretch;
    if (!scope.inScope(x, y, Math.max(crossRadius, sunRadius))) return;
    this.push(x, y, crossRadius, sunRadius);
  }

  private push(x: number, y: number, crossRadius: number, sunRadius: number): void {
    const cursor = this.count;
    if (cursor >= ENTITY_SHADOW_RENDER_CONFIG.maxInstances) return;
    this.x[cursor] = x;
    this.y[cursor] = y;
    this.crossRadius[cursor] = crossRadius;
    this.sunRadius[cursor] = sunRadius;
    this.count = cursor + 1;
  }
}
