// TankRig3D — a static tread belt shell + an animated cleat strip,
// for tracked locomotion units. The interior is a single non-spinning
// shell (a rounded slab of boxes + cylindrical end caps at High/Medium,
// one envelope box at Low); the only per-frame motion is the cleat
// scroll, driven by per-side body motion. There are no spinning road
// wheels inside the belt.
//
// Each side (left/right ribbon) lives in its own sub-group and carries
// the four canonical visual state channels:
//
//   movement position  →  side group local Y (`lift`)
//   movement velocity  →  integrated from lift via the EMA on `lift`
//   rotation position  →  `beltPhase` (where cleats sit on the belt loop)
//   rotation velocity  →  `beltVelocity` (linear m/s along belt tangent)
//
// High/Medium animation plays without checking whether the side is
// touching ground. Position EMAs toward the floor-clamp target every
// frame; belt velocity EMAs toward the per-side body-motion-derived
// target every frame. Low uses static envelope boxes while retaining
// the position clamp and contact samples. See the "Locomotion Visuals Are Frontend"
// section of budget_design_philosophy.html.

import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import type { Entity, PlayerId } from '../sim/types';
import type { TankConfig } from '@/types/blueprints';
import { TREAD_CHASSIS_LIFT_Y } from '../math/BodyDimensions';
import {
  type LocomotionBase,
  type LocomotionRenderPose,
  type RollingContactState,
  chassisUpFromPose,
  emaAlpha,
  rollingContact,
  rollingLocomotionBodyActive,
  sampleRollingContactDistance,
  sampleRollingContactPosition,
  transformChassisToWorld,
  wrappedRollingPhase,
} from './LocomotionRigShared3D';
import {
  sampleLocomotionPartClamp,
  type LocomotionPartClamp,
} from './LocomotionTerrainSampler';
import { getLocomotionMatByCache } from './RenderUtils';
import { REFERENCE_TRACK_LENGTH } from './SurfaceChart3D';
import { applyChartToMesh, applyVertexChartsToMesh } from './SurfaceChartMaterial3D';
import type { SurfaceChartId } from './SurfaceChart3D';
import { type PrimitiveGeometryTier } from './PrimitiveGeometryQuality3D';

const TREAD_COLOR = COLORS.units.locomotion.tread.slab.colorHex;
const _treadClamp: LocomotionPartClamp = { groundY: 0, renderedY: 0 };
const TREAD_HEIGHT = TREAD_CHASSIS_LIFT_Y;
const TREAD_Y = TREAD_HEIGHT / 2;
/**
 * CLEAT GEOMETRY IS ABSOLUTE. These are world units, not fractions of
 * anything — except the one width ratio, which is called out below.
 *
 * A track is a chain of standard parts. The belt it runs on is sized to the
 * unit — a Mammoth's is wider and longer than a Lynx's — but the grousers
 * bolted to it come off the same production line, so their depth along the
 * belt, their height, and the pitch between them do not change from one unit
 * to the next. Deriving them from the unit's radius, as this did, made a big
 * unit's track read as a coarse conveyor and a small one's as a fine chain,
 * which is the opposite of what a shared chassis part looks like.
 *
 * The pitch is a TARGET rather than an exact spacing, because a chain has to
 * close: the count is rounded to fit the belt's loop and the spacing falls
 * out of that. The deviation is larger on a short belt than a long one, since
 * a loop that fits five cleats can only be off by a fifth of one.
 *
 * Depth and pitch move together — doubling both keeps the duty ratio at 0.4,
 * so the bars stay the same proportion of the belt they sit on and only the
 * scale of the pattern changes. The radial numbers are independent of that
 * rhythm and of the unit: they are properties of the part.
 */
/** How far the grouser stands proud of the belt surface. The only radial
 *  number with a silhouette — it alone decides where the outer face lands
 *  and how coarse the track reads edge-on. */
const TREAD_CLEAT_PROUD = 1.1;
/**
 * Radial thickness of the whole bar, root to tip. Twice the proud height,
 * because a cleat is CENTRED ON the belt surface rather than resting on it:
 * half stands out, half is rooted inside the shell.
 *
 * A bar that only kissed the belt was tangent to it, which is true on the
 * straights and a lie on the rounded ends — a flat box meets a curve along a
 * single line, so both of its ends lifted off the arc by the chord's sagitta
 * and the teeth visibly floated as they came round the drive and the idler.
 * Sinking the root a full proud-height into the shell swallows that gap at
 * every arc position, and does it without moving the outer face by a hair:
 * what changes is only the half nobody could see.
 */
