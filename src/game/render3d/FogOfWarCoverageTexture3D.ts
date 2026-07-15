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

const FOG_COVERAGE_FULL_SIGHT_MASK = 1;
const FOG_COVERAGE_RADAR_MASK = 2;
const FOG_COVERAGE_FULL_SIGHT_AND_RADAR_MASK = 3;
type FogCoverageChannelMask = 1 | 2 | 3;

type FogCoverageSource = {
  x: number;
  y: number;
  radius: number;
  channelMask: FogCoverageChannelMask;
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
  readonly worldSizeUniform: { value: THREE.Vector2 };
  readonly enabledUniform = { value: 0 };

  private readonly cellSize: number;
  private edgeSoftnessWorld: number;
  private readonly pixels: Uint8Array;
  private readonly texture: THREE.DataTexture;
  private readonly sources: FogCoverageSource[] = [];
  private sourceCount = 0;
  private readonly width: number;
  private readonly height: number;
  private readonly cellCenterWorldX: Float64Array;
  private readonly cellCenterWorldY: Float64Array;

  constructor(
    mapWidth: number,
    mapHeight: number,
  ) {
    const presentation = FOG_CONFIG.presentation;
    this.cellSize = Math.max(1, presentation.coverage.cellSizeWorld);
    this.edgeSoftnessWorld = Math.max(0, presentation.shade.edgeSoftnessWorld);
    this.width = Math.max(1, Math.ceil(mapWidth / this.cellSize));
    this.height = Math.max(1, Math.ceil(mapHeight / this.cellSize));
    this.cellCenterWorldX = new Float64Array(this.width);
    this.cellCenterWorldY = new Float64Array(this.height);
    for (let gx = 0; gx < this.width; gx++) {
      this.cellCenterWorldX[gx] = Math.min(mapWidth, (gx + 0.5) * this.cellSize);
    }
    for (let gy = 0; gy < this.height; gy++) {
      this.cellCenterWorldY[gy] = Math.min(mapHeight, (gy + 0.5) * this.cellSize);
    }
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
    for (let i = 0; i < this.sourceCount; i++) {
      this.stampSource(this.sources[i]);
    }
    this.texture.needsUpdate = true;
  }

  setEdgeSoftnessWorld(value: number): void {
    this.edgeSoftnessWorld = Number.isFinite(value) ? Math.max(0, value) : 0;
  }

  destroy(): void {
    this.texture.dispose();
    this.sources.length = 0;
    this.sourceCount = 0;
  }

  private collectSources(clientViewState: ClientViewState, localPlayerId: PlayerId): void {
    this.sourceCount = 0;
    const playerIds = clientViewState.getVisionPlayerIds(localPlayerId);
    for (let i = 0; i < playerIds.length; i++) {
      const playerId = playerIds[i];
      this.collectFromOwned(clientViewState.getUnitsByPlayer(playerId));
      this.collectFromOwned(clientViewState.getBuildingsByPlayer(playerId));
    }

    const pulses = clientViewState.getScanPulses();
    for (let i = 0; i < pulses.length; i++) {
      const pulse = pulses[i];
      this.pushSource(
        pulse.x,
        pulse.y,
        pulse.radius,
        FOG_COVERAGE_FULL_SIGHT_AND_RADAR_MASK,
      );
    }
  }

  private collectFromOwned(entities: readonly Entity[]): void {
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      if (canEntityProvideFullVision(entity)) {
        const radius = getEntityFullVisionRadius(entity);
        this.pushSource(
          entity.transform.x,
          entity.transform.y,
          radius,
          FOG_COVERAGE_FULL_SIGHT_AND_RADAR_MASK,
        );
      }
      if (canEntityProvideRadarVision(entity)) {
        this.pushSource(
          entity.transform.x,
          entity.transform.y,
          getEntityRadarRadius(entity),
          FOG_COVERAGE_RADAR_MASK,
        );
      }
    }
  }

  private pushSource(
    x: number,
    y: number,
    radius: number,
    channelMask: FogCoverageChannelMask,
  ): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(radius) || radius <= 0) {
      return;
    }
    const cursor = this.sourceCount;
    let source = this.sources[cursor];
    if (source === undefined) {
      source = { x, y, radius, channelMask };
      this.sources.push(source);
    } else {
      source.x = x;
      source.y = y;
      source.radius = radius;
      source.channelMask = channelMask;
    }
    this.sourceCount = cursor + 1;
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
    const writeFullSight = (source.channelMask & FOG_COVERAGE_FULL_SIGHT_MASK) !== 0;
    const writeRadar = (source.channelMask & FOG_COVERAGE_RADAR_MASK) !== 0;
    const cellCenterWorldX = this.cellCenterWorldX;
    const cellCenterWorldY = this.cellCenterWorldY;
    const width = this.width;
    for (let gy = minY; gy <= maxY; gy++) {
      const worldY = cellCenterWorldY[gy];
      const dy = worldY - source.y;
      const dySq = dy * dy;
      const rowOffset = gy * width;
      for (let gx = minX; gx <= maxX; gx++) {
        const worldX = cellCenterWorldX[gx];
        const dx = worldX - source.x;
        const distanceSq = dx * dx + dySq;
        if (distanceSq >= outerSq) continue;
        const next = softness <= 0 || distanceSq <= innerSq
          ? 255
          : Math.round((1 - smoothstep(inner, outer, Math.sqrt(distanceSq))) * 255);
        if (next <= 0) continue;
        const offset = (rowOffset + gx) * 4;
        if (writeFullSight) pixels[offset] = maxByte(pixels[offset], next);
        if (writeRadar) pixels[offset + 1] = maxByte(pixels[offset + 1], next);
      }
    }
  }
}
