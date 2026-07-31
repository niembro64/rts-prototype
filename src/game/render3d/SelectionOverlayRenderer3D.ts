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
import {
  fabricatorTorusHoverHeight,
  fabricatorTorusOuterRadius,
  fabricatorTorusRingRadius,
} from '../sim/blueprints';
import { selectionVolumeCenterZ, selectionVolumeRadius } from './Input3DPicker';
import { isUnitGroundPenetrationInContact } from '../sim/unitGroundPhysics';
import { getTurretWorldMount } from '../math/MountGeometry';
import { getTransformCosSin } from '../math';
import { getEntityBodyOrientation, getTurretMountHeight } from '../sim/combat/combatUtils';
import { getHostShotArmingRadius } from '../sim/combat/shotArming';
import {
  createWorldSupportSurface,
} from '../sim/supportSurface';
import { GAME_DIAGNOSTICS, debugLog } from '../diagnostics';
import {
  getEntityPrimaryTurretSensorSource,
  getEntityRadarRadius,
  getEntitySonarRadius,
} from '../sim/sensorCoverage';
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
const ANNULUS_WIREFRAME_SEGMENTS = 48;
const ANNULUS_WIREFRAME_RIBS = 8;

/** Wireframe for a vertical-axis annular cylinder (the fabricator torus's
 *  true collision shape): four circles at the inner/outer radii, top and
 *  bottom of the tube, joined by radial ribs. Built in world units — the
 *  mesh is used unscaled. */
