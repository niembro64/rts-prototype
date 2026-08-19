// MapPresetLabel3D — the stock-preset caption, standing on its own slab of
// terrain just outside the map, at the (0, 0) corner (the near-left corner at
// the default camera yaw, where the camera sits on the -Z side looking toward
// +Z). It is map signage, not HUD: it lives in world space, so it is occluded
// by terrain and grows/shrinks with zoom like everything else.
//
// The world is a floating box, so a caption painted on the ground plane
// outside it hung in empty space. It now sits on a plinth cut from the same
// substances the world box is made of — grass on top, rock down the sides —
// and the letters are EXTRUDED off that top face rather than only printed on
// it: the painted caption stays underneath as the readable base (mipmapped
// and anisotropic, which raw geometry is not), and the extrusion adds the
// relief on top of exactly the same glyph shapes.
//
// Exact presets show their authored name; changed settings show CUSTOM and
// continue describing the live map. One pooled canvas is repainted on change;
// there is no per-frame work (the meshes have no update hook).

import * as THREE from 'three';
import { MAP_PRESET_LABEL_RENDER_CONFIG } from '@/config';
import { COLORS } from '@/colorsConfig';
import { NAME_LABEL_FONT_FAMILY } from '@/nameLabelConfig';
import { WATER_LEVEL } from '../sim/Terrain';
import {
  groupNestedContours,
  traceAlphaMaskContours,
  type MaskPolygon,
} from './AlphaMaskExtrusion3D';
import { applyTerrainSubstanceMaterial } from './TerrainSubstanceMaterial3D';
import type { MapPresetLabelLines, MapPresetLabelTarget } from './presetMapLabel';
import { TRANSPARENT_RENDER_ORDER_3D } from './TransparentRenderOrder3D';

const STYLE = {
  titleFontPx: MAP_PRESET_LABEL_RENDER_CONFIG.titleFontPx,
  infoFontPx: MAP_PRESET_LABEL_RENDER_CONFIG.infoFontPx,
  lineGapPx: MAP_PRESET_LABEL_RENDER_CONFIG.lineGapPx,
  canvasPadPx: MAP_PRESET_LABEL_RENDER_CONFIG.canvasPadPx,
  strokeWidthPx: MAP_PRESET_LABEL_RENDER_CONFIG.strokeWidthPx,
  blockHeightMapFraction: MAP_PRESET_LABEL_RENDER_CONFIG.blockHeightMapFraction,
  cornerMarginMapFraction: MAP_PRESET_LABEL_RENDER_CONFIG.cornerMarginMapFraction,
  groundLift: MAP_PRESET_LABEL_RENDER_CONFIG.groundLift,
  plinthPadBlockFraction: MAP_PRESET_LABEL_RENDER_CONFIG.plinthPadBlockFraction,
  plinthThicknessBlockFraction:
    MAP_PRESET_LABEL_RENDER_CONFIG.plinthThicknessBlockFraction,
  letterDepthTitleFraction: MAP_PRESET_LABEL_RENDER_CONFIG.letterDepthTitleFraction,
  letterMaskSupersample: MAP_PRESET_LABEL_RENDER_CONFIG.letterMaskSupersample,
  letterMaskSimplifyPx: MAP_PRESET_LABEL_RENDER_CONFIG.letterMaskSimplifyPx,
  fillColor: COLORS.ui.mapPresetLabel.fillColor,
  strokeColor: COLORS.ui.mapPresetLabel.strokeColor,
};

/** Ground-plane orientation for a readable sign at the default -Z camera.
 *  Canvas right maps toward world -X (screen-right from that camera), canvas
 *  top maps toward +Z, and the painted front normal points upward — so the
 *  plinth hangs down local -Z and the letters extrude up local +Z. */
export const MAP_PRESET_LABEL_ROTATION_X = -Math.PI / 2;
export const MAP_PRESET_LABEL_ROTATION_Z = Math.PI;

/** Clearance between the stacked coplanar layers of the sign (slab top,
 *  letter tops, painted caption), as a fraction of the caption block. Only
 *  enough to settle depth-fighting: the caption must still read as printed on
 *  the letters, not as a second sign hovering over them. */
