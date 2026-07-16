// LegRig3D — world-space leg rig for legged units (arachnid family).
// Each foot is planted at a real WORLD XYZ point on terrain and stays
// there until the body's moving rest sphere leaves that planted point.
// It then returns toward rest with a capped velocity lookahead. The visible leg is two cylinders
// (upper hip→knee + lower knee→foot) drawn through a shared
// LegInstancedRenderer; the IK that places the knee lives here.
//
// In the language of "Locomotion Visuals Are Frontend"
// (budget_design_philosophy.html): the per-leg primitive is the foot, the
// floor clamp is `Math.max(footY, footSurface.visualFootY)` baked
// into the step / placement code below, and each leg explicitly owns
// a planted / stepping / free contact state. Step cycle advance (lerpProgress)
// is gated on motion the same way wheels gate spin on contact.
//
// Animation state worth surviving a mesh rebuild is
// captured/restored via captureLegState / applyLegState — only the
// foot-position / lerp / phase fields, not the renderer slot indices
// or per-leg config refs (those are bound to the freshly-built
// LegInstance and re-issued by buildLegs).

import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import { getLegsRadiusToggle } from '@/clientBarConfig';
import type {
  LegConfig as BlueprintLegConfig,
  UnitBodyShape,
} from '@/types/blueprints';
import type { LegStyle } from '@/types/graphics';
import type { ArachnidLegConfig } from '@/types/render';
import { getSegmentMidYAt } from '../math/BodyDimensions';
import { resolveMirroredLegConfigs } from '../math/LegLayout';
import type { Entity, PlayerId } from '../sim/types';
import type { LegInstancedRenderer } from './LegInstancedRenderer';
import { locomotionPieceColorHex } from './colorUtils';
import {
  getLocomotionSurfaceHeight,
  sampleLocomotionFootSurface,
  type LocomotionFootSurfaceSample,
} from './LocomotionTerrainSampler';
import {
  type LocomotionBase,
  type LocomotionRenderPose,
  chassisUpFromPose,
  easeOutCubic,
  emaAlpha,
  kneeFromIK,
  rollingLocomotionBodyActive,
  transformChassisToWorld,
  transformWorldVectorToChassis,
} from './LocomotionRigShared3D';
import { clamp, clamp01 } from '../math';
import { createPrimitiveSphereGeometry } from './PrimitiveGeometryQuality3D';
import { legRestSphereNeedsStep, legSurfaceWithinReach } from './LegGait3D';

/** Per-unit directional target radius as a fraction of the unit's LONGEST
 *  leg (upperLegLength + lowerLegLength). One value shared by every
 *  leg on the unit. Bigger → longer stride / slower step cadence;
 *  smaller → shorter / faster. Each leg separately enforces its
 *  physical reach, because a unit-wide stride radius cannot safely
 *  describe every leg on an asymmetric chassis. */
const STEP_CIRCLE_RADIUS_FRAC = 0.85;

/** Per-leg phase pattern. Each leg is either at PHASE 0 (initial
 *  foot position = rest) or PHASE 180 (initial foot position =
 *  rest minus a full stepRadius along chassis +X, i.e. backward of
 *  rest along the body's forward axis). The pattern below — read
 *  index 0 = front-most leg, last index = rear-most leg — gives:
 *
 *    Left side:   0,   180, 0,   180, …
 *    Right side:  180, 0,   180, 0,   …
 *
 *  i.e. adjacent legs on the same side are inverted, AND the two
 *  sides are inverted relative to each other (so diagonals share
 *  a phase). Encoded as an XOR of within-side index parity and
 *  side parity:
 *
 *    phaseShift01 = (sideIndex & 1) ^ (side === 1 ? 1 : 0)
 *
 *  The 0/1 result becomes the multiplier on stepRadius for the
 *  initial backward chassis-local offset (see initializeLegAt). */
const PHASE_180_BACKWARD_FRACTION = 1.0;

/** Cap on the velocity-lookahead offset added to a grounded step target.
 *  Keeping the target inside the rest sphere prevents high-speed motion from
 *  landing a foot beyond the trigger and immediately starting another step. */
const SNAP_LOOKAHEAD_MAX_FRACTION = 0.7;

/** Watchdog: if the foot's distance-from-rest exceeds this many
 *  stepRadii DURING an in-flight slide, abort the slide so the normal
 *  rest-sphere check can choose a fresh target. Catches the case where the body's velocity
 *  reversed mid-step (push → thrust the other way) and the
 *  in-flight target is now wrong relative to the body's actual
 *  motion. */
const SLIDE_INTERRUPT_FRACTION = 2.0;

// Vertical layout for legs. The planted foot state stays on the
// terrain, but the rendered foot pad is lifted slightly so the lower
// cylinder's thick end cap does not clip into the ground. Hips attach
// at each leg's per-body-segment midpoint — computed once when the
// leg set is built (getSegmentMidYAt resolves the nearest body
// segment to the leg's forward offset). The knee's Y is solved by
// the IK routine: it lifts upward in the vertical plane containing
// the hip-foot line. Walk-cycle animation remains 2-axis (foot
// planting in XZ).
const FOOT_Y = 1;
const FOOT_PAD_RADIUS_MULT = 1.45;
const FOOT_PAD_HALF_HEIGHT_MULT = 0.45;
const FOOT_PAD_MIN_RADIUS = 1.1;
const FOOT_PAD_MIN_HALF_HEIGHT = 0.35;
const FOOT_PAD_GROUND_CLEARANCE = 0.35;
const LEG_SEGMENT_COLOR = COLORS.units.locomotion.leg.segment.colorHex;
const GROUND_ACQUIRE_REACH_FRACTION = 0.999;
const AIRBORNE_TOUCHDOWN_REST_DISTANCE_MULT = 0.7;
const AIRBORNE_MAX_REACH_FRACTION = 0.96;
const AIRBORNE_BASE_EXTENSION = 0.58;
const AIRBORNE_ASCENT_TUCK_EXTENSION = 0.4;
const AIRBORNE_ASCENT_SPEED_FOR_FULL_TUCK = 45;
const AIRBORNE_NEAR_GROUND_REACH_FRACTION = 1.2;
const AIRBORNE_DESCENT_SPEED_FOR_FULL_EXTENSION = 45;
const WATERBORNE_OUTWARD_DISTANCE_MULT = 0.55;
const WATERBORNE_TRAIL_DISTANCE_MULT = 0.35;
const WATERBORNE_EXTENSION = 0.58;
const AIRBORNE_FOOT_POSE_TAU_SEC = 0.12;
const AIRBORNE_LEG_POSE_SETTLED_EPSILON_SQ = 0.05 * 0.05;
const AIRBORNE_LEG_LINEAR_SPEED_EPSILON_SQ = 1e-4;
const AIRBORNE_LEG_ANGULAR_SPEED_EPSILON_SQ = 1e-8;
const MIN_LEG_SWING_DURATION_MS = 80;