function buildAnnulusWireframeGeometry(
  outerRadius: number,
  innerRadius: number,
  tubeHalfHeight: number,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const circle = (radius: number, y: number): void => {
    for (let i = 0; i < ANNULUS_WIREFRAME_SEGMENTS; i++) {
      const a0 = (i / ANNULUS_WIREFRAME_SEGMENTS) * Math.PI * 2;
      const a1 = ((i + 1) / ANNULUS_WIREFRAME_SEGMENTS) * Math.PI * 2;
      positions.push(
        Math.cos(a0) * radius, y, Math.sin(a0) * radius,
        Math.cos(a1) * radius, y, Math.sin(a1) * radius,
      );
    }
  };
  circle(outerRadius, tubeHalfHeight);
  circle(outerRadius, -tubeHalfHeight);
  circle(innerRadius, tubeHalfHeight);
  circle(innerRadius, -tubeHalfHeight);
  for (let i = 0; i < ANNULUS_WIREFRAME_RIBS; i++) {
    const a = (i / ANNULUS_WIREFRAME_RIBS) * Math.PI * 2;
    const cx = Math.cos(a);
    const sz = Math.sin(a);
    const ot = [cx * outerRadius, tubeHalfHeight, sz * outerRadius];
    const ob = [cx * outerRadius, -tubeHalfHeight, sz * outerRadius];
    const it = [cx * innerRadius, tubeHalfHeight, sz * innerRadius];
    const ib = [cx * innerRadius, -tubeHalfHeight, sz * innerRadius];
    positions.push(...ot, ...ob, ...ob, ...ib, ...ib, ...it, ...it, ...ot);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

/** Unit cylinder wireframe (radius 1, y in ±1): two rim circles joined by
 *  vertical ribs. Scaled (radius, halfHeight, radius) per volume — this is
 *  the target-acquisition cylinder shape Rust combat targeting tests for
 *  every entity. */
function buildUnitCylinderWireframeGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  for (const y of [1, -1]) {
    for (let i = 0; i < ANNULUS_WIREFRAME_SEGMENTS; i++) {
      const a0 = (i / ANNULUS_WIREFRAME_SEGMENTS) * Math.PI * 2;
      const a1 = ((i + 1) / ANNULUS_WIREFRAME_SEGMENTS) * Math.PI * 2;
      positions.push(
        Math.cos(a0), y, Math.sin(a0),
        Math.cos(a1), y, Math.sin(a1),
      );
    }
  }
  for (let i = 0; i < ANNULUS_WIREFRAME_RIBS; i++) {
    const a = (i / ANNULUS_WIREFRAME_RIBS) * Math.PI * 2;
    const cx = Math.cos(a);
    const sz = Math.sin(a);
    positions.push(cx, 1, sz, cx, -1, sz);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}
const FLAT_SURFACE_NORMAL = { nx: 0, ny: 0, nz: 1 };
const SUPPORT_DIAGNOSTIC_LOG_INTERVAL_MS = 500;
const _selectedSensorPosition = { x: 0, y: 0, z: 0 };

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
  /** Unit-cube edge wireframe, non-uniformly scaled per building box. */
  private readonly radiusBoxGeom = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
  /** Unit cylinder wireframe, scaled (r, halfH, r) per acquisition volume. */
  private readonly radiusCylinderGeom = buildUnitCylinderWireframeGeometry();
  /** Annulus wireframes keyed by exact dims — one per hovering blueprint. */
  private readonly annulusGeomCache = new Map<string, THREE.BufferGeometry>();
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
  /** The "SEL" toggle: draws the actual mouse-pick selection sphere.
   *  Persisted under the legacy key 'other'. */
  private showSelectionVolume = false;
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
    this.showSelectionVolume = getUnitRadiusToggle('other');
    this.showHitboxRadius = getUnitRadiusToggle('hitbox');
    this.showCollisionRadius = getUnitRadiusToggle('collision');
    this.showShotArmingRadius = getUnitRadiusToggle('shotArmingRadius');
    this.showAnyRange = anyRangeToggleActive();
    this.showAnyUnitRadius = anyUnitRadiusToggleActive();
    const selectedIds = this.clientViewState.getSelectedIds();
    this.selectedCount = selectedIds.size;
    for (const entityId of this.supportDiagnosticNextLogAtMs.keys()) {
      if (!selectedIds.has(entityId)) {
        this.supportDiagnosticNextLogAtMs.delete(entityId);
      }
    }
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
      this.showSelectionVolume,
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
      (selected && Math.max(
        getEntityRadarRadius(entity),
        getEntitySonarRadius(entity),
      ) > 0)
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
    if (this.hideRadiusRingsIfDisabled(m)) return;

    const collider = entity.unit?.radius;
    if (!entity.unit || !collider) return;

    // Unit physics, projectile hit detection, and arming volumes really are
    // spheres at the body center; target ACQUISITION is a cylinder for every
    // entity (radius = hitbox, half-height = max(hitbox, support offset)).
    const rings = m.radiusRings ?? (m.radiusRings = {});
    const centerY = getUnitSupportPointOffsetZ(entity.unit);
    this.setRadiusVolumeSphere(
      rings, 'other', this.showSelectionVolume, m.group,
      centerY, selectionVolumeRadius(entity), this.radiusMatOther,
    );
    this.setRadiusVolumeSphere(
      rings, 'hitbox', this.showHitboxRadius, m.group,
      centerY, collider.hitbox, this.radiusMatHitbox,
    );
    const unitAcquisitionHalfHeight = Math.max(collider.hitbox, centerY);
    this.setRadiusVolume(
      rings, 'hitboxAcquisition', this.showHitboxRadius, m.group,
      this.radiusCylinderGeom, centerY,
      collider.hitbox, unitAcquisitionHalfHeight, collider.hitbox,
      this.radiusMatHitbox,
    );
    this.setRadiusVolumeSphere(
      rings, 'collision', this.showCollisionRadius, m.group,
      centerY, collider.collision, this.radiusMatCollision,
    );
    this.setRadiusVolumeSphere(
      rings, 'shotArmingRadius', this.showShotArmingRadius, m.group,
      centerY, getHostShotArmingRadius(entity), this.radiusMatShotArming,
    );
    m.radiusRingsVisible = true;
  }

  updateBuildingRadiusRings(m: OverlayEntityMesh, entity: Entity): void {
    if (this.hideRadiusRingsIfDisabled(m)) return;
    const building = entity.building;
    if (!building || !entity.buildingBlueprintId) return;

    const rings = m.radiusRings ?? (m.radiusRings = {});
    const isHovering = building.hoveringType === 'fabricator';
    // The mesh group origin sits at the footprint base. The combat/physics
    // box center is depth/2 up for grounded buildings and the hover height
    // for the torus (matching the slab z the sim stamps into targeting).
    const baseZ = entity.transform.z - building.depth / 2;
    const combatCenterY = isHovering ? fabricatorTorusHoverHeight() : building.depth / 2;

    // SEL: the actual mouse-pick sphere, shared with Input3DPicker.
    this.setRadiusVolumeSphere(
      rings, 'other', this.showSelectionVolume, m.group,
      selectionVolumeCenterZ(entity) - baseZ, selectionVolumeRadius(entity),
      this.radiusMatOther,
    );
    // HIT is two true volumes for buildings: the combat AABB that
    // projectiles, beams, and splash test, plus the target-acquisition
    // cylinder Rust combat targeting gates on (radius = targetRadius,
    // half-height = max(targetRadius, depth/2)).
    this.setRadiusVolume(
      rings, 'hitbox', this.showHitboxRadius, m.group, this.radiusBoxGeom,
      combatCenterY, building.width, building.depth, building.height,
      this.radiusMatHitbox,
    );
    const acquisitionHalfHeight = Math.max(building.targetRadius, building.depth / 2);
    this.setRadiusVolume(
      rings, 'hitboxAcquisition', this.showHitboxRadius, m.group,
      this.radiusCylinderGeom, combatCenterY,
      building.targetRadius, acquisitionHalfHeight, building.targetRadius,
      this.radiusMatHitbox,
    );
    // COL: the physics volume — grounded static cuboid, or the fabricator's
    // floating annular ring (open center hole and all).
    if (isHovering) {
      const ringRadius = fabricatorTorusRingRadius(building.width, building.height);
      const outerRadius = fabricatorTorusOuterRadius(building.width, building.height);
      const tubeHalfHeight = outerRadius - ringRadius;
      this.setRadiusVolume(
        rings, 'collision', this.showCollisionRadius, m.group,
        this.annulusGeometry(outerRadius, ringRadius - tubeHalfHeight, tubeHalfHeight),
        combatCenterY, 1, 1, 1, this.radiusMatCollision,
      );
    } else {
      this.setRadiusVolume(
        rings, 'collision', this.showCollisionRadius, m.group, this.radiusBoxGeom,
        combatCenterY, building.width, building.depth, building.height,
        this.radiusMatCollision,
      );
    }
    this.setRadiusVolumeSphere(
      rings, 'shotArmingRadius', this.showShotArmingRadius, m.group,
      combatCenterY, getHostShotArmingRadius(entity), this.radiusMatShotArming,
    );
    m.radiusRingsVisible = true;
  }

  private annulusGeometry(
    outerRadius: number,
    innerRadius: number,
    tubeHalfHeight: number,
  ): THREE.BufferGeometry {
    const key = `${outerRadius}:${innerRadius}:${tubeHalfHeight}`;
    let geometry = this.annulusGeomCache.get(key);
    if (geometry === undefined) {
      geometry = buildAnnulusWireframeGeometry(outerRadius, innerRadius, tubeHalfHeight);
      this.annulusGeomCache.set(key, geometry);
    }
    return geometry;
  }

  private hideRadiusRingsIfDisabled(m: OverlayEntityMesh): boolean {
    if (
      this.showSelectionVolume || this.showHitboxRadius ||
      this.showCollisionRadius || this.showShotArmingRadius
    ) {
      return false;
    }
    if (m.radiusRingsVisible && m.radiusRings) {
      if (m.radiusRings.other) setObjectVisibleIfChanged(m.radiusRings.other, false);
      if (m.radiusRings.hitbox) setObjectVisibleIfChanged(m.radiusRings.hitbox, false);
      if (m.radiusRings.hitboxAcquisition) {
        setObjectVisibleIfChanged(m.radiusRings.hitboxAcquisition, false);
      }
      if (m.radiusRings.collision) setObjectVisibleIfChanged(m.radiusRings.collision, false);
      if (m.radiusRings.shotArmingRadius) setObjectVisibleIfChanged(m.radiusRings.shotArmingRadius, false);
    }
    m.radiusRingsVisible = false;
    return true;
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
    const radarRadius = Math.max(
      getEntityRadarRadius(entity),
      getEntitySonarRadius(entity),
    );
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
          getEntityBodyOrientation(entity),
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
      const source = getEntityPrimaryTurretSensorSource(entity, _selectedSensorPosition);
      this.setWorldRing(
        m.radarRing,
        source?.position.x ?? ux,
        source?.position.y ?? uy,
        radarRadius,
        COLOR_RADAR,
      );
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
    this.radiusBoxGeom.dispose();
    this.radiusCylinderGeom.dispose();
    for (const geometry of this.annulusGeomCache.values()) geometry.dispose();
    this.annulusGeomCache.clear();
    this.supportDiagnosticNextLogAtMs.clear();
  }

  private setRadiusVolumeSphere(
    rings: RadiusRingMeshes,
    key: keyof RadiusRingMeshes,
    want: boolean,
    parent: THREE.Group,
    centerY: number,
    radius: number,
    mat: THREE.LineBasicMaterial,
  ): void {
    this.setRadiusVolume(
      rings, key, want, parent, this.radiusSphereGeom,
      centerY, radius, radius, radius, mat,
    );
  }

  /** Place one debug volume wireframe. The mesh is recreated when the shape
   *  geometry changes (a host's shape never changes, so this is one-time). */
  private setRadiusVolume(
    rings: RadiusRingMeshes,
    key: keyof RadiusRingMeshes,
    want: boolean,
    parent: THREE.Group,
    geometry: THREE.BufferGeometry,
    centerY: number,
    scaleX: number,
    scaleY: number,
    scaleZ: number,
    mat: THREE.LineBasicMaterial,
  ): void {
    let mesh = rings[key];
    if (want && scaleX > 0 && scaleY > 0 && scaleZ > 0) {
      if (mesh !== undefined && mesh.geometry !== geometry) {
        parent.remove(mesh);
        mesh = undefined;
        rings[key] = undefined;
      }
      if (!mesh) {
        mesh = new THREE.LineSegments(geometry, mat);
        mesh.renderOrder = RADIUS_SPHERE_RENDER_ORDER;
        mesh.frustumCulled = false;
        parent.add(mesh);
        rings[key] = mesh;
      }
      setObjectVisibleIfChanged(mesh, true);
      setVector3YIfChanged(mesh.position, centerY);
      if (scaleX === scaleY && scaleY === scaleZ) {
        setScaleScalarIfChanged(mesh.scale, scaleX);
      } else if (
        mesh.scale.x !== scaleX || mesh.scale.y !== scaleY || mesh.scale.z !== scaleZ
      ) {
        mesh.scale.set(scaleX, scaleY, scaleZ);
      }
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
