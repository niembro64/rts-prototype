import type * as THREE from 'three';
import { isRayType } from '@/types/shotTypes';
import type { Entity, EntityId } from '../sim/types';
import {
  DETAIL_LEVEL_FULL,
  DETAIL_RADIUS_FLOOR_BEAM,
  DETAIL_RADIUS_FLOOR_PROJECTILE,
  DETAIL_RUNG_CLOSE,
  type DetailRung,
} from './EntityDetailLevel3D';
import type { RenderViewState3D } from './RenderFrameState3D';

const MIN_ENTITY_RADIUS = 1;

export const ENTITY_LOD_PROXY_GLYPH_CIRCLE = 0;
export const ENTITY_LOD_PROXY_GLYPH_DIAMOND = 1;
export const ENTITY_LOD_PROXY_GLYPH_TRIANGLE = 2;
export const ENTITY_LOD_PROXY_GLYPH_SQUARE = 3;
export const ENTITY_LOD_PROXY_GLYPH_CROSS = 4;

export type EntityLodProxyGlyph3D =
  | typeof ENTITY_LOD_PROXY_GLYPH_CIRCLE
  | typeof ENTITY_LOD_PROXY_GLYPH_DIAMOND
  | typeof ENTITY_LOD_PROXY_GLYPH_TRIANGLE
  | typeof ENTITY_LOD_PROXY_GLYPH_SQUARE
  | typeof ENTITY_LOD_PROXY_GLYPH_CROSS;

function firstFinitePositiveRadius(...values: Array<number | null | undefined>): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.max(MIN_ENTITY_RADIUS, value);
    }
  }
  return MIN_ENTITY_RADIUS;
}

export function entityLodProxyRadius3D(entity: Entity): number {
  const unit = entity.unit;
  if (unit !== null) {
    return firstFinitePositiveRadius(
      unit.radius.collision,
      unit.radius.hitbox,
      unit.radius.other,
    );
  }

  const building = entity.building;
  if (building !== null) {
    return firstFinitePositiveRadius(
      building.targetRadius,
      Math.hypot(building.width, building.height) * 0.5,
    );
  }

  const projectile = entity.projectile;
  if (projectile !== null) {
    const radius = projectile.config.shotProfile.runtime.radius;
    return firstFinitePositiveRadius(radius.collision, radius.hitbox, radius.other);
  }

  return MIN_ENTITY_RADIUS;
}

export function entityDetailRadius3D(entity: Entity): number {
  const unit = entity.unit;
  if (unit !== null) {
    return firstFinitePositiveRadius(
      unit.radius.other,
      unit.radius.hitbox,
      unit.radius.collision,
    );
  }

  const building = entity.building;
  if (building !== null) {
    return firstFinitePositiveRadius(
      Math.hypot(building.width, building.height) * 0.5,
      building.targetRadius,
    );
  }

  const projectile = entity.projectile;
  if (projectile !== null) {
    const floor = isRayType(projectile.config.shot.type)
      ? DETAIL_RADIUS_FLOOR_BEAM
      : DETAIL_RADIUS_FLOOR_PROJECTILE;
    const radius = projectile.config.shotProfile.runtime.radius;
    return Math.max(
      floor,
      firstFinitePositiveRadius(radius.other, radius.hitbox, radius.collision),
    );
  }

  return DETAIL_RADIUS_FLOOR_PROJECTILE;
}

export function unitDetailRadiusFromState3D(
  radiusOther: number,
  radiusHitbox: number,
): number {
  return firstFinitePositiveRadius(radiusOther, radiusHitbox);
}

export function buildingDetailRadiusFromState3D(
  width: number,
  footprintDepth: number,
): number {
  return firstFinitePositiveRadius(Math.hypot(width, footprintDepth) * 0.5);
}

export function entityLodProxyGlyph3D(entity: Entity): EntityLodProxyGlyph3D {
  if (entity.commander !== null) return ENTITY_LOD_PROXY_GLYPH_CROSS;

  const unit = entity.unit;
  if (unit !== null) {
    if (entity.builder !== null) return ENTITY_LOD_PROXY_GLYPH_DIAMOND;
    if (entity.transport !== null || entity.factory !== null) {
      return ENTITY_LOD_PROXY_GLYPH_SQUARE;
    }
    if (unit.locomotion.type === 'flying') return ENTITY_LOD_PROXY_GLYPH_TRIANGLE;
    return ENTITY_LOD_PROXY_GLYPH_CIRCLE;
  }

  if (entity.building !== null) return ENTITY_LOD_PROXY_GLYPH_SQUARE;
  return ENTITY_LOD_PROXY_GLYPH_CIRCLE;
}

export function entityUsesLowLodDistance3D(
  _camera: THREE.Camera,
  _entity: Entity,
): boolean {
  return false;
}

export function simPositionUsesLowLodDistance3D(
  _camera: THREE.Camera,
  _simX: number,
  _simY: number,
  _simZ: number,
): boolean {
  return false;
}

export function entityDetailLevel3D(_camera: THREE.Camera, _entity: Entity): number {
  return DETAIL_LEVEL_FULL;
}

export function entityDetailLevelForView(
  _view: RenderViewState3D,
  _entity: Entity,
): number {
  return DETAIL_LEVEL_FULL;
}

export class EntityLodState3D {
  beginFrame(): void {}
  endFrame(): void {}
  clear(): void {}
  delete(_entityId: EntityId): void {}

  entityDetailLevelForView(_view: RenderViewState3D, _entity: Entity): number {
    return DETAIL_LEVEL_FULL;
  }

  entityDetailLevelForViewSample(
    _view: RenderViewState3D,
    _entityId: EntityId,
    _simX: number,
    _simY: number,
    _simZ: number,
    _detailRadius: number,
  ): number {
    return DETAIL_LEVEL_FULL;
  }

  entityDetailRungForView(_view: RenderViewState3D, _entity: Entity): DetailRung {
    return DETAIL_RUNG_CLOSE;
  }

  entityDetailRungForViewSample(
    _view: RenderViewState3D,
    _entityId: EntityId,
    _simX: number,
    _simY: number,
    _simZ: number,
    _detailRadius: number,
  ): DetailRung {
    return DETAIL_RUNG_CLOSE;
  }

  entityUsesLodProxy(
    _camera: THREE.Camera,
    _entity: Entity,
    _channel?: string,
  ): boolean {
    return false;
  }

  entityUsesLodProxyForView(
    _view: RenderViewState3D,
    _entity: Entity,
    _channel?: string,
  ): boolean {
    return false;
  }

  entityUsesLodProxyForViewSample(
    _view: RenderViewState3D,
    _entityId: EntityId,
    _simX: number,
    _simY: number,
    _simZ: number,
    _detailRadius: number,
    _channel?: string,
  ): boolean {
    return false;
  }

  entityDetailLevel(_camera: THREE.Camera, _entity: Entity): number {
    return DETAIL_LEVEL_FULL;
  }

  entityUsesLowLodDistance(_camera: THREE.Camera, _entity: Entity): boolean {
    return false;
  }

  entityUsesLowLodDistanceForViewSample(
    _view: RenderViewState3D,
    _entityId: EntityId,
    _simX: number,
    _simY: number,
    _simZ: number,
  ): boolean {
    return false;
  }
}
