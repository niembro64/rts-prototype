import * as THREE from 'three';
import { getConstructionHostMarkingProfile } from '@/constructionVisualConfig';
import type { UnitBodyShape } from '@/types/blueprints';
import type { GraphicsConfig } from '@/types/graphics';
import { getUnitBodyShapeKey } from '../math/BodyDimensions';
import { FALLBACK_UNIT_BODY_SHAPE, getUnitBlueprint } from '../sim/blueprints';
import { isCommander } from '../sim/combat/combatUtils';
import { isShieldPanelTurret } from '../sim/shieldPanelRuntime';
import type { Entity, PlayerId, Turret } from '../sim/types';
import { getUnitSupportPointOffsetZ } from '../sim/unitGeometry';
import {
  applyLocomotionState,
  buildLocomotion,
  getChassisLift,
  type LocomotionStateSnapshot,
} from './Locomotion3D';
import { getFactoryProductionHoldVisual } from '../sim/factoryProductionHold';
import { buildAlbatrosChassis } from './AlbatrosMesh3D';
import type { LegInstancedRenderer } from './LegInstancedRenderer';
import { getBodyGeom } from './BodyShape3D';
import type { CommanderVisualKit3D } from './CommanderVisualKit3D';
import type { EntityMesh } from './EntityMesh3D';
import { buildShieldPanelMesh3D } from './ShieldPanelMesh3D';
import { buildTurretMesh3D, type TurretMesh } from './TurretMesh3D';
import type { UnitDetailInstanceRenderer3D } from './UnitDetailInstanceRenderer3D';
import { setVector3IfChanged } from './threeTransformWriteUtils';
import { featureVisibleAtDetail, geometryTierForDetail } from './EntityDetailLevel3D';
import { REFERENCE_HOST_RADIUS, bodyLobeChart } from './SurfaceChart3D';
import { applyChartToMesh, patchSurfaceChartTree } from './SurfaceChartMaterial3D';
import { buildProductionHoldRingMesh } from './ProductionHoldRing3D';
import { buildConstructionHostMarking } from './ConstructionHostMarking3D';

// Detailed unit parts use shared instanced pools by default. The
// per-mesh path remains only as an allocation fallback, not as the
// normal rendering route.
const USE_DETAILED_UNIT_INSTANCING = true;
const LOW_DETAIL_UNIT_BODY_SHAPE: UnitBodyShape = {
  kind: 'circle',
  radiusFrac: 0.78,
};

type UnitMeshBuilder3DOptions = {
  world: THREE.Group;
  unitDetailInstances: UnitDetailInstanceRenderer3D;
  commanderVisualKit: CommanderVisualKit3D;
  legRenderer: LegInstancedRenderer;
  turretHeadGeom: THREE.SphereGeometry;
  barrelGeom: THREE.CylinderGeometry;
  coneBarrelGeom: THREE.CylinderGeometry;
  mirrorGeom: THREE.BoxGeometry;
  mirrorArmGeom: THREE.BoxGeometry;
  mirrorSupportGeom: THREE.CylinderGeometry;
  getPrimaryMat: (playerId: PlayerId | undefined) => THREE.Material;
  barrelMat: THREE.Material;
  getMirrorShinyMat: () => THREE.Material;
};

type UnitMeshBuildRequest = {
  entity: Entity;
  radius: number;
  ownerId: PlayerId | undefined;
  turrets: readonly Turret[];
  unitGfx: GraphicsConfig;
  unitFrameKey: string;
  unitRenderKey: string;
  detailLevel: number;
  locomotionState?: LocomotionStateSnapshot;
};

export function applyUnitLiftGroupPose3D(mesh: EntityMesh, entity: Entity): void {
  if (!mesh.liftGroup) return;
  const suspension = entity.unit?.suspension;
  if (!suspension) {
    setVector3IfChanged(mesh.liftGroup.position, 0, mesh.chassisLift ?? 0, 0);
    return;
  }
  setVector3IfChanged(
    mesh.liftGroup.position,
    suspension.offsetX,
    (mesh.chassisLift ?? 0) + suspension.offsetZ,
    suspension.offsetY,
  );
}

