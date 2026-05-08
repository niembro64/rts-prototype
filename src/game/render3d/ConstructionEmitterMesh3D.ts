import * as THREE from 'three';
import type { ConstructionEmitterSize } from '@/types/blueprints';
import type { TurretConfig } from '../sim/types';
import { CONSTRUCTION_HAZARD_COLORS } from '@/constructionVisualConfig';
import { BUILDING_PALETTE } from './BuildingVisualPalette';

export type ConstructionTowerOrbitPart = {
  mesh: THREE.Mesh;
  baseX: number;
  baseZ: number;
  baseRotationY: number;
};

export type ProductionRateIndicatorRig = {
  shower: THREE.Mesh;
  showerRadius: number;
  pylonHeight: number;
  pylonBaseY: number;
  smoothedRate: number;
};

export type ConstructionEmitterRig = {
  group: THREE.Group;
  /** Same per-resource pylon trio the factory uses: energy / mana / metal. */
  showers: THREE.Mesh[];
  towerOrbitParts: ConstructionTowerOrbitPart[];
  showerRadius: number;
  pylonHeight: number;
  pylonBaseY: number;
  pylonTopsLocal: THREE.Vector3[];
  pylonTopBaseLocals: THREE.Vector3[];
  sprayTravelSpeed: number;
  sprayParticleRadius: number;
  smoothedRates: { energy: number; mana: number; metal: number };
  lastPaidTargetId: number | null;
  lastPaid: { energy: number; mana: number; metal: number };
  towerSpinAmount: number;
  towerSpinPhase: number;
};

type ConstructionPylonTrio = {
  staticMeshes: THREE.Mesh[];
  towerOrbitParts: ConstructionTowerOrbitPart[];
  showers: THREE.Mesh[];
  pylonTopsLocal: THREE.Vector3[];
  pylonTopBaseLocals: THREE.Vector3[];
};

export type ConstructionTowerResource = 'energy' | 'mana' | 'metal';
type ConstructionTowerSize = 'large' | 'small';

type ConstructionTowerVariant = {
  resource: ConstructionTowerResource;
  showerMaterial: THREE.Material;
  capMaterial: THREE.Material;
};

const cylinderGeom = new THREE.CylinderGeometry(0.5, 0.5, 1, 18);
const hexCylinderGeom = new THREE.CylinderGeometry(0.5, 0.5, 1, 6);
const sphereGeom = new THREE.SphereGeometry(1, 18, 12);
const frameMat = new THREE.MeshLambertMaterial({ color: BUILDING_PALETTE.structureDark });

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
  energy: 0xf5d442,
  mana: 0x7ad7ff,
  metal: 0xd09060,
} as const;