const TREAD_CLEAT_THICKNESS = TREAD_CLEAT_PROUD * 2;
const TREAD_CLEAT_LENGTH = 3.2;
/** Span across the belt, as a fraction of its width. The one cleat dimension
 *  that stays relative — a grouser spans the track it is bolted across, and a
 *  fixed width would leave a strip down the middle of a wide belt and overhang
 *  a narrow one. Deliberately under 1: at exactly 1 the bar's side faces were
 *  coplanar with the shell's, which is a coincident-surface flicker and the
 *  wrong read besides. The belt has to show past its own grousers on both
 *  sides for them to look bolted on rather than milled in. */
const TREAD_CLEAT_WIDTH_RATIO = 0.85;
/** Target spacing along the belt. The near rung is the real number; the mid
 *  rung doubles it, which is a distance decision rather than a size one — a
 *  belt at that range is a few dozen pixels and the halved count is not
 *  resolvable. */
const TREAD_CLEAT_PITCH: Record<PrimitiveGeometryTier, number> = {
  close: 8,
  mid: 16,
  far: 16,
};

// Movement-position EMA tau for the per-side lift. Drives the side
// toward the floor-clamp target each frame; long enough that terrain
// undulations read as suspension travel, short enough that the side
// doesn't lag the chassis on rolling ground.
const TREAD_LIFT_TAU_SEC = 0.12;
// Rotation-velocity EMA tau for cleat scroll velocity (and internal
// wheel angular velocity, derived from the same per-side beltVelocity).
// Short enough that treads grip body motion tightly, long enough that
// a sudden velocity change doesn't manifest as an instantaneous cleat
// scroll rate change.
const TREAD_BELT_TAU_SEC = 0.04;
const TREAD_LIFT_SETTLED_EPSILON = 0.02;
const TREAD_BELT_SETTLED_EPSILON = 0.02;

const treadBoxGeom = new THREE.BoxGeometry(1, 1, 1);
treadBoxGeom.name = 'tankTreadBox';

// One watertight stadium (rounded-rectangle) prism for the belt shell, cached
// per (dimensions, tier). A single extruded solid — not a slab box with
// cylinder end caps punched into it — so no interior triangles overlap or
// intersect. Cached module-side like the shared box geometry above.
const treadShellGeoms = new Map<string, THREE.ExtrudeGeometry>();

function getTreadShellGeom(
  straightLength: number,
  treadRadius: number,
  width: number,
  tier: PrimitiveGeometryTier,
): THREE.ExtrudeGeometry {
  const arcSegs = tier === 'mid' ? 6 : 10;
  const key = `${straightLength.toFixed(2)}:${treadRadius.toFixed(2)}:${width.toFixed(2)}:${tier}`;
  let geom = treadShellGeoms.get(key);
  if (!geom) {
    const hs = straightLength / 2;
    const shape = new THREE.Shape();
    shape.moveTo(-hs, -treadRadius);
    shape.lineTo(hs, -treadRadius); // bottom straight
    shape.absarc(hs, 0, treadRadius, -Math.PI / 2, Math.PI / 2, false); // front semicircle
    shape.lineTo(-hs, treadRadius); // top straight
    shape.absarc(-hs, 0, treadRadius, Math.PI / 2, Math.PI * 1.5, false); // back semicircle
    geom = new THREE.ExtrudeGeometry(shape, {
      depth: width,
      bevelEnabled: false,
      steps: 1,
      curveSegments: arcSegs,
    });
    geom.translate(0, 0, -width / 2); // centre the extrusion across the belt width
    remapTreadShellUvs(geom, hs, treadRadius, width);
    treadShellGeoms.set(key, geom);
  }
  return geom;
}

