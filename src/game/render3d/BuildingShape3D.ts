// BuildingShape3D — per-type 3D geometry for player-built buildings.
//
// Each building type gets its own recognizable silhouette, built from a
// team-colored primary slab plus LOD-tagged type-specific accents:
//
//   solar   — raised photovoltaic modules. No coplanar/near-coplanar
//             paper-thin overlays, so distant zoom levels do not shimmer.
//   factory — fully open construction pad: low team deck, machinery
//             plinths, tower/nozzle, build ghost, and spray particles.
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
  sparks: THREE.Mesh[];
  nozzleLocal: THREE.Vector3;
  targetLocal: THREE.Vector3;
  bayBaseY: number;
};

/** What the caller receives back from `buildBuildingShape()`. */
export type BuildingShape = {
  /** Team-primary-colored main slab. Scaled per-instance at the call
   *  site to the building's (width, height, depth). */
  primary: THREE.Mesh;
  /** Decorative accent meshes already positioned relative to the primary
   *  slab. Each declares the client LOD tier range where it should exist. */
  details: BuildingDetailMesh[];
  /** The building's render height so the caller can position the
   *  primary slab correctly on the ground plane. */
  height: number;
  factoryRig?: FactoryConstructionRig;
};

// ── Standard dimensions ────────────────────────────────────────────────
/** Default fallback block height for unknown buildings. */
const DEFAULT_HEIGHT = 120;
/** Solar collector silhouette is much shorter and wider — reads as a
 *  flat panel array, not a building. */
const SOLAR_HEIGHT = 30;
/** Factory primary is just the deck; the open-air frame/tower are details. */
const FACTORY_BASE_HEIGHT = 24;

// ── Shared cached geometries ───────────────────────────────────────────
// Unit box reused for all building slabs + accents; each caller scales
// it to the right dimensions. Shared across instances so every factory
// and every solar uses the same backing BufferGeometry.
const boxGeom = new THREE.BoxGeometry(1, 1, 1);

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
const factoryDarkDeckMat = new THREE.MeshLambertMaterial({ color: 0x20242a });
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

/** Factory: fully open construction pad. No walls around the build spot;
 *  the silhouette comes from the machinery pad and construction tower. */
function buildFactory(
  width: number,
  depth: number,
  primaryMat: THREE.Material,
): BuildingShape {
  const primary = new THREE.Mesh(boxGeom, primaryMat);
  const details: BuildingDetailMesh[] = [];

  const minDim = Math.min(width, depth);
  const plinthW = Math.max(18, minDim * 0.11);
  const plinthH = 18;
  const plinthX = width * 0.34;
  const plinthZ = depth * 0.28;

  // LOW LOD: open pad + squat machinery plinths only. These give the
  // factory footprint without enclosing the unit build spot.
  for (const x of [-plinthX, plinthX]) {
    for (const z of [-plinthZ, plinthZ]) {
      details.push(detail(
        makeBox(factoryFrameMat, plinthW, plinthH, plinthW, x, FACTORY_BASE_HEIGHT + plinthH / 2, z),
        'low',
      ));
    }
  }

  const deckInset = makeBox(
    factoryDarkDeckMat,
    width * 0.56,
    5,
    depth * 0.5,
    0,
    FACTORY_BASE_HEIGHT + 3,
    0,
  );
  details.push(detail(deckInset, 'medium'));

  details.push(detail(makeBox(chimneyMat, width * 0.42, 8, minDim * 0.06, 0, FACTORY_BASE_HEIGHT + 10, -depth * 0.16), 'medium'));
  details.push(detail(makeBox(chimneyMat, minDim * 0.06, 8, depth * 0.38, -width * 0.18, FACTORY_BASE_HEIGHT + 10, 0), 'medium'));
  details.push(detail(makeBox(chimneyMat, minDim * 0.06, 8, depth * 0.38, width * 0.18, FACTORY_BASE_HEIGHT + 10, 0), 'medium'));

  const towerW = Math.max(18, minDim * 0.105);
  const towerH = 128;
  const towerX = -width * 0.28;
  const towerZ = -depth * 0.3;
  const towerBaseY = FACTORY_BASE_HEIGHT + plinthH;
  details.push(detail(
    makeBox(chimneyMat, towerW, towerH, towerW, towerX, towerBaseY + towerH / 2, towerZ),
    'medium',
  ));
  details.push(detail(
    makeBox(factoryFrameMat, towerW * 1.45, towerW * 0.42, towerW * 1.45, towerX, towerBaseY + towerW * 0.21, towerZ),
    'medium',
  ));

  const boomY = towerBaseY + towerH - towerW * 0.4;
  const boomX = towerX * 0.46;
  details.push(detail(
    makeBox(factoryFrameMat, Math.abs(towerX) + width * 0.2, towerW * 0.5, towerW * 0.46, boomX, boomY, towerZ),
    'medium',
  ));
  details.push(detail(
    makeBox(chimneyMat, towerW * 0.38, towerH * 0.52, towerW * 0.38, towerX + towerW * 0.52, towerBaseY + towerH * 0.34, towerZ + towerW * 0.52),
    'high',
  ));
  const nozzle = makeBox(
    constructionCoreMat,
    towerW * 0.78,
    towerW * 0.62,
    towerW * 0.78,
    width * 0.05,
    boomY - towerW * 0.45,
    towerZ,
  );
  details.push(detail(nozzle, 'high'));

  const unitGhost = new THREE.Mesh(constructionOrbGeom, constructionGhostMat);
  unitGhost.visible = false;
  details.push(detail(unitGhost, 'medium', undefined, 'factoryUnitGhost'));

  const unitCore = new THREE.Mesh(constructionOrbGeom, constructionCoreMat);
  unitCore.visible = false;
  details.push(detail(unitCore, 'high', undefined, 'factoryUnitCore'));

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
      sparks,
      nozzleLocal: new THREE.Vector3(
        nozzle.position.x,
        nozzle.position.y - towerW * 0.2,
        nozzle.position.z,
      ),
      targetLocal: new THREE.Vector3(0, FACTORY_BASE_HEIGHT + 16, depth * 0.02),
      bayBaseY: FACTORY_BASE_HEIGHT,
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
  solarShineGeom.dispose();
  constructionOrbGeom.dispose();
  chimneyMat.dispose();
  solarCellMat.dispose();
  solarShineMat.dispose();
  factoryFrameMat.dispose();
  factoryDarkDeckMat.dispose();
  constructionGhostMat.dispose();
  constructionCoreMat.dispose();
  constructionSparkMat.dispose();
}
