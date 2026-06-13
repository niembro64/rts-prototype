import * as THREE from 'three';
import {
  anyRangeToggleActive,
  anyUnitRadiusToggleActive,
  getRangeToggle,
  getUnitRadiusToggle,
} from '@/clientBarConfig';
import { COLORS } from '@/colorsConfig';
import { LAND_CELL_SIZE } from '../../config';
import type { Entity } from '../sim/types';
import { isConstructionPieceMaterialized } from '../sim/buildableHelpers';
import type { ClientViewState } from '../network/ClientViewState';
import { getSurfaceHeight, getSurfaceNormal } from '../sim/Terrain';
import { getUnitBodyCenterHeight, getUnitGroundZ } from '../sim/unitGeometry';
import { isUnitGroundPenetrationInContact } from '../sim/unitGroundPhysics';
import { getTurretWorldMount } from '../math/MountGeometry';
import { getTransformCosSin } from '../math';
import { getTurretMountHeight } from '../sim/combat/combatUtils';
import {
  createWorldSupportSurface,
} from '../sim/supportSurface';
import { GAME_DIAGNOSTICS, debugLog } from '../diagnostics';
import { getEntityRadarRadius } from '../sim/sensorCoverage';
import { getBuildingConfig } from '../sim/buildConfigs';
import { isReclaimableTarget } from '../sim/reclaim';
import type { TurretMesh } from './TurretMesh3D';
import type { EntityMesh, RangeRingMesh, RadiusRingMeshes } from './EntityMesh3D';
import { sampleLocomotionSupportSurface } from './LocomotionTerrainSampler';
import {
  createClosedRibbonGeometry,
  writeCircleRibbonGeometry,
  type ClosedRibbonGeometry,
} from './GroundCircleLine3D';

const RANGE_CIRCLE_SEGMENTS = 96;
const RANGE_CIRCLE_GROUND_LIFT = 6;
const RANGE_CIRCLE_RENDER_ORDER = 20;
const RADIUS_SPHERE_RENDER_ORDER = RANGE_CIRCLE_RENDER_ORDER + 2;
const FLAT_SURFACE_NORMAL = { nx: 0, ny: 0, nz: 1 };
const SUPPORT_DIAGNOSTIC_LOG_INTERVAL_MS = 500;

export type OverlayEntityMesh = Pick<
  EntityMesh,
  | 'group'
  | 'turrets'
  | 'ring'
  | 'radiusRings'
  | 'radiusRingsVisible'
  | 'buildRing'
  | 'radarRing'
  | 'reclaimRing'
  | 'rangeRingsVisible'
>;

function makeRangeCircleMaterial(color: number, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
  });
}

export class SelectionOverlayRenderer3D {
  private readonly world: THREE.Group;
  private readonly clientViewState: ClientViewState;
  private readonly radiusSphereGeom: THREE.BufferGeometry;
  private readonly supportDiagnosticSurface = createWorldSupportSurface();
  private readonly supportDiagnosticNextLogAtMs = new Map<number, number>();
  private showTrackAcquire = false;
  private showTrackRelease = false;
  private showEngageAcquire = false;
  private showEngageRelease = false;
  private showEngageMinAcquire = false;
  private showEngageMinRelease = false;
  private showBuild = false;
  private showReclaimTargets = false;
  private showVisualRadius = false;
  private showHitboxRadius = false;
  private showCollisionRadius = false;
  private showShotArmingRadius = false;
  private showAnyRange = false;
  private showAnyUnitRadius = false;
  private selectedCount = 0;
  private rangeStateKey = '';
  private rangeStateVersion = 0;
  private unitOverlayStateKey = '';
  private unitOverlayStateVersion = 0;

