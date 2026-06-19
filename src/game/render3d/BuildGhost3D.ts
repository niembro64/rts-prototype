// BuildGhost3D — translucent footprint preview for build mode in the
// 3D scene. Ground-cell colors describe placement/resource facts:
// green = buildable, red = blocked, yellow = buildable but suboptimal
// (extractor off a deposit, or a non-extractor placed on a deposit).
// The always-built deposit overlay (a separate group on the same
// instance) draws filled blue squares with a brighter blue border above
// every metal-deposit coin, matching the red/green tile look produced by
// the terrain shader; its visibility is driven externally by
// setBuildGridOverlayVisible and is intentionally tied only to the
// DEBUG: BUILD toggle (build mode does NOT show it). Builder range is
// shown separately because the builder can move to the site.
//
// Ownership: Input3DManager drives the footprint preview (setTarget on
// mouse move, hide on mode exit). The scene render phase drives the
// deposit overlay's visibility every frame. Everything is parented to
// the world group so it tracks camera pan/orbit naturally.

import * as THREE from 'three';
import type { Entity, BuildingBlueprintId } from '../sim/types';
import { COLORS } from '@/colorsConfig';
import { getBuildingConfig } from '../sim/buildConfigs';
import { BUILD_GRID_CELL_SIZE } from '../sim/buildGrid';
import { isMetalExtractorBlueprintId } from '../../types/buildingTypes';
import type { MetalDeposit } from '@/metalDepositConfig';
import { getBuildingAuthoredRadarRadius } from '../sim/sensorCoverage';
import {
  type BuildPlacementCellDiagnostic,
  type BuildPlacementDiagnostics,
  getSnappedBuildPosition,
} from '../input/helpers';
import {
  createMetalDepositSurfaceIndex,
  METAL_DEPOSIT_COIN_TOP_LIFT,
  metalDepositCellKey,
} from './MetalDepositVisualClusters';

const GHOST_Y = 1; // hover a hair above the ground so it doesn't z-fight tiles
const TERRAIN_CELL_FILL_LIFT = 1.25;
const TERRAIN_CELL_BORDER_LIFT = 1.38;
const METAL_DEPOSIT_CELL_FILL_LIFT = 7.5;
const METAL_DEPOSIT_CELL_BORDER_LIFT = 7.82;
const RANGE_Y = 0.6;
type GroundHeightLookup = (x: number, y: number) => number;

type CellMaterialPair = {
  fill: THREE.MeshBasicMaterial;
  border: THREE.LineBasicMaterial;
};

type BuildAbilitySquareCell = {
  x: number;
  y: number;
  gx?: number;
  gy?: number;
  metalCovered?: boolean;
  depositId?: number | null;
};

type BuildAbilitySquarePose = {
  x: number;
  z: number;
  xMin: number;
  xMax: number;
  zMin: number;
  zMax: number;
  fillY: number;
  borderY: number;
};

export function resolveBuildAbilitySquarePose(
  cell: BuildAbilitySquareCell,
  surfaceY: number,
): BuildAbilitySquarePose {
  const half = BUILD_GRID_CELL_SIZE / 2;
  const fillLift = cell.metalCovered ? METAL_DEPOSIT_CELL_FILL_LIFT : TERRAIN_CELL_FILL_LIFT;
  const borderLift = cell.metalCovered ? METAL_DEPOSIT_CELL_BORDER_LIFT : TERRAIN_CELL_BORDER_LIFT;
  return {
    x: cell.x,
    z: cell.y,
    xMin: cell.x - half,
    xMax: cell.x + half,
    zMin: cell.y - half,
    zMax: cell.y + half,
    fillY: surfaceY + fillLift,
    borderY: surfaceY + borderLift,
  };
}

export class BuildGhost3D {
  private world: THREE.Group;
  private getGroundHeight: GroundHeightLookup;
  /** Footprint preview group — shown only while the player is actively
   *  hovering a build target (setTarget). */
  private group = new THREE.Group();
  /** Deposit-cell overlay group — built once from the deposit list at
   *  construction, visibility flipped externally each frame. Lives outside
   *  the footprint group so it can be shown without an active build
   *  target (e.g. while DEBUG: BUILD is on). Contains one filled mesh and
   *  one border LineSegments so the on-coin marker matches the red/green
   *  fill+border look the terrain shader paints elsewhere. */
  private depositOverlayGroup = new THREE.Group();
  private depositOverlayFillGeom: THREE.BufferGeometry | null = null;
  private depositOverlayFillMat: THREE.MeshBasicMaterial | null = null;
  private depositOverlayBorderGeom: THREE.BufferGeometry | null = null;
  private depositOverlayBorderMat: THREE.LineBasicMaterial | null = null;
  private metalDepositSurfaceYByCell = new Map<string, number>();
  private metalDepositSurfaceYById = new Map<number, number>();

