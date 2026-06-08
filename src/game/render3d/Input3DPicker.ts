import * as THREE from 'three';
import type { EntityId, PlayerId } from '../sim/types';
import type { SelectionEntitySource } from '@/types/input';
import type { ThreeApp } from './ThreeApp';
import type { CursorGround, SimGroundPoint } from './CursorGround';
import { Input3DBoxSelection } from './Input3DBoxSelection';

export class Input3DPicker {
  private readonly canvas: HTMLCanvasElement;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly boxSelection = new Input3DBoxSelection();

  constructor(
    private readonly threeApp: ThreeApp,
    private readonly cursorGround: CursorGround,
  ) {
    this.canvas = threeApp.renderer.domElement;
  }

  canvasRect(): DOMRect {
    return this.canvas.getBoundingClientRect();
  }

  raycastGround(clientX: number, clientY: number): SimGroundPoint | null {
    return this.cursorGround.pickSim(clientX, clientY);
  }

  raycastEntity(clientX: number, clientY: number): EntityId | null {
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
    const hits = this.raycaster.intersectObject(this.threeApp.world, true);
    for (const hit of hits) {
      let obj: THREE.Object3D | null = hit.object;
      while (obj && obj.userData.entityId === undefined) obj = obj.parent;
      if (obj && obj.userData.entityId !== undefined) {
        return obj.userData.entityId as EntityId;
      }
    }
    return null;
  }

  selectEntitiesInScreenRect(
    source: SelectionEntitySource,
    playerId: PlayerId,
    a: { x: number; y: number },
    b: { x: number; y: number },
  ): EntityId[] {
    return this.boxSelection.select(
      source,
      this.canvasRect(),
      this.threeApp.camera,
      playerId,
      a,
      b,
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
