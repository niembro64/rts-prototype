import * as THREE from 'three';
import type { UnitBodyShape } from '@/types/blueprints';
import type { GraphicsConfig } from '@/types/graphics';
import { getUnitBodyShapeKey } from '../math/BodyDimensions';
import { FALLBACK_UNIT_BODY_SHAPE, getUnitBlueprint } from '../sim/blueprints';
import { isCommander } from '../sim/combat/combatUtils';
import type { Entity, PlayerId, Turret } from '../sim/types';
import { getUnitBodyCenterHeight } from '../sim/unitGeometry';
import {
  applyLegState,
  buildLocomotion,
  getChassisLift,
  type LegStateSnapshot,
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
import { buildProductionHoldRingMesh } from './ProductionHoldRing3D';

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
  getTurretAccentMat: (playerId: PlayerId | undefined) => THREE.Material;
  getMirrorShinyMat: () => THREE.Material;
  getMapWidth: () => number;
  getMapHeight: () => number;
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
  legState?: LegStateSnapshot;
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
  private readonly getTurretAccentMat: UnitMeshBuilder3DOptions['getTurretAccentMat'];
  private readonly getMirrorShinyMat: UnitMeshBuilder3DOptions['getMirrorShinyMat'];
  private readonly getMapWidth: () => number;
  private readonly getMapHeight: () => number;

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
    this.getTurretAccentMat = options.getTurretAccentMat;
    this.getMirrorShinyMat = options.getMirrorShinyMat;
    this.getMapWidth = options.getMapWidth;
    this.getMapHeight = options.getMapHeight;
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
      legState,
    } = request;

    const group = new THREE.Group();
    const blueprint = this.getUnitBlueprint(entity);
    const isAlbatros = blueprint?.unitBlueprintId === 'unitAlbatros';
    const authoredBodyShape = blueprint?.bodyShape ?? FALLBACK_UNIT_BODY_SHAPE;
    const bodyShape =
      unitGfx.unitShape === 'circles' ? LOW_DETAIL_UNIT_BODY_SHAPE : authoredBodyShape;
    const bodyShapeKey = getUnitBodyShapeKey(bodyShape);
    const bodyEntry = getBodyGeom(bodyShape);
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

    const geometryTier = geometryTierForDetail(detailLevel);
    if (
      useInstancedChassis &&
      bodyEntry.isSmooth &&
      bodyEntry.parts.length > 0
    ) {
      smoothChassisSlots = this.unitDetailInstances.allocSmoothChassisSlots(
        bodyEntry.parts.length,
        geometryTier,
      ) ?? undefined;
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
        ...buildAlbatrosChassis(chassis, primaryMat, entity.id),
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
      const commanderKit = this.commanderVisualKit.buildKit(primaryMat);
      commanderKit.userData.entityId = entity.id;
      commanderKit.traverse((obj) => {
        obj.userData.entityId = entity.id;
        if (obj instanceof THREE.Mesh && obj.material === primaryMat) chassisMeshes.push(obj);
      });
      chassis.add(commanderKit);
    }

    const turretMeshes = this.buildTurrets(
      liftGroup,
      entity,
      turrets,
      ownerId,
      unitGfx,
      useDetailedUnitInstancing,
      blueprint?.dgun?.turretBlueprintId,
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
    };
    if (smoothChassisSlots) {
      this.unitDetailInstances.registerSmoothChassisSlots(entity.id, smoothChassisSlots);
    }

    applyUnitLiftGroupPose3D(mesh, entity);
    mesh.locomotion = buildLocomotion(
      yawGroup,
      this.world,
      entity,
      radius,
      ownerId,
      unitGfx,
      detailLevel,
      this.getMapWidth(),
      this.getMapHeight(),
      this.legRenderer,
    );
    if (legState !== undefined) applyLegState(mesh.locomotion, legState);

    this.buildMirrors(
      mesh,
      liftGroup,
      entity,
      turrets,
      ownerId,
      useDetailedUnitInstancing,
      detailLevel,
    );
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
      const hideHead =
        turretOff ||
        unitGfx.turretStyle === 'simple' ||
        (isShield && !showShieldEmitterCore) ||
        isConstructionEmitter;
      let headSlot: number | undefined;
      if (useDetailedUnitInstancing && !hideHead && !isCommanderUnit) {
        const allocated = this.unitDetailInstances.allocTurretHeadSlot(
          geometryTierForDetail(detailLevel),
        );
        if (allocated !== null) headSlot = allocated;
      }

      const turretMesh = buildTurretMesh3D(liftGroup, turret, unitGfx, {
        headGeom: this.turretHeadGeom,
        barrelGeom: this.barrelGeom,
        coneBarrelGeom: this.coneBarrelGeom,
        primaryMat: this.getPrimaryMat(ownerId),
        turretAccentMat: this.getTurretAccentMat(ownerId),
        shieldEmitterMat: this.getPrimaryMat(ownerId),
        showShieldEmitterCore,
        skipHead: headSlot !== undefined,
        skipBarrels: false,
        detailLevel,
      });
      if (turretMesh.head) turretMesh.head.userData.entityId = entity.id;
      if (isCommanderUnit && !hideHead) {
        this.commanderVisualKit.decorateTurret(
          turretMesh,
          turret.config.turretBlueprintId === commanderDgunTurretBlueprintId,
          this.getPrimaryMat(ownerId),
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
      if (!turret.config.passive) continue;
      shieldPanelTurret = turret;
      break;
    }
    const pivotLocalX = shieldPanelTurret?.mount.x ?? 0;
    const pivotLocalY = (shieldPanelTurret?.mount.z ?? getUnitBodyCenterHeight(entity.unit))
      - liftGroup.position.y;
    const pivotLocalZ = shieldPanelTurret?.mount.y ?? 0;
    const panelCount = shieldPanels.length;
    const allocedPanelSlots = useDetailedUnitInstancing && panelCount > 0
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
