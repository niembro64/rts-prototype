import * as THREE from 'three';
import type { ClientViewState } from '../network/ClientViewState';
import type { Entity, PlayerId } from '../sim/types';
import type { NetworkServerSnapshotShroud } from '../network/NetworkTypes';
import {
  canEntityProvideVision,
  getEntityVisionRadius,
} from '../network/stateSerializerVisibility';
import { markCircleScanline } from '../sim/circleFill';

// Texture resolution caps. The map sampled into a coarse alpha grid;
// finer resolution smooths the shroud edges at proportional CPU cost.
const MAX_TEXTURE_AXIS = 512;
const MIN_TEXTURE_AXIS = 192;

// Repaint cadence. The shroud is purely cosmetic; sub-100ms updates are
// imperceptible at RTS pace and let us keep the canvas-paint cost low.
const UPDATE_INTERVAL_MS = 110;

// Alpha values in the canvas R channel (used as alphaMap by the
// material — 0 = clear, 255 = solid black). Three states:
//   - UNEXPLORED: nearly opaque, terrain barely visible.
//   - EXPLORED-DARK: mid shroud, terrain readable but dimmed.
//   - CURRENTLY VISIBLE: punched out via a per-source radial gradient.
const UNEXPLORED_ALPHA = 245;
const EXPLORED_ALPHA = 130;

type VisionSource = {
  x: number;
  y: number;
  radius: number;
};

/** Three-state fog-of-war shroud (issues.txt FOW-01).
 *
 *  The server's snapshot filter already prevents the client from
 *  receiving entities outside the local player's vision, so this
 *  renderer does NOT exist to occlude enemies — that's authoritative.
 *  Its only job is showing the player which areas of terrain they've
 *  already explored. Without it, the world looks identical whether the
 *  player has scouted it or not, which is the canonical RTS gap noted
 *  in issues.txt.
 *
 *  Exploration history is tracked client-side: every update OR's the
 *  current vision mask into a persistent `revealed` bitmap, so areas
 *  light up the first time a vision source touches them and stay lit
 *  forever (until the local-player id changes, e.g. a lobby seat swap).
 *  Server doesn't persist this — mid-game joins start blank, which is
 *  fine; FOW-11 in issues.txt covers the server-side variant. */
export class FogOfWarShroudRenderer3D {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly imageData: ImageData;
  private readonly revealed: Uint8Array;
  private readonly texture: THREE.CanvasTexture;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly mesh: THREE.Mesh;
  private readonly sources: VisionSource[] = [];
  private updateAccumMs = UPDATE_INTERVAL_MS;
  private lastPlayerId: PlayerId | null = null;
  /** Last `enabled` state we drew at. Tracked so toggling fog back on
   *  forces an immediate repaint instead of leaving the canvas at
   *  whatever it held when fog last turned off — without this the
   *  shroud snaps in only on the next UPDATE_INTERVAL_MS tick (110ms
   *  of visible flash). */
  private lastEnabled = false;
  /** Hash of the source pool at the LAST paint (issues.txt
   *  FOW-OPT-04). Identical hash + no shroud-apply since last paint
   *  ⇒ the alphaMap output would be byte-for-byte identical, so we
   *  skip collectSources/markRevealed/paintAlphaMap entirely. Reset
   *  to null whenever the canvas needs an unconditional repaint
   *  (seat swap, fog toggle on, server shroud applied). */
  private lastSourcesHash: number | null = null;
  /** Resample lookup tables for applyServerShroud (issues.txt
   *  FOW-OPT-03). Map canvas-pixel column→server bitmap column and
   *  canvas-pixel row→server-row-index-base. The inner loop reads
   *  these instead of running two float divides + a floor per pixel
   *  (~100k operations on a 512×192 canvas). Rebuilt only when the
   *  server's shroud grid changes (gridW / gridH / cellSize), which
   *  is once per game in practice. Null until the first shroud
   *  applies. */
  private shroudSxLut: Int32Array | null = null;
  private shroudSrcRowLut: Int32Array | null = null;
  /** Signature of the LUTs' source grid — quick equality check on
   *  every applyServerShroud call. Stays in sync with the LUT
   *  arrays. */
  private shroudLutSignature: string | null = null;

