import * as THREE from 'three';
import {
  CONSTRUCTION_HAZARD_MARKING_STYLE,
  CONSTRUCTION_HOST_MARKING_PROFILES,
} from '@/constructionVisualConfig';
import {
  FOREST_SPRUCE2_LEAF_COLOR,
  FOREST_SPRUCE2_WOOD_COLOR,
} from '@/config';
import type { GraphicsConfig } from '@/types/graphics';
import {
  BUILDING_BLUEPRINT_IDS,
  RAY_BLUEPRINT_IDS,
  SHIELD_BLUEPRINT_IDS,
  SHOT_BLUEPRINT_IDS,
  STRUCTURE_BLUEPRINT_IDS,
  TURRET_BLUEPRINT_IDS,
  UNIT_BLUEPRINT_IDS,
  type StructureBlueprintId,
  type UnitBlueprintId,
} from '@/types/blueprintIds';
import {
  getBuildingBlueprint,
  getRayBlueprint,
  SHIELD_BLUEPRINTS,
  getShotBlueprint,
  TURRET_BLUEPRINTS,
  getUnitBlueprint,
} from '../sim/blueprints';
import { BUILD_GRID_CELL_SIZE } from '../sim/buildGrid';
import {
  getTurretBarrelCenterToTipLength,
  getTurretBarrelDiameter,
  getTurretHeadRadius,
} from '../math/BarrelGeometry';
import { buildStandingRig, poseStandingRigAtRest } from './StandingRig3D';
import { resolveMirroredLegConfigs } from '../math/LegLayout';
import { getTurretConfig } from '../sim/turretConfigs';
import type { Turret } from '../sim/types';
import { buildAlbatrosChassis } from './AlbatrosMesh3D';
import { getBodyGeom, type BodyMeshPart } from './BodyShape3D';
import { buildBuildingShape, type BuildingShape } from './BuildingShape3D';
import { CommanderVisualKit3D } from './CommanderVisualKit3D';
import {
  DETAIL_RUNG_CLOSE,
  DETAIL_RUNG_FAR,
  DETAIL_RUNG_GLYPH,
  DETAIL_RUNG_MID,
  detailLevelForRung,
  featureVisibleAtDetail,
} from './EntityDetailLevel3D';
import {
  PLASMA_PROJECTILE_TRIANGLE_COUNTS,
  ROCKET_PROJECTILE_TRIANGLE_COUNTS,
  composeProjectileTailPose3D,
  createLowResolutionRocketGeometry,
} from './ProjectileRenderer3D';
import {
  BEAM_LOW_LOD_OPACITY,
  BEAM_UPDATE_BUCKET_COUNT,
  beamImposterWorldRadiusForSegment,
  beamUpdateBucketForEntityId,
  composeBeamSegmentMatrix3D,
  createBeamSegmentPoseScratch3D,
} from './BeamRenderer3D';
import { BEAM_OUTER_VISUAL_CONFIG } from './BeamWaveVisual3D';
import {
  createExtrudedEquilateralTriangleGeometry,
  createPrimitiveCylinderGeometry,
  createPrimitiveSphereGeometry,
  createPrimitiveTetrahedronGeometry,
  geometryEnclosedVolume,
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';
import { buildFlippers } from './FlipperRig3D';
import { buildFlyingRig } from './FlyingRig3D';
import { buildHoverFans } from './HoverRig3D';
import {
  applyLocomotionState,
  captureLocomotionState,
  getChassisLift,
  type Locomotion3DMesh,
} from './Locomotion3D';
import { buildLegs, freeLegSlots } from './LegRig3D';
import { LegInstancedRenderer } from './LegInstancedRenderer';
import { buildShieldPanelMesh3D } from './ShieldPanelMesh3D';
import { buildSwimRig } from './SwimRig3D';
import { buildTreads } from './TreadRig3D';
import { buildTurretMesh3D, type TurretMesh } from './TurretMesh3D';
import { buildWheels } from './WheelRig3D';
import type { EntityMesh } from './EntityMesh3D';
import {
  applyEntityLodVisualState3D,
  captureEntityLodVisualState3D,
} from './EntityLodVisualState3D';
import { applySolarCollectorPetalPose } from './SolarCollectorMesh3D';
import {
  SEAWEED_ASSET_SCALE,
  getVegetationAssetOptions,
} from '@/vegetationAssets';
import {
  VEGETATION_PLACEMENT_CONFIG,
  getVegetationKindConfig,
} from '@/vegetationConfig';
import {
  buildEnvironmentGrassLodGeometry,
  createEnvironmentLowTreeCrownGeometry,
  environmentLodFlatMaterialSpec,
  environmentPropVisibleAtDetailRung,
  environmentPropUsesGrassPresentation,
} from './EnvironmentPropRenderer3D';
import {
  buildConstructionHazardSleeve,
  buildConstructionHostMarking,
  buildLinearHazardStripePolygons,
} from './ConstructionHostMarking3D';

const TIERS = ['close', 'mid', 'far'] as const satisfies readonly PrimitiveGeometryTier[];
const DETAIL_LEVELS = [
  detailLevelForRung(DETAIL_RUNG_CLOSE),
  detailLevelForRung(DETAIL_RUNG_MID),
  detailLevelForRung(DETAIL_RUNG_FAR),
] as const;
const BEAM_TURRET_IDS: ReadonlySet<string> = new Set([
  'turretBeam',
  'turretBeamMini',
  'turretBeamMega',
  'turretBeamLong',
]);

/**
 * Canonical side-by-side visual-regression roster. Keeping this sourced from
 * the wire-stable registries makes additions fail the contract until the new
 * model participates in the same High/Medium/Low gallery.
 */
export const ENTITY_LOD_VISUAL_REGRESSION_ROSTER = Object.freeze({
  units: UNIT_BLUEPRINT_IDS,
  buildings: BUILDING_BLUEPRINT_IDS,
});

const FULL_GFX: GraphicsConfig = {
  hudFrameStride: 1,
  effectFrameStride: 1,
  terrainTileFrameStride: 1,
  terrainTileSideWalls: true,
  waterSubdivisions: 8,
  waterFrameStride: 1,
  waterWaveAmplitude: 1,
  unitShape: 'full',
  legs: 'full',
  chassisDetail: true,
  paletteShading: true,
  turretStyle: 'full',
  forceTurretStyle: 'full',
  barrelSpin: true,
  beamStyle: 'complex',
  beamGlow: true,
  antialias: true,
  burnMarkDensity: 1,
  groundPrintDensity: 1,
  projectileStyle: 'full',
  fireExplosionStyle: 'inferno',
};

type TierCounts = Readonly<{ close: number; mid: number; far: number }>;

/** Composite body + mounted-turret ceilings, deliberately exhaustive. */
const STRUCTURE_TRIANGLE_BUDGETS: Record<StructureBlueprintId, TierCounts> = {
  buildingSolar: { close: 1600, mid: 700, far: 300 },
  buildingWind: { close: 1100, mid: 550, far: 300 },
  buildingExtractor: { close: 800, mid: 450, far: 260 },
  buildingExtractorT2: { close: 1000, mid: 550, far: 340 },
  buildingRadar: { close: 1500, mid: 700, far: 350 },
  buildingSonar: { close: 1500, mid: 700, far: 350 },
  buildingResourceConverter: { close: 1500, mid: 750, far: 420 },
  towerFabricator: { close: 1700, mid: 850, far: 420 },
  towerBeamMega: { close: 900, mid: 500, far: 260 },
  towerCannon: { close: 1000, mid: 600, far: 320 },
  towerAntiAir: { close: 1200, mid: 750, far: 440 },
  towerTorpedo: { close: 1100, mid: 650, far: 360 },
};

/** Full visible unit ceilings: body + locomotion + physical turrets + unique kit/panel art. */
const UNIT_TRIANGLE_BUDGETS: Record<UnitBlueprintId, TierCounts> = {
  unitJackal: { close: 380, mid: 250, far: 130 },
  unitLynx: { close: 1150, mid: 580, far: 210 },
  unitDaddy: { close: 2700, mid: 1050, far: 330 },
  unitBadger: { close: 1150, mid: 600, far: 230 },
  unitMongoose: { close: 420, mid: 280, far: 140 },
  unitTick: { close: 2550, mid: 950, far: 270 },
  unitHuman: { close: 2550, mid: 950, far: 270 },
  unitMammoth: { close: 1200, mid: 620, far: 220 },
  unitFormik: { close: 4100, mid: 1500, far: 520 },
  unitWidow: { close: 3600, mid: 1450, far: 560 },
  unitHippo: { close: 1500, mid: 720, far: 280 },
  unitSeaTurtle: { close: 1250, mid: 700, far: 320 },
  unitOrca: { close: 1200, mid: 620, far: 280 },
  unitTarantula: { close: 2750, mid: 1100, far: 320 },
  unitLoris: { close: 1450, mid: 720, far: 280 },
  unitBee: { close: 1250, mid: 650, far: 240 },
  unitDragonfly: { close: 1500, mid: 780, far: 330 },
  unitConstructionDrone: { close: 2200, mid: 1000, far: 420 },
  unitConstructionSubmarine: { close: 1500, mid: 760, far: 320 },
  unitEagle: { close: 600, mid: 420, far: 220 },
  unitDuck: { close: 600, mid: 420, far: 220 },
  unitAlbatros: { close: 1350, mid: 850, far: 420 },
  unitQueenBee: { close: 2350, mid: 1100, far: 450 },
  unitQueenTick: { close: 1250, mid: 780, far: 340 },
  unitTransport: { close: 2150, mid: 1050, far: 410 },
  unitCommander: { close: 4200, mid: 1900, far: 700 },
};

const INTENTIONAL_ZERO_TURRETS = new Set<string>([
  'turretDisruptor',
  'turretSpawnBuildingsAndTowers',
  'turretSpawnUnits',
  'turretResourcePylonExtractionMetal',
  'turretResourcePylonExtractionEnergy',
]);

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[entity lod geometry contract] ${message}`);
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex();
  return (index?.count ?? geometry.getAttribute('position').count) / 3;
}

function objectTriangleCount(root: THREE.Object3D): number {
  let count = 0;
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || !object.visible) return;
    count += triangleCount(object.geometry);
  });
  return count;
}

function n(value: number): number {
  return Object.is(value, -0) ? 0 : Number(value.toFixed(7));
}

function transformTuple(object: THREE.Object3D): readonly number[] {
  const tuple = [
    n(object.position.x), n(object.position.y), n(object.position.z),
    n(object.quaternion.x), n(object.quaternion.y), n(object.quaternion.z), n(object.quaternion.w),
    n(object.scale.x), n(object.scale.y), n(object.scale.z),
  ];
  if (!object.matrixAutoUpdate) tuple.push(...object.matrix.toArray().map(n));
  return tuple;
}

function assertSame(label: string, a: unknown, b: unknown): void {
  const left = JSON.stringify(a);
  const right = JSON.stringify(b);
  assertContract(left === right, `${label} differs: ${left} !== ${right}`);
}

function assertRelativeNear(label: string, a: number, b: number): void {
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  assertContract(
    Math.abs(a - b) <= scale * 1e-5,
    `${label} differs: ${a} !== ${b}`,
  );
}

function assertDescending(label: string, counts: readonly number[]): void {
  assertContract(counts.length === 3, `${label} has all three tiers`);
  assertContract(counts[0] >= counts[1], `${label} High ${counts[0]} >= Medium ${counts[1]}`);
  assertContract(counts[1] >= counts[2], `${label} Medium ${counts[1]} >= Low ${counts[2]}`);
}

function bodyPartSignature(part: BodyMeshPart): readonly number[] {
  return [
    n(part.x), n(part.y), n(part.z),
    n(part.scaleX), n(part.scaleY), n(part.scaleZ), n(part.rotZ ?? 0),
  ];
}

function syntheticTurret(turretBlueprintId: string): Turret {
  return {
    config: getTurretConfig(turretBlueprintId),
    mount: { x: 0, y: 0, z: 0 },
  } as Turret;
}

type TurretBuild = {
  mesh: TurretMesh;
  count: number;
  signature: unknown;
};

function buildTurretForTier(
  turretBlueprintId: string,
  tierIndex: number,
  material: THREE.Material,
  closeHead: THREE.SphereGeometry,
  closeBarrel: THREE.CylinderGeometry,
  closeCone: THREE.CylinderGeometry,
): TurretBuild {
  const parent = new THREE.Group();
  const mesh = buildTurretMesh3D(parent, syntheticTurret(turretBlueprintId), FULL_GFX, {
    headGeom: closeHead,
    barrelGeom: closeBarrel,
    coneBarrelGeom: closeCone,
    primaryMat: material,
    barrelMat: material,
    shieldEmitterMat: material,
    showShieldEmitterCore: true,
    skipHead: false,
    skipBarrels: false,
    detailLevel: DETAIL_LEVELS[tierIndex],
  });
  const signature = {
    root: transformTuple(mesh.root),
    head: mesh.head ? transformTuple(mesh.head) : null,
    pitch: mesh.pitchGroup ? transformTuple(mesh.pitchGroup) : null,
    spin: mesh.spinGroup ? transformTuple(mesh.spinGroup) : null,
    barrels: mesh.barrels.map(transformTuple),
    pylonRoots: mesh.constructionEmitter?.pylons.map((pylon) => [
      ...pylon.rootLocal.toArray().map(n),
      ...pylon.topLocal.toArray().map(n),
    ]) ?? [],
  };
  return { mesh, count: objectTriangleCount(mesh.root), signature };
}

function pylonSignature(shape: BuildingShape): unknown {
  const pylon = (value: { rootLocal: THREE.Vector3; topLocal: THREE.Vector3 }) => [
    ...value.rootLocal.toArray().map(n),
    ...value.topLocal.toArray().map(n),
  ];
  return {
    solar: shape.solarRig ? pylon(shape.solarRig.pylon) : null,
    wind: shape.windRig ? {
      root: transformTuple(shape.windRig.root),
      rotor: transformTuple(shape.windRig.rotor),
      pylon: pylon(shape.windRig.pylon),
    } : null,
    extractor: shape.extractorRig ? {
      rotors: shape.extractorRig.rotors.map(transformTuple),
      pylon: pylon(shape.extractorRig.pylon),
    } : null,
    radar: shape.radarRig ? {
      head: transformTuple(shape.radarRig.head),
      sweep: transformTuple(shape.radarRig.sweep),
    } : null,
    converter: shape.converterRig ? {
      energy: pylon(shape.converterRig.energyPylon),
      metal: pylon(shape.converterRig.metalPylon),
    } : null,
  };
}

function buildingSignature(shape: BuildingShape): unknown {
  return {
    height: n(shape.height),
    bodyless: shape.bodyless === true,
    primary: transformTuple(shape.primary),
    details: shape.details.map((detail) => [detail.role ?? 'static', ...transformTuple(detail.mesh)]),
    functional: pylonSignature(shape),
  };
}

function runBodyContracts(material: THREE.Material): Map<UnitBlueprintId, TierCounts> {
  const countsByUnit = new Map<UnitBlueprintId, TierCounts>();
  const locomotionTypes = new Set<string>();
  for (const unitId of UNIT_BLUEPRINT_IDS) {
    const blueprint = getUnitBlueprint(unitId);
    locomotionTypes.add(blueprint.unitLocomotion.type);
    const entries = TIERS.map((tier) => getBodyGeom(blueprint.bodyShape, tier));
    const signatures = entries.map((entry) => ({
      topY: n(entry.topY),
      smooth: entry.isSmooth,
      parts: entry.parts.map(bodyPartSignature),
    }));
    assertSame(`${unitId} body High/Medium layout`, signatures[0], signatures[1]);
    assertSame(`${unitId} body Medium/Low layout`, signatures[1], signatures[2]);
    const counts = entries.map((entry) => entry.parts.reduce(
      (sum, part) => sum + triangleCount(part.geometry), 0,
    ));
    const volumes = entries.map((entry) => entry.parts.reduce(
      (sum, part) => sum + geometryEnclosedVolume(part.geometry)
        * Math.abs(part.scaleX * part.scaleY * part.scaleZ),
      0,
    ));
    if (blueprint.bodyShape === null) {
      assertContract(
        counts.every((count) => count === 0),
        `${unitId} has no standalone chassis geometry at H/M/L`,
      );
    } else {
      assertContract(counts.every((count) => count > 0), `${unitId} body resolves H/M/L geometry`);
      assertDescending(`${unitId} body`, counts);
      assertRelativeNear(`${unitId} body High/Medium volume`, volumes[0], volumes[1]);
      assertRelativeNear(`${unitId} body Medium/Low volume`, volumes[1], volumes[2]);
    }
    // PRISM-AUTHORED BODIES ARE SPHEROIDS. A blueprint saying "hexagon, 0.55
    // across, 0.3 tall" is describing the room the hull takes up, not that it
    // is faceted, and it is rendered as one squashed sphere fitted to that
    // footprint. Checked against the AUTHORED numbers rather than against the
    // fitting code, so this fails if the fit drifts rather than agreeing with
    // whatever the fit currently does.
    const shape = blueprint.bodyShape;
    if (shape !== null
      && (shape.kind === 'polygon' || shape.kind === 'rect' || shape.kind === 'rhombus')) {
      const halfX = shape.kind === 'polygon' ? shape.radiusFrac : shape.lengthFrac / 2;
      const halfZ = shape.kind === 'polygon' ? shape.radiusFrac : shape.widthFrac / 2;
      for (const [tierIndex, entry] of entries.entries()) {
        const label = `${unitId}/${TIERS[tierIndex]}`;
        assertContract(
          entry.isSmooth && entry.parts.length === 1,
          `${label} prism-authored body must render as one smooth spheroid`,
        );
        const part = entry.parts[0];
        // Never past the footprint it was authored with: the turret's mount
        // height, the locomotion's lateral clearance and the team kit's fit
        // are all derived from these same numbers, and a body that outgrew
        // them would leave every one of them wrong in a different way.
        assertContract(
          Math.abs(part.x) + part.scaleX <= halfX + 1e-9
            && Math.abs(part.z) + part.scaleZ <= halfZ + 1e-9,
          `${label} spheroid body grows past its authored footprint`,
        );
        // ...but it does have to fill it, or the unit visibly shrank.
        assertContract(
          part.scaleX > halfX * 0.4 && part.scaleZ > halfZ * 0.4,
          `${label} spheroid body collapsed inside its footprint`,
        );
        // Seated on the ground and reaching exactly the authored top, which is
        // where the turret mounts.
        assertContract(
          Math.abs(part.y - part.scaleY) < 1e-9
            && Math.abs(part.y + part.scaleY - shape.heightFrac) < 1e-9,
          `${label} spheroid body must span 0..heightFrac exactly`,
        );
      }
      // And it must genuinely simplify between rungs. This is the thing a
      // prism could not do — there was nothing in a hexagonal extrusion to
      // take away, so all three rungs shared one geometry.
      assertContract(
        counts[0] > counts[2],
        `${unitId} spheroid body must shed triangles between High and Low`,
      );
    }
    countsByUnit.set(unitId, { close: counts[0], mid: counts[1], far: counts[2] });
  }
  for (const type of [
    'wheels', 'treads', 'amphibious-treads', 'legs', 'standing', 'flippers', 'hover', 'flying', 'submarine', 'dive',
  ]) {
    assertContract(locomotionTypes.has(type), `authored roster exercises ${type} locomotion LOD`);
  }

  const albatrosBuilds = TIERS.map((tier) => {
    const root = new THREE.Group();
    const meshes = buildAlbatrosChassis(root, material, 1, tier);
    return {
      count: objectTriangleCount(root),
      signature: meshes.map(transformTuple),
    };
  });
  assertSame('Albatross High/Medium chassis layout', albatrosBuilds[0].signature, albatrosBuilds[1].signature);
  assertSame('Albatross Medium/Low chassis layout', albatrosBuilds[1].signature, albatrosBuilds[2].signature);
  assertDescending('Albatross chassis', albatrosBuilds.map((build) => build.count));
  countsByUnit.set('unitAlbatros', {
    close: albatrosBuilds[0].count,
    mid: albatrosBuilds[1].count,
    far: albatrosBuilds[2].count,
  });

  const commanderKit = new CommanderVisualKit3D();
  const commanderBuilds = TIERS.map((tier) => {
    const root = commanderKit.buildKit(material, tier);
    return { count: objectTriangleCount(root), signature: root.children.map(transformTuple) };
  });
  assertSame('Commander High/Medium kit layout', commanderBuilds[0].signature, commanderBuilds[1].signature);
  assertSame('Commander Medium/Low kit layout', commanderBuilds[1].signature, commanderBuilds[2].signature);
  assertDescending('Commander visual kit', commanderBuilds.map((build) => build.count));
  const commanderBody = countsByUnit.get('unitCommander');
  assertContract(commanderBody !== undefined, 'Commander body participates in unit budgets');
  countsByUnit.set('unitCommander', {
    close: commanderBody.close + commanderBuilds[0].count,
    mid: commanderBody.mid + commanderBuilds[1].count,
    far: commanderBody.far + commanderBuilds[2].count,
  });
  commanderKit.dispose();
  return countsByUnit;
}

function runLocomotionContracts(): Map<UnitBlueprintId, TierCounts> {
  const countsByUnit = new Map<UnitBlueprintId, TierCounts>();
  runLegLocomotionStateContract();
  for (const unitId of UNIT_BLUEPRINT_IDS) {
    const blueprint = getUnitBlueprint(unitId);
    const locomotion = blueprint.unitLocomotion;
    if (locomotion.type === 'legs') {
      const legCount = resolveMirroredLegConfigs(
        locomotion.config, blueprint.radius.other,
      ).all.length;
      // Struts, joints and feet live in the shared instanced pools rather than
      // under this root, so this is the roster's standing per-limb accounting
      // figure, not a triangle count taken off a scene graph.
      countsByUnit.set(unitId, {
        close: legCount * 204,
        mid: legCount * 68,
        far: legCount * 20,
      });
      continue;
    }
    const builds = TIERS.map((tier, tierIndex) => {
      const root = new THREE.Group();
      const radius = blueprint.radius.other;
      switch (locomotion.type) {
        case 'wheels': {
          const rig = buildWheels(root, radius, locomotion.config, undefined, tier);
          assertContract(
            rig.rotationAnimated === (tier !== 'far'),
            `${unitId}/${tier} wheel rotation matches its geometry rung`,
          );
          if (tier === 'far') {
            assertContract(
              rig.wheels.every((wheel) => wheel.geometry.type === 'BoxGeometry'),
              `${unitId}/far wheels are non-rotating boxes`,
            );
          }
          return {
            rig,
            count: objectTriangleCount(root),
            signature: {
              root: transformTuple(rig.group),
              mounts: rig.wheelMounts.map((mount) => [
                n(mount.localX), n(mount.localZ), n(mount.wheelR), n(mount.maxLift),
              ]),
              pivots: rig.wheelGroups.map(transformTuple),
              wheels: rig.wheels.map(transformTuple),
            },
          };
        }
        case 'treads':
        case 'amphibious-treads': {
          const cleatsVisible = featureVisibleAtDetail(
            'treadCleats',
            DETAIL_LEVELS[tierIndex],
          );
          const rig = buildTreads(
            root,
            radius,
            locomotion.config,
            cleatsVisible,
            undefined,
            tier,
          );
          assertContract(
            rig.rotationAnimated === cleatsVisible,
            `${unitId}/${tier} tread rotation matches its geometry rung`,
          );
          assertContract(
            cleatsVisible ? rig.cleats.length > 0 : rig.cleats.length === 0,
            `${unitId}/${tier} tread cleats match the shared LOD feature rung`,
          );
          if (tier === 'far') {
            assertContract(
              rig.wheels.length === 0 && rig.cleats.length === 0 &&
                rig.sides.every((side) =>
                  side.group.children.length === 1 &&
                  (side.group.children[0] as THREE.Mesh).geometry.type === 'BoxGeometry'),
              `${unitId}/far treads are one static envelope box per side`,
            );
          }
          return {
            rig,
            count: objectTriangleCount(root),
            signature: {
              root: transformTuple(rig.group),
              sides: rig.sides.map((side) => [
                side.side, n(side.lateralOffset), ...transformTuple(side.group),
              ]),
              loop: [n(rig.cleatLoopLength), n(rig.treadStraightLength), n(rig.treadRadius)],
            },
          };
        }
        case 'standing': {
          const rig = buildStandingRig(
            root, radius, locomotion.config.legs, locomotion.config.arms,
            0, undefined, tier,
          );
          poseStandingRigAtRest(rig);
          assertContract(
            rig.legs.length === 2 && rig.arms.length === 2,
            `${unitId}/${tier} stand is a biped: two legs and two arms`,
          );
          assertContract(
            rig.legs.every((leg) => Math.abs(leg.hipZ) > 1e-6)
              && rig.legs[0].hipZ === -rig.legs[1].hipZ,
            `${unitId}/${tier} stand legs sit on a mirrored pair of planes`,
          );
          // The whole point of the rig: a knee is a hinge in its leg's plane,
          // so no part of a limb may leave the lateral offset it was built on.
          assertContract(
            rig.legs.every((leg) =>
              Math.abs(leg.knee.position.z - leg.hipZ) < 1e-6
              && Math.abs(leg.foot.position.z - leg.hipZ) < 1e-6),
            `${unitId}/${tier} stand knees and feet stay in their leg's plane`,
          );
          return {
            rig,
            count: objectTriangleCount(root),
            signature: {
              root: transformTuple(rig.group),
              legs: rig.legs.map((leg) => [
                leg.side, n(leg.hipX), n(leg.hipY), n(leg.hipZ),
                n(leg.thighLength), n(leg.shinLength), n(leg.phaseOffset),
                ...transformTuple(leg.knee), ...transformTuple(leg.foot),
              ]),
              arms: rig.arms.map((arm) => [
                arm.side, n(arm.shoulderX), n(arm.shoulderY), n(arm.shoulderZ),
                n(arm.handX), n(arm.handY), ...transformTuple(arm.elbow),
              ]),
              stride: [n(rig.strideLength), n(rig.strideLift), n(rig.standHipY)],
            },
          };
        }
        case 'flippers': {
          const rig = buildFlippers(root, radius, locomotion.config, undefined, tier);
          return {
            rig,
            count: objectTriangleCount(root),
            signature: {
              root: transformTuple(rig.group),
              panels: rig.panels.map((panel) => [
                panel.side, panel.front, n(panel.phaseOffset), n(panel.groundDownAngle),
                ...transformTuple(panel.hinge),
              ]),
            },
          };
        }
        case 'hover': {
          const smokeUseId = unitId === 'unitDragonfly'
            ? 'locomotionDragonflyHovercraft'
            : 'locomotionHovercraft';
          const rig = buildHoverFans(
            root, radius, locomotion.config, smokeUseId, 1, undefined, tier,
          );
          assertContract(
            rig.fans.every((fan) => {
              const ring = fan.group.children[0] as THREE.Mesh;
              const material = ring.material as THREE.Material;
              return ring.isMesh &&
                ring.geometry.type === 'TorusGeometry' &&
                material.side === THREE.DoubleSide;
            }),
            `${unitId}/${tier} hover fans retain a visible tiered duct ring`,
          );
          return {
            rig,
            count: objectTriangleCount(root),
            signature: {
              root: transformTuple(rig.group),
              fanSpin: n(rig.fanSpinRadPerSec),
              fans: rig.fans.map((fan) => ({
                group: transformTuple(fan.group),
                emitter: transformTuple(fan.emitter),
                exhaustSpeed: n(fan.exhaustSpeed),
              })),
            },
          };
        }
        case 'flying':
        case 'dive': {
          const smokeUseId = unitId === 'unitAlbatros'
            ? 'locomotionAlbatrosFlying'
            : 'locomotionEagleFlying';
          const rig = buildFlyingRig(
            root, radius, locomotion.config, smokeUseId, 1, undefined, tier,
          );
          return {
            rig,
            count: objectTriangleCount(root),
            signature: {
              root: transformTuple(rig.group),
              exhaustSpeed: n(rig.smokeExhaustSpeed),
              jets: rig.jets.map((jet) => ({
                group: transformTuple(jet.group),
                emitter: transformTuple(jet.emitter),
              })),
            },
          };
        }
        case 'submarine': {
          const rig = buildSwimRig(root, radius, locomotion.config, undefined, tier);
          const fanRing = rig.rearFan.group.children[0] as THREE.Mesh;
          assertContract(
            rig.pectoralHinges.length === 2 && fanRing.isMesh &&
              fanRing.geometry.type === 'TorusGeometry',
            `${unitId}/${tier} submarine keeps two front fins and a tiered rear hover-fan duct`,
          );
          return {
            rig,
            count: objectTriangleCount(root),
            signature: {
              root: transformTuple(rig.group),
              pectorals: rig.pectoralHinges.map(transformTuple),
              rearFan: {
                group: transformTuple(rig.rearFan.group),
                emitter: transformTuple(rig.rearFan.emitter),
                exhaustSpeed: n(rig.rearFan.exhaustSpeed),
              },
              cycle: [n(rig.cycleDistance), n(rig.strokeAngle)],
            },
          };
        }
      }
    });
    assertSame(`${unitId} locomotion High/Medium pose`, builds[0].signature, builds[1].signature);
    assertSame(`${unitId} locomotion Medium/Low pose`, builds[1].signature, builds[2].signature);
    assertContract(builds.every((build) => build.count > 0), `${unitId} locomotion resolves H/M/L geometry`);
    assertDescending(`${unitId} locomotion`, builds.map((build) => build.count));
    countsByUnit.set(unitId, {
      close: builds[0].count,
      mid: builds[1].count,
      far: builds[2].count,
    });
    seedLocomotionState(builds[0].rig);
    const snapshot = captureLocomotionState(builds[0].rig);
    applyLocomotionState(builds[2].rig, snapshot);
    assertSame(
      `${unitId} locomotion state survives High-to-Low rebuild`,
      captureLocomotionState(builds[2].rig),
      snapshot,
    );
  }
  return countsByUnit;
}

