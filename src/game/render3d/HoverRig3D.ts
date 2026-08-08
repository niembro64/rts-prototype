// HoverRig3D — ducted fan ring + downward smoke columns for hover
// locomotion. Hover never contacts ground, so the visuals contract
// (see "Locomotion Visuals Are Frontend" in budget_design_philosophy.html)
// inverts: the rig tracks per-frame `clearance` (chassis world Y −
// terrain Y) instead of a contact boolean, and the floor clamp is a
// soft safety — the rendered rig group is lifted at minimum
// HOVER_FLOOR_MARGIN above terrain so a stale snapshot can never park
// fans inside the dirt.

import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import {
  getSmokeProfile,
  type HoverSmokeUseId,
  type ResolvedSmokeProfile,
} from '@/smokeConfig';
import type { HoverConfig } from '@/types/blueprints';
import type { Entity, PlayerId } from '../sim/types';
import type {
  AirborneEmitterBatch3D,
  AirborneEmitterParentPose3D,
} from './AirborneEmitterBatch3D';
import type { LocomotionBase } from './LocomotionRigShared3D';
import { getLocomotionSurfaceHeight } from './LocomotionTerrainSampler';
import type { SmokePuffEmitter } from './SmokeTrail3D';
import { locomotionPieceColorHex } from './colorUtils';
import { getLocomotionMatByCache } from './RenderUtils';
import {
  createPrimitiveSphereGeometry,
  createPrimitiveTorusGeometry,
  getOrCreate,
  getSharedPrimitiveTetrahedronGeometry,
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';

/** Minimum world-Y gap the rendered fan ring is allowed to have above
 *  terrain. The sim is supposed to keep hovers above ground via the
 *  configured surface lift force, but a bad snapshot or a 1-tick
 *  interpolation glitch can briefly drop the rendered chassis below.
 *  The rig group lifts itself by enough to keep fans visible above
 *  the surface in that case. */
const HOVER_FLOOR_MARGIN = 1;
/** Presentation-only air gap between the top of the chassis and the lowest
 * point of an overhead hover fan. Authored mount offsets remain unchanged:
 * they still describe the locomotion layout used by the unit blueprint. */
const HOVER_FAN_BODY_GAP_RADIUS_FRAC = 0.04;
const HOVER_FAN_BODY_GAP_MIN = 0.5;

const FAN_RING_COLOR = COLORS.units.locomotion.hover.fanRing.colorHex;
const FAN_BLADE_COLOR = COLORS.units.locomotion.hover.fanBlade.colorHex;
const FAN_HUB_COLOR = COLORS.units.locomotion.hover.fanHub.colorHex;
const HOVER_SMOKE_COLOR = COLORS.units.locomotion.hover.smoke.colorHex;
const FAN_BLADE_PITCH_DEG = 24;
const FAN_BLADE_COUNT = 3;

const ringGeomByTubeRatio = new Map<string, THREE.BufferGeometry>();
const bladeRotorGeoms = new Map<string, THREE.BufferGeometry>();
const hubGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();

function getHubGeom(tier: PrimitiveGeometryTier): THREE.BufferGeometry {
  return getOrCreate(hubGeomByTier, tier, () => tier === 'far'
    ? getSharedPrimitiveTetrahedronGeometry()
    : createPrimitiveSphereGeometry('locomotion', tier));
}
const ringMats = new Map<number, THREE.MeshLambertMaterial>();
const hubMats = new Map<number, THREE.MeshLambertMaterial>();
/** Rotor blades keep their spin in a vertex injection rather than a bespoke
 *  ShaderMaterial, so they can be Lambert like every other locomotion piece.
 *  The time uniform is retained per material because a Lambert material has no
 *  `.uniforms` of its own to write through. */
type RotorBladeMaterial = {
  material: THREE.MeshLambertMaterial;
  timeUniform: { value: number };
};
const bladeRotorMats = new Map<string, RotorBladeMaterial>();

// The normal chunk runs first and computes the rotation, which the position
// chunk below reuses. Rotating the normal is what makes a spinning blade catch
// the light as it turns instead of looking like a flat disc.
const ROTOR_DECL = 'uniform float uTimeSec;\nuniform float uSpinRadPerSec;';
const ROTOR_BEGIN_NORMAL = `
float _rotA = -uTimeSec * uSpinRadPerSec;
float _rotC = cos(_rotA);
float _rotS = sin(_rotA);
vec3 objectNormal = vec3(
  _rotC * normal.x + _rotS * normal.z,
  normal.y,
  -_rotS * normal.x + _rotC * normal.z
);
`;
const ROTOR_BEGIN_VERTEX = `
vec3 transformed = vec3(
  _rotC * position.x + _rotS * position.z,
  position.y,
  -_rotS * position.x + _rotC * position.z
);
`;
const LOCAL_EXHAUST_DIR = new THREE.Vector3(0, -1, 0);
const _fanWorldPos = new THREE.Vector3();
const _fanWorldQuat = new THREE.Quaternion();
const _fanWorldDir = new THREE.Vector3();
const REARWARD_EXHAUST_DIR = new THREE.Vector3(-1, 0, 0);

function getRingGeom(tubeRatio: number, tier: PrimitiveGeometryTier): THREE.BufferGeometry {
  const ratioKey = Math.round(THREE.MathUtils.clamp(tubeRatio, 0.05, 0.2) * 1000) / 1000;
  const key = `${tier}:${ratioKey}`;
  // Low uses the same volume-bearing square-tube torus as the other rungs;
  // the previous flat annulus collapsed fan thickness to zero.
  return getOrCreate(ringGeomByTubeRatio, key, () =>
    createPrimitiveTorusGeometry('locomotion', tier, 1, ratioKey));
}

function rotorGeomKey(
  bladeLength: number,
  bladeThickness: number,
  bladeChord: number,
  bladeRootRadius: number,
  bladePitchRad: number,
): string {
  return [
    bladeLength,
    bladeThickness,
    bladeChord,
    bladeRootRadius,
    bladePitchRad,
  ].map((value) => value.toFixed(3)).join(':');
}

function pushRotorBladeBox(
  positions: number[],
  centerX: number,
  length: number,
  thickness: number,
  chord: number,
  pitchRad: number,
  yawRad: number,
): void {
  const hx = length * 0.5;
  const hy = thickness * 0.5;
  const hz = chord * 0.5;
  const cp = Math.cos(pitchRad);
  const sp = Math.sin(pitchRad);
  const cy = Math.cos(yawRad);
  const sy = Math.sin(yawRad);
  const corners = [
    [-hx, -hy, -hz],
    [hx, -hy, -hz],
    [hx, hy, -hz],
    [-hx, hy, -hz],
    [-hx, -hy, hz],
    [hx, -hy, hz],
    [hx, hy, hz],
    [-hx, hy, hz],
  ] as const;
  const transformed: number[] = [];
  for (const corner of corners) {
    const px = corner[0] + centerX;
    const py = corner[1] * cp - corner[2] * sp;
    const pz = corner[1] * sp + corner[2] * cp;
    transformed.push(
      px * cy + pz * sy,
      py,
      -px * sy + pz * cy,
    );
  }
  const faces = [
    [0, 2, 1], [0, 3, 2],
    [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4],
    [3, 6, 2], [3, 7, 6],
    [1, 2, 6], [1, 6, 5],
    [0, 4, 7], [0, 7, 3],
  ] as const;
  for (const face of faces) {
    for (const idx of face) {
      const base = idx * 3;
      positions.push(transformed[base], transformed[base + 1], transformed[base + 2]);
    }
  }
}

function pushRotorBladeSurface(
  positions: number[],
  bladeRootRadius: number,
  length: number,
  chord: number,
  pitchRad: number,
  yawRad: number,
  low: boolean,
): void {
  const halfChord = chord * 0.5;
  const tip = bladeRootRadius + length;
  const points = low
    ? [
      [bladeRootRadius, 0, -halfChord],
      [tip, 0, 0],
      [bladeRootRadius, 0, halfChord],
    ]
    : [
      [bladeRootRadius, 0, -halfChord],
      [tip, 0, -halfChord * 0.42],
      [tip, 0, halfChord * 0.42],
      [bladeRootRadius, 0, halfChord],
    ];
  const cp = Math.cos(pitchRad);
  const sp = Math.sin(pitchRad);
  const cy = Math.cos(yawRad);
  const sy = Math.sin(yawRad);
  const transformed: number[] = [];
  for (const point of points) {
    const py = point[1] * cp - point[2] * sp;
    const pz = point[1] * sp + point[2] * cp;
    transformed.push(
      point[0] * cy + pz * sy,
      py,
      -point[0] * sy + pz * cy,
    );
  }
  const faces = low ? [0, 1, 2] : [0, 1, 2, 0, 2, 3];
  for (const index of faces) {
    const offset = index * 3;
    positions.push(
      transformed[offset],
      transformed[offset + 1],
      transformed[offset + 2],
    );
  }
}

function getBladeRotorGeom(
  bladeLength: number,
  bladeThickness: number,
  bladeChord: number,
  bladeRootRadius: number,
  bladePitchRad: number,
  tier: PrimitiveGeometryTier,
): THREE.BufferGeometry {
  const key = `${tier}:` + rotorGeomKey(
    bladeLength,
    bladeThickness,
    bladeChord,
    bladeRootRadius,
    bladePitchRad,
  );
  let geom = bladeRotorGeoms.get(key);
  if (!geom) {
    const positions: number[] = [];
    const bladeCenterX = bladeRootRadius + bladeLength * 0.5;
    for (let i = 0; i < FAN_BLADE_COUNT; i++) {
      const yaw = (i * Math.PI * 2) / FAN_BLADE_COUNT;
      if (tier === 'close') {
        pushRotorBladeBox(
          positions,
          bladeCenterX,
          bladeLength,
          bladeThickness,
          bladeChord,
          bladePitchRad,
          yaw,
        );
      } else {
        pushRotorBladeSurface(
          positions,
          bladeRootRadius,
          bladeLength,
          bladeChord,
          bladePitchRad,
          yaw,
          tier === 'far',
        );
      }
    }
    geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.computeBoundingSphere();
    bladeRotorGeoms.set(key, geom);
  }
  return geom;
}

function getRotorBladeMat(
  baseColor: number,
  ownerId: PlayerId | undefined,
  spinRadPerSec: number,
): THREE.MeshLambertMaterial {
  const color = locomotionPieceColorHex(baseColor, ownerId);
  const speedKey = Math.round(spinRadPerSec * 1000) / 1000;
  const key = `${color}:${speedKey}`;
  const existing = bladeRotorMats.get(key);
  if (existing !== undefined) return existing.material;

  const timeUniform = { value: 0 };
  const spinUniform = { value: spinRadPerSec };
  const material = new THREE.MeshLambertMaterial({
    color,
    side: THREE.DoubleSide,
  });
  material.onBeforeCompile = (shader) => {
    // Assigned by reference, so setHoverFanAnimationTime keeps working without
    // reaching into a material that no longer owns its uniforms.
    shader.uniforms.uTimeSec = timeUniform;
    shader.uniforms.uSpinRadPerSec = spinUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `${ROTOR_DECL}\n#include <common>`)
      .replace('#include <beginnormal_vertex>', ROTOR_BEGIN_NORMAL)
      .replace('#include <begin_vertex>', ROTOR_BEGIN_VERTEX);
  };
  material.customProgramCacheKey = () => 'hoverRotorBladeLambert';
  bladeRotorMats.set(key, { material, timeUniform });
  return material;
}

