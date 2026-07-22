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
import { isAttackEmitter } from '../sim/emitterKinds';
import type { ClientViewState } from '../network/ClientViewState';
import { getSurfaceHeight, getSurfaceNormal } from '../sim/Terrain';
import { getUnitSupportPointOffsetZ, getUnitGroundZ } from '../sim/unitGeometry';
import { fabricatorTorusHoverHeight } from '../sim/blueprints';
import { isUnitGroundPenetrationInContact } from '../sim/unitGroundPhysics';
import { getTurretWorldMount } from '../math/MountGeometry';
import { getTransformCosSin } from '../math';
import { getTurretMountHeight } from '../sim/combat/combatUtils';
import { getHostShotArmingRadius } from '../sim/combat/shotArming';
import {
  createWorldSupportSurface,
} from '../sim/supportSurface';
import { GAME_DIAGNOSTICS, debugLog } from '../diagnostics';
import { getEntityRadarRadius } from '../sim/sensorCoverage';
import { getBuildingConfig } from '../sim/buildConfigs';
import { isReclaimableTarget } from '../sim/reclaim';
import type { TurretMesh } from './TurretMesh3D';
import type { EntityMesh, RadiusRingMeshes } from './EntityMesh3D';
import { sampleLocomotionSupportSurface } from './LocomotionTerrainSampler';
import type { OverlayLineSystem } from './OverlayLineSystem';
import type { OverlayLineKind } from '@/config';
import { GroundRing3D } from './GroundRing3D';
import { hexToRgb01 } from './colorUtils';
import {
  setObjectVisibleIfChanged,
  setScaleScalarIfChanged,
  setVector3YIfChanged,
} from './threeTransformWriteUtils';

const RANGE_CIRCLE_SEGMENTS = 96;
const RADIUS_SPHERE_RENDER_ORDER = 22;
const FLAT_SURFACE_NORMAL = { nx: 0, ny: 0, nz: 1 };
const SUPPORT_DIAGNOSTIC_LOG_INTERVAL_MS = 500;

type OverlayEntityMesh = Pick<
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

