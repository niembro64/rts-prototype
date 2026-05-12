import * as THREE from 'three';
import type { ClientViewState } from '../network/ClientViewState';
import type { Entity, PlayerId } from '../sim/types';
import {
  canEntityProvideVision,
  getEntityVisionRadius,
} from '../network/stateSerializerVisibility';

const MAX_TEXTURE_AXIS = 512;
const MIN_TEXTURE_AXIS = 192;
const UPDATE_INTERVAL_MS = 110;
const UNEXPLORED_ALPHA = 245;
const EXPLORED_ALPHA = 150;

type VisionSource = {
  x: number;
  y: number;
  radius: number;
};

export class FogOfWarRenderer3D {
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
    if (!ctx) throw new Error('FogOfWarRenderer3D failed to create 2D canvas context');
    this.ctx = ctx;
    this.imageData = ctx.createImageData(dims.width, dims.height);
    this.revealed = new Uint8Array(dims.width * dims.height);

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;

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
    if (!enabled) return;

    if (this.lastPlayerId !== localPlayerId) {
      this.lastPlayerId = localPlayerId;
      this.revealed.fill(0);
      this.updateAccumMs = UPDATE_INTERVAL_MS;
    }

    this.updateAccumMs += deltaMs;
    if (this.updateAccumMs < UPDATE_INTERVAL_MS) return;
    this.updateAccumMs = 0;

    this.collectSources(clientViewState, localPlayerId);
    this.markRevealed();
    this.paintAlphaMap();
    this.texture.needsUpdate = true;
  }

  destroy(): void {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }

  private collectSources(clientViewState: ClientViewState, localPlayerId: PlayerId): void {
    this.sources.length = 0;
    this.collectFrom(clientViewState.getUnits(), localPlayerId);
    this.collectFrom(clientViewState.getBuildings(), localPlayerId);
  }

  private collectFrom(entities: readonly Entity[], localPlayerId: PlayerId): void {
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      if (entity.ownership?.playerId !== localPlayerId) continue;
      if (!canEntityProvideVision(entity)) continue;
      this.sources.push({
        x: entity.transform.x,
        y: entity.transform.y,
        radius: getEntityVisionRadius(entity),
      });
    }
  }

  private markRevealed(): void {
    const width = this.canvas.width;
    const height = this.canvas.height;
    for (let i = 0; i < this.sources.length; i++) {
      const source = this.sources[i];
      const cx = (source.x / this.mapWidth) * width;
      const cy = (1 - source.y / this.mapHeight) * height;
      const r = (source.radius / this.mapWidth) * width;
      const minX = Math.max(0, Math.floor(cx - r));
      const maxX = Math.min(width - 1, Math.ceil(cx + r));
      const minY = Math.max(0, Math.floor(cy - r));
      const maxY = Math.min(height - 1, Math.ceil(cy + r));
      const r2 = r * r;
      for (let y = minY; y <= maxY; y++) {
        const dy = y - cy;
        const row = y * width;
        for (let x = minX; x <= maxX; x++) {
          const dx = x - cx;
          if (dx * dx + dy * dy <= r2) this.revealed[row + x] = 1;
        }
      }
    }
  }

  private paintAlphaMap(): void {
    const data = this.imageData.data;
    for (let i = 0, p = 0; i < this.revealed.length; i++, p += 4) {
      const v = this.revealed[i] ? EXPLORED_ALPHA : UNEXPLORED_ALPHA;
      data[p] = v;
      data[p + 1] = v;
      data[p + 2] = v;
      data[p + 3] = 255;
    }
    this.ctx.putImageData(this.imageData, 0, 0);

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
