// LegRig3D — world-space leg rig for legged units (arachnid family).
// Each foot is planted at a real WORLD XYZ point on terrain and stays
// there until the body's derived ground-centered snap sphere passes it.
// It then travels to the sphere surface in the unit's velocity direction. The visible leg is two cylinders
// (upper hip→knee + lower knee→ground endpoint) drawn through a shared
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
import { getLegsRadiusToggle, getLegsReachToggle } from '@/clientBarConfig';
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
import {
  createPrimitiveSphereGeometry,
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';
import {
  legChoppedSphereNeedsStep,
  legSurfaceWithinReach,
  resolveLegChoppingSphereRadius,
  resolveLegChoppedSphereVelocityTarget,
  resolveLegSnapRayOrigin,
  resolveLegSnapSphereLocal,
  type LegSnapSphereLocal,
} from './LegGait3D';

/** Per-leg phase pattern. Each leg starts on either boundary reached by
 *  casting outward or inward through its chopped foot envelope. The pattern below — read
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
 *  The 0/1 result selects opposite ray directions at initialization. */

// Vertical layout for legs. The planted endpoint state stays on the
// terrain, but the rendered cylinder endpoint is lifted slightly so
// its thick end cap does not clip into the ground. Hips attach
// at each leg's per-body-segment midpoint — computed once when the
// leg set is built (getSegmentMidYAt resolves the nearest body
// segment to the leg's forward offset). The knee's Y is solved by
// the IK routine: it lifts upward in the vertical plane containing
// the hip-foot line. Walk-cycle animation remains 2-axis (foot
// planting in XZ).
const FOOT_Y = 1;
const LEG_ENDPOINT_GROUND_CLEARANCE = 0.35;
const LEG_SEGMENT_COLOR = COLORS.units.locomotion.leg.segment.colorHex;
const GROUND_ACQUIRE_REACH_FRACTION = 0.999;
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

// LEG-RAD debug viz: the exact derived, ground-centered snap sphere.
const restSphereGeom = new THREE.WireframeGeometry(
  createPrimitiveSphereGeometry('debug', 'close'),
);
const restSphereMat = new THREE.LineBasicMaterial({
  color: COLORS.units.locomotion.leg.debugRestSphere.colorHex,
  transparent: true,
  opacity: COLORS.units.locomotion.leg.debugRestSphere.opacity,
  depthWrite: false,
});
const innerExclusionSphereMat = new THREE.LineBasicMaterial({
  color: COLORS.units.locomotion.leg.debugInnerExclusionSphere.colorHex,
  transparent: true,
  opacity: COLORS.units.locomotion.leg.debugInnerExclusionSphere.opacity,
  depthWrite: false,
});
const snapRayOriginPointGeom = createPrimitiveSphereGeometry('debug', 'far');
const snapRayOriginPointMat = new THREE.MeshBasicMaterial({
  color: COLORS.units.locomotion.leg.debugSnapRayOriginPoint.colorHex,
  transparent: true,
  opacity: COLORS.units.locomotion.leg.debugSnapRayOriginPoint.opacity,
  depthWrite: false,
});
const reachSphereMat = new THREE.LineBasicMaterial({
  color: COLORS.units.locomotion.leg.debugReachSphere.colorHex,
  transparent: true,
  opacity: COLORS.units.locomotion.leg.debugReachSphere.opacity,
  depthWrite: false,
});
const restDirectionGeom = new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(0, 0, 0),
  new THREE.Vector3(1, 0, 0),
]);
const debugSpokeAxis = new THREE.Vector3(1, 0, 0);

