// BuildingShape3D — per-type 3D geometry for player-built buildings.
//
// Each building type gets its own recognizable silhouette, built from a
// team-colored primary slab plus small type-specific accents that match
// the 2D `BuildingRenderer.ts` cues:
//
//   solar   — short flat panel with a grid of darker cells on top.
//             (2D draws a 3×2 cell grid with shimmer highlights.)
//   factory — full-height block with a corner chimney rising above and
//             a dark "machinery" inset on the front face.
//             (2D draws the inset + gears + chimney smokestack.)
//
// Shapes are additive — the caller owns a `THREE.Group` containing the
// whole building and plugs in the primary + detail meshes returned by
// `buildBuildingShape()`. Geometries and materials are shared per-team
// via the material cache that Render3DEntities already maintains, so no
// new allocation pressure.

import * as THREE from 'three';

/** Short building types we have art for. Unknown types fall back to a
 *  plain primary-color slab (same as before). */
export type BuildingShapeType = 'solar' | 'factory' | 'unknown';

/** What the caller receives back from `buildBuildingShape()`. */
export type BuildingShape = {
  /** Team-primary-colored main slab. Scaled per-instance at the call
   *  site to the building's (width, height, depth). */
  primary: THREE.Mesh;
  /** Decorative accent meshes (chimney, solar cells, etc.) already
   *  positioned relative to the primary slab — caller just needs to add
   *  them to the same group and they'll move/rotate with the building. */
  details: THREE.Mesh[];
  /** The building's render height so the caller can position the
   *  primary slab correctly on the ground plane. Most types use the
   *  standard 120 but `solar` is shorter so it reads as a flat panel. */
  height: number;
};

// ── Standard dimensions ────────────────────────────────────────────────
/** Default tall-block height for most buildings (factory, etc.). */
const DEFAULT_HEIGHT = 120;
/** Solar collector silhouette is much shorter and wider — reads as a
 *  flat panel array, not a building. */
const SOLAR_HEIGHT = 30;

// ── Shared cached geometries ───────────────────────────────────────────
// Unit box reused for all building slabs + accents; each caller scales
// it to the right dimensions. Shared across instances so every factory
// and every solar uses the same backing BufferGeometry.
const boxGeom = new THREE.BoxGeometry(1, 1, 1);

// Darker shared material for "machinery inset" and solar cell grid — a
// single dark gray works for both roles and keeps the material count
// low. Not team-tinted on purpose; these are mechanical details, not
// team surfaces.
const darkMat = new THREE.MeshLambertMaterial({ color: 0x1a1a1a });
// Slightly lighter gray for the chimney — stands out against the dark
// inset and against the team primary.
const chimneyMat = new THREE.MeshLambertMaterial({ color: 0x555555 });
// Solar-panel blue for cell fill — tint tilted cool so it reads
// "photovoltaic" rather than "team armor".
const solarCellMat = new THREE.MeshLambertMaterial({ color: 0x1a3050 });

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
  const details: THREE.Mesh[] = [];

  // Cell grid on top. 3 wide × 2 deep like the 2D version. Each cell is
  // a thin dark slab inset from the slab edges — the tile margin creates
  // the "panel frame" look.
  const MARGIN = 0.08; // fraction of width/depth
  const GAP = 0.05;    // fraction, between cells
  const cellsX = 3, cellsZ = 2;
  const availW = width * (1 - 2 * MARGIN);
  const availD = depth * (1 - 2 * MARGIN);
  const gapW = availW * GAP;
  const gapD = availD * GAP;
  const cellW = (availW - gapW * (cellsX - 1)) / cellsX;
  const cellD = (availD - gapD * (cellsZ - 1)) / cellsZ;
  const startX = -width / 2 + width * MARGIN + cellW / 2;
  const startZ = -depth / 2 + depth * MARGIN + cellD / 2;
  const cellH = 2;     // cells sit just above the slab top
  const slabTop = SOLAR_HEIGHT;
  for (let cz = 0; cz < cellsZ; cz++) {
    for (let cx = 0; cx < cellsX; cx++) {
      const cell = new THREE.Mesh(boxGeom, solarCellMat);
      cell.scale.set(cellW, cellH, cellD);
      cell.position.set(
        startX + cx * (cellW + gapW),
        slabTop + cellH / 2,
        startZ + cz * (cellD + gapD),
      );
      details.push(cell);
    }
  }

  return { primary, details, height: SOLAR_HEIGHT };
}

/** Factory: full-height team-colored block, with a dark machinery inset
 *  on the +X face (front) and a lighter chimney rising out of the
 *  back-right corner. Matches the 2D silhouette without trying to model
 *  the gears — gears read poorly at typical camera distance anyway. */
function buildFactory(
  width: number,
  depth: number,
  primaryMat: THREE.Material,
): BuildingShape {
  const primary = new THREE.Mesh(boxGeom, primaryMat);
  const details: THREE.Mesh[] = [];

  // Machinery inset — a dark slab covering most of the front face,
  // slightly inset so the team-color frame is still visible. Sits on
  // +X (unit forward) since factories face outward from the player's
  // spawn corner.
  const insetMargin = 0.15;        // of width/height/depth
  const insetW = width * (1 - insetMargin * 2);
  const insetH = DEFAULT_HEIGHT * (1 - insetMargin * 2);
  const insetDepth = 2;            // very thin: pokes out just enough to
                                   // catch light and read as a panel.
  const inset = new THREE.Mesh(boxGeom, darkMat);
  inset.scale.set(insetW, insetH, insetDepth);
  inset.position.set(0, DEFAULT_HEIGHT / 2, depth / 2 + insetDepth / 2);
  details.push(inset);

  // Chimney — slim box rising from the back-right corner of the roof.
  // Height tuned so its silhouette reads against the sky without
  // dominating the building.
  const chimneyW = Math.min(width, depth) * 0.12;
  const chimneyH = DEFAULT_HEIGHT * 0.5;
  const chimney = new THREE.Mesh(boxGeom, chimneyMat);
  chimney.scale.set(chimneyW, chimneyH, chimneyW);
  chimney.position.set(
    width / 2 - chimneyW,
    DEFAULT_HEIGHT + chimneyH / 2,
    -depth / 2 + chimneyW,
  );
  details.push(chimney);

  return { primary, details, height: DEFAULT_HEIGHT };
}

/** Fallback — plain team-primary slab at default height, no detail. */
function buildUnknown(primaryMat: THREE.Material): BuildingShape {
  const primary = new THREE.Mesh(boxGeom, primaryMat);
  return { primary, details: [], height: DEFAULT_HEIGHT };
}

/** Tear down shared geometries + materials on renderer destroy. Callers
 *  (Render3DEntities.destroy) invoke once at app teardown. */
export function disposeBuildingGeoms(): void {
  boxGeom.dispose();
  darkMat.dispose();
  chimneyMat.dispose();
  solarCellMat.dispose();
}
