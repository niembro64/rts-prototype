import * as THREE from 'three';
import type { ConcreteGraphicsQuality, GraphicsConfig } from '@/types/graphics';
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
import type { LegInstancedRenderer } from './LegInstancedRenderer';
import { getBodyGeom } from './BodyShape3D';
import type { CommanderVisualKit3D } from './CommanderVisualKit3D';
import type { EntityMesh } from './EntityMesh3D';
import { buildMirrorMesh3D } from './MirrorMesh3D';
import { buildTurretMesh3D, type TurretMesh } from './TurretMesh3D';
import type { UnitDetailInstanceRenderer3D } from './UnitDetailInstanceRenderer3D';

// Detailed unit parts use shared instanced pools by default. The
// per-mesh path remains only as an allocation fallback, not as the
// normal rendering route.
const USE_DETAILED_UNIT_INSTANCING = true;

export type UnitMeshBuilder3DOptions = {
  world: THREE.Group;
  unitDetailInstances: UnitDetailInstanceRenderer3D;
  commanderVisualKit: CommanderVisualKit3D;
  legRenderer: LegInstancedRenderer;
  turretHeadGeom: THREE.SphereGeometry;
  barrelGeom: THREE.CylinderGeometry;
  barrelMat: THREE.Material;
  mirrorGeom: THREE.BoxGeometry;
  mirrorArmGeom: THREE.BoxGeometry;
  mirrorSupportGeom: THREE.CylinderGeometry;
  getPrimaryMat: (playerId: PlayerId | undefined) => THREE.Material;
  getMirrorShinyMat: () => THREE.Material;
  getMapWidth: () => number;
  getMapHeight: () => number;
};

export type UnitMeshBuildRequest = {
  entity: Entity;
  radius: number;
  ownerId: PlayerId | undefined;
  turrets: readonly Turret[];
  unitGfx: GraphicsConfig;
  unitGraphicsTier: ConcreteGraphicsQuality;
  unitRenderKey: string;
  unitIsShell: boolean;
  legState?: LegStateSnapshot;
};