// Render-only contact band for leg gait. Physics contact uses a tiny
// epsilon because it gates spring/friction/sleep; visual walkers need
// hysteresis so one-frame chassis bob does not reset planted feet.
const VISUAL_GROUND_ACQUIRE_BUFFER_FRAC = 0.08;
const VISUAL_GROUND_RELEASE_BUFFER_FRAC = 0.16;
const VISUAL_GROUND_ACQUIRE_BUFFER_MIN = 0.75;
const VISUAL_GROUND_ACQUIRE_BUFFER_MAX = 4;
const VISUAL_GROUND_RELEASE_BUFFER_MIN = 1.5;
const VISUAL_GROUND_RELEASE_BUFFER_MAX = 8;
const PLANTED_REACH_RELEASE_MARGIN = 1.04;

// LEGS-radius debug viz: a wireframe SPHERE in world space at the
// authored rest center, scaled to stepRadius.
const restSphereGeom = new THREE.WireframeGeometry(
  createPrimitiveSphereGeometry('debug', 'close'),
);
const restSphereMat = new THREE.LineBasicMaterial({
  color: COLORS.units.locomotion.leg.debugRestSphere.colorHex,
  transparent: true,
  opacity: COLORS.units.locomotion.leg.debugRestSphere.opacity,
  depthWrite: false,
});

/** State for a single leg. The foot is planted at a real WORLD XYZ
 *  point on the terrain — it stays at that exact ground spot
 *  regardless of how the body moves or yaws, just like a real foot
 *  pinned against the ground. The trigger test is against the moving
 *  world-space sphere centered on this leg's authored rest position. */
export type LegContactState = 'planted' | 'stepping' | 'free';

export type LegInstance = {
  config: ArachnidLegConfig;
  /** Knee bends outward: +1 for right side, -1 for left. */
  side: number;
  /** Hip Y in chassis-local coords (= mid-height of the body segment
   *  this leg attaches to). Baked per-leg when the leg set is built
   *  so composite units like the arachnid get tall rear legs +
   *  shorter front legs. */
  hipY: number;
  /** Initial phase: 0 = foot starts AT rest, 1 = foot starts a full
   *  stepRadius BEHIND rest in chassis +X (= phase 180°). Computed
   *  per-leg in buildLegs so adjacent legs on the same side are
   *  inverted and the two sides are inverted from each other —
   *  diagonal-pair alternating gait from frame 1. */
  phaseShift01: 0 | 1;
  /** Which LegInstancedRenderer pool this leg allocated from. Construction
   *  units now use the normal pool instead of the transparent shell pool. */
  shellPool: boolean;

  /** Current foot world position. Y is sampled from terrain — when
   *  the foot is planted this XYZ doesn't change at
   *  all, which is exactly what "planted on the ground" means. */
  worldX: number;
  worldY: number;
  worldZ: number;
  /** Lerp endpoints (world XYZ) used during the snap-and-step
   *  animation that takes the foot from where it lifted off to its
   *  newly chosen ground spot. */
  startWorldX: number; startWorldY: number; startWorldZ: number;
  targetWorldX: number; targetWorldY: number; targetWorldZ: number;
  contactState: LegContactState;
  lerpProgress: number;
  lerpDuration: number;
  initialized: boolean;

  /** Slot index into LegInstancedRenderer's upper-cylinder pool. -1
   *  means "no slot" (pool exhausted on alloc, or leg has no upper
   *  cylinder). The renderer flushes all slot writes once per frame
   *  so the dirty flag overhead is shared. */
  upperSlot: number;
  /** Slot index into the lower-cylinder pool. Only allocated for
   *  'animated' / 'full' style; 'simple' legs are a single
   *  upper-cylinder spanning hip → foot directly. */
  lowerSlot: number;
  /** Slot indices into LegInstancedRenderer's joint-sphere pool —
   *  only allocated for the 'full' style; -1 elsewhere (or when the pool
   *  is exhausted, in which case the leg quietly skips that joint).
   *  Both joints across the whole scene draw in a single shared
   *  InstancedMesh call. The radius is baked once at build (joint
   *  sizes are constant) and re-encoded into the per-frame matrix
   *  alongside the world position. */
  hipJointSlot: number;
  kneeJointSlot: number;
  /** Slot into the flattened foot-pad pool. Allocated for every
   *  rendered leg style so the cylinder endpoint can sit above
   *  terrain even when joints are disabled. */
  footPadSlot: number;
  hipJointRadius: number;
  kneeJointRadius: number;
  footPadRadius: number;
  footPadHalfHeight: number;
  upperThick: number;
  lowerThick: number;
  /** LEGS-radius debug viz: a wireframe SPHERE centered at this
   *  leg's authored rest position. Lazy-built; hidden when off. */
  restSphere?: THREE.LineSegments;
};

export type LegMesh = {
  type: 'legs';
  /** Container for non-instanced leg parts — the LEGS-RAD viz
   *  sphere. Parented to the WORLD group so per-leg state stays in
   *  world coords. The CYLINDERS themselves are NOT children of
   *  this group; they live in the shared LegInstancedRenderer's two
   *  InstancedBufferGeometries (one upper-leg, one lower-leg) and
   *  render in a combined two draw calls for the entire scene. Each
   *  leg keeps a slot index into those buffers. */
  group: THREE.Group;
  legs: LegInstance[];
  config: BlueprintLegConfig;
  legStyle: LegStyle;
  /** Per-UNIT rest-sphere radius (world units). Every leg on this
   *  unit shares the same sphere size — it scales with the unit's
   *  longest leg so a Daddy gets a much larger stride budget than a
   *  Tick, but two legs of the same unit always agree on how far a
   *  foot can wander before snapping. */
  stepRadius: number;
  /** Longest authored leg on the unit. Used by render-only contact
   *  hysteresis so chassis bob is judged relative to what the feet
   *  can plausibly absorb. */
  maxLegLength: number;
  /** Frontend-only gait contact state. This deliberately does not
   *  reuse sim `legContact`: feet can remain visually planted while
   *  the chassis is inside the visual release band. */
  visualGrounded: boolean;
  poseInitialized: boolean;
  lastBaseX: number;
  lastBaseY: number;
  lastBaseZ: number;
} & LocomotionBase;

/** Per-leg state worth surviving a mesh rebuild — every
 *  scalar that says "where is this foot RIGHT NOW and what is it
 *  doing?". The cylinder/joint pool slot indices and config refs
 *  intentionally aren't here; those are bound to the freshly-built
 *  LegInstance and will be re-issued by buildLegs when the rebuilt
 *  mesh allocates new pool slots. */