export function setHoverFanAnimationTime(timeSec: number): void {
  for (const entry of bladeRotorMats.values()) {
    entry.timeUniform.value = timeSec;
  }
}

export type HoverFan = {
  group: THREE.Group;
  emitter: THREE.Object3D;
  smoke: SmokePuffEmitter;
  exhaustSpeed: number;
};

/** Shared rear-facing duct geometry for watercraft and hovercraft. The fan
 *  is visual only: locomotion physics never depends on it.
 *
 *  Mirrors the blueprint's `SwimRearFan` — an authored mount plus the duct's
 *  own dimensions — rather than the flat `rearFan*`-prefixed scalars it used
 *  to take, so the one rig that mounts it speaks the same {x, y, z} every
 *  other locomotion piece does. */
export type RearPropulsionFanConfig = {
  offset: { xUnitRadiusRatio: number; yUnitRadiusRatio: number; zUnitRadiusRatio: number };
  radius: number;
  ringTubeRadius: number;
  spinRadPerSec: number;
};

export type HoverMesh = {
  type: 'hover';
  group: THREE.Group;
  fans: HoverFan[];
  /** Chassis-local presentation height for the fan-array root. Terrain
   * safety may add to this value, but must never replace it. */
  visualBaseY: number;
  /** Most recent world-Y gap between the chassis and terrain below
   *  it. Updated every frame in updateHoverFans. Useful to other
   *  client systems (smoke length, dust kick-up, altitude shading)
   *  that key off the hover gap rather than absolute altitude. */
  clearance: number;
  fanSpinRadPerSec: number;
} & LocomotionBase;