export class UnitMeshBuilder3D {
  private readonly world: THREE.Group;
  private readonly unitDetailInstances: UnitDetailInstanceRenderer3D;
  private readonly commanderVisualKit: CommanderVisualKit3D;
  private readonly legRenderer: LegInstancedRenderer;
  private readonly turretHeadGeom: THREE.SphereGeometry;
  private readonly barrelGeom: THREE.CylinderGeometry;
  private readonly coneBarrelGeom: THREE.CylinderGeometry;
  private readonly mirrorGeom: THREE.BoxGeometry;
  private readonly mirrorArmGeom: THREE.BoxGeometry;
  private readonly mirrorSupportGeom: THREE.CylinderGeometry;
  private readonly getPrimaryMat: UnitMeshBuilder3DOptions['getPrimaryMat'];
  private readonly barrelMat: THREE.Material;
  private readonly getMirrorShinyMat: UnitMeshBuilder3DOptions['getMirrorShinyMat'];

  constructor(options: UnitMeshBuilder3DOptions) {
    this.world = options.world;
    this.unitDetailInstances = options.unitDetailInstances;
    this.commanderVisualKit = options.commanderVisualKit;
    this.legRenderer = options.legRenderer;
    this.turretHeadGeom = options.turretHeadGeom;
    this.barrelGeom = options.barrelGeom;
    this.coneBarrelGeom = options.coneBarrelGeom;
    this.mirrorGeom = options.mirrorGeom;
    this.mirrorArmGeom = options.mirrorArmGeom;
    this.mirrorSupportGeom = options.mirrorSupportGeom;
    this.getPrimaryMat = options.getPrimaryMat;
    this.barrelMat = options.barrelMat;
    this.getMirrorShinyMat = options.getMirrorShinyMat;
  }

