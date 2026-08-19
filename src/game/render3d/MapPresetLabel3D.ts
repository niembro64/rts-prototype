// MapPresetLabel3D — the stock-preset caption, standing on the map's info
// annex: the headland grown out of the middle of the map edge behind ally
// team 0 (see MapInfoAnnex3D). It is map signage, not HUD: it lives in world
// space, so it is occluded by terrain and grows/shrinks with zoom like
// everything else.
//
// The ground under it is no longer this file's problem. The caption used to
// carry its own plinth because it stood in the void outside the map; the
// annex is real map now — emitted into the terrain mesh, covered by the same
// liquid box — so all that is left here is the sign itself.
//
// The letters are EXTRUDED off the annex's flat table rather than only
// printed on it, and they always rise to a fixed relief above WHICHEVER IS
// HIGHER, the ground they stand on or the liquid surface. On a dry headland
// that is exactly the relief the letters always had. On a submerged one they
// run up out of the water like pilings, readable from above the surface and
// still readable from under it. The painted caption caps them (mipmapped and
// anisotropic, which raw geometry is not), so at whole-map zoom the sign is
// carried by a filtered texture rather than by shimmering triangles.
//
// Exact presets show their authored name; changed settings show CUSTOM and
// continue describing the live map. One pooled canvas is repainted on change;
// per-frame work is one terrain sample, and only to notice when the annex's
// altitude has changed under the sign.

import * as THREE from 'three';
import { MAP_PRESET_LABEL_RENDER_CONFIG } from '@/config';
import { COLORS } from '@/colorsConfig';
import { NAME_LABEL_FONT_FAMILY } from '@/nameLabelConfig';
import { getTerrainMeshHeight, WATER_LEVEL } from '../sim/Terrain';
import {
  groupNestedContours,
  traceAlphaMaskContours,
  type MaskPolygon,
} from './AlphaMaskExtrusion3D';
import {
  mapInfoAnnexFlatHeight,
  mapInfoAnnexFlatSurfaceY,
  resolveMapInfoAnnexCaptionArea,
  resolveMapInfoAnnexFootprint,
  type MapInfoAnnexFootprint,
} from './MapInfoAnnex3D';
import type { MapPresetLabelLines, MapPresetLabelTarget } from './presetMapLabel';
import { TRANSPARENT_RENDER_ORDER_3D } from './TransparentRenderOrder3D';

const STYLE = {
  titleFontPx: MAP_PRESET_LABEL_RENDER_CONFIG.titleFontPx,
  infoFontPx: MAP_PRESET_LABEL_RENDER_CONFIG.infoFontPx,
  lineGapPx: MAP_PRESET_LABEL_RENDER_CONFIG.lineGapPx,
  canvasPadPx: MAP_PRESET_LABEL_RENDER_CONFIG.canvasPadPx,
  strokeWidthPx: MAP_PRESET_LABEL_RENDER_CONFIG.strokeWidthPx,
  captionMarginAnnexDepthFraction:
    MAP_PRESET_LABEL_RENDER_CONFIG.captionMarginAnnexDepthFraction,
  letterReliefTitleFraction: MAP_PRESET_LABEL_RENDER_CONFIG.letterReliefTitleFraction,
  letterMaskSupersample: MAP_PRESET_LABEL_RENDER_CONFIG.letterMaskSupersample,
  letterMaskSimplifyPx: MAP_PRESET_LABEL_RENDER_CONFIG.letterMaskSimplifyPx,
  fillColor: COLORS.ui.mapPresetLabel.fillColor,
  strokeColor: COLORS.ui.mapPresetLabel.strokeColor,
};

/** Ground-plane orientation for a readable sign at the default -Z camera.
 *  Canvas right maps toward world -X (screen-right from that camera), canvas
 *  top maps toward +Z (into the map), and the painted front normal points
 *  upward — so the letters extrude up local +Z. The annex's own `signYaw` is
 *  added to the Z term, which after the lay-flat X turn is a yaw about world
 *  +Y: it carries this frame onto whichever map edge the annex landed on, and
 *  is zero for the edge ally team 0 actually backs onto. */
export const MAP_PRESET_LABEL_ROTATION_X = -Math.PI / 2;
export const MAP_PRESET_LABEL_ROTATION_Z = Math.PI;

/** Clearance between the stacked coplanar layers of the sign (letter tops and
 *  the painted caption), as a fraction of the caption block. Only enough to
 *  settle depth-fighting: the caption must still read as printed on the
 *  letters, not as a second sign hovering over them. */
