// LegRig3D — world-space leg rig for legged units (arachnid family).
// Each foot is planted at a real WORLD XYZ point on terrain and stays
// there until the body has moved / yawed / tilted enough that the
// planted foot exits the leg's REST SPHERE — a chassis-local 3D ball
// centered at the leg's rest position. When the foot exits, it lifts
// and lerps to a new ground spot. The visible leg is two cylinders
// (upper hip→knee + lower knee→foot) drawn through a shared
// LegInstancedRenderer; the IK that places the knee lives here.
//
// Animation state worth surviving an LOD-driven mesh rebuild is
// captured/restored via captureLegState / applyLegState — only the
// foot-position / lerp / phase fields, not the renderer slot indices
// or per-leg config refs (those are bound to the freshly-built
// LegInstance and re-issued by buildLegs).

import * as THREE from 'three';
import { getLegsRadiusToggle } from '@/clientBarConfig';
import type {
  LegConfig as BlueprintLegConfig,
  UnitBodyShape,
} from '@/types/blueprints';
import type { LegStyle as LegLod } from '@/types/graphics';
import type { ArachnidLegConfig } from '@/types/render';
import { getSegmentMidYAt } from '../math/BodyDimensions';
import { resolveMirroredLegConfigs } from '../math/LegLayout';
import type { Entity } from '../sim/types';
import { getUnitBodyCenterHeight } from '../sim/unitGeometry';
import type { LegInstancedRenderer } from './LegInstancedRenderer';
import {
  isLocomotionGrounded,
  getLocomotionSurfaceHeight,
  getLocomotionSurfaceNormal,
  sampleLocomotionFootSurface,
} from './LocomotionTerrainSampler';
import {
  type LocomotionBase,
  easeOutCubic,
  kneeFromIK,
  transformChassisToWorld,
} from './LocomotionRigShared3D';

/** Per-unit step-circle radius as a fraction of the unit's LONGEST
 *  leg (upperLegLength + lowerLegLength). One value shared by every
 *  leg on the unit. Bigger → longer stride / slower step cadence;
 *  smaller → shorter / faster. Stays well inside physical leg reach
 *  given the typical rest-distance multipliers (0.5–0.74) so the
 *  foot can fully reach the far edge of the circle without the leg
 *  over-extending. */
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

/** Cap on the velocity-lookahead offset added to the snap target,
 *  as a fraction of stepRadius. Keeps the snap target strictly
 *  INSIDE the rest sphere even at high body speeds (e.g. a unit
 *  pushed hard by a collision or explosion). Without this cap a
 *  fast push produces a snap target outside the sphere, the foot
 *  lands outside, the trigger immediately re-fires on the next
 *  tick, and visually the foot looks like it's just dragging
 *  through space instead of actually stepping — exactly the "feet
 *  drag when the unit is pushed backward / sideways" bug. */
const SNAP_LOOKAHEAD_MAX_FRACTION = 0.7;