  build(request: UnitMeshBuildRequest): EntityMesh {
    const {
      entity,
      radius,
      ownerId,
      turrets,
      unitGfx,
      unitFrameKey,
      unitRenderKey,
      detailLevel,
      locomotionState,
    } = request;

    const group = new THREE.Group();
    const blueprint = this.getUnitBlueprint(entity);
    const isAlbatros = blueprint?.unitBlueprintId === 'unitAlbatros';
    const bodyIsShieldEmitter = blueprint?.bodyShape === null && turrets.some(
      (turret) => turret.config.shot?.type === 'shield' &&
        turret.config.shot.barrier !== undefined,
    );
    // A null body is an authored visual absence, not a request for the
    // generic fallback or low-detail sphere. Units such as Daddy use a
    // turret-hosted visual as their sole body.
    const authoredBodyShape = blueprint === undefined
      ? FALLBACK_UNIT_BODY_SHAPE
      : blueprint.bodyShape;
    const bodyShape = authoredBodyShape === null
      ? null
      : unitGfx.unitShape === 'circles'
        ? LOW_DETAIL_UNIT_BODY_SHAPE
        : authoredBodyShape;
    const geometryTier = geometryTierForDetail(detailLevel);
    // Poly chassis pools own immutable geometry. Include the tier so a
    // Close bevelled body can never be reused by a Mid/Far instance (or
    // vice versa) merely because the authored 2D shape key is identical.
    const bodyShapeKey = `${geometryTier}:${getUnitBodyShapeKey(bodyShape)}`;
    const bodyEntry = getBodyGeom(bodyShape, geometryTier);
    const primaryMat = this.getPrimaryMat(ownerId);

    const yawGroup = new THREE.Group();
    yawGroup.userData.entityId = entity.id;
    group.add(yawGroup);

    const liftGroup = new THREE.Group();
    liftGroup.userData.entityId = entity.id;
    liftGroup.position.set(0, blueprint ? getChassisLift(blueprint, radius) : 0, 0);
    yawGroup.add(liftGroup);

    const chassis = new THREE.Group();
    chassis.userData.entityId = entity.id;
    const chassisMeshes: THREE.Mesh[] = [];
    const useDetailedUnitInstancing = USE_DETAILED_UNIT_INSTANCING;
    const useInstancedChassis = useDetailedUnitInstancing && !isAlbatros;
    let smoothChassisSlots: number[] | undefined;
    let polyChassisSlot: number | undefined;

    if (
      useInstancedChassis &&
      bodyEntry.isSmooth &&
      bodyEntry.parts.length > 0
    ) {
      smoothChassisSlots = this.unitDetailInstances.allocSmoothChassisSlots(
        bodyEntry.parts.length,
        geometryTier,
      ) ?? undefined;
      // Semantic labelling. The generator knows exactly which lobe of the
      // composite each slot is, so the chart comes from the build rather than
      // from analysing the result — see SurfaceChart3D.
      //
      // The FORWARD-MOST lobe is the unit's face from the RTS camera and takes
      // the harder-edged facet band; everything behind it shares plated
      // armour. That is the split the reference host's three lobes were drawn
      // with, applied by geometry rather than by blueprint id, so a new hull
      // is charted because of what it is.
      if (smoothChassisSlots !== undefined) {
        let forwardPart = 0;
        for (let i = 1; i < bodyEntry.parts.length; i++) {
          if (bodyEntry.parts[i].x > bodyEntry.parts[forwardPart].x) forwardPart = i;
        }
        const hostScale = radius / REFERENCE_HOST_RADIUS;
        // A body of ONE lobe has no nose to distinguish from its body, and
        // dressing the whole hull in the facet band is a degenerate reading of
        // a rule about composites. One lobe is a hull, and a hull is plate.
        const hasDistinctNose = bodyEntry.parts.length > 1;
        for (let i = 0; i < smoothChassisSlots.length; i++) {
          this.unitDetailInstances.setSmoothChassisChart(
            smoothChassisSlots[i],
            bodyLobeChart(hasDistinctNose && i === forwardPart),
            hostScale,
          );
        }
      }
    } else if (
      useInstancedChassis &&
      !bodyEntry.isSmooth &&
      bodyEntry.parts.length === 1
    ) {
      const allocated = this.unitDetailInstances.allocPolyChassisSlot(
        bodyShapeKey,
        bodyEntry.parts[0].geometry,
        entity.id,
      );
      if (allocated !== null) polyChassisSlot = allocated;
    }

    if (isAlbatros) {
      chassisMeshes.push(
        ...buildAlbatrosChassis(chassis, primaryMat, entity.id, geometryTier),
      );
    } else if (!smoothChassisSlots && polyChassisSlot === undefined) {
      for (const part of bodyEntry.parts) {
        const mesh = new THREE.Mesh(part.geometry, primaryMat);
        mesh.position.set(part.x, part.y, part.z);
        mesh.scale.set(part.scaleX, part.scaleY, part.scaleZ);
        if (part.rotZ) mesh.rotation.z = part.rotZ;
        mesh.userData.entityId = entity.id;
        chassis.add(mesh);
        chassisMeshes.push(mesh);
      }
    }
    liftGroup.add(chassis);

    if (entity.commander) {
      const commanderKit = this.commanderVisualKit.buildKit(primaryMat, geometryTier);
      commanderKit.userData.entityId = entity.id;
      commanderKit.traverse((obj) => {
        obj.userData.entityId = entity.id;
        if (obj instanceof THREE.Mesh && obj.material === primaryMat) chassisMeshes.push(obj);
      });
      chassis.add(commanderKit);
    }

    const markingProfile = blueprint === undefined
      ? null
      : getConstructionHostMarkingProfile(blueprint.unitBlueprintId);
    if (markingProfile !== null) {
      // Chassis children live in unit-radius-1 space; the renderer scales
      // the chassis group by the unit's render radius every frame. Marking
      // profiles are authored in body-radius units, so build at scale 1 —
      // passing the world radius here would scale the marking twice and
      // detach it from the model.
      const marking = buildConstructionHostMarking(markingProfile, 1, geometryTier);
      marking.userData.entityId = entity.id;
      marking.traverse((obj) => {
        obj.userData.entityId = entity.id;
      });
      chassis.add(marking);
    }

    const turretMeshes = this.buildTurrets(
      liftGroup,
      entity,
      turrets,
      ownerId,
      unitGfx,
      useDetailedUnitInstancing,
      blueprint?.dgun?.turretBlueprintId,
      bodyIsShieldEmitter,
      detailLevel,
    );
    this.buildProductionHoldRing(
      liftGroup,
      entity,
      primaryMat,
      chassisMeshes,
      detailLevel,
    );

    this.world.add(group);
    const mesh: EntityMesh = {
      group,
      yawGroup,
      liftGroup,
      chassis,
      chassisMeshes,
      bodyShapeKey,
      geometryTier,
      bodyShape,
      turrets: turretMeshes,
      geometryKey: unitRenderKey,
      unitRenderFrameKey: unitFrameKey,
      unitRenderOwnerId: ownerId,
      unitRenderBlueprintId: entity.unit?.unitBlueprintId,
      unitRenderTurretCount: turrets.length,
      smoothChassisSlots,
      polyChassisSlot,
      chassisLift: liftGroup.position.y,
      uprightPose: blueprint?.unitLocomotion.type === 'stand',
    };
    if (smoothChassisSlots) {
      this.unitDetailInstances.registerSmoothChassisSlots(entity.id, smoothChassisSlots);
    }

    applyUnitLiftGroupPose3D(mesh, entity);
    mesh.locomotion = buildLocomotion(
      yawGroup,
      liftGroup,
      liftGroup.position.y,
      this.world,
      entity,
      radius,
      ownerId,
      unitGfx,
      detailLevel,
      this.legRenderer,
    );
    if (locomotionState !== undefined) applyLocomotionState(mesh.locomotion, locomotionState);

    this.buildMirrors(
      mesh,
      liftGroup,
      entity,
      turrets,
      ownerId,
      useDetailedUnitInstancing,
      detailLevel,
    );
    // Coverage backstop. The palette materials are born textured, but a unit
    // pulls in bespoke art from a dozen other modules — commander kits,
    // construction emitters, Albatros canopies, shield frames, production
    // rings — each with its own material const. Walking the finished assembly
    // is what makes "every face of every entity" hold without a checklist that
    // silently goes stale the next time someone adds a part. Materials are
    // patched once and cached, so this is a build-time constant, not per-unit
    // work.
    patchSurfaceChartTree(group);
    return mesh;
  }