function runLegLocomotionStateContract(): void {
  const blueprint = getUnitBlueprint('unitTick');
  const locomotion = blueprint.unitLocomotion;
  assertContract(locomotion.type === 'legs', 'walking pose contract uses a legged unit');
  const highPoolRoot = new THREE.Group();
  const lowPoolRoot = new THREE.Group();
  const highRenderer = new LegInstancedRenderer(highPoolRoot);
  const lowRenderer = new LegInstancedRenderer(lowPoolRoot);
  const radius = blueprint.radius.other;
  const high = buildLegs(
    new THREE.Group(), radius, locomotion.config, 'full',
    getChassisLift(blueprint, radius), highRenderer, undefined, 'close',
  );
  const low = buildLegs(
    new THREE.Group(), radius, locomotion.config, 'full',
    getChassisLift(blueprint, radius), lowRenderer, undefined, 'far',
  );
  assertContract(high !== undefined && low !== undefined, 'walking unit resolves High/Low leg rigs');
  try {
    seedLocomotionState(high);
    const snapshot = captureLocomotionState(high);
    applyLocomotionState(low, snapshot);
    assertSame(
      'walking leg gait/contact state survives High-to-Low rebuild',
      captureLocomotionState(low),
      snapshot,
    );
    assertSame(
      'walking leg skeleton and attachment layout survives High-to-Low rebuild',
      low.legs.map((leg) => ({
        config: leg.config,
        side: leg.side,
        hipY: n(leg.hipY),
        phase: leg.phaseShift01,
      })),
      high.legs.map((leg) => ({
        config: leg.config,
        side: leg.side,
        hipY: n(leg.hipY),
        phase: leg.phaseShift01,
      })),
    );
  } finally {
    freeLegSlots(high, highRenderer);
    freeLegSlots(low, lowRenderer);
    highRenderer.destroy();
    lowRenderer.destroy();
  }
}

