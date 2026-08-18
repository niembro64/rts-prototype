import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import { SOLAR_BUILDING_VISUAL_HEIGHT } from '../sim/blueprints';
import {
  buildResourcePylonRig,
  type ResourcePylonRig,
} from './ResourcePylonMesh3D';
import { PYLON_BUILDING_SOLAR_CONE_HALF_ANGLE_RAD } from '@/resourceConfig';
import { easeBuildingActiveStateAmount } from './BuildingActiveStateTransition3D';
import type { BuildingDetailMesh, BuildingDetailRole, BuildingShape } from './BuildingShape3D';
import {
  getActiveBuildingGeometryTier,
  getBuildingCylinderGeometry,
  makeBox,
  playerColorDetail,
  teamOrnamentDetail,
} from './BuildingMeshPrimitives3D';
import {
  getOrCreate,
  getSharedPrimitiveTetrahedronGeometry,
  preserveGeometryVolume,
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';

/** One petal's actuator wedge. `groundArm` is fixed — the foot is bolted to
 *  the ground — while the panel arm swings with the petal, so the wedge between
 *  them opens and closes. Both arms are the same length, which is what makes
 *  the swept edge read as a coin's rim. */
type SolarActuatorAnimation = {
  hinge: THREE.Vector3;
  tangent: THREE.Vector3;
  /** In-plane horizontal axis. With world up it spans the plane the petal
   *  swings through, which is where the wedge's two arms live. */
  outward: THREE.Vector3;
  /** Fixed angle below horizontal at which the foot meets the ground. */
  groundAngle: number;
  openDirection: THREE.Vector3;
  closedDirection: THREE.Vector3;
  radius: number;
  thickness: number;
  /** Captured at build time — the pose runs outside the tier scope. */
  tier: PrimitiveGeometryTier;
};

type SolarPetalAnimation = {
  width: number;
  length: number;
  hinge: THREE.Vector3;
  tangent: THREE.Vector3;
  openDirection: THREE.Vector3;
  closedDirection: THREE.Vector3;
  panelSideHint: THREE.Vector3;
  inset: number;
  normalOffset: number;
  thickness: number;
};

export type SolarRig = {
  pylon: ResourcePylonRig;
};

const SOLAR_HEIGHT = SOLAR_BUILDING_VISUAL_HEIGHT;
const SOLAR_NATIVE_YAW = Math.PI / 4;
const SOLAR_PETAL_CHOP_FRACTION = 2 / 3;
const SOLAR_CHOP_HALF = (1 - SOLAR_PETAL_CHOP_FRACTION) / 2;
const SOLAR_FRUSTUM_TOP_Y = -0.5 + SOLAR_PETAL_CHOP_FRACTION;
const h = SOLAR_CHOP_HALF;
const ty = SOLAR_FRUSTUM_TOP_Y;

const solarPanelPyramidGeom = new THREE.BufferGeometry();
solarPanelPyramidGeom.setAttribute('position', new THREE.Float32BufferAttribute([
  -0.5, -0.5,  0.5,   0.5, -0.5,  0.5,   h, ty,  h,
  -0.5, -0.5,  0.5,   h, ty,  h,  -h, ty,  h,
   0.5, -0.5, -0.5,  -0.5, -0.5, -0.5,  -h, ty, -h,
   0.5, -0.5, -0.5,  -h, ty, -h,   h, ty, -h,
   0.5, -0.5,  0.5,   0.5, -0.5, -0.5,   h, ty, -h,
   0.5, -0.5,  0.5,   h, ty, -h,   h, ty,  h,
  -0.5, -0.5, -0.5,  -0.5, -0.5,  0.5,  -h, ty,  h,
  -0.5, -0.5, -0.5,  -h, ty,  h,  -h, ty, -h,
  -h, ty, -h,  -h, ty,  h,   h, ty,  h,
  -h, ty, -h,   h, ty,  h,   h, ty, -h,
], 3));
solarPanelPyramidGeom.computeVertexNormals();

const solarTrianglePetalShape = new THREE.Shape([
  new THREE.Vector2(-0.5, 0),
  new THREE.Vector2(0.5, 0),
  new THREE.Vector2(SOLAR_CHOP_HALF, SOLAR_PETAL_CHOP_FRACTION),
  new THREE.Vector2(-SOLAR_CHOP_HALF, SOLAR_PETAL_CHOP_FRACTION),
]);
const solarTrianglePetalGeom = new THREE.ExtrudeGeometry(solarTrianglePetalShape, {
  depth: 1,
  bevelEnabled: false,
  steps: 1,
});

/** The petal outline, in the same local units the pose matrix scales: one
 *  pyramid face, wide at the hinge and chopped to the top plate's width. */
const SOLAR_PETAL_OUTLINE: readonly (readonly [number, number])[] = [
  [-0.5, 0],
  [0.5, 0],
  [SOLAR_CHOP_HALF, SOLAR_PETAL_CHOP_FRACTION],
  [-SOLAR_CHOP_HALF, SOLAR_PETAL_CHOP_FRACTION],
];

/** One solid petal: the face outline extruded through the panel thickness.
 *
 * The panel is a single slab, not a frame with a photovoltaic sheet floating
 * above it, so it carries two materials instead of being two meshes. Group 0
 * is the inner face on its own — the shiny cell side, the side that lands on
 * the pyramid when the collector closes, sharing the pyramid's own material so
 * the two read as one surface. Group 1 is the dull back face and the four
 * edges together, which keeps the whole petal to two draws. */
function createSolarPetalSlabGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const pushTriangle = (
    corners: readonly (readonly [number, number, number])[],
    nx: number,
    ny: number,
    nz: number,
  ): void => {
    for (const [x, y, z] of corners) {
      positions.push(x, y, z);
      normals.push(nx, ny, nz);
    }
  };

  const [c0, c1, c2, c3] = SOLAR_PETAL_OUTLINE;
  const at = (c: readonly [number, number], z: number): [number, number, number] =>
    [c[0], c[1], z];

  // Inner (cell) face, alone in group 0. Local z is the pose normal, which
  // points into the pyramid while the panel is shut, so z = 1 is the side
  // that faces the skin.
  pushTriangle([at(c0, 1), at(c1, 1), at(c2, 1)], 0, 0, 1);
  pushTriangle([at(c0, 1), at(c2, 1), at(c3, 1)], 0, 0, 1);
  const innerFaceVertexCount = positions.length / 3;

  // Outer face, wound the other way so it faces out of the slab.
  pushTriangle([at(c0, 0), at(c2, 0), at(c1, 0)], 0, 0, -1);
  pushTriangle([at(c0, 0), at(c3, 0), at(c2, 0)], 0, 0, -1);

  // Edges. The outline runs counter-clockwise, so each edge's outward normal
  // is its direction rotated a quarter turn.
  for (let i = 0; i < SOLAR_PETAL_OUTLINE.length; i++) {
    const a = SOLAR_PETAL_OUTLINE[i];
    const b = SOLAR_PETAL_OUTLINE[(i + 1) % SOLAR_PETAL_OUTLINE.length];
    const edgeX = b[0] - a[0];
    const edgeY = b[1] - a[1];
    const edgeLength = Math.hypot(edgeX, edgeY);
    const nx = edgeY / edgeLength;
    const ny = -edgeX / edgeLength;
    pushTriangle([at(a, 0), at(b, 0), at(b, 1)], nx, ny, 0);
    pushTriangle([at(a, 0), at(b, 1), at(a, 1)], nx, ny, 0);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.addGroup(0, innerFaceVertexCount, 0);
  geometry.addGroup(innerFaceVertexCount, positions.length / 3 - innerFaceVertexCount, 1);
  return geometry;
}

const solarPetalSlabGeom = createSolarPetalSlabGeometry();

/** Angular resolution of the actuator wedge cache. */
const SOLAR_ACTUATOR_SPAN_STEP_RAD = Math.PI / 90;
/** Arc segments per quarter turn, per detail rung. The wedge is four of the
 *  collector's pieces, so its rim is a real share of the far-rung triangle
 *  budget and has to thin out with everything else. */
const SOLAR_ACTUATOR_ARC_SEGMENTS_PER_QUARTER: Readonly<Record<PrimitiveGeometryTier, number>> = {
  close: 12,
  mid: 8,
  far: 5,
};
const solarActuatorGeomByTierAndSpan = new Map<string, THREE.BufferGeometry>();

/** Unit-radius, unit-depth coin segments, one per quantised span.
 *
 * The wedge has to stay a real circular sector at every opening angle, and no
 * affine transform turns one sector into a sector of a different angle — it
 * turns it into an elliptical one, which collapses into a flat fin once the
 * arms open past a right angle. So the angle lives in the geometry. Spans are
 * quantised to two degrees and shared by every collector on the map, which
 * costs a few dozen tiny buffers in total and no per-instance allocation (each
 * detail mesh keeps a shared geometry, and nothing here needs disposing per
 * entity). The pose then only has to place a rigid, uniformly scaled wedge. */
function getSolarActuatorGeometry(
  spanRad: number,
  tier: PrimitiveGeometryTier,
): THREE.BufferGeometry {
  const steps = Math.max(1, Math.ceil(spanRad / SOLAR_ACTUATOR_SPAN_STEP_RAD));
  return getOrCreate(solarActuatorGeomByTierAndSpan, `${tier}:${steps}`, () => {
    const span = Math.min(Math.PI * 2, steps * SOLAR_ACTUATOR_SPAN_STEP_RAD);
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(1, 0);
    shape.absarc(0, 0, 1, 0, span, false);
    shape.lineTo(0, 0);
    return new THREE.ExtrudeGeometry(shape, {
      depth: 1,
      bevelEnabled: false,
      steps: 1,
      curveSegments: Math.max(3, Math.round(
        (span / (Math.PI * 0.5)) * SOLAR_ACTUATOR_ARC_SEGMENTS_PER_QUARTER[tier],
      )),
    });
  });
}
const solarHingeCapGeometryByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();

function getSolarHingeCapGeometry(): THREE.BufferGeometry {
  const tier = getActiveBuildingGeometryTier();
  return getOrCreate(solarHingeCapGeometryByTier, tier, () => {
    const geometry = tier === 'close'
      ? new THREE.IcosahedronGeometry(1, 1)
      : tier === 'mid'
        ? new THREE.OctahedronGeometry(1)
        : getSharedPrimitiveTetrahedronGeometry(1).clone();
    preserveGeometryVolume(geometry, Math.PI * 4 / 3);
    return geometry;
  });
}

function makeHingeCap(
  material: THREE.Material,
  radius: number,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(getSolarHingeCapGeometry(), material);
  mesh.position.set(x, y, z);
  mesh.scale.setScalar(radius);
  return mesh;
}

function makeSolarCellMaterial(
  polygonOffsetFactor: number,
  polygonOffsetUnits: number,
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: COLORS.buildings.materials.solarCell.colorHex,
    metalness: COLORS.buildings.materials.solarCell.metalness,
    roughness: COLORS.buildings.materials.solarCell.roughness,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor,
    polygonOffsetUnits,
  });
}