  private getUnitBlueprint(entity: Entity): ReturnType<typeof getUnitBlueprint> | undefined {
    try {
      return getUnitBlueprint(entity.unit!.unitBlueprintId);
    } catch {
      return undefined;
    }
  }

  private buildProductionHoldRing(
    liftGroup: THREE.Group,
    entity: Entity,
    primaryMat: THREE.Material,
    chassisMeshes: THREE.Mesh[],
    detailLevel: number,
  ): void {
    if (entity.unit === null || entity.factory === null) return;
    if (!featureVisibleAtDetail('muzzleDetail', detailLevel)) return;
    let visual: ReturnType<typeof getFactoryProductionHoldVisual> | null = null;
    try {
      visual = getFactoryProductionHoldVisual(entity, entity.factory.selectedUnitBlueprintId);
    } catch {
      visual = null;
    }
    if (visual === null) return;
    const ring = buildProductionHoldRingMesh(
      visual.ringRadius,
      primaryMat,
      visual.ringOrientation,
      geometryTierForDetail(detailLevel),
    );
    ring.position.set(
      visual.localOffsetX,
      visual.localBaseZ - liftGroup.position.y,
      visual.localOffsetY,
    );
    ring.userData.entityId = entity.id;
    liftGroup.add(ring);
    chassisMeshes.push(ring);
  }