/** Watchdog: if the foot's distance-from-rest exceeds this many
 *  stepRadii DURING an in-flight slide, abort the slide and snap
 *  to a fresh target. Catches the case where the body's velocity
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
const AIRBORNE_TOUCHDOWN_REST_DISTANCE_MULT = 0.7;
const AIRBORNE_MAX_REACH_FRACTION = 0.96;
const JUMP_AIRBORNE_TOUCHDOWN_REST_DISTANCE_MULT = 1.0;
const JUMP_AIRBORNE_MAX_REACH_FRACTION = 0.995;
const AIRBORNE_BASE_EXTENSION = 0.65;
const AIRBORNE_NEAR_GROUND_REACH_FRACTION = 1.2;
const AIRBORNE_DESCENT_SPEED_FOR_FULL_EXTENSION = 45;

// LEGS-radius debug viz: a wireframe SPHERE in world space at the
// leg's rest center, scaled to stepRadius. A real 3D ball, not a
// flat ground ring, so on uneven terrain the foot can actually find
// a valid ground spot inside it.
const restSphereGeom = new THREE.WireframeGeometry(new THREE.SphereGeometry(1, 16, 12));
const restSphereMat = new THREE.LineBasicMaterial({
  color: 0x44ffcc,
  transparent: true,
  opacity: 0.4,
  depthWrite: false,
});

/** State for a single leg. The foot is planted at a real WORLD XYZ
 *  point on the terrain — it stays at that exact ground spot
 *  regardless of how the body moves or yaws, just like a real foot
 *  pinned against the ground. The trigger / snap test happens in
 *  world frame against the leg's rest sphere (whose CENTER is in
 *  chassis-local space and therefore moves + rotates with the body). */
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
  /** True when this leg allocated from the transparent construction-shell
   *  pools in LegInstancedRenderer. Completion triggers a unit mesh
   *  rebuild, freeing these slots and reallocating normal-material slots. */
  shellPool: boolean;

  /** Current foot world position. Y is sampled from terrain — when
   *  the foot is planted (not sliding) this XYZ doesn't change at
   *  all, which is exactly what "planted on the ground" means. */
  worldX: number;
  worldY: number;
  worldZ: number;
  /** Lerp endpoints (world XYZ) used during the snap-and-step
   *  animation that takes the foot from where it lifted off to its
   *  newly chosen ground spot. */
  startWorldX: number; startWorldY: number; startWorldZ: number;
  targetWorldX: number; targetWorldY: number; targetWorldZ: number;
  isSliding: boolean;
  lerpProgress: number;
  lerpDuration: number;
  initialized: boolean;

  /** Slot index into LegInstancedRenderer's upper-cylinder pool. -1
   *  means "no slot" (pool exhausted on alloc, or leg has no upper
   *  cylinder). The renderer flushes all slot writes once per frame
   *  so the dirty flag overhead is shared. */
  upperSlot: number;
  /** Slot index into the lower-cylinder pool. Only allocated for
   *  'animated' / 'full' LOD; 'simple' LOD legs are a single
   *  upper-cylinder spanning hip → foot directly. */
  lowerSlot: number;
  /** Slot indices into LegInstancedRenderer's joint-sphere pool —
   *  only allocated at 'full' LOD; -1 elsewhere (or when the pool
   *  is exhausted, in which case the leg quietly skips that joint).
   *  Both joints across the whole scene draw in a single shared
   *  InstancedMesh call. The radius is baked once at build (joint
   *  sizes are constant) and re-encoded into the per-frame matrix
   *  alongside the world position. */
  hipJointSlot: number;
  kneeJointSlot: number;
  /** Slot into the flattened foot-pad pool. Allocated for every
   *  rendered leg LOD so the cylinder endpoint can sit above
   *  terrain even when joints are disabled. */
  footPadSlot: number;
  hipJointRadius: number;
  kneeJointRadius: number;
  footPadRadius: number;
  footPadHalfHeight: number;
  upperThick: number;
  lowerThick: number;
  /** LEGS-radius debug viz: a wireframe SPHERE centered at this
   *  leg's rest-sphere world position. Lazy-built; hidden (not
   *  destroyed) when off. */
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
  legLod: LegLod;
  /** Per-UNIT rest-sphere radius (world units). Every leg on this
   *  unit shares the same sphere size — it scales with the unit's
   *  longest leg so a Daddy gets a much larger stride budget than a
   *  Tick, but two legs of the same unit always agree on how far a
   *  foot can wander before snapping. */
  stepRadius: number;
} & LocomotionBase;

/** Per-leg state worth surviving an LOD-driven mesh rebuild — every
 *  scalar that says "where is this foot RIGHT NOW and what is it
 *  doing?". The cylinder/joint pool slot indices and config refs
 *  intentionally aren't here; those are bound to the freshly-built
 *  LegInstance and will be re-issued by buildLegs when the rebuilt
 *  mesh allocates new pool slots. */
export type LegStateSnapshot = ReadonlyArray<{
  worldX: number; worldY: number; worldZ: number;
  startWorldX: number; startWorldY: number; startWorldZ: number;
  targetWorldX: number; targetWorldY: number; targetWorldZ: number;
  isSliding: boolean;
  lerpProgress: number;
  lerpDuration: number;
  initialized: boolean;
  phaseShift01: 0 | 1;
}>;

/** Capture per-leg state from a legged locomotion mesh into a plain
 *  array of POJOs the caller can stash across a tear-down/rebuild.
 *  Cost: O(legs.length); called only at LOD-flip time, not per-frame. */