/** Shared photovoltaic surface for the original centre pyramid and the
 * inward-facing petal panels. */
const solarCellMat = makeSolarCellMaterial(-1, -4);
const solarPetalBackMat = new THREE.MeshLambertMaterial({
  color: COLORS.buildings.materials.solarPetalBack.colorHex,
  side: THREE.DoubleSide,
});

const _solarPetalTangent = new THREE.Vector3();
const _solarPetalDirection = new THREE.Vector3();
const _solarPetalNormal = new THREE.Vector3();
const _solarPetalOrigin = new THREE.Vector3();
const _solarPetalXAxis = new THREE.Vector3();
const _solarPetalYAxis = new THREE.Vector3();
const _solarPetalZAxis = new THREE.Vector3();
const _solarActuatorDirection = new THREE.Vector3();
const _solarActuatorXAxis = new THREE.Vector3();
const _solarActuatorYAxis = new THREE.Vector3();
const _solarActuatorZAxis = new THREE.Vector3();
const _solarActuatorOrigin = new THREE.Vector3();

function isSolarPetalDetail(detail: BuildingDetailMesh): boolean {
  return detail.role === 'solarPanel' ||
    detail.role === 'solarActuator' ||
    detail.role === 'teamOrnament';
}

/** Apply one canonical open/closed pose to every visible solar leaf. This is
 * used both by the live animator and by mesh construction/LOD transfer, so a
 * rebuilt collector never relies on detail-array ordering to recover a pose. */
