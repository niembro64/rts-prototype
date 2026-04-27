// Locomotion3D — 3D geometry + per-frame animation for each unit's legs,
// treads, or wheels.
//
// Legs port the 2D ArachnidLeg system (world-space foot planting, snap-lerp
// gait, IK knee bend) with the only simplification being that we keep feet
// on the ground plane (2-axis movement: XZ). Per-style attach offsets and
// snap parameters are cloned from 2D LocomotionManager so the 3D walk cycle
// matches the 2D look.

import * as THREE from 'three';
import type { Entity, PlayerId } from '../sim/types';
import { getUnitBlueprint } from '../sim/blueprints';
import type {
  TreadConfig,
  WheelConfig,
  LegConfig as BlueprintLegConfig,
  LegStyle,
} from '@/types/blueprints';
import type { GraphicsConfig, LegStyle as LegLod } from '@/types/graphics';
import type { ArachnidLegConfig } from '@/types/render';
import { getSegmentMidYAt } from '../math/BodyDimensions';
import { getLegsRadiusToggle } from '@/clientBarConfig';

/** Per-unit step-circle radius as a fraction of the unit's LONGEST
 *  leg (upperLegLength + lowerLegLength). One value shared by every
 *  leg on the unit. Bigger → longer stride / slower step cadence;
 *  smaller → shorter / faster. Stays well inside physical leg reach
 *  given the typical rest-distance multipliers (0.5–0.74) so the
 *  foot can fully reach the far edge of the circle without the leg
 *  over-extending. */
const STEP_CIRCLE_RADIUS_FRAC = 0.35;

/** When the foot exits the rest circle, the snap target sits at this
 *  fraction of the radius INSIDE the circle (along the opposite
 *  direction), not on the boundary. Provides hysteresis: after a
 *  snap the foot is 15% inside the boundary, so the body has to drag
 *  it through (1 + 0.85) = 1.85 radii before another snap fires —
 *  no immediate back-and-forth flicker if the body is jittering. */
const SNAP_TARGET_INSET = 0.85;

const TREAD_COLOR = 0x1a1d22;
const TREAD_HEIGHT = 10;
const TREAD_Y = TREAD_HEIGHT / 2;
const WHEEL_COLOR = 0x2a2f36;
const LEG_COLOR = 0x2a2f36;

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
       /** Container for all leg meshes — parented to the WORLD group (not
        *  the unit group) so world-space foot planting isn't disturbed by
        *  the unit's rotation. */
       group: THREE.Group;
       legs: LegInstance[];
       style: LegStyle;
       config: BlueprintLegConfig;
       legLod: LegLod;
       /** Per-UNIT rest-circle radius (chassis-local world units). Every
        *  leg on this unit shares the same circle size — it scales with
        *  the unit's longest leg so a Daddy gets a much larger stride
        *  budget than a Tick, but two legs of the same unit always
        *  agree on how far a foot can wander before snapping. */
       stepRadius: number;
    } & LocomotionBase)
  | undefined;

type LocomotionBase = {
  lodKey: string;
};

/** State for a single leg, matching the 2D ArachnidLeg fields. Foot position
 *  is tracked in world XZ coords; when the hip moves too far or the leg
 *  rotates past the snap angle, the foot lerps to a new snap position. */
type LegInstance = {
  config: ArachnidLegConfig;
  /** Knee bends outward: +1 for right side, -1 for left. */
  side: number;
  /** Hip Y in world coords (= mid-height of the body segment this leg
   *  attaches to). Baked per-leg when the leg set is built so composite
   *  units like the arachnid get tall rear legs + shorter front legs. */
  hipY: number;

  // World XZ foot position (2D "x, y" maps to 3D "x, z").
  groundX: number;
  groundZ: number;
  startGroundX: number;
  startGroundZ: number;
  targetGroundX: number;
  targetGroundZ: number;
  isSliding: boolean;
  lerpProgress: number;
  lerpDuration: number;
  initialized: boolean;

  // Meshes — all parented to the world-space group. Geometry is rebuilt
  // between hip/knee/foot each frame from the current state.
  upper: THREE.Mesh;
  lower?: THREE.Mesh;
  hipJoint?: THREE.Mesh;
  kneeJoint?: THREE.Mesh;
  footJoint?: THREE.Mesh;
  upperThick: number;
  lowerThick: number;
  /** LEGS-radius debug viz: a flat ring lying in the chassis-local
   *  XZ plane at the leg's rest center. Lazy-built the first time
   *  the toggle is on; hidden (not destroyed) when off. */
  restCircle?: THREE.LineLoop;
};