export type LegStateSnapshot = ReadonlyArray<{
  worldX: number; worldY: number; worldZ: number;
  startWorldX: number; startWorldY: number; startWorldZ: number;
  targetWorldX: number; targetWorldY: number; targetWorldZ: number;
  contactState: LegContactState;
  lerpProgress: number;
  lerpDuration: number;
  initialized: boolean;
  phaseShift01: 0 | 1;
}>;

/** Capture per-leg state from a legged locomotion mesh into a plain
 *  array of POJOs the caller can stash across a tear-down/rebuild.
 *  Cost: O(legs.length); called only at rebuild time, not per-frame. */
export function captureLegState(loc: LegMesh): LegStateSnapshot {
  const out: LegStateSnapshot[number][] = [];
  for (const leg of loc.legs) {
    out.push({
      worldX: leg.worldX, worldY: leg.worldY, worldZ: leg.worldZ,
      startWorldX: leg.startWorldX, startWorldY: leg.startWorldY, startWorldZ: leg.startWorldZ,
      targetWorldX: leg.targetWorldX, targetWorldY: leg.targetWorldY, targetWorldZ: leg.targetWorldZ,
      contactState: leg.contactState,
      lerpProgress: leg.lerpProgress,
      lerpDuration: leg.lerpDuration,
      initialized: leg.initialized,
      phaseShift01: leg.phaseShift01,
    });
  }
  return out;
}

/** Pour a captured snapshot back into a freshly-built legged mesh,
 *  matching by leg index. Leg COUNT is determined by the unit's
 *  blueprint (leg layout + bodyShape), which doesn't change with
 *  graphics style — so the indices line up 1:1 between the old and
 *  new LegInstance arrays. Slot indices, configs, and per-leg
 *  geometry refs (newly minted by buildLegs) are left untouched;
 *  only the foot-position / lerp / phase fields are overwritten. */
export function applyLegState(loc: LegMesh, snapshot: LegStateSnapshot): void {
  const n = Math.min(loc.legs.length, snapshot.length);
  for (let i = 0; i < n; i++) {
    const dst = loc.legs[i];
    const src = snapshot[i];
    dst.worldX = src.worldX; dst.worldY = src.worldY; dst.worldZ = src.worldZ;
    dst.startWorldX = src.startWorldX; dst.startWorldY = src.startWorldY; dst.startWorldZ = src.startWorldZ;
    dst.targetWorldX = src.targetWorldX; dst.targetWorldY = src.targetWorldY; dst.targetWorldZ = src.targetWorldZ;
    dst.contactState = src.contactState;
    dst.lerpProgress = src.lerpProgress;
    dst.lerpDuration = src.lerpDuration;
    dst.initialized = src.initialized;
    dst.phaseShift01 = src.phaseShift01;
  }
}

export function buildLegs(
  worldGroup: THREE.Group,
  r: number,
  cfg: BlueprintLegConfig,
  legStyle: LegStyle,
  bodyShape: UnitBodyShape,
  chassisLiftY: number,
  legAttachHeightFrac: number | null,
  legRenderer: LegInstancedRenderer,
  ownerId: PlayerId | undefined,
): LegMesh | undefined {
  if (legStyle === 'none') return undefined;

  const { left, all: allConfigs, sides } = resolveMirroredLegConfigs(cfg, r);
  const shellPool = false;
  const legColor = locomotionPieceColorHex(LEG_SEGMENT_COLOR, ownerId);

  const group = new THREE.Group();
  worldGroup.add(group);

  const legs: LegInstance[] = [];
  const upperThick = Math.max(cfg.upperThickness, 1) * 0.6;
  const lowerThick = Math.max(cfg.lowerThickness, 1) * 0.6;

  const sideLegCount = left.length;
  for (let i = 0; i < allConfigs.length; i++) {
    const legCfg = allConfigs[i];
    const side = sides[i];
    // Within-side index: 0 = front-most leg, last = rear-most.
    // Phase pattern (front → back):
    //   left:   0,   180, 0,   180, …   ← within-side parity drives it
    //   right:  180, 0,   180, 0,   …   ← side flip inverts that
    // Encoded as XOR of within-side parity and side parity.
    const sideIndex = i < sideLegCount ? i : i - sideLegCount;
    const sideParity = side === 1 ? 1 : 0;
    const phaseShift01 = ((sideIndex & 1) ^ sideParity) as 0 | 1;

    // Joint sphere / foot-pad sizing — baked here once because joint
    // and pad geometry is constant per-leg (only world transform
    // changes per frame).
    const hipJointRadius = Math.max(1, cfg.hipRadius);
    const kneeJointRadius = Math.max(1, cfg.kneeRadius);
    const footPadRadius = Math.max(FOOT_PAD_MIN_RADIUS, lowerThick * FOOT_PAD_RADIUS_MULT);
    const footPadHalfHeight = Math.max(
      FOOT_PAD_MIN_HALF_HEIGHT,
      lowerThick * FOOT_PAD_HALF_HEIGHT_MULT,
    );

    // Hip Y defaults to the lifted vertical mid-point of whichever
    // body segment the leg sits under. Units whose visible body is a
    // turret can author legAttachHeightFrac as an absolute terrain-up
    // height fraction, in the same coordinate system as turret mount.z.
    const hipY = legAttachHeightFrac !== null
      ? legAttachHeightFrac * r
      : chassisLiftY + getSegmentMidYAt(bodyShape, r, legCfg.attachOffsetX);

    // Build the leg object with placeholder slot indices first, then
    // alloc — the alloc relocator callbacks need to write back to
    // `leg.upperSlot` etc. when defrag moves a slot.
    const leg: LegInstance = {
      config: legCfg,
      side,
      hipY,
      phaseShift01,
      shellPool,
      worldX: 0, worldY: 0, worldZ: 0,
      startWorldX: 0, startWorldY: 0, startWorldZ: 0,
      targetWorldX: 0, targetWorldY: 0, targetWorldZ: 0,
      contactState: 'free',
      lerpProgress: 0,
      lerpDuration: legCfg.lerpDuration ?? cfg.lerpDuration,
      initialized: false,
      upperSlot: -1,
      lowerSlot: -1,
      hipJointSlot: -1,
      kneeJointSlot: -1,
      footPadSlot: -1,
      hipJointRadius,
      kneeJointRadius,
      footPadRadius,
      footPadHalfHeight,
      upperThick,
      lowerThick,
    };

    // Cylinders / joints / pads are slots in the shared
    // LegInstancedRenderer pools. Each alloc registers a relocator
    // so a future flush()-time defrag can call back into the leg and
    // update the stored index when a slot is packed downward.
    leg.upperSlot = legRenderer.allocUpper(shellPool, legColor, (s) => { leg.upperSlot = s; });
    if (legStyle === 'animated' || legStyle === 'full') {
      leg.lowerSlot = legRenderer.allocLower(shellPool, legColor, (s) => { leg.lowerSlot = s; });
    }
    leg.footPadSlot = legRenderer.allocFootPad(shellPool, legColor, (s) => { leg.footPadSlot = s; });
    if (legStyle === 'full') {
      leg.hipJointSlot = legRenderer.allocJoint(shellPool, legColor, (s) => { leg.hipJointSlot = s; });
      leg.kneeJointSlot = legRenderer.allocJoint(shellPool, legColor, (s) => { leg.kneeJointSlot = s; });
    }

    legs.push(leg);
  }

  // Unit-level step-sphere radius. Every leg on this unit shares the
  // same rest-sphere size; we anchor it to the LONGEST leg so units
  // with mixed-length legs (e.g. the daddy's slightly shorter middle
  // pair) all step on the same scale.
  let maxLegLength = 0;
  for (const c of allConfigs) {
    const tl = totalLegLength(c);
    if (tl > maxLegLength) maxLegLength = tl;
  }
  const stepRadius = maxLegLength * STEP_CIRCLE_RADIUS_FRAC;

  return {
    type: 'legs',
    group,
    legs,
    config: cfg,
    legStyle,
    stepRadius,
    maxLegLength,
    visualGrounded: true,
    poseInitialized: false,
    lastBaseX: 0,
    lastBaseY: 0,
    lastBaseZ: 0,
    geometryKey: '',
  };
}