export function applySolarCollectorPetalPose(
  details: readonly BuildingDetailMesh[] | undefined,
  openAmount: number,
): boolean {
  if (details === undefined) return false;
  const t = easeBuildingActiveStateAmount(openAmount);
  let applied = false;
  for (const detail of details) {
    if (!isSolarPetalDetail(detail)) continue;
    const actuator = detail.mesh.userData.solarActuator as SolarActuatorAnimation | undefined;
    if (actuator) {
      _solarActuatorDirection
        .copy(actuator.closedDirection)
        .lerp(actuator.openDirection, t)
        .normalize();
      applySolarActuatorPose(detail.mesh, actuator, _solarActuatorDirection);
      detail.mesh.matrixWorldNeedsUpdate = true;
      applied = true;
      continue;
    }
    const anim = detail.mesh.userData.solarPetal as SolarPetalAnimation | undefined;
    if (!anim) continue;
    _solarPetalDirection
      .copy(anim.closedDirection)
      .lerp(anim.openDirection, t)
      .normalize();
    writeSolarPetalMatrix(
      detail.mesh.matrix,
      anim.width,
      anim.length,
      anim.hinge,
      anim.tangent,
      _solarPetalDirection,
      anim.inset,
      anim.normalOffset,
      anim.thickness,
      anim.panelSideHint,
    );
    detail.mesh.matrixWorldNeedsUpdate = true;
    applied = true;
  }
  return applied;
}