const treadBoxGeom = new THREE.BoxGeometry(1, 1, 1);
const wheelGeom = new THREE.CylinderGeometry(1, 1, 1, 12);
const legGeom = new THREE.CylinderGeometry(1, 1, 1, 8);
const jointGeom = new THREE.SphereGeometry(1, 8, 6);

// Unit circle (radius 1) in the XZ plane at y=0 — instanced per leg
// at runtime by translating to rest center and scaling by stepRadius.
const restCircleGeom = (() => {
  const segs = 48;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < segs; i++) {
    const t = (i / segs) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(t), 0, Math.sin(t)));
  }
  return new THREE.BufferGeometry().setFromPoints(pts);
})();
const restCircleMat = new THREE.LineBasicMaterial({
  color: 0x44ffcc,
  transparent: true,
  opacity: 0.55,
  depthWrite: false,
});

const treadMat = new THREE.MeshLambertMaterial({ color: TREAD_COLOR });
const wheelMat = new THREE.MeshLambertMaterial({ color: WHEEL_COLOR });
const legMat = new THREE.MeshLambertMaterial({ color: LEG_COLOR });
// Lighter gray for the animated cleats, mirroring the 2D drawAnimatedTread
// track-line color (`GRAY_LIGHT`) so the moving highlights read over the
// dark tread slab.
const cleatMat = new THREE.MeshLambertMaterial({ color: 0x5a636d });

export function lodKeyFor(gfx: GraphicsConfig): string {
  return `${gfx.legs}|${gfx.treadsAnimated ? 1 : 0}`;
}

/**
 * Per-style leg-config builder, cloned from LocomotionManager.getOrCreateLegs
 * in the 2D renderer. Returns left-side configs only; the caller mirrors
 * them for the right side with the same `attachOffsetY`/`snapTargetAngle`
 * sign flip that 2D uses.
 */