const CAPTION_SURFACE_LIFT_FRACTION = 0.004;
/** Alpha the glyph mask is cut at, and the smallest loop worth extruding
 *  (square mask pixels — well under a period's counter, well over the specks
 *  antialiasing leaves behind). */
const LETTER_MASK_THRESHOLD = 0.5;
const LETTER_MASK_MINIMUM_AREA = 6;
/** Mask budget. Supersampling buys smoother outlines but the trace is per
 *  texel, and the caption is repainted whenever a lobby setting changes. */
const LETTER_MASK_MAX_TEXELS = 2_400_000;

function fontString(pixels: number): string {
  return `bold ${pixels}px ${NAME_LABEL_FONT_FAMILY}`;
}

function fontPxForLine(index: number): number {
  return index === 0 ? STYLE.titleFontPx : STYLE.infoFontPx;
}

/** Canvas height for `lines`: padding, the title row, then one gap +
 *  info row per remaining line. Exported for the contract test. */
export function mapPresetLabelCanvasHeight(lineCount: number): number {
  if (lineCount <= 0) return 0;
  let height = 2 * STYLE.canvasPadPx + STYLE.titleFontPx;
  for (let index = 1; index < lineCount; index++) {
    height += STYLE.lineGapPx + STYLE.infoFontPx;
  }
  return height;
}

type MapPresetLabelPlacement = {
  readonly worldWidth: number;
  readonly worldHeight: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly centerZ: number;
  /** Terrain border around the caption, and how deep the slab hangs. */
  readonly plinthPad: number;
  readonly plinthThickness: number;
};

/** Size the block from the canvas aspect and park it outside the map's
 *  (0, 0) corner: left edge flush with the map's x = 0 edge, first line
 *  one margin clear of the z = 0 edge, the whole block — plinth border
 *  included — at z < 0 so it never overlaps the playable area. Pure so the
 *  contract test can hold that invariant without WebGL. */
export function resolveMapPresetLabelPlacement(
  mapAxis: number,
  canvasAspect: number,
): MapPresetLabelPlacement {
  const worldHeight = mapAxis * STYLE.blockHeightMapFraction;
  const worldWidth = canvasAspect * worldHeight;
  const margin = mapAxis * STYLE.cornerMarginMapFraction;
  const plinthPad = Math.min(
    worldHeight * STYLE.plinthPadBlockFraction,
    // The border may eat the corner margin but never cross the map edge.
    margin * 0.5,
  );
  return {
    worldWidth,
    worldHeight,
    centerX: worldWidth / 2,
    centerY: WATER_LEVEL + STYLE.groundLift,
    centerZ: -margin - worldHeight / 2,
    plinthPad,
    plinthThickness: worldHeight * STYLE.plinthThicknessBlockFraction,
  };
}

export class MapPresetLabel3D implements MapPresetLabelTarget {
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly captionGeometry = new THREE.PlaneGeometry(1, 1);
  private readonly captionMaterial: THREE.MeshBasicMaterial;
  private readonly captionMesh: THREE.Mesh;
  /** Local frame shared by plinth, caption, and letters: +X canvas-right,
   *  +Y canvas-up, +Z world-up. */
  private readonly group = new THREE.Group();
  private readonly plinthMaterials: readonly THREE.MeshStandardMaterial[];
  private readonly letterMaterials: readonly THREE.MeshStandardMaterial[];
  private plinthMesh: THREE.Mesh | null = null;
  private letterMesh: THREE.Mesh | null = null;
  private readonly mapAxis: number;
  private lastKey: string | null = null;
  private destroyed = false;