/** Free every allocated slot (upper / lower / joints / foot pad) for
 *  this rig back to the shared LegInstancedRenderer pools. */
export function freeLegSlots(mesh: LegMesh, legRenderer: LegInstancedRenderer): void {
  for (const leg of mesh.legs) {
    legRenderer.freeUpper(leg.upperSlot, leg.shellPool);
    legRenderer.freeLower(leg.lowerSlot, leg.shellPool);
    legRenderer.freeJoint(leg.hipJointSlot, leg.shellPool);
    legRenderer.freeJoint(leg.kneeJointSlot, leg.shellPool);
    legRenderer.freeFootPad(leg.footPadSlot, leg.shellPool);
  }
}

export function fadeLegSlots(mesh: LegMesh, legRenderer: LegInstancedRenderer, fade: number): void {
  const clamped = Math.max(0, Math.min(1, fade));
  for (const leg of mesh.legs) {
    legRenderer.fadeUpper(leg.upperSlot, clamped, leg.shellPool);
    legRenderer.fadeLower(leg.lowerSlot, clamped, leg.shellPool);
    legRenderer.fadeJoint(leg.hipJointSlot, clamped, leg.shellPool);
    legRenderer.fadeJoint(leg.kneeJointSlot, clamped, leg.shellPool);
    legRenderer.fadeFootPad(leg.footPadSlot, clamped, leg.shellPool);
  }
}

export function translateLegSlots(
  mesh: LegMesh,
  legRenderer: LegInstancedRenderer,
  dx: number,
  dy: number,
  dz: number,
): void {
  for (const leg of mesh.legs) {
    legRenderer.translateUpper(leg.upperSlot, dx, dy, dz, leg.shellPool);
    legRenderer.translateLower(leg.lowerSlot, dx, dy, dz, leg.shellPool);
    legRenderer.translateJoint(leg.hipJointSlot, dx, dy, dz, leg.shellPool);
    legRenderer.translateJoint(leg.kneeJointSlot, dx, dy, dz, leg.shellPool);
    legRenderer.translateFootPad(leg.footPadSlot, dx, dy, dz, leg.shellPool);
  }
}

/** Per-frame: advance each leg's snap-lerp physics + IK, write
 *  cylinder + joint + foot-pad transforms into the shared instanced
 *  renderer pools. Returns true while the rig needs another visual
 *  frame without an external render dirty waking it. */