function seedLocomotionState(locomotion: Locomotion3DMesh): void {
  if (!locomotion) return;
  switch (locomotion.type) {
    case 'legs':
      locomotion.visualGrounded = false;
      locomotion.poseInitialized = true;
      locomotion.lastBaseX = 91;
      locomotion.lastBaseY = 37;
      locomotion.lastBaseZ = -24;
      for (let i = 0; i < locomotion.legs.length; i++) {
        const leg = locomotion.legs[i];
        leg.worldX = 10 + i;
        leg.worldY = 20 + i;
        leg.worldZ = 30 + i;
        leg.startWorldX = 40 + i;
        leg.startWorldY = 50 + i;
        leg.startWorldZ = 60 + i;
        leg.targetWorldX = 70 + i;
        leg.targetWorldY = 80 + i;
        leg.targetWorldZ = 90 + i;
        leg.contactState = i % 2 === 0 ? 'planted' : 'stepping';
        leg.lerpProgress = 0.17 * (i + 1);
        leg.lerpDuration = 120 + i;
        leg.initialized = true;
      }
      return;
    case 'wheels':
      for (let i = 0; i < locomotion.wheelMounts.length; i++) {
        locomotion.wheelMounts[i].lift = 1 + i;
        locomotion.wheelMounts[i].targetLift = 2 + i;
        locomotion.wheelMounts[i].angularVelocity = 3 + i;
        locomotion.wheelMounts[i].rotation = 0.2 + i;
        locomotion.wheels[i].rotation.y = locomotion.rotationAnimated ? 0.2 + i : 0;
        locomotion.wheelContacts[i].phase = 10 + i;
        locomotion.wheelContacts[i].initialized = true;
      }
      return;
    case 'treads':
      for (let i = 0; i < locomotion.sides.length; i++) {
        const side = locomotion.sides[i];
        side.lift = 1 + i;
        side.targetLift = 2 + i;
        side.beltPhase = 30 + i;
        side.beltVelocity = 4 + i;
        side.wheelRotation = 0.4 + i;
        side.group.position.y = 1 + i;
        locomotion.treadContacts[i].phase = 20 + i;
        locomotion.treadContacts[i].initialized = true;
      }
      for (let i = 0; i < locomotion.wheels.length; i++) {
        locomotion.wheels[i].rotation.y = locomotion.sides[locomotion.wheelSide[i]].wheelRotation;
      }
      return;
    case 'flippers':
      locomotion.contact.phase = 12;
      locomotion.contact.initialized = true;
      locomotion.waterBlend = 0.65;
      for (let i = 0; i < locomotion.panels.length; i++) {
        locomotion.panels[i].hinge.rotation.set(0.1 * i, 0.2 * i, 0.3 * i);
      }
      return;
    case 'hover':
      locomotion.clearance = 17;
      return;
    case 'flying':
      return;
    case 'swim':
      locomotion.contact.phase = 14;
      locomotion.contact.initialized = true;
      locomotion.pectoralHinges[0].rotation.z = 0.3;
      locomotion.pectoralHinges[1].rotation.z = -0.3;
      return;
  }
}

