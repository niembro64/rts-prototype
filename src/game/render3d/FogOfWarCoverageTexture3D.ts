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

type FogCoverageKernel = {
  minDx: number;
  minDy: number;
  width: number;
  height: number;
  values: Uint8Array;
};

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function maxByte(value: number, next: number): number {
  return next > value ? next : value;
}

function mixHash(hash: number, value: number): number {
  hash ^= value + 0x9e3779b9 + (hash << 6) + (hash >>> 2);
  return hash >>> 0;
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
  private readonly sourceSnapWorld: number;
  private readonly pixels: Uint8Array;
  private readonly texture: THREE.DataTexture;
  private readonly sourceXs: number[] = [];
  private readonly sourceYs: number[] = [];
  private readonly sourceRadii: number[] = [];
  private readonly sourceChannels: FogCoverageChannel[] = [];
  private readonly kernelCache = new Map<string, FogCoverageKernel>();
  private readonly width: number;
  private readonly height: number;
  private sourceHash = 0;
  private lastAppliedSourceCount = -1;
  private lastAppliedSourceHash = -1;

  constructor(
    mapWidth: number,
    mapHeight: number,
  ) {
    const shade = FOG_CONFIG.fogOfWar.shade;
    this.cellSize = Math.max(1, shade.cellSize);
    this.edgeSoftnessWorld = Math.max(0, shade.edgeSoftnessCells) * this.cellSize;
    this.sourceSnapWorld = Math.max(1, (shade.sourceSnapCells ?? 0.5) * this.cellSize);
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
    if (!enabled) {
      this.lastAppliedSourceCount = -1;
      this.lastAppliedSourceHash = -1;
      return;
    }

    this.collectSources(clientViewState, localPlayerId);
    if (
      this.sourceXs.length === this.lastAppliedSourceCount &&
      this.sourceHash === this.lastAppliedSourceHash
    ) {
      return;
    }

    this.pixels.fill(0);
    for (let i = 0; i < this.sourceXs.length; i++) {
      this.stampSource(i);
    }
    this.lastAppliedSourceCount = this.sourceXs.length;
    this.lastAppliedSourceHash = this.sourceHash;
    this.texture.needsUpdate = true;
  }

  destroy(): void {
    this.texture.dispose();
    this.sourceXs.length = 0;
    this.sourceYs.length = 0;
    this.sourceRadii.length = 0;
    this.sourceChannels.length = 0;
    this.kernelCache.clear();
  }

  private collectSources(clientViewState: ClientViewState, localPlayerId: PlayerId): void {
    this.sourceXs.length = 0;
    this.sourceYs.length = 0;
    this.sourceRadii.length = 0;
    this.sourceChannels.length = 0;
    this.sourceHash = 0;
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
    const snap = this.sourceSnapWorld;
    const snappedX = Math.round(x / snap) * snap;
    const snappedY = Math.round(y / snap) * snap;
    const snappedRadius = Math.round(radius);
    this.sourceXs.push(snappedX);
    this.sourceYs.push(snappedY);
    this.sourceRadii.push(snappedRadius);
    this.sourceChannels.push(channel);
    this.sourceHash = mixHash(this.sourceHash, Math.round(snappedX / snap));
    this.sourceHash = mixHash(this.sourceHash, Math.round(snappedY / snap));
    this.sourceHash = mixHash(this.sourceHash, snappedRadius);
    this.sourceHash = mixHash(this.sourceHash, channel);
  }

  private stampSource(index: number): void {
    const sourceX = this.sourceXs[index];
    const sourceY = this.sourceYs[index];
    const sourceRadius = this.sourceRadii[index];
    const sourceChannel = this.sourceChannels[index];
    const centerCellX = Math.floor(sourceX / this.cellSize);
    const centerCellY = Math.floor(sourceY / this.cellSize);
    const kernel = this.coverageKernel(sourceX, sourceY, sourceRadius);
    const srcWidth = kernel.width;
    const srcHeight = kernel.height;
    const srcValues = kernel.values;
    const dstBaseX = centerCellX + kernel.minDx;
    const dstBaseY = centerCellY + kernel.minDy;
    const pixels = this.pixels;
    const width = this.width;
    const height = this.height;
    const minKy = Math.max(0, -dstBaseY);
    const maxKy = Math.min(srcHeight - 1, height - 1 - dstBaseY);
    const minKx = Math.max(0, -dstBaseX);
    const maxKx = Math.min(srcWidth - 1, width - 1 - dstBaseX);
    if (minKy > maxKy || minKx > maxKx) return;

    for (let ky = minKy; ky <= maxKy; ky++) {
      const dstOffset = ((dstBaseY + ky) * width + dstBaseX + minKx) * 4 + sourceChannel;
      const srcOffset = ky * srcWidth + minKx;
      for (let kx = minKx, dst = dstOffset, src = srcOffset; kx <= maxKx; kx++, dst += 4, src++) {
        const next = srcValues[src];
        if (next !== 0) pixels[dst] = maxByte(pixels[dst], next);
      }
    }
  }

  private coverageKernel(
    sourceX: number,
    sourceY: number,
    sourceRadius: number,
  ): FogCoverageKernel {
    const fracX = sourceX - Math.floor(sourceX / this.cellSize) * this.cellSize;
    const fracY = sourceY - Math.floor(sourceY / this.cellSize) * this.cellSize;
    const fracXKey = Math.round(fracX);
    const fracYKey = Math.round(fracY);
    const radiusKey = Math.round(sourceRadius);
    const key = `${radiusKey}:${fracXKey}:${fracYKey}`;
    const cached = this.kernelCache.get(key);
    if (cached !== undefined) return cached;

    const softness = this.edgeSoftnessWorld;
    const stampRadius = sourceRadius + softness;
    const minDx = Math.floor((fracX - stampRadius) / this.cellSize);
    const maxDx = Math.floor((fracX + stampRadius) / this.cellSize);
    const minDy = Math.floor((fracY - stampRadius) / this.cellSize);
    const maxDy = Math.floor((fracY + stampRadius) / this.cellSize);
    const inner = Math.max(0, sourceRadius - softness);
    const outer = sourceRadius + softness;
    const innerSq = inner * inner;
    const outerSq = outer * outer;
    const cellSize = this.cellSize;
    const width = Math.max(0, maxDx - minDx + 1);
    const height = Math.max(0, maxDy - minDy + 1);
    const values = new Uint8Array(width * height);

    for (let ky = 0; ky < height; ky++) {
      const dy = (minDy + ky + 0.5) * cellSize - fracY;
      const dySq = dy * dy;
      const rowOffset = ky * width;
      for (let kx = 0; kx < width; kx++) {
        const dx = (minDx + kx + 0.5) * cellSize - fracX;
        const distanceSq = dx * dx + dySq;
        if (distanceSq >= outerSq) continue;
        const next = softness <= 0 || distanceSq <= innerSq
          ? 255
          : Math.round((1 - smoothstep(inner, outer, Math.sqrt(distanceSq))) * 255);
        if (next > 0) values[rowOffset + kx] = next;
      }
    }

    const kernel = { minDx, minDy, width, height, values };
    this.kernelCache.set(key, kernel);
    return kernel;
  }
}