export function updateLegs(
  mesh: LegMesh,
  entity: Entity,
  pose: LocomotionRenderPose,
  dtMs: number,
  mapWidth: number,
  mapHeight: number,
  legRenderer: LegInstancedRenderer,
): boolean {
  resetLegsAcrossPoseDiscontinuity(mesh, pose);

  // World-planted feet. Each foot stays at a real terrain point until the
  // chassis-local rest sphere moves far enough that the foot exits it. This is
  // the pre-today grounded gait: rest-region stepping rather than hip-extension
  // latches or movement-directed full-extension targets.
  const stepRadius = mesh.stepRadius;
  const showViz = getLegsRadiusToggle();
  const wasVisualGrounded = mesh.visualGrounded;
  const grounded = resolveVisualLegGrounded(
    mesh,
    entity,
    pose,
    mapWidth,
    mapHeight,
  );
  mesh.visualGrounded = grounded;
  const touchingDown = !wasVisualGrounded && grounded;
  chassisUpFromPose(pose, _chassisUp);
  const chassisUpX = _chassisUp.x;
  const chassisUpY = _chassisUp.y;
  const chassisUpZ = _chassisUp.z;
  transformWorldVectorToChassis(
    pose.velocityX, pose.velocityY, pose.velocityZ, pose, _localVelocity,
  );
  const vLocalForward = _localVelocity.x;
  const vLocalLateral = _localVelocity.z;

  if (!grounded) {
    return updateUnsupportedLegPose(
      mesh,
      entity,
      pose,
      dtMs,
      mapWidth,
      mapHeight,
      legRenderer,
      chassisUpX,
      chassisUpY,
      chassisUpZ,
      vLocalForward,
      vLocalLateral,
    );
  }

  for (const leg of mesh.legs) {
    const c = leg.config;
    const tl = totalLegLength(c);
    const restDistance = tl * c.snapDistanceMultiplier;
    // Chassis-local hip and rest position. Both transform to world
    // each frame so they ride along with the body's translation,
    // yaw, and surface tilt.
    const hipLocalX = c.attachOffsetX;
    const hipLocalY = leg.hipY;
    const hipLocalZ = c.attachOffsetY;
    const restLocalX = hipLocalX + Math.cos(c.snapTargetAngle) * restDistance;
    const restLocalY = FOOT_Y;
    const restLocalZ = hipLocalZ + Math.sin(c.snapTargetAngle) * restDistance;

    transformChassisToWorld(
      hipLocalX, hipLocalY, hipLocalZ,
      pose, _worldOut,
    );
    const hipWorldX = _worldOut.x;
    const hipWorldY = _worldOut.y;
    const hipWorldZ = _worldOut.z;

    transformChassisToWorld(
      restLocalX, restLocalY, restLocalZ,
      pose, _worldOut,
    );
    const restWorldX = _worldOut.x;
    const restWorldY = _worldOut.y;
    const restWorldZ = _worldOut.z;

    // LEGS-radius viz: show the exact rest sphere used by the trigger.
    if (showViz) {
      if (!leg.restSphere) {
        leg.restSphere = new THREE.LineSegments(restSphereGeom, restSphereMat);
        mesh.group.add(leg.restSphere);
      }
      leg.restSphere.visible = true;
      leg.restSphere.position.set(restWorldX, restWorldY, restWorldZ);
      leg.restSphere.scale.setScalar(stepRadius);
    } else if (leg.restSphere) {
      leg.restSphere.visible = false;
    }

    if (!leg.initialized) {
      // Defer init to the helper so the build-time and "lazy on
      // first update" paths stay in sync.
      initializeLegAt(leg, pose, entity.id, mapWidth, mapHeight, stepRadius);
    }

    let startedTouchdownStep = false;
    if (touchingDown) {
      beginLegStepToRest(
        leg,
        restLocalX,
        restLocalY,
        restLocalZ,
        vLocalForward,
        vLocalLateral,
        stepRadius,
        pose,
        entity.id,
        mapWidth,
        mapHeight,
      );
      startedTouchdownStep = true;
    }

    // Grounded feet follow the original cubic world-space slide. Otherwise the
    // stored world XYZ is unchanged and the foot remains planted.
    if (leg.contactState === 'stepping') {
      advanceGroundedLegSlide(leg, dtMs);
    }

    // REST-SPHERE TRIGGER. This one 3D distance test naturally covers body
    // translation, yaw, and tilt because rest moves with the chassis while a
    // planted foot remains fixed in world space.
    const dx = leg.worldX - restWorldX;
    const dy = leg.worldY - restWorldY;
    const dz = leg.worldZ - restWorldZ;
    const distSq = dx * dx + dy * dy + dz * dz;
    const stepRSq = stepRadius * stepRadius;

    // If the chassis outruns or reverses away from an in-flight target, cancel
    // that stale slide. The normal trigger below immediately selects a fresh
    // rest-plus-lookahead target.
    if (
      leg.contactState === 'stepping' &&
      !startedTouchdownStep &&
      distSq > stepRSq * SLIDE_INTERRUPT_FRACTION * SLIDE_INTERRUPT_FRACTION
    ) {
      leg.contactState = 'planted';
    }

    if (
      !startedTouchdownStep
      && leg.contactState === 'planted'
      && legRestSphereNeedsStep(distSq, stepRadius)
    ) {
      beginLegStepToRest(
        leg,
        restLocalX,
        restLocalY,
        restLocalZ,
        vLocalForward,
        vLocalLateral,
        stepRadius,
        pose,
        entity.id,
        mapWidth,
        mapHeight,
      );
    }

    // Clamp the rendered leg to physical reach. This does not move the stored
    // planted point; it only prevents an impossible visual extension.
    const clampDx = leg.worldX - hipWorldX;
    const clampDy = leg.worldY - hipWorldY;
    const clampDz = leg.worldZ - hipWorldZ;
    const clampDistSq = clampDx * clampDx + clampDy * clampDy + clampDz * clampDz;
    let footX = leg.worldX;
    let footY = leg.worldY;
    let footZ = leg.worldZ;
    if (clampDistSq > tl * tl) {
      const clampDist = Math.sqrt(clampDistSq);
      const scale = tl / clampDist;
      footX = hipWorldX + clampDx * scale;
      footY = hipWorldY + clampDy * scale;
      footZ = hipWorldZ + clampDz * scale;
    }

    // The gait foot remains terrain-planted, but the visible foot
    // endpoint needs enough clearance for the leg cylinder's radius.
    // Sampling at the current visual XZ keeps stepping feet above
    // hills/ridges between their start and target ground points.
    const footCylinderRadius = mesh.legStyle === 'simple' ? leg.upperThick : leg.lowerThick;
    const footSurface = sampleLocomotionFootSurface(
      footX,
      footZ,
      mapWidth,
      mapHeight,
      footCylinderRadius,
      leg.footPadHalfHeight,
      FOOT_PAD_GROUND_CLEARANCE,
      entity.id,
      _footSurface,
    );
    const visualFootY = Math.max(footY, footSurface.visualFootY);

    writeLegRenderPose(
      mesh,
      leg,
      legRenderer,
      hipWorldX, hipWorldY, hipWorldZ,
      footX, visualFootY, footZ,
      footSurface.nx, footSurface.nz, footSurface.ny,
      chassisUpX, chassisUpY, chassisUpZ,
    );
  }
  return legsNeedFrame(mesh, pose, showViz);
}

function legsNeedFrame(mesh: LegMesh, pose: LocomotionRenderPose, showViz: boolean): boolean {
  if (showViz) return true;
  if (!mesh.visualGrounded) return true;
  if (rollingLocomotionBodyActive(pose)) return true;
  for (const leg of mesh.legs) {
    if (!leg.initialized || leg.contactState !== 'planted') return true;
  }
  return false;
}

function airborneLegBodyActive(pose: LocomotionRenderPose): boolean {
  const { velocityX: vx, velocityY: vy, velocityZ: vz } = pose;
  if (vx * vx + vy * vy + vz * vz > AIRBORNE_LEG_LINEAR_SPEED_EPSILON_SQ) return true;
  if (pose.yawRate * pose.yawRate > AIRBORNE_LEG_ANGULAR_SPEED_EPSILON_SQ) return true;
  return false;
}

function resetLegsAcrossPoseDiscontinuity(
  mesh: LegMesh,
  pose: LocomotionRenderPose,
): void {
  const dx = pose.baseX - mesh.lastBaseX;
  const dy = pose.baseY - mesh.lastBaseY;
  const dz = pose.baseZ - mesh.lastBaseZ;
  const distanceSq = dx * dx + dy * dy + dz * dz;
  const maxDistance = Math.max(1, pose.maxContinuousDistance);
  const discontinuous = mesh.poseInitialized && (
    !Number.isFinite(distanceSq) || distanceSq > maxDistance * maxDistance
  );
  if (discontinuous) {
    for (const leg of mesh.legs) {
      leg.initialized = false;
      leg.contactState = 'free';
      leg.lerpProgress = 0;
    }
  }
  mesh.lastBaseX = pose.baseX;
  mesh.lastBaseY = pose.baseY;
  mesh.lastBaseZ = pose.baseZ;
  mesh.poseInitialized = true;
}

function totalLegLength(c: ArachnidLegConfig): number {
  return c.upperLegLength + c.lowerLegLength;
}

function visualGroundBuffer(maxLegLength: number, currentlyGrounded: boolean): number {
  if (currentlyGrounded) {
    return clamp(
      maxLegLength * VISUAL_GROUND_RELEASE_BUFFER_FRAC,
      VISUAL_GROUND_RELEASE_BUFFER_MIN,
      VISUAL_GROUND_RELEASE_BUFFER_MAX,
    );
  }
  return clamp(
    maxLegLength * VISUAL_GROUND_ACQUIRE_BUFFER_FRAC,
    VISUAL_GROUND_ACQUIRE_BUFFER_MIN,
    VISUAL_GROUND_ACQUIRE_BUFFER_MAX,
  );
}