function runTurretContracts(material: THREE.Material): Map<string, TierCounts> {
  const closeHead = createPrimitiveSphereGeometry('turret', 'close');
  const closeBarrel = createPrimitiveCylinderGeometry('turret', 'close');
  const closeCone = createPrimitiveCylinderGeometry('turret', 'close', 0, 1);
  const countsByTurret = new Map<string, TierCounts>();
  for (const turretId of TURRET_BLUEPRINT_IDS) {
    const builds = TIERS.map((_, tierIndex) => buildTurretForTier(
      turretId,
      tierIndex,
      material,
      closeHead,
      closeBarrel,
      closeCone,
    ));
    assertSame(`${turretId} High/Medium functional layout`, builds[0].signature, builds[1].signature);
    assertSame(`${turretId} Medium/Low functional layout`, builds[1].signature, builds[2].signature);
    if (turretId === 'turretGatling') {
      assertContract(
        builds.every((build) => build.mesh.spinGroup !== undefined && build.mesh.barrels.length === 5),
        'Gatling retains its spin pivot and all five rotating barrels at H/M/L',
      );
    }
    if (turretId === 'turretAntiAir') {
      assertContract(
        builds.every((build) => build.mesh.barrels.length === 6),
        'Anti-Air retains all six aimed tubes at H/M/L',
      );
    }
    if (BEAM_TURRET_IDS.has(turretId)) {
      const blueprint = TURRET_BLUEPRINTS[turretId];
      const config = getTurretConfig(turretId);
      const barrel = config.barrel;
      assertContract(!config.headOnly, `${turretId} is an ordinary full-barrel turret`);
      assertContract(
        barrel?.type === 'singleConeBarrel',
        `${turretId} uses one aimed focusing-cone barrel`,
      );
      assertContract(config.shot?.type === 'beam', `${turretId} emits a beam ray`);
      assertContract(
        !Object.prototype.hasOwnProperty.call(blueprint.barrel, 'barrelThickness'),
        `${turretId} derives barrel width from its beam instead of an arbitrary override`,
      );

      const headRadius = getTurretHeadRadius(config);
      const barrelDiameter = getTurretBarrelDiameter(config);
      const centerToTipLength = getTurretBarrelCenterToTipLength(config);
      assertRelativeNear(`${turretId} barrel/beam width`, barrelDiameter, config.shot.width);
      assertContract(
        barrelDiameter <= headRadius * 2,
        `${turretId} barrel base fits within its turret head silhouette`,
      );
      assertContract(
        centerToTipLength > barrelDiameter,
        `${turretId} barrel is longer than its base is wide`,
      );
      assertContract(
        builds.every((build) => (
          build.mesh.barrelUsesCone === true &&
          build.mesh.pitchGroup !== undefined &&
          build.mesh.barrels.length === 1
        )),
        `${turretId} retains one pitched cone barrel at H/M/L`,
      );
      for (const build of builds) {
        const meshBarrel = build.mesh.barrels[0];
        assertRelativeNear(`${turretId} mesh barrel radius`, meshBarrel.scale.x, barrelDiameter / 2);
        assertRelativeNear(`${turretId} mesh barrel length`, meshBarrel.scale.y, centerToTipLength);
      }
    }
    const counts = builds.map((build) => build.count);
    assertDescending(turretId, counts);
    if (INTENTIONAL_ZERO_TURRETS.has(turretId)) {
      assertContract(counts.every((count) => count === 0), `${turretId} remains an intentional logical mount`);
    } else {
      assertContract(counts.every((count) => count > 0), `${turretId} resolves visible H/M/L geometry`);
    }
    countsByTurret.set(turretId, { close: counts[0], mid: counts[1], far: counts[2] });
  }
  const metalPylon = countsByTurret.get('turretResourcePylonConstructionMetal');
  // base + hazard band + straw outer/inner + 4-triangle tetrahedron cap
  // (the pylon head is a vertex-down tetrahedron at every tier).
  assertContract(
    metalPylon?.close === 148 && metalPylon.mid === 84 && metalPylon.far === 32,
    `construction pylon expected 148/84/32, got ${JSON.stringify(metalPylon)}`,
  );
  closeHead.dispose();
  closeBarrel.dispose();
  closeCone.dispose();
  return countsByTurret;
}