/**
 * Give the belt shell a parameterization a track band can actually use.
 *
 * THREE's extrude UV generator hands the flat side plates the shape's own
 * (x, y) and the running rim an (axis, z) pair, both in raw local units. A
 * chart maps uv across its rectangle, so raw units peg the whole surface at
 * one edge of the band; and even normalized, "x across the plate" and "z
 * across the rim" are not the same axis, so one band could not serve both.
 *
 * Rewritten, both surfaces agree on what u and v MEAN:
 *
 *   u  along the belt — arc position around the stadium for the rim, and
 *      length along the frame for the side plates.
 *   v  across the belt — the frame's height on the plates, the track's
 *      width on the rim.
 *
 * That is what lets one band draw link seams that run transversely on both,
 * and it is what makes the u repeat (which follows the belt's real length)
 * mean the same thing on either surface.
 */
function remapTreadShellUvs(
  geometry: THREE.ExtrudeGeometry,
  halfStraight: number,
  treadRadius: number,
  width: number,
): void {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const uv = geometry.getAttribute('uv');
  if (position === undefined || normal === undefined || uv === undefined) return;

  const straight = halfStraight * 2;
  const perimeter = 2 * straight + 2 * Math.PI * treadRadius;
  const totalLength = straight + 2 * treadRadius;

  for (let i = 0; i < uv.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    if (Math.abs(normal.getZ(i)) > 0.5) {
      // Flat side plate: straight along the frame, up its height.
      uv.setXY(
        i,
        (x + totalLength / 2) / totalLength,
        (y + treadRadius) / (2 * treadRadius),
      );
      continue;
    }
    // Running rim: walk the stadium outline from the bottom-straight's rear
    // end, so u is a true arc fraction and wraps continuously.
    let arc: number;
    if (x >= halfStraight) {
      arc = straight * 0.5 + treadRadius * (Math.atan2(y, x - halfStraight) + Math.PI / 2);
    } else if (x <= -halfStraight) {
      arc = straight * 1.5 + Math.PI * treadRadius
        + treadRadius * (Math.atan2(y, x + halfStraight) - Math.PI / 2);
    } else if (y >= 0) {
      arc = straight + Math.PI * treadRadius + (halfStraight - x);
    } else {
      arc = x + halfStraight;
    }
    uv.setXY(i, arc / perimeter, (z + width / 2) / width);
  }
  uv.needsUpdate = true;
}

const treadMats = new Map<number, THREE.MeshLambertMaterial>();
const cleatMats = new Map<number, THREE.MeshLambertMaterial>();

/**
 * Belt slabs and rounded end caps never change in their side-local space.
 * Their parent still carries the live suspension lift, but freezing their
 * local matrices skips needless position/scale/quaternion recomposition on
 * every display frame for every tracked vehicle.
 */
function freezeStaticLocalTransform(mesh: THREE.Mesh): void {
  mesh.updateMatrix();
  mesh.matrixAutoUpdate = false;
}

/** Per-side state owned by the rig. The `group` holds the side's
 *  slab, end caps, internal wheels, and animated cleats — all in a
 *  frame where local origin is the side's lateral offset, so the
 *  per-frame floor clamp can rewrite local Y without touching any
 *  child. `lift` / `beltPhase` / `beltVelocity` are the four visual
 *  state channels for the side. */
type TreadSide = {
  /** -1 for the left rail, +1 for the right rail. */
  side: -1 | 1;
  /** Lateral offset from chassis center, from this belt's authored mount. */
  lateralOffset: number;
  group: THREE.Group;
  /** Movement-position channel: side group local Y offset above the
   *  baseline 0. EMA-converges toward whatever lift the floor clamp
   *  requires every frame. */
  lift: number;
  /** Last sampled lift target. Lets the render-side active queue stop
   *  updating a stationary tread side once the lift EMA has settled. */
  targetLift: number;
  /** Rotation-position channel: cleat phase distance along the belt
   *  loop. Integrated from `beltVelocity * dt` every frame; wraps to
   *  `cleatLoopLength` when laying out cleats. */
  beltPhase: number;
  /** Rotation-velocity channel: cleat scroll velocity in world units
   *  per second along the belt tangent. EMA-couples to the per-side
   *  body-motion signed distance every frame. */
  beltVelocity: number;
  /** Logical internal-wheel phase. Kept even at Low, where the internal
   * wheel meshes are absent, so changing LOD cannot reset their rotation. */
  wheelRotation: number;
  /** Wrapped phase the cleats were last laid out at. A settled belt (see
   *  the velocity snap below) keeps an unchanged phase, so the whole
   *  per-cleat transform pass — up to 44 meshes on a heavy tank — skips. */
  lastCleatLayoutPhase: number;
};

