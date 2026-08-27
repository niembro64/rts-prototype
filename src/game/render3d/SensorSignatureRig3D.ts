import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import type { Entity } from '../sim/types';
import { isEntityActive } from '../sim/buildableHelpers';
import { getEntityAuthoredSensorRadii } from '../sim/sensorCoverage';
import {
  createPrimitiveCylinderGeometry,
  createPrimitiveRingGeometry,
  createPrimitiveSphereGeometry,
} from './PrimitiveGeometryQuality3D';
import { configureSelfLitEffectMaterial } from './RenderLighting3D';

export type SensorSignatureChannel = 'radar' | 'sonar' | 'jamming';

export type SensorSignatureRig3D = {
  root: THREE.Group;
  channels: readonly SensorSignatureChannel[];
  radarHardware: THREE.Group | null;
  jammerHardware: THREE.Group | null;
  radarPulses: THREE.Group | null;
  jammerPulses: THREE.Group | null;
};

type SensorSignatureBuildOptions = {
  hostRadius: number;
  mountY: number;
  /** Dedicated Radar/Sonar/Jammer buildings already carry large bespoke
   * hardware. They still receive the common pulse, but not a duplicate dish. */
  includeHardware?: boolean;
};

const PULSE_COUNT = 3;
const PULSE_CYCLES_PER_SECOND = 0.62;
const DISH_RAD_PER_SECOND = 0.56;

let signatureTimeSec = 0;
let dishGeometry: THREE.BufferGeometry | null = null;
let ringGeometry: THREE.RingGeometry | null = null;
let cylinderGeometry: THREE.CylinderGeometry | null = null;
let sphereGeometry: THREE.SphereGeometry | null = null;
let boxGeometry: THREE.BoxGeometry | null = null;
let hardwareDarkMaterial: THREE.MeshLambertMaterial | null = null;
let hardwareLightMaterial: THREE.MeshStandardMaterial | null = null;
let radarPulseMaterial: THREE.MeshBasicMaterial | null = null;
let sonarPulseMaterial: THREE.MeshBasicMaterial | null = null;
let jammerPulseMaterial: THREE.MeshBasicMaterial | null = null;

export function setSensorSignatureTimeMs(timeMs: number): void {
  if (Number.isFinite(timeMs)) signatureTimeSec = Math.max(0, timeMs) / 1000;
}

function getDishGeometry(): THREE.BufferGeometry {
  if (dishGeometry !== null) return dishGeometry;
  const radialSegments = 3;
  const angularSegments = 14;
  const positions: number[] = [0, 0, -1];
  for (let radiusIndex = 1; radiusIndex <= radialSegments; radiusIndex++) {
    const radius = radiusIndex / radialSegments;
    const z = -1 + radius * radius;
    for (let angleIndex = 0; angleIndex < angularSegments; angleIndex++) {
      const angle = angleIndex / angularSegments * Math.PI * 2;
      positions.push(Math.cos(angle) * radius, Math.sin(angle) * radius, z);
    }
  }
  const indices: number[] = [];
  const ringIndex = (ring: number, angle: number): number => (
    1 + (ring - 1) * angularSegments + angle % angularSegments
  );
  for (let angle = 0; angle < angularSegments; angle++) {
    indices.push(0, ringIndex(1, angle), ringIndex(1, angle + 1));
  }
  for (let ring = 2; ring <= radialSegments; ring++) {
    for (let angle = 0; angle < angularSegments; angle++) {
      const a0 = ringIndex(ring - 1, angle);
      const a1 = ringIndex(ring - 1, angle + 1);
      const b0 = ringIndex(ring, angle);
      const b1 = ringIndex(ring, angle + 1);
      indices.push(a0, b0, b1, a0, b1, a1);
    }
  }
  dishGeometry = new THREE.BufferGeometry();
  dishGeometry.name = 'sharedSensorSignatureDish';
  dishGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  dishGeometry.setIndex(indices);
  dishGeometry.computeVertexNormals();
  return dishGeometry;
}

function getRingGeometry(): THREE.RingGeometry {
  if (ringGeometry === null) {
    ringGeometry = createPrimitiveRingGeometry('effect', 'close', 0.88, 1);
    ringGeometry.name = 'sharedSensorSignaturePulse';
  }
  return ringGeometry;
}

function getCylinderGeometry(): THREE.CylinderGeometry {
  if (cylinderGeometry === null) {
    cylinderGeometry = createPrimitiveCylinderGeometry('effect', 'close');
    cylinderGeometry.name = 'sharedSensorSignatureMast';
  }
  return cylinderGeometry;
}

function getSphereGeometry(): THREE.SphereGeometry {
  if (sphereGeometry === null) {
    sphereGeometry = createPrimitiveSphereGeometry('effect', 'close');
    sphereGeometry.name = 'sharedSensorSignatureNode';
  }
  return sphereGeometry;
}