function runShieldPanelContract(material: THREE.Material): TierCounts {
  const panel = new THREE.BoxGeometry(1, 1, 1);
  const arm = new THREE.BoxGeometry(1, 1, 1);
  const support = createPrimitiveCylinderGeometry('unitDetail', 'close');
  const builds = TIERS.map((tier) => {
    const parent = new THREE.Group();
    const mesh = buildShieldPanelMesh3D(
      parent,
      [{ offsetX: 12, offsetY: 0, angle: 0 }],
      3, 4, 5, 8, 12,
      panel, arm, support, material, material, false, tier,
    );
    return {
      count: objectTriangleCount(mesh.root),
      signature: {
        root: transformTuple(mesh.root),
        panels: mesh.panels.map(transformTuple),
        arms: mesh.arms.map(transformTuple),
        frames: mesh.frames.map(transformTuple),
      },
    };
  });
  assertSame('Loris panel High/Medium pose', builds[0].signature, builds[1].signature);
  assertSame('Loris panel Medium/Low pose', builds[1].signature, builds[2].signature);
  assertDescending('Loris shield panel assembly', builds.map((build) => build.count));
  panel.dispose();
  arm.dispose();
  support.dispose();
  return {
    close: builds[0].count,
    mid: builds[1].count,
    far: builds[2].count,
  };
}

function runUnitCompositeContracts(
  bodyCounts: ReadonlyMap<UnitBlueprintId, TierCounts>,
  locomotionCounts: ReadonlyMap<UnitBlueprintId, TierCounts>,
  turretCounts: ReadonlyMap<string, TierCounts>,
  shieldPanelCounts: TierCounts,
): void {
  const violations: string[] = [];
  for (const unitId of UNIT_BLUEPRINT_IDS) {
    const blueprint = getUnitBlueprint(unitId);
    const body = bodyCounts.get(unitId);
    const locomotion = locomotionCounts.get(unitId);
    assertContract(body !== undefined, `${unitId} has tiered body counts`);
    assertContract(locomotion !== undefined, `${unitId} has tiered locomotion counts`);
    const composite = TIERS.map((tier) => {
      let count = body[tier] + locomotion[tier];
      for (const mount of blueprint.turrets) {
        const turret = turretCounts.get(mount.turretBlueprintId);
        assertContract(turret !== undefined, `${unitId} mount ${mount.turretBlueprintId} has tiered counts`);
        count += turret[tier];
      }
      if (unitId === 'unitLoris') count += shieldPanelCounts[tier];
      return count;
    });
    assertDescending(`${unitId} full composite`, composite);
    const budget = UNIT_TRIANGLE_BUDGETS[unitId];
    for (let i = 0; i < TIERS.length; i++) {
      if (composite[i] > budget[TIERS[i]]) {
        violations.push(
          `${unitId}/${TIERS[i]} expected <= ${budget[TIERS[i]]}, got ${composite[i]}`,
        );
      }
    }
  }
  assertContract(
    violations.length === 0,
    `unit composite triangle budgets exceeded: ${violations.join('; ')}`,
  );
}

function runStructureContracts(
  material: THREE.Material,
  turretCounts: ReadonlyMap<string, TierCounts>,
): void {
  const budgetViolations: string[] = [];
  for (const structureId of STRUCTURE_BLUEPRINT_IDS) {
    const blueprint = getBuildingBlueprint(structureId);
    const shapes = TIERS.map((tier) => buildBuildingShape(
      blueprint.renderProfile,
      blueprint.gridWidth * BUILD_GRID_CELL_SIZE,
      blueprint.gridHeight * BUILD_GRID_CELL_SIZE,
      material,
      structureId,
      tier,
    ));
    const signatures = shapes.map(buildingSignature);
    assertSame(`${structureId} High/Medium animation anchors`, signatures[0], signatures[1]);
    assertSame(`${structureId} Medium/Low animation anchors`, signatures[1], signatures[2]);
    const bodyCounts = shapes.map((shape) => {
      const root = new THREE.Group();
      root.add(shape.primary);
      for (const detail of shape.details) root.add(detail.mesh);
      return objectTriangleCount(root);
    });
    const mountedCounts = TIERS.map((tier) => blueprint.turrets.reduce((sum, mount) => {
      const counts = turretCounts.get(mount.turretBlueprintId);
      assertContract(counts !== undefined, `${structureId} mount ${mount.turretBlueprintId} has H/M/L geometry`);
      return sum + counts[tier];
    }, 0));
    const compositeCounts = bodyCounts.map((count, index) => count + mountedCounts[index]);
    assertContract(compositeCounts.every((count) => count > 0), `${structureId} resolves visible H/M/L geometry`);
    assertDescending(`${structureId} composite`, compositeCounts);
    const budget = STRUCTURE_TRIANGLE_BUDGETS[structureId];
    for (let i = 0; i < TIERS.length; i++) {
      if (compositeCounts[i] > budget[TIERS[i]]) {
        budgetViolations.push(
          `${structureId}/${TIERS[i]} expected <= ${budget[TIERS[i]]}, got ${compositeCounts[i]}`,
        );
      }
    }
  }
  assertContract(
    budgetViolations.length === 0,
    `structure triangle budgets exceeded: ${budgetViolations.join('; ')}`,
  );
}

function visualStateMesh(overrides: Partial<EntityMesh>): EntityMesh {
  return { turrets: [], ...overrides } as EntityMesh;
}

function seedPylonVisualState(
  pylon: NonNullable<EntityMesh['windRig']>['pylon'],
  offset: number,
): void {
  pylon.rootLocal.add(new THREE.Vector3(offset, offset * 2, offset * 3));
  pylon.topLocal.add(new THREE.Vector3(-offset, offset * 4, offset * 2));
  pylon.smoothedRate = 0.37 + offset;
  pylon.displaySmoothedRate = 0.61 + offset;
}

