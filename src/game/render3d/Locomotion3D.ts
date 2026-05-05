// Locomotion3D — 3D geometry + per-frame animation for each unit's legs,
// treads, or wheels.
//
// Legs port the 2D ArachnidLeg system (world-space foot planting, snap-lerp
// gait, IK knee bend) with the only simplification being that we keep feet
// on the ground plane (2-axis movement: XZ). Attach offsets, lengths, and
// snap parameters are authored on each unit blueprint.

import * as THREE from 'three';
import type { Entity, PlayerId } from '../sim/types';
import { getUnitBlueprint } from '../sim/blueprints';
import { getUnitBodyCenterHeight } from '../sim/unitGeometry';
import type {
  TreadConfig,
  WheelConfig,
  LegConfig as BlueprintLegConfig,
  UnitBodyShape,
} from '@/types/blueprints';
import type { GraphicsConfig, LegStyle as LegLod } from '@/types/graphics';
import type { ArachnidLegConfig } from '@/types/render';
import {
  getChassisLiftY,
  getSegmentMidYAt,
  TREAD_CHASSIS_LIFT_Y,
} from '../math/BodyDimensions';
import { resolveMirroredLegConfigs } from '../math/LegLayout';
import { getLegsRadiusToggle } from '@/clientBarConfig';
import { getSurfaceHeight, getSurfaceNormal } from '../sim/Terrain';
import { SHELL_OPACITY, NORMAL_OPACITY } from '@/shellConfig';
import { LAND_CELL_SIZE } from '../../config';
import type { LegInstancedRenderer } from './LegInstancedRenderer';

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

const TREAD_COLOR = 0x1a1d22;
export const TREAD_HEIGHT = TREAD_CHASSIS_LIFT_Y;
const TREAD_Y = TREAD_HEIGHT / 2;

/** Vertical offset (world units) by which the unit's BODY (chassis,
 *  turrets, mirrors, force-field) sits above the ground plane.
 *
 *  Runtime rule: the unit blueprint's `bodyCenterHeight` is the hard
 *  source of truth. Chassis lift is derived from it so visual body
 *  center, sim center, turret mounts, and locomotion attachment all
 *  live in the same terrain-up coordinate system.
 *
 *  Returned in WORLD UNITS — used as `liftGroup.position.y` in
 *  Render3DEntities. */
export function getChassisLift(
  blueprint: import('@/types/blueprints').UnitBlueprint,
  unitRadius: number,
): number {
  return getChassisLiftY(blueprint, unitRadius);
}
const WHEEL_COLOR = 0x2a2f36;

// Vertical layout for legs. Feet stay on the ground, hips attach at
// each leg's per-body-segment midpoint — computed once when the leg
// set is built (getSegmentMidYAt resolves the nearest body segment to
// the leg's forward offset). The knee's Y is solved by the IK routine:
// it lifts upward in the vertical plane containing the hip-foot line.
// Walk-cycle animation remains 2-axis (foot planting in XZ).
const FOOT_Y = 1;

export type Locomotion3DMesh =
  | ({ type: 'treads';
       group: THREE.Group;
       wheels: THREE.Mesh[];
       /** Animated cleat strips on top of the tread slab (empty when
        *  treadsAnimated is off). Scroll along the slab length every frame
        *  at a rate proportional to the unit's speed — 3D analog of the
        *  2D drawAnimatedTread() moving track-mark lines. */
       cleats: THREE.Mesh[];
       cleatSpacing: number;
       slabLength: number;
       /** Cumulative linear distance the tread has "rolled" (world units).
        *  Only the mod with cleatSpacing is used, but we keep the full
        *  accumulator so animation keeps smooth across long runs. */
       treadPhase: number;
    } & LocomotionBase)
  | ({ type: 'wheels'; group: THREE.Group; wheels: THREE.Mesh[] } & LocomotionBase)
  | ({ type: 'legs';
       /** Container for non-instanced leg parts — joint spheres at
        *  'full' LOD, the LEGS-RAD viz sphere, etc. Parented to the
        *  WORLD group so per-leg state stays in world coords. The
        *  CYLINDERS themselves are NOT children of this group; they
        *  live in the shared LegInstancedRenderer's two
        *  InstancedBufferGeometries (one upper-leg, one lower-leg)
        *  and render in a combined two draw calls for the entire
        *  scene. Each leg keeps a slot index into those buffers. */
       group: THREE.Group;
       legs: LegInstance[];
       config: BlueprintLegConfig;
       legLod: LegLod;
       /** Per-UNIT rest-sphere radius (world units). Every leg on
        *  this unit shares the same sphere size — it scales with
        *  the unit's longest leg so a Daddy gets a much larger
        *  stride budget than a Tick, but two legs of the same unit
        *  always agree on how far a foot can wander before
        *  snapping. */
       stepRadius: number;
    } & LocomotionBase)
  | undefined;

