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
const solarTrianglePanelGeom = new THREE.ShapeGeometry(solarTrianglePetalShape);
const solarTrianglePetalGeom = new THREE.ExtrudeGeometry(solarTrianglePetalShape, {
  depth: 1,
  bevelEnabled: false,
  steps: 1,
});
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

function isSolarPetalDetail(detail: BuildingDetailMesh): boolean {
  return detail.role === 'solarLeaf' ||
    detail.role === 'solarPanel' ||
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
  const petalThickness = 3.2;
  const panelRaise = 2.4;
  const teamAccentThickness = 0.85;
  const teamAccentGap = 0.35;
  /** Clearance between a folded panel's cell face and the pyramid skin. */
  const petalFaceClearance = 0.6;
  // Layer offsets along the pose normal, which points INTO the pyramid while
  // the panel is closed and straight up while it is open. The cell sheet sits
  // ON the hinge plane, because the pin is bolted to that inner face; every
  // other layer is negative, so the frame stacks outside the skin when closed
  // and hangs beneath the cells when open — the same plate either way.
  const petalPanelOffset = 0;
  const petalLeafOffset = petalPanelOffset - panelRaise - petalThickness;
  const teamAccentOffset = petalLeafOffset - teamAccentGap - teamAccentThickness;
  const petalStackDepth = -teamAccentOffset;

  const hingeRadius = Math.max(2.2, Math.min(width, depth) * 0.035);
  const hingeCapRadius = hingeRadius * 1.08;

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
    hingeRadius,
    ...faces.map((face) => Math.max(
      0,
      (petalStackDepth * Math.cos(petalTilt) - petalFaceClearance * face.normal.y) / face.up.y,
    )),
  );

  for (const face of faces) {
    const hinge = solarHingePoint(face, petalFaceClearance, petalHingeRise);
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
    details.push(detail(makeTrianglePetal(
      solarPetalBackMat,
      face.span,
      petalLength,
      hinge,
      face,
      petalTilt,
      0,
      petalLeafOffset,
      petalThickness,
      closedDirection,
      panelSideHint,
    ), 'low', undefined, 'solarLeaf'));
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
    details.push(detail(makeTrianglePetal(
      solarCellMat,
      face.span,
      petalLength,
      hinge,
      face,
      petalTilt,
      0,
      petalPanelOffset,
      0,
      closedDirection,
      panelSideHint,
    ), 'low', undefined, 'solarPanel'));
  }

  // Caps close the four corners where adjacent hinge axes meet: each takes its
  // x from the side face's pin and its z from the front/back face's pin.
  for (const xFace of [faces[2], faces[3]]) {
    for (const zFace of [faces[0], faces[1]]) {
      const xPin = solarHingePoint(xFace, petalFaceClearance, petalHingeRise);
      const zPin = solarHingePoint(zFace, petalFaceClearance, petalHingeRise);
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
  material: THREE.Material,
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
  material: THREE.Material,
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
  const mesh = new THREE.Mesh(
    thickness > 0
      ? solarTrianglePetalGeom
      : solarTrianglePanelGeom,
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
  solarTrianglePanelGeom.dispose();
  solarTrianglePetalGeom.dispose();
  for (const geometry of solarHingeCapGeometryByTier.values()) geometry.dispose();
  solarHingeCapGeometryByTier.clear();
  solarCellMat.dispose();
  solarPetalBackMat.dispose();
}
