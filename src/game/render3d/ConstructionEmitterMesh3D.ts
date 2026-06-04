// Construction emitter rig: the pair of resource pylons + build-spray
// sources that visually communicate "energy/metal flowing
// out to a construction site". Mounted on a `turretConstruction` and
// shared verbatim across hosts — commanders, fabricators, and the future
// construction aircraft all render through this same rig with only the
// visualVariant (small/large) and rate-source differing.
//
// Pairing with capability components:
//   - Builder unit (commander, aircraft) → emitter rate inferred from
//     the target shell's paid-resource deltas; sprays target the
//     selected build site.
//   - Factory building (fabricator) → emitter rate read from the
//     factory's per-resource transfer fractions; sprays target the
//     live shell above the fabricator center. The "forming unit" orb +
//     sparks belongs to a separate `FactoryBuildSpotRig`, not this rig.

import * as THREE from 'three';
import type { ConstructionEmitterSize } from '@/types/blueprints';
import type { TurretConfig } from '../sim/types';
import { RESOURCE_COLOR_HEX } from '@/colorsConfig';
import { PYLON_CONSTRUCTION_CONE_HALF_ANGLE_RAD } from '@/resourceConfig';
import { CONSTRUCTION_HAZARD_COLORS } from '@/constructionVisualConfig';
import { BUILDING_PALETTE } from './BuildingVisualPalette';

export type ConstructionTowerOrbitPart = {
  mesh: THREE.Mesh;
  baseX: number;
  baseZ: number;
  baseRotationY: number;
};

export type ResourcePylonDirection = 'inbound' | 'outbound';

export type ResourcePylonRig = {
  resource: ConstructionTowerResource;
  direction: ResourcePylonDirection;
  rootLocal: THREE.Vector3;
  rootBaseLocal: THREE.Vector3;
  topLocal: THREE.Vector3;
  topBaseLocal: THREE.Vector3;
  sprayTravelSpeed: number;
  sprayParticleRadius: number;
  /** Radius of the beads that flow through the bore of the straw. Sized
   *  to sit inside the inner (bore) wall. Drives PylonTubeFlowRenderer. */
  tubeBeadRadius: number;
  flowRadius: number;
  /** Half-angle (radians) of the cone the pylon's resource balls disperse
   *  through, around the ray from the tip to its lock-on spot. See
   *  PYLON_*_CONE_HALF_ANGLE_RAD in resourceConfig. */
  coneAngle: number;
  channel: number;
  smoothedRate: number;
  displaySmoothedRate: number;
};

export type ConstructionEmitterRig = {
  group: THREE.Group;
  /** Same per-resource pylon pair the factory uses: energy / metal. */
  pylons: ResourcePylonRig[];
  towerOrbitParts: ConstructionTowerOrbitPart[];
  smoothedRates: { energy: number; metal: number };
  /** Second-stage display EMA layered on top of `smoothedRates`. Drives
   *  the build-spray emission so motion eases in/out of changes instead
   *  of tracking the first stage 1:1. */
  displaySmoothedRates: { energy: number; metal: number };
  lastPaidTargetId: number | null;
  lastPaid: { energy: number; metal: number };
  towerSpinAmount: number;
  /** Second-stage display EMA layered on top of `towerSpinAmount`. The
   *  visible tower spin uses this so spin-up / spin-down eases in. */
  displayTowerSpinAmount: number;
  towerSpinPhase: number;
};

type ConstructionPylonTrio = {
  staticMeshes: THREE.Mesh[];
  towerOrbitParts: ConstructionTowerOrbitPart[];
  pylons: ResourcePylonRig[];
};

export type ConstructionTowerResource = 'energy' | 'metal';
type ConstructionTowerSize = 'large' | 'small';

type ConstructionTowerVariant = {
  resource: ConstructionTowerResource;
  capMaterial: THREE.Material;
};

export type ResourcePylonBuildOptions = {
  resource: ConstructionTowerResource;
  direction: ResourcePylonDirection;
  pylonHeight: number;
  pylonBaseY: number;
  x: number;
  z: number;
  pylonRadius: number;
  sprayTravelSpeed: number;
  sprayParticleRadius: number;
  flowRadius: number;
  /** Cone half-angle (radians) for this pylon's resource-ball dispersion.
   *  Construction emitters pass PYLON_CONSTRUCTION_CONE_HALF_ANGLE_RAD;
   *  economy buildings pass their building-specific pylon cone constants. */
  coneAngle: number;
  channel: number;
};

const cylinderGeom = new THREE.CylinderGeometry(0.5, 0.5, 1, 18);
const hexCylinderGeom = new THREE.CylinderGeometry(0.5, 0.5, 1, 6);
const octagonCylinderGeom = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
const sphereGeom = new THREE.SphereGeometry(1, 18, 12);
const frameMat = new THREE.MeshLambertMaterial({ color: BUILDING_PALETTE.structureDark });