type LocomotionBase = {
  lodKey: string;
};

/** State for a single leg. The foot is planted at a real WORLD XYZ
 *  point on the terrain — it stays at that exact ground spot
 *  regardless of how the body moves or yaws, just like a real foot
 *  pinned against the ground. The trigger / snap test happens in
 *  world frame against the leg's rest sphere (whose CENTER is in
 *  chassis-local space and therefore moves + rotates with the body). */
type LegInstance = {
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
   *  All three joints across the whole scene draw in a single shared
   *  InstancedMesh call. The radius is baked once at build (joint
   *  sizes are constant) and re-encoded into the per-frame matrix
   *  alongside the world position. */
  hipJointSlot: number;
  kneeJointSlot: number;
  footJointSlot: number;
  hipJointRadius: number;
  kneeJointRadius: number;
  footJointRadius: number;
  upperThick: number;
  lowerThick: number;
  /** LEGS-radius debug viz: a wireframe SPHERE centered at this
   *  leg's rest-sphere world position. Lazy-built; hidden (not
   *  destroyed) when off. */
  restSphere?: THREE.LineSegments;
};

const treadBoxGeom = new THREE.BoxGeometry(1, 1, 1);
const wheelGeom = new THREE.CylinderGeometry(1, 1, 1, 12);
// Leg cylinders AND joint spheres no longer need a per-mesh
// geometry — every leg cylinder + joint sphere renders through the
// LegInstancedRenderer's shared pools.

// Unit wireframe sphere — the rest-sphere viz. Each leg gets one
// LineSegments instance scaled up to stepRadius and positioned at the
// leg's rest-sphere CENTER in world coords. A real 3D ball, not a
// flat ground ring, so on uneven terrain the foot can actually find
// a valid ground spot inside it.
const restSphereGeom = new THREE.WireframeGeometry(new THREE.SphereGeometry(1, 16, 12));
const restSphereMat = new THREE.LineBasicMaterial({
  color: 0x44ffcc,
  transparent: true,
  opacity: 0.4,
  depthWrite: false,
});

const treadMat = new THREE.MeshBasicMaterial({ color: TREAD_COLOR });
const wheelMat = new THREE.MeshBasicMaterial({ color: WHEEL_COLOR });
// Leg cylinders + joint spheres now live in LegInstancedRenderer's
// shared pools; their materials are owned there. No module-level
// legMat remains.
// Lighter gray for the animated cleats, mirroring the 2D drawAnimatedTread
// track-line color (`GRAY_LIGHT`) so the moving highlights read over the
// dark tread slab.
const cleatMat = new THREE.MeshBasicMaterial({ color: 0x5a636d });

export function lodKeyFor(gfx: GraphicsConfig): string {
  return `${gfx.legs}|${gfx.treadsAnimated ? 1 : 0}`;
}

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
 *  Returns `undefined` for non-legged units (treads/wheels/none) so
 *  the caller can `if (snap)` cheaply. Cost: O(legs.length); called
 *  only at LOD-flip time, not per-frame. */