  private readonly ringGeom = new THREE.TorusGeometry(1.0, 0.06, 8, 36);
  private readonly radiusMatVisual = new THREE.LineBasicMaterial({
    color: COLORS.effects.selectionOverlay.radiusVisual.colorHex,
    transparent: true,
    opacity: COLORS.effects.selectionOverlay.radiusVisual.opacity,
    depthWrite: false,
    depthTest: false,
  });
  private readonly radiusMatHitbox = new THREE.LineBasicMaterial({
    color: COLORS.effects.selectionOverlay.radiusHitbox.colorHex,
    transparent: true,
    opacity: COLORS.effects.selectionOverlay.radiusHitbox.opacity,
    depthWrite: false,
    depthTest: false,
  });
  private readonly radiusMatCollision = new THREE.LineBasicMaterial({
    color: COLORS.effects.selectionOverlay.radiusCollision.colorHex,
    transparent: true,
    opacity: COLORS.effects.selectionOverlay.radiusCollision.opacity,
    depthWrite: false,
    depthTest: false,
  });
  private readonly radiusMatShotArming = new THREE.LineBasicMaterial({
    color: COLORS.effects.selectionOverlay.radiusShotArming.colorHex,
    transparent: true,
    opacity: COLORS.effects.selectionOverlay.radiusShotArming.opacity,
    depthWrite: false,
    depthTest: false,
  });
  private readonly ringMatTrackAcquire = makeRangeCircleMaterial(
    COLORS.effects.selectionOverlay.trackAcquire.colorHex,
    COLORS.effects.selectionOverlay.trackAcquire.opacity,
  );
  private readonly ringMatTrackRelease = makeRangeCircleMaterial(
    COLORS.effects.selectionOverlay.trackRelease.colorHex,
    COLORS.effects.selectionOverlay.trackRelease.opacity,
  );
  private readonly ringMatEngageAcquire = makeRangeCircleMaterial(
    COLORS.effects.selectionOverlay.engageAcquire.colorHex,
    COLORS.effects.selectionOverlay.engageAcquire.opacity,
  );
  private readonly ringMatEngageRelease = makeRangeCircleMaterial(
    COLORS.effects.selectionOverlay.engageRelease.colorHex,
    COLORS.effects.selectionOverlay.engageRelease.opacity,
  );
  private readonly ringMatEngageMinAcquire = makeRangeCircleMaterial(
    COLORS.effects.selectionOverlay.engageMinAcquire.colorHex,
    COLORS.effects.selectionOverlay.engageMinAcquire.opacity,
  );
  private readonly ringMatEngageMinRelease = makeRangeCircleMaterial(
    COLORS.effects.selectionOverlay.engageMinRelease.colorHex,
    COLORS.effects.selectionOverlay.engageMinRelease.opacity,
  );
  private readonly ringMatBuild = makeRangeCircleMaterial(
    COLORS.effects.selectionOverlay.build.colorHex,
    COLORS.effects.selectionOverlay.build.opacity,
  );
  private readonly ringMatRadar = makeRangeCircleMaterial(
    COLORS.effects.selectionOverlay.radar.colorHex,
    COLORS.effects.selectionOverlay.radar.opacity,
  );
  private readonly ringMatReclaim = makeRangeCircleMaterial(
    COLORS.ui.actionColors.reclaim.colorHex,
    0.6,
  );
  private readonly selectionRingMat = new THREE.MeshLambertMaterial({
    color: COLORS.effects.selectionOverlay.selectionRing.colorHex,
    emissive: COLORS.effects.selectionOverlay.selectionRing.emissiveHex,
    transparent: true,
    opacity: COLORS.effects.selectionOverlay.selectionRing.opacity,
    depthWrite: false,
    depthTest: false,
  });

  constructor(options: {
    world: THREE.Group;
    clientViewState: ClientViewState;
    radiusSphereGeom: THREE.BufferGeometry;
  }) {
    this.world = options.world;
    this.clientViewState = options.clientViewState;
    this.radiusSphereGeom = options.radiusSphereGeom;
    this.beginFrame();
  }