function getBoxGeometry(): THREE.BoxGeometry {
  if (boxGeometry === null) {
    boxGeometry = new THREE.BoxGeometry(1, 1, 1);
    boxGeometry.name = 'sharedSensorSignatureArray';
  }
  return boxGeometry;
}

function getHardwareDarkMaterial(): THREE.MeshLambertMaterial {
  return hardwareDarkMaterial ??= new THREE.MeshLambertMaterial({
    color: COLORS.effects.sensorSignature.hardwareDark.colorHex,
  });
}

function getHardwareLightMaterial(): THREE.MeshStandardMaterial {
  return hardwareLightMaterial ??= new THREE.MeshStandardMaterial({
    color: COLORS.effects.sensorSignature.hardwareLight.colorHex,
    metalness: COLORS.effects.sensorSignature.hardwareLight.metalness,
    roughness: COLORS.effects.sensorSignature.hardwareLight.roughness,
    side: THREE.DoubleSide,
  });
}

function makePulseMaterial(
  channel: SensorSignatureChannel,
): THREE.MeshBasicMaterial {
  if (channel === 'radar') {
    return radarPulseMaterial ??= configureSelfLitEffectMaterial(
      new THREE.MeshBasicMaterial({
        color: COLORS.effects.sensorSignature.radarPulse.colorHex,
        transparent: true,
        opacity: COLORS.effects.sensorSignature.radarPulse.opacity,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
  }
  if (channel === 'sonar') {
    return sonarPulseMaterial ??= configureSelfLitEffectMaterial(
      new THREE.MeshBasicMaterial({
        color: COLORS.effects.sensorSignature.sonarPulse.colorHex,
        transparent: true,
        opacity: COLORS.effects.sensorSignature.sonarPulse.opacity,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
  }
  return jammerPulseMaterial ??= configureSelfLitEffectMaterial(
    new THREE.MeshBasicMaterial({
      color: COLORS.effects.sensorSignature.jammerPulse.colorHex,
      transparent: true,
      opacity: COLORS.effects.sensorSignature.jammerPulse.opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
}

function makeMast(size: number): THREE.Mesh {
  const mast = new THREE.Mesh(getCylinderGeometry(), getHardwareDarkMaterial());
  mast.scale.set(size * 0.075, size * 0.48, size * 0.075);
  mast.position.y = size * 0.24;
  return mast;
}

function buildRadarHardware(
  size: number,
  underwater: boolean,
  phase: number,
): THREE.Group {
  const root = new THREE.Group();
  root.name = underwater ? 'sharedSonarHardware' : 'sharedRadarHardware';
  root.userData.sensorSignatureHardware = underwater ? 'sonar' : 'radar';
  root.add(makeMast(size));

  const yaw = new THREE.Group();
  yaw.position.y = size * 0.56;
  root.add(yaw);
  const tilt = new THREE.Group();
  tilt.rotation.x = underwater ? Math.PI / 2 : -0.48;
  yaw.add(tilt);

  const dish = new THREE.Mesh(getDishGeometry(), getHardwareLightMaterial());
  dish.scale.set(size * 0.46, size * 0.3, size * 0.13);
  dish.userData.sensorSignatureDish = underwater ? 'sonar' : 'radar';
  dish.onBeforeRender = () => {
    yaw.rotation.y = signatureTimeSec * DISH_RAD_PER_SECOND + phase;
  };
  tilt.add(dish);

  const feed = new THREE.Mesh(getSphereGeometry(), getHardwareDarkMaterial());
  feed.scale.setScalar(size * 0.095);
  feed.position.z = size * 0.22;
  tilt.add(feed);
  return root;
}

function buildJammerHardware(size: number): THREE.Group {
  const root = new THREE.Group();
  root.name = 'sharedJammerHardware';
  root.userData.sensorSignatureHardware = 'jamming';
  root.add(makeMast(size));
  const array = new THREE.Group();
  array.position.y = size * 0.58;
  root.add(array);
  for (let index = 0; index < 3; index++) {
    const bar = new THREE.Mesh(getBoxGeometry(), getHardwareLightMaterial());
    bar.scale.set(size * 0.75, size * 0.075, size * 0.11);
    bar.rotation.y = index * Math.PI / 3;
    array.add(bar);
  }
  const node = new THREE.Mesh(getSphereGeometry(), makePulseMaterial('jamming'));
  node.scale.setScalar(size * 0.13);
  node.userData.sensorSignatureGlow = 'jamming';
  array.add(node);
  return root;
}

function buildPulseGroup(
  channel: SensorSignatureChannel,
  size: number,
  phaseSeed: number,
): THREE.Group {
  const root = new THREE.Group();
  root.name = `shared${channel[0].toUpperCase()}${channel.slice(1)}Pulses`;
  root.userData.sensorSignaturePulse = channel;
  for (let index = 0; index < PULSE_COUNT; index++) {
    const pulse = new THREE.Mesh(getRingGeometry(), makePulseMaterial(channel));
    pulse.rotation.x = -Math.PI / 2;
    pulse.frustumCulled = false;
    pulse.renderOrder = 8;
    pulse.userData.sensorSignaturePulse = channel;
    const phaseOffset = index / PULSE_COUNT;
    pulse.onBeforeRender = () => {
      const phase = (
        signatureTimeSec * PULSE_CYCLES_PER_SECOND +
        phaseSeed +
        phaseOffset
      ) % 1;
      const scale = size * (0.72 + phase * 1.62);
      pulse.scale.setScalar(scale);
    };
    root.add(pulse);
  }
  return root;
}

/** Build the shared capability marker from the entity's actual authored
 * mounted sensor suite. Pure sight/detector hosts receive nothing. */
export function buildSensorSignatureRig3D(
  entity: Entity,
  options: SensorSignatureBuildOptions,
): SensorSignatureRig3D | undefined {
  const radii = getEntityAuthoredSensorRadii(entity);
  const hasRadar = radii.radar > 0;
  const hasSonar = radii.sonar > 0;
  const hasContact = hasRadar || hasSonar;
  const hasJammer = radii.radarJamming > 0 || radii.sonarJamming > 0;
  if (!hasContact && !hasJammer) return undefined;

  const root = new THREE.Group();
  root.name = 'sensorSignatureRig';
  root.position.y = options.mountY;
  root.userData.sensorSignatureChannels = [
    ...(hasRadar ? ['radar'] as const : []),
    ...(hasSonar ? ['sonar'] as const : []),
    ...(hasJammer ? ['jamming'] as const : []),
  ];
  const size = Math.max(2.4, Math.min(12, options.hostRadius * 0.22));
  const phaseSeed = (entity.id * 0.173) % 1;
  const contactOffset = hasContact && hasJammer ? -size * 0.62 : 0;
  const jammerOffset = hasContact && hasJammer ? size * 0.62 : 0;
  const includeHardware = options.includeHardware !== false;

  let radarHardware: THREE.Group | null = null;
  let radarPulses: THREE.Group | null = null;
  if (hasContact) {
    if (includeHardware) {
      radarHardware = buildRadarHardware(size, hasSonar, phaseSeed * Math.PI * 2);
      radarHardware.position.x = contactOffset;
      root.add(radarHardware);
    }
    radarPulses = buildPulseGroup(hasSonar ? 'sonar' : 'radar', size, phaseSeed);
    radarPulses.position.set(contactOffset, size * 0.62, 0);
    root.add(radarPulses);
  }

  let jammerHardware: THREE.Group | null = null;
  let jammerPulses: THREE.Group | null = null;
  if (hasJammer) {
    if (includeHardware) {
      jammerHardware = buildJammerHardware(size);
      jammerHardware.position.x = jammerOffset;
      root.add(jammerHardware);
    }
    jammerPulses = buildPulseGroup('jamming', size, phaseSeed + 0.37);
    jammerPulses.position.set(jammerOffset, size * 0.62, 0);
    root.add(jammerPulses);
  }

  const channels = root.userData.sensorSignatureChannels as SensorSignatureChannel[];
  const rig = {
    root,
    channels,
    radarHardware,
    jammerHardware,
    radarPulses,
    jammerPulses,
  } satisfies SensorSignatureRig3D;
  syncSensorSignatureRig3D(rig, entity);
  return rig;
}

/** Hardware identifies authored capability even while closed; only the
 * exuded pulse follows the operational coverage gate. */
export function syncSensorSignatureRig3D(
  rig: SensorSignatureRig3D,
  entity: Entity,
): void {
  const operational = isEntityActive(entity) &&
    entity.building?.activeState?.open !== false;
  if (rig.radarPulses !== null) rig.radarPulses.visible = operational;
  if (rig.jammerPulses !== null) rig.jammerPulses.visible = operational;
}

export function disposeSensorSignatureRig3DResources(): void {
  dishGeometry?.dispose();
  ringGeometry?.dispose();
  cylinderGeometry?.dispose();
  sphereGeometry?.dispose();
  boxGeometry?.dispose();
  hardwareDarkMaterial?.dispose();
  hardwareLightMaterial?.dispose();
  radarPulseMaterial?.dispose();
  sonarPulseMaterial?.dispose();
  jammerPulseMaterial?.dispose();
  dishGeometry = null;
  ringGeometry = null;
  cylinderGeometry = null;
  sphereGeometry = null;
  boxGeometry = null;
  hardwareDarkMaterial = null;
  hardwareLightMaterial = null;
  radarPulseMaterial = null;
  sonarPulseMaterial = null;
  jammerPulseMaterial = null;
}