export type TankMesh = {
  type: 'tank';
  group: THREE.Group;
  sides: TreadSide[];
  wheels: THREE.Mesh[];
  /** Per-internal-wheel side index (0 or 1) into `sides[]`, so the
   *  per-frame loop knows which beltVelocity drives this wheel. */
  wheelSide: number[];
  /** Per-side rolling contact at (0, ±offset). Tracks the world XY of
   *  each ribbon's center so per-frame signed distance can be sampled
   *  as the input to the belt-velocity EMA. */
  treadContacts: RollingContactState[];
  /** Animated cleat strips around the tread belt (empty below the
   *  `treadCleats` LOD feature rung). The first half is the left side,
   *  the second half the right side; layout consumes `beltPhase` per side. */
  cleats: THREE.Mesh[];
  cleatSpacing: number;
  cleatLoopLength: number;
  treadStraightLength: number;
  treadRadius: number;
  /** Maximum chassis-local suspension travel. A support surface can
   *  lift the belt within this envelope, never detach the whole rig. */
  maxLift: number;
  /** Width of the rut a single tread side stamps onto the ground, in
   *  world units. Roughly the cleat width — narrower than the full
   *  belt so the two parallel ruts are visually separated rather
   *  than reading as one wide smear. */
  printWidth: number;
  /** False when the resolved LOD rung has no cleats and therefore needs
   *  no belt-phase integration. */
  rotationAnimated: boolean;
} & LocomotionBase;