  beginFrame(options: { reclaimTargets?: boolean } = {}): void {
    this.showTrackAcquire = getRangeToggle('trackAcquire');
    this.showTrackRelease = getRangeToggle('trackRelease');
    this.showEngageAcquire = getRangeToggle('engageAcquire');
    this.showEngageRelease = getRangeToggle('engageRelease');
    this.showEngageMinAcquire = getRangeToggle('engageMinAcquire');
    this.showEngageMinRelease = getRangeToggle('engageMinRelease');
    this.showBuild = getRangeToggle('build');
    this.showReclaimTargets = options.reclaimTargets === true;
    this.showVisualRadius = getUnitRadiusToggle('visual');
    this.showHitboxRadius = getUnitRadiusToggle('hitbox');
    this.showCollisionRadius = getUnitRadiusToggle('collision');
    this.showShotArmingRadius = getUnitRadiusToggle('shotArmingRadius');
    this.showAnyRange = anyRangeToggleActive();
    this.showAnyUnitRadius = anyUnitRadiusToggleActive();
    this.selectedCount = this.clientViewState.getSelectedIds().size;
    const nextRangeStateKey = [
      this.showTrackAcquire,
      this.showTrackRelease,
      this.showEngageAcquire,
      this.showEngageRelease,
      this.showEngageMinAcquire,
      this.showEngageMinRelease,
      this.showBuild,
      this.showReclaimTargets,
    ].join('|');
    if (nextRangeStateKey !== this.rangeStateKey) {
      this.rangeStateKey = nextRangeStateKey;
      this.rangeStateVersion++;
    }
    const nextUnitOverlayStateKey = [
      nextRangeStateKey,
      this.showVisualRadius,
      this.showHitboxRadius,
      this.showCollisionRadius,
      this.showShotArmingRadius,
      this.selectedCount,
    ].join('|');
    if (nextUnitOverlayStateKey !== this.unitOverlayStateKey) {
      this.unitOverlayStateKey = nextUnitOverlayStateKey;
      this.unitOverlayStateVersion++;
    }
  }

  getRangeStateVersion(): number {
    return this.rangeStateVersion;
  }

  getUnitOverlayStateVersion(): number {
    return this.unitOverlayStateVersion;
  }

  unitStaticOverlaysNeedUpdate(m: OverlayEntityMesh, selected: boolean): boolean {
    return (
      selected ||
      m.ring !== undefined ||
      this.showAnyUnitRadius ||
      m.radiusRingsVisible === true
    );
  }

  unitRangeOverlaysNeedUpdate(m: OverlayEntityMesh, selected: boolean): boolean {
    return (
      this.showAnyRange ||
      this.showReclaimTargets ||
      m.rangeRingsVisible === true ||
      (selected && this.selectedCount === 1)
    );
  }

  buildingRangeOverlaysNeedUpdate(
    m: OverlayEntityMesh,
    entity: Entity,
    selected: boolean,
  ): boolean {
    return (
      m.rangeRingsVisible === true ||
      this.showReclaimTargets ||
      this.showAnyRange ||
      (selected && getEntityRadarRadius(entity) > 0)
    );
  }

  updateSelectionRing(m: OverlayEntityMesh, selected: boolean, radius: number): void {
    if (selected && !m.ring) {
      const ring = new THREE.Mesh(this.ringGeom, this.selectionRingMat);
      ring.rotation.x = Math.PI / 2;
      ring.renderOrder = RADIUS_SPHERE_RENDER_ORDER;
      m.group.add(ring);
      m.ring = ring;
    } else if (!selected && m.ring) {
      m.group.remove(m.ring);
      m.ring = undefined;
    }
    if (!m.ring) return;
    m.ring.scale.setScalar(radius);
    m.ring.position.set(0, radius * 0.06 + 0.8, 0);
  }

  updateUnitRadiusRings(m: OverlayEntityMesh, entity: Entity): void {
    const showVisual = this.showVisualRadius;
    const showHitbox = this.showHitboxRadius;
    const showCollision = this.showCollisionRadius;
    const showShotArming = this.showShotArmingRadius;
    if (!showVisual && !showHitbox && !showCollision && !showShotArming) {
      if (m.radiusRingsVisible && m.radiusRings) {
        if (m.radiusRings.visual) m.radiusRings.visual.visible = false;
        if (m.radiusRings.hitbox) m.radiusRings.hitbox.visible = false;
        if (m.radiusRings.collision) m.radiusRings.collision.visible = false;
        if (m.radiusRings.shotArmingRadius) m.radiusRings.shotArmingRadius.visible = false;
      }
      m.radiusRingsVisible = false;
      return;
    }

    const collider = entity.unit?.radius;
    if (!entity.unit || !collider) return;

    const rings = m.radiusRings ?? (m.radiusRings = {});
    const centerY = getUnitBodyCenterHeight(entity.unit);

    this.setUnitRadiusSphere(
      rings, 'visual', showVisual, m.group,
      centerY, entity.unit.radius.visual, this.radiusMatVisual,
    );
    this.setUnitRadiusSphere(
      rings, 'hitbox', showHitbox, m.group,
      centerY, collider.hitbox, this.radiusMatHitbox,
    );
    this.setUnitRadiusSphere(
      rings, 'collision', showCollision, m.group,
      centerY, collider.collision, this.radiusMatCollision,
    );
    this.setUnitRadiusSphere(
      rings, 'shotArmingRadius', showShotArming, m.group,
      centerY, collider.shotArmingRadius ?? 0, this.radiusMatShotArming,
    );
    m.radiusRingsVisible = true;
  }