/** A geometry-tier rebuild must be a presentation swap, never an animation reset. */
function runVisualStateTransferContracts(material: THREE.Material): void {
  for (const structureId of ['buildingWind', 'buildingRadar', 'buildingSonar'] as const) {
    const blueprint = getBuildingBlueprint(structureId);
    const width = blueprint.gridWidth * BUILD_GRID_CELL_SIZE;
    const depth = blueprint.gridHeight * BUILD_GRID_CELL_SIZE;
    const high = buildBuildingShape(
      blueprint.renderProfile, width, depth, material, structureId, 'close',
    );
    const low = buildBuildingShape(
      blueprint.renderProfile, width, depth, material, structureId, 'far',
    );
    const source = visualStateMesh({
      buildingDetails: high.details,
      windRig: high.windRig,
      radarRig: high.radarRig,
      visualBankRoll: 0.29,
      solarOpenAmount: 0.71,
    });
    const target = visualStateMesh({
      buildingDetails: low.details,
      windRig: low.windRig,
      radarRig: low.radarRig,
    });
    if (source.windRig) {
      source.windRig.root.rotation.y = 0.73;
      source.windRig.rotor.rotation.z = -1.17;
      seedPylonVisualState(source.windRig.pylon, 0.13);
    }
    if (source.radarRig) {
      source.radarRig.head.rotation.y = -0.83;
      source.radarRig.sweep.rotation.z = 1.41;
    }
    const state = captureEntityLodVisualState3D(source);
    applyEntityLodVisualState3D(target, state);
    assertSame(
      `${structureId} animation state survives High-to-Low rebuild`,
      captureEntityLodVisualState3D(target),
      state,
    );
  }

  const solarBlueprint = getBuildingBlueprint('buildingSolar');
  const solarWidth = solarBlueprint.gridWidth * BUILD_GRID_CELL_SIZE;
  const solarDepth = solarBlueprint.gridHeight * BUILD_GRID_CELL_SIZE;
  const solarHigh = buildBuildingShape(
    solarBlueprint.renderProfile, solarWidth, solarDepth, material, 'buildingSolar', 'close',
  );
  const solarLow = buildBuildingShape(
    solarBlueprint.renderProfile, solarWidth, solarDepth, material, 'buildingSolar', 'far',
  );
  const solarOpenAmount = 0.37;
  assertContract(
    applySolarCollectorPetalPose(solarHigh.details, solarOpenAmount),
    'solar High mesh exposes animated petals',
  );
  const solarSource = visualStateMesh({
    buildingDetails: solarHigh.details,
    solarOpenAmount,
    solarPetalPoseAmount: solarOpenAmount,
  });
  const solarTarget = visualStateMesh({ buildingDetails: solarLow.details });
  applyEntityLodVisualState3D(solarTarget, captureEntityLodVisualState3D(solarSource));
  const solarPose = (details: NonNullable<EntityMesh['buildingDetails']>) => details
    .filter((detail) => detail.role === 'solarLeaf' || detail.role === 'solarPanel')
    .map((detail) => ({ role: detail.role, transform: transformTuple(detail.mesh) }));
  assertSame(
    'solar petal pose survives High-to-Low rebuild without detail-index drift',
    solarPose(solarTarget.buildingDetails!),
    solarPose(solarSource.buildingDetails!),
  );

  const head = createPrimitiveSphereGeometry('turret', 'close');
  const barrel = createPrimitiveCylinderGeometry('turret', 'close');
  const cone = createPrimitiveCylinderGeometry('turret', 'close', 0, 1);
  try {
    const high = buildTurretForTier(
      'turretResourcePylonConstructionMetal', 0, material, head, barrel, cone,
    ).mesh;
    const low = buildTurretForTier(
      'turretResourcePylonConstructionMetal', 2, material, head, barrel, cone,
    ).mesh;
    const emitter = high.constructionEmitter;
    assertContract(emitter !== undefined, 'construction pylon exposes its visual-state rig');
    emitter.smoothedRates.energy = 0.31;
    emitter.smoothedRates.metal = 0.47;
    emitter.displaySmoothedRates.energy = 0.59;
    emitter.displaySmoothedRates.metal = 0.67;
    emitter.lastPaidTargetId = 123;
    emitter.lastPaid.energy = 4.5;
    emitter.lastPaid.metal = 7.25;
    emitter.towerSpinAmount = 0.38;
    emitter.displayTowerSpinAmount = 0.52;
    emitter.towerSpinPhase = 1.23;
    for (let i = 0; i < emitter.pylons.length; i++) {
      seedPylonVisualState(emitter.pylons[i], 0.04 * (i + 1));
    }
    for (let i = 0; i < emitter.towerOrbitParts.length; i++) {
      const part = emitter.towerOrbitParts[i].mesh;
      part.position.set(i + 1, i + 2, i + 3);
      part.rotation.set(i * 0.1, i * 0.2, i * 0.3);
    }
    const source = visualStateMesh({ turrets: [high] });
    const target = visualStateMesh({ turrets: [low] });
    const state = captureEntityLodVisualState3D(source);
    applyEntityLodVisualState3D(target, state);
    assertSame(
      'construction emitter state survives High-to-Low rebuild',
      captureEntityLodVisualState3D(target),
      state,
    );
  } finally {
    head.dispose();
    barrel.dispose();
    cone.dispose();
  }
}

function runEmissionRegistryContracts(): void {
  for (const shotId of SHOT_BLUEPRINT_IDS) {
    const blueprint = getShotBlueprint(shotId);
    const counts = blueprint.type === 'plasma'
      ? PLASMA_PROJECTILE_TRIANGLE_COUNTS
      : ROCKET_PROJECTILE_TRIANGLE_COUNTS;
    assertContract(counts.high > 0 && counts.medium > 0 && counts.low > 0, `${shotId} resolves H/M/L geometry`);
    assertDescending(shotId, [counts.high, counts.medium, counts.low]);
  }
  for (const rayId of RAY_BLUEPRINT_IDS) {
    assertContract(getRayBlueprint(rayId).rayBlueprintId === rayId, `${rayId} participates in shared beam H/M/L geometry`);
  }
  for (const shieldId of SHIELD_BLUEPRINT_IDS) {
    assertContract(SHIELD_BLUEPRINTS[shieldId].shieldBlueprintId === shieldId, `${shieldId} participates in shield H/M/L policy`);
  }
}

function runEmissionPoseContracts(): void {
  assertContract(
    BEAM_LOW_LOD_OPACITY === BEAM_OUTER_VISUAL_CONFIG.waveHighAlpha,
    'Low beam transparency matches the canonical outer beam layer',
  );
  assertContract(
    BEAM_UPDATE_BUCKET_COUNT === 1,
    'beam paths and live turret origins refresh every render frame',
  );
  const bucketPopulation = new Array<number>(BEAM_UPDATE_BUCKET_COUNT).fill(0);
  for (let entityId = 1; entityId <= 256; entityId++) {
    const bucket = beamUpdateBucketForEntityId(entityId);
    assertContract(
      bucket === beamUpdateBucketForEntityId(entityId),
      `beam ${entityId} keeps a stable update bucket`,
    );
    bucketPopulation[bucket]++;
  }
  assertContract(
    bucketPopulation.every((population) => population > 0),
    'beam update hash distributes live IDs across every ring bucket',
  );
  const farImposterRadius = beamImposterWorldRadiusForSegment(
    {
      viewportHeightPx: 1080,
      cameraX: 0,
      cameraY: 0,
      cameraZ: 0,
      forwardX: 0,
      forwardY: 0,
      forwardZ: -1,
      fovYRad: Math.PI / 4,
      aspect: 1,
    },
    -10, -10000, 0,
    10, -10000, 0,
    0.35,
  );
  assertContract(
    farImposterRadius > 0.35,
    'far beam imposter expands enough to retain its minimum screen radius',
  );
  const nearToFarImposterRadius = beamImposterWorldRadiusForSegment(
    {
      viewportHeightPx: 1080,
      cameraX: 0,
      cameraY: 0,
      cameraZ: 0,
      forwardX: 0,
      forwardY: 0,
      forwardZ: -1,
      fovYRad: Math.PI / 4,
      aspect: 1,
    },
    0, -10, 0,
    0, -10000, 0,
    0.35,
  );
  assertContract(
    nearToFarImposterRadius === 0.35,
    'long Low beams use their closest camera distance instead of inflating from the midpoint',
  );

  const reflectedPath = [
    new THREE.Vector3(3, 5, 7),
    new THREE.Vector3(17, -2, 11),
    new THREE.Vector3(23, 19, 4),
    new THREE.Vector3(-6, 31, 13),
  ];
  const beamTierPoses = TIERS.map(() => {
    const scratch = createBeamSegmentPoseScratch3D();
    const matrix = new THREE.Matrix4();
    const poses: number[][] = [];
    for (let i = 0; i < reflectedPath.length - 1; i++) {
      const a = reflectedPath[i];
      const b = reflectedPath[i + 1];
      composeBeamSegmentMatrix3D(
        matrix,
        scratch,
        a.x, a.y, a.z,
        b.x, b.y, b.z,
        2.75,
        a.distanceTo(b),
      );
      poses.push(matrix.toArray().map(n));
    }
    return poses;
  });
  assertSame('reflected beam High/Medium path poses', beamTierPoses[0], beamTierPoses[1]);
  assertSame('reflected beam Medium/Low path poses', beamTierPoses[1], beamTierPoses[2]);

  const direction = new THREE.Vector3(0.31, 0.47, -0.826).normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0), direction,
  );
  const axisPose = new Float32Array([
    direction.x, direction.y, direction.z,
    quaternion.x, quaternion.y, quaternion.z, quaternion.w,
  ]);
  const projectileTierPoses = TIERS.map(() => {
    const outDirection = new THREE.Vector3();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    composeProjectileTailPose3D(
      axisPose, 0,
      101, -37, 53,
      28, 3.5,
      outDirection, position, rotation, scale,
    );
    return {
      direction: outDirection.toArray().map(n),
      matrix: new THREE.Matrix4().compose(position, rotation, scale).toArray().map(n),
    };
  });
  assertSame('in-flight projectile High/Medium pose', projectileTierPoses[0], projectileTierPoses[1]);
  assertSame('in-flight projectile Medium/Low pose', projectileTierPoses[1], projectileTierPoses[2]);
}

