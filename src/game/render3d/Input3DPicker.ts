import * as THREE from 'three';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import type { ScreenRectSelectionOptions } from '../input/helpers';
import type { SelectionEntitySource } from '@/types/input';
import type { ThreeApp } from './ThreeApp';
import type { CursorGround, SimGroundPoint } from './CursorGround';
import { Input3DBoxSelection } from './Input3DBoxSelection';
import { getBuildingVisualCenterZ } from '../sim/buildingAnchors';

/** Enlarge the pick volume past the drawn body so clicks near an edge
 *  still land — BAR enlarges selection volumes by a similar factor. */
const SELECTION_VOLUME_SCALE = 1.18;
/** Floor (world units) so tiny units — and units drawn only as LOD
 *  proxy points at distance — stay easy to click at any zoom. */
const MIN_SELECTION_RADIUS = 12;

/** World-space pick radius for an entity's selection volume. Units use
 *  their drawn radius; buildings/towers use their footprint half-diagonal. */
function selectionVolumeRadius(entity: Entity): number {
  if (entity.unit !== null) {
    return Math.max(MIN_SELECTION_RADIUS, entity.unit.radius.visual * SELECTION_VOLUME_SCALE);
  }
  if (entity.building !== null) {
    const halfDiag = 0.5 * Math.hypot(entity.building.width, entity.building.height);
    return Math.max(MIN_SELECTION_RADIUS, halfDiag * SELECTION_VOLUME_SCALE);
  }
  return 0;
}

export class Input3DPicker {
  private readonly canvas: HTMLCanvasElement;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly boxSelection = new Input3DBoxSelection();

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

  /** Pick the entity under the cursor in true 3D, independent of how it
   *  is rendered. Casts the camera ray and intersects each entity's
   *  world-space selection sphere (centered on its body, at its real
   *  altitude), returning the one nearest the camera. Unlike a mesh
   *  raycast this works for units drawn as LOD proxy points and for
   *  airborne bodies high above the terrain — the cursor targets the
   *  body itself, never its ground projection, at any camera angle.
   *
   *  Sim coords map to three.js world as (x, z_altitude, y): the renderer
   *  positions every body at THREE(sim.x, centerZ, sim.y) — see
   *  Input3DBoxSelection. An optional filter pre-rejects entities. */
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
    const ox0 = ray.origin.x;
    const oy0 = ray.origin.y;
    const oz0 = ray.origin.z;
    const dx = ray.direction.x;
    const dy = ray.direction.y;
    const dz = ray.direction.z;

    let bestId: EntityId | null = null;
    let bestT = Infinity;

    const consider = (entity: Entity): void => {
      if (filter !== null && !filter(entity)) return;
      const radius = selectionVolumeRadius(entity);
      if (radius <= 0) return;
      const cx = entity.transform.x;
      const cy = entity.building !== null
        ? getBuildingVisualCenterZ(entity)
        : entity.transform.z;
      const cz = entity.transform.y;
      const ox = cx - ox0;
      const oy = cy - oy0;
      const oz = cz - oz0;
      // ray.direction is unit-length, so t is the signed distance along
      // the ray to the point's projection.
      const t = ox * dx + oy * dy + oz * dz;
      if (t < 0) return; // behind the camera
      const perpSq = (ox * ox + oy * oy + oz * oz) - t * t;
      if (perpSq > radius * radius) return; // ray misses the volume
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

  selectEntitiesInScreenRect(
    source: SelectionEntitySource,
    playerId: PlayerId,
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
