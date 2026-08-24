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
  getMultiBarrelFiringOrbitRadius,
  getTurretBarrelCenterToTipLength,
  getTurretBarrelDiameter,
  getTurretHeadRadius,
} from '../math/BarrelGeometry';
import {
  buildBotRig,
  getBotPelvisTopLocalY,
  poseBotRigAtRest,
} from './BotRig3D';
import { resolveMirroredLegConfigs } from '../math/LegLayout';
import { getTurretConfig } from '../sim/turretConfigs';
import type { Entity, Turret } from '../sim/types';
import type { TurretPresentation } from '@/types/blueprints';
import { buildAlbatrosChassis } from './AlbatrosMesh3D';
import { getBodyGeom, type BodyMeshPart } from './BodyShape3D';
import { buildBuildingShape, type BuildingShape } from './BuildingShape3D';
import { CommanderVisualKit3D } from './CommanderVisualKit3D';
import { RexVisualKit3D } from './RexVisualKit3D';
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
  constrainDirectBeamEndpointToMountRay,
  createBeamSegmentPoseScratch3D,
} from './BeamRenderer3D';
import {
  beamImpactCellKey,
  classifyBeamImpactSurface,
  classifyDamageImpactSurface,
} from './BeamImpact3D';
import { scorchCellKey } from './BurnMark3D';
import { beamBurnVolumeCellKey } from './BeamBurnVolume3D';
import { BeamPilotLightState3D } from './BeamPilotLightState3D';
import { BEAM_OUTER_VISUAL_CONFIG } from './BeamWaveVisual3D';
import {
  createExtrudedEquilateralTriangleGeometry,
  createPrimitiveHemisphereGeometry,
  createPrimitiveCylinderGeometry,
  createPrimitiveSphereGeometry,
  createPrimitiveTetrahedronGeometry,
  geometryEnclosedVolume,
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';
import { buildAmphibian } from './AmphibianRig3D';
import { buildAirframeRig } from './AirframeRig3D';
import { buildDroneFans } from './DroneRig3D';
import {
  applyLocomotionState,
  captureLocomotionState,
  getChassisLift,
  type Locomotion3DMesh,
} from './Locomotion3D';
import { buildCrawler, freeLegSlots } from './CrawlerRig3D';
import { LegInstancedRenderer } from './LegInstancedRenderer';
import { buildShieldPanelMesh3D } from './ShieldPanelMesh3D';
import { applyPerMeshShieldPanelForceVisibility3D } from './ShieldPanelPose3D';
import {
  SHIELD_SPHERE_SPIN_RADIANS_PER_SECOND,
  setShieldSphereVisualRotation3D,
} from './ShieldSphereVisualRotation3D';
import { buildSubmarineRig } from './SubmarineRig3D';
import { buildTank } from './TankRig3D';
import { buildTurretMesh3D, type TurretMesh } from './TurretMesh3D';
import { buildRover } from './RoverRig3D';
import type { EntityMesh } from './EntityMesh3D';
import {
  applyEntityLodVisualState3D,
  captureEntityLodVisualState3D,
} from './EntityLodVisualState3D';
import { applySolarCollectorPetalPose } from './SolarCollectorMesh3D';
import { applyBuildingOperationalPose } from './BuildingOperationalRig3D';
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
  configureEnvironmentMaterialFogShading,
  createEnvironmentLowTreeCrownGeometry,
  environmentLodFlatMaterialSpec,
  environmentPropVisibleAtDetailRung,
  environmentPropUsesGrassPresentation,
  patchEnvironmentFoliageLighting,
} from './EnvironmentPropRenderer3D';
import { worldShadeVertexPositionAssignment } from './WorldShade3D';
import {
  buildConstructionHazardSleeve,
  buildConstructionHostMarking,
  buildLinearHazardStripePolygons,
} from './ConstructionHostMarking3D';
import { VegetationVolumeOverlay3D } from './VegetationVolumeOverlay3D';

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
const ENTITY_LOD_VISUAL_REGRESSION_ROSTER = Object.freeze({
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
};

type TierCounts = Readonly<{ close: number; mid: number; far: number }>;

/** Composite body + mounted-turret ceilings, deliberately exhaustive. */
const STRUCTURE_TRIANGLE_BUDGETS: Record<StructureBlueprintId, TierCounts> = {
  // Re-baselined 2026-08-18 when each solar petal gained an actuator ram:
  // four assemblies of a rod, two coloured bosses and two attachment pads. The
  // anchor-signature invariant forbids dropping parts at a rung, so the far
  // ceiling has to carry all sixteen; the rams themselves are already built a
  // geometry rung below the body. Still under the converter and fabricator.
  buildingSolar: { close: 1600, mid: 700, far: 400 },
  buildingWind: { close: 1100, mid: 550, far: 300 },
  buildingExtractor: { close: 800, mid: 450, far: 260 },
  buildingExtractorT2: { close: 1000, mid: 550, far: 340 },
  buildingRadar: { close: 1500, mid: 700, far: 350 },
  buildingSonar: { close: 1500, mid: 700, far: 350 },
  buildingResourceConverter: { close: 1500, mid: 750, far: 420 },
  // Eight construction clamp stations since the hazard-marking round
  // (boxCount 4 -> 8) — the budgets carry the doubled housing count.
  towerFabricator: { close: 2600, mid: 1300, far: 640 },
  // Heavy carries a cross-yoke and two emitter heads instead of one.
  towerBeamMega: { close: 1400, mid: 780, far: 400 },
  towerBeamLight: { close: 900, mid: 500, far: 260 },
  towerCannon: { close: 1000, mid: 600, far: 320 },
  // Re-baselined 2026-08-23: the Helios grew from the shared cannon bunker
  // into a bespoke 210-unit siege spire (service platforms, counterweight
  // ring, extra spars).
  towerHelios: { close: 1300, mid: 720, far: 360 },
  towerAntiAir: { close: 1200, mid: 750, far: 440 },
  towerTorpedo: { close: 1100, mid: 650, far: 360 },
  // Re-baselined 2026-08-16 when the two shield labs got their curve
  // sculpture back (twisted spire and crown halos; S-curve dome + nautilus
  // shells + horns) on top of taller, bulkier massing. These are the only two
  // structures a player builds one or two of, so the Medium/Low rungs buy
  // silhouette rather than mass-instance throughput. Measured value plus ~5%
  // headroom, so the ceiling still catches FUTURE growth.
  // Re-baselined 2026-08-16 again when the labs' spinning bands became real
  // square-section extruded tori instead of flat RingGeometry discs. A flat
  // ring is 48 triangles and vanishes to a hairline edge-on; the shared torus
  // is 224 at close and actually reads as a ring turning in three dimensions,
  // which is the whole point of a gimbal and a crown halo.
  // The detached helical ribbons were removed on 2026-08-24. Keep the tighter
  // ceilings so that oversized sky geometry cannot quietly return as LOD art.
  buildingShieldTargetingTech: { close: 1860, mid: 925, far: 440 },
  buildingShieldTech: { close: 1445, mid: 695, far: 245 },
  buildingPrecisionTargetingTech: { close: 1615, mid: 790, far: 300 },
  buildingRadarJammer: { close: 900, mid: 600, far: 360 },
  buildingSonarJammer: { close: 900, mid: 600, far: 360 },
  buildingMetalStorage: { close: 700, mid: 500, far: 320 },
  buildingEnergyStorage: { close: 1620, mid: 825, far: 380 },
  buildingBotFabricator: { close: 2600, mid: 1300, far: 640 },
  buildingVehicleFabricator: { close: 2600, mid: 1300, far: 640 },
  buildingAircraftFabricator: { close: 2600, mid: 1300, far: 640 },
  buildingNavalFabricator: { close: 2600, mid: 1300, far: 640 },
  buildingAdvancedUniversalFabricator: { close: 2600, mid: 1300, far: 640 },
  buildingExperimentalUniversalFabricator: { close: 2600, mid: 1300, far: 640 },
  buildingAdvancedBotFabricator: { close: 2600, mid: 1300, far: 640 },
  buildingAdvancedVehicleFabricator: { close: 2600, mid: 1300, far: 640 },
  buildingAdvancedAircraftFabricator: { close: 2600, mid: 1300, far: 640 },
  buildingAdvancedNavalFabricator: { close: 2600, mid: 1300, far: 640 },
  towerInterceptor: { close: 1200, mid: 750, far: 440 },
  buildingTidalGenerator: { close: 1100, mid: 550, far: 300 },
};

/** Full visible unit ceilings: body + locomotion + physical turrets + unique kit/panel art. */
// Re-baselined 2026-08-11 for the entries the locomotion-rig and standing-rig
// work grew past: jackal/mongoose close (shared wheels rig), queen bee all
// three rungs, queen tick close, and human far (bot rig). Measured value
// plus ~5% headroom, so the ceiling keeps catching FUTURE growth instead of
// being deleted. These are perf ceilings for SCALE-1000, not targets -- if the
// rigs are meant to be cheaper, shrink the geometry and lower these again.
const UNIT_TRIANGLE_BUDGETS: Record<UnitBlueprintId, TierCounts> = {
  unitJackal: { close: 500, mid: 250, far: 130 },
  unitLynx: { close: 1150, mid: 580, far: 210 },
  unitDaddy: { close: 2380, mid: 954, far: 306 },
  unitBadger: { close: 1150, mid: 600, far: 230 },
  unitHedgehog: { close: 1150, mid: 600, far: 230 },
  unitMongoose: { close: 500, mid: 280, far: 140 },
  unitTick: { close: 2230, mid: 854, far: 246 },
  unitHuman: { close: 2550, mid: 950, far: 430 },
  unitMammoth: { close: 1200, mid: 620, far: 220 },
  unitFormik: { close: 4100, mid: 1500, far: 520 },
  unitWidow: { close: 3600, mid: 1450, far: 560 },
  unitHippo: { close: 1500, mid: 720, far: 280 },
  unitSeaTurtle: { close: 1250, mid: 700, far: 320 },
  unitOrca: { close: 1200, mid: 620, far: 280 },
  unitTarantula: { close: 2750, mid: 1100, far: 320 },
  unitLoris: { close: 1450, mid: 720, far: 280 },
  // The Bee's authored thorax, paired wings, and head replace the old shared
  // one-piece drone body. Measured close composite 1436 + ~5% headroom.
  unitBee: { close: 1510, mid: 650, far: 240 },
  unitDragonfly: { close: 1500, mid: 780, far: 330 },
  unitConstructionDrone: { close: 2200, mid: 1000, far: 420 },
  unitAdvancedConstructionDrone: { close: 2200, mid: 1000, far: 420 },
  unitConstructionSubmarine: { close: 1500, mid: 760, far: 320 },
  unitAdvancedConstructionSubmarine: { close: 1500, mid: 760, far: 320 },
  unitEagle: { close: 600, mid: 420, far: 220 },
  unitDuck: { close: 1100, mid: 720, far: 400 },
  unitAlbatros: { close: 1350, mid: 850, far: 420 },
  unitQueenBee: { close: 2920, mid: 1220, far: 580 },
  unitQueenTick: { close: 2290, mid: 780, far: 340 },
  unitTransport: { close: 2150, mid: 1050, far: 410 },
  unitCommander: { close: 4200, mid: 1900, far: 700 },
  // Rex's unified skull/neck, cylindrical midsection, four articulated arms,
  // two hand-carried fast-rocket racks, two Gatlings, and two backpack rocket
  // racks are included here. Measured at 2140/1380/810; each
  // ceiling retains roughly 5% regression headroom.
  unitRex: { close: 2240, mid: 1440, far: 850 },
  // Kestrel and Owl now own distinct multi-part airframes rather than
  // inheriting Bee geometry. Measured close composites 1300/1448 + ~5%.
  unitRadarScout: { close: 1365, mid: 650, far: 240 },
  unitDetector: { close: 1525, mid: 650, far: 240 },
  unitPetrel: { close: 1250, mid: 780, far: 440 },
  unitConstructionBot: { close: 3000, mid: 1200, far: 550 },
  unitAdvancedConstructionBot: { close: 3000, mid: 1200, far: 550 },
  unitConstructionRover: { close: 700, mid: 350, far: 180 },
  unitAdvancedConstructionRover: { close: 700, mid: 350, far: 180 },
  unitStealthScout: { close: 1250, mid: 700, far: 320 },
  unitRadarJammer: { close: 1400, mid: 780, far: 380 },
  unitMissileRover: { close: 1400, mid: 800, far: 460 },
  unitClusterArtillery: { close: 1100, mid: 650, far: 340 },
  unitWaterStrider: { close: 3000, mid: 1250, far: 400 },
  unitPatrolCorvette: { close: 1400, mid: 780, far: 380 },
};

const INTENTIONAL_ZERO_TURRETS = new Set<string>(['turretDisruptor']);

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

/** Monotonic simplification: every part present at the coarser rung must exist
 *  at the SAME transform in the finer one, and the coarser rung may not invent
 *  parts. budget_design_philosophy.html "One Shared Entity Detail Ladder"
 *  allows a part to be intentionally absent at a named rung, so identity is too
 *  strict for kits that drop detail pieces -- but a part that moves between
 *  rungs, or appears only at the coarse rung, is still drift. */
function assertMonotonicSubset(
  label: string,
  fine: readonly (readonly number[])[],
  coarse: readonly (readonly number[])[],
): void {
  assertContract(
    coarse.length <= fine.length,
    `${label} coarse rung has ${coarse.length} parts, more than the fine rung's ${fine.length}`,
  );
  const fineKeys = new Set(fine.map((tuple) => JSON.stringify(tuple)));
  for (const tuple of coarse) {
    const key = JSON.stringify(tuple);
    assertContract(
      fineKeys.has(key),
      `${label} coarse rung places a part the fine rung does not have at the same transform: ${key}`,
    );
  }
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

function syntheticTurret(
  turretBlueprintId: string,
  presentation: TurretPresentation,
): Turret {
  return {
    config: getTurretConfig(turretBlueprintId),
    presentation,
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
  presentation: TurretPresentation,
  tierIndex: number,
  material: THREE.Material,
  closeHead: THREE.SphereGeometry,
  closeBarrel: THREE.CylinderGeometry,
  closeCone: THREE.CylinderGeometry,
): TurretBuild {
  const parent = new THREE.Group();
  const mesh = buildTurretMesh3D(parent, syntheticTurret(turretBlueprintId, presentation), FULL_GFX, {
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
    yaw: transformTuple(mesh.yawGroup),
    head: mesh.head ? transformTuple(mesh.head) : null,
    pitch: mesh.pitchGroup ? transformTuple(mesh.pitchGroup) : null,
    spin: mesh.spinGroup ? transformTuple(mesh.spinGroup) : null,
    barrels: mesh.barrels.map(transformTuple),
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

/** Construction hazard markings are the one detail role the philosophy says
 *  must "simplify visibly and monotonically with building LOD" -- High keeps
 *  the chamfered housing, latch, and corner fasteners, Medium a plain box and
 *  latch, Low only the mounted box and its striped identity face. So their
 *  PIECE COUNT is expected to fall between rungs while every other anchor
 *  stays pinned. Compare the rest exactly and the markings by count. */
function buildingAnchorSignature(shape: BuildingShape): unknown {
  const signature = buildingSignature(shape) as {
    details: (readonly unknown[])[];
    [key: string]: unknown;
  };
  return {
    anchors: {
      ...signature,
      details: signature.details.filter((detail) => detail[0] !== 'constructionMarking'),
    },
    // Merged marking buffers, one per surviving sub-piece: housing, top latch,
    // and the two stripe colours at High/Medium; the latch buffer is gone at
    // Low, which is the authored simplification, not a missing clamp box.
    constructionMarkingCount: signature.details.filter((detail) => detail[0] === 'constructionMarking').length,
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
    'rover', 'tank', 'amphibious-tank', 'crawler', 'bot', 'amphibian', 'drone', 'plane', 'submarine', 'aerosub',
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
  // The Commander kit intentionally drops lens strips, shoulder caps, and pack
  // studs as the rung coarsens, which the ladder sanctions. What must hold is
  // that the surviving parts keep their exact transforms and nothing is added.
  assertMonotonicSubset('Commander High/Medium kit layout', commanderBuilds[0].signature, commanderBuilds[1].signature);
  assertMonotonicSubset('Commander Medium/Low kit layout', commanderBuilds[1].signature, commanderBuilds[2].signature);
  assertContract(
    commanderBuilds[0].signature.length > commanderBuilds[1].signature.length &&
      commanderBuilds[1].signature.length > commanderBuilds[2].signature.length,
    'Commander kit must actually shed parts at each coarser rung rather than only re-tessellating',
  );
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

function runBotBodySeamContracts(): void {
  for (const unitId of ['unitHuman', 'unitCommander'] as const) {
    const blueprint = getUnitBlueprint(unitId);
    const locomotion = blueprint.unitLocomotion;
    const body = blueprint.bodyShape;
    assertContract(locomotion.type === 'bot', `${unitId} uses bot locomotion`);
    assertContract(body?.kind === 'composite', `${unitId} owns a composite upper body`);
    const boxBottoms = body.parts
      .filter((part): part is Extract<typeof part, { kind: 'box' }> => part.kind === 'box')
      .map((part) => (
        (part.centerYFrac ?? part.heightFrac * 0.5) - part.heightFrac * 0.5
      ) * blueprint.radius.other);
    assertContract(boxBottoms.length > 0, `${unitId} upper body has box volumes`);
    const lowestUpperBodyY = Math.min(...boxBottoms);
    const pelvisTopY = getBotPelvisTopLocalY(
      blueprint.radius.other,
      locomotion.config.legs,
      getChassisLift(blueprint, blueprint.radius.other),
    );
    assertRelativeNear(
      `${unitId} upper body terminates at lower-body seam`,
      lowestUpperBodyY,
      pelvisTopY,
    );
  }
}

function runLocomotionContracts(): Map<UnitBlueprintId, TierCounts> {
  const countsByUnit = new Map<UnitBlueprintId, TierCounts>();
  runLegLocomotionStateContract();
  const footTriangles = TIERS.map((tier) => {
    const geometry = createPrimitiveHemisphereGeometry('locomotion', tier);
    const count = triangleCount(geometry);
    geometry.dispose();
    return count;
  });
  for (const unitId of UNIT_BLUEPRINT_IDS) {
    const blueprint = getUnitBlueprint(unitId);
    const locomotion = blueprint.unitLocomotion;
    if (locomotion.type === 'crawler') {
      const legCount = resolveMirroredLegConfigs(
        locomotion.config, blueprint.radius.other,
      ).all.length;
      // Struts, joints and feet live in the shared instanced pools rather than
      // under this root, so this is the roster's standing per-limb accounting
      // figure, not a triangle count taken off a scene graph.
      const footScale = locomotion.config.hasFeet ? 0 : 1;
      countsByUnit.set(unitId, {
        close: legCount * (204 - footTriangles[0] * footScale),
        mid: legCount * (68 - footTriangles[1] * footScale),
        far: legCount * (20 - footTriangles[2] * footScale),
      });
      continue;
    }
    const builds = TIERS.map((tier, tierIndex) => {
      const root = new THREE.Group();
      const radius = blueprint.radius.other;
      switch (locomotion.type) {
        case 'rover': {
          const rig = buildRover(root, radius, locomotion.config, undefined, tier);
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
        case 'tank':
        case 'amphibious-tank': {
          const cleatsVisible = featureVisibleAtDetail(
            'treadCleats',
            DETAIL_LEVELS[tierIndex],
          );
          const rig = buildTank(
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
        case 'bot': {
          const rig = buildBotRig(
            root, radius, blueprint.mass,
            locomotion.physics.ground.maxPropulsiveForce,
            locomotion.config.legs, locomotion.config.arms, locomotion.config.upperArms,
            0, undefined, tier,
          );
          poseBotRigAtRest(rig);
          assertContract(
            rig.legs.length === 2 &&
              rig.arms.length === (locomotion.config.upperArms === undefined ? 2 : 4),
            `${unitId}/${tier} stand has two legs and its authored arm pairs`,
          );
          assertContract(
            rig.legs.every((leg) => Math.abs(leg.hipZ) > 1e-6)
              && rig.legs[0].hipZ === -rig.legs[1].hipZ,
            `${unitId}/${tier} stand legs attach at mirrored hip sockets`,
          );
          assertContract(
            rig.legs.every((leg) => {
              const hip = new THREE.Vector3(leg.hipX, leg.hipY, leg.hipZ);
              const hipToFoot = leg.foot.position.clone().sub(hip);
              const hipToKnee = leg.knee.position.clone().sub(hip);
              const kneeToFoot = leg.foot.position.clone().sub(leg.knee.position);
              return leg.hipJoint.userData.botHipJoint === true &&
                leg.hipJoint.geometry.type === 'CylinderGeometry' &&
                Math.abs(leg.hipJoint.rotation.x - Math.PI * 0.5) < 1e-9 &&
                leg.hipJoint.parent === rig.hips &&
                leg.knee.geometry.type === 'CylinderGeometry' &&
                Math.abs(leg.knee.rotation.x - Math.PI * 0.5) < 1e-9 &&
                leg.foot.position.x > leg.hipX &&
                (leg.foot.position.z - leg.hipZ) * leg.side > 0 &&
                Math.abs(hipToKnee.length() - leg.thighLength) < 1e-5 &&
                Math.abs(kneeToFoot.length() - leg.shinLength) < 1e-5 &&
                hipToFoot.clone().cross(hipToKnee).length() > 1e-5;
            }),
            `${unitId}/${tier} stopped legs open through visible hip joints with fixed-length articulated bones`,
          );
          assertContract(
            rig.pelvis.userData.botPelvis === true &&
              rig.pelvis.parent === rig.hips,
            `${unitId}/${tier} central pelvis belongs to the lower-body leg frame`,
          );
          assertContract(
            rig.arms.every((arm) =>
              arm.shoulderJoint.userData.botShoulderJoint === true &&
              arm.upper.armor === undefined &&
              arm.elbow.geometry.type === 'CylinderGeometry' &&
              Math.abs(arm.elbow.rotation.x - Math.PI * 0.5) < 1e-9 &&
              (arm.elbow.position.z - arm.shoulderZ) * arm.side > 0),
            `${unitId}/${tier} stand arms leave visible shoulder joints at an outward angle`,
          );
          return {
            rig,
            count: objectTriangleCount(root),
            signature: {
              root: transformTuple(rig.group),
              pelvis: transformTuple(rig.pelvis),
              legs: rig.legs.map((leg) => [
                leg.side, n(leg.hipX), n(leg.hipY), n(leg.hipZ),
                n(leg.thighLength), n(leg.shinLength),
                ...transformTuple(leg.hipJoint),
                ...transformTuple(leg.knee), ...transformTuple(leg.foot),
              ]),
              arms: rig.arms.map((arm) => [
                arm.side, n(arm.shoulderX), n(arm.shoulderY), n(arm.shoulderZ),
                n(arm.handX), n(arm.handY), ...transformTuple(arm.shoulderJoint),
                ...transformTuple(arm.elbow),
              ]),
              stride: [
                n(rig.stepLength), n(rig.gaitCycleDistance),
                n(rig.strideLift), n(rig.standHipY),
                n(rig.stanceForward), n(rig.stanceOutward),
              ],
            },
          };
        }
        case 'amphibian': {
          const rig = buildAmphibian(root, radius, locomotion.config, undefined, tier);
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
        case 'drone': {
          const smokeUseId = unitId === 'unitDragonfly'
            ? 'locomotionDragonflyDrone'
            : 'locomotionDuctedFan';
          const rig = buildDroneFans(
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
            `${unitId}/${tier} drone fans retain a visible tiered duct ring`,
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
        case 'plane':
        case 'aerosub': {
          const smokeUseId = unitId === 'unitAlbatros'
            ? 'locomotionAlbatrosAerosub'
            : 'locomotionEaglePlane';
          const rig = buildAirframeRig(
            root, radius, locomotion.type, locomotion.config, smokeUseId, 1, undefined, tier,
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
          const rig = buildSubmarineRig(root, radius, locomotion.config, undefined, tier);
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
  assertContract(locomotion.type === 'crawler', 'walking pose contract uses a legged unit');
  const highPoolRoot = new THREE.Group();
  const lowPoolRoot = new THREE.Group();
  const highRenderer = new LegInstancedRenderer(highPoolRoot);
  const lowRenderer = new LegInstancedRenderer(lowPoolRoot);
  const radius = blueprint.radius.other;
  const high = buildCrawler(
    new THREE.Group(), radius, locomotion.config, 'full',
    getChassisLift(blueprint, radius), highRenderer, undefined, 'close',
  );
  const low = buildCrawler(
    new THREE.Group(), radius, locomotion.config, 'full',
    getChassisLift(blueprint, radius), lowRenderer, undefined, 'far',
  );
  const footedBlueprint = getUnitBlueprint('unitFormik');
  const footedLocomotion = footedBlueprint.unitLocomotion;
  assertContract(footedLocomotion.type === 'crawler', 'footed walking fixture uses the legs rig');
  const footed = buildCrawler(
    new THREE.Group(),
    footedBlueprint.radius.other,
    footedLocomotion.config,
    'full',
    getChassisLift(footedBlueprint, footedBlueprint.radius.other),
    highRenderer,
    undefined,
    'close',
  );
  assertContract(high !== undefined && low !== undefined, 'walking unit resolves High/Low leg rigs');
  assertContract(footed !== undefined, 'footed walking unit resolves its leg rig');
  try {
    assertContract(
      high.legs.every((leg) => leg.footSlot === -1) &&
        low.legs.every((leg) => leg.footSlot === -1),
      'Tick allocates no rendered feet at any geometry tier',
    );
    assertContract(
      footed.legs.every((leg) => leg.footSlot >= 0),
      'a foot-enabled legs rig still allocates one foot instance per leg',
    );
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
    freeLegSlots(footed, highRenderer);
    highRenderer.destroy();
    lowRenderer.destroy();
  }
}

function seedLocomotionState(locomotion: Locomotion3DMesh): void {
  if (!locomotion) return;
  switch (locomotion.type) {
    case 'crawler':
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
    case 'rover':
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
    case 'tank':
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
    case 'amphibian':
      locomotion.contact.phase = 12;
      locomotion.contact.initialized = true;
      locomotion.waterBlend = 0.65;
      for (let i = 0; i < locomotion.panels.length; i++) {
        locomotion.panels[i].hinge.rotation.set(0.1 * i, 0.2 * i, 0.3 * i);
      }
      return;
    case 'drone':
      locomotion.clearance = 17;
      return;
    case 'plane':
      return;
    case 'submarine':
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
  const countsByMount = new Map<string, TierCounts>();
  const rexKit = new RexVisualKit3D();
  const hosts = [
    ...UNIT_BLUEPRINT_IDS.map((hostId) => ({ hostId, mounts: getUnitBlueprint(hostId).turrets })),
    ...STRUCTURE_BLUEPRINT_IDS.map((hostId) => ({ hostId, mounts: getBuildingBlueprint(hostId).turrets })),
  ];
  for (const host of hosts) for (const mount of host.mounts) {
    const mountKey = `${host.hostId}/${mount.mountId}`;
    const turretId = mount.turretBlueprintId;
    const presentation = mount.presentation;
    if (presentation === null) {
      countsByMount.set(mountKey, { close: 0, mid: 0, far: 0 });
      continue;
    }
    const builds = TIERS.map((_, tierIndex) => buildTurretForTier(
      turretId,
      presentation,
      tierIndex,
      material,
      closeHead,
      closeBarrel,
      closeCone,
    ));
    assertContract(
      builds.every((build) => (
        build.mesh.yawGroup.parent === build.mesh.root &&
        (build.mesh.pitchGroup === undefined || build.mesh.pitchGroup.parent === build.mesh.yawGroup)
      )),
      `${mountKey} presents through fixed mount → logical yaw body → optional pitch hierarchy`,
    );
    assertSame(`${turretId} High/Medium functional layout`, builds[0].signature, builds[1].signature);
    assertSame(`${turretId} Medium/Low functional layout`, builds[1].signature, builds[2].signature);
    const presentedBarrel = presentation.barrel;
    if (
      presentedBarrel?.type === 'simpleMultiBarrel' ||
      presentedBarrel?.type === 'coneMultiBarrel'
    ) {
      const turretConfig = getTurretConfig(turretId);
      const headRadius = getTurretHeadRadius(presentation);
      const barrelLength = getTurretBarrelCenterToTipLength(presentation);
      const firingOrbit = getMultiBarrelFiringOrbitRadius(
        presentedBarrel,
        headRadius,
        barrelLength,
        turretConfig.spread?.angle,
      );
      for (const build of builds) {
        const fixedMuzzle = build.mesh.fixedMultiBarrelMuzzle;
        const spinGroup = build.mesh.spinGroup;
        assertContract(
          fixedMuzzle !== undefined && spinGroup !== undefined,
          `${mountKey} exposes one fixed multi-barrel firing socket`,
        );
        const teamCollar = build.mesh.teamCollar;
        assertContract(
          teamCollar !== undefined,
          `${mountKey} retains its team-coloured barrel collar`,
        );
        assertRelativeNear(`${mountKey} lowered spin axis`, spinGroup.position.y, -firingOrbit);
        assertRelativeNear(
          `${mountKey} collar follows lowered barrel axis`,
          teamCollar.centerY,
          spinGroup.position.y,
        );
        assertRelativeNear(
          `${mountKey} collar stays centered laterally around barrels`,
          teamCollar.centerZ,
          spinGroup.position.z,
        );
        if (presentedBarrel.barrelCount === 2) {
          const barrelRadius = getTurretBarrelDiameter(presentation, turretConfig.shot) * 0.5;
          assertContract(
            teamCollar.radius > firingOrbit + barrelRadius,
            `${mountKey} two-barrel collar fully contains both tube envelopes`,
          );
        }
        assertRelativeNear(`${mountKey} centered muzzle x`, fixedMuzzle.x, barrelLength);
        assertRelativeNear(`${mountKey} centered muzzle y`, fixedMuzzle.y, 0);
        assertRelativeNear(`${mountKey} centered muzzle z`, fixedMuzzle.z, 0);
        assertContract(
          fixedMuzzle.laneCount === turretConfig.emissionLaneCount,
          `${mountKey} routes every logical lane through the fixed firing socket`,
        );
        if (build.mesh.barrels.length === presentedBarrel.barrelCount) {
          const topBarrel = build.mesh.barrels[0];
          const topTip = new THREE.Vector3(0, topBarrel.scale.y * 0.5, 0)
            .applyQuaternion(topBarrel.quaternion)
            .add(topBarrel.position)
            .add(spinGroup.position);
          assertRelativeNear(`${mountKey} top barrel/fixed muzzle x`, topTip.x, fixedMuzzle.x);
          assertRelativeNear(`${mountKey} top barrel/fixed muzzle y`, topTip.y, fixedMuzzle.y);
          assertRelativeNear(`${mountKey} top barrel/fixed muzzle z`, topTip.z, fixedMuzzle.z);
        }
      }
    }
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
      const barrel = presentation.barrel;
      assertContract(!presentation.headOnly, `${mountKey} presents an ordinary full-barrel turret`);
      assertContract(
        barrel?.type === 'singleConeBarrel',
        `${mountKey} uses one aimed pilot-light cone`,
      );
      assertContract(config.shot?.type === 'beam', `${turretId} emits a beam ray`);
      assertContract(
        !Object.prototype.hasOwnProperty.call(blueprint, 'barrel'),
        `${turretId} logical blueprint owns no barrel geometry`,
      );

      const headRadius = getTurretHeadRadius(presentation);
      const barrelDiameter = getTurretBarrelDiameter(presentation, config.shot);
      const centerToTipLength = getTurretBarrelCenterToTipLength(presentation);
      const pilotBarrel = builds[0].mesh.barrels[0];
      const pilotBase = new THREE.Vector3(0, -pilotBarrel.scale.y * 0.5, 0)
        .applyQuaternion(pilotBarrel.quaternion)
        .add(pilotBarrel.position);
      assertRelativeNear(`${turretId} barrel/beam width`, barrelDiameter, config.shot.width);
      assertRelativeNear(`${turretId} pilot-light origin x`, pilotBase.x, 0);
      assertRelativeNear(`${turretId} pilot-light origin y`, pilotBase.y, 0);
      assertRelativeNear(`${turretId} pilot-light origin z`, pilotBase.z, 0);
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
    if (host.hostId === 'unitRex') {
      for (let i = 0; i < builds.length; i++) {
        rexKit.decorateTurret(
          builds[i].mesh,
          mount.mountId,
          material,
          material,
          TIERS[i],
        );
        builds[i].count = objectTriangleCount(builds[i].mesh.root);
        const fixedMuzzle = builds[i].mesh.fixedMultiBarrelMuzzle;
        if (fixedMuzzle !== undefined) {
          assertContract(
            builds[i].mesh.teamCollar !== undefined,
            `${mountKey} standard barrels retain their shared team-coloured collar`,
          );
        }
      }
      if (mount.mountId === 'beamMega') {
        assertContract(
          builds.every((build) => (
            build.mesh.barrelUsesCone === true &&
              build.mesh.barrels.length === 1 &&
              build.mesh.barrels[0].userData.rexBeamPilotBarrel === true &&
              build.mesh.teamCollar !== undefined
          )),
          `${mountKey} exposes the ordinary beam cone and collar as a visible head barrel`,
        );
        for (const build of builds) {
          const pitch = build.mesh.pitchGroup;
          assertContract(pitch !== undefined, `${mountKey} retains its pitch piece`);
          const head = pitch.children.find((child) => child.userData.rexTyrannosaurHead === true);
          assertContract(head !== undefined, `${mountKey} presents a Tyrannosaur head`);
          assertContract(head.parent === pitch, `${mountKey} whole head belongs to the pitch piece`);
          const neck = build.mesh.yawGroup.children.find(
            (child) => child.userData.rexThickNeck === true,
          );
          assertContract(neck !== undefined, `${mountKey} presents a yaw-owned thick neck`);
          const visibleHeadSolids = head.children.filter(
            (child) => child instanceof THREE.Mesh && child.visible,
          );
          assertContract(
            visibleHeadSolids.length === 1 &&
              visibleHeadSolids[0].userData.rexUnifiedCanidHead === true,
            `${mountKey} head is one unified canid shell with no separate bill or facial pieces`,
          );
          assertContract(
            visibleHeadSolids[0].position.x + visibleHeadSolids[0].scale.x <
              (build.mesh.teamCollar?.frontX ?? 0),
            `${mountKey} beam barrel projects visibly beyond the unified head shell`,
          );
          const aperture = head.children.find(
            (child) => child.userData.rexBeamAperture === true,
          );
          assertContract(
            aperture !== undefined,
            `${mountKey} publishes its non-visual beam-aperture marker`,
          );
          const barrel = build.mesh.barrels[0];
          const expectedAperture = new THREE.Vector3(0, barrel.scale.y * 0.5, 0)
            .applyQuaternion(barrel.quaternion)
            .add(barrel.position);
          assertRelativeNear(
            `${mountKey} head/aperture x`, aperture.position.x, expectedAperture.x,
          );
          assertRelativeNear(
            `${mountKey} head/aperture y`, aperture.position.y, expectedAperture.y,
          );
          assertRelativeNear(
            `${mountKey} head/aperture z`, aperture.position.z, expectedAperture.z,
          );
        }
      } else if (mount.mountId === 'gatlingRight' || mount.mountId === 'gatlingLeft') {
        assertContract(
          builds.every((build) => (
            build.mesh.barrels.length === 5 &&
              build.mesh.pitchGroup?.children.some(
                (child) => child.userData.rexGatlingBreech === true,
              )
          )),
          `${mountKey} uses the standard five-barrel Gatling cluster in a Rex forearm breech`,
        );
      } else if (mount.mountId === 'antiAirRight' || mount.mountId === 'antiAirLeft') {
        assertContract(
          builds.every((build) => (
            build.mesh.barrels.length === 3 &&
              build.mesh.pitchGroup?.children.some(
                (child) => child.userData.rexFastRocketPod === true,
              )
          )),
          `${mountKey} uses the standard three-barrel fast-rocket cluster in a shoulder pod`,
        );
      } else if (mount.mountId === 'siloRight' || mount.mountId === 'siloLeft') {
        assertContract(
          builds.every((build) => (
            build.mesh.barrels.length === 3 &&
              build.mesh.pitchGroup?.children.some(
                (child) => child.userData.rexVerticalRocketRack === true,
              )
          )),
          `${mountKey} uses the standard three-barrel rocket cluster in a vertical rack`,
        );
      }
    }
    const counts = builds.map((build) => build.count);
    assertDescending(turretId, counts);
    if (INTENTIONAL_ZERO_TURRETS.has(turretId)) {
      assertContract(counts.every((count) => count === 0), `${turretId} remains an intentional logical mount`);
    } else {
      assertContract(counts.every((count) => count > 0), `${turretId} resolves visible H/M/L geometry`);
    }
    countsByMount.set(mountKey, { close: counts[0], mid: counts[1], far: counts[2] });
  }

  closeHead.dispose();
  closeBarrel.dispose();
  closeCone.dispose();
  rexKit.dispose();
  return countsByMount;
}

function runRexUpperBodyMidsectionContracts(material: THREE.Material): TierCounts {
  const rexKit = new RexVisualKit3D();
  const counts = TIERS.map((tier) => {
    const upperBody = new THREE.Group();
    const midsection = rexKit.decorateUpperBodyMidsection(upperBody, material, tier, 110);
    assertContract(
      midsection.parent === upperBody && midsection.userData.rexUpperBodyMidsection === true,
      `Rex ${tier} center ring belongs to its independently yawing upper body`,
    );
    const belly = midsection.children.find((child) => child.userData.rexBellyCore === true);
    assertContract(belly !== undefined, `Rex ${tier} upper body retains its center ring`);
    assertContract(
      belly instanceof THREE.Mesh && belly.geometry instanceof THREE.CylinderGeometry,
      `Rex ${tier} midsection is an up-down cylinder`,
    );
    assertContract(
      belly.userData.rexMidsectionAxis === 'vertical' &&
        belly.rotation.x === 0 && belly.rotation.y === 0 && belly.rotation.z === 0,
      `Rex ${tier} midsection cylinder remains vertical`,
    );
    let hasTail = false;
    midsection.traverse((child) => {
      if (
        child.userData.rexTyrannosaurTail === true ||
        typeof child.userData.rexTailSegment === 'number'
      ) hasTail = true;
    });
    assertContract(
      !hasTail,
      `Rex ${tier} center ring contains no tail geometry`,
    );
    return objectTriangleCount(midsection);
  });
  assertDescending('Rex upper-body cylindrical midsection', counts);
  rexKit.dispose();
  return { close: counts[0], mid: counts[1], far: counts[2] };
}

/** Focused host-presentation gate that can run independently of unrelated
 * chassis/structure budget assertions in the full gallery contract. */
export function runHostTurretPresentationGeometry3DContractTest(): void {
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
  try {
    runTurretContracts(material);
    runRexUpperBodyMidsectionContracts(material);
  } finally {
    material.dispose();
  }
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
      mesh,
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
  for (const tierIndex of [1, 2]) {
    const tier = TIERS[tierIndex];
    const mesh = builds[tierIndex].mesh;
    applyPerMeshShieldPanelForceVisibility3D(mesh, 0);
    assertContract(
      mesh.panels.every((panelMesh) => !panelMesh.visible),
      `Loris ${tier} force plate is hidden when the shield is lowered`,
    );
    assertContract(
      mesh.arms.every((armMesh) => armMesh.visible) &&
        mesh.frames.every((frameMesh) => frameMesh.visible),
      `Loris ${tier} shield hardware remains visible when the shield is lowered`,
    );
    applyPerMeshShieldPanelForceVisibility3D(mesh, 1);
    assertContract(
      mesh.panels.every((panelMesh) => panelMesh.visible),
      `Loris ${tier} force plate is visible when the shield is raised`,
    );
  }
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
  rexUpperBodyMidsectionCounts: TierCounts,
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
        const turret = turretCounts.get(`${unitId}/${mount.mountId}`);
        assertContract(turret !== undefined, `${unitId} mount ${mount.turretBlueprintId} has tiered counts`);
        count += turret[tier];
      }
      if (unitId === 'unitLoris') count += shieldPanelCounts[tier];
      if (unitId === 'unitRex') count += rexUpperBodyMidsectionCounts[tier];
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
    const signatures = shapes.map(buildingAnchorSignature) as {
      anchors: unknown;
      constructionMarkingCount: number;
    }[];
    assertSame(`${structureId} High/Medium animation anchors`, signatures[0].anchors, signatures[1].anchors);
    assertSame(`${structureId} Medium/Low animation anchors`, signatures[1].anchors, signatures[2].anchors);
    assertContract(
      signatures[0].constructionMarkingCount >= signatures[1].constructionMarkingCount &&
        signatures[1].constructionMarkingCount >= signatures[2].constructionMarkingCount,
      `${structureId} construction markings must simplify monotonically with LOD; got ` +
        signatures.map((signature) => signature.constructionMarkingCount).join('/'),
    );
    const bodyCounts = shapes.map((shape) => {
      const root = new THREE.Group();
      root.add(shape.primary);
      for (const detail of shape.details) root.add(detail.mesh);
      return objectTriangleCount(root);
    });
    const mountedCounts = TIERS.map((tier) => blueprint.turrets.reduce((sum, mount) => {
      const counts = turretCounts.get(`${structureId}/${mount.mountId}`);
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
  const transportSourceGroup = new THREE.Group();
  const transportTargetGroup = new THREE.Group();
  transportSourceGroup.scale.setScalar(2.25);
  const transportSource = visualStateMesh({
    group: transportSourceGroup,
    carryScale: 2.25,
  });
  const transportTarget = visualStateMesh({ group: transportTargetGroup });
  applyEntityLodVisualState3D(
    transportTarget,
    captureEntityLodVisualState3D(transportSource),
  );
  assertContract(
    transportTarget.carryScale === 2.25 &&
      transportTarget.group.scale.x === 2.25 &&
      transportTarget.group.scale.y === 2.25 &&
      transportTarget.group.scale.z === 2.25,
    'transport carry size survives High-to-Low rebuild without replaying its grab animation',
  );

  for (const structureId of [
    'buildingWind',
    'buildingRadar',
    'buildingSonar',
    'buildingResourceConverter',
    'buildingShieldTargetingTech',
    'buildingShieldTech',
  ] as const) {
    const blueprint = getBuildingBlueprint(structureId);
    const width = blueprint.gridWidth * BUILD_GRID_CELL_SIZE;
    const depth = blueprint.gridHeight * BUILD_GRID_CELL_SIZE;
    const high = buildBuildingShape(
      blueprint.renderProfile, width, depth, material, structureId, 'close',
    );
    const low = buildBuildingShape(
      blueprint.renderProfile, width, depth, material, structureId, 'far',
    );
    const sourceChassis = new THREE.Group();
    const targetChassis = new THREE.Group();
    const operationalAmount = high.operationalRig === undefined ? undefined : 0.43;
    const operationalTime = high.operationalRig === undefined ? undefined : 2.7;
    applyBuildingOperationalPose(
      high.operationalRig,
      sourceChassis,
      operationalAmount ?? 1,
      operationalTime ?? 0,
    );
    const source = visualStateMesh({
      chassis: sourceChassis,
      buildingDetails: high.details,
      windRig: high.windRig,
      radarRig: high.radarRig,
      converterRig: high.converterRig,
      buildingOperationalRig: high.operationalRig,
      buildingOperationalAmount: operationalAmount,
      buildingOperationalMotionTime: operationalTime,
      visualBankRoll: 0.29,
      solarOpenAmount: 0.71,
    });
    const target = visualStateMesh({
      chassis: targetChassis,
      buildingDetails: low.details,
      windRig: low.windRig,
      radarRig: low.radarRig,
      converterRig: low.converterRig,
      buildingOperationalRig: low.operationalRig,
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
    assertSame(
      `${structureId} deploy/hunker chassis pose survives High-to-Low rebuild`,
      transformTuple(targetChassis),
      transformTuple(sourceChassis),
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
    .filter((detail) => detail.role === 'solarPanel')
    .map((detail) => ({ role: detail.role, transform: transformTuple(detail.mesh) }));
  assertSame(
    'solar petal pose survives High-to-Low rebuild without detail-index drift',
    solarPose(solarTarget.buildingDetails!),
    solarPose(solarSource.buildingDetails!),
  );

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
  const constrainedEndpoint = { x: 100, y: 80, z: 50 };
  assertContract(
    constrainDirectBeamEndpointToMountRay(
      constrainedEndpoint,
      10, 20, 30,
      2, 0, 0,
    ) &&
      constrainedEndpoint.x === 100 &&
      constrainedEndpoint.y === 20 &&
      constrainedEndpoint.z === 30,
    'a direct beam endpoint must remain exactly collinear with its turret-mount forward',
  );
  const pilotLights = new BeamPilotLightState3D();
  const beamFixture = [{
    projectile: {
      projectileType: 'beam',
      sourceEntityId: 47,
      config: { turretIndex: 2 },
    },
  }] as unknown as Entity[];
  assertContract(
    pilotLights.isVisible(47, 2),
    'a beam pilot light is visible while its turret has no live ray',
  );
  pilotLights.update(beamFixture, 1);
  assertContract(
    !pilotLights.isVisible(47, 2) && pilotLights.isVisible(47, 1),
    'a live ray hides only its own turret pilot light',
  );
  pilotLights.update([], 2);
  assertContract(
    pilotLights.isVisible(47, 2),
    'the pilot light returns when its live ray leaves presentation',
  );
  assertContract(
    classifyBeamImpactSurface(10, 10, false, 0) === 'terrain' &&
      classifyBeamImpactSurface(0, -20, true, 0) === 'water' &&
      classifyBeamImpactSurface(30, 0, false, 0) === 'endpoint' &&
      classifyBeamImpactSurface(30, 0, false, 0, 4, true) === 'entity' &&
      classifyDamageImpactSurface(30, 0, false, 0, false) === 'blast' &&
      classifyDamageImpactSurface(30, 0, false, 0, true) === 'entity',
    'damage impacts distinguish terrain, water, body strikes, ray endpoints, and free blasts',
  );
  assertContract(
    beamImpactCellKey('terrain', 10, 20, 30) ===
      beamImpactCellKey('terrain', 11, 21, 31) &&
      beamImpactCellKey('water', 10, 20, 30) !==
        beamImpactCellKey('terrain', 10, 20, 30) &&
      beamImpactCellKey('entity', 10, 20, 30) !==
        beamImpactCellKey('endpoint', 10, 20, 30) &&
      scorchCellKey(10, 20) === scorchCellKey(11, 21) &&
      beamBurnVolumeCellKey(10, 20, 30) === beamBurnVolumeCellKey(11, 21, 31) &&
      beamBurnVolumeCellKey(10, 20, 30) !== beamBurnVolumeCellKey(14, 20, 30),
    'impact and 2D/3D scorch keys consolidate repeated hits while retaining spatial identity',
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
    high: 136, medium: 84, low: 16,
  });
  const lowRocket = createLowResolutionRocketGeometry();
  assertContract(
    triangleCount(lowRocket) === 8,
    'Low rocket uses the eight-face capped equilateral triangular prism',
  );
  assertContract(
    ROCKET_PROJECTILE_TRIANGLE_COUNTS.low === triangleCount(lowRocket) * 2,
    'Low rocket spends its tail band on a second copy of that same prism',
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

  const shieldSpinEuler = new THREE.Euler();
  const shieldSpinQuaternion = new THREE.Quaternion();
  setShieldSphereVisualRotation3D(5_000, shieldSpinEuler, shieldSpinQuaternion);
  assertContract(
    Math.abs(shieldSpinEuler.x) > 0.001 &&
      Math.abs(shieldSpinEuler.y) > 0.001 &&
      Math.abs(shieldSpinEuler.z) > 0.001,
    'finite shield sphere visual rotation must advance on X, Y, and Z',
  );
  assertContract(
    Math.abs(shieldSpinEuler.x - 5 * SHIELD_SPHERE_SPIN_RADIANS_PER_SECOND.x) < 1e-9 &&
      Math.abs(shieldSpinEuler.y - 5 * SHIELD_SPHERE_SPIN_RADIANS_PER_SECOND.y) < 1e-9 &&
      Math.abs(shieldSpinEuler.z - 5 * SHIELD_SPHERE_SPIN_RADIANS_PER_SECOND.z) < 1e-9 &&
      Math.abs(shieldSpinQuaternion.length() - 1) < 1e-9,
    'finite shield sphere visual rotation must remain a normalized XYZ orientation',
  );
}

function runEnvironmentLodMaterialContracts(): void {
  const overlayParent = new THREE.Group();
  const vegetationOverlay = new VegetationVolumeOverlay3D(overlayParent);
  const overlayMesh = overlayParent.children[0] as THREE.LineSegments;
  const placeholderGeometry = overlayMesh.geometry;
  let placeholderDisposals = 0;
  placeholderGeometry.addEventListener('dispose', () => placeholderDisposals++);
  (
    vegetationOverlay as unknown as {
      rebuild(cameraX: number, cameraY: number): void;
    }
  ).rebuild(0, 0);
  assertContract(
    placeholderDisposals === 1 && overlayMesh.geometry !== placeholderGeometry,
    'vegetation overlay disposes its constructor geometry exactly once when rebuilt',
  );
  const activeGeometry = overlayMesh.geometry;
  let activeDisposals = 0;
  activeGeometry.addEventListener('dispose', () => activeDisposals++);
  vegetationOverlay.dispose();
  assertContract(
    activeDisposals === 1 && overlayParent.children.length === 0,
    'vegetation overlay disposes its active geometry exactly once on teardown',
  );

  assertContract(
    !environmentPropVisibleAtDetailRung(DETAIL_RUNG_GLYPH) &&
      environmentPropVisibleAtDetailRung(DETAIL_RUNG_FAR),
    'trees, grass, and seaweed disappear at MIN/GLYPH but remain visible at LOW',
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
  const foliageMaterial = new THREE.MeshLambertMaterial();
  patchEnvironmentFoliageLighting(foliageMaterial);
  patchEnvironmentFoliageLighting(foliageMaterial);
  const foliageShader = {
    uniforms: {},
    vertexShader: '',
    fragmentShader:
      'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;',
  } as Parameters<typeof foliageMaterial.onBeforeCompile>[0];
  foliageMaterial.onBeforeCompile(
    foliageShader,
    {} as THREE.WebGLRenderer,
  );
  assertContract(
    foliageMaterial.side === THREE.DoubleSide &&
      foliageMaterial.userData.worldShadeAtObjectOrigin === true &&
      foliageMaterial.userData.worldShadeAfterLighting === true &&
      foliageShader.fragmentShader.includes('environmentFoliageDiffuse') &&
      foliageShader.fragmentShader.includes('diffuseColor.rgb * 1.00') &&
      foliageShader.fragmentShader.match(/vec3 environmentFoliageDiffuse =/g)?.length === 1,
    'foliage renders both sides, shades from one prop anchor, and receives one Lambert floor',
  );
  foliageMaterial.dispose();

  const trunkMaterial = new THREE.MeshLambertMaterial();
  configureEnvironmentMaterialFogShading(trunkMaterial);
  assertContract(
    trunkMaterial.userData.worldShadeAfterLighting === true,
    'tree trunks receive fog desaturation and darkness after lighting',
  );
  trunkMaterial.dispose();

  const surfaceShadePosition = worldShadeVertexPositionAssignment(false);
  const objectShadePosition = worldShadeVertexPositionAssignment(true);
  assertContract(
    surfaceShadePosition.includes('vec4(transformed, 1.0)') &&
      surfaceShadePosition.includes(
        'worldShadeLocalPosition = batchingMatrix * worldShadeLocalPosition;',
      ) &&
      surfaceShadePosition.includes(
        'worldShadeLocalPosition = instanceMatrix * worldShadeLocalPosition;',
      ) &&
      surfaceShadePosition.indexOf('batchingMatrix') <
        surfaceShadePosition.indexOf('instanceMatrix') &&
      objectShadePosition.includes('vec4(0.0, 0.0, 0.0, 1.0)') &&
      !objectShadePosition.includes('vec4(transformed, 1.0)'),
    'fog shading applies batch and instance transforms to both surface and prop-origin samples',
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

function runConstructionHostMarkingContracts(): void {
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
    const profiles = CONSTRUCTION_HOST_MARKING_PROFILES[entityId];
    assertContract(
      profiles !== undefined && profiles.length > 0,
      `${entityId} construction marking profiles resolve`,
    );
    const unitBlueprint = UNIT_BLUEPRINT_IDS.includes(entityId as UnitBlueprintId)
      ? getUnitBlueprint(entityId as UnitBlueprintId)
      : null;
    const scale = unitBlueprint?.radius.other ?? 100;
    for (const profile of profiles) {
    assertContract(
      (profile as { kind: string }).kind !== 'torus' &&
        (profile as { kind: string }).kind !== 'collar' &&
        (profile as { kind: string }).kind !== 'ringPanels',
      `${entityId} does not use legacy radial/twist marking geometry`,
    );
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
  assertContract(ENTITY_LOD_VISUAL_REGRESSION_ROSTER.units.length === 43, 'visual roster covers all 43 units');
  assertContract(ENTITY_LOD_VISUAL_REGRESSION_ROSTER.buildings.length === 33, 'visual roster covers all 33 buildings');
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
  try {
    runEnvironmentLodMaterialContracts();
    runReferenceGeometryCountContracts();
    const bodyCounts = runBodyContracts(material);
    runBotBodySeamContracts();
    const locomotionCounts = runLocomotionContracts();
    const turretCounts = runTurretContracts(material);
    const shieldPanelCounts = runShieldPanelContract(material);
    const rexUpperBodyMidsectionCounts = runRexUpperBodyMidsectionContracts(material);
    runUnitCompositeContracts(
      bodyCounts,
      locomotionCounts,
      turretCounts,
      shieldPanelCounts,
      rexUpperBodyMidsectionCounts,
    );
    runStructureContracts(material, turretCounts);
    runVisualStateTransferContracts(material);
    runEmissionRegistryContracts();
    runEmissionPoseContracts();
    runConstructionHostMarkingContracts();
  } finally {
    material.dispose();
  }
}