function runReferenceGeometryCountContracts(): void {
  assertSame('plasma reference ladder', PLASMA_PROJECTILE_TRIANGLE_COUNTS, {
    high: 140, medium: 48, low: 4,
  });
  assertSame('rocket reference ladder', ROCKET_PROJECTILE_TRIANGLE_COUNTS, {
    high: 136, medium: 63, low: 8,
  });
  const lowRocket = createLowResolutionRocketGeometry();
  assertContract(
    triangleCount(lowRocket) === 8,
    'Low rocket uses the eight-face capped equilateral triangular prism',
  );
  lowRocket.dispose();

  const legCounts = TIERS.map((tier) => {
    if (tier === 'far') {
      const segment = createExtrudedEquilateralTriangleGeometry();
      const joint = createPrimitiveTetrahedronGeometry();
      const count = triangleCount(segment) * 2 + triangleCount(joint);
      segment.dispose();
      joint.dispose();
      return count;
    }
    const segment = createPrimitiveCylinderGeometry('locomotion', tier);
    const joint = createPrimitiveSphereGeometry('locomotion', tier);
    const count = triangleCount(segment) * 2 + triangleCount(joint);
    segment.dispose();
    joint.dispose();
    return count;
  });
  assertSame('one footless articulated leg geometry ladder', legCounts, [204, 68, 20]);

  const shieldCounts = TIERS.map((tier) => {
    const geometry = createPrimitiveSphereGeometry('shield', tier);
    const count = triangleCount(geometry);
    geometry.dispose();
    return count;
  });
  assertSame('finite shield sphere geometry ladder', shieldCounts, [288, 120, 36]);
}

function runEnvironmentLodMaterialContracts(): void {
  assertContract(
    !environmentPropVisibleAtDetailRung(DETAIL_RUNG_GLYPH) &&
      environmentPropVisibleAtDetailRung(DETAIL_RUNG_FAR),
    'trees, grass, and seaweed disappear at OFF/GLYPH but remain visible at LOW',
  );
  assertContract(
    environmentPropUsesGrassPresentation('grass') &&
      environmentPropUsesGrassPresentation('seaweed') &&
      !environmentPropUsesGrassPresentation('tree'),
    'grass and seaweed share the blade LOD/material path while trees retain trunk/crown LOD',
  );
  const grassAssets = getVegetationAssetOptions('grass');
  const seaweedAssets = getVegetationAssetOptions('seaweed');
  assertContract(
    grassAssets.length > 0 &&
      seaweedAssets.length > 0 &&
      [...grassAssets, ...seaweedAssets].every((asset) => asset.palette === 'modular'),
    'grass and seaweed share the modular blade palette instead of separate visual palettes',
  );
  assertContract(
    SEAWEED_ASSET_SCALE === 0.07 &&
      seaweedAssets.every((asset) => asset.scale === SEAWEED_ASSET_SCALE),
    'every seaweed frond is uniformly scaled to 70% of its previous world size',
  );
  const treePlacement = getVegetationKindConfig('tree');
  const grassPlacement = getVegetationKindConfig('grass');
  const seaweedPlacement = getVegetationKindConfig('seaweed');
  assertContract(
    treePlacement.minSlope === 0.1 &&
      treePlacement.maxSlope === 0.3 &&
      grassPlacement.minSlope === 0.1 &&
      grassPlacement.maxSlope === 0.3,
    'tree and grass eligibility uses the authored inclusive 0.1–0.3 slope band',
  );
  assertContract(
    seaweedPlacement.medium === 'waterline' &&
      seaweedPlacement.waterlineRangeFraction === 0.5,
    'seaweed spans halfway from water to the main flat and halfway to the seabed',
  );
  assertContract(
    !('metalDepositClearance' in VEGETATION_PLACEMENT_CONFIG) &&
      !('playerStartClearanceMin' in VEGETATION_PLACEMENT_CONFIG) &&
      !('playerStartClearanceMapFraction' in VEGETATION_PLACEMENT_CONFIG),
    'vegetation placement has no deposit- or player-region exclusions',
  );
  const wood = environmentLodFlatMaterialSpec('wood');
  const foliage = environmentLodFlatMaterialSpec('foliage');
  assertContract(
    wood.color === FOREST_SPRUCE2_WOOD_COLOR && wood.map === null,
    'Medium/Low tree wood uses the canonical flat wood color without a texture',
  );
  assertContract(
    foliage.color === FOREST_SPRUCE2_LEAF_COLOR && foliage.map === null,
    'Medium/Low tree foliage and grass use the canonical flat foliage color without a texture',
  );
  assertContract(
    wood.key !== foliage.key,
    'Medium/Low wood and foliage cache as separate flat materials',
  );

  const lowTreeCrown = createEnvironmentLowTreeCrownGeometry(12, 18, 9);
  const lowTreeCrownPositions = lowTreeCrown.getAttribute('position');
  const lowTreeCrownUniqueBase = new Set<string>();
  const lowTreeCrownUniqueApex = new Set<string>();
  for (let i = 0; i < lowTreeCrownPositions.count; i++) {
    const key = [
      lowTreeCrownPositions.getX(i),
      lowTreeCrownPositions.getY(i),
      lowTreeCrownPositions.getZ(i),
    ].join(',');
    if (lowTreeCrownPositions.getY(i) === 0) lowTreeCrownUniqueBase.add(key);
    if (lowTreeCrownPositions.getY(i) === 18) lowTreeCrownUniqueApex.add(key);
  }
  const lowTreeCrownBounds = lowTreeCrown.boundingBox;
  assertContract(
    triangleCount(lowTreeCrown) === 4 &&
      lowTreeCrownUniqueBase.size === 3 &&
      lowTreeCrownUniqueApex.size === 1,
    'Low tree crown has one triangular base and one upward apex',
  );
  assertContract(
    lowTreeCrownBounds !== null &&
      Math.abs((lowTreeCrownBounds.max.x - lowTreeCrownBounds.min.x) - 12) < 1e-6 &&
      Math.abs((lowTreeCrownBounds.max.y - lowTreeCrownBounds.min.y) - 18) < 1e-6 &&
      Math.abs((lowTreeCrownBounds.max.z - lowTreeCrownBounds.min.z) - 9) < 1e-6,
    'Low tree crown preserves its tree-specific foliage width, height, and depth',
  );
  lowTreeCrown.dispose();

  const highGrass = new THREE.Group();
  const authoredDirections = [
    new THREE.Vector3(0.3, 1.8, 0.1),
    new THREE.Vector3(-0.7, 1.5, 0.4),
    new THREE.Vector3(0.2, 1.3, -0.8),
  ];
  for (let i = 0; i < authoredDirections.length; i++) {
    const tip = authoredDirections[i];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0,
      tip.x * 0.45 + 0.08, tip.y * 0.45, tip.z * 0.45,
      tip.x, tip.y, tip.z,
    ], 3));
    highGrass.add(new THREE.Mesh(geometry));
  }
  const mediumGrass = buildEnvironmentGrassLodGeometry(highGrass, 'mid');
  const lowGrass = buildEnvironmentGrassLodGeometry(highGrass, 'far');
  assertContract(
    mediumGrass.getAttribute('position').count === authoredDirections.length * 3,
    'Medium grass uses one simple triangle per authored High leaf',
  );
  assertContract(
    lowGrass.getAttribute('position').count === 6,
    'Low grass/seaweed retains two representative authored leaf triangles without a stem',
  );
  const mediumPositions = mediumGrass.getAttribute('position');
  const mediumBaseCenter = new THREE.Vector3(
    (mediumPositions.getX(0) + mediumPositions.getX(1)) * 0.5,
    (mediumPositions.getY(0) + mediumPositions.getY(1)) * 0.5,
    (mediumPositions.getZ(0) + mediumPositions.getZ(1)) * 0.5,
  );
  const mediumDirection = new THREE.Vector3(
    mediumPositions.getX(2),
    mediumPositions.getY(2),
    mediumPositions.getZ(2),
  ).sub(mediumBaseCenter).normalize();
  assertContract(
    mediumDirection.dot(authoredDirections[0].clone().normalize()) > 0.9999,
    'Medium grass triangle preserves its authored High leaf direction',
  );
  mediumGrass.dispose();
  lowGrass.dispose();
  highGrass.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) mesh.geometry.dispose();
  });
}

