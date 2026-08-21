import * as THREE from 'three';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import type { ScreenRectSelectionOptions } from '../input/helpers';
import type { SelectionEntitySource } from '@/types/input';
import type { ThreeApp } from './ThreeApp';
import type { CursorGround, SimGroundPoint } from './CursorGround';
import { Input3DBoxSelection } from './Input3DBoxSelection';
import { raycastVegetation, vegetationTargetIdForIndex } from '../sim/vegetation';
import {
  createEntityVolume,
  rayVolumeT,
  writeSelectionVolume,
} from '../sim/entityVolumes';

/** Pick reach for vegetation, in world units. Long enough to cross the
 *  map from any camera altitude the orbit camera allows, so a prop is
 *  never unclickable just because the camera pulled back. */
const VEGETATION_PICK_MAX_DISTANCE = 1e6;

export class Input3DPicker {
  private readonly canvas: HTMLCanvasElement;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly boxSelection = new Input3DBoxSelection();
  /** Reused by the per-entity pick loop so a pick allocates nothing. */
  private readonly pickVolume = createEntityVolume();

  constructor(
    private readonly threeApp: ThreeApp,
    private readonly cursorGround: CursorGround,
    private readonly getEntitySource: () => SelectionEntitySource,
  ) {
    this.canvas = threeApp.renderer.domElement;
  }

  canvasRect(): DOMRect {
    return this.canvas.getBoundingClientRect();
  }

  raycastGround(clientX: number, clientY: number): SimGroundPoint | null {
    return this.cursorGround.pickSim(clientX, clientY);
  }

  /** Waypoint pick: raycast the actual terrain, including terrain submerged
   * by water. */
  raycastTerrainBed(clientX: number, clientY: number): SimGroundPoint | null {
    return this.cursorGround.pickTerrainBedSim(clientX, clientY);
  }

  /** Pick the entity under the cursor in true 3D, independent of how it
   *  is rendered. Casts the camera ray and intersects each entity's
   *  world-space selection volume — a body sphere for units, an upright
   *  footprint x visual-height box for grounded buildings, the torus ring
   *  for the hovering fabricator — returning the one nearest the camera.
   *  Unlike a mesh raycast this works for units drawn as LOD proxy points
   *  and for airborne bodies high above the terrain: the cursor targets
   *  the body itself, never its ground projection, at any camera angle.
   *
   *  Three.js world maps to sim coords as THREE(x, z_altitude, y), so the
   *  ray is transposed on the way in and the whole test runs in sim space
   *  against the volumes the debug overlay draws. An optional filter
   *  pre-rejects entities. */
  raycastEntity(
    clientX: number,
    clientY: number,
    filter: ((entity: Entity) => boolean) | null = null,
  ): EntityId | null {
    const rect = this.canvasRect();
    if (
      clientX < rect.left ||
      clientX > rect.right ||
      clientY < rect.top ||
      clientY > rect.bottom
    ) {
      return null;
    }
    this.castRay(clientX, clientY);
    const ray = this.raycaster.ray;
    const ox = ray.origin.x;
    const oy = ray.origin.z;
    const oz = ray.origin.y;
    const dx = ray.direction.x;
    const dy = ray.direction.z;
    const dz = ray.direction.y;

    let bestId: EntityId | null = null;
    let bestT = Infinity;
    const volume = this.pickVolume;

    const consider = (entity: Entity): void => {
      if (filter !== null && !filter(entity)) return;
      if (!writeSelectionVolume(entity, volume)) return;
      const t = rayVolumeT(volume, ox, oy, oz, dx, dy, dz);
      if (t < 0) return;
      if (t < bestT) {
        bestT = t;
        bestId = entity.id;
      }
    };

    const source = this.getEntitySource();
    const units = source.getUnits();
    for (let i = 0; i < units.length; i++) consider(units[i]);
    const buildings = source.getBuildings();
    for (let i = 0; i < buildings.length; i++) consider(buildings[i]);

    return bestId;
  }

  /** Pick the nearest vegetation prop under the cursor. Props are not
   *  entities, so they have their own store and their own ray test —
   *  but the model is the same one `raycastEntity` uses: a world-space
   *  selection volume around the body itself, evaluated in the sim's
   *  own coordinates. Returns the prop's reclaim target id, or null.
   *
   *  Three.js world maps to sim coords as THREE(x, z_altitude, y), so
   *  the ray is transposed on the way in. */
  raycastVegetation(clientX: number, clientY: number): EntityId | null {
    const rect = this.canvasRect();
    if (
      clientX < rect.left ||
      clientX > rect.right ||
      clientY < rect.top ||
      clientY > rect.bottom
    ) {
      return null;
    }
    this.castRay(clientX, clientY);
    const ray = this.raycaster.ray;
    const index = raycastVegetation(
      ray.origin.x,
      ray.origin.z,
      ray.origin.y,
      ray.direction.x,
      ray.direction.z,
      ray.direction.y,
      VEGETATION_PICK_MAX_DISTANCE,
    );
    return index < 0 ? null : vegetationTargetIdForIndex(index);
  }

  selectEntitiesInScreenRect(
    source: SelectionEntitySource,
    playerId: PlayerId | undefined,
    a: { x: number; y: number },
    b: { x: number; y: number },
    options: ScreenRectSelectionOptions = {},
  ): EntityId[] {
    return this.boxSelection.select(
      source,
      this.canvasRect(),
      this.threeApp.camera,
      playerId,
      a,
      b,
      options,
    );
  }

  private toNDC(clientX: number, clientY: number): THREE.Vector2 {
    const rect = this.canvasRect();
    return this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  private castRay(clientX: number, clientY: number): void {
    const ndc = this.toNDC(clientX, clientY);
    this.raycaster.setFromCamera(ndc, this.threeApp.camera);
  }
}