function legSwingDurationMs(leg: LegInstance): number {
  const d = Number.isFinite(leg.lerpDuration) ? leg.lerpDuration : 0;
  return Math.max(MIN_LEG_SWING_DURATION_MS, d);
}

function beginGroundedLegSlideTo(
  leg: LegInstance,
  targetX: number,
  targetY: number,
  targetZ: number,
): void {
  leg.startWorldX = leg.worldX;
  leg.startWorldY = leg.worldY;
  leg.startWorldZ = leg.worldZ;
  leg.targetWorldX = targetX;
  leg.targetWorldY = targetY;
  leg.targetWorldZ = targetZ;
  leg.contactState = 'stepping';
  leg.lerpProgress = 0;
  leg.lerpDuration = legSwingDurationMs(leg);
  leg.initialized = true;
}

function beginLegStepToRest(
  leg: LegInstance,
  restLocalX: number,
  restLocalY: number,
  restLocalZ: number,
  vLocalForward: number,
  vLocalLateral: number,
  stepRadius: number,
  pose: LocomotionRenderPose,
  entityId: number,
  mapWidth: number,
  mapHeight: number,
): void {
  const lookaheadT = legSwingDurationMs(leg) / 1000;
  let offsetX = vLocalForward * lookaheadT;
  let offsetZ = vLocalLateral * lookaheadT;
  const offsetMagnitude = Math.hypot(offsetX, offsetZ);
  const maximumOffset = stepRadius * SNAP_LOOKAHEAD_MAX_FRACTION;
  if (offsetMagnitude > maximumOffset) {
    const scale = maximumOffset / offsetMagnitude;
    offsetX *= scale;
    offsetZ *= scale;
  }
  transformChassisToWorld(
    restLocalX + offsetX,
    restLocalY,
    restLocalZ + offsetZ,
    pose,
    _worldOut,
  );
  const targetX = _worldOut.x;
  const targetZ = _worldOut.z;
  const targetY = getLocomotionSurfaceHeight(
    targetX,
    targetZ,
    mapWidth,
    mapHeight,
    entityId,
  );
  beginGroundedLegSlideTo(leg, targetX, targetY, targetZ);
}

function advanceGroundedLegSlide(leg: LegInstance, dtMs: number): void {
  const duration = legSwingDurationMs(leg);
  leg.lerpDuration = duration;
  leg.lerpProgress += Math.max(0, dtMs) / duration;
  if (leg.lerpProgress >= 1) {
    leg.lerpProgress = 1;
    leg.worldX = leg.targetWorldX;
    leg.worldY = leg.targetWorldY;
    leg.worldZ = leg.targetWorldZ;
    leg.contactState = 'planted';
    return;
  }

  const t = easeOutCubic(leg.lerpProgress);
  leg.worldX = leg.startWorldX + (leg.targetWorldX - leg.startWorldX) * t;
  leg.worldY = leg.startWorldY + (leg.targetWorldY - leg.startWorldY) * t;
  leg.worldZ = leg.startWorldZ + (leg.targetWorldZ - leg.startWorldZ) * t;
}

function resolveVisualLegGrounded(
  mesh: LegMesh,
  entity: Entity,
  pose: LocomotionRenderPose,
  mapWidth: number,
  mapHeight: number,
): boolean {
  const groundY = getLocomotionSurfaceHeight(
    pose.baseX,
    pose.baseZ,
    mapWidth,
    mapHeight,
    entity.id,
  );
  const bodyBaseY = pose.baseY;
  const clearance = bodyBaseY - groundY;
  if (clearance <= visualGroundBuffer(mesh.maxLegLength, mesh.visualGrounded)) {
    return true;
  }

  if (mesh.visualGrounded && hasReachablePlantedFoot(mesh, pose)) return true;

  // A free rig must be able to reacquire ground from actual leg geometry,
  // not only from a small chassis-center clearance band. Probe the terrain
  // beneath each authored rest position and begin touchdown as soon as one
  // leg can physically reach its support surface.
  return hasReachableGroundAtRest(mesh, entity, pose, mapWidth, mapHeight);
}

function hasReachablePlantedFoot(
  mesh: LegMesh,
  pose: LocomotionRenderPose,
): boolean {
  for (const leg of mesh.legs) {
    if (!leg.initialized || leg.contactState !== 'planted') continue;
    const c = leg.config;
    transformChassisToWorld(
      c.attachOffsetX, leg.hipY, c.attachOffsetY,
      pose, _worldOut,
    );
    const dx = leg.worldX - _worldOut.x;
    const dy = leg.worldY - _worldOut.y;
    const dz = leg.worldZ - _worldOut.z;
    const reach = totalLegLength(c) * PLANTED_REACH_RELEASE_MARGIN;
    if (dx * dx + dy * dy + dz * dz <= reach * reach) return true;
  }
  return false;
}

function hasReachableGroundAtRest(
  mesh: LegMesh,
  entity: Entity,
  pose: LocomotionRenderPose,
  mapWidth: number,
  mapHeight: number,
): boolean {
  for (const leg of mesh.legs) {
    const c = leg.config;
    const totalLength = totalLegLength(c);
    const restDistance = totalLength * c.snapDistanceMultiplier;
    transformChassisToWorld(
      c.attachOffsetX,
      leg.hipY,
      c.attachOffsetY,
      pose,
      _worldOut,
    );
    const hipWorldX = _worldOut.x;
    const hipWorldY = _worldOut.y;
    const hipWorldZ = _worldOut.z;
    transformChassisToWorld(
      c.attachOffsetX + Math.cos(c.snapTargetAngle) * restDistance,
      FOOT_Y,
      c.attachOffsetY + Math.sin(c.snapTargetAngle) * restDistance,
      pose,
      _worldOut,
    );
    const groundY = getLocomotionSurfaceHeight(
      _worldOut.x,
      _worldOut.z,
      mapWidth,
      mapHeight,
      entity.id,
    );
    const dx = _worldOut.x - hipWorldX;
    const dy = groundY - hipWorldY;
    const dz = _worldOut.z - hipWorldZ;
    if (legSurfaceWithinReach(
      dx * dx + dy * dy + dz * dz,
      totalLength,
      GROUND_ACQUIRE_REACH_FRACTION,
    )) {
      return true;
    }
  }
  return false;
}