// Per-overlay colours (RGBA 0..1) for the unified ground-ring system; widths/
// lifts/render-orders come from OverlayLineSystem's per-kind config.
type Rgba = readonly [number, number, number, number];
function rgbaFrom(colorHex: number, opacity: number): Rgba {
  const c = hexToRgb01(colorHex);
  return [c.r, c.g, c.b, opacity];
}
function rgbaStyle(style: { colorHex: number; opacity: number }): Rgba {
  return rgbaFrom(style.colorHex, style.opacity);
}
const SEL = COLORS.effects.selectionOverlay;
const COLOR_SELECTION = rgbaStyle(SEL.selectionRing);
const COLOR_TRACK_ACQUIRE = rgbaStyle(SEL.trackAcquire);
const COLOR_TRACK_RELEASE = rgbaStyle(SEL.trackRelease);
const COLOR_ENGAGE_ACQUIRE = rgbaStyle(SEL.engageAcquire);
const COLOR_ENGAGE_RELEASE = rgbaStyle(SEL.engageRelease);
const COLOR_ENGAGE_MIN_ACQUIRE = rgbaStyle(SEL.engageMinAcquire);
const COLOR_ENGAGE_MIN_RELEASE = rgbaStyle(SEL.engageMinRelease);
const COLOR_BUILD = rgbaStyle(SEL.build);
const COLOR_RADAR = rgbaStyle(SEL.radar);
const COLOR_RECLAIM = rgbaFrom(COLORS.ui.actionColors.reclaim.colorHex, 0.6);

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
  private showOtherRadius = false;
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

  private readonly radiusMatOther = new THREE.LineBasicMaterial({
    color: COLORS.effects.selectionOverlay.radiusOther.colorHex,
    transparent: true,
    opacity: COLORS.effects.selectionOverlay.radiusOther.opacity,
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
  private readonly overlayLines: OverlayLineSystem;
  /** Terrain sampler used to drape world-parented range rings over slopes
   *  (so they read as on-surface once depth occlusion is on). */
  private readonly sampleTerrainY = (x: number, z: number): number =>
    getSurfaceHeight(
      x, z,
      this.clientViewState.getMapWidth(),
      this.clientViewState.getMapHeight(),
      LAND_CELL_SIZE,
    );

  constructor(options: {
    world: THREE.Group;
    clientViewState: ClientViewState;
    radiusSphereGeom: THREE.BufferGeometry;
    overlayLines: OverlayLineSystem;
  }) {
    this.world = options.world;
    this.clientViewState = options.clientViewState;
    this.radiusSphereGeom = options.radiusSphereGeom;
    this.overlayLines = options.overlayLines;
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
    this.showOtherRadius = getUnitRadiusToggle('other');
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
      this.showOtherRadius,
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
      m.ring = new GroundRing3D(this.overlayLines, 'selection', 48);
      // Parented to the entity group so it auto-follows the unit each frame.
      m.group.add(m.ring.mesh);
    } else if (!selected && m.ring) {
      m.group.remove(m.ring.mesh);
      m.ring.dispose();
      m.ring = undefined;
    }
    if (!m.ring) return;
    // Flat ring in the group's local space (center at origin); the config
    // ground lift keeps it just above the unit's footprint.
    const [r, g, b, a] = COLOR_SELECTION;
    m.ring.set(0, 0, 0, radius, r, g, b, a);
  }

  updateUnitRadiusRings(m: OverlayEntityMesh, entity: Entity): void {
    const showOther = this.showOtherRadius;
    const showHitbox = this.showHitboxRadius;
    const showCollision = this.showCollisionRadius;
    const showShotArming = this.showShotArmingRadius;
    if (!showOther && !showHitbox && !showCollision && !showShotArming) {
      if (m.radiusRingsVisible && m.radiusRings) {
        if (m.radiusRings.other) setObjectVisibleIfChanged(m.radiusRings.other, false);
        if (m.radiusRings.hitbox) setObjectVisibleIfChanged(m.radiusRings.hitbox, false);
        if (m.radiusRings.collision) setObjectVisibleIfChanged(m.radiusRings.collision, false);
        if (m.radiusRings.shotArmingRadius) setObjectVisibleIfChanged(m.radiusRings.shotArmingRadius, false);
      }
      m.radiusRingsVisible = false;
      return;
    }

    const collider = entity.unit?.radius;
    if (!entity.unit || !collider) return;

    const rings = m.radiusRings ?? (m.radiusRings = {});
    const centerY = getUnitSupportPointOffsetZ(entity.unit);

    this.setUnitRadiusSphere(
      rings, 'other', showOther, m.group,
      centerY, entity.unit.radius.other, this.radiusMatOther,
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
      centerY, getHostShotArmingRadius(entity), this.radiusMatShotArming,
    );
    m.radiusRingsVisible = true;
  }

  updateBuildingRadiusRings(m: OverlayEntityMesh, entity: Entity): void {
    const showOther = this.showOtherRadius;
    const showHitbox = this.showHitboxRadius;
    const showCollision = this.showCollisionRadius;
    const showShotArming = this.showShotArmingRadius;
    if (!showOther && !showHitbox && !showCollision && !showShotArming) {
      if (m.radiusRingsVisible && m.radiusRings) {
        if (m.radiusRings.other) setObjectVisibleIfChanged(m.radiusRings.other, false);
        if (m.radiusRings.hitbox) setObjectVisibleIfChanged(m.radiusRings.hitbox, false);
        if (m.radiusRings.collision) setObjectVisibleIfChanged(m.radiusRings.collision, false);
        if (m.radiusRings.shotArmingRadius) setObjectVisibleIfChanged(m.radiusRings.shotArmingRadius, false);
      }
      m.radiusRingsVisible = false;
      return;
    }
    if (!entity.building || !entity.buildingBlueprintId) return;

    const config = getBuildingConfig(entity.buildingBlueprintId);
    const collider = config.radius;
    const rings = m.radiusRings ?? (m.radiusRings = {});
    // A hovering body (the fabricator torus) carries its hitbox/collision/visual
    // volumes up at the torus center, not at the ground-level body midpoint.
    const centerY = entity.building.hoveringType === 'fabricator'
      ? fabricatorTorusHoverHeight()
      : Math.max(0, config.visualHeight * 0.5);

    this.setUnitRadiusSphere(
      rings, 'other', showOther, m.group,
      centerY, collider.other, this.radiusMatOther,
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
      centerY, getHostShotArmingRadius(entity), this.radiusMatShotArming,
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

    if (showAnyTurretRange && entity.combat) {
      const { cos, sin } = getTransformCosSin(entity.transform);
      const turrets = entity.combat.turrets;
      for (let i = 0; i < turrets.length; i++) {
        const weapon = turrets[i];
        if (!isAttackEmitter(weapon)) continue;
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

        this.setRangeCircle(
          tm, 'trackAcquire', showTrackAcquire, mountX, mountY,
          this.projectGroundRadius(weapon.ranges.tracking?.acquire ?? null), 'rangeTrack', COLOR_TRACK_ACQUIRE,
        );
        this.setRangeCircle(
          tm, 'trackRelease', showTrackRelease, mountX, mountY,
          this.projectGroundRadius(weapon.ranges.tracking?.release ?? null), 'rangeTrack', COLOR_TRACK_RELEASE,
        );
        this.setRangeCircle(
          tm, 'engageAcquire', showEngageAcquire, mountX, mountY,
          this.projectGroundRadius(weapon.ranges.fire.max.acquire), 'rangeEngage', COLOR_ENGAGE_ACQUIRE,
        );
        this.setRangeCircle(
          tm, 'engageRelease', showEngageRelease, mountX, mountY,
          this.projectGroundRadius(weapon.ranges.fire.max.release), 'rangeEngage', COLOR_ENGAGE_RELEASE,
        );
        this.setRangeCircle(
          tm, 'engageMinAcquire', showEngageMinAcquire, mountX, mountY,
          this.projectGroundRadius(weapon.ranges.fire.min?.acquire ?? null), 'rangeEngage', COLOR_ENGAGE_MIN_ACQUIRE,
        );
        this.setRangeCircle(
          tm, 'engageMinRelease', showEngageMinRelease, mountX, mountY,
          this.projectGroundRadius(weapon.ranges.fire.min?.release ?? null), 'rangeEngage', COLOR_ENGAGE_MIN_RELEASE,
        );
      }
    } else if (m.rangeRingsVisible) {
      this.hideTurretRangeRings(m);
    }

    const builder = entity.builder;
    if (showBuild && builder) {
      if (!m.buildRing) m.buildRing = this.makeWorldRing('build');
      this.setWorldRing(m.buildRing, ux, uy, builder.buildRange, COLOR_BUILD);
    } else if (m.buildRing) {
      m.buildRing.hide();
    }

    if (showRadar) {
      if (!m.radarRing) m.radarRing = this.makeWorldRing('radar');
      this.setWorldRing(m.radarRing, ux, uy, radarRadius, COLOR_RADAR);
    } else if (m.radarRing) {
      m.radarRing.hide();
    }

    if (showReclaim) {
      if (!m.reclaimRing) m.reclaimRing = this.makeWorldRing('reclaim');
      this.setWorldRing(m.reclaimRing, ux, uy, reclaimHighlightRadius(entity), COLOR_RECLAIM);
    } else if (m.reclaimRing) {
      m.reclaimRing.hide();
    }

    m.rangeRingsVisible = showAnyTurretRange || (showBuild && builder !== undefined) || showRadar || showReclaim;
  }

  private makeWorldRing(kind: OverlayLineKind): GroundRing3D {
    const ring = new GroundRing3D(this.overlayLines, kind, RANGE_CIRCLE_SEGMENTS);
    this.world.add(ring.mesh);
    return ring;
  }

  /** Place a world-parented ring at (worldX, worldZ), draped over terrain. */
  private setWorldRing(
    ring: GroundRing3D,
    worldX: number,
    worldZ: number,
    radius: number,
    color: Rgba,
  ): void {
    if (radius <= 0) {
      ring.hide();
      return;
    }
    const [r, g, b, a] = color;
    ring.set(worldX, 0, worldZ, radius, r, g, b, a, this.sampleTerrainY);
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
    // The selection ring is group-parented, but it also leaves immediately on
    // teardown; dispose its geometry here so the per-ring buffer isn't leaked.
    if (m.ring) {
      m.group.remove(m.ring.mesh);
      m.ring.dispose();
      m.ring = undefined;
    }
  }

  dispose(): void {
    // Overlay-ring geometry/material is owned by the shared OverlayLineSystem;
    // only the radius-sphere wireframe materials are owned here.
    this.radiusMatOther.dispose();
    this.radiusMatHitbox.dispose();
    this.radiusMatCollision.dispose();
    this.radiusMatShotArming.dispose();
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
      setObjectVisibleIfChanged(mesh, true);
      setVector3YIfChanged(mesh.position, centerY);
      setScaleScalarIfChanged(mesh.scale, radius);
    } else if (mesh) {
      setObjectVisibleIfChanged(mesh, false);
    }
  }

  private projectGroundRadius(radius: number | null): number | null {
    if (radius === null) return null;
    return radius;
  }

  private hideRangeRings(m: OverlayEntityMesh): void {
    this.hideTurretRangeRings(m);
    m.buildRing?.hide();
    m.radarRing?.hide();
    m.reclaimRing?.hide();
  }

  private hideTurretRangeRings(m: OverlayEntityMesh): void {
    for (const tm of m.turrets) {
      this.hideSingleTurretRangeRings(tm);
    }
  }

  private hideSingleTurretRangeRings(tm: TurretMesh): void {
    const rings = tm.rangeRings;
    if (!rings) return;
    rings.trackAcquire?.hide();
    rings.trackRelease?.hide();
    rings.engageAcquire?.hide();
    rings.engageRelease?.hide();
    rings.engageMinAcquire?.hide();
    rings.engageMinRelease?.hide();
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
    worldX: number, worldZ: number,
    radius: number | null,
    kind: OverlayLineKind,
    color: Rgba,
  ): void {
    const rings = tm.rangeRings ?? (tm.rangeRings = {});
    let ring = rings[key];
    if (want && radius !== null && radius > 0) {
      if (!ring) {
        ring = this.makeWorldRing(kind);
        rings[key] = ring;
      }
      this.setWorldRing(ring, worldX, worldZ, radius, color);
    } else if (ring) {
      ring.hide();
    }
  }

  private removeRangeCircle(ring: GroundRing3D): void {
    this.world.remove(ring.mesh);
    ring.dispose();
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
      getUnitSupportPointOffsetZ(unit),
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
      contact: isUnitGroundPenetrationInContact(penetration, unit.radius.collision),
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
  if (entity.unit?.radius) return Math.max(12, entity.unit.radius.other * 1.45);
  if (entity.building) return Math.max(18, Math.hypot(entity.building.width, entity.building.height) * 0.58);
  return 16;
}