  private buildTurrets(
    liftGroup: THREE.Group,
    entity: Entity,
    turrets: readonly Turret[],
    ownerId: PlayerId | undefined,
    unitGfx: GraphicsConfig,
    useDetailedUnitInstancing: boolean,
    commanderDgunTurretBlueprintId: string | undefined,
    bodyIsShieldEmitter: boolean,
    detailLevel: number,
  ): TurretMesh[] {
    const turretMeshes: TurretMesh[] = [];
    const turretOff = unitGfx.turretStyle === 'none';
    const isCommanderUnit = isCommander(entity);
    for (let turretIdx = 0; turretIdx < turrets.length; turretIdx++) {
      const turret = turrets[turretIdx];
      const isShield = (turret.config.barrel as { type?: string } | undefined)?.type === 'complexSingleEmitter';
      const isConstructionEmitter = turret.config.constructionEmitter !== undefined;
      const showShieldEmitterCore = isShield &&
        turret.config.shot?.type === 'shield' &&
        turret.config.shot.barrier !== undefined;
      // A bodyless shield host deliberately uses its oscillating shield
      // sphere as the entire body. Ray heads are normally small spheres,
      // so hide the overlapping beam head while retaining the beam's mount,
      // aim, and emission behavior.
      const hideBeamHead = bodyIsShieldEmitter && turret.config.shot?.type === 'beam';
      const hideHead =
        turretOff ||
        unitGfx.turretStyle === 'simple' ||
        (isShield && !showShieldEmitterCore) ||
        isConstructionEmitter ||
        hideBeamHead;
      let headSlot: number | undefined;
      if (useDetailedUnitInstancing && !hideHead && !isCommanderUnit) {
        const allocated = this.unitDetailInstances.allocTurretHeadSlot(
          geometryTierForDetail(detailLevel),
        );
        if (allocated !== null) headSlot = allocated;
        // Every turret head in the game is a sensor dome: the pitch slot its
        // barrels travel in, its polar mounting collars and its armoured
        // ports belong to the ROLE, not to one blueprint.
        if (headSlot !== undefined) {
          this.unitDetailInstances.setTurretHeadChart(headSlot, 'sensorDome');
        }
      }

      const turretMesh = buildTurretMesh3D(liftGroup, turret, unitGfx, {
        headGeom: this.turretHeadGeom,
        barrelGeom: this.barrelGeom,
        coneBarrelGeom: this.coneBarrelGeom,
        primaryMat: this.getPrimaryMat(ownerId),
        barrelMat: this.barrelMat,
        shieldEmitterMat: this.getPrimaryMat(ownerId),
        showShieldEmitterCore,
        skipHead: headSlot !== undefined,
        hideHead: hideBeamHead,
        skipBarrels: false,
        detailLevel,
      });
      if (turretMesh.head) turretMesh.head.userData.entityId = entity.id;
      // The head is a per-Mesh sphere rather than an instanced slot, so it
      // adopts its chart by geometry/material swap instead of an attribute
      // write. Keyed by tier because each tier's head is a different sphere.
      // A shield emitter core is a glowing bubble, not a machined housing —
      // it is light rather than matter, so it takes no placed structure.
      if (turretMesh.head !== undefined && turretMesh.shieldEmitterCore !== true) {
        applyChartToMesh(
          turretMesh.head,
          'sensorDome',
          `turretHead:${geometryTierForDetail(detailLevel)}`,
        );
      }
      if (isCommanderUnit && !hideHead) {
        this.commanderVisualKit.decorateTurret(
          turretMesh,
          turret.config.turretBlueprintId === commanderDgunTurretBlueprintId,
          this.getPrimaryMat(ownerId),
          geometryTierForDetail(detailLevel),
        );
      }
      for (const barrel of turretMesh.barrels) barrel.userData.entityId = entity.id;
      turretMesh.headSlot = headSlot;

      if (useDetailedUnitInstancing && turretMesh.barrels.length > 0) {
        const barrelSlots = this.unitDetailInstances.allocBarrelSlots(
          turretMesh.barrels.length,
          turretMesh.barrelUsesCone === true,
          geometryTierForDetail(detailLevel),
        );
        if (barrelSlots) {
          turretMesh.barrelSlots = barrelSlots;
          // Cone barrels are beam emitters — a glowing rig, not a machined
          // tube — so they keep their wave material. Every real barrel is a
          // barrel shaft whatever fires through it.
          if (turretMesh.barrelUsesCone !== true) {
            for (const slot of barrelSlots) {
              this.unitDetailInstances.setBarrelChart(slot, 'barrelShaft');
            }
          }
          for (const barrel of turretMesh.barrels) barrel.parent?.remove(barrel);
          if (turretMesh.barrelUsesCone === true) {
            // Far-rung hosts shed the beam rig's inner cone + inner ball
            // layers (the glow doubling), halving the rig's triangles.
            this.unitDetailInstances.registerConeBarrelEmitter(
              barrelSlots[0],
              0,
              featureVisibleAtDetail('beamGlow', detailLevel),
            );
          }
        }
      }
      turretMeshes.push(turretMesh);
    }
    return turretMeshes;
  }