/** One pyramid face, and the hinged panel that folds onto it.
 *
 * The panel hinges on its INNER face — the photovoltaic side, the side that
 * meets the pyramid when the collector is OFF — so the whole assembly stacks
 * OUTWARD from the hinge axis and lands on the skin the way the metal
 * extractor's blades do. Hinging on the outer face instead buries the frame
 * and the cells inside the pyramid the moment the panels close.
 *
 * `outward` is the face's horizontal direction, `up` runs up the slope to the
 * top plate (the closed panel direction), and `normal` is the face's outward
 * normal (the direction the panel stands off along). */
type SolarFaceFrame = {
  outward: THREE.Vector3;
  tangent: THREE.Vector3;
  up: THREE.Vector3;
  normal: THREE.Vector3;
  baseHalf: number;
  span: number;
  slant: number;
};

function solarFaceFrame(
  outwardX: number,
  outwardZ: number,
  baseHalf: number,
  span: number,
): SolarFaceFrame {
  const outward = new THREE.Vector3(outwardX, 0, outwardZ);
  // Bottom-to-top-plate travel across the face, and the normal perpendicular
  // to it. The frustum's top plate is SOLAR_CHOP_HALF*2 of the base, so the
  // face leans inward by (baseHalf - topHalf) over SOLAR_PETAL_CHOP_FRACTION
  // of the full height — which reduces to the same (height, baseHalf) pair.
  const up = new THREE.Vector3(0, SOLAR_HEIGHT, 0)
    .addScaledVector(outward, -baseHalf)
    .normalize();
  const normal = new THREE.Vector3(0, baseHalf, 0)
    .addScaledVector(outward, SOLAR_HEIGHT)
    .normalize();
  return {
    outward,
    tangent: new THREE.Vector3(outward.z, 0, -outward.x),
    up,
    normal,
    baseHalf,
    span,
    slant: SOLAR_PETAL_CHOP_FRACTION * Math.hypot(SOLAR_HEIGHT, baseHalf),
  };
}

/** Where the panel's hinge pin runs: out from the face's bottom edge by the
 *  cell clearance, then up the slope by the shared hinge rise. */
function solarHingePoint(
  face: SolarFaceFrame,
  faceClearance: number,
  hingeRise: number,
): THREE.Vector3 {
  return new THREE.Vector3()
    .addScaledVector(face.outward, face.baseHalf)
    .addScaledVector(face.normal, faceClearance)
    .addScaledVector(face.up, hingeRise);
}