  /** Flat footprint rectangle (scaled to the current building blueprint). */
  private footprint: THREE.Mesh;
  /** Builder build-range circle (drawn as a thin ring). */
  private rangeRing: THREE.Mesh;
  /** Radar footprint preview shown while placing radar towers. */
  private radarRangeRing: THREE.Mesh;
  /** Warning line from builder to ghost, shown only when out of range. */
  private rangeLine: THREE.Line;
  private rangeLineGeom: THREE.BufferGeometry;
  /** Per-footprint-cell diagnostic tiles. */
  private cellGeom: THREE.PlaneGeometry;
  private cellBorderGeom: THREE.BufferGeometry;
  private cellMeshes: THREE.Mesh[] = [];
  private cellBorders: THREE.LineSegments[] = [];
  private lastTargetKey = '';
  private lastDiagnostics?: BuildPlacementDiagnostics;

  // Materials kept as fields so we can swap colors without re-creating
  // the meshes on every frame.
  private footMatOk: THREE.MeshBasicMaterial;
  private footMatBad: THREE.MeshBasicMaterial;
  private cellMatOk: THREE.MeshBasicMaterial;
  private cellMatBad: THREE.MeshBasicMaterial;
  private cellMatWarn: THREE.MeshBasicMaterial;
  private cellBorderMatOk: THREE.LineBasicMaterial;
  private cellBorderMatBad: THREE.LineBasicMaterial;
  private cellBorderMatWarn: THREE.LineBasicMaterial;
  private ringMat: THREE.MeshBasicMaterial;
  private radarRingMat: THREE.MeshBasicMaterial;
  private lineMat: THREE.LineBasicMaterial;

  // Reusable scratch arrays.
  private _linePositions = new Float32Array(6);

