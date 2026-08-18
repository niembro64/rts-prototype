import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import { SOLAR_BUILDING_VISUAL_HEIGHT } from '../sim/blueprints';
import {
  buildResourcePylonRig,
  type ResourcePylonRig,
} from './ResourcePylonMesh3D';
import { PYLON_BUILDING_SOLAR_CONE_HALF_ANGLE_RAD } from '@/resourceConfig';
import { MIRROR_CHROME_MATERIAL } from './BuildingVisualPalette';
import { easeBuildingActiveStateAmount } from './BuildingActiveStateTransition3D';
import type { BuildingDetailMesh, BuildingDetailRole, BuildingShape } from './BuildingShape3D';
import {
  boxGeom,
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

/** One petal's actuator piston.
 *
 * The foot is bolted to the ground just beyond the petal's swing, while the
 * head rides the outside of the panel halfway up its length, so the ram
 * lengthens as the collector shuts and draws in as it deploys. Three segments
 * share one record: a chromed rod running the full span and a coloured mount
 * sleeved over each end. */
type SolarPistonAnimation = {
  groundAnchor: THREE.Vector3;
  hinge: THREE.Vector3;
  /** Perpendicular to the plane the petal swings through — the ram's roll
   *  reference, so its cylinders never spin about their own axis. */
  tangent: THREE.Vector3;
  /** In-plane horizontal axis; with world up it spans that same plane. */
  outward: THREE.Vector3;
  openDirection: THREE.Vector3;
  closedDirection: THREE.Vector3;
  /** How far up the panel the head mounts, and how far it stands off the
   *  panel's mid-plane to reach the outer face. */
  headAlongPanel: number;
  headOuterOffset: number;
  rodRadius: number;
  mountRadius: number;
  mountLength: number;
  /** Pad bolted to the panel's outer face under the head, in panel axes:
   *  across the petal, out from its face, and along the petal. */
  panelFootingWidth: number;
  panelFootingHeight: number;
  panelFootingLength: number;
};

type SolarPistonSegment = 'rod' | 'groundMount' | 'panelMount' | 'panelFooting';

/** The ram is thin hardware — its silhouette barely reads even close up, and
 *  there are twelve cylinders of it per collector — so it is built one rung
 *  below the body it bolts to. At the far rung that is already the shared
 *  three-sided prism, which is all a rod that thin can justify. */
const SOLAR_PISTON_TIER: Readonly<Record<PrimitiveGeometryTier, PrimitiveGeometryTier>> = {
  close: 'mid',
  mid: 'far',
  far: 'far',
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
/** Hard-chromed ram rod. The only mirror-bright surface on the collector, so
 *  the moving part reads as machined metal against the matte panel backs. */
const solarPistonRodMat = new THREE.MeshStandardMaterial({
  ...MIRROR_CHROME_MATERIAL,
  side: THREE.FrontSide,
});
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
const _solarPistonDirection = new THREE.Vector3();
const _solarPistonHead = new THREE.Vector3();
const _solarPistonAxis = new THREE.Vector3();
const _solarPistonSide = new THREE.Vector3();
const _solarPistonXAxis = new THREE.Vector3();
const _solarPistonYAxis = new THREE.Vector3();
const _solarPistonZAxis = new THREE.Vector3();
const _solarPistonOrigin = new THREE.Vector3();

function isSolarPetalDetail(detail: BuildingDetailMesh): boolean {
  return detail.role === 'solarPanel' ||
    detail.role === 'solarActuator' ||
    detail.role === 'playerColorPlate' ||
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
    const piston = detail.mesh.userData.solarPiston as SolarPistonAnimation | undefined;
    if (piston) {
      _solarPistonDirection
        .copy(piston.closedDirection)
        .lerp(piston.openDirection, t)
        .normalize();
      writeSolarPistonMatrix(
        detail.mesh.matrix,
        piston,
        detail.mesh.userData.solarPistonSegment as SolarPistonSegment,
        _solarPistonDirection,
      );
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
  // Actuator ram, as fractions of the face it drives. The foot stands a little
  // beyond the arc the petal's outer corner sweeps, so the ram never has to
  // push through its own mounting point.
  const pistonFootFraction = 0.33;
  const pistonRodRadiusFraction = 0.032;
  const pistonMountRadiusFraction = 0.056;
  // Short bosses on purpose: at full deploy the ram closes to about a third of
  // its shut length, so long mounts would leave no rod showing at all.
  const pistonMountLengthFraction = 0.038;
  // Static foundation the ram's foot pivots in. Sized to swallow the ground
  // mount, so the ram reads as socketed into the ground rather than balanced
  // on it. It never animates — only the ram above it does.
  const pistonFootingWidthFraction = 0.17;
  const pistonFootingDepthFraction = 0.15;
  const pistonFootingHeightFraction = 0.038;
  // Its counterpart on the panel, which rides the petal. Sized off the coloured
  // boss it carries: wider than the boss across the petal, and twice the boss's
  // width along the petal — the direction that reads as vertical while shut.
  const pistonPanelFootingWidthScale = 1.2;
  const pistonPanelFootingLengthScale = 2;
  const pistonPanelFootingHeightScale = 0.3;

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
    const pistonMountDiameter = face.span * pistonMountRadiusFraction * 2;
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
    // Actuator ram. Foot bolted to the ground beyond the petal's swing, head
    // on the outside of the panel halfway up it.
    const pistonAnim: SolarPistonAnimation = {
      groundAnchor: new THREE.Vector3(hinge.x, 0, hinge.z)
        .addScaledVector(face.outward, face.slant * pistonFootFraction),
      hinge: hinge.clone(),
      tangent: face.tangent.clone(),
      outward: face.outward.clone(),
      openDirection: new THREE.Vector3(0, Math.sin(petalTilt), 0)
        .addScaledVector(face.outward, Math.cos(petalTilt)),
      closedDirection: closedDirection.clone(),
      headAlongPanel: petalLength * SOLAR_PETAL_CHOP_FRACTION * 0.5,
      headOuterOffset: hingeRadius,
      rodRadius: face.span * pistonRodRadiusFraction,
      mountRadius: face.span * pistonMountRadiusFraction,
      mountLength: face.span * pistonMountLengthFraction,
      panelFootingWidth: pistonMountDiameter * pistonPanelFootingWidthScale,
      panelFootingHeight: pistonMountDiameter * pistonPanelFootingHeightScale,
      panelFootingLength: pistonMountDiameter * pistonPanelFootingLengthScale,
    };
    details.push(detail(makeSolarPistonSegment(
      solarPistonRodMat,
      pistonAnim,
      'rod',
    ), 'low', undefined, 'solarActuator'));
    details.push(playerColorDetail(makeSolarPistonSegment(
      primaryMat,
      pistonAnim,
      'groundMount',
    )));
    details.push(detail(makeSolarPistonSegment(
      solarPetalBackMat,
      pistonAnim,
      'panelFooting',
    ), 'low', undefined, 'solarActuator'));
    details.push(teamOrnamentDetail(makeSolarPistonSegment(
      primaryMat,
      pistonAnim,
      'panelMount',
    ), 'solarPetalInlay'));
    // Faces are axis-aligned, so the footing's tangent/outward extents map
    // straight onto world width and depth.
    const footingWidth = face.span * pistonFootingWidthFraction;
    const footingDepth = face.span * pistonFootingDepthFraction;
    const footingHeight = face.span * pistonFootingHeightFraction;
    details.push(detail(makeBox(
      solarPetalBackMat,
      Math.abs(face.tangent.x) * footingWidth + Math.abs(face.outward.x) * footingDepth,
      footingHeight,
      Math.abs(face.tangent.z) * footingWidth + Math.abs(face.outward.z) * footingDepth,
      pistonAnim.groundAnchor.x,
      footingHeight * 0.5,
      pistonAnim.groundAnchor.z,
    ), 'low'));
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

/** Places one segment of a petal's piston.
 *
 * The head is recomputed from the live panel direction: out along the petal to
 * the mount point, then off the mid-plane onto the panel's outer face, which is
 * that direction turned a quarter turn within the swing plane. The rod spans
 * foot to head at full length and each mount is a short sleeve over one end, so
 * the rod slides into them as the ram draws in and no seam can split open. */
function writeSolarPistonMatrix(
  matrix: THREE.Matrix4,
  anim: SolarPistonAnimation,
  segment: SolarPistonSegment,
  panelDirection: THREE.Vector3,
): void {
  const alongOutward = panelDirection.dot(anim.outward);
  const alongUp = panelDirection.y;
  _solarPistonHead.copy(anim.hinge)
    .addScaledVector(panelDirection, anim.headAlongPanel)
    .addScaledVector(anim.outward, alongUp * anim.headOuterOffset);
  _solarPistonHead.y -= alongOutward * anim.headOuterOffset;

  if (segment === 'panelFooting') {
    // Flat on the panel's outer face and square to the petal, so it reads as
    // bolted to the panel rather than as part of the ram.
    _solarPistonSide.copy(anim.outward).multiplyScalar(alongUp);
    _solarPistonSide.y -= alongOutward;
    _solarPistonXAxis.copy(anim.tangent).normalize().multiplyScalar(anim.panelFootingWidth);
    _solarPistonYAxis.copy(_solarPistonSide).multiplyScalar(anim.panelFootingHeight);
    _solarPistonZAxis.copy(panelDirection).multiplyScalar(anim.panelFootingLength);
    matrix.makeBasis(_solarPistonXAxis, _solarPistonYAxis, _solarPistonZAxis);
    _solarPistonOrigin.copy(_solarPistonHead)
      .addScaledVector(_solarPistonSide, anim.panelFootingHeight * 0.5);
    matrix.setPosition(_solarPistonOrigin);
    return;
  }

  _solarPistonAxis.copy(_solarPistonHead).sub(anim.groundAnchor);
  const span = Math.max(1e-3, _solarPistonAxis.length());
  _solarPistonAxis.multiplyScalar(1 / span);
  // The swing plane's normal is a stable roll reference, so the cylinders never
  // spin about their own axis as the ram swings.
  _solarPistonSide.crossVectors(_solarPistonAxis, anim.tangent).normalize();

  const isRod = segment === 'rod';
  const radius = isRod ? anim.rodRadius : anim.mountRadius;
  // The bosses are fixed-length hardware pinned to their endpoints — only the
  // chromed rod between them changes length as the ram works.
  const length = isRod ? span : anim.mountLength;
  _solarPistonXAxis.copy(anim.tangent).normalize().multiplyScalar(radius * 2);
  _solarPistonYAxis.copy(_solarPistonAxis).multiplyScalar(length);
  _solarPistonZAxis.copy(_solarPistonSide).multiplyScalar(radius * 2);
  matrix.makeBasis(_solarPistonXAxis, _solarPistonYAxis, _solarPistonZAxis);

  // Cylinders are centred on their own origin, so each segment sits at the
  // midpoint of the stretch it covers.
  if (isRod) {
    _solarPistonOrigin.copy(anim.groundAnchor).addScaledVector(_solarPistonAxis, span * 0.5);
  } else if (segment === 'groundMount') {
    _solarPistonOrigin.copy(anim.groundAnchor).addScaledVector(_solarPistonAxis, length * 0.5);
  } else {
    _solarPistonOrigin.copy(_solarPistonHead).addScaledVector(_solarPistonAxis, -length * 0.5);
  }
  matrix.setPosition(_solarPistonOrigin);
}

/** Builds one segment of a petal's ram against a shared animation record. */
function makeSolarPistonSegment(
  material: THREE.Material,
  anim: SolarPistonAnimation,
  segment: SolarPistonSegment,
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    segment === 'panelFooting'
      ? boxGeom
      : getBuildingCylinderGeometry(SOLAR_PISTON_TIER[getActiveBuildingGeometryTier()]),
    material,
  );
  mesh.matrixAutoUpdate = false;
  mesh.userData.solarPiston = anim;
  mesh.userData.solarPistonSegment = segment;
  writeSolarPistonMatrix(mesh.matrix, anim, segment, anim.openDirection);
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
  solarTrianglePetalGeom.dispose();
  for (const geometry of solarHingeCapGeometryByTier.values()) geometry.dispose();
  solarHingeCapGeometryByTier.clear();
  solarCellMat.dispose();
  solarPistonRodMat.dispose();
  solarPetalBackMat.dispose();
}