  constructor(
    parent: THREE.Object3D,
    renderer: THREE.WebGLRenderer,
    mapWidth: number,
    mapHeight: number,
  ) {
    this.mapAxis = Math.max(mapWidth, mapHeight);
    const ctx = this.canvas.getContext('2d');
    if (ctx === null) throw new Error('MapPresetLabel3D requires a 2D canvas context');
    this.ctx = ctx;
    // Non-zero starter dimensions keep the CanvasTexture valid before the
    // first paint; every paint resizes the canvas to fit its own text.
    this.canvas.width = 2;
    this.canvas.height = 2;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    // Whole-map zoom minifies this hard, so mipmaps + anisotropy are what
    // keep the caption from shimmering into noise as the camera pulls out.
    // The extruded letters have no such filtering, which is exactly why the
    // painted caption stays under them instead of being replaced by them.
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    this.captionMaterial = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      // The quad lies in the plinth's top plane, so the camera sees whichever
      // face the current pitch presents.
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.captionMesh = new THREE.Mesh(this.captionGeometry, this.captionMaterial);
    this.captionMesh.name = 'MapPresetLabelCaption';
    this.captionMesh.renderOrder = TRANSPARENT_RENDER_ORDER_3D.aboveWaterEffects;

    // The plinth is a slab of the world's own substances rather than a UI
    // panel: the ground the map's flat green is made of on top, the rock its
    // walls are cut from down the sides — mixed by the same base colour,
    // detail tile and broad field layers the terrain mixes them by, and read
    // from WORLD position, so the slab is the same physical grain as the
    // ground it sits beside rather than a stretched copy of one tile.
    const groundMaterial = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
    applyTerrainSubstanceMaterial(groundMaterial, 'ground');
    const rockMaterial = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
    applyTerrainSubstanceMaterial(rockMaterial, 'rock');
    this.plinthMaterials = [groundMaterial, rockMaterial];
    // Letter faces take the painted fill colour and letter sides the painted
    // outline colour, so the relief reads as the printed caption lifted off
    // the slab rather than as a second, differently coloured sign.
    this.letterMaterials = [
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(STYLE.fillColor),
        roughness: 0.55,
        metalness: 0,
      }),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(STYLE.strokeColor),
        roughness: 0.8,
        metalness: 0,
      }),
    ];

    this.group.name = 'MapPresetLabel';
    // The extra half-turn around Z corrects both mirrored reading order and
    // vertical stacking after the group is laid flat on the ground plane.
    this.group.rotation.x = MAP_PRESET_LABEL_ROTATION_X;
    this.group.rotation.z = MAP_PRESET_LABEL_ROTATION_Z;
    this.group.visible = false;
    this.group.add(this.captionMesh);
    parent.add(this.group);
  }

  setMapPresetLabelLines(lines: MapPresetLabelLines): void {
    if (this.destroyed) return;
    const painted = lines?.filter((line) => line.length > 0) ?? [];
    const key = painted.length > 0 ? painted.join('\n') : null;
    if (key === this.lastKey) return;
    this.lastKey = key;
    if (key === null) {
      this.group.visible = false;
      return;
    }
    this.paint(this.ctx, this.canvas, painted, 1);
    this.placeSign(painted);
    this.group.visible = true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.group.parent?.remove(this.group);
    this.disposeBuiltMeshes();
    this.texture.dispose();
    this.captionMaterial.dispose();
    this.captionGeometry.dispose();
    for (const material of this.plinthMaterials) material.dispose();
    for (const material of this.letterMaterials) material.dispose();
  }

  // ── internals ──

  /** Paint `lines` into `canvas` at `scale`, resizing it to fit. Scale 1 is
   *  the caption texture; the glyph trace repaints the identical layout
   *  larger, so mask coordinates map onto the caption quad by ratio alone. */
  private paint(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    lines: readonly string[],
    scale: number,
  ): void {
    // Measure first — the font must be set before measureText, and
    // resizing the canvas wipes both the pixels and the context state.
    let widest = 0;
    for (let index = 0; index < lines.length; index++) {
      ctx.font = fontString(fontPxForLine(index) * scale);
      widest = Math.max(widest, Math.ceil(ctx.measureText(lines[index]).width));
    }
    canvas.width = widest + 2 * Math.round(STYLE.canvasPadPx * scale);
    canvas.height = Math.round(mapPresetLabelCanvasHeight(lines.length) * scale);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = STYLE.strokeColor;
    ctx.fillStyle = STYLE.fillColor;

    let cursorY = STYLE.canvasPadPx * scale;
    for (let index = 0; index < lines.length; index++) {
      const fontPx = fontPxForLine(index) * scale;
      if (index > 0) cursorY += STYLE.lineGapPx * scale;
      ctx.font = fontString(fontPx);
      // The outline scales with the row so info lines don't get swallowed
      // by a stroke authored for the title.
      ctx.lineWidth = STYLE.strokeWidthPx * scale * (fontPx / (STYLE.titleFontPx * scale));
      ctx.strokeText(lines[index], STYLE.canvasPadPx * scale, cursorY);
      ctx.fillText(lines[index], STYLE.canvasPadPx * scale, cursorY);
      cursorY += fontPx;
    }
    if (canvas === this.canvas) this.texture.needsUpdate = true;
  }

  /** Rebuild everything that depends on the caption's size: the slab under
   *  it, the printed caption, and the letters standing on it. */
  private placeSign(lines: readonly string[]): void {
    const placement = resolveMapPresetLabelPlacement(
      this.mapAxis,
      this.canvas.width / this.canvas.height,
    );
    this.group.position.set(placement.centerX, placement.centerY, placement.centerZ);

    const captionLift = placement.worldHeight * CAPTION_SURFACE_LIFT_FRACTION;
    this.captionMesh.scale.set(placement.worldWidth, placement.worldHeight, 1);

    this.disposeBuiltMeshes();

    const plinth = new THREE.Mesh(
      buildPlinthGeometry(
        placement.worldWidth + 2 * placement.plinthPad,
        placement.worldHeight + 2 * placement.plinthPad,
        placement.plinthThickness,
      ),
      this.plinthMaterials as THREE.MeshStandardMaterial[],
    );
    plinth.name = 'MapPresetLabelPlinth';
    this.plinthMesh = plinth;
    this.group.add(plinth);

    const letterDepth =
      (placement.worldHeight / this.canvas.height) *
      STYLE.titleFontPx *
      STYLE.letterDepthTitleFraction;
    const letters = this.buildLetterGeometry(lines, placement, captionLift, letterDepth);
    if (letters !== null) {
      const mesh = new THREE.Mesh(letters, this.letterMaterials as THREE.MeshStandardMaterial[]);
      mesh.name = 'MapPresetLabelLetters';
      this.letterMesh = mesh;
      this.group.add(mesh);
    }
    // The painted caption caps the relief instead of lying under it. Printed
    // on the slab it showed around every raised letter as a second, offset
    // copy of the same text; capping the letters puts it exactly where their
    // top faces already are, so it reads as the letters' own printed surface
    // and still carries the sign at whole-map zoom, where mipmaps beat
    // geometry.
    this.captionMesh.position.set(
      0,
      0,
      letters === null ? captionLift : captionLift + letterDepth + captionLift,
    );
  }

  /** Trace the painted glyphs and extrude them off the plinth's top face.
   *  Returns null when the mask yields nothing to extrude (an empty caption,
   *  or a context that cannot hand back pixels) — the printed caption alone
   *  is then still a complete, readable sign. */
  private buildLetterGeometry(
    lines: readonly string[],
    placement: MapPresetLabelPlacement,
    captionLift: number,
    depth: number,
  ): THREE.ExtrudeGeometry | null {
    const maskCanvas = document.createElement('canvas');
    const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
    if (maskCtx === null) return null;
    const supersample = Math.max(
      1,
      Math.min(
        STYLE.letterMaskSupersample,
        Math.sqrt(
          LETTER_MASK_MAX_TEXELS / Math.max(1, this.canvas.width * this.canvas.height),
        ),
      ),
    );
    this.paint(maskCtx, maskCanvas, lines, supersample);
    let pixels: ImageData;
    try {
      pixels = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    } catch {
      return null;
    }
    const texelCount = maskCanvas.width * maskCanvas.height;
    const alpha = new Uint8Array(texelCount);
    for (let i = 0; i < texelCount; i++) alpha[i] = pixels.data[i * 4 + 3];

    const contours = traceAlphaMaskContours(
      alpha,
      maskCanvas.width,
      maskCanvas.height,
      {
        threshold: LETTER_MASK_THRESHOLD,
        simplifyTolerance: STYLE.letterMaskSimplifyPx * supersample,
        minimumArea: LETTER_MASK_MINIMUM_AREA * supersample * supersample,
      },
    );
    const groups = groupNestedContours(contours);
    if (groups.length === 0) return null;

    // Mask texel to local sign units. Integer mask coordinates are texel
    // CENTRES, so the half-texel shift keeps the extrusion registered on the
    // caption printed underneath it.
    const toLocal = (polygon: MaskPolygon): THREE.Vector2[] => {
      const points: THREE.Vector2[] = [];
      for (let i = 0; i < polygon.length; i += 2) {
        points.push(new THREE.Vector2(
          ((polygon[i] + 0.5) / maskCanvas.width - 0.5) * placement.worldWidth,
          (0.5 - (polygon[i + 1] + 0.5) / maskCanvas.height) * placement.worldHeight,
        ));
      }
      return points;
    };
    const shapes = groups.map((group) => {
      const shape = new THREE.Shape(toLocal(group.outline));
      shape.holes = group.holes.map((hole) => new THREE.Path(toLocal(hole)));
      return shape;
    });

    const geometry = new THREE.ExtrudeGeometry(shapes, {
      depth,
      bevelEnabled: false,
      steps: 1,
      // The outlines are already polylines; there is no curve left to
      // resample, and a higher count would only duplicate their points.
      curveSegments: 1,
    });
    // Extrusion starts at the shape plane, so lift it to sit on the printed
    // caption instead of half-sunk into the slab.
    geometry.translate(0, 0, captionLift);
    return geometry;
  }

  private disposeBuiltMeshes(): void {
    for (const mesh of [this.plinthMesh, this.letterMesh]) {
      if (mesh === null) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    this.plinthMesh = null;
    this.letterMesh = null;
  }
}