export function buildSolarCollector(
  width: number,
  depth: number,
  primaryMat: THREE.Material,
): BuildingShape {
  const primary = new THREE.Mesh(solarPanelPyramidGeom, solarCellMat);
  const details: BuildingDetailMesh[] = [];

  const petalTilt = 0.42;
  const petalThickness = 6;
  const teamAccentThickness = 0.85;
  const teamAccentGap = 0.35;
  /** Clearance between a folded panel's cell face and the pyramid skin. */
  const petalFaceClearance = 0.6;
  // The pin runs down the middle of the slab's thickness, so its knuckle is
  // flush with both faces the way a barrel hinge on a real panel is. That puts
  // the panel body symmetrically about the pose normal — which points INTO the
  // pyramid while shut and straight up while open — and leaves the back of the
  // panel as the only thing the team accent has to clear.
  const hingeRadius = petalThickness * 0.5;
  const hingeCapRadius = hingeRadius * 1.15;
  const petalSlabOffset = -hingeRadius;
  const teamAccentOffset = petalSlabOffset - teamAccentGap - teamAccentThickness;
  const petalStackDepth = -teamAccentOffset;
  // Standing the pin off the skin by its own radius plus the cell clearance is
  // what keeps the knuckle out of the pyramid and lands the shut panel's cell
  // face exactly `petalFaceClearance` above it.
  const petalPinStandoff = hingeRadius + petalFaceClearance;
  // Actuator wedge, as fractions of the face it drives: a reach roughly a
  // quarter of the way up the panel, and a coin thick enough to read as a
  // machined part rather than a fin.
  // Reach stops short of where the team accent starts up the panel, so the
  // wedge never eats into the ornament.
  const actuatorRadiusFraction = 0.28;
  const actuatorThicknessFraction = 0.09;

  const faces: readonly SolarFaceFrame[] = [
    solarFaceFrame(0, 1, depth * 0.5, width),
    solarFaceFrame(0, -1, depth * 0.5, width),
    solarFaceFrame(1, 0, width * 0.5, depth),
    solarFaceFrame(-1, 0, width * 0.5, depth),
  ];

  // How far up the face the hinge axis sits. The deployed panel hangs its
  // frame below the cell plane, so the axis has to clear that depth or the
  // inboard edge of an open panel would be buried in the ground. The strip of
  // face left bare underneath is what the hinge bar itself covers.
  const petalHingeRise = Math.max(
    0,
    ...faces.map((face) => Math.max(
      0,
      (petalStackDepth * Math.cos(petalTilt) - petalPinStandoff * face.normal.y) / face.up.y,
    )),
  );

  for (const face of faces) {
    const hinge = solarHingePoint(face, petalPinStandoff, petalHingeRise);
    // Shortened by the rise so the tip still meets the top plate when closed.
    const petalLength = (face.slant - petalHingeRise) / SOLAR_PETAL_CHOP_FRACTION;
    const closedDirection = face.up;
    const panelSideHint = face.outward.clone().multiplyScalar(-1);

    details.push(detail(makeHingeBar(
      solarPetalBackMat,
      face.span,
      hingeRadius,
      hinge,
      face.tangent,
    ), 'low'));
    details.push(detail(makeSolarActuator(
      solarPetalBackMat,
      face,
      hinge,
      face.slant * actuatorRadiusFraction,
      face.span * actuatorThicknessFraction,
      petalTilt,
    ), 'low', undefined, 'solarActuator'));
    // One slab, two materials: shiny cells on the inner face (group 0), dull
    // backing on the outer face and the edges (group 1).
    details.push(detail(makeTrianglePetal(
      [solarCellMat, solarPetalBackMat],
      face.span,
      petalLength,
      hinge,
      face,
      petalTilt,
      0,
      petalSlabOffset,
      petalThickness,
      closedDirection,
      panelSideHint,
    ), 'low', undefined, 'solarPanel'));
    details.push(teamOrnamentDetail(makeTrianglePetal(
      primaryMat,
      face.span * 0.58,
      petalLength * 0.42,
      hinge,
      face,
      petalTilt,
      petalLength * 0.2,
      teamAccentOffset,
      teamAccentThickness,
      closedDirection,
      panelSideHint,
    ), 'solarPetalInlay'));
  }

  // Caps close the four corners where adjacent hinge axes meet: each takes its
  // x from the side face's pin and its z from the front/back face's pin.
  for (const xFace of [faces[2], faces[3]]) {
    for (const zFace of [faces[0], faces[1]]) {
      const xPin = solarHingePoint(xFace, petalPinStandoff, petalHingeRise);
      const zPin = solarHingePoint(zFace, petalPinStandoff, petalHingeRise);
      details.push(detail(makeHingeCap(
        solarPetalBackMat,
        hingeCapRadius,
        xPin.x,
        (xPin.y + zPin.y) * 0.5,
        zPin.z,
      ), 'low', undefined, 'tinyTrim'));
    }
  }

  const minDim = Math.min(width, depth);
  const squareTopY = SOLAR_PETAL_CHOP_FRACTION * SOLAR_HEIGHT;

  // Crown plinth on the collector's flat top square. The pyramid itself is
  // material-locked photovoltaic art, so this two-step stack is where the
  // machine wears its identities: the wide lower plate is the OWNER's body
  // colour and the narrower plate above it is the ally-team trim, both read
  // straight down from the overhead camera. The energy pylon then rises out
  // of the stack instead of straight off the bare panel.
  const crownWidth = width * SOLAR_CHOP_HALF * 2;
  const crownDepth = depth * SOLAR_CHOP_HALF * 2;
  const ownerPlateHeight = Math.max(4, SOLAR_HEIGHT * 0.055);
  const teamPlateHeight = Math.max(3.2, SOLAR_HEIGHT * 0.045);
  details.push(playerColorDetail(makeBox(
    primaryMat,
    crownWidth * 0.99,
    ownerPlateHeight,
    crownDepth * 0.99,
    0,
    squareTopY + ownerPlateHeight * 0.5,
    0,
  )));
  details.push(teamOrnamentDetail(makeBox(
    primaryMat,
    crownWidth * 0.72,
    teamPlateHeight,
    crownDepth * 0.72,
    0,
    squareTopY + ownerPlateHeight + teamPlateHeight * 0.5,
    0,
  ), 'solarPetalInlay'));

  const ratePillarBaseY = squareTopY + ownerPlateHeight + teamPlateHeight;
  const shortRatePillarHeight = Math.max(10, Math.min(16, SOLAR_HEIGHT - ratePillarBaseY - 4));
  const ratePillarHeight = shortRatePillarHeight * 2;
  const ratePillarRadius = Math.max(3.8, minDim * 0.055);
  const energyPylon = buildResourcePylonRig({
    resource: 'energy',
    direction: 'inbound',
    pylonHeight: ratePillarHeight,
    pylonBaseY: ratePillarBaseY,
    x: 0,
    z: 0,
    pylonRadius: ratePillarRadius,
    sprayTravelSpeed: 120,
    sprayParticleRadius: Math.max(1.4, ratePillarRadius * 0.42),
    flowRadius: Math.max(36, ratePillarHeight * 1.35),
    coneAngle: PYLON_BUILDING_SOLAR_CONE_HALF_ANGLE_RAD,
    channel: 0,
    geometryTier: getActiveBuildingGeometryTier(),
  });
  for (const mesh of energyPylon.staticMeshes) {
    details.push(detail(mesh, 'low'));
  }

  return {
    primary,
    details,
    height: SOLAR_HEIGHT,
    authoredYaw: SOLAR_NATIVE_YAW,
    primaryMaterialLocked: true,
    solarRig: { pylon: energyPylon.rig },
  };
}

