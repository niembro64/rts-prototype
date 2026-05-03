// BuildGhost3D — translucent footprint preview for build mode in the
// 3D scene. Ground-cell colors describe only placement/resource facts:
// green = buildable flat ground, red = blocked/unbuildable ground,
// blue = required resource/special build cells. Commander range is
// shown separately because the commander can walk to the site.
//
// Ownership: Input3DManager drives it (call setTarget on mouse move,
// hide on mode exit). The meshes are parented to the world group so
// they track camera pan/orbit naturally.

import * as THREE from 'three';
import type { Entity, BuildingType } from '../sim/types';
import { getBuildingConfig } from '../sim/buildConfigs';
import { GRID_CELL_SIZE } from '../sim/grid';
import {
  type BuildPlacementCellDiagnostic,
  type BuildPlacementDiagnostics,
  getSnappedBuildPosition,
} from '../input/helpers';
import { getUnitGroundZ } from '../sim/unitGeometry';

const GHOST_Y = 1; // hover a hair above the ground so it doesn't z-fight tiles
const CELL_Y = 1.25;
const RANGE_Y = 0.6;
type GroundHeightLookup = (x: number, y: number) => number;

export class BuildGhost3D {
  private world: THREE.Group;
  private getGroundHeight: GroundHeightLookup;
  private group = new THREE.Group();

  /** Flat footprint rectangle (scaled to the current building type). */
  private footprint: THREE.Mesh;
  /** Commander build-range circle (drawn as a thin ring). */
  private rangeRing: THREE.Mesh;
  /** Warning line from commander to ghost, shown only when out of range. */
  private rangeLine: THREE.Line;
  private rangeLineGeom: THREE.BufferGeometry;
  /** Per-footprint-cell diagnostic tiles. */
  private cellGeom: THREE.PlaneGeometry;
  private cellMeshes: THREE.Mesh[] = [];

  // Materials kept as fields so we can swap colors without re-creating
  // the meshes on every frame.
  private footMatOk: THREE.MeshBasicMaterial;
  private footMatBad: THREE.MeshBasicMaterial;
  private cellMatOk: THREE.MeshBasicMaterial;
  private cellMatMetal: THREE.MeshBasicMaterial;
  private cellMatBad: THREE.MeshBasicMaterial;
  private ringMat: THREE.MeshBasicMaterial;
  private lineMat: THREE.LineBasicMaterial;

  // Reusable scratch arrays.
  private _linePositions = new Float32Array(6);

  constructor(world: THREE.Group, getGroundHeight: GroundHeightLookup = () => 0) {
    this.world = world;
    this.getGroundHeight = getGroundHeight;

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
    this.cellMatOk = new THREE.MeshBasicMaterial({
      color: 0x00ff00,
      transparent: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.cellMatMetal = new THREE.MeshBasicMaterial({
      color: 0x006dff,
      transparent: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.cellMatBad = new THREE.MeshBasicMaterial({
      color: 0xff0000,
      transparent: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    // Plane geometry of unit size, scaled per-building on setTarget.
    const footGeom = new THREE.PlaneGeometry(1, 1);
    this.footprint = new THREE.Mesh(footGeom, this.footMatOk);
    this.footprint.rotation.x = -Math.PI / 2;
    this.footprint.position.y = GHOST_Y;
    this.footprint.renderOrder = 20;
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
    this.cellGeom = new THREE.PlaneGeometry(GRID_CELL_SIZE, GRID_CELL_SIZE);

    this.group.visible = false;
    this.world.add(this.group);
  }

  /** Update the ghost position + styling. Sim y maps to world z on
   *  the ground plane. Pass a freshly selected commander so the
   *  range circle + in-range check reflect the current selection.
   *  `canPlace` comes from the client-side placement validator
   *  (terrain/resource/overlap/map bounds). Commander range is drawn
   *  with the range ring/line only; it never changes the ground-cell
   *  diagnostic colors. */
  setTarget(
    buildingType: BuildingType,
    worldX: number,
    worldY: number,
    commander: Entity | null,
    canPlace: boolean,
    diagnostics?: BuildPlacementDiagnostics,
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

    const okVisually = canPlace;
    const targetGroundY = this.getGroundHeight(snapped.x, snapped.y);
    this.footprint.scale.set(width, depth, 1);
    this.footprint.position.set(snapped.x, targetGroundY + GHOST_Y, snapped.y);
    this.footprint.material = okVisually ? this.footMatOk : this.footMatBad;
    this.footprint.visible = !this.updateDiagnosticCells(diagnostics);

    if (commander?.builder) {
      const commanderGroundY = getUnitGroundZ(commander);
      const ringY = commanderGroundY + RANGE_Y;
      this.rangeRing.visible = true;
      this.rangeRing.position.set(commander.transform.x, ringY, commander.transform.y);
      const r = commander.builder.buildRange;
      this.rangeRing.scale.set(r, r, 1);

      this.rangeLine.visible = !inRange;
      if (!inRange) {
        this._linePositions[0] = commander.transform.x;
        this._linePositions[1] = ringY;
        this._linePositions[2] = commander.transform.y;
        this._linePositions[3] = snapped.x;
        this._linePositions[4] = targetGroundY + RANGE_Y;
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

  private materialForCell(cell: BuildPlacementCellDiagnostic): THREE.Material {
    if (cell.blocking) return this.cellMatBad;
    if (cell.reason === 'metal') return this.cellMatMetal;
    return this.cellMatOk;
  }

  private updateDiagnosticCells(diagnostics?: BuildPlacementDiagnostics): boolean {
    const cells = diagnostics?.cells ?? [];
    while (this.cellMeshes.length < cells.length) {
      const mesh = new THREE.Mesh(this.cellGeom, this.cellMatOk);
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = 30;
      this.group.add(mesh);
      this.cellMeshes.push(mesh);
    }

    for (let i = 0; i < this.cellMeshes.length; i++) {
      const mesh = this.cellMeshes[i];
      const cell = cells[i];
      if (!cell) {
        mesh.visible = false;
        continue;
      }
      const y = this.getGroundHeight(cell.x, cell.y);
      mesh.position.set(cell.x, y + CELL_Y, cell.y);
      mesh.material = this.materialForCell(cell);
      mesh.visible = true;
    }
    return cells.length > 0;
  }

  destroy(): void {
    this.world.remove(this.group);
    (this.footprint.geometry as THREE.BufferGeometry).dispose();
    (this.rangeRing.geometry as THREE.BufferGeometry).dispose();
    this.cellGeom.dispose();
    this.rangeLineGeom.dispose();
    this.footMatOk.dispose();
    this.footMatBad.dispose();
    this.cellMatOk.dispose();
    this.cellMatMetal.dispose();
    this.cellMatBad.dispose();
    this.ringMat.dispose();
    this.lineMat.dispose();
  }
}