export function leftSideConfigsForStyle(style: LegStyle, radius: number): ArachnidLegConfig[] {
  if (style === 'daddy') {
    const legLength = radius * 10;
    const upperLen = legLength * 0.45;
    const lowerLen = upperLen * 1.2;
    return [
      { attachOffsetX:  radius * 0.3,  attachOffsetY: -radius * 0.2,  upperLegLength: upperLen,        lowerLegLength: lowerLen,        snapTriggerAngle: Math.PI * 0.46, snapTargetAngle: -Math.PI * 0.31, snapDistanceMultiplier: 0.74, extensionThreshold: 0.96 },
      { attachOffsetX:  radius * 0.1,  attachOffsetY: -radius * 0.25, upperLegLength: upperLen * 0.95, lowerLegLength: lowerLen * 0.95, snapTriggerAngle: Math.PI * 0.65, snapTargetAngle: -Math.PI * 0.39, snapDistanceMultiplier: 0.7,  extensionThreshold: 0.97 },
      { attachOffsetX: -radius * 0.1,  attachOffsetY: -radius * 0.4,  upperLegLength: upperLen * 0.95, lowerLegLength: lowerLen * 0.95, snapTriggerAngle: Math.PI * 0.89, snapTargetAngle: -Math.PI * 0.4,  snapDistanceMultiplier: 0.71, extensionThreshold: 0.98 },
      { attachOffsetX: -radius * 0.3,  attachOffsetY: -radius * 0.3,  upperLegLength: upperLen,        lowerLegLength: lowerLen,        snapTriggerAngle: Math.PI * 0.99, snapTargetAngle: -Math.PI * 0.58, snapDistanceMultiplier: 0.5,  extensionThreshold: 0.99 },
    ];
  }
  if (style === 'tarantula') {
    const legLength = radius * 1.9;
    const upperLen = legLength * 0.55;
    const lowerLen = upperLen * 1.2;
    return [
      { attachOffsetX:  radius * 0.3,  attachOffsetY: -radius * 0.2,  upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.46, snapTargetAngle: -Math.PI * 0.31, snapDistanceMultiplier: 0.74, extensionThreshold: 0.96 },
      { attachOffsetX:  radius * 0.1,  attachOffsetY: -radius * 0.2,  upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.65, snapTargetAngle: -Math.PI * 0.39, snapDistanceMultiplier: 0.7,  extensionThreshold: 0.97 },
      { attachOffsetX: -radius * 0.1,  attachOffsetY: -radius * 0.2,  upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.89, snapTargetAngle: -Math.PI * 0.4,  snapDistanceMultiplier: 0.71, extensionThreshold: 0.98 },
      { attachOffsetX: -radius * 0.3,  attachOffsetY: -radius * 0.2,  upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.99, snapTargetAngle: -Math.PI * 0.58, snapDistanceMultiplier: 0.5,  extensionThreshold: 0.99 },
    ];
  }
  if (style === 'tick') {
    const legLength = radius * 1.0;
    const upperLen = legLength * 0.5;
    const lowerLen = upperLen * 1.1;
    return [
      { attachOffsetX:  radius * 0.25, attachOffsetY: -radius * 0.15, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.46, snapTargetAngle: -Math.PI * 0.31, snapDistanceMultiplier: 0.74, extensionThreshold: 0.96 },
      { attachOffsetX:  radius * 0.08, attachOffsetY: -radius * 0.18, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.65, snapTargetAngle: -Math.PI * 0.39, snapDistanceMultiplier: 0.7,  extensionThreshold: 0.97 },
      { attachOffsetX: -radius * 0.08, attachOffsetY: -radius * 0.18, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.89, snapTargetAngle: -Math.PI * 0.4,  snapDistanceMultiplier: 0.71, extensionThreshold: 0.98 },
      { attachOffsetX: -radius * 0.25, attachOffsetY: -radius * 0.15, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.99, snapTargetAngle: -Math.PI * 0.58, snapDistanceMultiplier: 0.5,  extensionThreshold: 0.99 },
    ];
  }
  if (style === 'commander') {
    const legLength = radius * 2.2;
    const upperLen = legLength * 0.5;
    const lowerLen = upperLen * 1.2;
    return [
      { attachOffsetX:  radius * 0.4,  attachOffsetY: -radius * 0.5,  upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.46, snapTargetAngle: -Math.PI * 0.31, snapDistanceMultiplier: 0.74, extensionThreshold: 0.96 },
      { attachOffsetX: -radius * 0.4,  attachOffsetY: -radius * 0.5,  upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.99, snapTargetAngle: -Math.PI * 0.58, snapDistanceMultiplier: 0.5,  extensionThreshold: 0.99 },
    ];
  }
  // Default: widow (4 legs per side)
  const legLength = radius * 1.9;
  const upperLen = legLength * 0.55;
  const lowerLen = upperLen * 1.2;
  return [
    { attachOffsetX:  radius * 0.4,  attachOffsetY: -radius * 0.4,  upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.46, snapTargetAngle: -Math.PI * 0.31, snapDistanceMultiplier: 0.74, extensionThreshold: 0.96 },
    { attachOffsetX:  radius * 0.15, attachOffsetY: -radius * 0.45, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.65, snapTargetAngle: -Math.PI * 0.39, snapDistanceMultiplier: 0.7,  extensionThreshold: 0.97 },
    { attachOffsetX: -radius * 0.15, attachOffsetY: -radius * 0.45, upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.89, snapTargetAngle: -Math.PI * 0.4,  snapDistanceMultiplier: 0.71, extensionThreshold: 0.98 },
    { attachOffsetX: -radius * 0.4,  attachOffsetY: -radius * 0.4,  upperLegLength: upperLen, lowerLegLength: lowerLen, snapTriggerAngle: Math.PI * 0.99, snapTargetAngle: -Math.PI * 0.58, snapDistanceMultiplier: 0.5,  extensionThreshold: 0.99 },
  ];
}

