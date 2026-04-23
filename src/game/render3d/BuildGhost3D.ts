// BuildGhost3D — translucent footprint preview for build mode in the
// 3D scene. Mirrors the 2D BuildingPlacementController.drawBuildGhost
// (green when placeable, red when out of the commander's build range)
// so the two renderers give the same affordance.
//
// Ownership: Input3DManager drives it (call setTarget on mouse move,
// hide on mode exit). The meshes are parented to the world group so
// they track camera pan/orbit naturally.

import * as THREE from 'three';
import type { Entity, BuildingType } from '../sim/types';
import { getBuildingConfig } from '../sim/buildConfigs';
import { GRID_CELL_SIZE } from '../sim/grid';
import { getSnappedBuildPosition } from '../input/helpers';

const GHOST_Y = 1; // hover a hair above the ground so it doesn't z-fight tiles
const RANGE_Y = 0.6;

export class BuildGhost3D {
  private world: THREE.Group;
  private group = new THREE.Group();

  /** Flat footprint rectangle (scaled to the current building type). */
  private footprint: THREE.Mesh;
  /** Commander build-range circle (drawn as a thin ring). */
  private rangeRing: THREE.Mesh;
  /** Warning line from commander to ghost, shown only when out of range. */
  private rangeLine: THREE.Line;
  private rangeLineGeom: THREE.BufferGeometry;

  // Materials kept as fields so we can swap colors without re-creating
  // the meshes on every frame.
  private footMatOk: THREE.MeshBasicMaterial;
  private footMatBad: THREE.MeshBasicMaterial;
  private ringMat: THREE.MeshBasicMaterial;
  private lineMat: THREE.LineBasicMaterial;

  // Reusable scratch arrays.
  private _linePositions = new Float32Array(6);

  constructor(world: THREE.Group) {
    this.world = world;

    this.footMatOk = new THREE.MeshBasicMaterial({
      color: 0x88ff88,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.footMatBad = new THREE.MeshBasicMaterial({
      color: 0xff4444,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    // Plane geometry of unit size, scaled per-building on setTarget.
    const footGeom = new THREE.PlaneGeometry(1, 1);
    this.footprint = new THREE.Mesh(footGeom, this.footMatOk);
    this.footprint.rotation.x = -Math.PI / 2;
    this.footprint.position.y = GHOST_Y;
    this.group.add(this.footprint);

    // Thin ring at commander build-range radius. Inner radius set to
    // just under outer so it reads as a stroke rather than a filled
    // disc.
    this.ringMat = new THREE.MeshBasicMaterial({
      color: 0x00ff00,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const ringGeom = new THREE.RingGeometry(0.985, 1.0, 64);
    this.rangeRing = new THREE.Mesh(ringGeom, this.ringMat);
    this.rangeRing.rotation.x = -Math.PI / 2;
    this.rangeRing.position.y = RANGE_Y;
    this.group.add(this.rangeRing);

    // Out-of-range warning line.
    this.lineMat = new THREE.LineBasicMaterial({
      color: 0xff4444,
      transparent: true,
      opacity: 0.6,
    });
    this.rangeLineGeom = new THREE.BufferGeometry();
    this.rangeLineGeom.setAttribute(
      'position',
      new THREE.BufferAttribute(this._linePositions, 3),
    );
    this.rangeLine = new THREE.Line(this.rangeLineGeom, this.lineMat);
    this.group.add(this.rangeLine);

    this.group.visible = false;
    this.world.add(this.group);
  }

  /** Update the ghost position + styling. Sim y maps to world z on
   *  the ground plane. Pass a freshly selected commander so the
   *  range circle + in-range check reflect the current selection. */
  setTarget(
    buildingType: BuildingType,
    worldX: number,
    worldY: number,
    commander: Entity | null,
  ): void {
    const snapped = getSnappedBuildPosition(worldX, worldY, buildingType);
    const config = getBuildingConfig(buildingType);
    const width = config.gridWidth * GRID_CELL_SIZE;
    const depth = config.gridHeight * GRID_CELL_SIZE;

    let inRange = true;
    if (commander?.builder) {
      const dx = snapped.x - commander.transform.x;
      const dy = snapped.y - commander.transform.y;
      inRange = Math.hypot(dx, dy) <= commander.builder.buildRange;
    }

    this.footprint.scale.set(width, depth, 1);
    this.footprint.position.set(snapped.x, GHOST_Y, snapped.y);
    this.footprint.material = inRange ? this.footMatOk : this.footMatBad;

    if (commander?.builder) {
      this.rangeRing.visible = true;
      this.rangeRing.position.set(commander.transform.x, RANGE_Y, commander.transform.y);
      const r = commander.builder.buildRange;
      this.rangeRing.scale.set(r, r, 1);

      this.rangeLine.visible = !inRange;
      if (!inRange) {
        this._linePositions[0] = commander.transform.x;
        this._linePositions[1] = RANGE_Y;
        this._linePositions[2] = commander.transform.y;
        this._linePositions[3] = snapped.x;
        this._linePositions[4] = RANGE_Y;
        this._linePositions[5] = snapped.y;
        this.rangeLineGeom.attributes.position.needsUpdate = true;
      }
    } else {
      this.rangeRing.visible = false;
      this.rangeLine.visible = false;
    }

    this.group.visible = true;
  }

  hide(): void {
    this.group.visible = false;
  }

  destroy(): void {
    this.world.remove(this.group);
    (this.footprint.geometry as THREE.BufferGeometry).dispose();
    (this.rangeRing.geometry as THREE.BufferGeometry).dispose();
    this.rangeLineGeom.dispose();
    this.footMatOk.dispose();
    this.footMatBad.dispose();
    this.ringMat.dispose();
    this.lineMat.dispose();
  }
}
