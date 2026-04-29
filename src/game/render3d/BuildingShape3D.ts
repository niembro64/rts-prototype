// BuildingShape3D — per-type 3D geometry for player-built buildings.
//
// Each building type gets its own recognizable silhouette, built from a
// team-colored primary body plus LOD-tagged type-specific accents:
//
//   solar   — raised photovoltaic modules. No coplanar/near-coplanar
//             paper-thin overlays, so distant zoom levels do not shimmer.
//   factory — compact radial construction tower. Produced units are
//             assembled outside the tower footprint by spray particles.
//
// Shapes are additive — the caller owns a `THREE.Group` containing the
// whole building and plugs in the primary + detail meshes returned by
// `buildBuildingShape()`. Geometries and materials are shared per-team
// via the material cache that Render3DEntities already maintains, so no
// new allocation pressure.

import * as THREE from 'three';
import type { ConcreteGraphicsQuality } from '@/types/graphics';

/** Short building types we have art for. Unknown types fall back to a
 *  plain primary-color slab (same as before). */
export type BuildingShapeType = 'solar' | 'factory' | 'unknown';

export type BuildingDetailRole =
  | 'static'
  | 'solarShine'
  | 'factoryUnitGhost'
  | 'factoryUnitCore'
  | 'factoryBuildPulse'
  | 'factorySpark';

export type BuildingDetailMesh = {
  mesh: THREE.Mesh;
  minTier: ConcreteGraphicsQuality;
  maxTier?: ConcreteGraphicsQuality;
  role?: BuildingDetailRole;
};

export type FactoryConstructionRig = {
  unitGhost: THREE.Mesh;
  unitCore: THREE.Mesh;
  buildPulses: THREE.Mesh[];
  sparks: THREE.Mesh[];
  nozzleLocal: THREE.Vector3;
  bayBaseY: number;
};

/** What the caller receives back from `buildBuildingShape()`. */
export type BuildingShape = {
  /** Team-primary-colored main body. Scaled per-instance at the call
   *  site to the building's (width, height, depth). */
  primary: THREE.Mesh;
  /** Decorative accent meshes already positioned relative to the primary
   *  body. Each declares the client LOD tier range where it should exist. */
  details: BuildingDetailMesh[];
  /** The building's render height so the caller can position the
   *  primary body correctly on the ground plane. */
  height: number;
  factoryRig?: FactoryConstructionRig;
};

// ── Standard dimensions ────────────────────────────────────────────────
/** Default fallback block height for unknown buildings. */
const DEFAULT_HEIGHT = 120;
/** Solar collector silhouette is much shorter and wider — reads as a
 *  flat panel array, not a building. */
const SOLAR_HEIGHT = 30;
/** Factory primary is the compact cylindrical base of the tower. */
const FACTORY_BASE_HEIGHT = 30;

// ── Shared cached geometries ───────────────────────────────────────────
// Unit box reused for all building slabs + accents; each caller scales
// it to the right dimensions. Shared across instances so every factory
// and every solar uses the same backing BufferGeometry.
const boxGeom = new THREE.BoxGeometry(1, 1, 1);
const cylinderGeom = new THREE.CylinderGeometry(0.5, 0.5, 1, 18);
const hexCylinderGeom = new THREE.CylinderGeometry(0.5, 0.5, 1, 6);
const factorySphereGeom = new THREE.SphereGeometry(1, 18, 12);

// Slightly lighter gray for structural columns/gantries.
const chimneyMat = new THREE.MeshLambertMaterial({ color: 0x555555 });
// Solar-panel glass uses the same PBR trick as mirror panels: metalness=1
// and near-zero roughness reflect the scene PMREM, while the dark blue
// base tint keeps it reading as photovoltaic glass.
const solarCellMat = new THREE.MeshStandardMaterial({
  color: 0x123a58,
  metalness: 1.0,
  roughness: 0.02,
});
const solarShineGeom = new THREE.PlaneGeometry(1, 1);
const solarShineMat = new THREE.ShaderMaterial({
  vertexShader: `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`,
  fragmentShader: `
varying vec2 vUv;
void main() {
  float crossFade = smoothstep(0.0, 0.16, vUv.x) * smoothstep(1.0, 0.84, vUv.x);
  float strip = 1.0 - smoothstep(0.0, 0.5, abs(vUv.y - 0.5) * 2.0);
  float alpha = crossFade * strip * strip * 0.72;
  gl_FragColor = vec4(0.72, 0.96, 1.0, alpha);
}
`,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide,
});
const factoryFrameMat = new THREE.MeshLambertMaterial({ color: 0x2c3038 });
const constructionGhostMat = new THREE.MeshLambertMaterial({
  color: 0x8fdcff,
  transparent: true,
  opacity: 0.5,
  depthWrite: false,
});
const constructionCoreMat = new THREE.MeshBasicMaterial({
  color: 0xffe08a,
  transparent: true,
  opacity: 0.8,
  depthWrite: false,
});
const constructionSparkMat = new THREE.MeshBasicMaterial({
  color: 0xffffff,
  transparent: true,
  opacity: 0.85,
  depthWrite: false,
});
const constructionOrbGeom = new THREE.SphereGeometry(1, 12, 8);