export function buildLocomotion(
  unitGroup: THREE.Group,
  worldGroup: THREE.Group,
  entity: Entity,
  unitRadius: number,
  _pid: PlayerId | undefined,
  gfx: GraphicsConfig,
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
      const renderer = bp.renderer ?? 'arachnid';
      const mesh = buildLegs(worldGroup, entity, unitRadius, loc.style, loc.config, gfx.legs, renderer);
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
  style: LegStyle,
  cfg: BlueprintLegConfig,
  legLod: LegLod,
  renderer: string,
): Locomotion3DMesh {
  if (legLod === 'none') return undefined;

  const leftConfigs = leftSideConfigsForStyle(style, r);
  const lerpDuration = cfg.lerpDuration ?? 150;
  // Mirror left → right by flipping attachOffsetY and snapTargetAngle, same
  // way the 2D LocomotionManager builds the full leg set.
  const leftWithLerp: ArachnidLegConfig[] = leftConfigs.map((c) => ({ ...c, lerpDuration }));
  const rightWithLerp: ArachnidLegConfig[] = leftWithLerp.map((c) => ({
    ...c,
    attachOffsetY: -c.attachOffsetY,
    snapTargetAngle: -c.snapTargetAngle,
  }));
  const allConfigs = [...leftWithLerp, ...rightWithLerp];
  const sides = [
    ...leftWithLerp.map(() => -1),
    ...rightWithLerp.map(() => 1),
  ];

  const group = new THREE.Group();
  worldGroup.add(group);

  const legs: LegInstance[] = [];
  const upperThick = Math.max(cfg.upperThickness, 1) * 0.6;
  const lowerThick = Math.max(cfg.lowerThickness, 1) * 0.6;

  for (let i = 0; i < allConfigs.length; i++) {
    const legCfg = allConfigs[i];
    const side = sides[i];

    const upper = new THREE.Mesh(legGeom, legMat);
    group.add(upper);
    let lower: THREE.Mesh | undefined;
    let hipJoint: THREE.Mesh | undefined;
    let kneeJoint: THREE.Mesh | undefined;
    let footJoint: THREE.Mesh | undefined;

    // Two-segment legs whenever we're animating: 'animated' and 'full' both
    // get an upper + lower cylinder with the knee bending upward via IK.
    // This mirrors 2D, where medium LOD ('animated') already splits the leg
    // into hip→knee and knee→foot lines (just without joint circles).
    //
    // Joint spheres are reserved for 'full' LOD only, matching 2D where
    // hip/knee/foot dots only show at the highest tier.
    if (legLod === 'animated' || legLod === 'full') {
      lower = new THREE.Mesh(legGeom, legMat);
      group.add(lower);
    }
    if (legLod === 'full') {
      hipJoint = new THREE.Mesh(jointGeom, legMat);
      hipJoint.scale.setScalar(Math.max(1, cfg.hipRadius));
      kneeJoint = new THREE.Mesh(jointGeom, legMat);
      kneeJoint.scale.setScalar(Math.max(1, cfg.kneeRadius));
      footJoint = new THREE.Mesh(jointGeom, legMat);
      footJoint.scale.setScalar(Math.max(1, cfg.footRadius));
      group.add(hipJoint, kneeJoint, footJoint);
    }

    // Hip Y is the vertical mid-point of whichever body segment the
    // leg sits under. For composite bodies this picks the closest
    // segment by forward offset — so an arachnid's rear legs hook
    // into the tall abdomen while front legs hook into the shorter
    // prosoma.
    const hipY = getSegmentMidYAt(renderer, r, legCfg.attachOffsetX);

    legs.push({
      config: legCfg,
      side,
      hipY,
      groundX: 0,
      groundZ: 0,
      startGroundX: 0,
      startGroundZ: 0,
      targetGroundX: 0,
      targetGroundZ: 0,
      isSliding: false,
      lerpProgress: 0,
      lerpDuration,
      initialized: false,
      upper,
      lower,
      hipJoint,
      kneeJoint,
      footJoint,
      upperThick,
      lowerThick,
    });
  }

  // Seat each foot at its snap-target rest pose so legs don't flicker from
  // (0,0) on the first frame.
  const unitX = entity.transform.x;
  const unitY = entity.transform.y;
  const unitR = entity.transform.rotation;
  for (const leg of legs) initializeLegAt(leg, unitX, unitY, unitR);

  // Unit-level step-circle radius. Every leg on this unit shares the
  // same rest-circle size; we anchor it to the LONGEST leg so units
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
    style,
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

function initializeLegAt(leg: LegInstance, unitX: number, unitZ: number, unitR: number): void {
  const cos = Math.cos(unitR);
  const sin = Math.sin(unitR);
  const c = leg.config;
  const attachX = unitX + cos * c.attachOffsetX - sin * c.attachOffsetY;
  const attachZ = unitZ + sin * c.attachOffsetX + cos * c.attachOffsetY;
  const restDistance = totalLegLength(c) * c.snapDistanceMultiplier;
  // Right-side legs (side === 1) start halfway through their drift
  // cycle (between snap rest and snap trigger angles) so they step out
  // of phase with the left side once the unit moves — an alternating
  // walk gait from spawn rather than all legs cycling in unison.
  const initAngle = leg.side === 1
    ? (c.snapTargetAngle + c.snapTriggerAngle * Math.sign(c.snapTargetAngle)) / 2
    : c.snapTargetAngle;
  const angle = unitR + initAngle;
  const gx = attachX + Math.cos(angle) * restDistance;
  const gz = attachZ + Math.sin(angle) * restDistance;
  leg.groundX = gx;
  leg.groundZ = gz;
  leg.startGroundX = gx;
  leg.startGroundZ = gz;
  leg.targetGroundX = gx;
  leg.targetGroundZ = gz;
  leg.initialized = true;
}

/** 3D IK (law of cosines, lifted into 3D) — returns the knee world position
 *  for a leg given hip + foot and upper/lower segment lengths. The knee is
 *  placed in the VERTICAL plane that contains the hip→foot line, bending
 *  upward (toward +Y) instead of sideways in the ground plane. All the
 *  trigonometry (cos/sin of the law-of-cosines angle B) is unchanged — we
 *  just take the step perpendicular to the hip-foot direction along the
 *  in-plane "up" vector rather than a horizontal perpendicular. */
function kneeFromIK(
  hipX: number, hipY: number, hipZ: number,
  footX: number, footY: number, footZ: number,
  upperLen: number, lowerLen: number,
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
  // sin(B) positive → knee bends upward. (Same angle B as the 2D version;
  // only the axis it's swept around changes.)
  const sinB = Math.sqrt(Math.max(0, 1 - cosB * cosB));

  // Unit vector hip → foot
  const nx = dx / dist;
  const ny = dy / dist;
  const nz = dz / dist;

  // In-plane "up" = world up (0,1,0) with its component along `n` removed,
  // then normalized. This keeps the knee in the vertical plane containing
  // the leg, bending toward +Y. If the leg happens to be exactly vertical
  // (rare — hips sit above feet), fall back to world up.
  const dotUpN = ny;
  let ux = -dotUpN * nx;
  let uy = 1 - dotUpN * ny;
  let uz = -dotUpN * nz;
  const uLen = Math.hypot(ux, uy, uz);
  if (uLen > 1e-6) {
    ux /= uLen;
    uy /= uLen;
    uz /= uLen;
  } else {
    ux = 0; uy = 1; uz = 0;
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
    // Walk cycle in CHASSIS-LOCAL frame. Legs are children of
    // yawGroup so the world-space "feet plant while the unit moves"
    // gait of the original 2D port has been re-expressed as
    // "feet drag BACKWARD in unit-local frame as the unit moves
    // forward". The visual is identical (foot stays put against
    // the ground while the chassis moves over it) but the math now
    // lives in the same frame as the rest pose, the parent yaw +
    // tilt come from the scene graph, and there is one update path.
    //
    // Rotate the WORLD velocity into chassis-local frame so the
    // drag is applied along the unit's body axes:
    //   v_local_sim = R(-yaw) · v_world_sim
    // Then sim x → three.x, sim y → three.z (the existing handedness).
    const yaw = entity.transform.rotation;
    const cosYaw = Math.cos(yaw);
    const sinYaw = Math.sin(yaw);
    const vLocalForward = cosYaw * vx + sinYaw * vy;   // chassis +X
    const vLocalLateral = -sinYaw * vx + cosYaw * vy;  // chassis +Y in sim → three +Z

    // One rest-circle radius for the whole unit, baked at build time.
    const stepRadius = mesh.stepRadius;
    for (const leg of mesh.legs) {
      const c = leg.config;
      const tl = totalLegLength(c);
      const restDistance = tl * c.snapDistanceMultiplier;
      // Right-side legs straddle the rest direction by half the
      // step-radius angle so the gait alternates by side from frame 1.
      const initAngle = leg.side === 1
        ? (c.snapTargetAngle + c.snapTriggerAngle * Math.sign(c.snapTargetAngle)) / 2
        : c.snapTargetAngle;
      // Hip in chassis-local three.js coords. (sim x → three.x,
      // sim z (up) → three.y, sim y (lateral) → three.z.)
      const hipX = c.attachOffsetX;
      const hipY = leg.hipY;
      const hipZ = c.attachOffsetY;
      // The leg's REST CENTER — the chassis-local point the foot
      // wanders around. Defined entirely by hip + (rest distance,
      // rest angle); changing snapDistanceMultiplier moves the
      // circle in/out, snapTargetAngle rotates it around the hip.
      const restCenterX = hipX + Math.cos(initAngle) * restDistance;
      const restCenterZ = hipZ + Math.sin(initAngle) * restDistance;

      // LEGS-radius debug viz: ring sitting at the foot plane (FOOT_Y
      // in chassis-local coords) centered on the leg's rest center,
      // scaled to stepRadius. Lazy-creates on first show; persists in
      // the leg group so subsequent toggles are just a visibility flip.
      if (getLegsRadiusToggle()) {
        if (!leg.restCircle) {
          leg.restCircle = new THREE.LineLoop(restCircleGeom, restCircleMat);
          mesh.group.add(leg.restCircle);
        }
        leg.restCircle.visible = true;
        leg.restCircle.position.set(restCenterX, FOOT_Y, restCenterZ);
        leg.restCircle.scale.set(stepRadius, 1, stepRadius);
      } else if (leg.restCircle) {
        leg.restCircle.visible = false;
      }

      // First frame: seat the foot at the rest center so it starts
      // "in the middle" of its allowed wandering region.
      if (!leg.initialized) {
        leg.groundX = restCenterX;
        leg.groundZ = restCenterZ;
        leg.startGroundX = restCenterX;
        leg.startGroundZ = restCenterZ;
        leg.targetGroundX = restCenterX;
        leg.targetGroundZ = restCenterZ;
        leg.initialized = true;
      }

      // Either: lerp the foot toward its snap target (mid-step), or
      // drag the planted foot backward in chassis-local frame.
      if (leg.isSliding) {
        if (leg.lerpDuration <= 0) {
          leg.groundX = leg.targetGroundX;
          leg.groundZ = leg.targetGroundZ;
          leg.isSliding = false;
        } else {
          leg.lerpProgress += dtMs / leg.lerpDuration;
          if (leg.lerpProgress >= 1) {
            leg.lerpProgress = 1;
            leg.groundX = leg.targetGroundX;
            leg.groundZ = leg.targetGroundZ;
            leg.isSliding = false;
          } else {
            const t = easeOutCubic(leg.lerpProgress);
            leg.groundX = leg.startGroundX + (leg.targetGroundX - leg.startGroundX) * t;
            leg.groundZ = leg.startGroundZ + (leg.targetGroundZ - leg.startGroundZ) * t;
          }
        }
      } else {
        // Foot stays world-planted: in unit-local frame, drag opposite
        // the unit's local velocity.
        leg.groundX -= vLocalForward * dt;
        leg.groundZ -= vLocalLateral * dt;
      }

      // REST-CIRCLE TRIGGER. The foot is allowed to wander anywhere
      // inside a circle of radius `stepRadius` around the rest
      // center; once it crosses the boundary the foot snaps to the
      // diametrically opposite point on that circle's edge — that's
      // the next stride. The same single test handles both forward
      // overshoot (body moved past the foot) and rotational overshoot
      // (body yawed and the foot is now off to the side); both cases
      // produce a foot that exits the circle in the appropriate
      // direction and snaps to the natural opposite stride point.
      const dx = leg.groundX - restCenterX;
      const dz = leg.groundZ - restCenterZ;
      const distSq = dx * dx + dz * dz;

      if (!leg.isSliding && distSq > stepRadius * stepRadius) {
        const dist = Math.sqrt(distSq);
        // Unit vector pointing FROM rest center TO current foot.
        // Snap target sits 85% of the radius along the OPPOSITE
        // direction — strictly inside the circle, not on the edge.
        // The 15% inset gives hysteresis so a body that's jittering
        // can't immediately re-trigger a back-snap (the foot has to
        // traverse 1.85 R worth of drift before exiting again).
        const ux = dist > 1e-6 ? dx / dist : Math.cos(initAngle);
        const uz = dist > 1e-6 ? dz / dist : Math.sin(initAngle);
        const snapDist = stepRadius * SNAP_TARGET_INSET;
        leg.startGroundX = leg.groundX;
        leg.startGroundZ = leg.groundZ;
        leg.targetGroundX = restCenterX - ux * snapDist;
        leg.targetGroundZ = restCenterZ - uz * snapDist;
        leg.isSliding = true;
        leg.lerpProgress = 0;
      }

      // Clamp to physical reach so a fast snap can't visually
      // over-extend the segments past their hinge limit.
      const clampDx = leg.groundX - hipX;
      const clampDz = leg.groundZ - hipZ;
      const clampDistSq = clampDx * clampDx + clampDz * clampDz;
      if (clampDistSq > tl * tl) {
        const clampDist = Math.sqrt(clampDistSq);
        const scale = tl / clampDist;
        leg.groundX = hipX + clampDx * scale;
        leg.groundZ = hipZ + clampDz * scale;
      }

      const footX = leg.groundX;
      const footY = FOOT_Y;
      const footZ = leg.groundZ;
      if (mesh.legLod === 'simple') {
        setCylinderBetween(leg.upper, hipX, hipY, hipZ, footX, footY, footZ, leg.upperThick);
      } else {
        const knee = kneeFromIK(
          hipX, hipY, hipZ,
          footX, footY, footZ,
          c.upperLegLength, c.lowerLegLength,
        );
        setCylinderBetween(leg.upper, hipX, hipY, hipZ, knee.x, knee.y, knee.z, leg.upperThick);
        if (leg.lower) {
          setCylinderBetween(leg.lower, knee.x, knee.y, knee.z, footX, footY, footZ, leg.lowerThick);
        }
        if (leg.hipJoint)  leg.hipJoint.position.set(hipX, hipY, hipZ);
        if (leg.kneeJoint) leg.kneeJoint.position.set(knee.x, knee.y, knee.z);
        if (leg.footJoint) leg.footJoint.position.set(footX, footY, footZ);
      }
    }
  }
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();

function setCylinderBetween(
  mesh: THREE.Mesh,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  thickness: number,
): void {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.max(1e-3, Math.hypot(dx, dy, dz));
  mesh.scale.set(thickness, len, thickness);
  mesh.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  _dir.set(dx / len, dy / len, dz / len);
  mesh.quaternion.setFromUnitVectors(_up, _dir);
}

export function destroyLocomotion(mesh: Locomotion3DMesh): void {
  if (!mesh) return;
  mesh.group.parent?.remove(mesh.group);
}