export function buildTank(
  unitGroup: THREE.Group,
  r: number,
  cfg: TankConfig,
  cleatsVisible: boolean,
  ownerId: PlayerId | undefined,
  geometryTier: PrimitiveGeometryTier = 'close',
): TankMesh {
  const group = new THREE.Group();
  const length = r * cfg.treadLength;
  const width = r * cfg.treadWidth;
  const treadRadius = Math.min(TREAD_HEIGHT / 2, Math.max(1, length / 2));
  const straightLength = Math.max(1, length - 2 * treadRadius);

  const sides: TreadSide[] = [];
  const wheels: THREE.Mesh[] = [];
  const wheelSide: number[] = [];
  const cleats: THREE.Mesh[] = [];
  let cleatSpacing = 0;
  const cleatLoopLength = 2 * straightLength + 2 * Math.PI * treadRadius;
  const treadMat = getLocomotionMatByCache(treadMats, TREAD_COLOR, ownerId);
  // How many reference tracks' worth of belt this one is. Link seams then
  // stay the same physical distance apart on a Lynx and on a Mammoth; the
  // chart rounds it whole so the belt's loop still meets itself.
  const beltChartScale = length / REFERENCE_TRACK_LENGTH;
  const cleatMat = getLocomotionMatByCache(
    cleatMats,
    COLORS.units.locomotion.tread.cleat.colorHex,
    ownerId,
  );
  cleatMat.side = THREE.DoubleSide;

  // One authored mount per belt. `treadOffset` used to be a single lateral
  // scalar reflected into two sides, so a track could not be given its own
  // height and nothing recorded how far it stood off the hull — which is how
  // every tracked unit ended up with its belts buried in its own body.
  for (const mount of cfg.mounts) {
    const side = mount.yUnitRadiusRatio < 0 ? -1 : 1;
    const sideGroup = new THREE.Group();
    sideGroup.position.set(
      r * mount.xUnitRadiusRatio,
      r * mount.zUnitRadiusRatio - TREAD_Y,
      r * mount.yUnitRadiusRatio,
    );
    group.add(sideGroup);

    if (geometryTier === 'far') {
      // Low is a single box per side, sized to the complete authored
      // track envelope. It preserves the high-detail rig's overall
      // length, height, width, and lateral placement without moving parts.
      const treadBox = new THREE.Mesh(treadBoxGeom, treadMat);
      treadBox.scale.set(length, TREAD_HEIGHT, width);
      treadBox.position.set(0, TREAD_Y, 0);
      // Only the box's two flat sides are the track's outward face; its top,
      // bottom and ends are running gear. BoxGeometry lays out six unshared
      // four-corner faces in +X, -X, +Y, -Y, +Z, -Z order, and the side group
      // is offset along Z, so the flat sides are the last eight vertices.
      applyVertexChartsToMesh(
        treadBox,
        'trackBeltEnvelope',
        (i) => (i >= 16 ? 'trackBelt' : 'trackRun'),
        beltChartScale,
      );
      freezeStaticLocalTransform(treadBox);
      sideGroup.add(treadBox);
    } else {
      // High/medium: one watertight stadium prism for the belt shell -- flat
      // straights joined by semicircular ends, no overlapping interior
      // triangles. The shape's X/Y are the belt length/height and the extrusion
      // depth is the belt width, so it drops straight into the side group.
      const shell = new THREE.Mesh(
        getTreadShellGeom(straightLength, treadRadius, width, geometryTier),
        treadMat,
      );
      shell.position.set(0, TREAD_Y, 0);
      // ONE MESH, TWO SURFACES. The shell's flat outer faces are the track's
      // face — the only part of it with real area square-on to the camera, and
      // the one place a track's detail is legible. The extruded rim between
      // them is running gear, glimpsed edge-on between the grousers, and takes
      // the plain band the cleats do. Splitting them per-vertex says that
      // without splitting the mesh and doubling the draw calls.
      const shellNormal = shell.geometry.getAttribute('normal');
      applyVertexChartsToMesh(
        shell,
        `trackBeltShell:${straightLength.toFixed(2)}:${treadRadius.toFixed(2)}`
          + `:${width.toFixed(2)}:${geometryTier}`,
        (i): SurfaceChartId => (
          Math.abs(shellNormal.getZ(i)) > 0.5 ? 'trackBelt' : 'trackRun'
        ),
        beltChartScale,
      );
      freezeStaticLocalTransform(shell);
      sideGroup.add(shell);
    }

    sides.push({
      side,
      lateralOffset: r * mount.yUnitRadiusRatio,
      group: sideGroup,
      lift: 0,
      targetLift: 0,
      beltPhase: 0,
      lastCleatLayoutPhase: Number.NaN,
      beltVelocity: 0,
      wheelRotation: 0,
    });
  }

  // One rolling-contact sampler per belt, at that belt's own mount.
  const treadContacts: RollingContactState[] = cfg.mounts.map(
    (mount) => rollingContact(r * mount.xUnitRadiusRatio, r * mount.yUnitRadiusRatio),
  );

  if (cleatsVisible) {
    // Animated cleats cover the full belt loop: top run, rounded front
    // return, bottom ground-contact run, and rounded rear return. This
    // makes treads read correctly from side/front/back instead of
    // looking like a square slab with only top markings.
    const cleatCount = Math.max(
      4,
      Math.round(cleatLoopLength / TREAD_CLEAT_PITCH[geometryTier]),
    );
    cleatSpacing = cleatLoopLength / cleatCount;
    const cleatLen = TREAD_CLEAT_LENGTH;
    const cleatWidth = width * TREAD_CLEAT_WIDTH_RATIO;
    const cleatsPerSide = cleatCount + 1;
    for (let s = 0; s < 2; s++) {
      const sideGroup = sides[s].group;
      for (let i = 0; i < cleatsPerSide; i++) {
        const cleat = new THREE.Mesh(treadBoxGeom, cleatMat);
        cleat.scale.set(cleatLen, TREAD_CLEAT_THICKNESS, cleatWidth);
        // Bright unpainted steel against the belt's dark band. Both bands are
        // equally plain — they differ in VALUE, not in busyness, because what
        // a track reads as in motion is the rhythm of light bars crossing a
        // dark ribbon, and a cleat drawn at the belt's own value is a cleat
        // nobody can see.
        applyChartToMesh(cleat, 'trackCleat', 'trackCleat');
        layoutTreadCleat(cleat, i * cleatSpacing, straightLength, treadRadius);
        sideGroup.add(cleat);
        cleats.push(cleat);
      }
    }
  }

  unitGroup.add(group);
  // Rut width is the belt's full width — the whole track presses ground,
  // not just the bars across it — floored so the left+right ruts stay two
  // resolvable parallel lines instead of degenerating to nothing.
  const printWidth = Math.max(0.5, width);
  return {
    type: 'tank',
    group,
    sides,
    wheels,
    wheelSide,
    treadContacts,
    cleats,
    cleatSpacing,
    cleatLoopLength,
    treadStraightLength: straightLength,
    treadRadius,
    maxLift: Math.max(1, Math.min(r * 0.35, TREAD_HEIGHT)),
    printWidth,
    rotationAnimated: cleatsVisible,
    geometryKey: '',
  };
}