function makeTrianglePetal(
  material: THREE.Material | THREE.Material[],
  width: number,
  length: number,
  hinge: THREE.Vector3,
  face: SolarFaceFrame,
  openAngle: number,
  inset: number,
  normalOffset: number,
  thickness: number,
  closedDirection: THREE.Vector3,
  panelSideHint: THREE.Vector3,
): THREE.Mesh {
  const openDirection = new THREE.Vector3(0, Math.sin(openAngle), 0)
    .addScaledVector(face.outward, Math.cos(openAngle));
  const mesh = makeTrianglePlate(
    material,
    width,
    length,
    hinge,
    face.tangent,
    openDirection,
    inset,
    normalOffset,
    thickness,
    panelSideHint,
  );
  mesh.userData.solarPetal = {
    width,
    length,
    hinge: hinge.clone(),
    tangent: face.tangent.clone(),
    openDirection: openDirection.clone(),
    closedDirection: closedDirection.clone(),
    panelSideHint: panelSideHint.clone(),
    inset,
    normalOffset,
    thickness,
  } satisfies SolarPetalAnimation;
  return mesh;
}

function makeTrianglePlate(
  material: THREE.Material | THREE.Material[],
  width: number,
  length: number,
  hinge: THREE.Vector3,
  tangent: THREE.Vector3,
  petalDirection: THREE.Vector3,
  inset = 0,
  normalOffset = 0,
  thickness = 0,
  panelSideHint?: THREE.Vector3,
): THREE.Mesh {
  // A material list means the two-sided petal slab, whose groups split the
  // cell face from the backing; a single material is a plain extruded accent.
  const mesh = new THREE.Mesh(
    Array.isArray(material) ? solarPetalSlabGeom : solarTrianglePetalGeom,
    material,
  );
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(makeTrianglePlateMatrix(width, length, hinge, tangent, petalDirection, inset, normalOffset, thickness, panelSideHint));
  return mesh;
}