/** State for a single leg. The foot is planted at a real WORLD XYZ
 *  point on the terrain — it stays at that exact ground spot
 *  regardless of how the body moves or yaws, just like a real foot
 *  pinned against the ground. The trigger and target use its outer foot sphere
 *  minus the shared locomotion-root exclusion sphere. */
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
  /** Initial phase selects the outward boundary or the inward exclusion
   *  boundary. Computed
   *  per-leg in buildLegs so adjacent legs on the same side are
   *  inverted and the two sides are inverted from each other —
   *  diagonal-pair alternating gait from frame 1. */
  phaseShift01: 0 | 1;
  /** Which LegInstancedRenderer pool this leg allocated from. Construction
   *  units now use the normal pool instead of the transparent shell pool. */
  shellPool: boolean;
  /** Geometry pool selected at build time. Pose/IK state is identical across
   * tiers; only the shared primitive mesh differs. */
  geometryTier: PrimitiveGeometryTier;

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
  /** Slot into LegInstancedRenderer's hip-joint pool. Only allocated
   *  for the 'full' style; knees deliberately have no cap geometry. */
  hipJointSlot: number;
  hipJointRadius: number;
  upperThick: number;
  lowerThick: number;
  /** LEG-RAD debug viz: this leg's derived outer foot sphere. */
  restSphere?: THREE.LineSegments;
  snapBoundaryRay?: THREE.Line;
  snapRayOriginPoint?: THREE.Mesh;
  /** LEG-REACH debug viz: the exact hip-centered maximum extension
   *  sphere plus a spoke to the derived outer point. */
  reachSphere?: THREE.LineSegments;
  restDirection?: THREE.Line;
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
  /** One terrain-rooted sphere removed from every leg's outer foot sphere. */
  innerExclusionRadius: number;
  innerExclusionSphere?: THREE.LineSegments;
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
  bodyShape: UnitBodyShape | null,
  chassisLiftY: number,
  legAttachHeightFrac: number | null,
  legRenderer: LegInstancedRenderer,
  ownerId: PlayerId | undefined,
  geometryTier: PrimitiveGeometryTier = 'close',
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

    // Hip-joint sphere sizing is baked once because only its world
    // transform changes per frame. Kneecaps and feet are intentionally
    // absent: the two cylinders alone define the leg silhouette.
    const hipJointRadius = Math.max(1, cfg.hipRadius);

    // Hip Y defaults to the lifted vertical mid-point of whichever
    // body segment the leg sits under. Units whose visible body is a
    // turret can author legAttachHeightFrac as an absolute terrain-up
    // height fraction, in the same coordinate system as turret mount.z.
    let hipY: number;
    if (legAttachHeightFrac !== null) {
      hipY = legAttachHeightFrac * r;
    } else {
      if (bodyShape === null) {
        throw new Error('A legged bodyless unit requires legAttachHeightFrac.');
      }
      hipY = chassisLiftY + getSegmentMidYAt(bodyShape, r, legCfg.attachOffsetX);
    }

    // Build the leg object with placeholder slot indices first, then
    // alloc — the alloc relocator callbacks need to write back to
    // `leg.upperSlot` etc. when defrag moves a slot.
    const leg: LegInstance = {
      config: legCfg,
      side,
      hipY,
      phaseShift01,
      shellPool,
      geometryTier,
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
      hipJointRadius,
      upperThick,
      lowerThick,
    };

    // Cylinders and hip joints are slots in the shared
    // LegInstancedRenderer pools. Each alloc registers a relocator
    // so a future flush()-time defrag can call back into the leg and
    // update the stored index when a slot is packed downward.
    leg.upperSlot = legRenderer.allocUpper(
      shellPool, legColor, (s) => { leg.upperSlot = s; }, geometryTier,
    );
    if (legStyle === 'animated' || legStyle === 'full') {
      leg.lowerSlot = legRenderer.allocLower(
        shellPool, legColor, (s) => { leg.lowerSlot = s; }, geometryTier,
      );
    }
    if (legStyle === 'full') {
      leg.hipJointSlot = legRenderer.allocJoint(
        shellPool, legColor, (s) => { leg.hipJointSlot = s; }, geometryTier,
      );
    }

    legs.push(leg);
  }

  // Longest leg drives only the visual-ground contact hysteresis. Each leg's
  // snap sphere is derived independently from its authored ratios.
  let maxLegLength = 0;
  const footSphereOriginDistances = new Array<number>(allConfigs.length);
  let configIndex = 0;
  for (const c of allConfigs) {
    const tl = totalLegLength(c);
    if (tl > maxLegLength) maxLegLength = tl;
    resolveLegSnapSphereLocal(
      c.attachOffsetX,
      c.attachOffsetY,
      tl,
      c.footSphereOriginExtensionRatio,
      c.footSphereRadiusLegLengthRatio,
      _snapSphereLocal,
    );
    footSphereOriginDistances[configIndex++] = Math.hypot(
      _snapSphereLocal.centerX,
      _snapSphereLocal.centerZ,
    );
  }
  const innerExclusionRadius = resolveLegChoppingSphereRadius(
    footSphereOriginDistances,
    cfg.choppingSphere.radiusAverageFootSphereOriginDistanceRatio,
  );
  return {
    type: 'legs',
    group,
    legs,
    config: cfg,
    legStyle,
    innerExclusionRadius,
    maxLegLength,
    visualGrounded: true,
    poseInitialized: false,
    lastBaseX: 0,
    lastBaseY: 0,
    lastBaseZ: 0,
    geometryKey: '',
  };
}