// Scratch reused per frame so the tread loop never allocates.
const _treadWorld = { x: 0, y: 0, z: 0 };
const _treadUp = { x: 0, y: 1, z: 0 };

/** Per-frame: integrate each side's visual channels forward. The floor
 *  clamp drives the lift channel via EMA; the per-side signed distance
 *  drives the beltVelocity channel via EMA. beltPhase integrates from
 *  beltVelocity and feeds the cleat layout. Rungs without the
 *  `treadCleats` feature skip belt scroll while retaining the floor clamp.
 *  The interior is a single static belt shell (no spinning road wheels),
 *  so only the cleats move. */
export function updateTank(
  mesh: TankMesh,
  entity: Entity,
  pose: LocomotionRenderPose,
  dtMs: number,
  mapWidth: number,
  mapHeight: number,
): boolean {
  const dtSec = Math.max(0.001, dtMs / 1000);
  // Convert a world-Y lift back into a chassis-local Y delta. Tilt
  // rotates local Y through the surface normal; the local lift needed
  // to raise the side by `worldLift` world units is approximately
  // `worldLift / normal.z` (with the same 0.35 floor CrawlerRig3D uses).
  chassisUpFromPose(pose, _treadUp);
  const normalY = Math.max(0.35, _treadUp.y);
  const liftAlpha = emaAlpha(dtSec, TREAD_LIFT_TAU_SEC);
  const beltAlpha = emaAlpha(dtSec, TREAD_BELT_TAU_SEC);

  // Sample localX positions along each side's belt straight section:
  // rear, mid, front. The slab's bottom sits at world Y = side world
  // Y − treadRadius (treadRadius is also the half-height of the rounded
  // end cap and the slab's vertical half-extent), so the floor clamp
  // wants the side center to be at least `treadRadius` above terrain.
  const halfStraight = mesh.treadStraightLength / 2;
  for (let s = 0; s < mesh.sides.length; s++) {
    const sideEntry = mesh.sides[s];

    // ── Movement-position channel: lift ──────────────────────────
    // Walk the 3 sample points, take the max world-lift required by
    // any of them. EMA-converge `lift` toward that target every frame.
    let maxRequiredLocalLift = 0;
    for (let p = 0; p < 3; p++) {
      const localX = p === 0 ? -halfStraight : p === 1 ? 0 : halfStraight;
      transformChassisToWorld(
        localX, 0, sideEntry.lateralOffset,
        pose, _treadWorld,
      );
      const naturalWorldY = _treadWorld.y;
      const clamp = sampleLocomotionPartClamp(
        _treadWorld.x, _treadWorld.z,
        naturalWorldY, mesh.treadRadius,
        mapWidth, mapHeight,
        entity.id,
        _treadClamp,
      );
      const worldLift = clamp.renderedY - naturalWorldY;
      if (worldLift > 0) {
        const localLift = worldLift / normalY;
        if (localLift > maxRequiredLocalLift) maxRequiredLocalLift = localLift;
      }
    }
    maxRequiredLocalLift = Math.min(mesh.maxLift, maxRequiredLocalLift);
    sideEntry.targetLift = maxRequiredLocalLift;
    sideEntry.lift += (maxRequiredLocalLift - sideEntry.lift) * liftAlpha;
    sideEntry.group.position.y = sideEntry.lift;

    // ── Rotation-velocity channel: beltVelocity ──────────────────
    // Target scroll velocity is always derived from the per-side
    // signed distance. The EMA gives the belt a hair of inertia so
    // a sudden body velocity change doesn't manifest as a cleat-scroll
    // discontinuity.
    const contact = mesh.treadContacts[s];
    if (mesh.rotationAnimated && !pose.carried) {
      const signedDistance = contact !== undefined
        ? sampleRollingContactDistance(pose, contact)
        : 0;
      const targetBeltVelocity = signedDistance / dtSec;
      sideEntry.beltVelocity += (targetBeltVelocity - sideEntry.beltVelocity) * beltAlpha;
      // Snap the EMA tail to a full stop: otherwise the phase creeps by
      // sub-visible amounts forever and the settled-cleat skip below can
      // never engage. Same epsilon the frame-gating predicate uses.
      if (Math.abs(sideEntry.beltVelocity) <= TREAD_BELT_SETTLED_EPSILON) {
        sideEntry.beltVelocity = 0;
      }

      // ── Rotation-position channel: beltPhase ───────────────────
      // Integrate from the velocity channel. Wraps modulo
      // cleatLoopLength implicitly inside the cleat layout helper.
      sideEntry.beltPhase += sideEntry.beltVelocity * dtSec;
    } else {
      if (contact !== undefined) sampleRollingContactPosition(pose, contact);
      sideEntry.beltVelocity = 0;
    }
  }

  // Lay out cleats from each side's beltPhase.
  if (mesh.cleats.length > 0 && mesh.cleatSpacing > 0) {
    const spacing = mesh.cleatSpacing;
    const cleatsPerSide = mesh.cleats.length / 2;
    for (let s = 0; s < 2; s++) {
      const sideEntry = mesh.sides[s];
      const phaseOff = wrappedRollingPhase(sideEntry.beltPhase, mesh.cleatLoopLength);
      if (phaseOff === sideEntry.lastCleatLayoutPhase) continue;
      sideEntry.lastCleatLayoutPhase = phaseOff;
      const baseIdx = s * cleatsPerSide;
      for (let i = 0; i < cleatsPerSide; i++) {
        layoutTreadCleat(
          mesh.cleats[baseIdx + i],
          phaseOff + i * spacing,
          mesh.treadStraightLength,
          mesh.treadRadius,
        );
      }
    }
  }
  return treadsNeedFrame(mesh, pose);
}

