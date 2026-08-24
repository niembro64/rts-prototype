// BuildGhost3D — translucent footprint preview for build mode in the
// 3D scene. Ground-cell colors describe placement/resource facts:
// green = buildable, red = blocked, yellow = buildable but suboptimal
// (extractor off a deposit, or a non-extractor placed on a deposit).
// Every footprint cell is anchored to the actual terrain mesh. That includes
// the seabed for water-surface structures and the terrain pad beneath raised
// metal-deposit crowns. Builder range is shown separately because the builder
// can move to the site.
//
// The whole-map BUILD availability modes are not drawn here. They are baked
// directly onto the terrain by TerrainTileRenderer3D so they conform to the
// ground/bed instead of jumping to water or raised prop surfaces.
//
// Ownership: Input3DManager drives the footprint preview (setTarget on
// mouse move, hide on mode exit). Everything is parented to the world
// group so it tracks camera pan/orbit naturally.

import * as THREE from 'three';
import type { Entity, BuildingBlueprintId } from '../sim/types';
import { COLORS } from '@/colorsConfig';
import { getBuildingConfig } from '../sim/buildConfigs';
import {
  BUILD_GRID_CELL_SIZE,
  getRotatedBuildingPlacementFootprint,
} from '../sim/buildGrid';
import {
  getBuildingPlacementAnchor,
  isMetalExtractorBlueprintId,
} from '../../types/buildingTypes';
import {
  getBuildingPlacementBaseZ,
  getHighestBuildFootprintCellsGroundZ,
} from '../sim/buildingPlacementPolicy';
import { createBuildingRuntimeTurrets } from '../sim/runtimeTurrets';
import { getTurretHeadRadius } from '../math';
import {
  isBuildingAimPieceAttachment,
  isBuildingHostPieceAttachment,
  selectBuildingHostPieceTurretIndex,
} from '../math/BuildingHostSocketGeometry';
import {
  getBuildingAuthoredContactSightRadius,
  getBuildingAuthoredFullSightRadius,
  getBuildingAuthoredJammerRadius,
  getSensorMediumAtZ,
} from '../sim/sensorCoverage';
import {
  getBuildingAuthoredShieldBarrierRadius,
  getBuildingAuthoredWeaponRangeRadius,
} from '../sim/buildingBlueprintRanges';
import {
  type BuildPlacementCellDiagnostic,
  type BuildPlacementDiagnostics,
  getSnappedBuildPosition,
} from '../input/helpers';
import type { OverlayLineSystem } from './OverlayLineSystem';
import { GroundRing3D } from './GroundRing3D';
import { GroundLineBatch3D } from './GroundLineBatch3D';
import { hexToRgb01 } from './colorUtils';
import { buildBuildingShape } from './BuildingShape3D';
import { buildTurretMesh3D } from './TurretMesh3D';
import { getGraphicsConfig } from '@/clientBarConfig';

const GHOST_Y = 1; // hover a hair above the ground so it doesn't z-fight tiles
const CELL_FILL_LIFT = 1.25;
const CELL_BORDER_LIFT = 1.38;
const RANGE_Y = 0.6;
type GroundHeightLookup = (x: number, y: number) => number;

const BUILDING_MODEL_NAME = 'build-ghost-building-model';
const BUILDING_PRIMARY_NAME = 'build-ghost-building-primary';
const BUILDING_MODEL_RENDER_ORDER = 25;
const BUILDING_GHOST_DETAIL_LEVEL = 1;

type BuildGhostBuildingModel = {
  blueprintId: BuildingBlueprintId;
  root: THREE.Group;
  meshes: THREE.Mesh[];
  authoredYaw: number;
};

type CellMaterialPair = {
  fill: THREE.MeshBasicMaterial;
  border: THREE.LineBasicMaterial;
};

type BuildAbilitySquareCell = {
  x: number;
  y: number;
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
  return {
    x: cell.x,
    z: cell.y,
    xMin: cell.x - half,
    xMax: cell.x + half,
    zMin: cell.y - half,
    zMax: cell.y + half,
    fillY: surfaceY + CELL_FILL_LIFT,
    borderY: surfaceY + CELL_BORDER_LIFT,
  };
}