  constructor(
    world: THREE.Group,
    getGroundHeight: GroundHeightLookup = () => 0,
    deposits: ReadonlyArray<MetalDeposit> = [],
  ) {
    this.world = world;
    this.getGroundHeight = getGroundHeight;

    this.footMatOk = new THREE.MeshBasicMaterial({
      color: COLORS.effects.buildGhost.footprintOk.colorHex,
      transparent: true,
      opacity: COLORS.effects.buildGhost.footprintOk.opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.footMatBad = new THREE.MeshBasicMaterial({
      color: COLORS.effects.buildGhost.footprintBad.colorHex,
      transparent: true,
      opacity: COLORS.effects.buildGhost.footprintBad.opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.cellMatOk = makeBuildAbilityFillMaterial(COLORS.effects.buildGhost.cellOk.colorHex);
    this.cellMatBad = makeBuildAbilityFillMaterial(COLORS.effects.buildGhost.cellBad.colorHex);
    this.cellMatWarn = makeBuildAbilityFillMaterial(COLORS.effects.buildGhost.cellWarn.colorHex);
    this.cellBorderMatOk = makeBuildAbilityBorderMaterial(COLORS.effects.buildGhost.cellBorderOk.colorHex);
    this.cellBorderMatBad = makeBuildAbilityBorderMaterial(COLORS.effects.buildGhost.cellBorderBad.colorHex);
    this.cellBorderMatWarn = makeBuildAbilityBorderMaterial(COLORS.effects.buildGhost.cellBorderWarn.colorHex);

    // Plane geometry of unit size, scaled per-building on setTarget.
    const footGeom = new THREE.PlaneGeometry(1, 1);
    this.footprint = new THREE.Mesh(footGeom, this.footMatOk);
    this.footprint.rotation.x = -Math.PI / 2;
    this.footprint.position.y = GHOST_Y;
    this.footprint.renderOrder = 20;
    this.group.add(this.footprint);

    // Thin ring at builder build-range radius. Inner radius set to
    // just under outer so it reads as a stroke rather than a filled
    // disc.
    this.ringMat = new THREE.MeshBasicMaterial({
      color: COLORS.effects.buildGhost.rangeRing.colorHex,
      transparent: true,
      opacity: COLORS.effects.buildGhost.rangeRing.opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const ringGeom = new THREE.RingGeometry(0.985, 1.0, 64);
    this.rangeRing = new THREE.Mesh(ringGeom, this.ringMat);
    this.rangeRing.rotation.x = -Math.PI / 2;
    this.rangeRing.position.y = RANGE_Y;
    this.group.add(this.rangeRing);

    this.radarRingMat = new THREE.MeshBasicMaterial({
      color: COLORS.effects.buildGhost.radarRangeRing.colorHex,
      transparent: true,
      opacity: COLORS.effects.buildGhost.radarRangeRing.opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const radarRingGeom = new THREE.RingGeometry(0.992, 1.0, 96);
    this.radarRangeRing = new THREE.Mesh(radarRingGeom, this.radarRingMat);
    this.radarRangeRing.rotation.x = -Math.PI / 2;
    this.radarRangeRing.position.y = RANGE_Y;
    this.radarRangeRing.visible = false;
    this.group.add(this.radarRangeRing);

    // Out-of-range warning line.
    this.lineMat = new THREE.LineBasicMaterial({
      color: COLORS.effects.buildGhost.outOfRangeLine.colorHex,
      transparent: true,
      opacity: COLORS.effects.buildGhost.outOfRangeLine.opacity,
    });
    this.rangeLineGeom = new THREE.BufferGeometry();
    this.rangeLineGeom.setAttribute(
      'position',
      new THREE.BufferAttribute(this._linePositions, 3),
    );
    this.rangeLine = new THREE.Line(this.rangeLineGeom, this.lineMat);
    this.group.add(this.rangeLine);
    this.cellGeom = new THREE.PlaneGeometry(BUILD_GRID_CELL_SIZE, BUILD_GRID_CELL_SIZE);
    this.cellBorderGeom = BuildGhost3D.makeCellBorderGeometry();

    this.group.visible = false;
    this.world.add(this.group);

    this.indexMetalDepositSurfaces(deposits);
    this.buildDepositOverlay(deposits);
    this.depositOverlayGroup.visible = false;
    this.world.add(this.depositOverlayGroup);
  }

  /** Show/hide the always-built deposit-cell overlay. Driven externally
   *  so the same overlay activates for both build mode and the DEBUG:
   *  BUILD toggle. */
  setBuildGridOverlayVisible(visible: boolean): void {
    if (this.depositOverlayGroup.visible === visible) return;
    this.depositOverlayGroup.visible = visible;
  }

  /** Build one merged filled mesh + one merged border LineSegments
   *  covering every metal-deposit cell. Together they reproduce the
   *  red/green "darker fill, brighter border" look the terrain shader
   *  paints. Positions are resolved through the same square helper used
   *  by live placement diagnostics, so deposit markers and red/yellow/
   *  green buildability cells share the same clearance rules. */
  private buildDepositOverlay(deposits: ReadonlyArray<MetalDeposit>): void {
    if (deposits.length === 0) return;
    const fillPositions: number[] = [];
    const fillIndices: number[] = [];
    const borderPositions: number[] = [];
    let vertexBase = 0;
    for (const deposit of deposits) {
      for (const cell of deposit.cells) {
        const square = this.getBuildAbilitySquarePose({
          ...cell,
          metalCovered: true,
          depositId: deposit.id,
        });
        fillPositions.push(
          square.xMin, square.fillY, square.zMin,
          square.xMax, square.fillY, square.zMin,
          square.xMax, square.fillY, square.zMax,
          square.xMin, square.fillY, square.zMax,
        );
        fillIndices.push(
          vertexBase, vertexBase + 1, vertexBase + 2,
          vertexBase, vertexBase + 2, vertexBase + 3,
        );
        vertexBase += 4;
        borderPositions.push(
          square.xMin, square.borderY, square.zMin, square.xMax, square.borderY, square.zMin,
          square.xMax, square.borderY, square.zMin, square.xMax, square.borderY, square.zMax,
          square.xMax, square.borderY, square.zMax, square.xMin, square.borderY, square.zMax,
          square.xMin, square.borderY, square.zMax, square.xMin, square.borderY, square.zMin,
        );
      }
    }
    if (fillPositions.length > 0) {
      const fillGeom = new THREE.BufferGeometry();
      fillGeom.setAttribute('position', new THREE.Float32BufferAttribute(fillPositions, 3));
      fillGeom.setIndex(fillIndices);
      const fillMat = makeBuildAbilityFillMaterial(COLORS.effects.buildGhost.cellMetal.colorHex, 0.5);
      const fillMesh = new THREE.Mesh(fillGeom, fillMat);
      fillMesh.renderOrder = 32;
      this.depositOverlayGroup.add(fillMesh);
      this.depositOverlayFillGeom = fillGeom;
      this.depositOverlayFillMat = fillMat;
    }
    if (borderPositions.length > 0) {
      const borderGeom = new THREE.BufferGeometry();
      borderGeom.setAttribute('position', new THREE.Float32BufferAttribute(borderPositions, 3));
      const borderMat = makeBuildAbilityBorderMaterial(COLORS.effects.buildGhost.cellBorderMetal.colorHex);
      const borderMesh = new THREE.LineSegments(borderGeom, borderMat);
      borderMesh.renderOrder = 33;
      this.depositOverlayGroup.add(borderMesh);
      this.depositOverlayBorderGeom = borderGeom;
      this.depositOverlayBorderMat = borderMat;
    }
  }

  /** Update the ghost position + styling. Sim y maps to world z on
   *  the ground plane. Pass a freshly selected builder so the
   *  range circle + in-range check reflect the current selection.
   *  `canPlace` comes from the client-side placement validator
   *  (terrain/resource/overlap/map bounds). Builder range is drawn
   *  with the range ring/line only; it never changes the ground-cell
   *  diagnostic colors. */
  setTarget(
    buildingBlueprintId: BuildingBlueprintId,
    worldX: number,
    worldY: number,
    builder: Entity | null,
    canPlace: boolean,
    diagnostics?: BuildPlacementDiagnostics,
    rotation = 0,
  ): void {
    const snapped = getSnappedBuildPosition(worldX, worldY, buildingBlueprintId, rotation);
    const config = getBuildingConfig(buildingBlueprintId);
    const width = config.gridWidth * BUILD_GRID_CELL_SIZE;
    const depth = config.gridHeight * BUILD_GRID_CELL_SIZE;
    const builderKey = builder?.builder
      ? `${builder.id}:${builder.transform.x}:${builder.transform.y}:${builder.transform.z}:${builder.builder.buildRange}`
      : 'none';
    const targetKey = `${buildingBlueprintId}:${snapped.gridX}:${snapped.gridY}:${canPlace ? 1 : 0}:${rotation}:${builderKey}`;
    if (
      this.group.visible &&
      targetKey === this.lastTargetKey &&
      diagnostics === this.lastDiagnostics
    ) {
      return;
    }
    this.lastTargetKey = targetKey;
    this.lastDiagnostics = diagnostics;

    let inRange = true;
    if (builder?.builder) {
      const dx = snapped.x - builder.transform.x;
      const dy = snapped.y - builder.transform.y;
      inRange = Math.hypot(dx, dy) <= builder.builder.buildRange;
    }

    const okVisually = canPlace;
    const targetGroundY = this.getGroundHeight(snapped.x, snapped.y);
    this.footprint.scale.set(width, depth, 1);
    this.footprint.rotation.set(-Math.PI / 2, 0, -rotation);
    this.footprint.position.set(snapped.x, targetGroundY + GHOST_Y, snapped.y);
    this.footprint.material = okVisually ? this.footMatOk : this.footMatBad;
    const isExtractor = isMetalExtractorBlueprintId(buildingBlueprintId);
    this.footprint.visible = !this.updateDiagnosticCells(diagnostics, isExtractor);

    const radarRadius = getBuildingAuthoredRadarRadius(buildingBlueprintId);
    if (radarRadius > 0) {
      this.radarRangeRing.visible = true;
      this.radarRangeRing.position.set(snapped.x, targetGroundY + RANGE_Y, snapped.y);
      this.radarRangeRing.scale.set(radarRadius, radarRadius, 1);
    } else {
      this.radarRangeRing.visible = false;
    }

    if (builder?.builder) {
      const builderGroundY = this.getGroundHeight(builder.transform.x, builder.transform.y);
      const ringY = builderGroundY + RANGE_Y;
      this.rangeRing.visible = true;
      this.rangeRing.position.set(builder.transform.x, ringY, builder.transform.y);
      const r = builder.builder.buildRange;
      this.rangeRing.scale.set(r, r, 1);

      this.rangeLine.visible = !inRange;
      if (!inRange) {
        this._linePositions[0] = builder.transform.x;
        this._linePositions[1] = ringY;
        this._linePositions[2] = builder.transform.y;
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
    this.lastTargetKey = '';
    this.lastDiagnostics = undefined;
  }

  private static makeCellBorderGeometry(): THREE.BufferGeometry {
    const h = BUILD_GRID_CELL_SIZE / 2;
    const positions = new Float32Array([
      -h, -h, 0, h, -h, 0,
      h, -h, 0, h, h, 0,
      h, h, 0, -h, h, 0,
      -h, h, 0, -h, -h, 0,
    ]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return geometry;
  }

  private materialForCell(
    cell: BuildPlacementCellDiagnostic,
    isExtractor: boolean,
  ): CellMaterialPair {
    if (cell.blocking) return { fill: this.cellMatBad, border: this.cellBorderMatBad };
    // "Can build but shouldn't": extractor placed on bare ground (no
    // resource) or a non-extractor placed on a deposit (wastes the
    // deposit). Both read as yellow so the player can still place the
    // building but is warned the choice is suboptimal.
    if (cell.reason === 'empty' || (cell.metalCovered && !isExtractor)) {
      return { fill: this.cellMatWarn, border: this.cellBorderMatWarn };
    }
    return { fill: this.cellMatOk, border: this.cellBorderMatOk };
  }

  private indexMetalDepositSurfaces(deposits: ReadonlyArray<MetalDeposit>): void {
    const surfaceIndex = createMetalDepositSurfaceIndex(deposits);
    this.metalDepositSurfaceYByCell = surfaceIndex.surfaceYByCell;
    this.metalDepositSurfaceYById = surfaceIndex.surfaceYById;
  }

  private getBuildAbilitySquarePose(cell: BuildAbilitySquareCell): BuildAbilitySquarePose {
    const surfaceY = this.getBuildAbilitySquareSurfaceY(cell);
    return resolveBuildAbilitySquarePose(cell, surfaceY);
  }

  private getBuildAbilitySquareSurfaceY(cell: BuildAbilitySquareCell): number {
    const terrainY = this.getGroundHeight(cell.x, cell.y);
    if (!cell.metalCovered) return terrainY;

    let depositSurfaceY: number | undefined;
    if (cell.gx !== undefined && cell.gy !== undefined) {
      depositSurfaceY = this.metalDepositSurfaceYByCell.get(metalDepositCellKey(cell.gx, cell.gy));
    }
    if (depositSurfaceY === undefined && cell.depositId !== undefined && cell.depositId !== null) {
      depositSurfaceY = this.metalDepositSurfaceYById.get(cell.depositId);
    }
    if (depositSurfaceY === undefined) {
      depositSurfaceY = terrainY + METAL_DEPOSIT_COIN_TOP_LIFT;
    }
    return Math.max(terrainY, depositSurfaceY);
  }

  private updateDiagnosticCells(
    diagnostics: BuildPlacementDiagnostics | undefined,
    isExtractor: boolean,
  ): boolean {
    const cells = diagnostics?.cells ?? [];
    while (this.cellMeshes.length < cells.length) {
      const mesh = new THREE.Mesh(this.cellGeom, this.cellMatOk);
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = 30;
      this.group.add(mesh);
      this.cellMeshes.push(mesh);

      const border = new THREE.LineSegments(this.cellBorderGeom, this.cellBorderMatOk);
      border.rotation.x = -Math.PI / 2;
      border.renderOrder = 31;
      this.group.add(border);
      this.cellBorders.push(border);
    }

    for (let i = 0; i < this.cellMeshes.length; i++) {
      const mesh = this.cellMeshes[i];
      const border = this.cellBorders[i];
      const cell = cells[i];
      if (!cell) {
        mesh.visible = false;
        if (border) border.visible = false;
        continue;
      }
      const square = this.getBuildAbilitySquarePose(cell);
      mesh.position.set(square.x, square.fillY, square.z);
      const materials = this.materialForCell(cell, isExtractor);
      mesh.material = materials.fill;
      mesh.visible = true;
      if (border) {
        border.position.set(square.x, square.borderY, square.z);
        border.material = materials.border;
        border.visible = true;
      }
    }
    return cells.length > 0;
  }

  destroy(): void {
    this.world.remove(this.group);
    this.world.remove(this.depositOverlayGroup);
    (this.footprint.geometry as THREE.BufferGeometry).dispose();
    (this.rangeRing.geometry as THREE.BufferGeometry).dispose();
    (this.radarRangeRing.geometry as THREE.BufferGeometry).dispose();
    this.cellGeom.dispose();
    this.cellBorderGeom.dispose();
    this.rangeLineGeom.dispose();
    this.depositOverlayFillGeom?.dispose();
    this.depositOverlayFillMat?.dispose();
    this.depositOverlayBorderGeom?.dispose();
    this.depositOverlayBorderMat?.dispose();
    this.footMatOk.dispose();
    this.footMatBad.dispose();
    this.cellMatOk.dispose();
    this.cellMatBad.dispose();
    this.cellMatWarn.dispose();
    this.cellBorderMatOk.dispose();
    this.cellBorderMatBad.dispose();
    this.cellBorderMatWarn.dispose();
    this.ringMat.dispose();
    this.radarRingMat.dispose();
    this.lineMat.dispose();
  }
}

function makeBuildAbilityFillMaterial(color: number, opacity = 1): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: opacity < 1,
    opacity,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

function makeBuildAbilityBorderMaterial(color: number): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color,
    transparent: false,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}
