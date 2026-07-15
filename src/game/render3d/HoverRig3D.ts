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
import { ALBATROS_ICOSAHEDRON_VERTEX_DIRECTIONS } from './AlbatrosMesh3D';
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
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';

/** Minimum world-Y gap the rendered fan ring is allowed to have above
 *  terrain. The sim is supposed to keep hovers above ground via the
 *  configured surface lift force, but a bad snapshot or a 1-tick
 *  interpolation glitch can briefly drop the rendered chassis below.
 *  The rig group lifts itself by enough to keep fans visible above
 *  the surface in that case. */
const HOVER_FLOOR_MARGIN = 1;

const FAN_RING_COLOR = COLORS.units.locomotion.hover.fanRing.colorHex;
const FAN_BLADE_COLOR = COLORS.units.locomotion.hover.fanBlade.colorHex;
const FAN_HUB_COLOR = COLORS.units.locomotion.hover.fanHub.colorHex;
const HOVER_SMOKE_COLOR = COLORS.units.locomotion.hover.smoke.colorHex;
const DEFAULT_FAN_SPIN_RAD_PER_SEC = 42;
const DEFAULT_FAN_OUTWARD_ANGLE_DEG = 14;
const FAN_BLADE_PITCH_DEG = 24;
const FAN_BLADE_COUNT = 3;
const TRI_FRONT_FAN_ANGLES_RAD = [-Math.PI / 3, Math.PI / 3, Math.PI];
const ALBATROS_FAN_POSITION_RADIUS_FRAC = 0.86;

const ringGeomByTubeRatio = new Map<string, THREE.TorusGeometry>();
const bladeRotorGeoms = new Map<string, THREE.BufferGeometry>();
const hubGeomByTier = new Map<PrimitiveGeometryTier, THREE.SphereGeometry>();

function getHubGeom(tier: PrimitiveGeometryTier): THREE.SphereGeometry {
  let geom = hubGeomByTier.get(tier);
  if (!geom) {
    geom = createPrimitiveSphereGeometry('locomotion', tier);
    hubGeomByTier.set(tier, geom);
  }
  return geom;
}
const ringMats = new Map<number, THREE.MeshBasicMaterial>();
const hubMats = new Map<number, THREE.MeshBasicMaterial>();
const bladeRotorMats = new Map<string, THREE.ShaderMaterial>();
const LOCAL_EXHAUST_DIR = new THREE.Vector3(0, -1, 0);
const _fanWorldPos = new THREE.Vector3();
const _fanWorldQuat = new THREE.Quaternion();
const _fanWorldDir = new THREE.Vector3();

function getRingGeom(tubeRatio: number, tier: PrimitiveGeometryTier): THREE.TorusGeometry {
  const ratioKey = Math.round(THREE.MathUtils.clamp(tubeRatio, 0.05, 0.2) * 1000) / 1000;
  const key = `${tier}:${ratioKey}`;
  let geom = ringGeomByTubeRatio.get(key);
  if (!geom) {
    geom = createPrimitiveTorusGeometry('locomotion', tier, 1, ratioKey);
    ringGeomByTubeRatio.set(key, geom);
  }
  return geom;
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

function getBladeRotorGeom(
  bladeLength: number,
  bladeThickness: number,
  bladeChord: number,
  bladeRootRadius: number,
  bladePitchRad: number,
): THREE.BufferGeometry {
  const key = rotorGeomKey(
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
      pushRotorBladeBox(
        positions,
        bladeCenterX,
        bladeLength,
        bladeThickness,
        bladeChord,
        bladePitchRad,
        (i * Math.PI * 2) / FAN_BLADE_COUNT,
      );
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
): THREE.ShaderMaterial {
  const color = locomotionPieceColorHex(baseColor, ownerId);
  const speedKey = Math.round(spinRadPerSec * 1000) / 1000;
  const key = `${color}:${speedKey}`;
  let mat = bladeRotorMats.get(key);
  if (!mat) {
    mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uTimeSec: { value: 0 },
        uSpinRadPerSec: { value: spinRadPerSec },
      },
      vertexShader: `
        uniform float uTimeSec;
        uniform float uSpinRadPerSec;
        void main() {
          float a = -uTimeSec * uSpinRadPerSec;
          float c = cos(a);
          float s = sin(a);
          vec3 p = position;
          p = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        void main() {
          gl_FragColor = vec4(uColor, 1.0);
        }
      `,
      side: THREE.DoubleSide,
    });
    bladeRotorMats.set(key, mat);
  }
  return mat;
}