type FanSpec = {
  localX: number;
  localY?: number;
  localZ: number;
  fanRadius: number;
  ringTubeRadius: number;
  outwardAngleRad: number;
  fanSpinRadPerSec: number;
  exhaustDirection?: THREE.Vector3;
  smokeProfile: ResolvedSmokeProfile;
};

/**
 * Resolve a render-only root height that seats every hover duct completely
 * above the visible chassis. The blueprint mount's planar position and tilt
 * are retained, including its logical z offset; one common visual translation
 * moves the array without changing locomotion data or authoritative physics.
 */
export function getHoverFanVisualRootY(
  bodyTopY: number,
  unitRadius: number,
  cfg: HoverConfig,
): number {
  const gapY = Math.max(HOVER_FAN_BODY_GAP_MIN, unitRadius * HOVER_FAN_BODY_GAP_RADIUS_FRAC);
  let rootY = bodyTopY + gapY;

  for (const mount of cfg.mounts) {
    const fanRadius = Math.max(1, unitRadius * mount.radiusFrac);
    const ringTubeRadius = Math.max(0.35, unitRadius * mount.ringTubeRadiusFrac);
    const outwardAngleRad = THREE.MathUtils.degToRad(
      Math.max(0, Math.min(35, mount.outwardAngleDeg)),
    );
    // A tilted duct's lowest point is its major-radius drop plus the
    // orientation-independent radius of its circular tube. Include the hub
    // sphere as well so a nearly-flat, small-duct configuration still clears.
    const verticalHalfExtent = Math.max(
      fanRadius * Math.sin(outwardAngleRad) + ringTubeRadius,
      fanRadius * 0.22,
    );
    const authoredLocalY = unitRadius * mount.offset.zUnitRadiusRatio;
    rootY = Math.max(
      rootY,
      bodyTopY + gapY + verticalHalfExtent - authoredLocalY,
    );
  }

  return rootY;
}