export class BuildGhost3D {
  private world: THREE.Group;
  private getGroundHeight: GroundHeightLookup;
  private getSurfaceHeight: GroundHeightLookup;
  /** Footprint preview group — shown only while the player is actively
   *  hovering a build target (setTarget). */
  private group = new THREE.Group();
  /** Flat footprint rectangle (scaled to the current building blueprint). */
  private footprint: THREE.Mesh;
  /** BAR-style translucent copy of the actual building silhouette. It is
   *  rebuilt only when the selected blueprint changes; pointer motion and
   *  facing changes update the retained root transform. */
  private buildingModel: BuildGhostBuildingModel | null = null;
  /** Builder build-range circle — unified screen-space ground ring. */
  private readonly buildRing: GroundRing3D;
  /** Contact-sensor footprint preview shown while placing radar/sonar. */
  private readonly radarRing: GroundRing3D;
  /** Blueprint-authored radii shown while choosing a site (BAR shows the
   *  same set during placement): weapon reach, full sight, jammer reach,
   *  and the shield-sphere barrier. Each hides itself at radius 0. */
  private readonly weaponRing: GroundRing3D;
  private readonly sightRing: GroundRing3D;
  private readonly jammerRing: GroundRing3D;
  private readonly shieldRing: GroundRing3D;
  /** Warning line from builder to ghost, shown only when out of range. */
  private readonly rangeLineBatch: GroundLineBatch3D;
  private readonly rangeLineWidthPx: number;
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
  private buildingMatOk: THREE.MeshBasicMaterial;
  private buildingMatBad: THREE.MeshBasicMaterial;
  private cellMatOk: THREE.MeshBasicMaterial;
  private cellMatBad: THREE.MeshBasicMaterial;
  private cellMatWarn: THREE.MeshBasicMaterial;
  private cellBorderMatOk: THREE.LineBasicMaterial;
  private cellBorderMatBad: THREE.LineBasicMaterial;
  private cellBorderMatWarn: THREE.LineBasicMaterial;
  private readonly outOfRangeColor: { r: number; g: number; b: number };
  private readonly outOfRangeAlpha: number;
  private readonly turretHeadGeom = new THREE.SphereGeometry(1, 16, 10);
  private readonly turretBarrelGeom = new THREE.CylinderGeometry(1, 1, 1, 10, 1, false);
  private readonly turretConeBarrelGeom = new THREE.CylinderGeometry(0, 1, 1, 10, 1, false);

