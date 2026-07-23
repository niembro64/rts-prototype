import * as THREE from 'three';
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
  getUnitBlueprint,
} from '../sim/blueprints';
import { BUILD_GRID_CELL_SIZE } from '../sim/buildGrid';
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
  buildEnvironmentGrassLodGeometry,
  createEnvironmentLowTreeCrownGeometry,
  environmentLodFlatMaterialSpec,
  environmentPropVisibleAtDetailRung,
} from './EnvironmentPropRenderer3D';

const TIERS = ['close', 'mid', 'far'] as const satisfies readonly PrimitiveGeometryTier[];
const DETAIL_LEVELS = [
  detailLevelForRung(DETAIL_RUNG_CLOSE),
  detailLevelForRung(DETAIL_RUNG_MID),
  detailLevelForRung(DETAIL_RUNG_FAR),
] as const;

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
  treadsAnimated: true,
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
  materialExplosionStyle: 'obliterate',
  materialExplosionPieceBudget: 1,
  materialExplosionPhysicsFramesSkip: 1,
  deathExplosionStyle: 'obliterate',
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
};

/** Full visible unit ceilings: body + locomotion + physical turrets + unique kit/panel art. */
const UNIT_TRIANGLE_BUDGETS: Record<UnitBlueprintId, TierCounts> = {
  unitJackal: { close: 380, mid: 250, far: 130 },
  unitLynx: { close: 1150, mid: 580, far: 210 },
  unitDaddy: { close: 2700, mid: 1050, far: 330 },
  unitBadger: { close: 1150, mid: 600, far: 230 },
  unitMongoose: { close: 420, mid: 280, far: 140 },
  unitTick: { close: 2550, mid: 950, far: 270 },
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
    turretAccentMat: material,
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
      if (!entries[0].isSmooth) {
        for (const [tierIndex, entry] of entries.entries()) {
          for (const part of entry.parts) {
            if (part.geometry.type !== 'ExtrudeGeometry') continue;
            const options = (part.geometry as THREE.ExtrudeGeometry).parameters?.options;
            assertContract(
              options?.bevelEnabled === false,
              `${unitId}/${TIERS[tierIndex]} boxy body keeps hard unbeveled faces`,
            );
          }
        }
      }
    }
    if (unitId === 'unitMongoose') {
      assertContract(
        blueprint.bodyShape !== null &&
          blueprint.bodyShape.kind === 'polygon' &&
          blueprint.bodyShape.bevelEnabled === false,
        'Mongoose explicitly disables polygon body bevels',
      );
      assertContract(
        counts[0] === counts[1] && counts[1] === counts[2],
        'Mongoose High/Medium/Low bodies stay on the same unbeveled hexagonal prism',
      );
    }
    countsByUnit.set(unitId, { close: counts[0], mid: counts[1], far: counts[2] });
  }
  for (const type of [
    'wheels', 'treads', 'amphibious-treads', 'legs', 'flippers', 'hover', 'flying', 'submarine', 'dive',
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
      countsByUnit.set(unitId, {
        close: legCount * 204,
        mid: legCount * 68,
        far: legCount * 20,
      });
      continue;
    }
    const builds = TIERS.map((tier) => {
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
          const rig = buildTreads(root, radius, locomotion.config, true, undefined, tier);
          assertContract(
            rig.rotationAnimated === (tier !== 'far'),
            `${unitId}/${tier} tread rotation matches its geometry rung`,
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
    new THREE.Group(), radius, locomotion.config, 'full', blueprint.bodyShape,
    getChassisLift(blueprint, radius), blueprint.legAttachHeightFrac,
    highRenderer, undefined, 'close',
  );
  const low = buildLegs(
    new THREE.Group(), radius, locomotion.config, 'full', blueprint.bodyShape,
    getChassisLift(blueprint, radius), blueprint.legAttachHeightFrac,
    lowRenderer, undefined, 'far',
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
  assertContract(
    metalPylon?.close === 284 && metalPylon.mid === 116 && metalPylon.far === 32,
    `construction pylon expected 284/116/32, got ${JSON.stringify(metalPylon)}`,
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
    BEAM_UPDATE_BUCKET_COUNT > 1,
    'beam path updates use more than one stagger bucket',
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
    'trees and grass disappear at OFF/GLYPH but remain visible at LOW',
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
    'Low grass retains two representative authored leaf triangles',
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

export function runEntityLodGeometry3DContractTest(): void {
  assertContract(ENTITY_LOD_VISUAL_REGRESSION_ROSTER.units.length === 24, 'visual roster covers all 24 units');
  assertContract(ENTITY_LOD_VISUAL_REGRESSION_ROSTER.buildings.length === 11, 'visual roster covers all 11 buildings');
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
  } finally {
    material.dispose();
  }
}