  updateBuildingRadiusRings(m: OverlayEntityMesh, entity: Entity): void {
    const showVisual = this.showVisualRadius;
    const showHitbox = this.showHitboxRadius;
    const showCollision = this.showCollisionRadius;
    const showShotArming = this.showShotArmingRadius;
    if (!showVisual && !showHitbox && !showCollision && !showShotArming) {
      if (m.radiusRingsVisible && m.radiusRings) {
        if (m.radiusRings.visual) m.radiusRings.visual.visible = false;
        if (m.radiusRings.hitbox) m.radiusRings.hitbox.visible = false;
        if (m.radiusRings.collision) m.radiusRings.collision.visible = false;
        if (m.radiusRings.shotArmingRadius) m.radiusRings.shotArmingRadius.visible = false;
      }
      m.radiusRingsVisible = false;
      return;
    }
    if (!entity.building || !entity.buildingBlueprintId) return;

    const config = getBuildingConfig(entity.buildingBlueprintId);
    const collider = config.radius;
    const rings = m.radiusRings ?? (m.radiusRings = {});
    const centerY = Math.max(0, config.visualHeight * 0.5);

    this.setUnitRadiusSphere(
      rings, 'visual', showVisual, m.group,
      centerY, collider.visual, this.radiusMatVisual,
    );
    this.setUnitRadiusSphere(
      rings, 'hitbox', showHitbox, m.group,
      centerY, collider.hitbox, this.radiusMatHitbox,
    );
    this.setUnitRadiusSphere(
      rings, 'collision', showCollision, m.group,
      centerY, collider.collision, this.radiusMatCollision,
    );
    this.setUnitRadiusSphere(
      rings, 'shotArmingRadius', showShotArming, m.group,
      centerY, collider.shotArmingRadius ?? 0, this.radiusMatShotArming,
    );
    m.radiusRingsVisible = true;
  }