  constructor(
    world: THREE.Group,
    overlayLines: OverlayLineSystem,
    getGroundHeight: GroundHeightLookup = () => 0,
    getSurfaceHeight: GroundHeightLookup = getGroundHeight,
  ) {
    this.world = world;
    this.getGroundHeight = getGroundHeight;
    this.getSurfaceHeight = getSurfaceHeight;
    this.buildRing = new GroundRing3D(overlayLines, 'build', 64);
    this.radarRing = new GroundRing3D(overlayLines, 'radar', 96);
    this.weaponRing = new GroundRing3D(overlayLines, 'rangeEngage', 96);
    this.sightRing = new GroundRing3D(overlayLines, 'sight', 96);
    this.jammerRing = new GroundRing3D(overlayLines, 'radar', 96);
    this.shieldRing = new GroundRing3D(overlayLines, 'rangeEngage', 96);
    this.rangeLineWidthPx = overlayLines.style('build').widthPx;
    this.rangeLineBatch = overlayLines.createBatch('build', 2);
    const outOfRange = COLORS.effects.buildGhost.outOfRangeLine;
    this.outOfRangeColor = hexToRgb01(outOfRange.colorHex);
    this.outOfRangeAlpha = outOfRange.opacity;

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
    this.buildingMatOk = makeBuildGhostBuildingMaterial(
      COLORS.effects.buildGhost.footprintOk.colorHex,
      COLORS.effects.buildGhost.footprintOk.opacity,
    );
    this.buildingMatBad = makeBuildGhostBuildingMaterial(
      COLORS.effects.buildGhost.footprintBad.colorHex,
      COLORS.effects.buildGhost.footprintBad.opacity,
    );
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

    // Builder build-range circle, radar preview circle, and out-of-range
    // warning line — all unified screen-space ground overlays under the ghost
    // group (so build-mode exit hides them with the group).
    this.group.add(this.buildRing.mesh);
    this.group.add(this.radarRing.mesh);
    this.group.add(this.weaponRing.mesh);
    this.group.add(this.sightRing.mesh);
    this.group.add(this.jammerRing.mesh);
    this.group.add(this.shieldRing.mesh);
    this.group.add(this.rangeLineBatch.mesh);
    this.cellGeom = new THREE.PlaneGeometry(BUILD_GRID_CELL_SIZE, BUILD_GRID_CELL_SIZE);
    this.cellBorderGeom = BuildGhost3D.makeCellBorderGeometry();

    this.group.visible = false;
    this.world.add(this.group);
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
    const model = this.ensureBuildingModel(buildingBlueprintId);
    const placementBaseY = this.getBuildingModelBaseY(
      buildingBlueprintId,
      snapped.gridX,
      snapped.gridY,
      snapped.x,
      snapped.y,
      rotation,
    );
    model.root.position.set(snapped.x, placementBaseY, snapped.y);
    model.root.rotation.y = -rotation + model.authoredYaw;
    model.root.visible = true;
    const modelMaterial = okVisually ? this.buildingMatOk : this.buildingMatBad;
    for (let i = 0; i < model.meshes.length; i++) {
      model.meshes[i].material = modelMaterial;
    }
    this.footprint.scale.set(width, depth, 1);
    this.footprint.rotation.set(-Math.PI / 2, 0, -rotation);
    this.footprint.position.set(snapped.x, targetGroundY + GHOST_Y, snapped.y);
    this.footprint.material = okVisually ? this.footMatOk : this.footMatBad;
    const isExtractor = isMetalExtractorBlueprintId(buildingBlueprintId);
    this.footprint.visible = !this.updateDiagnosticCells(diagnostics, isExtractor);

    const sourceMedium = getSensorMediumAtZ(targetGroundY);
    const contactRadius = Math.max(
      getBuildingAuthoredContactSightRadius(
        buildingBlueprintId,
        sourceMedium,
        'aboveWater',
      ),
      getBuildingAuthoredContactSightRadius(
        buildingBlueprintId,
        sourceMedium,
        'underwater',
      ),
    );
    this.setBlueprintRing(
      this.radarRing, snapped.x, snapped.y, contactRadius,
      COLORS.effects.buildGhost.radarRangeRing,
    );

    // The rest of the blueprint's authored radii, so a placement decision can
    // see everything the site would cover (BAR shows the same set while
    // placing: weapon range, LOS, jammer, shield).
    this.setBlueprintRing(
      this.weaponRing, snapped.x, snapped.y,
      getBuildingAuthoredWeaponRangeRadius(buildingBlueprintId),
      COLORS.effects.buildGhost.weaponRangeRing,
    );
    const sightRadius = Math.max(
      getBuildingAuthoredFullSightRadius(buildingBlueprintId, sourceMedium, 'aboveWater'),
      getBuildingAuthoredFullSightRadius(buildingBlueprintId, sourceMedium, 'underwater'),
    );
    this.setBlueprintRing(
      this.sightRing, snapped.x, snapped.y, sightRadius,
      COLORS.effects.buildGhost.sightRangeRing,
    );
    this.setBlueprintRing(
      this.jammerRing, snapped.x, snapped.y,
      getBuildingAuthoredJammerRadius(buildingBlueprintId),
      COLORS.effects.buildGhost.jammerRangeRing,
    );
    this.setBlueprintRing(
      this.shieldRing, snapped.x, snapped.y,
      getBuildingAuthoredShieldBarrierRadius(buildingBlueprintId),
      COLORS.effects.buildGhost.shieldRangeRing,
    );

    this.rangeLineBatch.begin();
    if (builder?.builder) {
      const c = hexToRgb01(COLORS.effects.buildGhost.rangeRing.colorHex);
      this.buildRing.set(
        builder.transform.x, 0, builder.transform.y, builder.builder.buildRange,
        c.r, c.g, c.b, COLORS.effects.buildGhost.rangeRing.opacity,
        this.getGroundHeight,
      );
      if (!inRange) {
        const builderY = this.getGroundHeight(builder.transform.x, builder.transform.y) + RANGE_Y;
        this.rangeLineBatch.pushSegment(
          builder.transform.x, builderY, builder.transform.y,
          snapped.x, targetGroundY + RANGE_Y, snapped.y,
          this.outOfRangeColor.r, this.outOfRangeColor.g, this.outOfRangeColor.b, this.outOfRangeAlpha,
          this.rangeLineWidthPx,
        );
      }
    } else {
      this.buildRing.hide();
    }
    this.rangeLineBatch.finishFrame();

    this.group.visible = true;
  }