export function captureLegState(loc: Locomotion3DMesh): LegStateSnapshot | undefined {
  if (!loc || loc.type !== 'legs') return undefined;
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
 *  blueprint (leg layout + bodyShape), which doesn't change with graphics
 *  LOD — so the indices line up 1:1 between the old and new
 *  LegInstance arrays. Slot indices, configs, and per-leg geometry
 *  refs (newly minted by buildLegs) are left untouched; only the
 *  foot-position / lerp / phase fields are overwritten. */
export function applyLegState(loc: Locomotion3DMesh, snapshot: LegStateSnapshot): void {
  if (!loc || loc.type !== 'legs') return;
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

export function buildLocomotion(
  unitGroup: THREE.Group,
  worldGroup: THREE.Group,
  entity: Entity,
  unitRadius: number,
  _pid: PlayerId | undefined,
  gfx: GraphicsConfig,
  mapWidth: number,
  mapHeight: number,
  legRenderer: LegInstancedRenderer,
): Locomotion3DMesh {
  if (!entity.unit) return undefined;
  let bp;
  try {
    bp = getUnitBlueprint(entity.unit.unitType);
  } catch {
    return undefined;
  }
  const loc = bp.locomotion;
  if (!loc) return undefined;

  const lodKey = lodKeyFor(gfx);

  switch (loc.type) {
    case 'treads': {
      const mesh = buildTreads(unitGroup, unitRadius, loc.config, gfx.treadsAnimated);
      if (mesh) mesh.lodKey = lodKey;
      return mesh;
    }
    case 'wheels': {
      const mesh = buildWheels(unitGroup, unitRadius, loc.config);
      if (mesh) mesh.lodKey = lodKey;
      return mesh;
    }
    case 'legs': {
      const chassisLiftY = getChassisLift(bp, unitRadius);
      const mesh = buildLegs(
        worldGroup, entity, unitRadius, loc.config,
        gfx.legs, bp.bodyShape, chassisLiftY, bp.legAttachHeightFrac, mapWidth, mapHeight, legRenderer,
      );
      if (mesh) mesh.lodKey = lodKey;
      return mesh;
    }
  }
}

function buildTreads(
  unitGroup: THREE.Group,
  r: number,
  cfg: TreadConfig,
  animatedWheels: boolean,
): Locomotion3DMesh {
  const group = new THREE.Group();
  const length = r * cfg.treadLength;
  const width = r * cfg.treadWidth;
  const offset = r * cfg.treadOffset;
  for (const side of [-1, 1]) {
    const slab = new THREE.Mesh(treadBoxGeom, treadMat);
    slab.scale.set(length, TREAD_HEIGHT, width);
    slab.position.set(0, TREAD_Y, side * offset);
    group.add(slab);
  }

  const wheels: THREE.Mesh[] = [];
  const cleats: THREE.Mesh[] = [];
  let cleatSpacing = 0;

  if (animatedWheels) {
    // Internal wheels — mostly hidden inside the slab but ensure the
    // chassis-speed → wheel-rotation rate stays consistent with what the
    // visible cleats display.
    const wheelCount = Math.max(2, Math.round(cfg.treadLength * 2));
    const wheelR = Math.max(1, r * cfg.wheelRadius);
    for (const side of [-1, 1]) {
      for (let i = 0; i < wheelCount; i++) {
        const t = (i + 0.5) / wheelCount;
        const x = -length / 2 + t * length;
        const w = new THREE.Mesh(wheelGeom, wheelMat);
        w.rotation.x = Math.PI / 2;
        w.scale.set(wheelR, width * 1.05, wheelR);
        w.position.set(x, TREAD_Y, side * offset);
        group.add(w);
        wheels.push(w);
      }
    }

    // Animated cleats on top of the slab — lighter-gray strips that scroll
    // along the tread length, matching the 2D drawAnimatedTread track-mark
    // animation. One extra cleat per side so the wrap-around transition is
    // seamless as strips exit the near end and re-enter at the far end.
    const cleatCount = Math.max(6, Math.round(cfg.treadLength * 4));
    cleatSpacing = length / cleatCount;
    const cleatLen = cleatSpacing * 0.4;
    const cleatHeight = 2;
    const cleatWidth = width * 0.85;
    const cleatsPerSide = cleatCount + 1;
    for (const side of [-1, 1]) {
      for (let i = 0; i < cleatsPerSide; i++) {
        const cleat = new THREE.Mesh(treadBoxGeom, cleatMat);
        cleat.scale.set(cleatLen, cleatHeight, cleatWidth);
        // Rest Y on top of the slab; X is set each frame by the scroll loop.
        cleat.position.set(0, TREAD_HEIGHT + cleatHeight / 2, side * offset);
        group.add(cleat);
        cleats.push(cleat);
      }
    }
  }

  unitGroup.add(group);
  return {
    type: 'treads',
    group,
    wheels,
    cleats,
    cleatSpacing,
    slabLength: length,
    treadPhase: 0,
    lodKey: '',
  };
}

function buildWheels(
  unitGroup: THREE.Group,
  r: number,
  cfg: WheelConfig,
): Locomotion3DMesh {
  // Wheeled units (jackal, mongoose, …) get four real cylindrical
  // wheels — not the four small tread-slabs the previous renderer
  // used. The cylinder default axis is +Y; we wrap it in a group
  // rotated so the axle points along the unit's lateral (+Z) axis,
  // and the inner mesh spins around its own +Y for the rolling-
  // tire animation when the unit moves.
  const group = new THREE.Group();
  const wheelR = Math.max(1, r * cfg.wheelRadius);
  const tireWidth = Math.max(0.5, r * cfg.treadWidth);
  const fx = r * cfg.wheelDistX;
  const fz = r * cfg.wheelDistY;
  const wheels: THREE.Mesh[] = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      // Outer group: position at the wheel mount, lay the cylinder
      // on its side (axle parallel to lateral). Wheel center sits at
      // y = wheelR so the bottom of the tire touches the ground.
      const wheelGroup = new THREE.Group();
      wheelGroup.position.set(sx * fx, wheelR, sz * fz);
      wheelGroup.rotation.x = Math.PI / 2;
      // Inner mesh — the spinning tire. Local +X / +Z scale to wheel
      // radius (the disc face); local +Y scale to tire width (post-
      // rotation, world lateral). Spin animation rotates this mesh
      // around its own +Y, which after the parent's rotation.x is
      // the lateral axis in the unit's frame.
      const tire = new THREE.Mesh(wheelGeom, wheelMat);
      tire.scale.set(wheelR, tireWidth, wheelR);
      wheelGroup.add(tire);
      group.add(wheelGroup);
      wheels.push(tire);
    }
  }
  unitGroup.add(group);
  return { type: 'wheels', group, wheels, lodKey: '' };
}