  updateRangeRings(m: OverlayEntityMesh, entity: Entity): void {
    this.logSupportDiagnostics(entity);
    if (!entity.unit && !entity.building) return;

    const showTrackAcquire = this.showTrackAcquire;
    const showTrackRelease = this.showTrackRelease;
    const showEngageAcquire = this.showEngageAcquire;
    const showSingleSelectedUnitTurretCircle =
      entity.unit !== null &&
      entity.selectable?.selected === true &&
      this.selectedCount === 1;
    const showEngageRelease =
      this.showEngageRelease || showSingleSelectedUnitTurretCircle;
    const showEngageMinAcquire = this.showEngageMinAcquire;
    const showEngageMinRelease = this.showEngageMinRelease;
    const showBuild = this.showBuild;
    const radarRadius = getEntityRadarRadius(entity);
    const showRadar = radarRadius > 0 && entity.selectable?.selected === true;
    const showReclaim = this.showReclaimTargets && isReclaimableTarget(entity);
    const showAnyTurretRange =
      showTrackAcquire || showTrackRelease
      || showEngageAcquire || showEngageRelease
      || showEngageMinAcquire || showEngageMinRelease;
    if (!showAnyTurretRange && !showBuild && !showRadar && !showReclaim) {
      if (m.rangeRingsVisible) this.hideRangeRings(m);
      m.rangeRingsVisible = false;
      return;
    }

    const ux = entity.transform.x;
    const uy = entity.transform.y;
    const mapWidth = this.clientViewState.getMapWidth();
    const mapHeight = this.clientViewState.getMapHeight();
    const unitGroundZ = getSurfaceHeight(ux, uy, mapWidth, mapHeight, LAND_CELL_SIZE)
      + RANGE_CIRCLE_GROUND_LIFT;

    if (showAnyTurretRange && entity.combat) {
      const { cos, sin } = getTransformCosSin(entity.transform);
      const turrets = entity.combat.turrets;
      for (let i = 0; i < turrets.length; i++) {
        const weapon = turrets[i];
        if (weapon.config.visualOnly) continue;
        const tm = m.turrets[i];
        if (!tm) continue;
        if (!isConstructionPieceMaterialized(entity, 'body')) {
          this.hideSingleTurretRangeRings(tm);
          continue;
        }
        const mountSurfaceNormal = entity.unit
          ? entity.unit.surfaceNormal ?? getSurfaceNormal(
              ux, uy,
              mapWidth,
              mapHeight,
              LAND_CELL_SIZE,
            )
          : FLAT_SURFACE_NORMAL;
        const mount = getTurretWorldMount(
          ux, uy, getUnitGroundZ(entity),
          cos, sin,
          weapon.mount.x, weapon.mount.y, getTurretMountHeight(entity, i),
          mountSurfaceNormal,
        );
        const mountX = mount.x;
        const mountY = mount.y;
        const terrainZ = getSurfaceHeight(mountX, mountY, mapWidth, mapHeight, LAND_CELL_SIZE);
        const mountGroundZ = terrainZ + RANGE_CIRCLE_GROUND_LIFT;

        this.setRangeCircle(
          tm, 'trackAcquire', showTrackAcquire, mountX, mountY, mountGroundZ,
          this.projectGroundRadius(weapon.ranges.tracking?.acquire ?? null), this.ringMatTrackAcquire,
        );
        this.setRangeCircle(
          tm, 'trackRelease', showTrackRelease, mountX, mountY, mountGroundZ,
          this.projectGroundRadius(weapon.ranges.tracking?.release ?? null), this.ringMatTrackRelease,
        );
        this.setRangeCircle(
          tm, 'engageAcquire', showEngageAcquire, mountX, mountY, mountGroundZ,
          this.projectGroundRadius(weapon.ranges.fire.max.acquire), this.ringMatEngageAcquire,
        );
        this.setRangeCircle(
          tm, 'engageRelease', showEngageRelease, mountX, mountY, mountGroundZ,
          this.projectGroundRadius(weapon.ranges.fire.max.release), this.ringMatEngageRelease,
        );
        this.setRangeCircle(
          tm, 'engageMinAcquire', showEngageMinAcquire, mountX, mountY, mountGroundZ,
          this.projectGroundRadius(weapon.ranges.fire.min?.acquire ?? null), this.ringMatEngageMinAcquire,
        );
        this.setRangeCircle(
          tm, 'engageMinRelease', showEngageMinRelease, mountX, mountY, mountGroundZ,
          this.projectGroundRadius(weapon.ranges.fire.min?.release ?? null), this.ringMatEngageMinRelease,
        );
      }
    } else if (m.rangeRingsVisible) {
      this.hideTurretRangeRings(m);
    }

    const builder = entity.builder;
    if (showBuild && builder) {
      if (!m.buildRing) {
        m.buildRing = this.createRangeCircle(this.ringMatBuild);
        m.buildRing.renderOrder = RANGE_CIRCLE_RENDER_ORDER;
        this.world.add(m.buildRing);
      }
      m.buildRing.visible = true;
      m.buildRing.position.set(ux, unitGroundZ, uy);
      this.writeRangeCircle(m.buildRing, builder.buildRange);
    } else if (m.buildRing) {
      m.buildRing.visible = false;
    }

    if (showRadar) {
      if (!m.radarRing) {
        m.radarRing = this.createRangeCircle(this.ringMatRadar);
        m.radarRing.renderOrder = RANGE_CIRCLE_RENDER_ORDER;
        this.world.add(m.radarRing);
      }
      m.radarRing.visible = true;
      m.radarRing.position.set(ux, unitGroundZ, uy);
      this.writeRangeCircle(m.radarRing, radarRadius);
    } else if (m.radarRing) {
      m.radarRing.visible = false;
    }

    if (showReclaim) {
      if (!m.reclaimRing) {
        m.reclaimRing = this.createRangeCircle(this.ringMatReclaim);
        m.reclaimRing.renderOrder = RANGE_CIRCLE_RENDER_ORDER + 1;
        this.world.add(m.reclaimRing);
      }
      m.reclaimRing.visible = true;
      m.reclaimRing.position.set(ux, unitGroundZ, uy);
      this.writeRangeCircle(m.reclaimRing, reclaimHighlightRadius(entity));
    } else if (m.reclaimRing) {
      m.reclaimRing.visible = false;
    }

    m.rangeRingsVisible = showAnyTurretRange || (showBuild && builder !== undefined) || showRadar || showReclaim;
  }