function makeShowerMat(hex: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: hex,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

const energyShowerMat = makeShowerMat(CONSTRUCTION_RESOURCE_COLORS.energy);
const manaShowerMat = makeShowerMat(CONSTRUCTION_RESOURCE_COLORS.mana);
const metalShowerMat = makeShowerMat(CONSTRUCTION_RESOURCE_COLORS.metal);
const energyCapMat = new THREE.MeshLambertMaterial({ color: CONSTRUCTION_RESOURCE_COLORS.energy });
const manaCapMat = new THREE.MeshLambertMaterial({ color: CONSTRUCTION_RESOURCE_COLORS.mana });
const metalCapMat = new THREE.MeshLambertMaterial({ color: CONSTRUCTION_RESOURCE_COLORS.metal });

const CONSTRUCTION_TOWER_VARIANTS: readonly ConstructionTowerVariant[] = [
  { resource: 'energy', showerMaterial: energyShowerMat, capMaterial: energyCapMat },
  { resource: 'mana', showerMaterial: manaShowerMat, capMaterial: manaCapMat },
  { resource: 'metal', showerMaterial: metalShowerMat, capMaterial: metalCapMat },
] as const;

const CONSTRUCTION_TOWER_VARIANT_BY_RESOURCE: Record<ConstructionTowerResource, ConstructionTowerVariant> = {
  energy: CONSTRUCTION_TOWER_VARIANTS[0],
  mana: CONSTRUCTION_TOWER_VARIANTS[1],
  metal: CONSTRUCTION_TOWER_VARIANTS[2],
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

export function buildProductionRateIndicator(
  resource: ConstructionTowerResource,
  showerRadius: number,
  pylonHeight: number,
  pylonBaseY: number,
  x = 0,
  z = 0,
  pylonRadius = 0,
): {
  staticMeshes: THREE.Mesh[];
  rig: ProductionRateIndicatorRig;
} {
  const variant = CONSTRUCTION_TOWER_VARIANT_BY_RESOURCE[resource];
  const staticMeshes: THREE.Mesh[] = [];
  if (pylonRadius > 0) {
    staticMeshes.push(makeCylinder(
      frameMat,
      pylonRadius,
      pylonHeight,
      x,
      pylonBaseY + pylonHeight / 2,
      z,
    ));
    staticMeshes.push(makeSphere(
      variant.capMaterial,
      Math.max(1.6, pylonRadius * 1.45),
      x,
      pylonBaseY + pylonHeight + Math.max(1.0, pylonRadius * 0.5),
      z,
    ));
  }
  const shower = makeCylinder(
    variant.showerMaterial,
    showerRadius,
    1,
    x,
    pylonBaseY,
    z,
  );
  shower.visible = false;
  shower.renderOrder = 6;
  return {
    staticMeshes,
    rig: {
      shower,
      showerRadius,
      pylonHeight,
      pylonBaseY,
      smoothedRate: 0,
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
    dims.showerRadius,
    pylonBaseY,
  );
  for (const mesh of pylonTrio.staticMeshes) root.add(mesh);
  for (const shower of pylonTrio.showers) root.add(shower);

  return {
    group: root,
    showers: pylonTrio.showers,
    towerOrbitParts: pylonTrio.towerOrbitParts,
    showerRadius: dims.showerRadius,
    pylonHeight: dims.pylonHeight,
    pylonBaseY,
    pylonTopsLocal: pylonTrio.pylonTopsLocal,
    pylonTopBaseLocals: pylonTrio.pylonTopBaseLocals,
    sprayTravelSpeed: spec.particleTravelSpeed,
    sprayParticleRadius: spec.particleRadius,
    smoothedRates: { energy: 0, mana: 0, metal: 0 },
    lastPaidTargetId: null,
    lastPaid: { energy: 0, mana: 0, metal: 0 },
    towerSpinAmount: 0,
    towerSpinPhase: 0,
  };
}

export function disposeConstructionEmitterGeoms(): void {
  cylinderGeom.dispose();
  hexCylinderGeom.dispose();
  sphereGeom.dispose();
  frameMat.dispose();
  constructionBandMat.dispose();
  energyShowerMat.dispose();
  manaShowerMat.dispose();
  metalShowerMat.dispose();
  energyCapMat.dispose();
  manaCapMat.dispose();
  metalCapMat.dispose();
}

function buildConstructionPylonTrio(
  size: ConstructionTowerSize,
  teamBaseMat: THREE.Material,
  pylonHeight: number,
  pylonOffset: number,
  innerPylonRadius: number,
  showerRadius: number,
  pylonBaseY: number,
): ConstructionPylonTrio {
  const staticMeshes: THREE.Mesh[] = [];
  const towerOrbitParts: ConstructionTowerOrbitPart[] = [];
  const showers: THREE.Mesh[] = [];
  const pylonTopsLocal: THREE.Vector3[] = [];
  const pylonTopBaseLocals: THREE.Vector3[] = [];

  for (let i = 0; i < CONSTRUCTION_TOWER_VARIANTS.length; i++) {
    const a = (i / CONSTRUCTION_TOWER_VARIANTS.length) * Math.PI * 2;
    const tower = buildConstructionTowerPiece(
      CONSTRUCTION_TOWER_VARIANTS[i],
      size,
      teamBaseMat,
      pylonHeight,
      innerPylonRadius,
      showerRadius,
      pylonBaseY,
      Math.cos(a) * pylonOffset,
      Math.sin(a) * pylonOffset,
    );
    staticMeshes.push(...tower.staticMeshes);
    towerOrbitParts.push(...tower.towerOrbitParts);
    showers.push(tower.shower);
    pylonTopsLocal.push(tower.topLocal);
    pylonTopBaseLocals.push(tower.topBaseLocal);
  }

  return { staticMeshes, towerOrbitParts, showers, pylonTopsLocal, pylonTopBaseLocals };
}

function buildConstructionTowerPiece(
  variant: ConstructionTowerVariant,
  size: ConstructionTowerSize,
  teamBaseMat: THREE.Material,
  pylonHeight: number,
  innerPylonRadius: number,
  showerRadius: number,
  pylonBaseY: number,
  x: number,
  z: number,
): {
  staticMeshes: THREE.Mesh[];
  towerOrbitParts: ConstructionTowerOrbitPart[];
  shower: THREE.Mesh;
  topLocal: THREE.Vector3;
  topBaseLocal: THREE.Vector3;
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
  const pylon = makeCylinder(
    frameMat,
    innerPylonRadius,
    pylonHeight,
    x,
    pylonBaseY + pylonHeight / 2,
    z,
  );
  const cap = makeSphere(variant.capMaterial, capRadius, x, capY, z);
  const staticMeshes = [teamBase, constructionBand, pylon, cap];

  const shower = makeCylinder(
    variant.showerMaterial,
    showerRadius,
    1,
    x,
    pylonBaseY,
    z,
  );
  shower.visible = false;
  shower.renderOrder = 6;
  const topLocal = new THREE.Vector3(x, capY + capRadius * 0.35, z);

  const towerOrbitParts: ConstructionTowerOrbitPart[] = [
    teamBase,
    constructionBand,
    pylon,
    cap,
    shower,
  ].map((mesh) => ({
    mesh,
    baseX: mesh.position.x,
    baseZ: mesh.position.z,
    baseRotationY: mesh.rotation.y,
  }));

  return {
    staticMeshes,
    towerOrbitParts,
    shower,
    topLocal,
    topBaseLocal: topLocal.clone(),
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