function makeTrianglePlateMatrix(
  width: number,
  length: number,
  hinge: THREE.Vector3,
  tangent: THREE.Vector3,
  petalDirection: THREE.Vector3,
  inset = 0,
  normalOffset = 0,
  thickness = 0,
  panelSideHint?: THREE.Vector3,
): THREE.Matrix4 {
  const matrix = new THREE.Matrix4();
  writeSolarPetalMatrix(
    matrix,
    width,
    length,
    hinge,
    tangent,
    petalDirection,
    inset,
    normalOffset,
    thickness,
    panelSideHint,
  );
  return matrix;
}

function writeSolarPetalMatrix(
  matrix: THREE.Matrix4,
  width: number,
  length: number,
  hinge: THREE.Vector3,
  tangent: THREE.Vector3,
  petalDirection: THREE.Vector3,
  inset = 0,
  normalOffset = 0,
  thickness = 0,
  panelSideHint?: THREE.Vector3,
): void {
  const tangentDir = _solarPetalTangent.copy(tangent).normalize();
  const petalDir = _solarPetalDirection.copy(petalDirection).normalize();
  const normal = _solarPetalNormal.crossVectors(tangentDir, petalDir).normalize();
  if (panelSideHint) {
    if (normal.dot(panelSideHint) < 0) normal.multiplyScalar(-1);
  } else if (normal.y < 0) {
    normal.multiplyScalar(-1);
  }
  const origin = _solarPetalOrigin.copy(hinge)
    .addScaledVector(petalDir, inset)
    .addScaledVector(normal, normalOffset);
  const xAxis = _solarPetalXAxis.copy(tangentDir).multiplyScalar(width);
  const yAxis = _solarPetalYAxis.copy(petalDir).multiplyScalar(Math.max(1, length - inset));
  const zAxis = _solarPetalZAxis.copy(normal).multiplyScalar(Math.max(1, thickness));
  matrix.makeBasis(xAxis, yAxis, zAxis);
  matrix.setPosition(origin);
}

/** Picks the wedge whose span matches the angle the petal currently makes with
 *  the ground, then stands it on the hinge axis.
 *
 * The sector is anchored by its panel edge, so that edge sits exactly on the
 * petal's mid-plane and the wedge emerges through the panel's outer face
 * instead of breaking the cell side. Spans round up, which pushes the small
 * quantisation error into the foot, where a fraction of a degree just buries
 * itself in the ground rather than leaving the wedge hovering. */