/** Build a type-specific building mesh set. `width` and `depth` are the
 *  building's footprint in world units (from `entity.building.width/height`);
 *  `primaryMat` is the team-colored MeshLambertMaterial the caller pulls
 *  from its per-player cache. */
export function buildBuildingShape(
  type: BuildingShapeType,
  width: number,
  depth: number,
  primaryMat: THREE.Material,
): BuildingShape {
  switch (type) {
    case 'solar':
      return buildSolar(width, depth, primaryMat);
    case 'factory':
      return buildFactory(width, depth, primaryMat);
    default:
      return buildUnknown(primaryMat);
  }
}

// ── Per-type builders ──────────────────────────────────────────────────

/** Solar collector: short team-colored slab with a 3×2 grid of darker
 *  "cell" inset boxes on top. Height clamped low so the whole thing
 *  reads as a ground-hugging panel array. */
function buildSolar(
  width: number,
  depth: number,
  primaryMat: THREE.Material,
): BuildingShape {
  const primary = new THREE.Mesh(boxGeom, primaryMat);
  const details: BuildingDetailMesh[] = [];

  // LOW gets one chunky raised collector plate. MED+ replaces it with
  // the 3x2 modules below; using maxTier avoids stacked overlapping
  // panels when the LOD gets richer.
  const lowPlate = makeBox(
    solarCellMat,
    width * 0.84,
    8,
    depth * 0.7,
    0,
    SOLAR_HEIGHT + 7,
    0,
  );
  details.push(detail(lowPlate, 'low', 'low'));

  // Cell grid on top. 3 wide x 2 deep like the 2D version, but each
  // module is a real raised slab with several world units of clearance
  // from the roof so it does not z-fight or shimmer at long zoom.
  const MARGIN = 0.08;
  const GAP = 0.055;
  const cellsX = 3, cellsZ = 2;
  const availW = width * (1 - 2 * MARGIN);
  const availD = depth * (1 - 2 * MARGIN);
  const gapW = availW * GAP;
  const gapD = availD * GAP;
  const cellW = (availW - gapW * (cellsX - 1)) / cellsX;
  const cellD = (availD - gapD * (cellsZ - 1)) / cellsZ;
  const startX = -width / 2 + width * MARGIN + cellW / 2;
  const startZ = -depth / 2 + depth * MARGIN + cellD / 2;
  const cellH = 8;
  const slabTop = SOLAR_HEIGHT;
  for (let cz = 0; cz < cellsZ; cz++) {
    for (let cx = 0; cx < cellsX; cx++) {
      const cell = makeBox(
        solarCellMat,
        cellW,
        cellH,
        cellD,
        startX + cx * (cellW + gapW),
        slabTop + 4 + cellH / 2,
        startZ + cz * (cellD + gapD),
      );
      details.push(detail(cell, 'medium'));

      const shineY = slabTop + 4 + cellH + 2.5;
      const shinePhase = (cx + cz * cellsX) / (cellsX * cellsZ);
      details.push(detail(
        makeSolarShine(
          cell.position.x,
          shineY,
          cell.position.z,
          cellW * 1.35,
          cellD * 0.22,
          cellW * 0.42,
          shinePhase,
          -Math.PI / 11,
        ),
        'high',
        undefined,
        'solarShine',
      ));
      details.push(detail(
        makeSolarShine(
          cell.position.x,
          shineY + 0.6,
          cell.position.z,
          cellW * 1.55,
          cellD * 0.16,
          cellW * 0.52,
          shinePhase + 0.37,
          Math.PI / 12,
        ),
        'max',
        undefined,
        'solarShine',
      ));
    }
  }

  return { primary, details, height: SOLAR_HEIGHT };
}

/** Factory: compact radial construction tower. No yard geometry is
 *  drawn; only the small tower footprint exists visually/gameplay-wise. */