function buildFan(
  parent: THREE.Group,
  spec: FanSpec,
  entityId: number,
  fanIndex: number,
  ownerId: PlayerId | undefined,
  geometryTier: PrimitiveGeometryTier = 'close',
): HoverFan {
  const {
    localX, localY, localZ, fanRadius, ringTubeRadius, outwardAngleRad,
    fanSpinRadPerSec,
    exhaustDirection,
    smokeProfile,
  } = spec;
  const exhaustSpeed = smokeProfile.exhaustSpeed;
  const emitFramesSkip = Math.max(0, smokeProfile.emitFramesSkip);
  const ringTubeRatio = ringTubeRadius / fanRadius;
  const fanY = -Math.max(0.4, ringTubeRadius * 0.9);

  const fanGroup = new THREE.Group();
  fanGroup.position.set(localX, localY ?? fanY, localZ);

  if (exhaustDirection !== undefined && exhaustDirection.lengthSq() > 1e-6) {
    fanGroup.quaternion.setFromUnitVectors(
      LOCAL_EXHAUST_DIR,
      exhaustDirection.clone().normalize(),
    );
  } else {
    const outward = new THREE.Vector3(localX, 0, localZ);
    if (outward.lengthSq() > 1e-6 && outwardAngleRad > 0) {
      outward.normalize();
      const exhaustDir = outward
        .multiplyScalar(Math.sin(outwardAngleRad))
        .addScaledVector(new THREE.Vector3(0, -1, 0), Math.cos(outwardAngleRad))
        .normalize();
      fanGroup.quaternion.setFromUnitVectors(LOCAL_EXHAUST_DIR, exhaustDir);
    }
  }

  const ringMaterial = getLocomotionMatByCache(ringMats, FAN_RING_COLOR, ownerId);
  // Medium keeps a reduced-segment 3D duct; Low uses a single annular
  // surface. Double-sided rendering keeps that low ring visible from
  // above and below, including arbitrarily oriented Albatros fans.
  ringMaterial.side = THREE.DoubleSide;
  const ring = new THREE.Mesh(
    getRingGeom(ringTubeRatio, geometryTier),
    ringMaterial,
  );
  ring.rotation.x = Math.PI / 2;
  ring.scale.setScalar(fanRadius);
  fanGroup.add(ring);

  const hubRadius = fanRadius * 0.22;
  const bladeRootRadius = hubRadius * 0.9;
  const bladeTipRadius = fanRadius * 0.82;
  const bladeLength = Math.max(0.2, bladeTipRadius - bladeRootRadius);
  const bladeChord = Math.max(0.55, bladeLength * 0.42);
  const bladeThickness = Math.max(0.14, ringTubeRadius * 0.32);
  const bladePitchRad = THREE.MathUtils.degToRad(FAN_BLADE_PITCH_DEG);
  const rotor = new THREE.Mesh(
    getBladeRotorGeom(
      bladeLength,
      bladeThickness,
      bladeChord,
      bladeRootRadius,
      bladePitchRad,
      geometryTier,
    ),
    getRotorBladeMat(FAN_BLADE_COLOR, ownerId, fanSpinRadPerSec),
  );
  fanGroup.add(rotor);

  const hub = new THREE.Mesh(
    getHubGeom(geometryTier),
    getLocomotionMatByCache(hubMats, FAN_HUB_COLOR, ownerId),
  );
  hub.scale.setScalar(hubRadius);
  fanGroup.add(hub);

  const emitter = new THREE.Object3D();
  emitter.position.set(0, -Math.max(0.35, ringTubeRadius * 0.9), 0);
  fanGroup.add(emitter);

  parent.add(fanGroup);
  return {
    group: fanGroup,
    emitter,
    exhaustSpeed,
    smoke: {
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: -exhaustSpeed,
      useId: smokeProfile.useId,
      maxPoolSize: smokeProfile.maxPoolSize,
      capPolicy: smokeProfile.capPolicy,
      emitFramesSkip,
      fadeInMs: smokeProfile.fadeInMs,
      fadeOutMs: smokeProfile.fadeOutMs,
      startRadius: smokeProfile.startRadius,
      endRadiusMultiplier: smokeProfile.endRadiusMultiplier,
      maxAlpha: smokeProfile.maxAlpha,
      color: HOVER_SMOKE_COLOR,
      phase: entityId * 4 + fanIndex,
    },
  };
}