// "Straw" walls: the pylon is a transparent double-wall tube — an outer
// wall and an inner bore wall — so the resource beads are visible riding
// up/down the bore inside it. depthWrite:false + DoubleSide keeps the
// glassy look and lets the beads (drawn after) always show through.
const STRAW_BORE_FRAC = 0.6;   // inner wall radius as a fraction of the pylon radius
const STRAW_BEAD_FRAC = 0.4;   // bead radius as a fraction of the pylon radius (sits inside the bore)
const strawOuterMat = new THREE.MeshLambertMaterial({
  color: BUILDING_PALETTE.structureDark,
  transparent: true,
  opacity: 0.16,
  depthWrite: false,
  side: THREE.DoubleSide,
});
const strawInnerMat = new THREE.MeshLambertMaterial({
  color: BUILDING_PALETTE.structureDark,
  transparent: true,
  opacity: 0.3,
  depthWrite: false,
  side: THREE.DoubleSide,
});

function shaderRgb(rgb: readonly [number, number, number]): string {
  return `vec3(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

const CONSTRUCTION_HAZARD_YELLOW_GLSL = shaderRgb(CONSTRUCTION_HAZARD_COLORS.yellowRgb);
const CONSTRUCTION_HAZARD_BLACK_GLSL = shaderRgb(CONSTRUCTION_HAZARD_COLORS.blackRgb);

const constructionBandMat = new THREE.ShaderMaterial({
  vertexShader: `
varying vec3 vLocal;
void main() {
  vLocal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`,
  fragmentShader: `
varying vec3 vLocal;
void main() {
  float diagonal = fract((vLocal.x * 0.8 + vLocal.y * 1.15 + vLocal.z * 0.45) * 4.4);
  vec3 yellow = ${CONSTRUCTION_HAZARD_YELLOW_GLSL};
  vec3 black = ${CONSTRUCTION_HAZARD_BLACK_GLSL};
  gl_FragColor = vec4(diagonal < 0.5 ? yellow : black, 1.0);
}
`,
});

const CONSTRUCTION_RESOURCE_COLORS = {
  energy: RESOURCE_COLOR_HEX.energy,
  metal: RESOURCE_COLOR_HEX.metal,
} as const;

const energyCapMat = new THREE.MeshLambertMaterial({ color: CONSTRUCTION_RESOURCE_COLORS.energy });
const metalCapMat = new THREE.MeshLambertMaterial({ color: CONSTRUCTION_RESOURCE_COLORS.metal });

const CONSTRUCTION_TOWER_VARIANTS: readonly ConstructionTowerVariant[] = [
  { resource: 'energy', capMaterial: energyCapMat },
  { resource: 'metal', capMaterial: metalCapMat },
] as const;

const CONSTRUCTION_TOWER_VARIANT_BY_RESOURCE: Record<ConstructionTowerResource, ConstructionTowerVariant> = {
  energy: CONSTRUCTION_TOWER_VARIANTS[0],
  metal: CONSTRUCTION_TOWER_VARIANTS[1],
};

const CONSTRUCTION_TOWER_SIZE_STYLE: Record<ConstructionTowerSize, {
  baseRadiusMult: number;
  baseHeightMult: number;
  bandRadiusMult: number;
  bandHeightMult: number;
  capRadiusMult: number;
}> = {
  large: {
    baseRadiusMult: 2.85,
    baseHeightMult: 1.45,
    bandRadiusMult: 2.55,
    bandHeightMult: 0.95,
    capRadiusMult: 1.65,
  },
  small: {
    baseRadiusMult: 2.55,
    baseHeightMult: 1.25,
    bandRadiusMult: 2.25,
    bandHeightMult: 0.78,
    capRadiusMult: 1.55,
  },
};

export function buildResourcePylonRig(options: ResourcePylonBuildOptions): {
  staticMeshes: THREE.Mesh[];
  rig: ResourcePylonRig;
} {
  const variant = CONSTRUCTION_TOWER_VARIANT_BY_RESOURCE[options.resource];
  const staticMeshes: THREE.Mesh[] = [];
  if (options.pylonRadius > 0) {
    for (const wall of makeStrawWalls(
      options.pylonRadius,
      options.pylonHeight,
      options.x,
      options.pylonBaseY + options.pylonHeight / 2,
      options.z,
    )) staticMeshes.push(wall);
    staticMeshes.push(makeSphere(
      variant.capMaterial,
      Math.max(1.6, options.pylonRadius * 1.45),
      options.x,
      options.pylonBaseY + options.pylonHeight + Math.max(1.0, options.pylonRadius * 0.5),
      options.z,
    ));
  }
  const capRadius = Math.max(1.6, options.pylonRadius * 1.45);
  const topLocal = new THREE.Vector3(
    options.x,
    options.pylonBaseY + options.pylonHeight + Math.max(1.0, options.pylonRadius * 0.5) + capRadius * 0.35,
    options.z,
  );
  const rootLocal = new THREE.Vector3(options.x, options.pylonBaseY, options.z);
  return {
    staticMeshes,
    rig: {
      resource: options.resource,
      direction: options.direction,
      rootLocal,
      rootBaseLocal: rootLocal.clone(),
      topLocal,
      topBaseLocal: topLocal.clone(),
      sprayTravelSpeed: options.sprayTravelSpeed,
      sprayParticleRadius: options.sprayParticleRadius,
      tubeBeadRadius: Math.max(0.5, options.pylonRadius * STRAW_BEAD_FRAC),
      flowRadius: options.flowRadius,
      coneAngle: options.coneAngle,
      channel: options.channel,
      smoothedRate: 0,
      displaySmoothedRate: 0,
    },
  };
}

export function buildConstructionEmitterRigFromTurretConfig(
  turretConfig: Pick<TurretConfig, 'constructionEmitter'>,
  visualVariant: ConstructionEmitterSize | undefined,
  primaryMat: THREE.Material = frameMat,
): ConstructionEmitterRig {
  const spec = turretConfig.constructionEmitter;
  if (!spec) {
    throw new Error('Construction emitter rig requires a constructionEmitter turret config');
  }
  const variant = visualVariant ?? spec.defaultSize;
  const dims = spec.sizes[variant];
  if (!dims) {
    throw new Error(`Unknown construction emitter visual variant: ${variant}`);
  }

  const root = new THREE.Group();
  const pylonBaseY = 0;
  const pylonTrio = buildConstructionPylonTrio(
    dims.towerSize,
    primaryMat,
    dims.pylonHeight,
    dims.pylonOffset,
    dims.innerPylonRadius,
    pylonBaseY,
  );
  if (variant === 'large') {
    root.add(buildConstructionTurretDeck(dims.pylonOffset, dims.innerPylonRadius, primaryMat));
  }
  for (const mesh of pylonTrio.staticMeshes) root.add(mesh);
  for (const pylon of pylonTrio.pylons) {
    pylon.sprayTravelSpeed = spec.particleTravelSpeed;
    pylon.sprayParticleRadius = spec.particleRadius;
  }

  return {
    group: root,
    pylons: pylonTrio.pylons,
    towerOrbitParts: pylonTrio.towerOrbitParts,
    smoothedRates: { energy: 0, metal: 0 },
    displaySmoothedRates: { energy: 0, metal: 0 },
    lastPaidTargetId: null,
    lastPaid: { energy: 0, metal: 0 },
    towerSpinAmount: 0,
    displayTowerSpinAmount: 0,
    towerSpinPhase: 0,
  };
}

export function disposeConstructionEmitterGeoms(): void {
  cylinderGeom.dispose();
  hexCylinderGeom.dispose();
  octagonCylinderGeom.dispose();
  sphereGeom.dispose();
  frameMat.dispose();
  strawOuterMat.dispose();
  strawInnerMat.dispose();
  constructionBandMat.dispose();
  energyCapMat.dispose();
  metalCapMat.dispose();
}

function buildConstructionTurretDeck(
  pylonOffset: number,
  innerPylonRadius: number,
  primaryMat: THREE.Material,
): THREE.Mesh {
  const radius = Math.max(16, pylonOffset + innerPylonRadius * 5);
  const height = Math.max(4, innerPylonRadius * 1.6);
  const deck = new THREE.Mesh(octagonCylinderGeom, primaryMat);
  deck.position.set(0, -height * 0.5, 0);
  deck.scale.set(radius * 2, height, radius * 2);
  return deck;
}

function buildConstructionPylonTrio(
  size: ConstructionTowerSize,
  teamBaseMat: THREE.Material,
  pylonHeight: number,
  pylonOffset: number,
  innerPylonRadius: number,
  pylonBaseY: number,
): ConstructionPylonTrio {
  const staticMeshes: THREE.Mesh[] = [];
  const towerOrbitParts: ConstructionTowerOrbitPart[] = [];
  const pylons: ResourcePylonRig[] = [];

  for (let i = 0; i < CONSTRUCTION_TOWER_VARIANTS.length; i++) {
    const a = (i / CONSTRUCTION_TOWER_VARIANTS.length) * Math.PI * 2;
    const tower = buildConstructionTowerPiece(
      CONSTRUCTION_TOWER_VARIANTS[i],
      size,
      teamBaseMat,
      pylonHeight,
      innerPylonRadius,
      pylonBaseY,
      Math.cos(a) * pylonOffset,
      Math.sin(a) * pylonOffset,
    );
    staticMeshes.push(...tower.staticMeshes);
    towerOrbitParts.push(...tower.towerOrbitParts);
    pylons.push(tower.rig);
  }

  return { staticMeshes, towerOrbitParts, pylons };
}

function buildConstructionTowerPiece(
  variant: ConstructionTowerVariant,
  size: ConstructionTowerSize,
  teamBaseMat: THREE.Material,
  pylonHeight: number,
  innerPylonRadius: number,
  pylonBaseY: number,
  x: number,
  z: number,
): {
  staticMeshes: THREE.Mesh[];
  towerOrbitParts: ConstructionTowerOrbitPart[];
  rig: ResourcePylonRig;
} {
  const style = CONSTRUCTION_TOWER_SIZE_STYLE[size];
  const baseRadius = innerPylonRadius * style.baseRadiusMult;
  const baseHeight = Math.max(1.2, innerPylonRadius * style.baseHeightMult);
  const bandRadius = innerPylonRadius * style.bandRadiusMult;
  const bandHeight = Math.max(1.0, innerPylonRadius * style.bandHeightMult);
  const capRadius = Math.max(1.35, innerPylonRadius * style.capRadiusMult);
  const pylonTopY = pylonBaseY + pylonHeight;
  const capY = pylonTopY + capRadius * 0.36;

  const teamBase = makeCylinder(
    teamBaseMat,
    baseRadius,
    baseHeight,
    x,
    pylonBaseY + baseHeight / 2,
    z,
    hexCylinderGeom,
  );
  const constructionBand = makeCylinder(
    constructionBandMat,
    bandRadius,
    bandHeight,
    x,
    pylonBaseY + baseHeight + bandHeight / 2,
    z,
    hexCylinderGeom,
  );
  const [strawOuter, strawInner] = makeStrawWalls(
    innerPylonRadius,
    pylonHeight,
    x,
    pylonBaseY + pylonHeight / 2,
    z,
  );
  const cap = makeSphere(variant.capMaterial, capRadius, x, capY, z);
  const staticMeshes = [teamBase, constructionBand, strawOuter, strawInner, cap];

  const rootLocal = new THREE.Vector3(x, pylonBaseY, z);
  const topLocal = new THREE.Vector3(x, capY + capRadius * 0.35, z);

  // Both straw walls orbit with the tower so the bore (and the bead
  // column locked to it) travels with the pylon.
  const towerOrbitParts: ConstructionTowerOrbitPart[] = [
    teamBase,
    constructionBand,
    strawOuter,
    strawInner,
    cap,
  ].map((mesh) => ({
    mesh,
    baseX: mesh.position.x,
    baseZ: mesh.position.z,
    baseRotationY: mesh.rotation.y,
  }));

  return {
    staticMeshes,
    towerOrbitParts,
    rig: {
      resource: variant.resource,
      direction: 'outbound',
      rootLocal,
      rootBaseLocal: rootLocal.clone(),
      topLocal,
      topBaseLocal: topLocal.clone(),
      sprayTravelSpeed: 0,
      sprayParticleRadius: 0,
      tubeBeadRadius: Math.max(0.5, innerPylonRadius * STRAW_BEAD_FRAC),
      flowRadius: Math.max(24, pylonHeight * 1.15),
      coneAngle: PYLON_CONSTRUCTION_CONE_HALF_ANGLE_RAD,
      channel: variant.resource === 'energy' ? 0 : 1,
      smoothedRate: 0,
      displaySmoothedRate: 0,
    },
  };
}

function makeCylinder(
  material: THREE.Material,
  radius: number,
  height: number,
  x: number,
  y: number,
  z: number,
  geom: THREE.BufferGeometry = cylinderGeom,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geom, material);
  mesh.scale.set(radius * 2, height, radius * 2);
  mesh.position.set(x, y, z);
  return mesh;
}

function makeSphere(
  material: THREE.Material,
  radius: number,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(sphereGeom, material);
  mesh.scale.setScalar(radius);
  mesh.position.set(x, y, z);
  return mesh;
}

/** The transparent double-wall "straw": an outer wall at `radius` and an
 *  inner bore wall, both see-through so the resource beads read clearly
 *  inside the bore. Returns [outer, inner]. */
function makeStrawWalls(
  radius: number,
  height: number,
  x: number,
  y: number,
  z: number,
): THREE.Mesh[] {
  return [
    makeCylinder(strawOuterMat, radius, height, x, y, z),
    makeCylinder(strawInnerMat, radius * STRAW_BORE_FRAC, height, x, y, z),
  ];
}