export function runConstructionHostMarkingContracts(): void {
  assertContract(
    CONSTRUCTION_HAZARD_MARKING_STYLE.stripeAngleDeg === 45,
    'construction hazard bands use the one exact 45-degree style',
  );
  const samplePolygons = buildLinearHazardStripePolygons(10, 4, 8);
  assertContract(
    samplePolygons.some((polygon) => polygon.color === 'yellow') &&
      samplePolygons.some((polygon) => polygon.color === 'black'),
    'linear construction stripe partition retains both palette colors',
  );
  for (const polygon of samplePolygons) {
    for (let index = 0; index < polygon.points.length; index++) {
      const next = polygon.points[(index + 1) % polygon.points.length];
      const deltaU = next[0] - polygon.points[index][0];
      const deltaV = next[1] - polygon.points[index][1];
      const isRectangleEdge = Math.abs(deltaU) < 1e-7 || Math.abs(deltaV) < 1e-7;
      assertContract(
        isRectangleEdge || Math.abs(Math.abs(deltaU) - Math.abs(deltaV)) < 1e-7,
        'every non-outline construction stripe boundary has an exact 45-degree slant',
      );
    }
  }

  const blueprintHostIds = [
    ...UNIT_BLUEPRINT_IDS.filter((unitBlueprintId) =>
      (getUnitBlueprint(unitBlueprintId).constructionRate ?? 0) > 0),
    ...BUILDING_BLUEPRINT_IDS.filter((buildingBlueprintId) =>
      (getBuildingBlueprint(buildingBlueprintId).constructionRate ?? 0) > 0),
  ].sort();
  const configuredHostIds = Object.keys(CONSTRUCTION_HOST_MARKING_PROFILES).sort();
  assertContract(
    JSON.stringify(configuredHostIds) === JSON.stringify(blueprintHostIds),
    `construction marking profiles must exactly cover construction-rate hosts; configured=${configuredHostIds.join(',')} blueprints=${blueprintHostIds.join(',')}`,
  );

  for (const entityId of configuredHostIds) {
    const profile = CONSTRUCTION_HOST_MARKING_PROFILES[entityId];
    assertContract(profile !== undefined, `${entityId} construction marking profile resolves`);
    assertContract(
      (profile as { kind: string }).kind !== 'torus' &&
        (profile as { kind: string }).kind !== 'collar' &&
        (profile as { kind: string }).kind !== 'ringPanels',
      `${entityId} does not use legacy radial/twist marking geometry`,
    );
    const unitBlueprint = UNIT_BLUEPRINT_IDS.includes(entityId as UnitBlueprintId)
      ? getUnitBlueprint(entityId as UnitBlueprintId)
      : null;
    const scale = unitBlueprint?.radius.other ?? 100;
    const ringBoxTierVertexCounts: number[] = [];
    for (const tier of TIERS) {
      const marking = buildConstructionHostMarking(profile, scale, tier);
      const colorMeshes = new Map<string, THREE.Mesh>();
      marking.traverse((object) => {
        const mesh = object as THREE.Mesh;
        const color = object.userData.constructionHostMarkingColor as string | undefined;
        if (mesh.isMesh && color !== undefined) colorMeshes.set(color, mesh);
      });
      for (const color of ['yellow', 'black']) {
        const mesh = colorMeshes.get(color);
        assertContract(
          mesh !== undefined &&
            mesh.geometry.getAttribute('position').count > 0,
          `${entityId} ${tier} construction marking retains ${color} geometry`,
        );
        assertContract(
          mesh?.userData.constructionHazardStripeAngleDeg === 45 &&
            mesh.userData.constructionHazardPattern === 'linear-open' &&
            mesh.userData.constructionHazardRadial === false,
          `${entityId} ${tier} ${color} geometry declares exact linear 45-degree, non-radial topology`,
        );
      }
      if (profile.kind === 'sleeve') {
        for (const mesh of colorMeshes.values()) {
          const positions = mesh.geometry.getAttribute('position');
          for (let vertex = 0; vertex < positions.count; vertex++) {
            const radialDistance = Math.hypot(
              positions.getX(vertex),
              positions.getZ(vertex),
            );
            assertContract(
              radialDistance >= profile.radius * scale * 0.999,
              `${entityId} ${tier} sleeve is open-ended and contains no radial cap-center vertices`,
            );
          }
        }
      }
      if (profile.kind === 'ringBoxes') {
        const lod = tier === 'close'
          ? profile.lod.high
          : tier === 'mid' ? profile.lod.medium : profile.lod.low;
        assertContract(
          profile.mountInset > 0 && profile.mountInset < profile.boxDepth,
          `${entityId} ${tier} clamp boxes penetrate the host perimeter instead of floating`,
        );
        const housing = marking.children.find(
          (child) =>
            child.userData.constructionHostMarkingPart === 'mounted-housing',
        ) as THREE.Mesh | undefined;
        const latch = marking.children.find(
          (child) =>
            child.userData.constructionHostMarkingPart === 'top-latch',
        ) as THREE.Mesh | undefined;
        assertContract(
          housing?.isMesh === true &&
            housing.userData.constructionHostMarkingVolume === true &&
            housing.geometry.getAttribute('position').count > 0,
          `${entityId} ${tier} uses a real volumetric housing`,
        );
        assertContract(
          housing?.geometry.userData.constructionHostMarkingLodTier === tier &&
            housing.geometry.userData.constructionHostMarkingHousingStyle ===
              (lod.chamferedHousing ? 'chamfered' : 'box'),
          `${entityId} ${tier} selects its authored housing simplification`,
        );
        const expectsHardware = lod.topLatch || lod.cornerFasteners;
        assertContract(
          expectsHardware
            ? latch?.isMesh === true &&
              latch.userData.constructionHostMarkingVolume === true &&
              latch.geometry.getAttribute('position').count > 0 &&
              latch.geometry.userData.constructionHostMarkingTopLatch ===
                lod.topLatch &&
              latch.geometry.userData.constructionHostMarkingCornerFasteners ===
                lod.cornerFasteners
            : latch === undefined,
          `${entityId} ${tier} hardware matches its authored latch/fastener LOD`,
        );
        const hostOuterRadius =
          (profile.ringRadius + profile.tubeRadius) * scale;
        const expectedBackRadius =
          hostOuterRadius - profile.mountInset * scale;
        const expectedFrontRadius =
          expectedBackRadius + profile.boxDepth * scale;
        const housingPositions = housing?.geometry.getAttribute('position');
        let hasEmbeddedBack = false;
        let hasProjectedFront = false;
        if (housingPositions !== undefined) {
          const tolerance = Math.max(1e-5, scale * 1e-5);
          for (let vertex = 0; vertex < housingPositions.count; vertex++) {
            const x = housingPositions.getX(vertex);
            hasEmbeddedBack =
              hasEmbeddedBack ||
              Math.abs(x - expectedBackRadius) <= tolerance;
            hasProjectedFront =
              hasProjectedFront ||
              Math.abs(x - expectedFrontRadius) <= tolerance;
          }
        }
        assertContract(
          expectedBackRadius < hostOuterRadius &&
            hasEmbeddedBack &&
            hasProjectedFront,
          `${entityId} ${tier} housing spans from inside the torus surface to a true outer face`,
        );
        let tierVertexCount = 0;
        marking.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (mesh.isMesh) {
            tierVertexCount += mesh.geometry.getAttribute('position').count;
          }
        });
        ringBoxTierVertexCounts.push(tierVertexCount);
      }
    }
    if (profile.kind === 'ringBoxes') {
      assertContract(
        ringBoxTierVertexCounts.length === 3 &&
          ringBoxTierVertexCounts[0] > ringBoxTierVertexCounts[1] &&
          ringBoxTierVertexCounts[1] > ringBoxTierVertexCounts[2],
        `${entityId} clamp-box vertices must strictly decrease close > mid > far; got ${ringBoxTierVertexCounts.join(' > ')}`,
      );
    }
  }

  for (const tier of TIERS) {
    const pylonSleeve = buildConstructionHazardSleeve(
      4,
      2,
      CONSTRUCTION_HAZARD_MARKING_STYLE.pylonStripeCount,
      tier,
    );
    pylonSleeve.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      assertContract(
        mesh.userData.constructionHazardStripeAngleDeg === 45 &&
          mesh.userData.constructionHazardRadial === false,
        `construction pylon ${tier} uses the same exact 45-degree non-radial sleeve`,
      );
    });
  }
}

export function runEntityLodGeometry3DContractTest(): void {
  assertContract(ENTITY_LOD_VISUAL_REGRESSION_ROSTER.units.length === 26, 'visual roster covers all 26 units');
  assertContract(ENTITY_LOD_VISUAL_REGRESSION_ROSTER.buildings.length === 12, 'visual roster covers all 12 buildings');
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
  try {
    runEnvironmentLodMaterialContracts();
    runReferenceGeometryCountContracts();
    const bodyCounts = runBodyContracts(material);
    const locomotionCounts = runLocomotionContracts();
    const turretCounts = runTurretContracts(material);
    const shieldPanelCounts = runShieldPanelContract(material);
    runUnitCompositeContracts(bodyCounts, locomotionCounts, turretCounts, shieldPanelCounts);
    runStructureContracts(material, turretCounts);
    runVisualStateTransferContracts(material);
    runEmissionRegistryContracts();
    runEmissionPoseContracts();
    runConstructionHostMarkingContracts();
  } finally {
    material.dispose();
  }
}