export function applyUnitLiftGroupPose3D(mesh: EntityMesh, entity: Entity): void {
  if (!mesh.liftGroup) return;
  const suspension = entity.unit?.suspension;
  if (!suspension) {
    mesh.liftGroup.position.set(0, mesh.chassisLift ?? 0, 0);
    return;
  }
  mesh.liftGroup.position.set(
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
  private readonly barrelMat: THREE.Material;
  private readonly mirrorGeom: THREE.BoxGeometry;
  private readonly mirrorArmGeom: THREE.BoxGeometry;
  private readonly mirrorSupportGeom: THREE.CylinderGeometry;
  private readonly getPrimaryMat: UnitMeshBuilder3DOptions['getPrimaryMat'];
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
    this.barrelMat = options.barrelMat;
    this.mirrorGeom = options.mirrorGeom;
    this.mirrorArmGeom = options.mirrorArmGeom;
    this.mirrorSupportGeom = options.mirrorSupportGeom;
    this.getPrimaryMat = options.getPrimaryMat;
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
      unitGraphicsTier,
      unitRenderKey,
      unitIsShell,
      legState,
    } = request;

    const group = new THREE.Group();
    const blueprint = this.getUnitBlueprint(entity);
    const bodyShape = blueprint?.bodyShape ?? FALLBACK_UNIT_BODY_SHAPE;
    const bodyShapeKey = getUnitBodyShapeKey(bodyShape);
    const bodyEntry = getBodyGeom(bodyShape);
    const hideChassis = blueprint?.hideChassis === true;

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
    const useDetailedUnitInstancing = USE_DETAILED_UNIT_INSTANCING && !unitIsShell;
    let smoothChassisSlots: number[] | undefined;
    let polyChassisSlot: number | undefined;

    if (
      useDetailedUnitInstancing &&
      !hideChassis &&
      bodyEntry.isSmooth &&
      bodyEntry.parts.length > 0
    ) {
      smoothChassisSlots = this.unitDetailInstances.allocSmoothChassisSlots(bodyEntry.parts.length) ?? undefined;
    } else if (
      useDetailedUnitInstancing &&
      !hideChassis &&
      !bodyEntry.isSmooth &&
      bodyEntry.parts.length > 0
    ) {
      const allocated = this.unitDetailInstances.allocPolyChassisSlot(
        bodyShapeKey,
        bodyEntry.parts[0].geometry,
        entity.id,
      );
      if (allocated !== null) polyChassisSlot = allocated;
    }

    if (!hideChassis && !smoothChassisSlots && polyChassisSlot === undefined) {
      for (const part of bodyEntry.parts) {
        const mesh = new THREE.Mesh(part.geometry, this.getPrimaryMat(ownerId));
        mesh.position.set(part.x, part.y, part.z);
        mesh.scale.set(part.scaleX, part.scaleY, part.scaleZ);
        mesh.userData.entityId = entity.id;
        chassis.add(mesh);
        chassisMeshes.push(mesh);
      }
    }
    liftGroup.add(chassis);

    if (entity.commander) {
      const commanderKit = this.commanderVisualKit.buildKit(unitGraphicsTier);
      commanderKit.userData.entityId = entity.id;
      commanderKit.traverse((obj) => { obj.userData.entityId = entity.id; });
      chassis.add(commanderKit);
    }

    const turretMeshes = this.buildTurrets(
      liftGroup,
      entity,
      turrets,
      ownerId,
      unitGfx,
      unitGraphicsTier,
      useDetailedUnitInstancing,
      blueprint?.dgun?.turretId,
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
      hideChassis,
      turrets: turretMeshes,
      lodKey: unitRenderKey,
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
      this.getMapWidth(),
      this.getMapHeight(),
      this.legRenderer,
    );
    if (legState !== undefined) applyLegState(mesh.locomotion, legState);

    this.buildMirrors(mesh, liftGroup, entity, ownerId, useDetailedUnitInstancing);
    return mesh;
  }

  private getUnitBlueprint(entity: Entity): ReturnType<typeof getUnitBlueprint> | undefined {
    try {
      return getUnitBlueprint(entity.unit!.unitType);
    } catch {
      return undefined;
    }
  }

  private buildTurrets(
    liftGroup: THREE.Group,
    entity: Entity,
    turrets: readonly Turret[],
    ownerId: PlayerId | undefined,
    unitGfx: GraphicsConfig,
    unitGraphicsTier: ConcreteGraphicsQuality,
    useDetailedUnitInstancing: boolean,
    commanderDgunTurretId: string | undefined,
  ): TurretMesh[] {
    const turretMeshes: TurretMesh[] = [];
    const turretOff = unitGfx.turretStyle === 'none';
    const isCommanderUnit = isCommander(entity);
    for (let turretIdx = 0; turretIdx < turrets.length; turretIdx++) {
      const turret = turrets[turretIdx];
      const isForceField = (turret.config.barrel as { type?: string } | undefined)?.type === 'complexSingleEmitter';
      const isConstructionEmitter = turret.config.constructionEmitter !== undefined;
      const hideHead = turretOff || isForceField || isConstructionEmitter;
      let headSlot: number | undefined;
      if (useDetailedUnitInstancing && !hideHead && !isCommanderUnit) {
        const allocated = this.unitDetailInstances.allocTurretHeadSlot();
        if (allocated !== null) headSlot = allocated;
      }

      const turretMesh = buildTurretMesh3D(liftGroup, turret, unitGfx, {
        headGeom: this.turretHeadGeom,
        barrelGeom: this.barrelGeom,
        barrelMat: this.barrelMat,
        primaryMat: this.getPrimaryMat(ownerId),
        skipHead: headSlot !== undefined,
        skipBarrels: false,
      });
      if (turretMesh.head) turretMesh.head.userData.entityId = entity.id;
      if (isCommanderUnit && !hideHead) {
        this.commanderVisualKit.decorateTurret(
          turretMesh,
          turret.config.id === commanderDgunTurretId,
          unitGraphicsTier,
        );
      }
      for (const barrel of turretMesh.barrels) barrel.userData.entityId = entity.id;
      turretMesh.headSlot = headSlot;

      if (useDetailedUnitInstancing && turretMesh.barrels.length > 0) {
        const barrelSlots = this.unitDetailInstances.allocBarrelSlots(turretMesh.barrels.length);
        if (barrelSlots) {
          turretMesh.barrelSlots = barrelSlots;
          for (const barrel of turretMesh.barrels) barrel.parent?.remove(barrel);
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
    ownerId: PlayerId | undefined,
    useDetailedUnitInstancing: boolean,
  ): void {
    const mirrorPanels = entity.unit?.mirrorPanels;
    if (!mirrorPanels || mirrorPanels.length === 0 || !entity.unit) return;

    const panelHalfSide = mirrorPanels[0].halfWidth;
    const panelArmLength = mirrorPanels[0].offsetX;
    const panelCenterY = getUnitBodyCenterHeight(entity.unit) - liftGroup.position.y;
    const panelCount = mirrorPanels.length;
    const allocedPanelSlots = useDetailedUnitInstancing && panelCount > 0
      ? this.unitDetailInstances.allocMirrorPanelSlots(panelCount)
      : null;
    const allMirrorAlloc = allocedPanelSlots !== null;
    mesh.mirrors = buildMirrorMesh3D(
      liftGroup,
      mirrorPanels,
      panelCenterY,
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