function buildFactory(
  width: number,
  depth: number,
  primaryMat: THREE.Material,
): BuildingShape {
  const primary = new THREE.Mesh(cylinderGeom, primaryMat);
  const details: BuildingDetailMesh[] = [];

  const minDim = Math.min(width, depth);
  const towerRadius = Math.max(7, minDim * 0.22);
  const collarRadius = Math.max(towerRadius * 1.35, minDim * 0.34);
  const towerH = Math.max(78, minDim * 1.9);
  const towerBaseY = FACTORY_BASE_HEIGHT;

  details.push(detail(
    makeCylinder(factoryFrameMat, collarRadius, 10, 0, FACTORY_BASE_HEIGHT + 5, 0, hexCylinderGeom),
    'low',
  ));
  details.push(detail(
    makeCylinder(chimneyMat, towerRadius, towerH, 0, towerBaseY + towerH / 2, 0),
    'low',
  ));

  const pylonRadius = Math.max(2.3, minDim * 0.055);
  const pylonOffset = Math.min(minDim * 0.38, collarRadius * 1.15);
  const pylonH = towerH * 0.66;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    details.push(detail(
      makeCylinder(
        factoryFrameMat,
        pylonRadius,
        pylonH,
        Math.cos(a) * pylonOffset,
        towerBaseY + pylonH / 2,
        Math.sin(a) * pylonOffset,
      ),
      'medium',
    ));
  }

  details.push(detail(
    makeCylinder(factoryFrameMat, collarRadius * 0.82, 8, 0, towerBaseY + towerH * 0.56, 0, hexCylinderGeom),
    'medium',
  ));

  const capY = towerBaseY + towerH + 5;
  details.push(detail(
    makeCylinder(factoryFrameMat, collarRadius * 0.72, 10, 0, capY, 0, hexCylinderGeom),
    'medium',
  ));

  const nozzleRadius = Math.max(6, towerRadius * 0.95);
  const nozzleY = capY + 5 + nozzleRadius * 0.45;
  const nozzle = makeSphere(
    constructionCoreMat,
    nozzleRadius,
    0,
    nozzleY,
    0,
  );
  details.push(detail(nozzle, 'medium'));

  const unitGhost = new THREE.Mesh(constructionOrbGeom, constructionGhostMat);
  unitGhost.visible = false;
  details.push(detail(unitGhost, 'medium', undefined, 'factoryUnitGhost'));

  const unitCore = new THREE.Mesh(constructionOrbGeom, constructionCoreMat);
  unitCore.visible = false;
  details.push(detail(unitCore, 'high', undefined, 'factoryUnitCore'));

  const buildPulses: THREE.Mesh[] = [];
  for (let i = 0; i < 5; i++) {
    const pulse = new THREE.Mesh(constructionOrbGeom, constructionCoreMat);
    pulse.visible = false;
    buildPulses.push(pulse);
    details.push(detail(pulse, 'medium', 'medium', 'factoryBuildPulse'));
  }

  const sparks: THREE.Mesh[] = [];
  for (let i = 0; i < 5; i++) {
    const spark = new THREE.Mesh(constructionOrbGeom, constructionSparkMat);
    spark.visible = false;
    sparks.push(spark);
    details.push(detail(spark, 'max', undefined, 'factorySpark'));
  }

  return {
    primary,
    details,
    height: FACTORY_BASE_HEIGHT,
    factoryRig: {
      unitGhost,
      unitCore,
      buildPulses,
      sparks,
      nozzleLocal: new THREE.Vector3(
        nozzle.position.x,
        nozzle.position.y,
        nozzle.position.z,
      ),
      bayBaseY: 0,
    },
  };
}

/** Fallback — plain team-primary slab at default height, no detail. */
function buildUnknown(primaryMat: THREE.Material): BuildingShape {
  const primary = new THREE.Mesh(boxGeom, primaryMat);
  return { primary, details: [], height: DEFAULT_HEIGHT };
}

function makeBox(
  material: THREE.Material,
  sx: number,
  sy: number,
  sz: number,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(boxGeom, material);
  mesh.scale.set(sx, sy, sz);
  mesh.position.set(x, y, z);
  return mesh;
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
  const mesh = new THREE.Mesh(factorySphereGeom, material);
  mesh.scale.setScalar(radius);
  mesh.position.set(x, y, z);
  return mesh;
}

function makeSolarShine(
  x: number,
  y: number,
  z: number,
  sx: number,
  sz: number,
  travel: number,
  phase: number,
  angle: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(solarShineGeom, solarShineMat);
  // The mesh is a wide transparent ribbon. The shader fades everything
  // except a soft center streak, so the visible result is a moving line
  // of reflected light rather than a hard rectangular overlay.
  mesh.rotation.x = -Math.PI / 2;
  mesh.rotation.z = angle;
  mesh.scale.set(sx, sz, 1);
  mesh.position.set(x, y, z);
  mesh.userData.solarShine = {
    baseX: x,
    baseZ: z,
    baseScaleX: sx,
    travel,
    phase,
  };
  return mesh;
}

function detail(
  mesh: THREE.Mesh,
  minTier: ConcreteGraphicsQuality,
  maxTier?: ConcreteGraphicsQuality,
  role: BuildingDetailRole = 'static',
): BuildingDetailMesh {
  return { mesh, minTier, maxTier, role };
}

/** Tear down shared geometries + materials on renderer destroy. Callers
 *  (Render3DEntities.destroy) invoke once at app teardown. */
export function disposeBuildingGeoms(): void {
  boxGeom.dispose();
  cylinderGeom.dispose();
  hexCylinderGeom.dispose();
  factorySphereGeom.dispose();
  solarShineGeom.dispose();
  constructionOrbGeom.dispose();
  chimneyMat.dispose();
  solarCellMat.dispose();
  solarShineMat.dispose();
  factoryFrameMat.dispose();
  constructionGhostMat.dispose();
  constructionCoreMat.dispose();
  constructionSparkMat.dispose();
}