  hide(): void {
    this.group.visible = false;
    this.lastTargetKey = '';
    this.lastDiagnostics = undefined;
  }

  private ensureBuildingModel(
    buildingBlueprintId: BuildingBlueprintId,
  ): BuildGhostBuildingModel {
    if (this.buildingModel?.blueprintId === buildingBlueprintId) {
      return this.buildingModel;
    }
    if (this.buildingModel !== null) {
      this.group.remove(this.buildingModel.root);
    }

    const config = getBuildingConfig(buildingBlueprintId);
    const width = config.gridWidth * BUILD_GRID_CELL_SIZE;
    const depth = config.gridHeight * BUILD_GRID_CELL_SIZE;
    const shape = buildBuildingShape(
      config.renderProfile,
      width,
      depth,
      this.buildingMatOk,
      buildingBlueprintId,
      'close',
    );
    const root = new THREE.Group();
    root.name = BUILDING_MODEL_NAME;
    root.userData.buildingBlueprintId = buildingBlueprintId;
    root.userData.localWidth = width;
    root.userData.localDepth = depth;

    const chassis = new THREE.Group();
    shape.primary.name = BUILDING_PRIMARY_NAME;
    if (shape.bodyless === true) {
      shape.primary.visible = false;
    } else {
      shape.primary.scale.set(width, shape.height, depth);
      shape.primary.position.set(0, shape.height * 0.5, 0);
    }
    chassis.add(shape.primary);
    root.add(chassis);

    const turrets = createBuildingRuntimeTurrets(buildingBlueprintId);
    root.userData.turretCount = turrets.length;
    const hostPieces: {
      pieceId: string;
      root: THREE.Group;
      pitchRoot?: THREE.Group;
    }[] = [];
    for (const piece of shape.turretHostPieces ?? []) {
      const turretIndex = selectBuildingHostPieceTurretIndex(turrets, piece.pieceId);
      if (turretIndex < 0) continue;
      const turret = turrets[turretIndex];
      piece.root.position.set(turret.mount.x, turret.mount.z, turret.mount.y);
      root.add(piece.root);
      hostPieces.push(piece);
    }

    for (const detail of shape.details) {
      const hostPiece = detail.hostPieceId === undefined
        ? undefined
        : hostPieces.find((piece) => piece.pieceId === detail.hostPieceId);
      (hostPiece?.pitchRoot ?? hostPiece?.root ?? root).add(detail.mesh);
    }

    const gfx = getGraphicsConfig();
    for (let i = 0; i < turrets.length; i++) {
      const turret = turrets[i];
      const attachment = turret.config.hostAttachment;
      const hostPiece = isBuildingHostPieceAttachment(attachment)
        ? hostPieces.find((piece) => piece.pieceId === attachment.piece)
        : undefined;
      const turretMesh = buildTurretMesh3D(
        hostPiece?.pitchRoot ?? hostPiece?.root ?? root,
        turret,
        gfx,
        {
          headGeom: this.turretHeadGeom,
          barrelGeom: this.turretBarrelGeom,
          coneBarrelGeom: this.turretConeBarrelGeom,
          primaryMat: this.buildingMatOk,
          barrelMat: this.buildingMatOk,
          shieldEmitterMat: this.buildingMatOk,
          detailLevel: BUILDING_GHOST_DETAIL_LEVEL,
          hideHead: isBuildingAimPieceAttachment(attachment),
        },
      );
      const headRadius = turretMesh.headRadius ?? getTurretHeadRadius(turret.presentation);
      const mount = hostPiece !== undefined && isBuildingHostPieceAttachment(attachment)
        ? attachment.socketOffset
        : turret.mount;
      turretMesh.root.position.set(mount.x, mount.z - headRadius, mount.y);
      turretMesh.root.visible = true;
    }

    const meshes: THREE.Mesh[] = [];
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.material = this.buildingMatOk;
      object.renderOrder = BUILDING_MODEL_RENDER_ORDER;
      meshes.push(object);
    });
    this.group.add(root);
    this.buildingModel = {
      blueprintId: buildingBlueprintId,
      root,
      meshes,
      authoredYaw: shape.authoredYaw ?? 0,
    };
    return this.buildingModel;
  }

  /** Match construction.ts exactly: terrain-bed and sea-surface buildings
   *  use their authored anchor, while hover hosts sit on the highest sampled
   *  surface beneath the rotated authored footprint. */
  private getBuildingModelBaseY(
    buildingBlueprintId: BuildingBlueprintId,
    gridX: number,
    gridY: number,
    worldX: number,
    worldY: number,
    rotation: number,
  ): number {
    const config = getBuildingConfig(buildingBlueprintId);
    const anchor = getBuildingPlacementAnchor(config.placementSets);
    if (anchor === 'hover-surface') {
      return getHighestBuildFootprintCellsGroundZ(
        gridX,
        gridY,
        getRotatedBuildingPlacementFootprint(config.placementFootprint, rotation),
        this.getSurfaceHeight,
      );
    }
    return getBuildingPlacementBaseZ(
      anchor,
      config.gridDepth * BUILD_GRID_CELL_SIZE,
      worldX,
      worldY,
      this.getSurfaceHeight,
      this.getGroundHeight,
    );
  }

  /** Terrain-draped ring at the snapped ghost site; radius 0 hides it. */
  private setBlueprintRing(
    ring: GroundRing3D,
    worldX: number,
    worldY: number,
    radius: number,
    color: { colorHex: number; opacity: number },
  ): void {
    if (radius <= 0) {
      ring.hide();
      return;
    }
    const c = hexToRgb01(color.colorHex);
    ring.set(worldX, 0, worldY, radius, c.r, c.g, c.b, color.opacity, this.getGroundHeight);
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

  private getBuildAbilitySquarePose(cell: BuildAbilitySquareCell): BuildAbilitySquarePose {
    return resolveBuildAbilitySquarePose(cell, this.getGroundHeight(cell.x, cell.y));
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
    (this.footprint.geometry as THREE.BufferGeometry).dispose();
    this.buildRing.dispose();
    this.radarRing.dispose();
    this.weaponRing.dispose();
    this.sightRing.dispose();
    this.jammerRing.dispose();
    this.shieldRing.dispose();
    this.rangeLineBatch.dispose();
    this.cellGeom.dispose();
    this.cellBorderGeom.dispose();
    this.turretHeadGeom.dispose();
    this.turretBarrelGeom.dispose();
    this.turretConeBarrelGeom.dispose();
    this.footMatOk.dispose();
    this.footMatBad.dispose();
    this.buildingMatOk.dispose();
    this.buildingMatBad.dispose();
    this.cellMatOk.dispose();
    this.cellMatBad.dispose();
    this.cellMatWarn.dispose();
    this.cellBorderMatOk.dispose();
    this.cellBorderMatBad.dispose();
    this.cellBorderMatWarn.dispose();
  }
}

function makeBuildGhostBuildingMaterial(
  color: number,
  opacity: number,
): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

// Footprint cells follow natural depth occlusion (nearer geometry hides
// them) — depthTest on, depthWrite off so they layer over terrain without
// z-fighting (the small per-cell lift plus polygonOffset keep them clear).
function makeBuildAbilityFillMaterial(color: number, opacity = 1): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: opacity < 1,
    opacity,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

function makeBuildAbilityBorderMaterial(color: number): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color,
    transparent: false,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });
}