/** Builds the same ducted-fan assembly used by hover locomotion, but points
 * its exhaust along the chassis' rearward axis for a propeller-like drive. */
export function buildRearPropulsionFan(
  parent: THREE.Group,
  unitRadius: number,
  cfg: RearPropulsionFanConfig,
  entityId: number,
  ownerId: PlayerId | undefined,
  geometryTier: PrimitiveGeometryTier = 'close',
): HoverFan {
  return buildFan(
    parent,
    {
      localX: unitRadius * cfg.offset.xUnitRadiusRatio,
      localY: unitRadius * cfg.offset.zUnitRadiusRatio,
      localZ: unitRadius * cfg.offset.yUnitRadiusRatio,
      fanRadius: Math.max(1, unitRadius * cfg.radius),
      ringTubeRadius: Math.max(0.35, unitRadius * cfg.ringTubeRadius),
      outwardAngleRad: 0,
      fanSpinRadPerSec: cfg.spinRadPerSec,
      exhaustDirection: REARWARD_EXHAUST_DIR,
      smokeProfile: getSmokeProfile('locomotionHovercraft'),
    },
    entityId,
    0,
    ownerId,
    geometryTier,
  );
}

/** Appends one world-space plume emitter for a reusable fan assembly. */
export function appendHoverFanSmoke(
  fan: HoverFan,
  smokeOut: SmokePuffEmitter[],
): void {
  fan.emitter.getWorldPosition(_fanWorldPos);
  fan.group.getWorldQuaternion(_fanWorldQuat);
  _fanWorldDir.copy(LOCAL_EXHAUST_DIR).applyQuaternion(_fanWorldQuat).normalize();

  fan.smoke.x = _fanWorldPos.x;
  fan.smoke.y = _fanWorldPos.z;
  fan.smoke.z = _fanWorldPos.y;
  fan.smoke.vx = _fanWorldDir.x * fan.exhaustSpeed;
  fan.smoke.vy = _fanWorldDir.z * fan.exhaustSpeed;
  fan.smoke.vz = _fanWorldDir.y * fan.exhaustSpeed;
  smokeOut.push(fan.smoke);
}