  removeWorldParentedOverlays(m: OverlayEntityMesh): void {
    if (m.buildRing) {
      this.removeRangeCircle(m.buildRing);
      m.buildRing = undefined;
    }
    if (m.radarRing) {
      this.removeRangeCircle(m.radarRing);
      m.radarRing = undefined;
    }
    if (m.reclaimRing) {
      this.removeRangeCircle(m.reclaimRing);
      m.reclaimRing = undefined;
    }
    for (const tm of m.turrets) {
      if (!tm.rangeRings) continue;
      if (tm.rangeRings.trackAcquire)     this.removeRangeCircle(tm.rangeRings.trackAcquire);
      if (tm.rangeRings.trackRelease)     this.removeRangeCircle(tm.rangeRings.trackRelease);
      if (tm.rangeRings.engageAcquire)    this.removeRangeCircle(tm.rangeRings.engageAcquire);
      if (tm.rangeRings.engageRelease)    this.removeRangeCircle(tm.rangeRings.engageRelease);
      if (tm.rangeRings.engageMinAcquire) this.removeRangeCircle(tm.rangeRings.engageMinAcquire);
      if (tm.rangeRings.engageMinRelease) this.removeRangeCircle(tm.rangeRings.engageMinRelease);
      tm.rangeRings = undefined;
    }
    m.rangeRingsVisible = false;
  }

  dispose(): void {
    this.ringGeom.dispose();
    this.radiusMatVisual.dispose();
    this.radiusMatHitbox.dispose();
    this.radiusMatCollision.dispose();
    this.radiusMatShotArming.dispose();
    this.ringMatTrackAcquire.dispose();
    this.ringMatTrackRelease.dispose();
    this.ringMatEngageAcquire.dispose();
    this.ringMatEngageRelease.dispose();
    this.ringMatEngageMinAcquire.dispose();
    this.ringMatEngageMinRelease.dispose();
    this.ringMatBuild.dispose();
    this.ringMatRadar.dispose();
    this.ringMatReclaim.dispose();
    this.selectionRingMat.dispose();
  }

  private setUnitRadiusSphere(
    rings: RadiusRingMeshes,
    key: keyof RadiusRingMeshes,
    want: boolean,
    parent: THREE.Group,
    centerY: number,
    radius: number,
    mat: THREE.LineBasicMaterial,
  ): void {
    let mesh = rings[key];
    if (want && radius > 0) {
      if (!mesh) {
        mesh = new THREE.LineSegments(this.radiusSphereGeom, mat);
        mesh.renderOrder = RADIUS_SPHERE_RENDER_ORDER;
        mesh.frustumCulled = false;
        parent.add(mesh);
        rings[key] = mesh;
      }
      mesh.visible = true;
      mesh.position.y = centerY;
      mesh.scale.setScalar(radius);
    } else if (mesh) {
      mesh.visible = false;
    }
  }

  private projectGroundRadius(radius: number | null): number | null {
    if (radius === null) return null;
    return radius;
  }

  private hideRangeRings(m: OverlayEntityMesh): void {
    this.hideTurretRangeRings(m);
    if (m.buildRing) m.buildRing.visible = false;
    if (m.radarRing) m.radarRing.visible = false;
    if (m.reclaimRing) m.reclaimRing.visible = false;
  }

  private hideTurretRangeRings(m: OverlayEntityMesh): void {
    for (const tm of m.turrets) {
      this.hideSingleTurretRangeRings(tm);
    }
  }

  private hideSingleTurretRangeRings(tm: TurretMesh): void {
    const rings = tm.rangeRings;
    if (!rings) return;
    if (rings.trackAcquire)     rings.trackAcquire.visible = false;
    if (rings.trackRelease)     rings.trackRelease.visible = false;
    if (rings.engageAcquire)    rings.engageAcquire.visible = false;
    if (rings.engageRelease)    rings.engageRelease.visible = false;
    if (rings.engageMinAcquire) rings.engageMinAcquire.visible = false;
    if (rings.engageMinRelease) rings.engageMinRelease.visible = false;
  }