  constructor(
    world: THREE.Group,
    private readonly mapWidth: number,
    private readonly mapHeight: number,
  ) {
    const dims = textureDimensions(mapWidth, mapHeight);
    this.canvas = document.createElement('canvas');
    this.canvas.width = dims.width;
    this.canvas.height = dims.height;
    const ctx = this.canvas.getContext('2d', { willReadFrequently: false });
    if (!ctx) {
      throw new Error('FogOfWarShroudRenderer3D failed to create 2D canvas context');
    }
    this.ctx = ctx;
    this.imageData = ctx.createImageData(dims.width, dims.height);
    this.revealed = new Uint8Array(dims.width * dims.height);

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
    // opposite end of the map from its source unit (so e.g. a unit on
    // the south edge punches its circle through the shroud at the
    // north edge — its own position stays opaque and the player sees
    // the unit "hidden" by the shroud).
    this.texture.flipY = false;

    this.material = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      alphaMap: this.texture,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    });

    const geom = new THREE.PlaneGeometry(mapWidth, mapHeight);
    this.mesh = new THREE.Mesh(geom, this.material);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.set(mapWidth / 2, 2, mapHeight / 2);
    // Render last and ignore depth — the shroud is a 2D info layer, not
    // a physical object. Tall terrain shouldn't poke through it.
    this.mesh.renderOrder = 9000;
    this.mesh.visible = false;
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

    // Lobby seat swap or replay scrub → exploration is per-player, so
    // start a fresh history.
    if (this.lastPlayerId !== localPlayerId) {
      this.lastPlayerId = localPlayerId;
      this.revealed.fill(0);
      this.updateAccumMs = UPDATE_INTERVAL_MS;
      this.lastSourcesHash = null;
    }

    // Fog just toggled back on — force a repaint this frame so the
    // shroud snaps in immediately instead of showing the canvas in
    // whatever state it held last.
    if (!this.lastEnabled) {
      this.updateAccumMs = UPDATE_INTERVAL_MS;
      this.lastEnabled = true;
      this.lastSourcesHash = null;
    }

    // FOW-11: fold any authoritative bitmap from the latest keyframe
    // into the local revealed array BEFORE the live OR pass. The
    // server's record covers anything the recipient (and their
    // allies) ever explored — a mid-game join / reconnect lands with
    // a populated bitmap so the dark-shroud history shows up
    // immediately, then live vision keeps it current.
    const shroud = clientViewState.consumePendingShroud();
    if (shroud) {
      this.applyServerShroud(shroud);
      // Server reveals can light up explored cells we haven't observed
      // locally — force a repaint regardless of source-hash stability.
      this.lastSourcesHash = null;
    }

    this.updateAccumMs += deltaMs;
    if (this.updateAccumMs < UPDATE_INTERVAL_MS) return;
    this.updateAccumMs = 0;

    this.collectSources(clientViewState, localPlayerId);
    // FOW-OPT-04: skip the full paint when the local source pool is
    // byte-identical to the last paint. With no source movement (an
    // idle base) and no fresh shroud apply, the alphaMap output would
    // be identical to what's already on the canvas — the per-pixel
    // base coat + radial-gradient pass is the dominant cost of this
    // class, and a hash compare keeps the static case near-free.
    const sourcesHash = this.hashSources();
    if (sourcesHash === this.lastSourcesHash) return;
    this.markRevealed();
    this.paintAlphaMap();
    this.texture.needsUpdate = true;
    this.lastSourcesHash = sourcesHash;
  }

  /** Cheap rolling hash of the current source pool. Quantizes positions
   *  and radii to integer world units (sub-unit drift is below the
   *  alphaMap's per-pixel resolution anyway, ~mapWidth/512) so a unit
   *  parked in place doesn't trigger repaints from float noise. The
   *  hash is order-sensitive — fine because collectSources walks
   *  ClientViewState's units/buildings/pulses in a stable order. */
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

  /** OR the server-side shroud bitmap into the local revealed array.
   *  Server cells map onto the local canvas pixels by nearest-cell
   *  sampling — the two grids share their world-space mapping so a
   *  reveal-anywhere flag in the server bitmap lights up the
   *  corresponding canvas pixels regardless of resolution mismatch.
   *  Never CLEARS pixels — explored history is monotonic from the
   *  client's perspective. The wire bitmap is bit-packed
   *  (issues.txt FOW-OPT-02): cell `i = sy * gridW + sx` is bit
   *  `i & 7` of byte `i >> 3`.
   *
   *  FOW-OPT-03: the per-pixel world→cell conversion uses a pair of
   *  precomputed Int32Array LUTs that get rebuilt only when the
   *  server grid changes (gridW/gridH/cellSize). The hot loop then
   *  reads sxLut[cx] and srcRowLut[cy] instead of running two float
   *  divides + a clamp + a floor per pixel. */
  private applyServerShroud(shroud: NetworkServerSnapshotShroud): void {
    const srcBits = shroud.bitmap;
    const canvasW = this.canvas.width;
    const canvasH = this.canvas.height;
    const { sxLut, srcRowLut } = this.ensureShroudLuts(shroud);
    for (let cy = 0; cy < canvasH; cy++) {
      const srcRow = srcRowLut[cy];
      const dstRow = cy * canvasW;
      for (let cx = 0; cx < canvasW; cx++) {
        const cellIdx = srcRow + sxLut[cx];
        if ((srcBits[cellIdx >> 3] & (1 << (cellIdx & 7))) !== 0) {
          this.revealed[dstRow + cx] = 1;
        }
      }
    }
  }

  /** Rebuild the resample LUTs when the server grid changes; reuse
   *  the cached pair otherwise. The signature key is cheap to
   *  compare against on every shroud apply. */
  private ensureShroudLuts(
    shroud: NetworkServerSnapshotShroud,
  ): { sxLut: Int32Array; srcRowLut: Int32Array } {
    const srcGridW = shroud.gridW;
    const srcGridH = shroud.gridH;
    const srcCell = shroud.cellSize;
    const canvasW = this.canvas.width;
    const canvasH = this.canvas.height;
    const signature = `${srcGridW}x${srcGridH}@${srcCell}`;
    if (
      this.shroudLutSignature === signature &&
      this.shroudSxLut !== null &&
      this.shroudSrcRowLut !== null
    ) {
      return { sxLut: this.shroudSxLut, srcRowLut: this.shroudSrcRowLut };
    }
    const worldW = srcGridW * srcCell;
    const worldH = srcGridH * srcCell;
    const sxLut = new Int32Array(canvasW);
    for (let cx = 0; cx < canvasW; cx++) {
      const wx = ((cx + 0.5) / canvasW) * worldW;
      let sx = Math.floor(wx / srcCell);
      if (sx < 0) sx = 0;
      else if (sx >= srcGridW) sx = srcGridW - 1;
      sxLut[cx] = sx;
    }
    const srcRowLut = new Int32Array(canvasH);
    for (let cy = 0; cy < canvasH; cy++) {
      // Server bitmap rows run y=0 at world y=0; the local canvas
      // flips Y on upload (texture.flipY=false + paint with
      // 1 - sy/mapHeight), so sample the server row matching the
      // SAME world Y as the canvas row.
      const wy = ((canvasH - 1 - cy + 0.5) / canvasH) * worldH;
      let sy = Math.floor(wy / srcCell);
      if (sy < 0) sy = 0;
      else if (sy >= srcGridH) sy = srcGridH - 1;
      srcRowLut[cy] = sy * srcGridW;
    }
    this.shroudSxLut = sxLut;
    this.shroudSrcRowLut = srcRowLut;
    this.shroudLutSignature = signature;
    return { sxLut, srcRowLut };
  }

  destroy(): void {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }

  private collectSources(clientViewState: ClientViewState, localPlayerId: PlayerId): void {
    this.sources.length = 0;
    // FOW-OPT-06: pull the local player's units/buildings directly
    // from the per-player cache instead of filtering the world-wide
    // list. On a 1k-entity map the prior code paid one ownership
    // check per entity each paint; the cache slice is exactly the
    // set we care about so we skip straight to the
    // canEntityProvideVision predicate.
    this.collectFromOwned(clientViewState.getUnitsByPlayer(localPlayerId));
    this.collectFromOwned(clientViewState.getBuildingsByPlayer(localPlayerId));
    // FOW-14: temporary scanner sweeps clear the shroud for the
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
      if (!canEntityProvideVision(entity)) continue;
      this.sources.push({
        x: entity.transform.x,
        y: entity.transform.y,
        radius: getEntityVisionRadius(entity),
      });
    }
  }

  private markRevealed(): void {
    // Pixel-corner sampling (cellAnchor=0) matches the original loop's
    // `dx = x - cx`. Defers per-row span math to the shared scanline
    // helper (issues.txt FOW-OPT-05) so the per-cell distance test
    // is one sqrt per row instead of per pixel.
    const width = this.canvas.width;
    const height = this.canvas.height;
    for (let i = 0; i < this.sources.length; i++) {
      const source = this.sources[i];
      const cx = (source.x / this.mapWidth) * width;
      const cy = (1 - source.y / this.mapHeight) * height;
      const r = (source.radius / this.mapWidth) * width;
      markCircleScanline(this.revealed, width, height, cx, cy, r, 0);
    }
  }

  private paintAlphaMap(): void {
    // Base coat: every pixel paints its persistent state — either
    // explored-dark or fully unexplored. The vision-circle pass below
    // punches transparent holes through this base where the local
    // player currently has sight.
    const data = this.imageData.data;
    for (let i = 0, p = 0; i < this.revealed.length; i++, p += 4) {
      const v = this.revealed[i] ? EXPLORED_ALPHA : UNEXPLORED_ALPHA;
      data[p] = v;
      data[p + 1] = v;
      data[p + 2] = v;
      data[p + 3] = 255;
    }
    this.ctx.putImageData(this.imageData, 0, 0);

    // Vision-circle pass: paint each source as a radial gradient from
    // solid black at the inner core to transparent at the rim. With the
    // material's alphaMap reading the canvas R channel, solid black
    // (R=0) renders as a transparent shroud → the player sees through.
    // The 0.78 inner stop keeps the core sharp and only feathers the
    // outer 22%, which is what RTS shroud rims traditionally look like.
    for (let i = 0; i < this.sources.length; i++) {
      const source = this.sources[i];
      const cx = (source.x / this.mapWidth) * this.canvas.width;
      const cy = (1 - source.y / this.mapHeight) * this.canvas.height;
      const r = (source.radius / this.mapWidth) * this.canvas.width;
      const gradient = this.ctx.createRadialGradient(cx, cy, r * 0.78, cx, cy, r);
      gradient.addColorStop(0, 'rgb(0, 0, 0)');
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
      this.ctx.fillStyle = gradient;
      this.ctx.beginPath();
      this.ctx.arc(cx, cy, r, 0, Math.PI * 2);
      this.ctx.fill();
    }
  }
}

function textureDimensions(mapWidth: number, mapHeight: number): { width: number; height: number } {
  const aspect = mapWidth / Math.max(1, mapHeight);
  if (aspect >= 1) {
    return {
      width: MAX_TEXTURE_AXIS,
      height: Math.max(MIN_TEXTURE_AXIS, Math.round(MAX_TEXTURE_AXIS / aspect)),
    };
  }
  return {
    width: Math.max(MIN_TEXTURE_AXIS, Math.round(MAX_TEXTURE_AXIS * aspect)),
    height: MAX_TEXTURE_AXIS,
  };
}