function applySolarActuatorPose(
  mesh: THREE.Mesh,
  anim: SolarActuatorAnimation,
  panelDirection: THREE.Vector3,
): void {
  const panelAngle = Math.atan2(panelDirection.y, panelDirection.dot(anim.outward));
  const span = Math.max(SOLAR_ACTUATOR_SPAN_STEP_RAD, panelAngle - anim.groundAngle);
  const geometry = getSolarActuatorGeometry(span, anim.tier);
  if (mesh.geometry !== geometry) mesh.geometry = geometry;
  const steps = Math.max(1, Math.ceil(span / SOLAR_ACTUATOR_SPAN_STEP_RAD));
  const footAngle = panelAngle - steps * SOLAR_ACTUATOR_SPAN_STEP_RAD;

  // Rigid, uniformly scaled: the wedge's own angle is already baked in, so the
  // two in-plane axes stay orthonormal and the rim stays a circle.
  _solarActuatorXAxis.copy(anim.outward).multiplyScalar(Math.cos(footAngle) * anim.radius);
  _solarActuatorXAxis.y += Math.sin(footAngle) * anim.radius;
  _solarActuatorYAxis.copy(anim.outward).multiplyScalar(-Math.sin(footAngle) * anim.radius);
  _solarActuatorYAxis.y += Math.cos(footAngle) * anim.radius;
  _solarActuatorZAxis.copy(anim.tangent).normalize().multiplyScalar(anim.thickness);
  mesh.matrix.makeBasis(_solarActuatorXAxis, _solarActuatorYAxis, _solarActuatorZAxis);
  // One coin standing at the petal's mid-span, so pull it back half its own
  // thickness off the pin.
  _solarActuatorOrigin.copy(anim.hinge).addScaledVector(_solarActuatorZAxis, -0.5);
  mesh.matrix.setPosition(_solarActuatorOrigin);
}

/** The actuator that drives one petal: a wedge standing on the ground just
 *  outside the pyramid, rising into the back of the panel. It pivots on the
 *  same axis as the hinge pin and wears the same coin orientation, and because
 *  its panel arm lies on the petal's mid-plane it emerges through the panel's
 *  outer face rather than clipping the cell side. */
function makeSolarActuator(
  material: THREE.Material,
  face: SolarFaceFrame,
  hinge: THREE.Vector3,
  radius: number,
  thickness: number,
  openAngle: number,
): THREE.Mesh {
  // The foot sits on the ground, far enough out that the arm reaching it is
  // the same length as the arm reaching the panel.
  const groundReach = Math.sqrt(Math.max(0, radius * radius - hinge.y * hinge.y));
  const openDirection = new THREE.Vector3(0, Math.sin(openAngle), 0)
    .addScaledVector(face.outward, Math.cos(openAngle));
  const anim: SolarActuatorAnimation = {
    hinge: hinge.clone(),
    tangent: face.tangent.clone(),
    outward: face.outward.clone(),
    groundAngle: Math.atan2(-hinge.y, groundReach),
    openDirection,
    closedDirection: face.up.clone(),
    radius,
    thickness,
    tier: getActiveBuildingGeometryTier(),
  };
  const mesh = new THREE.Mesh(getSolarActuatorGeometry(Math.PI * 0.5, anim.tier), material);
  mesh.matrixAutoUpdate = false;
  mesh.userData.solarActuator = anim;
  applySolarActuatorPose(mesh, anim, openDirection);
  return mesh;
}

function makeHingeBar(
  material: THREE.Material,
  length: number,
  radius: number,
  position: THREE.Vector3,
  tangent: THREE.Vector3,
): THREE.Mesh {
  const mesh = new THREE.Mesh(getBuildingCylinderGeometry(), material);
  mesh.scale.set(radius * 2, length, radius * 2);
  mesh.position.copy(position);
  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    _solarPetalTangent.copy(tangent).normalize(),
  );
  return mesh;
}

function detail(
  mesh: THREE.Mesh,
  _legacyVisibility?: unknown,
  _legacyMaxVisibility?: unknown,
  role: BuildingDetailRole = 'static',
): BuildingDetailMesh {
  return { mesh, role };
}

export function disposeSolarCollectorGeoms(): void {
  solarPanelPyramidGeom.dispose();
  solarPetalSlabGeom.dispose();
  for (const geometry of solarActuatorGeomByTierAndSpan.values()) geometry.dispose();
  solarActuatorGeomByTierAndSpan.clear();
  solarTrianglePetalGeom.dispose();
  for (const geometry of solarHingeCapGeometryByTier.values()) geometry.dispose();
  solarHingeCapGeometryByTier.clear();
  solarCellMat.dispose();
  solarPetalBackMat.dispose();
}