  private setRangeCircle(
    tm: TurretMesh,
    key:
      | 'trackAcquire'
      | 'trackRelease'
      | 'engageAcquire'
      | 'engageRelease'
      | 'engageMinAcquire'
      | 'engageMinRelease',
    want: boolean,
    cx: number, cy: number, cz: number,
    radius: number | null,
    mat: THREE.MeshBasicMaterial,
  ): void {
    const rings = tm.rangeRings ?? (tm.rangeRings = {});
    let ring = rings[key];
    if (want && radius !== null) {
      if (!ring) {
        ring = this.createRangeCircle(mat);
        ring.renderOrder = RANGE_CIRCLE_RENDER_ORDER;
        this.world.add(ring);
        rings[key] = ring;
      }
      ring.visible = true;
      ring.position.set(cx, cz, cy);
      this.writeRangeCircle(ring, radius);
    } else if (ring) {
      ring.visible = false;
    }
  }

  private createRangeCircle(mat: THREE.MeshBasicMaterial): RangeRingMesh {
    const ribbon = createClosedRibbonGeometry(RANGE_CIRCLE_SEGMENTS);
    const mesh = new THREE.Mesh(ribbon.geometry, mat) as RangeRingMesh;
    mesh.userData.ribbon = ribbon;
    mesh.frustumCulled = false;
    return mesh;
  }

  private writeRangeCircle(mesh: RangeRingMesh, radius: number): void {
    if (mesh.userData.radius === radius) return;
    mesh.userData.radius = radius;
    writeCircleRibbonGeometry(mesh.userData.ribbon as ClosedRibbonGeometry, radius);
  }

  private removeRangeCircle(mesh: RangeRingMesh): void {
    this.world.remove(mesh);
    mesh.geometry.dispose();
  }

  private logSupportDiagnostics(entity: Entity): void {
    if (!GAME_DIAGNOSTICS.supportSurfaceDiagnostics) return;
    const unit = entity.unit;
    if (unit === null || entity.selectable?.selected !== true) return;

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const nextLogAt = this.supportDiagnosticNextLogAtMs.get(entity.id) ?? 0;
    if (now < nextLogAt) return;
    this.supportDiagnosticNextLogAtMs.set(
      entity.id,
      now + SUPPORT_DIAGNOSTIC_LOG_INTERVAL_MS,
    );

    const mapWidth = this.clientViewState.getMapWidth();
    const mapHeight = this.clientViewState.getMapHeight();
    const bodyGroundY = getUnitGroundZ(entity);
    const support = sampleLocomotionSupportSurface(
      entity.transform.x,
      entity.transform.y,
      mapWidth,
      mapHeight,
      entity.transform.z,
      getUnitBodyCenterHeight(unit),
      entity.id,
      this.supportDiagnosticSurface,
    );
    const penetration = support.groundZ - bodyGroundY;
    debugLog(GAME_DIAGNOSTICS.supportSurfaceDiagnostics, '[support-surface]', {
      id: entity.id,
      unitBlueprintId: unit.unitBlueprintId,
      supportKind: support.supportKind,
      materialKind: support.materialKind,
      supportEntityId: support.supportEntityId,
      sourceKey: support.sourceKey,
      walkable: support.walkable,
      sampledSupportY: roundSupportDiagnostic(support.groundZ),
      bodyGroundY: roundSupportDiagnostic(bodyGroundY),
      penetration: roundSupportDiagnostic(penetration),
      contact: isUnitGroundPenetrationInContact(penetration),
      velocity: {
        x: roundSupportDiagnostic(unit.velocityX),
        y: roundSupportDiagnostic(unit.velocityY),
        z: roundSupportDiagnostic(unit.velocityZ),
      },
      position: {
        x: roundSupportDiagnostic(entity.transform.x),
        y: roundSupportDiagnostic(entity.transform.z),
        z: roundSupportDiagnostic(entity.transform.y),
      },
    });
  }
}

function roundSupportDiagnostic(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function reclaimHighlightRadius(entity: Entity): number {
  if (entity.unit?.radius) return Math.max(12, entity.unit.radius.visual * 1.45);
  if (entity.building) return Math.max(18, Math.hypot(entity.building.width, entity.building.height) * 0.58);
  return 16;
}