export function buildHoverFans(
  unitGroup: THREE.Group,
  unitRadius: number,
  cfg: HoverConfig,
  smokeUseId: HoverSmokeUseId,
  entityId: number,
  ownerId: PlayerId | undefined,
  geometryTier: PrimitiveGeometryTier = 'close',
): HoverMesh {
  const group = new THREE.Group();
  const fanSpinRadPerSec = cfg.fanSpinRadPerSec;
  const fans: HoverFan[] = [];
  const smokeProfile = getSmokeProfile(smokeUseId);

  // ONE AUTHORED MOUNT PER FAN. This used to be four layout branches — twin,
  // quad, triFront, and a dragonfly special case with its own tail fan — each
  // deriving positions from a (fanDistX, fanDistY) pair. A layout enum can
  // only ever name arrangements someone already thought of, and every new one
  // meant another branch here; a list of mounts names all of them, needs no
  // branch, and lets one fan differ from its neighbours in size or tilt.
  for (const mount of cfg.mounts) {
    fans.push(buildFan(
      group,
      {
        localX: unitRadius * mount.offset.xUnitRadiusRatio,
        localY: unitRadius * mount.offset.zUnitRadiusRatio,
        localZ: unitRadius * mount.offset.yUnitRadiusRatio,
        fanRadius: Math.max(1, unitRadius * mount.radiusFrac),
        ringTubeRadius: Math.max(0.35, unitRadius * mount.ringTubeRadiusFrac),
        outwardAngleRad: THREE.MathUtils.degToRad(
          Math.max(0, Math.min(35, mount.outwardAngleDeg)),
        ),
        fanSpinRadPerSec,
        smokeProfile,
      },
      entityId,
      fans.length,
      ownerId,
      geometryTier,
    ));
  }

  unitGroup.add(group);
  return {
    type: 'hover',
    group,
    fans,
    visualBaseY: 0,
    clearance: 0,
    fanSpinRadPerSec,
    geometryKey: '',
  };
}

export function updateHoverFans(
  mesh: HoverMesh,
  entity: Entity,
  _dtMs: number,
  mapWidth: number,
  mapHeight: number,
  smokeOut?: SmokePuffEmitter[],
  emitterBatch?: AirborneEmitterBatch3D,
  parentPose?: AirborneEmitterParentPose3D,
): boolean {
  // Per-frame clearance + soft floor safety. The chassis world Y is
  // sim altitude (entity.transform.z); the rendered rig group is a
  // child of the unitGroup, so local-Y adjustments shift it relative
  // to that chassis. Preserve the overhead presentation height, then
  // add whatever emergency correction is needed when the authoritative
  // chassis itself falls inside HOVER_FLOOR_MARGIN. On the common case
  // (chassis floating cleanly above ground) the correction is zero.
  const chassisWorldY = entity.transform.z;
  const groundY = getLocomotionSurfaceHeight(
    entity.transform.x, entity.transform.y, mapWidth, mapHeight, entity.id,
  );
  const rawClearance = chassisWorldY - groundY;
  const floorDeficit = HOVER_FLOOR_MARGIN - rawClearance;
  const groupY = mesh.visualBaseY + (floorDeficit > 0 ? floorDeficit : 0);
  if (mesh.group.position.y !== groupY) mesh.group.position.y = groupY;
  mesh.clearance = Math.max(rawClearance, HOVER_FLOOR_MARGIN);

  if (!smokeOut) return false;

  for (let i = 0; i < mesh.fans.length; i++) {
    const fan = mesh.fans[i];
    if (emitterBatch && parentPose) {
      emitterBatch.enqueue(
        parentPose,
        mesh.group.position.x,
        groupY,
        mesh.group.position.z,
        fan.group.position.x,
        fan.group.position.y,
        fan.group.position.z,
        fan.group.quaternion.x,
        fan.group.quaternion.y,
        fan.group.quaternion.z,
        fan.group.quaternion.w,
        fan.emitter.position.x,
        fan.emitter.position.y,
        fan.emitter.position.z,
        LOCAL_EXHAUST_DIR.x,
        LOCAL_EXHAUST_DIR.y,
        LOCAL_EXHAUST_DIR.z,
        fan.exhaustSpeed,
        fan.smoke,
      );
      continue;
    }

    appendHoverFanSmoke(fan, smokeOut);
  }
  return true;
}
