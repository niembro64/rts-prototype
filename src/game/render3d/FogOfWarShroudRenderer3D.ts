import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import { HORIZON_RENDER_EXTEND } from '../../config';
import type { ClientViewState } from '../network/ClientViewState';
import type { Entity, PlayerId } from '../sim/types';
import {
  canEntityProvideFullVision,
  getEntityFullVisionRadius,
} from '../network/stateSerializerVisibility';

// Repaint cadence. The shade is purely cosmetic; sub-100ms updates are
// imperceptible at RTS pace and let us keep the canvas-paint cost low.
const UPDATE_INTERVAL_MS = 110;
const FOG_SHADE_CELL_SIZE = 64;
const SHROUD_Y = 2;

type VisionSource = {
  x: number;
  y: number;
  radius: number;
};

function createHorizonShroudGeometry(mapWidth: number, mapHeight: number): THREE.BufferGeometry {
  const outer = Math.max(0, HORIZON_RENDER_EXTEND);
  const worldX = [-outer, 0, mapWidth, mapWidth + outer];
  const worldY = [-outer, 0, mapHeight, mapHeight + outer];
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  // Nine quads: the center maps the full alpha texture, while the
  // horizon bands clamp to the nearest texture edge instead of
  // stretching the shade across the extended water/shelf plane.
  for (let yIndex = 0; yIndex < worldY.length; yIndex++) {
    const y = worldY[yIndex];
    const v = 1 - clamp01(y / mapHeight);
    for (let xIndex = 0; xIndex < worldX.length; xIndex++) {
      const x = worldX[xIndex];
      positions.push(x - mapWidth / 2, mapHeight / 2 - y, 0);
      uvs.push(clamp01(x / mapWidth), v);
    }
  }

  const columns = worldX.length;
  for (let yIndex = 0; yIndex < worldY.length - 1; yIndex++) {
    for (let xIndex = 0; xIndex < worldX.length - 1; xIndex++) {
      const a = yIndex * columns + xIndex;
      const b = a + 1;
      const c = a + columns;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/** Live fog-of-war shade.
 *
 *  The server's snapshot filter already prevents the client from
 *  receiving entities outside the local player's vision, so this
 *  renderer does NOT exist to occlude enemies. It is only a client
 *  presentation layer for unseen terrain while battle-level FOG is on.
 *  It deliberately does not track explored history: there is no black
 *  "never seen" region and no dark "explored but not visible" state. */
export class FogOfWarShroudRenderer3D {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly imageData: ImageData;
  private readonly texture: THREE.CanvasTexture;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly mesh: THREE.Mesh;
  private readonly sources: VisionSource[] = [];
  private updateAccumMs = UPDATE_INTERVAL_MS;
  /** Last `enabled` state we drew at. Tracked so toggling fog back on
   *  forces an immediate repaint instead of leaving the canvas at
   *  whatever it held when fog last turned off — without this the
   *  shade snaps in only on the next UPDATE_INTERVAL_MS tick (110ms
   *  of visible flash). */
  private lastEnabled = false;
  /** Hash of the source pool at the LAST paint. Identical hash
   *  ⇒ the alphaMap output would be byte-for-byte identical, so we
   *  skip paintAlphaMap entirely. Reset
   *  to null whenever the canvas needs an unconditional repaint
   *  (fog toggle on). */
  private lastSourcesHash: number | null = null;

  constructor(
    world: THREE.Group,
    private readonly mapWidth: number,
    private readonly mapHeight: number,
  ) {
    // A coarse alpha grid is enough for this presentation layer;
    // texture filtering on the GPU smooths it back up to screen space.
    const gridW = Math.max(1, Math.ceil(mapWidth / FOG_SHADE_CELL_SIZE));
    const gridH = Math.max(1, Math.ceil(mapHeight / FOG_SHADE_CELL_SIZE));
    this.canvas = document.createElement('canvas');
    this.canvas.width = gridW;
    this.canvas.height = gridH;
    const ctx = this.canvas.getContext('2d', { willReadFrequently: false });
    if (!ctx) {
      throw new Error('FogOfWarShroudRenderer3D failed to create 2D canvas context');
    }
    this.ctx = ctx;
    this.imageData = ctx.createImageData(gridW, gridH);
    fillImageDataShade(this.imageData);

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    // Disable the default vertical flip on upload. The paint code lays
    // out the canvas with `cy = (1 - source.y / mapHeight) * height`
    // so canvas-bottom corresponds to world 2D Y=0 — matching the
    // post-rotation plane's UV V=1-at-Y=0 mapping ONLY when flipY is
    // off. With flipY left at its default true, the texture is
    // mirrored on upload and every vision circle renders at the
    // opposite end of the map from its source unit.
    this.texture.flipY = false;

    this.material = new THREE.MeshBasicMaterial({
      color: COLORS.world.fogOfWar.shade.colorHex,
      transparent: true,
      alphaMap: this.texture,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    });

    const geom = createHorizonShroudGeometry(mapWidth, mapHeight);
    this.mesh = new THREE.Mesh(geom, this.material);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.set(mapWidth / 2, SHROUD_Y, mapHeight / 2);
    // Render last and ignore depth — the shade is a 2D info layer, not
    // a physical object. Tall terrain shouldn't poke through it.
    this.mesh.renderOrder = 9000;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    world.add(this.mesh);
  }

  update(
    clientViewState: ClientViewState,
    localPlayerId: PlayerId,
    enabled: boolean,
    deltaMs: number,
  ): void {
    this.mesh.visible = enabled;
    if (!enabled) {
      this.lastEnabled = false;
      return;
    }

    // Fog just toggled back on — force a repaint this frame so the
    // shade snaps in immediately instead of showing the canvas in
    // whatever state it held last.
    if (!this.lastEnabled) {
      this.updateAccumMs = UPDATE_INTERVAL_MS;
      this.lastEnabled = true;
      this.lastSourcesHash = null;
    }

    this.updateAccumMs += deltaMs;
    if (this.updateAccumMs < UPDATE_INTERVAL_MS) return;
    this.updateAccumMs = 0;

    this.collectSources(clientViewState, localPlayerId);
    // Skip the full paint when the local source pool is
    // byte-identical to the last paint. With no source movement (an
    // idle base), the alphaMap output would
    // be identical to what's already on the canvas — putImageData +
    // radial-gradient pass would just repaint identical pixels, and a
    // hash compare keeps the static case near-free.
    const sourcesHash = this.hashSources();
    if (sourcesHash === this.lastSourcesHash) return;
    this.paintAlphaMap();
    this.texture.needsUpdate = true;
    this.lastSourcesHash = sourcesHash;
  }

  /** Cheap rolling hash of the current source pool. Quantizes positions
   *  and radii to integer world units (sub-unit drift is below the
   *  alphaMap's per-cell resolution anyway) so a unit parked in place doesn't
   *  trigger repaints from float noise. The hash is order-sensitive —
   *  fine because collectSources walks ClientViewState's units / buildings
   *  / pulses in a stable order. */
  private hashSources(): number {
    let h = this.sources.length;
    for (let i = 0; i < this.sources.length; i++) {
      const s = this.sources[i];
      h = (Math.imul(h, 31) + (s.x | 0)) | 0;
      h = (Math.imul(h, 31) + (s.y | 0)) | 0;
      h = (Math.imul(h, 31) + (s.radius | 0)) | 0;
    }
    return h;
  }

  destroy(): void {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }

  private collectSources(clientViewState: ClientViewState, localPlayerId: PlayerId): void {
    this.sources.length = 0;
    // Pull only the host-declared recipient+allies player set. That
    // keeps team fog presentation aligned with SnapshotVisibility
    // without treating arbitrary visible enemies as sight sources.
    const playerIds = clientViewState.getVisionPlayerIds(localPlayerId);
    for (let i = 0; i < playerIds.length; i++) {
      const playerId = playerIds[i];
      this.collectFromOwned(clientViewState.getUnitsByPlayer(playerId));
      this.collectFromOwned(clientViewState.getBuildingsByPlayer(playerId));
    }
    // FOW-14: temporary scanner sweeps clear the shade for the
    // duration of the pulse. Server already filtered the list to this
    // recipient's team, so every entry is one we should honor.
    const pulses = clientViewState.getScanPulses();
    for (let i = 0; i < pulses.length; i++) {
      const pulse = pulses[i];
      this.sources.push({ x: pulse.x, y: pulse.y, radius: pulse.radius });
    }
  }

  /** Append vision sources from a slice already restricted to the
   *  local player by the cache. Skipping the ownership check matches
   *  the FOW-OPT-06 optimization comment in collectSources. */
  private collectFromOwned(entities: readonly Entity[]): void {
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      if (!canEntityProvideFullVision(entity)) continue;
      this.sources.push({
        x: entity.transform.x,
        y: entity.transform.y,
        radius: getEntityFullVisionRadius(entity),
      });
    }
  }

  private paintAlphaMap(): void {
    fillImageDataShade(this.imageData);
    this.ctx.putImageData(this.imageData, 0, 0);

    // Vision-circle pass: paint each source as a radial gradient from
    // solid black at the inner core to transparent at the rim. With the
    // material's alphaMap reading the canvas R channel, solid black
    // (R=0) renders as a transparent shade → the player sees through.
    // The 0.78 inner stop keeps the core sharp and only feathers the
    // outer 22%.
    for (let i = 0; i < this.sources.length; i++) {
      const source = this.sources[i];
      const cx = (source.x / this.mapWidth) * this.canvas.width;
      const cy = (1 - source.y / this.mapHeight) * this.canvas.height;
      const r = (source.radius / this.mapWidth) * this.canvas.width;
      const gradient = this.ctx.createRadialGradient(cx, cy, r * 0.78, cx, cy, r);
      gradient.addColorStop(0, COLORS.world.fogOfWar.gradientStart);
      gradient.addColorStop(1, COLORS.world.fogOfWar.gradientEnd);
      this.ctx.fillStyle = gradient;
      this.ctx.beginPath();
      this.ctx.arc(cx, cy, r, 0, Math.PI * 2);
      this.ctx.fill();
    }
  }
}

function fillImageDataShade(imageData: ImageData): void {
  const data = imageData.data;
  const shadeAlpha = clampByte(COLORS.world.fogOfWar.shade.alpha);
  for (let p = 0; p < data.length; p += 4) {
    data[p] = shadeAlpha;
    data[p + 1] = shadeAlpha;
    data[p + 2] = shadeAlpha;
    data[p + 3] = 255;
  }
}

function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}