function treadsNeedFrame(mesh: TankMesh, pose: LocomotionRenderPose): boolean {
  if (rollingLocomotionBodyActive(pose)) return true;
  for (let s = 0; s < mesh.sides.length; s++) {
    const contact = mesh.treadContacts[s];
    if (contact === undefined || !contact.initialized) return true;
    const side = mesh.sides[s];
    if (Math.abs(side.targetLift - side.lift) > TREAD_LIFT_SETTLED_EPSILON) return true;
    if (Math.abs(side.beltVelocity) > TREAD_BELT_SETTLED_EPSILON) return true;
  }
  return false;
}

/** Lay one cleat mesh on the belt loop given its phase distance.
 *  Wraps around: front-top → front-arc → bottom → rear-arc → repeat.
 *  Lateral position is owned by the side group the cleat is parented
 *  to (sideZ = 0 here). */
function layoutTreadCleat(
  cleat: THREE.Mesh,
  distance: number,
  straightLength: number,
  treadRadius: number,
): void {
  const halfStraight = straightLength / 2;
  const arcLength = Math.PI * treadRadius;
  const loopLength = 2 * straightLength + 2 * arcLength;
  let d = ((distance % loopLength) + loopLength) % loopLength;
  // Centre of the bar, not its outer face: the cleat straddles the belt
  // surface, standing TREAD_CLEAT_PROUD out of it and rooting the rest
  // inside the shell. Spelled out as face-minus-half-thickness rather than
  // as the bare belt radius so the two radial constants stay independent.
  const cleatRadius = treadRadius + TREAD_CLEAT_PROUD - TREAD_CLEAT_THICKNESS / 2;

  let x = 0;
  let y = 0;
  let angle = 0;

  if (d < straightLength) {
    x = -halfStraight + d;
    y = TREAD_Y + cleatRadius;
    angle = 0;
  } else {
    d -= straightLength;
    if (d < arcLength) {
      const theta = Math.PI / 2 - d / treadRadius;
      x = halfStraight + Math.cos(theta) * cleatRadius;
      y = TREAD_Y + Math.sin(theta) * cleatRadius;
      angle = Math.atan2(-Math.cos(theta), Math.sin(theta));
    } else {
      d -= arcLength;
      if (d < straightLength) {
        x = halfStraight - d;
        y = TREAD_Y - cleatRadius;
        angle = Math.PI;
      } else {
        d -= straightLength;
        const theta = -Math.PI / 2 - d / treadRadius;
        x = -halfStraight + Math.cos(theta) * cleatRadius;
        y = TREAD_Y + Math.sin(theta) * cleatRadius;
        angle = Math.atan2(-Math.cos(theta), Math.sin(theta));
      }
    }
  }

  cleat.position.set(x, y, 0);
  cleat.rotation.z = angle;
}