/** Free every allocated slot (upper / lower / hip joint) for
 *  this rig back to the shared LegInstancedRenderer pools. */
export function freeLegSlots(mesh: LegMesh, legRenderer: LegInstancedRenderer): void {
  for (const leg of mesh.legs) {
    legRenderer.freeUpper(leg.upperSlot, leg.shellPool, leg.geometryTier);
    legRenderer.freeLower(leg.lowerSlot, leg.shellPool, leg.geometryTier);
    legRenderer.freeJoint(leg.hipJointSlot, leg.shellPool, leg.geometryTier);
  }
}

export function fadeLegSlots(mesh: LegMesh, legRenderer: LegInstancedRenderer, fade: number): void {
  const clamped = Math.max(0, Math.min(1, fade));
  for (const leg of mesh.legs) {
    legRenderer.fadeUpper(leg.upperSlot, clamped, leg.shellPool, leg.geometryTier);
    legRenderer.fadeLower(leg.lowerSlot, clamped, leg.shellPool, leg.geometryTier);
    legRenderer.fadeJoint(leg.hipJointSlot, clamped, leg.shellPool, leg.geometryTier);
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
    legRenderer.translateUpper(leg.upperSlot, dx, dy, dz, leg.shellPool, leg.geometryTier);
    legRenderer.translateLower(leg.lowerSlot, dx, dy, dz, leg.shellPool, leg.geometryTier);
    legRenderer.translateJoint(leg.hipJointSlot, dx, dy, dz, leg.shellPool, leg.geometryTier);
  }
}

