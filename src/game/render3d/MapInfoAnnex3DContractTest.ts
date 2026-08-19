import {
  emitMapInfoAnnexGeometry,
  mapInfoAnnexFlatHeight,
  mapInfoAnnexFlatSurfaceY,
  mapInfoAnnexSurfaceY,
  resolveMapInfoAnnexCaptionArea,
  resolveMapInfoAnnexFootprint,
  resolveMapInfoAnnexLiquidRect,
} from './MapInfoAnnex3D';
import { getFloatingWaterOverhang } from './WorldBoxGeometry3D';
import { LAND_TILE_GROUND_LIFT, MAP_INFO_ANNEX_RENDER_CONFIG } from '@/config';
import { getAllyTeamBaseAngle } from '../sim/playerLayout';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[map info annex contract] ${message}`);
}

/** A gently rolling stand-in for the map's terrain: enough curvature that a
 *  flat annex could not accidentally match it, no WASM and no baked mesh. */
function sampleTestTerrainHeight(x: number, z: number): number {
  return 60 * Math.sin(x / 900) + 40 * Math.cos(z / 700) - 30;
}

type EmittedVertex = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly kind: 'surface' | 'wall';
};

export function runMapInfoAnnex3DContractTest(): void {
  // Smallest and largest stock map axes, square and oblong.
  for (const [mapWidth, mapHeight] of [
    [1400, 1400],
    [10600, 10600],
    [23800, 7000],
    [7000, 23800],
  ] as const) {
    const annex = resolveMapInfoAnnexFootprint(mapWidth, mapHeight);

    // The annex belongs to ally team 0, at every side count: the layout's
    // first-side angle is one constant, and the annex must be phased off it
    // rather than off the edge that constant happens to select today.
    for (const allyTeamCount of [1, 2, 3, 4, 6]) {
      const angle = getAllyTeamBaseAngle(0, allyTeamCount);
      assertContract(
        annex.outX * Math.cos(angle) + annex.outZ * Math.sin(angle) > 0.99,
        'the annex must hang off the map edge ally team 0 backs onto',
      );
    }

    assertContract(
      annex.width > 0 && annex.depth > 0 && annex.blendDepth > 0,
      'the annex must be a real rectangle with a real blend band',
    );
    assertContract(
      annex.blendDepth < annex.depth,
      'the blend band must leave a flat table for the caption to stand on',
    );
    assertContract(
      Math.abs(annex.alongX + annex.outZ) < 1e-9 &&
        Math.abs(annex.alongZ - annex.outX) < 1e-9,
      'the along axis must be the out axis turned a quarter, so grids wind upward',
    );

    // It touches the map along exactly one side and lies entirely outside it.
    const outsideDepth =
      annex.outX !== 0
        ? annex.outX > 0
          ? annex.minX - mapWidth
          : -annex.maxX
        : annex.outZ > 0
          ? annex.minZ - mapHeight
          : -annex.maxZ;
    assertContract(
      Math.abs(outsideDepth) < 1e-9,
      'the annex must be flush against the map edge, neither overlapping it nor floating off it',
    );
    const edgeSpan = annex.outX === 0 ? mapWidth : mapHeight;
    assertContract(
      annex.width <= edgeSpan * MAP_INFO_ANNEX_RENDER_CONFIG.maxEdgeSpanFraction + 1e-9,
      'the annex must never take over the coast it hangs off',
    );
    assertContract(
      Math.abs(
        annex.depth / annex.width -
          MAP_INFO_ANNEX_RENDER_CONFIG.depthMapFraction /
            MAP_INFO_ANNEX_RENDER_CONFIG.widthMapFraction,
      ) < 1e-9,
      'a map that forces the annex smaller must scale it, not squash it',
    );
    const attachedSpanCenter =
      annex.outX === 0 ? (annex.minX + annex.maxX) / 2 : (annex.minZ + annex.maxZ) / 2;
    assertContract(
      Math.abs(attachedSpanCenter - (annex.outX === 0 ? annex.attachX : annex.attachZ)) < 1e-9,
      'the annex must be centred on the midpoint of its edge — the point directly behind team 1',
    );

    // The surface is the map's own edge profile at the seam and one flat
    // table past the blend. The seam equality is what makes the two meshes
    // meet without a crack, so it is exact, not approximate.
    const flatHeight = mapInfoAnnexFlatHeight(annex, sampleTestTerrainHeight);
    assertContract(
      flatHeight === sampleTestTerrainHeight(annex.attachX, annex.attachZ),
      'the flat table must sit at the terrain height of the attachment point',
    );
    for (const across of [-0.5, -0.2, 0, 0.3, 0.5]) {
      const seamX = annex.attachX + annex.alongX * across * annex.width;
      const seamZ = annex.attachZ + annex.alongZ * across * annex.width;
      assertContract(
        mapInfoAnnexSurfaceY(annex, seamX, seamZ, flatHeight, sampleTestTerrainHeight) ===
          sampleTestTerrainHeight(seamX, seamZ) + LAND_TILE_GROUND_LIFT,
        'the seam row must be the map edge height exactly, or the meshes crack apart',
      );
      const farX = seamX + annex.outX * annex.depth;
      const farZ = seamZ + annex.outZ * annex.depth;
      assertContract(
        Math.abs(
          mapInfoAnnexSurfaceY(annex, farX, farZ, flatHeight, sampleTestTerrainHeight) -
            mapInfoAnnexFlatSurfaceY(flatHeight),
        ) < 1e-9,
        'everything past the blend band must be one flat table',
      );
    }

    // The caption's ground is the flat part only: letters all rise from one
    // plane, so ground still easing under them would leave them floating.
    const margin = annex.depth * 0.12;
    const area = resolveMapInfoAnnexCaptionArea(annex, margin);
    const areaNearOut =
      (area.centerX - annex.attachX) * annex.outX +
      (area.centerZ - annex.attachZ) * annex.outZ -
      area.depth / 2;
    assertContract(
      area.width > 0 && area.depth > 0,
      'the caption must have somewhere to stand',
    );
    assertContract(
      areaNearOut >= annex.blendDepth - 1e-9,
      'the caption area must start past the blend band, on the flat table',
    );
    assertContract(
      areaNearOut + area.depth <= annex.depth - margin + 1e-9,
      'the caption area must stay inside the annex, one margin clear of its far edge',
    );

    // The liquid grows around the annex by the same overhang every map edge
    // gets, and stops at the map's own liquid border.
    const overhang = getFloatingWaterOverhang();
    const arm = resolveMapInfoAnnexLiquidRect(annex, overhang, mapWidth, mapHeight);
    const farFace =
      annex.outX !== 0
        ? annex.outX > 0
          ? arm.maxX - annex.maxX
          : annex.minX - arm.minX
        : annex.outZ > 0
          ? arm.maxZ - annex.maxZ
          : annex.minZ - arm.minZ;
    assertContract(
      Math.abs(farFace - overhang) < 1e-9,
      "the liquid must clear the annex's far edge by exactly the map's own overhang",
    );
    const flankLow = annex.outX === 0 ? annex.minX - arm.minX : annex.minZ - arm.minZ;
    const flankHigh = annex.outX === 0 ? arm.maxX - annex.maxX : arm.maxZ - annex.maxZ;
    assertContract(
      Math.abs(flankLow - overhang) < 1e-9 && Math.abs(flankHigh - overhang) < 1e-9,
      'both flanks must carry the same overhang as the far edge',
    );
    const sharedFace =
      annex.outX !== 0
        ? annex.outX > 0
          ? arm.minX
          : arm.maxX
        : annex.outZ > 0
          ? arm.minZ
          : arm.maxZ;
    assertContract(
      Math.abs(
        sharedFace -
          ((annex.outX !== 0 ? annex.attachX : annex.attachZ) +
            (annex.outX !== 0 ? annex.outX : annex.outZ) * overhang),
      ) < 1e-9,
      "the arm must stop on the map's own liquid border, not lay a second sheet over it",
    );
  }

  // Emission: the annex has to come out as a closed, correctly wound piece of
  // the terrain mesh, because that is the mesh it is appended to.
  const mapWidth = 10600;
  const mapHeight = 10600;
  const annex = resolveMapInfoAnnexFootprint(mapWidth, mapHeight);
  const floorY = -2650;
  const vertices: EmittedVertex[] = [];
  const triangles: Array<readonly [number, number, number]> = [];
  emitMapInfoAnnexGeometry(
    annex,
    {
      flatHeight: mapInfoAnnexFlatHeight(annex, sampleTestTerrainHeight),
      sampleTerrainHeight: sampleTestTerrainHeight,
      step: 200,
      floorY,
      walls: true,
      cullAtOrBelowY: null,
    },
    {
      pushSurfaceVertex: (x, y, z, nx, ny, nz): number => {
        vertices.push({ x, y, z, nx, ny, nz, kind: 'surface' });
        return vertices.length - 1;
      },
      pushWallVertex: (x, y, z, nx, nz): number => {
        vertices.push({ x, y, z, nx, ny: 0, nz, kind: 'wall' });
        return vertices.length - 1;
      },
      pushTriangle: (a, b, c): void => {
        triangles.push([a, b, c]);
      },
    },
  );
  assertContract(
    vertices.length > 0 && triangles.length > 0,
    'the annex must emit geometry',
  );
  let surfaceTriangles = 0;
  let wallTriangles = 0;
  for (const [ia, ib, ic] of triangles) {
    const a = vertices[ia];
    const b = vertices[ib];
    const c = vertices[ic];
    const ux = b.x - a.x;
    const uy = b.y - a.y;
    const uz = b.z - a.z;
    const vx = c.x - a.x;
    const vy = c.y - a.y;
    const vz = c.z - a.z;
    const gx = uy * vz - uz * vy;
    const gy = uz * vx - ux * vz;
    const gz = ux * vy - uy * vx;
    const length = Math.hypot(gx, gy, gz);
    assertContract(length > 1e-6, 'the annex must emit no degenerate triangles');
    const dot = (gx * a.nx + gy * a.ny + gz * a.nz) / length;
    if (a.kind === 'surface') {
      surfaceTriangles++;
      // Clockwise from above, matching the authoritative terrain mesh: the
      // DoubleSide terrain material negates the shading normal on a back
      // face, so an annex wound the other way is lit by the sun on top of
      // the same baked shade and renders several times brighter than the
      // seabed it joins. The authored vertex normal still points UP, exactly
      // as the map's own surface vertices do.
      assertContract(
        gy / length < -0.5 && dot < -0.9,
        "every annex top triangle must carry the terrain mesh's own winding",
      );
    } else {
      wallTriangles++;
      assertContract(
        Math.abs(gy) / length < 1e-6 && dot > 0.999,
        'every annex wall must be a vertical face wound to agree with its outward normal',
      );
    }
  }
  assertContract(
    surfaceTriangles > 0 && wallTriangles > 0,
    'the annex must emit both a top and the walls that close it',
  );

  const walls = vertices.filter((vertex) => vertex.kind === 'wall');
  assertContract(
    walls.some((vertex) => Math.abs(vertex.y - floorY) < 1e-9),
    'the annex walls must reach the world-box floor the map slab uses',
  );
  assertContract(
    vertices.every((vertex) => vertex.y >= floorY - 1e-9),
    'nothing in the annex may hang below the world-box floor',
  );
  // The outward normals are the three sides that face open water. The side
  // the annex grew out of is left open on purpose: the map's own wall already
  // closes that plane, from inside the annex's solid.
  const wallNormals = new Set(
    walls.map((vertex) => `${Math.round(vertex.nx)}:${Math.round(vertex.nz)}`),
  );
  assertContract(
    wallNormals.size === 3 &&
      !wallNormals.has(`${Math.round(-annex.outX)}:${Math.round(-annex.outZ)}`),
    'the annex must wall its three outer sides and leave the attached side open',
  );

  // Emission with the walls off is the terrain's own side-wall graphics
  // option, and must leave the top intact rather than dropping the annex.
  const topOnly: Array<readonly [number, number, number]> = [];
  emitMapInfoAnnexGeometry(
    annex,
    {
      flatHeight: mapInfoAnnexFlatHeight(annex, sampleTestTerrainHeight),
      sampleTerrainHeight: sampleTestTerrainHeight,
      step: 200,
      floorY,
      walls: false,
      cullAtOrBelowY: null,
    },
    {
      pushSurfaceVertex: (): number => 0,
      pushWallVertex: (): number => {
        throw new Error('[map info annex contract] walls: false must emit no wall vertices');
      },
      pushTriangle: (a, b, c): void => {
        topOnly.push([a, b, c]);
      },
    },
  );
  assertContract(
    topOnly.length === surfaceTriangles,
    'turning the side walls off must keep every top triangle',
  );
}
