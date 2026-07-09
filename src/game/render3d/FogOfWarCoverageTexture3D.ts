import * as THREE from 'three';
import type { ClientViewState } from '../network/ClientViewState';
import {
  canEntityProvideFullVision,
  canEntityProvideRadarVision,
  getEntityFullVisionRadius,
  getEntityRadarRadius,
} from '../sim/sensorCoverage';
import type { Entity, PlayerId } from '../sim/types';
import { FOG_CONFIG } from '@/fogConfig';
import { configureSpriteTexture } from './threeUtils';

type FogCoverageChannel = 0 | 1;

type FogCoverageSource = {
  x: number;
  y: number;
  radius: number;
  channel: FogCoverageChannel;
};

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function maxByte(value: number, next: number): number {
  return next > value ? next : value;
}

/** Client-side presentation texture for live fog shading.
 *
 *  R = full-sight coverage, G = radar-level coverage. This is visual-only:
 *  authoritative fog filtering still comes from the host snapshot. */
export class FogOfWarCoverageTexture3D {
  readonly textureUniform: { value: THREE.DataTexture };
  readonly mapSizeUniform: { value: THREE.Vector2 };
  readonly worldSizeUniform: { value: THREE.Vector2 };
  readonly enabledUniform = { value: 0 };

  private readonly cellSize: number;
  private readonly edgeSoftnessWorld: number;
  private readonly pixels: Uint8Array;
  private readonly texture: THREE.DataTexture;
  private readonly sources: FogCoverageSource[] = [];
  private readonly width: number;
  private readonly height: number;

  constructor(
    private readonly mapWidth: number,
    private readonly mapHeight: number,
  ) {
    const shade = FOG_CONFIG.fogOfWar.shade;
    this.cellSize = Math.max(1, shade.cellSize);
    this.edgeSoftnessWorld = Math.max(0, shade.edgeSoftnessCells) * this.cellSize;
    this.width = Math.max(1, Math.ceil(mapWidth / this.cellSize));
    this.height = Math.max(1, Math.ceil(mapHeight / this.cellSize));
    this.pixels = new Uint8Array(this.width * this.height * 4);
    this.texture = new THREE.DataTexture(
      this.pixels,
      this.width,
      this.height,
      THREE.RGBAFormat,
    );
    configureSpriteTexture(this.texture, 'linear');
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.flipY = false;
    this.texture.needsUpdate = true;
    this.textureUniform = { value: this.texture };
    this.mapSizeUniform = { value: new THREE.Vector2(this.width, this.height) };
    this.worldSizeUniform = { value: new THREE.Vector2(mapWidth, mapHeight) };
  }

  update(
    clientViewState: ClientViewState,
    localPlayerId: PlayerId,
    enabled: boolean,
  ): void {
    this.enabledUniform.value = enabled ? 1 : 0;
    if (!enabled) return;

    this.pixels.fill(0);
    this.collectSources(clientViewState, localPlayerId);
    for (let i = 0; i < this.sources.length; i++) {
      this.stampSource(this.sources[i]);
    }
    this.texture.needsUpdate = true;
  }

  destroy(): void {
    this.texture.dispose();
    this.sources.length = 0;
  }

  private collectSources(clientViewState: ClientViewState, localPlayerId: PlayerId): void {
    this.sources.length = 0;
    const playerIds = clientViewState.getVisionPlayerIds(localPlayerId);
    for (let i = 0; i < playerIds.length; i++) {
      const playerId = playerIds[i];
      this.collectFromOwned(clientViewState.getUnitsByPlayer(playerId));
      this.collectFromOwned(clientViewState.getBuildingsByPlayer(playerId));
    }

    const pulses = clientViewState.getScanPulses();
    for (let i = 0; i < pulses.length; i++) {
      const pulse = pulses[i];
      this.pushSource(pulse.x, pulse.y, pulse.radius, 0);
      this.pushSource(pulse.x, pulse.y, pulse.radius, 1);
    }
  }

  private collectFromOwned(entities: readonly Entity[]): void {
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      if (canEntityProvideFullVision(entity)) {
        const radius = getEntityFullVisionRadius(entity);
        this.pushSource(entity.transform.x, entity.transform.y, radius, 0);
        this.pushSource(entity.transform.x, entity.transform.y, radius, 1);
      }
      if (canEntityProvideRadarVision(entity)) {
        this.pushSource(
          entity.transform.x,
          entity.transform.y,
          getEntityRadarRadius(entity),
          1,
        );
      }
    }
  }

  private pushSource(
    x: number,
    y: number,
    radius: number,
    channel: FogCoverageChannel,
  ): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(radius) || radius <= 0) {
      return;
    }
    this.sources.push({ x, y, radius, channel });
  }

  private stampSource(source: FogCoverageSource): void {
    const softness = this.edgeSoftnessWorld;
    const stampRadius = source.radius + softness;
    const minX = Math.max(0, Math.floor((source.x - stampRadius) / this.cellSize));
    const maxX = Math.min(this.width - 1, Math.floor((source.x + stampRadius) / this.cellSize));
    const minY = Math.max(0, Math.floor((source.y - stampRadius) / this.cellSize));
    const maxY = Math.min(this.height - 1, Math.floor((source.y + stampRadius) / this.cellSize));
    const inner = Math.max(0, source.radius - softness);
    const outer = source.radius + softness;
    const innerSq = inner * inner;
    const outerSq = outer * outer;
    const pixels = this.pixels;
    const channel = source.channel;
    const cellSize = this.cellSize;
    const mapWidth = this.mapWidth;
    const mapHeight = this.mapHeight;
    const width = this.width;
    for (let gy = minY; gy <= maxY; gy++) {
      const worldY = Math.min(mapHeight, (gy + 0.5) * cellSize);
      const dy = worldY - source.y;
      const dySq = dy * dy;
      const rowOffset = gy * width;
      for (let gx = minX; gx <= maxX; gx++) {
        const worldX = Math.min(mapWidth, (gx + 0.5) * cellSize);
        const dx = worldX - source.x;
        const distanceSq = dx * dx + dySq;
        if (distanceSq >= outerSq) continue;
        const next = softness <= 0 || distanceSq <= innerSq
          ? 255
          : Math.round((1 - smoothstep(inner, outer, Math.sqrt(distanceSq))) * 255);
        if (next <= 0) continue;
        const offset = (rowOffset + gx) * 4 + channel;
        pixels[offset] = maxByte(pixels[offset], next);
      }
    }
  }
}