function buildLegs(
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
): Locomotion3DMesh {
  if (legLod === 'none') return undefined;

  const { left, all: allConfigs, sides } = resolveMirroredLegConfigs(cfg, r);

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

    // Cylinders are NOT per-Mesh anymore — they're slots in the
    // shared LegInstancedRenderer's two InstancedBufferGeometries
    // (upper + lower). Allocate one upper-slot for every leg; only
    // allocate a lower-slot for 'animated'/'full' (the IK-bend
    // tiers — 'simple' is a single hip→foot cylinder in the upper
    // pool). If the pool is exhausted, alloc returns -1 and the
    // leg quietly skips rendering.
    const upperSlot = legRenderer.allocUpper();
    let lowerSlot = -1;
    if (legLod === 'animated' || legLod === 'full') {
      lowerSlot = legRenderer.allocLower();
    }

    // Joint spheres at 'full' LOD only — all three slots allocate
    // into the shared joint-sphere InstancedMesh pool. Radii are
    // baked here (joint sizes are constant per leg config) and
    // re-applied each frame alongside the world position via the
    // slot's instanceMatrix. -1 means "no slot" (non-full LOD or
    // the pool was exhausted; the leg just skips that joint).
    let hipJointSlot = -1;
    let kneeJointSlot = -1;
    let footJointSlot = -1;
    const hipJointRadius = Math.max(1, cfg.hipRadius);
    const kneeJointRadius = Math.max(1, cfg.kneeRadius);
    const footJointRadius = Math.max(1, cfg.footRadius);
    if (legLod === 'full') {
      hipJointSlot = legRenderer.allocJoint();
      kneeJointSlot = legRenderer.allocJoint();
      footJointSlot = legRenderer.allocJoint();
    }

    // Hip Y defaults to the lifted vertical mid-point of whichever body
    // segment the leg sits under. Units whose visible body is a turret
    // can author legAttachHeightFrac as an absolute terrain-up height
    // fraction, in the same coordinate system as turret mount.z.
    const hipY = legAttachHeightFrac !== undefined
      ? legAttachHeightFrac * r
      : chassisLiftY + getSegmentMidYAt(bodyShape, r, legCfg.attachOffsetX);

    legs.push({
      config: legCfg,
      side,
      hipY,
      phaseShift01,
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
      footJointSlot,
      hipJointRadius,
      kneeJointRadius,
      footJointRadius,
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

// --- Leg geometry (rest-pose; legs share the same yawGroup parent as
// every other locomotion type so animation lives in the parent
// chain, not in per-leg world-space tracking) ---

function totalLegLength(c: ArachnidLegConfig): number {
  return c.upperLegLength + c.lowerLegLength;
}

// Reused by the chassis→world transform on the legs hot path so the
// per-frame loop allocates no quaternions / vectors.
const _chassisVec = new THREE.Vector3();
const _chassisTilt = new THREE.Quaternion();
const _chassisUp = new THREE.Vector3(0, 1, 0);
const _chassisN = new THREE.Vector3();

/** Given a chassis-local point (cx, cy, cz) and a unit's transform,
 *  return the corresponding WORLD point (writes into out). The
 *  transform chain matches Render3DEntities exactly:
 *
 *    world = T(unit_base) · tilt · Ry(yaw) · chassis_local
 *
 *  where unit_base is (sim.x, sim.z − bodyCenterHeight, sim.y), yaw is
 *  −sim.rotation, and tilt is built from the surface normal at the
 *  unit's footprint. Surface normal sampling is done inline so the
 *  caller doesn't need to thread it through. */
function transformChassisToWorld(
  cx: number, cy: number, cz: number,
  entity: Entity,
  bodyCenterHeight: number,
  mapWidth: number,
  mapHeight: number,
  out: { x: number; y: number; z: number },
): void {
  const rot = entity.transform.rotation;
  const cosR = Math.cos(rot);
  const sinR = Math.sin(rot);
  // Yaw: yawGroup applies rotation.y = −rot. Apply that to (cx, cy, cz).
  const yx = cosR * cx - sinR * cz;
  const yy = cy;
  const yz = sinR * cx + cosR * cz;
  // Tilt: build the same surface-normal quaternion the renderer uses.
  // Read from the unit's sim-side smoothed normal (updateUnitTilt) so
  // legs/wheels and chassis tilt all share one canonical value, falling
  // back to a raw-terrain read for non-unit entities.
  const n = entity.unit?.surfaceNormal ?? getSurfaceNormal(
    entity.transform.x, entity.transform.y,
    mapWidth, mapHeight, LAND_CELL_SIZE,
  );
  if (n.nx === 0 && n.ny === 0) {
    out.x = entity.transform.x + yx;
    out.y = entity.transform.z - bodyCenterHeight + yy;
    out.z = entity.transform.y + yz;
    return;
  }
  // sim normal (nx, ny, nz=up) → three.js (nx, nz, ny)
  _chassisN.set(n.nx, n.nz, n.ny);
  _chassisTilt.setFromUnitVectors(_chassisUp, _chassisN);
  _chassisVec.set(yx, yy, yz).applyQuaternion(_chassisTilt);
  out.x = entity.transform.x + _chassisVec.x;
  out.y = entity.transform.z - bodyCenterHeight + _chassisVec.y;
  out.z = entity.transform.y + _chassisVec.z;
}

// Scratch output struct reused across the per-leg loop.
const _worldOut = { x: 0, y: 0, z: 0 };

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
  const groundY = getSurfaceHeight(_worldOut.x, _worldOut.z, mapWidth, mapHeight, LAND_CELL_SIZE);
  leg.worldX = _worldOut.x;
  leg.worldY = groundY;
  leg.worldZ = _worldOut.z;
  leg.startWorldX = leg.worldX; leg.startWorldY = leg.worldY; leg.startWorldZ = leg.worldZ;
  leg.targetWorldX = leg.worldX; leg.targetWorldY = leg.worldY; leg.targetWorldZ = leg.worldZ;
  leg.initialized = true;
}

/** 3D IK (law of cosines, lifted into 3D) — returns the knee world
 *  position for a leg given hip + foot and upper/lower segment
 *  lengths. The knee is placed in the plane that contains the hip→
 *  foot line and the chassis-up axis (the surface normal at the
 *  unit's footprint), bending toward chassis-up. On flat ground
 *  chassis-up collapses to world +Y and the math matches the
 *  pre-tilt behavior; on a slope the knee bends "up" relative to
 *  the unit instead of "up" in world coords — so legs always look
 *  knees-pointing-skyward from the unit's perspective, even when
 *  the unit is leaning hard on a hillside.
 *
 *  upX/upY/upZ MUST be a unit vector (the caller computes it once
 *  per unit per frame via the surface-normal sampler). */
function kneeFromIK(
  hipX: number, hipY: number, hipZ: number,
  footX: number, footY: number, footZ: number,
  upperLen: number, lowerLen: number,
  upX: number, upY: number, upZ: number,
): { x: number; y: number; z: number } {
  const dx = footX - hipX;
  const dy = footY - hipY;
  const dz = footZ - hipZ;
  const dist = Math.max(1e-3, Math.hypot(dx, dy, dz));
  const clampedDist = Math.min(dist, upperLen + lowerLen * 0.98);

  const a = upperLen;
  const b = lowerLen;
  const c = clampedDist;
  let cosB = (a * a + c * c - b * b) / (2 * a * c);
  cosB = Math.max(-1, Math.min(1, cosB));
  // sin(B) positive → knee bends along the chassis-up direction.
  const sinB = Math.sqrt(Math.max(0, 1 - cosB * cosB));

  // Unit vector hip → foot
  const nx = dx / dist;
  const ny = dy / dist;
  const nz = dz / dist;

  // In-plane "up" = chassis-up (passed in) with its component along
  // `n` removed, then normalized. This keeps the knee in the
  // up-axis-containing plane that includes the leg, bending toward
  // the chassis-up direction. If the leg happens to be exactly
  // aligned with chassis-up (degenerate), fall back to chassis-up.
  const dotUpN = upX * nx + upY * ny + upZ * nz;
  let ux = upX - dotUpN * nx;
  let uy = upY - dotUpN * ny;
  let uz = upZ - dotUpN * nz;
  const uLen = Math.hypot(ux, uy, uz);
  if (uLen > 1e-6) {
    ux /= uLen;
    uy /= uLen;
    uz /= uLen;
  } else {
    ux = upX; uy = upY; uz = upZ;
  }

  return {
    x: hipX + upperLen * (cosB * nx + sinB * ux),
    y: hipY + upperLen * (cosB * ny + sinB * uy),
    z: hipZ + upperLen * (cosB * nz + sinB * uz),
  };
}

/**
 * Per-frame update — drives the tread wheels, and advances each leg's
 * snap-lerp physics + IK.
 */
export function updateLocomotion(
  mesh: Locomotion3DMesh,
  entity: Entity,
  dtMs: number,
  mapWidth: number,
  mapHeight: number,
  legRenderer: LegInstancedRenderer,
): void {
  if (!mesh) return;
  const vx = entity.unit?.velocityX ?? 0;
  const vy = entity.unit?.velocityY ?? 0;
  const speed = Math.hypot(vx, vy);
  const dt = dtMs / 1000;

  if (mesh.type === 'wheels') {
    if (speed <= 0.1) return;
    // Wheels spin at ω = v / r so the tire's tangential surface
    // speed matches the chassis's linear speed.
    if (mesh.wheels.length > 0) {
      const wheelR = Math.max(1, mesh.wheels[0].scale.x);
      const rotDelta = (speed / wheelR) * dt;
      for (const w of mesh.wheels) w.rotation.y += rotDelta;
    }
    return;
  }

  if (mesh.type === 'treads') {
    if (speed <= 0.1) return;
    // Wheels spin at ω = v / r so their surface speed matches the unit's
    // linear speed.
    if (mesh.wheels.length > 0) {
      const wheelR = Math.max(1, mesh.wheels[0].scale.x);
      const rotDelta = (speed / wheelR) * dt;
      for (const w of mesh.wheels) w.rotation.y += rotDelta;
    }
    // Cleats scroll along the slab length at the same linear speed. We
    // advance a phase counter in world units and lay out cleats modulo
    // spacing so they look continuous regardless of cumulative distance.
    if (mesh.cleats.length > 0 && mesh.cleatSpacing > 0) {
      mesh.treadPhase += speed * dt;
      const spacing = mesh.cleatSpacing;
      const phaseOff = ((mesh.treadPhase % spacing) + spacing) % spacing;
      const L = mesh.slabLength;
      const cleatsPerSide = mesh.cleats.length / 2;
      for (let s = 0; s < 2; s++) {
        const baseIdx = s * cleatsPerSide;
        for (let i = 0; i < cleatsPerSide; i++) {
          let posX = -L / 2 + phaseOff + i * spacing;
          // Wrap into [-L/2, L/2]. At most one wrap either way is needed
          // since phaseOff ∈ [0, spacing) and i ∈ [0, cleatsPerSide-1].
          if (posX > L / 2) posX -= L;
          else if (posX < -L / 2) posX += L;
          mesh.cleats[baseIdx + i].position.x = posX;
        }
      }
    }
    return;
  }

  if (mesh.type === 'legs') {
    // Per-leg shell alpha — pushed into the LegInstancedRenderer's
    // per-instance buffers so a half-built unit's legs / joints render
    // at SHELL_OPACITY along with the chassis / turrets / barrels.
    const isShell = !!(entity.buildable && !entity.buildable.isComplete && !entity.buildable.isGhost);
    const legAlpha = isShell ? SHELL_OPACITY : NORMAL_OPACITY;
    for (const leg of mesh.legs) {
      if (leg.upperSlot >= 0) legRenderer.setUpperAlpha(leg.upperSlot, legAlpha);
      if (leg.lowerSlot >= 0) legRenderer.setLowerAlpha(leg.lowerSlot, legAlpha);
      if (leg.hipJointSlot >= 0) legRenderer.setJointAlpha(leg.hipJointSlot, legAlpha);
      if (leg.kneeJointSlot >= 0) legRenderer.setJointAlpha(leg.kneeJointSlot, legAlpha);
      if (leg.footJointSlot >= 0) legRenderer.setJointAlpha(leg.footJointSlot, legAlpha);
    }

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
    // Chassis-UP direction in three.js world coords — the surface
    // normal at the unit's footprint, mapped from sim (sim z up) to
    // three (sim z → three y). Sampled once per unit per frame and
    // shared across every leg's IK so all legs bend their knees
    // along the same chassis-relative "up", regardless of slope.
    // On flat ground this collapses to (0, 1, 0) = world up.
    const sn = entity.unit?.surfaceNormal ?? getSurfaceNormal(
      entity.transform.x, entity.transform.y,
      mapWidth, mapHeight, LAND_CELL_SIZE,
    );
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
        // so by the time the lerp completes, the body has caught
        // up and the foot is at chassis-local rest. Direction-
        // agnostic: works the same for forward thrust, backward
        // push, sideways slide, etc.
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
        const groundY = getSurfaceHeight(tWorldX, tWorldZ, mapWidth, mapHeight, LAND_CELL_SIZE);

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

      // Write the leg's two cylinder slots into the shared
      // instanced renderer's per-instance buffers. After this loop
      // (across every unit's every leg), the scene calls
      // legRenderer.flush() once and the GPU draws every leg
      // cylinder in two draw calls total.
      if (mesh.legLod === 'simple') {
        // 'simple' = single cylinder hip → foot, no knee bend.
        legRenderer.updateUpper(
          leg.upperSlot,
          hipWorldX, hipWorldY, hipWorldZ,
          footX, footY, footZ,
          leg.upperThick,
        );
        // No lower slot allocated; nothing to do.
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
        );
        legRenderer.updateLower(
          leg.lowerSlot,
          knee.x, knee.y, knee.z,
          footX, footY, footZ,
          leg.lowerThick,
        );
        if (leg.hipJointSlot >= 0)  legRenderer.updateJoint(leg.hipJointSlot,  hipWorldX, hipWorldY, hipWorldZ, leg.hipJointRadius);
        if (leg.kneeJointSlot >= 0) legRenderer.updateJoint(leg.kneeJointSlot, knee.x, knee.y, knee.z, leg.kneeJointRadius);
        if (leg.footJointSlot >= 0) legRenderer.updateJoint(leg.footJointSlot, footX, footY, footZ, leg.footJointRadius);
      }
    }
  }
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

// setCylinderBetween was the per-mesh transform path for legs —
// it's gone; legs now write into the LegInstancedRenderer's
// per-instance attribute buffers and the GPU shader does the
// equivalent transform from instStart, instEnd, instThickness.

export function destroyLocomotion(
  mesh: Locomotion3DMesh,
  legRenderer: LegInstancedRenderer,
): void {
  if (!mesh) return;
  // Free every leg slot (cylinder + joint) back into the shared
  // pools so other units can reuse them. The slots are zero-scaled
  // by free() and pushed onto the pool's free-list.
  if (mesh.type === 'legs') {
    for (const leg of mesh.legs) {
      legRenderer.freeUpper(leg.upperSlot);
      legRenderer.freeLower(leg.lowerSlot);
      legRenderer.freeJoint(leg.hipJointSlot);
      legRenderer.freeJoint(leg.kneeJointSlot);
      legRenderer.freeJoint(leg.footJointSlot);
    }
  }
  mesh.group.parent?.remove(mesh.group);
}