/** Per-frame: advance each leg's snap-lerp physics + IK, write
 *  cylinder + hip-joint transforms into the shared instanced
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

  // World-planted feet. Each per-leg sphere derives its ground origin and
  // radius from authored ratios. One shared terrain-rooted sphere, sized from
  // average foot-sphere-origin distance, removes the inner portion of every
  // foot envelope.
  const showViz = getLegsRadiusToggle();
  const showReachViz = getLegsReachToggle();
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

  const innerSphereWorldX = pose.baseX;
  const innerSphereWorldZ = pose.baseZ;
  const innerSphereWorldY = getLocomotionSurfaceHeight(
    innerSphereWorldX,
    innerSphereWorldZ,
    mapWidth,
    mapHeight,
    entity.id,
  );
  _innerSphereCenterPoint.x = innerSphereWorldX;
  _innerSphereCenterPoint.y = innerSphereWorldY;
  _innerSphereCenterPoint.z = innerSphereWorldZ;
  if (showViz) {
    if (!mesh.innerExclusionSphere) {
      mesh.innerExclusionSphere = new THREE.LineSegments(
        restSphereGeom,
        innerExclusionSphereMat,
      );
      mesh.group.add(mesh.innerExclusionSphere);
    }
    mesh.innerExclusionSphere.visible = true;
    mesh.innerExclusionSphere.position.set(
      innerSphereWorldX,
      innerSphereWorldY,
      innerSphereWorldZ,
    );
    mesh.innerExclusionSphere.scale.setScalar(mesh.innerExclusionRadius);
  } else if (mesh.innerExclusionSphere) {
    mesh.innerExclusionSphere.visible = false;
  }

  for (const leg of mesh.legs) {
    const c = leg.config;
    const tl = totalLegLength(c);
    const hipLocalX = c.attachOffsetX;
    const hipLocalY = leg.hipY;
    const hipLocalZ = c.attachOffsetY;
    resolveLegSnapSphereLocal(
      hipLocalX,
      hipLocalZ,
      tl,
      c.footSphereOriginExtensionRatio,
      c.footSphereRadiusLegLengthRatio,
      _snapSphereLocal,
    );

    transformChassisToWorld(
      hipLocalX, hipLocalY, hipLocalZ,
      pose, _worldOut,
    );
    const hipWorldX = _worldOut.x;
    const hipWorldY = _worldOut.y;
    const hipWorldZ = _worldOut.z;

    transformChassisToWorld(
      _snapSphereLocal.centerX, FOOT_Y, _snapSphereLocal.centerZ,
      pose, _worldOut,
    );
    const sphereWorldX = _worldOut.x;
    const sphereWorldZ = _worldOut.z;
    const sphereWorldY = getLocomotionSurfaceHeight(
      sphereWorldX,
      sphereWorldZ,
      mapWidth,
      mapHeight,
      entity.id,
    );
    transformChassisToWorld(
      _snapSphereLocal.outwardX, FOOT_Y, _snapSphereLocal.outwardZ,
      pose, _worldOut,
    );
    const outwardWorldX = _worldOut.x;
    const outwardWorldZ = _worldOut.z;
    const outwardWorldY = getLocomotionSurfaceHeight(
      outwardWorldX,
      outwardWorldZ,
      mapWidth,
      mapHeight,
      entity.id,
    );
    const sphereRadius = _snapSphereLocal.radius;
    _snapSphereCenterPoint.x = sphereWorldX;
    _snapSphereCenterPoint.y = sphereWorldY;
    _snapSphereCenterPoint.z = sphereWorldZ;
    _snapSphereOutwardPoint.x = outwardWorldX;
    _snapSphereOutwardPoint.y = outwardWorldY;
    _snapSphereOutwardPoint.z = outwardWorldZ;
    resolveLegSnapRayOrigin(
      _snapSphereCenterPoint,
      sphereRadius,
      _innerSphereCenterPoint,
      mesh.innerExclusionRadius,
      mesh.config.snapRay.originBoundarySpanRatio,
      _snapRayOriginPoint,
    );
    _snapRayOriginPoint.y = getLocomotionSurfaceHeight(
      _snapRayOriginPoint.x,
      _snapRayOriginPoint.z,
      mapWidth,
      mapHeight,
      entity.id,
    );

    // LEG-RAD viz: exact ground-centered sphere used by both trigger and target.
    if (showViz) {
      if (!leg.restSphere) {
        leg.restSphere = new THREE.LineSegments(restSphereGeom, restSphereMat);
        mesh.group.add(leg.restSphere);
      }
      leg.restSphere.visible = true;
      leg.restSphere.position.set(sphereWorldX, sphereWorldY, sphereWorldZ);
      leg.restSphere.scale.setScalar(sphereRadius);
      resolveLegChoppedSphereVelocityTarget(
        _snapRayOriginPoint,
        _snapSphereCenterPoint,
        sphereRadius,
        _innerSphereCenterPoint,
        mesh.innerExclusionRadius,
        pose.velocityX,
        pose.velocityZ,
        _snapSphereOutwardPoint,
        _snapSphereTargetPoint,
      );
      const debugTargetY = getLocomotionSurfaceHeight(
        _snapSphereTargetPoint.x,
        _snapSphereTargetPoint.z,
        mapWidth,
        mapHeight,
        entity.id,
      );
      if (!leg.snapBoundaryRay) {
        leg.snapBoundaryRay = new THREE.Line(restDirectionGeom, restSphereMat);
        mesh.group.add(leg.snapBoundaryRay);
      }
      if (!leg.snapRayOriginPoint) {
        leg.snapRayOriginPoint = new THREE.Mesh(
          snapRayOriginPointGeom,
          snapRayOriginPointMat,
        );
        mesh.group.add(leg.snapRayOriginPoint);
      }
      leg.snapRayOriginPoint.visible = true;
      leg.snapRayOriginPoint.position.set(
        _snapRayOriginPoint.x,
        _snapRayOriginPoint.y,
        _snapRayOriginPoint.z,
      );
      leg.snapRayOriginPoint.scale.setScalar(
        Math.max(0.6, Math.min(2.5, sphereRadius * 0.06)),
      );
      leg.snapBoundaryRay.visible = true;
      leg.snapBoundaryRay.position.set(
        _snapRayOriginPoint.x,
        _snapRayOriginPoint.y,
        _snapRayOriginPoint.z,
      );
      _debugSpokeDirection.set(
        _snapSphereTargetPoint.x - _snapRayOriginPoint.x,
        debugTargetY - _snapRayOriginPoint.y,
        _snapSphereTargetPoint.z - _snapRayOriginPoint.z,
      );
      const rayLength = _debugSpokeDirection.length();
      if (rayLength > 1e-6) {
        _debugSpokeDirection.multiplyScalar(1 / rayLength);
        leg.snapBoundaryRay.quaternion.setFromUnitVectors(debugSpokeAxis, _debugSpokeDirection);
        leg.snapBoundaryRay.scale.set(rayLength, 1, 1);
      } else {
        leg.snapBoundaryRay.scale.set(0, 1, 1);
      }
    } else {
      if (leg.restSphere) leg.restSphere.visible = false;
      if (leg.snapBoundaryRay) leg.snapBoundaryRay.visible = false;
      if (leg.snapRayOriginPoint) leg.snapRayOriginPoint.visible = false;
    }

    // LEG-REACH viz: hip-centered hard reach plus the derived center→hip ray
    // continued to its full-length ground point.
    if (showReachViz) {
      if (!leg.reachSphere) {
        leg.reachSphere = new THREE.LineSegments(restSphereGeom, reachSphereMat);
        mesh.group.add(leg.reachSphere);
      }
      leg.reachSphere.visible = true;
      leg.reachSphere.position.set(hipWorldX, hipWorldY, hipWorldZ);
      leg.reachSphere.scale.setScalar(tl);

      if (!leg.restDirection) {
        leg.restDirection = new THREE.Line(restDirectionGeom, reachSphereMat);
        mesh.group.add(leg.restDirection);
      }
      leg.restDirection.visible = true;
      leg.restDirection.position.set(hipWorldX, hipWorldY, hipWorldZ);
      _debugSpokeDirection.set(
        outwardWorldX - hipWorldX,
        outwardWorldY - hipWorldY,
        outwardWorldZ - hipWorldZ,
      );
      const spokeLength = _debugSpokeDirection.length();
      if (spokeLength > 1e-6) {
        _debugSpokeDirection.multiplyScalar(1 / spokeLength);
        leg.restDirection.quaternion.setFromUnitVectors(debugSpokeAxis, _debugSpokeDirection);
        leg.restDirection.scale.set(spokeLength, 1, 1);
      } else {
        leg.restDirection.scale.set(0, 1, 1);
      }
    } else {
      if (leg.reachSphere) leg.reachSphere.visible = false;
      if (leg.restDirection) leg.restDirection.visible = false;
    }

    if (!leg.initialized) {
      initializeLegOnSnapSphere(
        leg,
        sphereWorldX,
        sphereWorldY,
        sphereWorldZ,
        outwardWorldX,
        outwardWorldY,
        outwardWorldZ,
        sphereRadius,
        _snapRayOriginPoint.x,
        _snapRayOriginPoint.y,
        _snapRayOriginPoint.z,
        innerSphereWorldX,
        innerSphereWorldY,
        innerSphereWorldZ,
        mesh.innerExclusionRadius,
        entity.id,
        mapWidth,
        mapHeight,
      );
    }

    let startedTouchdownStep = false;
    if (touchingDown) {
      beginLegStepToChoppedSphereBoundary(
        leg,
        sphereWorldX,
        sphereWorldY,
        sphereWorldZ,
        outwardWorldX,
        outwardWorldY,
        outwardWorldZ,
        sphereRadius,
        _snapRayOriginPoint.x,
        _snapRayOriginPoint.y,
        _snapRayOriginPoint.z,
        innerSphereWorldX,
        innerSphereWorldY,
        innerSphereWorldZ,
        mesh.innerExclusionRadius,
        pose.velocityX,
        pose.velocityZ,
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

    const outerDx = leg.worldX - sphereWorldX;
    const outerDy = leg.worldY - sphereWorldY;
    const outerDz = leg.worldZ - sphereWorldZ;
    const outerDistSq = outerDx * outerDx + outerDy * outerDy + outerDz * outerDz;
    const innerDx = leg.worldX - innerSphereWorldX;
    const innerDy = leg.worldY - innerSphereWorldY;
    const innerDz = leg.worldZ - innerSphereWorldZ;
    const innerDistSq = innerDx * innerDx + innerDy * innerDy + innerDz * innerDz;

    if (
      !startedTouchdownStep
      && leg.contactState === 'planted'
      && legChoppedSphereNeedsStep(
        outerDistSq,
        sphereRadius,
        innerDistSq,
        mesh.innerExclusionRadius,
      )
    ) {
      beginLegStepToChoppedSphereBoundary(
        leg,
        sphereWorldX,
        sphereWorldY,
        sphereWorldZ,
        outwardWorldX,
        outwardWorldY,
        outwardWorldZ,
        sphereRadius,
        _snapRayOriginPoint.x,
        _snapRayOriginPoint.y,
        _snapRayOriginPoint.z,
        innerSphereWorldX,
        innerSphereWorldY,
        innerSphereWorldZ,
        mesh.innerExclusionRadius,
        pose.velocityX,
        pose.velocityZ,
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
      LEG_ENDPOINT_GROUND_CLEARANCE,
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
      chassisUpX, chassisUpY, chassisUpZ,
    );
  }
  return legsNeedFrame(mesh, pose, showViz || showReachViz);
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

function beginLegStepToChoppedSphereBoundary(
  leg: LegInstance,
  sphereX: number,
  sphereY: number,
  sphereZ: number,
  outwardX: number,
  outwardY: number,
  outwardZ: number,
  sphereRadius: number,
  rayOriginX: number,
  rayOriginY: number,
  rayOriginZ: number,
  innerSphereX: number,
  innerSphereY: number,
  innerSphereZ: number,
  innerSphereRadius: number,
  velocityX: number,
  velocityZ: number,
  entityId: number,
  mapWidth: number,
  mapHeight: number,
): void {
  _snapSphereCenterPoint.x = sphereX;
  _snapSphereCenterPoint.y = sphereY;
  _snapSphereCenterPoint.z = sphereZ;
  _innerSphereCenterPoint.x = innerSphereX;
  _innerSphereCenterPoint.y = innerSphereY;
  _innerSphereCenterPoint.z = innerSphereZ;
  _snapSphereOutwardPoint.x = outwardX;
  _snapSphereOutwardPoint.y = outwardY;
  _snapSphereOutwardPoint.z = outwardZ;
  _snapRayOriginPoint.x = rayOriginX;
  _snapRayOriginPoint.y = rayOriginY;
  _snapRayOriginPoint.z = rayOriginZ;
  resolveLegChoppedSphereVelocityTarget(
    _snapRayOriginPoint,
    _snapSphereCenterPoint,
    sphereRadius,
    _innerSphereCenterPoint,
    innerSphereRadius,
    velocityX,
    velocityZ,
    _snapSphereOutwardPoint,
    _snapSphereTargetPoint,
  );
  const targetX = _snapSphereTargetPoint.x;
  const targetZ = _snapSphereTargetPoint.z;
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
  // beneath each snap sphere's inward surface and begin touchdown as soon as one
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
    resolveLegSnapSphereLocal(
      c.attachOffsetX,
      c.attachOffsetY,
      totalLength,
      c.footSphereOriginExtensionRatio,
      c.footSphereRadiusLegLengthRatio,
      _snapSphereLocal,
    );
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
      _snapSphereLocal.centerX,
      FOOT_Y,
      _snapSphereLocal.centerZ,
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
const _snapSphereLocal: LegSnapSphereLocal = {
  centerX: 0,
  centerZ: 0,
  outwardX: 0,
  outwardZ: 0,
  radius: 0,
};
const _snapSphereCenterPoint = { x: 0, y: 0, z: 0 };
const _innerSphereCenterPoint = { x: 0, y: 0, z: 0 };
const _snapSphereOutwardPoint = { x: 0, y: 0, z: 0 };
const _snapRayOriginPoint = { x: 0, y: 0, z: 0 };
const _snapSphereTargetPoint = { x: 0, y: 0, z: 0 };
const _debugSpokeDirection = new THREE.Vector3();
const _footSurface: LocomotionFootSurfaceSample = {
  groundY: 0,
  visualFootY: 0,
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
  if (mesh.innerExclusionSphere) mesh.innerExclusionSphere.visible = false;
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
    if (leg.snapBoundaryRay) leg.snapBoundaryRay.visible = false;
    if (leg.snapRayOriginPoint) leg.snapRayOriginPoint.visible = false;
    if (leg.reachSphere) leg.reachSphere.visible = false;
    if (leg.restDirection) leg.restDirection.visible = false;

    const c = leg.config;
    const tl = totalLegLength(c);
    const hipLocalX = c.attachOffsetX;
    const hipLocalY = leg.hipY;
    const hipLocalZ = c.attachOffsetY;
    resolveLegSnapSphereLocal(
      hipLocalX,
      hipLocalZ,
      tl,
      c.footSphereOriginExtensionRatio,
      c.footSphereRadiusLegLengthRatio,
      _snapSphereLocal,
    );
    const touchdownLocalX = _snapSphereLocal.centerX;
    const touchdownLocalZ = _snapSphereLocal.centerZ;
    const rayX = (_snapSphereLocal.outwardX - hipLocalX) / Math.max(1e-6, tl);
    const rayZ = (_snapSphereLocal.outwardZ - hipLocalZ) / Math.max(1e-6, tl);
    const localPlanarSpeed = Math.hypot(vLocalForward, vLocalLateral);
    const trailDistance = tl * WATERBORNE_TRAIL_DISTANCE_MULT;
    const waterTrailX = localPlanarSpeed > 1e-6
      ? -vLocalForward / localPlanarSpeed * trailDistance
      : 0;
    const waterTrailZ = localPlanarSpeed > 1e-6
      ? -vLocalLateral / localPlanarSpeed * trailDistance
      : 0;
    const waterOutwardDistance = tl * WATERBORNE_OUTWARD_DISTANCE_MULT;
    const waterLocalX =
      hipLocalX + rayX * waterOutwardDistance + waterTrailX;
    const waterLocalZ =
      hipLocalZ + rayZ * waterOutwardDistance + waterTrailZ;
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
      LEG_ENDPOINT_GROUND_CLEARANCE,
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
      hipLocalY - LEG_ENDPOINT_GROUND_CLEARANCE,
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
      LEG_ENDPOINT_GROUND_CLEARANCE,
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
      LEG_ENDPOINT_GROUND_CLEARANCE,
      entity.id,
      _footSurface,
    );
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
      leg.geometryTier,
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
      leg.geometryTier,
    );
    legRenderer.updateLower(
      leg.lowerSlot,
      knee.x, knee.y, knee.z,
      footX, footY, footZ,
      leg.lowerThick,
      leg.shellPool,
      leg.geometryTier,
    );
    if (leg.hipJointSlot >= 0) {
      legRenderer.updateJoint(
        leg.hipJointSlot,
        hipWorldX, hipWorldY, hipWorldZ,
        leg.hipJointRadius,
        leg.shellPool,
        leg.geometryTier,
      );
    }
  }
}

function initializeLegOnSnapSphere(
  leg: LegInstance,
  sphereX: number,
  sphereY: number,
  sphereZ: number,
  outwardX: number,
  outwardY: number,
  outwardZ: number,
  sphereRadius: number,
  rayOriginX: number,
  rayOriginY: number,
  rayOriginZ: number,
  innerSphereX: number,
  innerSphereY: number,
  innerSphereZ: number,
  innerSphereRadius: number,
  entityId: number,
  mapWidth: number,
  mapHeight: number,
): void {
  const side = leg.phaseShift01 === 0 ? 1 : -1;
  _snapSphereCenterPoint.x = sphereX;
  _snapSphereCenterPoint.y = sphereY;
  _snapSphereCenterPoint.z = sphereZ;
  _innerSphereCenterPoint.x = innerSphereX;
  _innerSphereCenterPoint.y = innerSphereY;
  _innerSphereCenterPoint.z = innerSphereZ;
  _snapSphereOutwardPoint.x = outwardX;
  _snapSphereOutwardPoint.y = outwardY;
  _snapSphereOutwardPoint.z = outwardZ;
  _snapRayOriginPoint.x = rayOriginX;
  _snapRayOriginPoint.y = rayOriginY;
  _snapRayOriginPoint.z = rayOriginZ;
  resolveLegChoppedSphereVelocityTarget(
    _snapRayOriginPoint,
    _snapSphereCenterPoint,
    sphereRadius,
    _innerSphereCenterPoint,
    innerSphereRadius,
    (outwardX - sphereX) * side,
    (outwardZ - sphereZ) * side,
    _snapSphereOutwardPoint,
    _snapSphereTargetPoint,
  );
  leg.worldX = _snapSphereTargetPoint.x;
  leg.worldZ = _snapSphereTargetPoint.z;
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