const CAPTION_SURFACE_LIFT_FRACTION = 0.004;
/** Alpha the glyph mask is cut at, and the smallest loop worth extruding
 *  (square mask pixels — well under a period's counter, well over the specks
 *  antialiasing leaves behind). */
const LETTER_MASK_THRESHOLD = 0.5;
const LETTER_MASK_MINIMUM_AREA = 6;
/** Mask budget. Supersampling buys smoother outlines but the trace is per
 *  texel, and the caption is repainted whenever a lobby setting changes. */
const LETTER_MASK_MAX_TEXELS = 2_400_000;
/** How far the annex's altitude has to move before the sign is re-seated.
 *  The terrain sample is exact once the baked mesh is installed; this only
 *  keeps float noise from re-seating the sign every frame. */
const ANNEX_ALTITUDE_EPSILON = 1e-3;

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

export type MapPresetLabelPlacement = {
  readonly worldWidth: number;
  readonly worldHeight: number;
  readonly centerX: number;
  readonly centerZ: number;
  readonly annex: MapInfoAnnexFootprint;
};

/** Fit the caption into the annex's flat table, inset by one margin on every
 *  side, largest size that keeps the canvas aspect. Pure so the contract test
 *  can hold the "entirely on the flat part, entirely off the map" invariant
 *  without WebGL. */
export function resolveMapPresetLabelPlacement(
  mapWidth: number,
  mapHeight: number,
  canvasAspect: number,
): MapPresetLabelPlacement {
  const annex = resolveMapInfoAnnexFootprint(mapWidth, mapHeight);
  const area = resolveMapInfoAnnexCaptionArea(
    annex,
    annex.depth * STYLE.captionMarginAnnexDepthFraction,
  );
  const worldHeight = Math.min(area.depth, area.width / Math.max(1e-6, canvasAspect));
  return {
    worldWidth: worldHeight * canvasAspect,
    worldHeight,
    centerX: area.centerX,
    centerZ: area.centerZ,
    annex,
  };
}

export class MapPresetLabel3D implements MapPresetLabelTarget {
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly captionGeometry = new THREE.PlaneGeometry(1, 1);
  private readonly captionMaterial: THREE.MeshBasicMaterial;
  private readonly captionMesh: THREE.Mesh;
  /** Local frame shared by caption and letters: +X canvas-right, +Y
   *  canvas-up, +Z world-up. */
  private readonly group = new THREE.Group();
  private readonly letterMaterials: readonly THREE.MeshStandardMaterial[];
  private letterMesh: THREE.Mesh | null = null;
  private readonly mapWidth: number;
  private readonly mapHeight: number;
  private lastKey: string | null = null;
  private lastLines: readonly string[] = [];
  private lastAnnexSurfaceY = Number.NaN;
  private destroyed = false;

  constructor(
    parent: THREE.Object3D,
    renderer: THREE.WebGLRenderer,
    mapWidth: number,
    mapHeight: number,
  ) {
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
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
    // painted caption caps them instead of being replaced by them.
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    this.captionMaterial = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      // The quad caps the letters, so the camera sees whichever face the
      // current pitch presents — including from below, through the water.
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.captionMesh = new THREE.Mesh(this.captionGeometry, this.captionMaterial);
    this.captionMesh.name = 'MapPresetLabelCaption';
    this.captionMesh.renderOrder = TRANSPARENT_RENDER_ORDER_3D.aboveWaterEffects;

    // Letter faces take the painted fill colour and letter sides the painted
    // outline colour, so the relief reads as the printed caption lifted off
    // the annex rather than as a second, differently coloured sign.
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
    this.group.rotation.z =
      MAP_PRESET_LABEL_ROTATION_Z +
      resolveMapInfoAnnexFootprint(mapWidth, mapHeight).signYaw;
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
    this.lastLines = painted;
    if (key === null) {
      this.group.visible = false;
      return;
    }
    this.paint(this.ctx, this.canvas, painted, 1);
    // New text, new glyph mask. placeSign only traces when there is no
    // letter mesh, which is what keeps an altitude-only re-seat cheap.
    this.disposeLetterMesh();
    this.placeSign(painted);
    this.group.visible = true;
  }