export function setHoverFanAnimationTime(timeSec: number): void {
  for (const mat of bladeRotorMats.values()) {
    mat.uniforms.uTimeSec.value = timeSec;
  }
}

type HoverFan = {
  group: THREE.Group;
  emitter: THREE.Object3D;
  smoke: SmokePuffEmitter;
  exhaustSpeed: number;
};

export type HoverMesh = {
  type: 'hover';
  group: THREE.Group;
  fans: HoverFan[];
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

  const ring = new THREE.Mesh(
    getRingGeom(ringTubeRatio, geometryTier),
    getLocomotionMatByCache(ringMats, FAN_RING_COLOR, ownerId),
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

export function buildAlbatrosHoverFans(
  unitGroup: THREE.Group,
  unitRadius: number,
  cfg: HoverConfig,
  smokeUseId: HoverSmokeUseId,
  entityId: number,
  ownerId: PlayerId | undefined,
  geometryTier: PrimitiveGeometryTier = 'close',
): HoverMesh {
  const group = new THREE.Group();
  const fanPositionRadius = cfg.fanPositionRadius ?? ALBATROS_FAN_POSITION_RADIUS_FRAC;
  const fanDistance = unitRadius * fanPositionRadius;
  const fanRadius = Math.max(1, unitRadius * cfg.fanRadius);
  const ringTubeRadius = Math.max(0.35, unitRadius * cfg.fanRingTubeRadius);
  const fanSpinRadPerSec = cfg.fanSpinRadPerSec ?? DEFAULT_FAN_SPIN_RAD_PER_SEC;
  const smokeProfile = getSmokeProfile(smokeUseId);
  const fans: HoverFan[] = [];

  for (const direction of ALBATROS_ICOSAHEDRON_VERTEX_DIRECTIONS) {
    fans.push(buildFan(
      group,
      {
        localX: direction.x * fanDistance,
        localY: direction.y * fanDistance,
        localZ: direction.z * fanDistance,
        fanRadius,
        ringTubeRadius,
        outwardAngleRad: 0,
        fanSpinRadPerSec,
        exhaustDirection: direction,
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
    clearance: 0,
    fanSpinRadPerSec,
    geometryKey: '',
  };
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
  const mainFanRadius = Math.max(1, unitRadius * cfg.fanRadius);
  const mainRingTubeRadius = Math.max(0.35, unitRadius * cfg.fanRingTubeRadius);
  const fanSpinRadPerSec = cfg.fanSpinRadPerSec ?? DEFAULT_FAN_SPIN_RAD_PER_SEC;
  const outwardAngleRad = THREE.MathUtils.degToRad(
    Math.max(0, Math.min(35, cfg.fanOutwardAngleDeg ?? DEFAULT_FAN_OUTWARD_ANGLE_DEG)),
  );
  const fans: HoverFan[] = [];
  const smokeProfile = getSmokeProfile(smokeUseId);

  const useDragonflyLayout = cfg.tailFanOffsetX !== undefined;
  const hasTailFan =
    useDragonflyLayout && cfg.tailFanRadius !== undefined && cfg.tailFanRadius > 0;

  if (useDragonflyLayout) {
    // Dragonfly layout: two large "wing" fans at body center forward,
    // spread laterally; optionally one small fan at the tail tip. The
    // wing fans sit on the lateral axis (localX = 0) so they read as
    // wings, not corner thrusters. Smoke shape/cadence comes from the
    // locomotionDragonflyHovercraft smokeConfig entry.
    const lateral = unitRadius * cfg.fanDistY;
    for (const sz of [-1, 1]) {
      fans.push(buildFan(
        group,
        {
          localX: 0,
          localZ: sz * lateral,
          fanRadius: mainFanRadius,
          ringTubeRadius: mainRingTubeRadius,
          outwardAngleRad,
          fanSpinRadPerSec,
          smokeProfile,
        },
        entityId,
        fans.length,
        ownerId,
        geometryTier,
      ));
    }
    if (hasTailFan) {
      const tailFanRadius = Math.max(0.6, unitRadius * cfg.tailFanRadius!);
      const tailRingTubeRadius = Math.max(
        0.18,
        unitRadius * (cfg.tailFanRingTubeRadius ?? cfg.fanRingTubeRadius),
      );
      // The tail fan sits at (x=tailFanOffsetX*r, z=0) so its
      // center-to-fan radial vector is exactly the unit's −X axis. Feeding
      // that direction into buildFan's outwardAngleRad therefore tilts
      // the duct rearward — which is the visual the user wants for
      // "the tail fan angled back."
      const tailBackAngleRad = THREE.MathUtils.degToRad(
        Math.max(0, Math.min(90, cfg.tailFanBackAngleDeg ?? 0)),
      );
      fans.push(buildFan(
        group,
        {
          localX: unitRadius * (cfg.tailFanOffsetX ?? 0),
          localZ: 0,
          fanRadius: tailFanRadius,
          ringTubeRadius: tailRingTubeRadius,
          outwardAngleRad: tailBackAngleRad,
          fanSpinRadPerSec,
          smokeProfile,
        },
        entityId,
        fans.length,
        ownerId,
        geometryTier,
      ));
    }
  } else if (cfg.fanLayout === 'twin') {
    // Twin layout: two fans on the lateral axis (localX = 0), one to each
    // side, like a two-rotor lift. Used by the Bee.
    const lateral = unitRadius * cfg.fanDistY;
    for (const sz of [-1, 1]) {
      fans.push(buildFan(
        group,
        {
          localX: 0,
          localZ: sz * lateral,
          fanRadius: mainFanRadius,
          ringTubeRadius: mainRingTubeRadius,
          outwardAngleRad,
          fanSpinRadPerSec,
          smokeProfile,
        },
        entityId,
        fans.length,
        ownerId,
        geometryTier,
      ));
    }
  } else if (cfg.fanLayout === 'triFront') {
    const fanDist = unitRadius * Math.hypot(cfg.fanDistX, cfg.fanDistY);
    for (const angle of TRI_FRONT_FAN_ANGLES_RAD) {
      fans.push(buildFan(
        group,
        {
          localX: Math.cos(angle) * fanDist,
          localZ: Math.sin(angle) * fanDist,
          fanRadius: mainFanRadius,
          ringTubeRadius: mainRingTubeRadius,
          outwardAngleRad,
          fanSpinRadPerSec,
          smokeProfile,
        },
        entityId,
        fans.length,
        ownerId,
        geometryTier,
      ));
    }
  } else {
    const fx = unitRadius * cfg.fanDistX;
    const fz = unitRadius * cfg.fanDistY;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        fans.push(buildFan(
          group,
          {
            localX: sx * fx,
            localZ: sz * fz,
            fanRadius: mainFanRadius,
            ringTubeRadius: mainRingTubeRadius,
            outwardAngleRad,
            fanSpinRadPerSec,
            smokeProfile,
          },
          entityId,
          fans.length,
          ownerId,
          geometryTier,
        ));
      }
    }
  }

  unitGroup.add(group);
  return {
    type: 'hover',
    group,
    fans,
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
  // to that chassis. Lift the group by whatever it takes to keep the
  // fans at least HOVER_FLOOR_MARGIN above terrain. On the common
  // case (chassis floating cleanly above ground) this is a no-op.
  const chassisWorldY = entity.transform.z;
  const groundY = getLocomotionSurfaceHeight(
    entity.transform.x, entity.transform.y, mapWidth, mapHeight, entity.id,
  );
  const rawClearance = chassisWorldY - groundY;
  const floorDeficit = HOVER_FLOOR_MARGIN - rawClearance;
  const groupY = floorDeficit > 0 ? floorDeficit : 0;
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
  return true;
}