// Scratch output struct reused across the per-leg loop.
const _worldOut = { x: 0, y: 0, z: 0 };
const _chassisUp = { x: 0, y: 1, z: 0 };
const _localVelocity = { x: 0, y: 0, z: 0 };
const _footSurface: LocomotionFootSurfaceSample = {
  groundY: 0,
  visualFootY: 0,
  nx: 0,
  ny: 0,
  nz: 1,
};

function updateUnsupportedLegPose(
  mesh: LegMesh,
  entity: Entity,
  pose: LocomotionRenderPose,
  dtMs: number,
  mapWidth: number,
  mapHeight: number,
  legRenderer: LegInstancedRenderer,
  chassisUpX: number,
  chassisUpY: number,
  chassisUpZ: number,
  vLocalForward: number,
  vLocalLateral: number,
): boolean {
  const bodyBaseY = pose.baseY;
  const bodyGroundY = getLocomotionSurfaceHeight(
    pose.baseX,
    pose.baseZ,
    mapWidth,
    mapHeight,
    entity.id,
  );
  const bodyClearance = Math.max(0, bodyBaseY - bodyGroundY);
  const descentSpeed = Math.max(0, -pose.velocityY);
  const ascentSpeed = Math.max(0, pose.velocityY);
  const water01 = clamp01(pose.waterFraction);
  const poseAlpha = emaAlpha(Math.max(0, dtMs) / 1000, AIRBORNE_FOOT_POSE_TAU_SEC);
  let needsFrame = airborneLegBodyActive(pose);

  for (const leg of mesh.legs) {
    if (leg.restSphere) leg.restSphere.visible = false;

    const c = leg.config;
    const tl = totalLegLength(c);
    const restDistance = tl * c.snapDistanceMultiplier;
    const hipLocalX = c.attachOffsetX;
    const hipLocalY = leg.hipY;
    const hipLocalZ = c.attachOffsetY;
    const touchdownDistance = restDistance * AIRBORNE_TOUCHDOWN_REST_DISTANCE_MULT;
    const touchdownLocalX = hipLocalX + Math.cos(c.snapTargetAngle) * touchdownDistance;
    const touchdownLocalZ = hipLocalZ + Math.sin(c.snapTargetAngle) * touchdownDistance;
    const localPlanarSpeed = Math.hypot(vLocalForward, vLocalLateral);
    const trailDistance = restDistance * WATERBORNE_TRAIL_DISTANCE_MULT;
    const waterTrailX = localPlanarSpeed > 1e-6
      ? -vLocalForward / localPlanarSpeed * trailDistance
      : 0;
    const waterTrailZ = localPlanarSpeed > 1e-6
      ? -vLocalLateral / localPlanarSpeed * trailDistance
      : 0;
    const waterOutwardDistance = restDistance * WATERBORNE_OUTWARD_DISTANCE_MULT;
    const waterLocalX =
      hipLocalX + Math.cos(c.snapTargetAngle) * waterOutwardDistance + waterTrailX;
    const waterLocalZ =
      hipLocalZ + Math.sin(c.snapTargetAngle) * waterOutwardDistance + waterTrailZ;
    const unsupportedLocalX = touchdownLocalX + (waterLocalX - touchdownLocalX) * water01;
    const unsupportedLocalZ = touchdownLocalZ + (waterLocalZ - touchdownLocalZ) * water01;

    transformChassisToWorld(
      hipLocalX, hipLocalY, hipLocalZ,
      pose, _worldOut,
    );
    const hipWorldX = _worldOut.x;
    const hipWorldY = _worldOut.y;
    const hipWorldZ = _worldOut.z;

    transformChassisToWorld(
      unsupportedLocalX, FOOT_Y, unsupportedLocalZ,
      pose, _worldOut,
    );
    const footCylinderRadius = mesh.legStyle === 'simple' ? leg.upperThick : leg.lowerThick;
    const firstSurface = sampleLocomotionFootSurface(
      _worldOut.x,
      _worldOut.z,
      mapWidth,
      mapHeight,
      footCylinderRadius,
      leg.footPadHalfHeight,
      FOOT_PAD_GROUND_CLEARANCE,
      entity.id,
      _footSurface,
    );
    const horizontalReach = Math.hypot(
      unsupportedLocalX - hipLocalX,
      unsupportedLocalZ - hipLocalZ,
    );
    const maxReach = tl * AIRBORNE_MAX_REACH_FRACTION;
    const verticalReach = Math.sqrt(
      Math.max(0, maxReach * maxReach - horizontalReach * horizontalReach),
    );
    const fullyExtendedLocalY = hipLocalY - verticalReach;
    const terrainReadyLocalY = firstSurface.visualFootY - bodyBaseY;
    const touchdownLocalY = Math.min(
      hipLocalY - FOOT_PAD_GROUND_CLEARANCE,
      Math.max(terrainReadyLocalY, fullyExtendedLocalY),
    );
    const nearGround01 = 1 - clamp01(
      bodyClearance / Math.max(1, maxReach * AIRBORNE_NEAR_GROUND_REACH_FRACTION),
    );
    const descent01 = clamp01(descentSpeed / AIRBORNE_DESCENT_SPEED_FOR_FULL_EXTENSION);
    const ascent01 = clamp01(ascentSpeed / AIRBORNE_ASCENT_SPEED_FOR_FULL_TUCK);
    const airborneBaseExtension =
      AIRBORNE_BASE_EXTENSION +
      (AIRBORNE_ASCENT_TUCK_EXTENSION - AIRBORNE_BASE_EXTENSION) * ascent01;
    const airborneExtension01 = Math.max(airborneBaseExtension, nearGround01, descent01);
    const airborneFootLocalY =
      hipLocalY + (touchdownLocalY - hipLocalY) * airborneExtension01;
    const waterborneFootLocalY = hipLocalY - verticalReach * WATERBORNE_EXTENSION;
    const footLocalY =
      airborneFootLocalY + (waterborneFootLocalY - airborneFootLocalY) * water01;

    transformChassisToWorld(
      unsupportedLocalX, footLocalY, unsupportedLocalZ,
      pose, _worldOut,
    );
    const targetFootX = _worldOut.x;
    const targetFootZ = _worldOut.z;
    const targetFootSurface = sampleLocomotionFootSurface(
      targetFootX,
      targetFootZ,
      mapWidth,
      mapHeight,
      footCylinderRadius,
      leg.footPadHalfHeight,
      FOOT_PAD_GROUND_CLEARANCE,
      entity.id,
      _footSurface,
    );
    const targetFootY = Math.max(_worldOut.y, targetFootSurface.visualFootY);

    if (!leg.initialized) {
      leg.worldX = targetFootX;
      leg.worldY = targetFootY;
      leg.worldZ = targetFootZ;
      leg.initialized = true;
    } else {
      leg.worldX += (targetFootX - leg.worldX) * poseAlpha;
      leg.worldY += (targetFootY - leg.worldY) * poseAlpha;
      leg.worldZ += (targetFootZ - leg.worldZ) * poseAlpha;
    }
    const poseDx = targetFootX - leg.worldX;
    const poseDy = targetFootY - leg.worldY;
    const poseDz = targetFootZ - leg.worldZ;
    if (poseDx * poseDx + poseDy * poseDy + poseDz * poseDz > AIRBORNE_LEG_POSE_SETTLED_EPSILON_SQ) {
      needsFrame = true;
    }

    const reachDx = leg.worldX - hipWorldX;
    const reachDy = leg.worldY - hipWorldY;
    const reachDz = leg.worldZ - hipWorldZ;
    const reachDistance = Math.hypot(reachDx, reachDy, reachDz);
    if (reachDistance > maxReach && Number.isFinite(reachDistance)) {
      const reachScale = maxReach / reachDistance;
      leg.worldX = hipWorldX + reachDx * reachScale;
      leg.worldY = hipWorldY + reachDy * reachScale;
      leg.worldZ = hipWorldZ + reachDz * reachScale;
    }

    const footSurface = sampleLocomotionFootSurface(
      leg.worldX,
      leg.worldZ,
      mapWidth,
      mapHeight,
      footCylinderRadius,
      leg.footPadHalfHeight,
      FOOT_PAD_GROUND_CLEARANCE,
      entity.id,
      _footSurface,
    );
    const surfaceControlsFootPose = leg.worldY <= footSurface.visualFootY;
    if (leg.worldY < footSurface.groundY) leg.worldY = footSurface.groundY;
    const footY = Math.max(leg.worldY, footSurface.visualFootY);

    leg.startWorldX = leg.worldX;
    leg.startWorldY = leg.worldY;
    leg.startWorldZ = leg.worldZ;
    leg.targetWorldX = targetFootX;
    leg.targetWorldY = targetFootY;
    leg.targetWorldZ = targetFootZ;
    leg.contactState = 'free';
    leg.lerpProgress = 0;

    writeLegRenderPose(
      mesh,
      leg,
      legRenderer,
      hipWorldX, hipWorldY, hipWorldZ,
      leg.worldX, footY, leg.worldZ,
      surfaceControlsFootPose ? footSurface.nx : chassisUpX,
      surfaceControlsFootPose ? footSurface.nz : chassisUpY,
      surfaceControlsFootPose ? footSurface.ny : chassisUpZ,
      chassisUpX, chassisUpY, chassisUpZ,
    );
  }
  return needsFrame;
}