  /** The annex's altitude is the terrain's, and the terrain mesh is not
   *  necessarily baked when this renderer is built — a lobby preview, a
   *  battle restart, or simply a caption that arrived first. One sample per
   *  frame is what keeps the sign standing ON the headland rather than at
   *  whatever height the analytic fallback guessed before the bake landed. */
  update(): void {
    if (this.destroyed || this.lastKey === null) return;
    const surfaceY = this.annexSurfaceY();
    if (Math.abs(surfaceY - this.lastAnnexSurfaceY) <= ANNEX_ALTITUDE_EPSILON) return;
    this.placeSign(this.lastLines);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.group.parent?.remove(this.group);
    this.disposeLetterMesh();
    this.texture.dispose();
    this.captionMaterial.dispose();
    this.captionGeometry.dispose();
    for (const material of this.letterMaterials) material.dispose();
  }

  // ── internals ──

  /** The rendered altitude of the annex's flat table — the plane the letters
   *  stand on. */
  private annexSurfaceY(): number {
    const annex = resolveMapInfoAnnexFootprint(this.mapWidth, this.mapHeight);
    return mapInfoAnnexFlatSurfaceY(
      mapInfoAnnexFlatHeight(annex, (x, z) =>
        getTerrainMeshHeight(x, z, this.mapWidth, this.mapHeight)),
    );
  }

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

  /** Seat the sign on the annex: size it to the flat table, stand it at the
   *  table's altitude, and stretch the letters up to clear the liquid. */
  private placeSign(lines: readonly string[]): void {
    const placement = resolveMapPresetLabelPlacement(
      this.mapWidth,
      this.mapHeight,
      this.canvas.width / this.canvas.height,
    );
    const surfaceY = this.annexSurfaceY();
    this.lastAnnexSurfaceY = surfaceY;
    this.group.position.set(placement.centerX, surfaceY, placement.centerZ);
    this.captionMesh.scale.set(placement.worldWidth, placement.worldHeight, 1);

    const captionLift = placement.worldHeight * CAPTION_SURFACE_LIFT_FRACTION;
    // The relief is the letters' authored height above what they stand on.
    // What they stand on is the higher of the ground and the liquid surface —
    // lava and water share WATER_LEVEL — so a caption on a shallow seabed
    // still reads from a boat's-eye view instead of drowning in the shallows.
    const relief =
      (placement.worldHeight / this.canvas.height) *
      STYLE.titleFontPx *
      STYLE.letterReliefTitleFraction;
    const letterDepth = Math.max(surfaceY, WATER_LEVEL) + relief - surfaceY;

    if (this.letterMesh === null) {
      // The extrusion is authored one unit deep and SCALED to the depth the
      // liquid asks for, so re-seating the sign when the terrain bake lands
      // is a transform write rather than a second glyph trace.
      const letters = this.buildLetterGeometry(lines, placement);
      if (letters !== null) {
        const mesh = new THREE.Mesh(
          letters,
          this.letterMaterials as THREE.MeshStandardMaterial[],
        );
        mesh.name = 'MapPresetLabelLetters';
        this.letterMesh = mesh;
        this.group.add(mesh);
      }
    }
    if (this.letterMesh !== null) {
      this.letterMesh.position.z = captionLift;
      this.letterMesh.scale.z = letterDepth;
    }
    // The painted caption caps the relief instead of lying under it. Printed
    // on the ground it showed around every raised letter as a second, offset
    // copy of the same text; capping the letters puts it exactly where their
    // top faces already are, so it reads as the letters' own printed surface
    // and still carries the sign at whole-map zoom, where mipmaps beat
    // geometry.
    this.captionMesh.position.set(
      0,
      0,
      this.letterMesh === null ? captionLift : captionLift + letterDepth + captionLift,
    );
  }

  /** Trace the painted glyphs and extrude them ONE UNIT off the sign plane.
   *  Returns null when the mask yields nothing to extrude (an empty caption,
   *  or a context that cannot hand back pixels) — the printed caption alone
   *  is then still a complete, readable sign. */
  private buildLetterGeometry(
    lines: readonly string[],
    placement: MapPresetLabelPlacement,
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
    // caption printed over it.
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

    return new THREE.ExtrudeGeometry(shapes, {
      depth: 1,
      bevelEnabled: false,
      steps: 1,
      // The outlines are already polylines; there is no curve left to
      // resample, and a higher count would only duplicate their points.
      curveSegments: 1,
    });
  }

  private disposeLetterMesh(): void {
    if (this.letterMesh === null) return;
    this.group.remove(this.letterMesh);
    this.letterMesh.geometry.dispose();
    this.letterMesh = null;
  }
}