export function captureLegState(loc: LegMesh): LegStateSnapshot {
  const out: LegStateSnapshot[number][] = [];
  for (const leg of loc.legs) {
    out.push({
      worldX: leg.worldX, worldY: leg.worldY, worldZ: leg.worldZ,
      startWorldX: leg.startWorldX, startWorldY: leg.startWorldY, startWorldZ: leg.startWorldZ,
      targetWorldX: leg.targetWorldX, targetWorldY: leg.targetWorldY, targetWorldZ: leg.targetWorldZ,
      isSliding: leg.isSliding,
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
 *  graphics LOD — so the indices line up 1:1 between the old and
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
    dst.isSliding = src.isSliding;
    dst.lerpProgress = src.lerpProgress;
    dst.lerpDuration = src.lerpDuration;
    dst.initialized = src.initialized;
    dst.phaseShift01 = src.phaseShift01;
  }
}

export function buildLegs(
  worldGroup: THREE.Group,
  entity: Entity,
  r: number,
  cfg: BlueprintLegConfig,
  legLod: LegLod,
  bodyShape: UnitBodyShape,
  chassisLiftY: number,
  legAttachHeightFrac: number | undefined,
  mapWidth: number,
  mapHeight: number,
  legRenderer: LegInstancedRenderer,
): LegMesh | undefined {
  if (legLod === 'none') return undefined;

  const { left, all: allConfigs, sides } = resolveMirroredLegConfigs(cfg, r);
  const shellPool = !!(entity.buildable && !entity.buildable.isComplete && !entity.buildable.isGhost);

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

    // Cylinders are NOT per-Mesh — they're slots in the shared
    // LegInstancedRenderer's two InstancedBufferGeometries (upper +
    // lower). Allocate one upper-slot for every leg; only allocate a
    // lower-slot for 'animated'/'full' (the IK-bend tiers — 'simple'
    // is a single hip→foot cylinder in the upper pool). If the pool
    // is exhausted, alloc returns -1 and the leg quietly skips
    // rendering.
    const upperSlot = legRenderer.allocUpper(shellPool);
    let lowerSlot = -1;
    if (legLod === 'animated' || legLod === 'full') {
      lowerSlot = legRenderer.allocLower(shellPool);
    }
    const footPadSlot = legRenderer.allocFootPad(shellPool);

    // Joint spheres at 'full' LOD only — both slots allocate into
    // the shared joint-sphere InstancedMesh pool. Radii are baked
    // here (joint sizes are constant per leg config) and re-applied
    // each frame alongside the world position via the slot's
    // instanceMatrix. -1 means "no slot" (non-full LOD or the pool
    // was exhausted; the leg just skips that joint).
    let hipJointSlot = -1;
    let kneeJointSlot = -1;
    const hipJointRadius = Math.max(1, cfg.hipRadius);
    const kneeJointRadius = Math.max(1, cfg.kneeRadius);
    const footPadRadius = Math.max(FOOT_PAD_MIN_RADIUS, lowerThick * FOOT_PAD_RADIUS_MULT);
    const footPadHalfHeight = Math.max(
      FOOT_PAD_MIN_HALF_HEIGHT,
      lowerThick * FOOT_PAD_HALF_HEIGHT_MULT,
    );
    if (legLod === 'full') {
      hipJointSlot = legRenderer.allocJoint(shellPool);
      kneeJointSlot = legRenderer.allocJoint(shellPool);
    }

    // Hip Y defaults to the lifted vertical mid-point of whichever
    // body segment the leg sits under. Units whose visible body is a
    // turret can author legAttachHeightFrac as an absolute terrain-up
    // height fraction, in the same coordinate system as turret mount.z.
    const hipY = legAttachHeightFrac !== undefined
      ? legAttachHeightFrac * r
      : chassisLiftY + getSegmentMidYAt(bodyShape, r, legCfg.attachOffsetX);

    legs.push({
      config: legCfg,
      side,
      hipY,
      phaseShift01,
      shellPool,
      worldX: 0, worldY: 0, worldZ: 0,
      startWorldX: 0, startWorldY: 0, startWorldZ: 0,
      targetWorldX: 0, targetWorldY: 0, targetWorldZ: 0,
      isSliding: false,
      lerpProgress: 0,
      lerpDuration: legCfg.lerpDuration ?? cfg.lerpDuration,
      initialized: false,
      upperSlot,
      lowerSlot,
      hipJointSlot,
      kneeJointSlot,
      footPadSlot,
      hipJointRadius,
      kneeJointRadius,
      footPadRadius,
      footPadHalfHeight,
      upperThick,
      lowerThick,
    });
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

  // Seat each foot at its rest position on the actual ground so
  // there's no first-frame flicker from (0,0,0). Each leg's
  // phaseShift01 (set just above) decides whether it starts AT rest
  // or a full stepRadius backward of rest — see initializeLegAt.
  const bodyCenterHeight = getUnitBodyCenterHeight(entity.unit);
  for (const leg of legs) {
    initializeLegAt(leg, entity, bodyCenterHeight, mapWidth, mapHeight, stepRadius);
  }

  return {
    type: 'legs',
    group,
    legs,
    config: cfg,
    legLod,
    stepRadius,
    lodKey: '',
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

/** Per-frame: advance each leg's snap-lerp physics + IK, write
 *  cylinder + joint + foot-pad transforms into the shared instanced
 *  renderer pools. */
export function updateLegs(
  mesh: LegMesh,
  entity: Entity,
  dtMs: number,
  mapWidth: number,
  mapHeight: number,
  legRenderer: LegInstancedRenderer,
): void {
  const vx = entity.unit?.velocityX ?? 0;
  const vy = entity.unit?.velocityY ?? 0;

  // World-planted feet. Each foot sits at a real world XYZ point on
  // the terrain and stays there until the body has moved or yawed
  // or tilted enough that the planted foot exits the leg's REST
  // SPHERE — a chassis-local 3D ball centered at the leg's rest
  // position. When the foot exits, it lifts and lerps to a new
  // world ground spot AT the rest position (with a velocity
  // lookahead that exactly cancels body motion during the lerp,
  // so the foot ends up at chassis-local rest by lerp completion).
  //
  // Why this avoids "under the body" and leg crossing:
  //   - Rest position = hip + outward × restDistance, sitting OUTSIDE
  //     the body silhouette by construction.
  //   - Snap target = rest position + small lookahead, which stays
  //     near rest — the foot returns home, never to the opposite
  //     side of the sphere or across the body's centerline.
  //   - stepRadius < restDistance, so the rest sphere never includes
  //     the hip; the foot can drift toward the body but the trigger
  //     always fires before the foot crosses the body's footprint.
  const bodyCenterHeight = getUnitBodyCenterHeight(entity.unit);
  const stepRadius = mesh.stepRadius;
  const showViz = getLegsRadiusToggle();
  const grounded = isLocomotionGrounded(entity, mapWidth, mapHeight);
  // Chassis-UP direction in three.js world coords — the surface
  // normal at the unit's footprint, mapped from sim (sim z up) to
  // three (sim z → three y). Sampled once per unit per frame and
  // shared across every leg's IK so all legs bend their knees
  // along the same chassis-relative "up", regardless of slope.
  // On flat ground this collapses to (0, 1, 0) = world up.
  const sn = getLocomotionSurfaceNormal(entity, mapWidth, mapHeight);
  const chassisUpX = sn.nx;
  const chassisUpY = sn.nz;
  const chassisUpZ = sn.ny;
  // Body velocity rotated into chassis-local frame, used for the
  // snap target's lookahead. sim x/y → three x/z (the existing
  // handedness); chassis +X = body forward.
  const yaw = entity.transform.rotation;
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const vLocalForward = cosYaw * vx + sinYaw * vy;
  const vLocalLateral = -sinYaw * vx + cosYaw * vy;

  if (!grounded) {
    updateAirborneLegPose(
      mesh,
      entity,
      bodyCenterHeight,
      mapWidth,
      mapHeight,
      legRenderer,
      chassisUpX,
      chassisUpY,
      chassisUpZ,
    );
    return;
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
      entity, bodyCenterHeight, mapWidth, mapHeight, _worldOut,
    );
    const hipWorldX = _worldOut.x;
    const hipWorldY = _worldOut.y;
    const hipWorldZ = _worldOut.z;

    transformChassisToWorld(
      restLocalX, restLocalY, restLocalZ,
      entity, bodyCenterHeight, mapWidth, mapHeight, _worldOut,
    );
    const restWorldX = _worldOut.x;
    const restWorldY = _worldOut.y;
    const restWorldZ = _worldOut.z;

    // LEGS-radius viz: a wireframe SPHERE in world space at the
    // rest center, scaled to stepRadius. Lazy-build / cheap toggle.
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
      initializeLegAt(leg, entity, bodyCenterHeight, mapWidth, mapHeight, stepRadius);
    }

    // Lerp the foot through 3D world space when mid-step. Otherwise
    // the foot is PLANTED — its world XYZ doesn't change at all.
    if (leg.isSliding) {
      if (leg.lerpDuration <= 0) {
        leg.worldX = leg.targetWorldX;
        leg.worldY = leg.targetWorldY;
        leg.worldZ = leg.targetWorldZ;
        leg.isSliding = false;
      } else {
        leg.lerpProgress += dtMs / leg.lerpDuration;
        if (leg.lerpProgress >= 1) {
          leg.lerpProgress = 1;
          leg.worldX = leg.targetWorldX;
          leg.worldY = leg.targetWorldY;
          leg.worldZ = leg.targetWorldZ;
          leg.isSliding = false;
        } else {
          const t = easeOutCubic(leg.lerpProgress);
          leg.worldX = leg.startWorldX + (leg.targetWorldX - leg.startWorldX) * t;
          leg.worldY = leg.startWorldY + (leg.targetWorldY - leg.startWorldY) * t;
          leg.worldZ = leg.startWorldZ + (leg.targetWorldZ - leg.startWorldZ) * t;
        }
      }
    }

    // REST-SPHERE TRIGGER. Test foot ↔ rest center in 3D world
    // coords. The same single check covers translation, yaw, AND
    // tilt change — the rest sphere's center moves with all three,
    // the foot stays put, so any of them can carry the foot out
    // of the sphere. The trigger is direction-agnostic, so it
    // fires equally for forward, backward, sideways, and yaw-only
    // motion of the body.
    const dx = leg.worldX - restWorldX;
    const dy = leg.worldY - restWorldY;
    const dz = leg.worldZ - restWorldZ;
    const distSq = dx * dx + dy * dy + dz * dz;
    const stepRSq = stepRadius * stepRadius;

    // Watchdog: if the foot is way outside the sphere mid-slide
    // (body changed direction during the step, or we're snapping
    // to an old target the body has since outrun), abort and
    // re-trigger to a fresh target.
    if (
      leg.isSliding
      && distSq > stepRSq * SLIDE_INTERRUPT_FRACTION * SLIDE_INTERRUPT_FRACTION
    ) {
      leg.isSliding = false;
    }

    if (!leg.isSliding && distSq > stepRSq) {
      // Snap target = REST POSITION + velocity lookahead. The foot
      // lifts and lands near home, then drift restarts. The
      // lookahead in chassis-local frame shifts the target along
      // the body's motion direction by velocity × lerpDuration —
      // so by the time the lerp completes, the body has caught up
      // and the foot is at chassis-local rest. Direction-agnostic:
      // works the same for forward thrust, backward push, sideways
      // slide, etc.
      //
      // The offset is CAPPED at SNAP_LOOKAHEAD_MAX_FRACTION of
      // stepRadius so the target always lands inside the rest
      // sphere even when the body is moving fast. Without that
      // cap, fast motion (especially backward / sideways pushes
      // from collisions) produces a target outside the sphere,
      // the foot lands outside, and the trigger fires again
      // immediately on the next tick — visually reading as
      // "dragging" because each step is a no-op micro-snap.
      const lookaheadT = leg.lerpDuration / 1000;
      let offsetX = vLocalForward * lookaheadT;
      let offsetZ = vLocalLateral * lookaheadT;
      const offsetMag = Math.hypot(offsetX, offsetZ);
      const offsetMax = stepRadius * SNAP_LOOKAHEAD_MAX_FRACTION;
      if (offsetMag > offsetMax) {
        const scale = offsetMax / offsetMag;
        offsetX *= scale;
        offsetZ *= scale;
      }
      const targetLocalX = restLocalX + offsetX;
      const targetLocalY = restLocalY;
      const targetLocalZ = restLocalZ + offsetZ;
      transformChassisToWorld(
        targetLocalX, targetLocalY, targetLocalZ,
        entity, bodyCenterHeight, mapWidth, mapHeight, _worldOut,
      );
      const tWorldX = _worldOut.x;
      const tWorldZ = _worldOut.z;
      // Y comes from actual terrain at the chosen XZ — feet always
      // land on real ground, not a plane through the rest center.
      const groundY = getLocomotionSurfaceHeight(tWorldX, tWorldZ, mapWidth, mapHeight);

      leg.startWorldX = leg.worldX; leg.startWorldY = leg.worldY; leg.startWorldZ = leg.worldZ;
      leg.targetWorldX = tWorldX;
      leg.targetWorldY = groundY;
      leg.targetWorldZ = tWorldZ;
      leg.isSliding = true;
      leg.lerpProgress = 0;
    }

    // Clamp visual leg length to physical reach so a fast snap or
    // a freshly tilted body can't render a leg that visibly stretches
    // past its hinge limit. Done in world space against the world hip.
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
    // Sampling at the current visual XZ keeps sliding feet above
    // hills/ridges between their start and target ground points.
    const footCylinderRadius = mesh.legLod === 'simple' ? leg.upperThick : leg.lowerThick;
    const footSurface = sampleLocomotionFootSurface(
      footX,
      footZ,
      mapWidth,
      mapHeight,
      footCylinderRadius,
      leg.footPadHalfHeight,
      FOOT_PAD_GROUND_CLEARANCE,
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
}

function totalLegLength(c: ArachnidLegConfig): number {
  return c.upperLegLength + c.lowerLegLength;
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

// Scratch output struct reused across the per-leg loop.
const _worldOut = { x: 0, y: 0, z: 0 };

function updateAirborneLegPose(
  mesh: LegMesh,
  entity: Entity,
  bodyCenterHeight: number,
  mapWidth: number,
  mapHeight: number,
  legRenderer: LegInstancedRenderer,
  chassisUpX: number,
  chassisUpY: number,
  chassisUpZ: number,
): void {
  const bodyBaseY = entity.transform.z - bodyCenterHeight;
  const bodyGroundY = getLocomotionSurfaceHeight(
    entity.transform.x,
    entity.transform.y,
    mapWidth,
    mapHeight,
  );
  const bodyClearance = Math.max(0, bodyBaseY - bodyGroundY);
  const descentSpeed = Math.max(0, -(entity.unit?.velocityZ ?? 0));
  // Jump-capable legged units should read as pushing off / bracing for
  // landing while airborne, not tucking their knees under the chassis.
  const useJumpExtensionPose = entity.unit?.jump !== undefined;

  for (const leg of mesh.legs) {
    if (leg.restSphere) leg.restSphere.visible = false;

    const c = leg.config;
    const tl = totalLegLength(c);
    const restDistance = tl * c.snapDistanceMultiplier;
    const hipLocalX = c.attachOffsetX;
    const hipLocalY = leg.hipY;
    const hipLocalZ = c.attachOffsetY;
    const touchdownDistance = restDistance * (
      useJumpExtensionPose
        ? JUMP_AIRBORNE_TOUCHDOWN_REST_DISTANCE_MULT
        : AIRBORNE_TOUCHDOWN_REST_DISTANCE_MULT
    );
    const touchdownLocalX = hipLocalX + Math.cos(c.snapTargetAngle) * touchdownDistance;
    const touchdownLocalZ = hipLocalZ + Math.sin(c.snapTargetAngle) * touchdownDistance;

    transformChassisToWorld(
      hipLocalX, hipLocalY, hipLocalZ,
      entity, bodyCenterHeight, mapWidth, mapHeight, _worldOut,
    );
    const hipWorldX = _worldOut.x;
    const hipWorldY = _worldOut.y;
    const hipWorldZ = _worldOut.z;

    transformChassisToWorld(
      touchdownLocalX, FOOT_Y, touchdownLocalZ,
      entity, bodyCenterHeight, mapWidth, mapHeight, _worldOut,
    );
    const footCylinderRadius = mesh.legLod === 'simple' ? leg.upperThick : leg.lowerThick;
    const firstSurface = sampleLocomotionFootSurface(
      _worldOut.x,
      _worldOut.z,
      mapWidth,
      mapHeight,
      footCylinderRadius,
      leg.footPadHalfHeight,
      FOOT_PAD_GROUND_CLEARANCE,
    );
    const horizontalReach = Math.hypot(
      touchdownLocalX - hipLocalX,
      touchdownLocalZ - hipLocalZ,
    );
    const maxReach = tl * (
      useJumpExtensionPose
        ? JUMP_AIRBORNE_MAX_REACH_FRACTION
        : AIRBORNE_MAX_REACH_FRACTION
    );
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
    const extension01 = useJumpExtensionPose
      ? 1
      : Math.max(AIRBORNE_BASE_EXTENSION, nearGround01, descent01);
    const footLocalY = hipLocalY + (touchdownLocalY - hipLocalY) * extension01;

    transformChassisToWorld(
      touchdownLocalX, footLocalY, touchdownLocalZ,
      entity, bodyCenterHeight, mapWidth, mapHeight, _worldOut,
    );
    const footX = _worldOut.x;
    const footZ = _worldOut.z;
    const footSurface = sampleLocomotionFootSurface(
      footX,
      footZ,
      mapWidth,
      mapHeight,
      footCylinderRadius,
      leg.footPadHalfHeight,
      FOOT_PAD_GROUND_CLEARANCE,
    );
    const footY = Math.max(_worldOut.y, footSurface.visualFootY);

    leg.worldX = footX;
    leg.worldY = footY;
    leg.worldZ = footZ;
    leg.startWorldX = footX;
    leg.startWorldY = footY;
    leg.startWorldZ = footZ;
    leg.targetWorldX = footX;
    leg.targetWorldY = footY;
    leg.targetWorldZ = footZ;
    leg.isSliding = false;
    leg.lerpProgress = 0;
    leg.initialized = false;

    writeLegRenderPose(
      mesh,
      leg,
      legRenderer,
      hipWorldX, hipWorldY, hipWorldZ,
      footX, footY, footZ,
      footSurface.nx, footSurface.nz, footSurface.ny,
      chassisUpX, chassisUpY, chassisUpZ,
      useJumpExtensionPose,
    );
  }
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
  forceStraightKnee = false,
): void {
  const c = leg.config;
  if (mesh.legLod === 'simple') {
    legRenderer.updateUpper(
      leg.upperSlot,
      hipWorldX, hipWorldY, hipWorldZ,
      footX, footY, footZ,
      leg.upperThick,
      leg.shellPool,
    );
  } else {
    const knee = forceStraightKnee
      ? kneeOnLegLine(
        hipWorldX, hipWorldY, hipWorldZ,
        footX, footY, footZ,
        c.upperLegLength, c.lowerLegLength,
      )
      : kneeFromIK(
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

function kneeOnLegLine(
  hipX: number,
  hipY: number,
  hipZ: number,
  footX: number,
  footY: number,
  footZ: number,
  upperLen: number,
  lowerLen: number,
): { x: number; y: number; z: number } {
  const totalLen = upperLen + lowerLen;
  const ratio = totalLen > 1e-6 ? upperLen / totalLen : 0.5;
  return {
    x: hipX + (footX - hipX) * ratio,
    y: hipY + (footY - hipY) * ratio,
    z: hipZ + (footZ - hipZ) * ratio,
  };
}

function initializeLegAt(
  leg: LegInstance,
  entity: Entity,
  bodyCenterHeight: number,
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
  transformChassisToWorld(cx, cy, cz, entity, bodyCenterHeight, mapWidth, mapHeight, _worldOut);
  const groundY = getLocomotionSurfaceHeight(_worldOut.x, _worldOut.z, mapWidth, mapHeight);
  leg.worldX = _worldOut.x;
  leg.worldY = groundY;
  leg.worldZ = _worldOut.z;
  leg.startWorldX = leg.worldX; leg.startWorldY = leg.worldY; leg.startWorldZ = leg.worldZ;
  leg.targetWorldX = leg.worldX; leg.targetWorldY = leg.worldY; leg.targetWorldZ = leg.worldZ;
  leg.initialized = true;
}
