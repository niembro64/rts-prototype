import {
  emitMapInfoAnnexGeometry,
  mapInfoAnnexFlatHeight,
  mapInfoAnnexFlatSurfaceY,
  mapInfoAnnexHalfWidthAt,
  mapInfoAnnexProfileBreakpoints,
  mapInfoAnnexSettledDepth,
  mapInfoAnnexSurfaceY,
  resolveMapInfoAnnexCaptionArea,
  resolveMapInfoAnnexFootprint,
  resolveMapInfoAnnexLiquidRows,
} from './MapInfoAnnex3D';
import {
  resolveCameraTargetBounds,
  resolveCameraTargetBufferDepth,
} from './CameraTargetBounds3D';
import { cameraSurfaceHeight, isOnMapInfoAnnex } from './CameraSurface3D';
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

    // The camera rail has to reach the land we draw. The annex is rendered
    // terrain outside the map square, so an orbit focus railed to the square
    // alone would show the caption without ever letting the player pan onto
    // it.
    const cameraBounds = resolveCameraTargetBounds(mapWidth, mapHeight);
    assertContract(
      cameraBounds.minX <= 0 &&
        cameraBounds.minZ <= 0 &&
        cameraBounds.maxX >= mapWidth &&
        cameraBounds.maxZ >= mapHeight,
      'the camera rail must still cover the whole playable map square',
    );
    assertContract(
      cameraBounds.minX <= annex.minX &&
        cameraBounds.minZ <= annex.minZ &&
        cameraBounds.maxX >= annex.maxX &&
        cameraBounds.maxZ >= annex.maxZ,
      'the camera rail must cover the info annex footprint',
    );
    assertContract(
      cameraBounds.minX <= annex.attachX + annex.outX * annex.depth &&
        cameraBounds.maxX >= annex.attachX + annex.outX * annex.depth &&
        cameraBounds.minZ <= annex.attachZ + annex.outZ * annex.depth &&
        cameraBounds.maxZ >= annex.attachZ + annex.outZ * annex.depth,
      'the camera focus must reach the annex far rim, not just its seam',
    );

    // The union alone gave the annex's edge a deep extension and the other
    // three nothing, so the camera could stand well past one coast and not one
    // unit past its opposite. Every side gets the same standoff buffer.
    const buffer = resolveCameraTargetBufferDepth(mapWidth, mapHeight);
    assertContract(
      buffer > 0,
      'the camera rail buffer must be a real distance, not zero',
    );
    assertContract(
      cameraBounds.minX <= Math.min(0, annex.minX) - buffer + 1e-6 &&
        cameraBounds.minZ <= Math.min(0, annex.minZ) - buffer + 1e-6 &&
        cameraBounds.maxX >= Math.max(mapWidth, annex.maxX) + buffer - 1e-6 &&
        cameraBounds.maxZ >= Math.max(mapHeight, annex.maxZ) + buffer - 1e-6,
      'the camera rail must clear the drawn world by the buffer on all four sides',
    );
    // Standoff, not reach: a buffer as deep as the annex would put as much
    // void past every coast as there is headland past one of them.
    assertContract(
      buffer < annex.depth,
      'the all-sides buffer must stay shallower than the annex it is derived from',
    );

    // ONE height field for the camera. The rail now runs well outside the map
    // square, and the sampler that used to serve the camera answered every
    // point out there with the height of the nearest map edge — a plateau over
    // ground that is drawn as open air, which floors the focus above the
    // surface beneath it and is what let a zoom-out walk its own altitude
    // upward until the gesture throttled itself to nothing.
    const insideMap = cameraSurfaceHeight(
      mapWidth / 2,
      mapHeight / 2,
      mapWidth,
      mapHeight,
    );
    assertContract(
      Number.isFinite(insideMap),
      'the camera surface must be defined everywhere inside the map square',
    );
    const annexMiddleX = annex.attachX + annex.outX * annex.depth * 0.5;
    const annexMiddleZ = annex.attachZ + annex.outZ * annex.depth * 0.5;
    assertContract(
      Number.isFinite(cameraSurfaceHeight(annexMiddleX, annexMiddleZ, mapWidth, mapHeight)),
      'the camera surface must include the info annex — it is drawn land',
    );
    // Halfway into the buffer off the edge OPPOSITE the annex: the side that
    // had no rail at all before, and that has no land under it at any time.
    const voidX = (annex.outX !== 0 ? mapWidth - annex.attachX : annex.attachX)
      - annex.outX * buffer * 0.5;
    const voidZ = (annex.outZ !== 0 ? mapHeight - annex.attachZ : annex.attachZ)
      - annex.outZ * buffer * 0.5;
    assertContract(
      !isOnMapInfoAnnex(voidX, voidZ, mapWidth, mapHeight),
      'the far-side buffer probe must genuinely miss the annex',
    );
    assertContract(
      voidX >= cameraBounds.minX && voidX <= cameraBounds.maxX &&
        voidZ >= cameraBounds.minZ && voidZ <= cameraBounds.maxZ,
      'the buffer off the far coast must be inside the rail — that is the point of it',
    );
    assertContract(
      Number.isNaN(cameraSurfaceHeight(voidX, voidZ, mapWidth, mapHeight)),
      'the camera surface must report NaN over the void, never a phantom coast',
    );
    // The seam is a join, not a step: the annex inherits the map's own edge
    // height at out = 0, so the field either side of the boundary agrees.
    const seamStep = Math.abs(
      cameraSurfaceHeight(
        annex.attachX + annex.outX * 1e-3,
        annex.attachZ + annex.outZ * 1e-3,
        mapWidth,
        mapHeight,
      ) -
        cameraSurfaceHeight(
          annex.attachX - annex.outX * 1e-3,
          annex.attachZ - annex.outZ * 1e-3,
          mapWidth,
          mapHeight,
        ),
    );
    assertContract(
      seamStep < 1,
      'the camera surface must be continuous across the map/annex seam',
    );

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
    // The SEAM is what has to fit, not the body: the flare is the widest the
    // headland ever gets, and it is exactly where it meets the coast.
    assertContract(
      2 * mapInfoAnnexHalfWidthAt(annex, 0)
        <= edgeSpan * MAP_INFO_ANNEX_RENDER_CONFIG.maxEdgeSpanFraction + 1e-9,
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

    // THE RAMP IS A RAMP, NOT A KEEP-OUT ZONE. Letters all rise from one
    // plane, so the caption stands clear of ground that is still easing off
    // the coast — but only as far as that ground actually rises. A coast
    // already at the table's altitude hands the sign the whole headland.
    const margin = annex.depth * 0.12;
    const tolerance = annex.depth * 0.004;
    assertContract(
      mapInfoAnnexSettledDepth(annex, 0, tolerance) === 0
        && mapInfoAnnexSettledDepth(annex, tolerance * 0.5, tolerance) === 0,
      'a coast at the table\'s own altitude must cost the caption nothing',
    );
    const bigDeviation = mapInfoAnnexSettledDepth(annex, 400, tolerance);
    const smallDeviation = mapInfoAnnexSettledDepth(annex, 40, tolerance);
    assertContract(
      bigDeviation > smallDeviation && smallDeviation > 0
        && bigDeviation < annex.blendDepth,
      'a steeper coast must push the caption further out, but never past the ramp',
    );
    // The settled distance is the exact inverse of the ramp's own curve: at
    // it, the surface is within tolerance of the flat table by construction.
    for (const deviation of [40, 400]) {
      const settled = mapInfoAnnexSettledDepth(annex, deviation, tolerance);
      const x = annex.attachX + annex.outX * settled;
      const z = annex.attachZ + annex.outZ * settled;
      const residual = Math.abs(
        mapInfoAnnexSurfaceY(annex, x, z, 0, () => -deviation)
          - mapInfoAnnexFlatSurfaceY(0),
      );
      assertContract(
        Math.abs(residual - tolerance) < tolerance * 1e-6,
        'the settled distance must be where the ramp is exactly one tolerance from flat',
      );
    }

    const minAspect = 1.9;
    for (const nearLimit of [0, annex.blendDepth]) {
      const area = resolveMapInfoAnnexCaptionArea(annex, margin, nearLimit, minAspect);
      const centerOut =
        (area.centerX - annex.attachX) * annex.outX +
        (area.centerZ - annex.attachZ) * annex.outZ;
      assertContract(
        area.width > 0 && area.depth > 0,
        'the caption must have somewhere to stand',
      );
      assertContract(
        centerOut - area.depth / 2 >= nearLimit + margin - 1e-9,
        'the caption area must start past the ramp, one margin clear of it',
      );
      assertContract(
        centerOut + area.depth / 2 <= annex.depth - margin + 1e-9,
        'the caption area must stay inside the annex, one margin clear of its far edge',
      );
      // Centred on the headland it stands on, whatever depth it settles at:
      // a sign in one half of its own island reads as a mistake.
      assertContract(
        Math.abs(centerOut - (nearLimit + (annex.depth - nearLimit) / 2)) < 1e-9,
        'the caption area must stay centred on the land left to it',
      );
      // And never squarer than a sign can be set in, with every corner —
      // the far pair, where the headland is narrowest — standing on land.
      assertContract(
        area.width / area.depth >= minAspect - 1e-6,
        'the caption area must never come out squarer than a caption can fill',
      );
      for (const corner of [-1, 1]) {
        assertContract(
          area.width / 2
            <= mapInfoAnnexHalfWidthAt(annex, centerOut + corner * area.depth / 2) + 1e-9,
          'no corner of the caption area may hang over the headland\'s taper',
        );
      }
    }

    // THE SILHOUETTE. Each flank is divided in three: the outer third's
    // corner is cut away and the identical triangle added back over the inner
    // third, so the headland loses a corner to open water and gains one
    // filling the inside corner against the map's edge.
    const band = annex.cornerBandDepth;
    const cut = annex.cornerCut;
    assertContract(
      Math.abs(band - annex.depth / 3) < 1e-9 && cut > 0,
      'each flank must be divided in three, with a real corner to cut',
    );
    assertContract(
      Math.abs(mapInfoAnnexHalfWidthAt(annex, 0) - (annex.width / 2 + cut)) < 1e-9
        && Math.abs(mapInfoAnnexHalfWidthAt(annex, band) - annex.width / 2) < 1e-9
        && Math.abs(mapInfoAnnexHalfWidthAt(annex, annex.depth - band) - annex.width / 2) < 1e-9
        && Math.abs(mapInfoAnnexHalfWidthAt(annex, annex.depth) - (annex.width / 2 - cut)) < 1e-9,
      'the silhouette must flare by the cut at the seam, run parallel, and taper by it at the rim',
    );
    // Chop equals fill: the two diagonals are the same line moved, so the
    // headland covers exactly the ground its rectangle did.
    for (const fraction of [0.2, 0.5, 0.8]) {
      const filled = mapInfoAnnexHalfWidthAt(annex, fraction * band) - annex.width / 2;
      const chopped = annex.width / 2
        - mapInfoAnnexHalfWidthAt(annex, annex.depth - band + fraction * band);
      assertContract(
        Math.abs(filled - (cut - chopped)) < 1e-9,
        'the corner cut away and the corner added back must be the same triangle',
      );
    }
    assertContract(
      mapInfoAnnexHalfWidthAt(annex, -100) === mapInfoAnnexHalfWidthAt(annex, 0)
        && mapInfoAnnexHalfWidthAt(annex, annex.depth + 100)
          === mapInfoAnnexHalfWidthAt(annex, annex.depth),
      'the profile must clamp past its own ends rather than run off into nothing',
    );

    // The liquid grows around the SILHOUETTE by the same overhang every map
    // edge gets — measured perpendicular to whatever edge it stands off, so a
    // cut corner carries the same border as a flank — and stops at the map's
    // own liquid border.
    const overhang = getFloatingWaterOverhang();
    const rows = resolveMapInfoAnnexLiquidRows(annex, overhang, 400);
    assertContract(
      rows.length >= 2 && Math.abs(rows[0].out - overhang) < 1e-9,
      "the arm must start on the map's own liquid border, not lay a second sheet over it",
    );
    assertContract(
      Math.abs(rows[rows.length - 1].out - (annex.depth + overhang)) < 1e-9,
      "the liquid must clear the annex's far rim by the map's own overhang",
    );
    for (let index = 1; index < rows.length; index++) {
      assertContract(
        rows[index].out > rows[index - 1].out,
        'the arm rows must march outward',
      );
    }
    // The border's own kinks are its miters — the corners of the headland
    // pushed out — and they do not sit above the land's corners: a convex one
    // reaches past, a reflex one falls short. So each run is measured between
    // the miters that actually bound it, which is also the only way this
    // holds on a small map, where a 200-unit border's miters can swallow the
    // parallel run whole.
    const offsetKinks = mapInfoAnnexProfileBreakpoints(annex, overhang);
    assertContract(
      offsetKinks.length === 4 && offsetKinks[1] < offsetKinks[2],
      'the offset profile must kink once per corner, in order',
    );
    // Across the parallel middle, "perpendicular to the edge" and "across the
    // annex" are the same measurement.
    assertContract(
      Math.abs(
        mapInfoAnnexHalfWidthAt(annex, (offsetKinks[1] + offsetKinks[2]) / 2, overhang)
          - (annex.width / 2 + overhang),
      ) < 1e-9,
      'the liquid border must be one overhang across the parallel flanks',
    );
    // Across a CUT CORNER they are not, and that is the whole point: the land
    // and its border are parallel lines there, so the distance between them
    // is the along-axis gap foreshortened by the diagonal. Offsetting along
    // the axis instead leaves it short by exactly that factor — the pinch a
    // bounding-box arm puts in every corner this shape exists to soften.
    // Sampled where the land's diagonal and its own offset are BOTH the
    // active edge — the offset run reaches past the land's at either end,
    // and out there the land has clamped to its rim and the two are no
    // longer the parallel pair this measures.
    const diagonalRuns: ReadonlyArray<readonly [number, number]> = [
      [Math.max(0, offsetKinks[0]), Math.min(band, offsetKinks[1])],
      [
        Math.max(annex.depth - band, offsetKinks[2]),
        Math.min(annex.depth, offsetKinks[3]),
      ],
    ];
    for (const [low, high] of diagonalRuns) {
      assertContract(high > low, 'each diagonal must survive its own offset');
      const out = (low + high) / 2;
      const gap = mapInfoAnnexHalfWidthAt(annex, out, overhang)
        - mapInfoAnnexHalfWidthAt(annex, out);
      assertContract(
        Math.abs(gap * band / Math.hypot(band, cut) - overhang) < 1e-6,
        'the liquid border must be one overhang PERPENDICULAR to a cut corner',
      );
    }
    // The rows the mesh is built from are that profile, sampled.
    for (const row of rows) {
      assertContract(
        Math.abs(row.halfWidth - mapInfoAnnexHalfWidthAt(annex, row.out, overhang)) < 1e-9,
        'every arm row must sit on the offset profile',
      );
    }
    assertContract(
      mapInfoAnnexProfileBreakpoints(annex, overhang).every(
        (out) => rows.some((row) => Math.abs(row.out - out) < 1e-6) || out < overhang,
      ),
      'the arm must carry a row on every kink, or its diagonals come out as staircases',
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
  // Every wall faces open water. The side the annex grew out of is left open
  // on purpose: the map's own wall already closes that plane, from inside the
  // annex's solid — so nothing may face back at the coast.
  const wallNormals = walls.map((vertex) => ({
    out: vertex.nx * annex.outX + vertex.nz * annex.outZ,
    along: vertex.nx * annex.alongX + vertex.nz * annex.alongZ,
  }));
  assertContract(
    wallNormals.every((normal) => normal.out >= -1e-6),
    "no annex wall may face back at the coast it grew out of — that side is open",
  );
  assertContract(
    wallNormals.some((normal) => normal.out > 0.999)
      && wallNormals.some((normal) => normal.along > 0.999)
      && wallNormals.some((normal) => normal.along < -0.999),
    'the far rim and both parallel flanks must each be walled',
  );
  // The fill and the cut are the same diagonal on each flank, so there are
  // exactly two of these directions and both lean out to open water.
  const acrossDiagonal =
    annex.cornerBandDepth / Math.hypot(annex.cornerBandDepth, annex.cornerCut);
  const diagonals = wallNormals.filter(
    (normal) => Math.abs(Math.abs(normal.along) - acrossDiagonal) < 1e-6,
  );
  assertContract(
    diagonals.length > 0
      && diagonals.some((normal) => normal.along > 0)
      && diagonals.some((normal) => normal.along < 0)
      && diagonals.every((normal) => normal.out > 0),
    'the cut corner and the fill must be walled on the diagonal, leaning out to open water',
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
