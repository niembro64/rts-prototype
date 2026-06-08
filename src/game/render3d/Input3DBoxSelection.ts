import * as THREE from 'three';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import { getBuildingVisualCenterZ } from '../sim/buildingAnchors';
import {
  selectEntitiesInScreenRect,
  type ScreenRectSelectionOptions,
  type SelectionEntitySource,
} from '../input/helpers';

/** Approximate world-space vertical center for box-select projection,
 *  picked per entity kind so the screen-projected point lands near
 *  the visible body. Keep these in rough lockstep with Render3DEntities
 *  chassis/turret heights. */
function selectionCenterY(entity: Entity): number {
  // Visual center in three.js Y. The entity's transform.z is its
  // current sim altitude, already terrain-aware, so for box selection
  // we just project at that altitude.
  return entity.building ? getBuildingVisualCenterZ(entity) : entity.transform.z;
}

export class Input3DBoxSelection {
  private readonly selectV = new THREE.Vector3();

  /** Delegates to the shared box-select helper. The renderer-specific
   *  bit is the projector: take a sim world (x, y, z) point, run it
   *  through THREE's Vector3.project to get NDC, then convert NDC to
   *  viewport pixels. `behind` is set when NDC z >= 1 so the shared
   *  helper skips entities behind the camera. */
  select(
    source: SelectionEntitySource,
    viewportRect: DOMRect,
    camera: THREE.Camera,
    playerId: PlayerId,
    a: { x: number; y: number },
    b: { x: number; y: number },
    options: ScreenRectSelectionOptions = {},
  ): EntityId[] {
    const v = this.selectV;
    return selectEntitiesInScreenRect(
      source,
      {
        minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
        minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y),
      },
      playerId,
      (entity, out) => {
        const centerY = selectionCenterY(entity);
        v.set(entity.transform.x, centerY, entity.transform.y).project(camera);
        out.x = (v.x * 0.5 + 0.5) * viewportRect.width + viewportRect.left;
        out.y = (-v.y * 0.5 + 0.5) * viewportRect.height + viewportRect.top;
        out.behind = v.z >= 1;
      },
      options,
    );
  }
}