  private buildMirrors(
    mesh: EntityMesh,
    liftGroup: THREE.Group,
    entity: Entity,
    turrets: readonly Turret[],
    ownerId: PlayerId | undefined,
    useDetailedUnitInstancing: boolean,
    detailLevel: number,
  ): void {
    const shieldPanels = entity.unit?.shieldPanels;
    if (!shieldPanels || shieldPanels.length === 0 || !entity.unit) return;
    if (!featureVisibleAtDetail('shieldPanels', detailLevel)) return;

    const panelHalfSide = shieldPanels[0].halfWidth;
    const panelArmLength = shieldPanels[0].offsetX;
    let shieldPanelTurret: Turret | undefined;
    for (let i = 0; i < turrets.length; i++) {
      const turret = turrets[i];
      if (!isShieldPanelTurret(turret)) continue;
      shieldPanelTurret = turret;
      break;
    }
    const pivotLocalX = shieldPanelTurret?.mount.x ?? 0;
    const pivotLocalY = (shieldPanelTurret?.mount.z ?? getUnitSupportPointOffsetZ(entity.unit))
      - liftGroup.position.y;
    const pivotLocalZ = shieldPanelTurret?.mount.y ?? 0;
    const panelCount = shieldPanels.length;
    const panelGeometryTier = geometryTierForDetail(detailLevel);
    // The shared panel pool owns the High box slab. Medium/Low use their
    // own cheaper per-mesh slab/support geometry while keeping the same
    // root pose and authored panel transforms.
    const allocedPanelSlots =
      useDetailedUnitInstancing && panelCount > 0 && panelGeometryTier === 'close'
      ? this.unitDetailInstances.allocShieldPanelSlots(panelCount)
      : null;
    const allMirrorAlloc = allocedPanelSlots !== null;
    mesh.mirrors = buildShieldPanelMesh3D(
      liftGroup,
      shieldPanels,
      pivotLocalX,
      pivotLocalY,
      pivotLocalZ,
      panelHalfSide,
      panelArmLength,
      this.mirrorGeom,
      this.mirrorArmGeom,
      this.mirrorSupportGeom,
      this.getMirrorShinyMat(),
      this.getPrimaryMat(ownerId),
      allMirrorAlloc,
      panelGeometryTier,
    );
    if (allMirrorAlloc) mesh.mirrors.panelSlots = allocedPanelSlots;
    for (const panel of mesh.mirrors.panels) {
      panel.userData.entityId = entity.id;
      panel.renderOrder = 7;
    }
    for (const frame of mesh.mirrors.frames) {
      frame.userData.entityId = entity.id;
    }
  }
}