/**
 * The caption's slab of terrain, in the sign's local frame: the ground-faced
 * top at z = 0 (material 0) and the rock sides and floor hanging below it
 * (material 1). No uvs — both substances are read from WORLD position by
 * TerrainSubstanceMaterial3D, which is what makes the slab the same grain as
 * the map rather than one stretched tile per face.
 *
 * Exported for the contract test.
 */
export function buildPlinthGeometry(
  width: number,
  height: number,
  thickness: number,
): THREE.BufferGeometry {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  // Each face is an origin plus two edge vectors whose cross product is the
  // outward normal, so winding and normal cannot drift apart.
  const faces: ReadonlyArray<{
    readonly origin: readonly [number, number, number];
    readonly u: readonly [number, number, number];
    readonly v: readonly [number, number, number];
    readonly normal: readonly [number, number, number];
    readonly material: 0 | 1;
  }> = [
    {
      origin: [-halfWidth, -halfHeight, 0],
      u: [width, 0, 0],
      v: [0, height, 0],
      normal: [0, 0, 1],
      material: 0,
    },
    {
      origin: [-halfWidth, -halfHeight, -thickness],
      u: [0, height, 0],
      v: [width, 0, 0],
      normal: [0, 0, -1],
      material: 1,
    },
    {
      origin: [halfWidth, -halfHeight, -thickness],
      u: [0, height, 0],
      v: [0, 0, thickness],
      normal: [1, 0, 0],
      material: 1,
    },
    {
      origin: [-halfWidth, -halfHeight, -thickness],
      u: [0, 0, thickness],
      v: [0, height, 0],
      normal: [-1, 0, 0],
      material: 1,
    },
    {
      origin: [-halfWidth, halfHeight, -thickness],
      u: [0, 0, thickness],
      v: [width, 0, 0],
      normal: [0, 1, 0],
      material: 1,
    },
    {
      origin: [-halfWidth, -halfHeight, -thickness],
      u: [width, 0, 0],
      v: [0, 0, thickness],
      normal: [0, -1, 0],
      material: 1,
    },
  ];

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const groups: Array<{ start: number; count: number; material: 0 | 1 }> = [];
  for (const face of faces) {
    const base = positions.length / 3;
    for (const [su, sv] of [[0, 0], [1, 0], [1, 1], [0, 1]] as const) {
      positions.push(
        face.origin[0] + su * face.u[0] + sv * face.v[0],
        face.origin[1] + su * face.u[1] + sv * face.v[1],
        face.origin[2] + su * face.u[2] + sv * face.v[2],
      );
      normals.push(face.normal[0], face.normal[1], face.normal[2]);
    }
    const start = indices.length;
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    // One draw group per material run, not per face: the rock faces are
    // contiguous, so they merge into a single range.
    const previous = groups[groups.length - 1];
    if (previous !== undefined && previous.material === face.material) {
      previous.count = indices.length - previous.start;
    } else {
      groups.push({ start, count: indices.length - start, material: face.material });
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  for (const group of groups) {
    geometry.addGroup(group.start, group.count, group.material);
  }
  geometry.computeBoundingSphere();
  return geometry;
}