function writeLegRenderPose(
  mesh: LegMesh,
  leg: LegInstance,
  legRenderer: LegInstancedRenderer,
  hipWorldX: number,
  hipWorldY: number,
  hipWorldZ: number,
  footX: number,
  footY: number,
  footZ: number,
  footNormalX: number,
  footNormalY: number,
  footNormalZ: number,
  chassisUpX: number,
  chassisUpY: number,
  chassisUpZ: number,
): void {
  const c = leg.config;
  if (mesh.legStyle === 'simple') {
    legRenderer.updateUpper(
      leg.upperSlot,
      hipWorldX, hipWorldY, hipWorldZ,
      footX, footY, footZ,
      leg.upperThick,
      leg.shellPool,
    );
  } else {
    const knee = kneeFromIK(
      hipWorldX, hipWorldY, hipWorldZ,
      footX, footY, footZ,
      c.upperLegLength, c.lowerLegLength,
      chassisUpX, chassisUpY, chassisUpZ,
    );
    legRenderer.updateUpper(
      leg.upperSlot,
      hipWorldX, hipWorldY, hipWorldZ,
      knee.x, knee.y, knee.z,
      leg.upperThick,
      leg.shellPool,
    );
    legRenderer.updateLower(
      leg.lowerSlot,
      knee.x, knee.y, knee.z,
      footX, footY, footZ,
      leg.lowerThick,
      leg.shellPool,
    );
    if (leg.hipJointSlot >= 0) {
      legRenderer.updateJoint(
        leg.hipJointSlot,
        hipWorldX, hipWorldY, hipWorldZ,
        leg.hipJointRadius,
        leg.shellPool,
      );
    }
    if (leg.kneeJointSlot >= 0) {
      legRenderer.updateJoint(
        leg.kneeJointSlot,
        knee.x, knee.y, knee.z,
        leg.kneeJointRadius,
        leg.shellPool,
      );
    }
  }
  legRenderer.updateFootPad(
    leg.footPadSlot,
    footX, footY, footZ,
    leg.footPadRadius,
    leg.footPadHalfHeight,
    footNormalX, footNormalY, footNormalZ,
    leg.shellPool,
  );
}

function initializeLegAt(
  leg: LegInstance,
  pose: LocomotionRenderPose,
  entityId: number,
  mapWidth: number,
  mapHeight: number,
  stepRadius: number,
): void {
  const c = leg.config;
  const restDistance = totalLegLength(c) * c.snapDistanceMultiplier;
  // Both sides use the leg's canonical rest direction
  // (c.snapTargetAngle is already mirrored for right-side legs at
  // build time). Chassis-local rest position = hip + outward × dist.
  const restLocalX = c.attachOffsetX + Math.cos(c.snapTargetAngle) * restDistance;
  const restLocalY = FOOT_Y;
  const restLocalZ = c.attachOffsetY + Math.sin(c.snapTargetAngle) * restDistance;
  // PHASE OFFSET for alternating gait: each leg is at phase 0 (foot
  // at rest) or phase 180 (foot a full stepRadius BACKWARD of rest
  // along chassis +X). The pattern, set in buildLegs, alternates
  // along each side AND inverts between sides — so diagonal pairs
  // share a phase and the unit walks with a diagonal-trot gait
  // from frame 1 instead of every leg stepping in unison.
  const phaseShiftX = leg.phaseShift01 === 1
    ? -stepRadius * PHASE_180_BACKWARD_FRACTION
    : 0;
  const cx = restLocalX + phaseShiftX;
  const cy = restLocalY;
  const cz = restLocalZ;
  // Transform to world to find the foot's spawn XZ, then snap Y to
  // the actual terrain elevation so the foot lands ON the ground.
  transformChassisToWorld(cx, cy, cz, pose, _worldOut);
  leg.worldX = _worldOut.x;
  leg.worldZ = _worldOut.z;
  leg.worldY = getLocomotionSurfaceHeight(
    leg.worldX,
    leg.worldZ,
    mapWidth,
    mapHeight,
    entityId,
  );
  leg.startWorldX = leg.worldX; leg.startWorldY = leg.worldY; leg.startWorldZ = leg.worldZ;
  leg.targetWorldX = leg.worldX; leg.targetWorldY = leg.worldY; leg.targetWorldZ = leg.worldZ;
  leg.contactState = 'planted';
  leg.initialized = true;
}
