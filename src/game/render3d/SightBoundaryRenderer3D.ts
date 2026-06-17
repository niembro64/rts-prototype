import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import type { ClientViewState } from '../network/ClientViewState';
import {
  canEntityProvideFullVision,
  canEntityProvideRadarVision,
  getEntityFullVisionRadius,
  getEntityRadarRadius,
} from '../sim/sensorCoverage';
import type { Entity, PlayerId } from '../sim/types';
import type { ViewportFootprint } from '../ViewportFootprint';
import { DynamicLineBuffer3D } from './DynamicLineBuffer3D';
import { hexToRgb01 } from './colorUtils';

export type SensorBoundaryMode = 'sight' | 'radar';

type SensorBoundaryRendererOptions = {
  mode?: SensorBoundaryMode;
};

const TAU = Math.PI * 2;
const EPSILON = 1e-5;
const STYLE = {
  initialLineCap: 4096,
  groundLift: 9,
  maxSegmentLength: 28,
  maxArcStepRad: Math.PI / 48,
  renderOrder: 24,
};

const STYLE_BY_MODE = {
  sight: COLORS.effects.selectionOverlay.radiusVisual,
  radar: COLORS.effects.selectionOverlay.radar,
} as const;

const RENDER_ORDER_BY_MODE: Record<SensorBoundaryMode, number> = {
  radar: STYLE.renderOrder,
  sight: STYLE.renderOrder + 1,
};

function normalizeAngle(angle: number): number {
  const n = angle % TAU;
  return n < 0 ? n + TAU : n;
}

function clampUnit(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

/**
 * Draws sensor coverage union boundaries.
 *
 * - sight: total player full sight, including active scan pulses.
 * - radar: total radar-level knowledge, which includes all sight sources
 *   plus radar-only sources because full sight is a stronger intel tier.
 */
export class SightBoundaryRenderer3D {
  private readonly parent: THREE.Group;
  private readonly getTerrainHeight: (x: number, y: number) => number;
  private readonly lineBuffer = new DynamicLineBuffer3D(STYLE.initialLineCap);
  private readonly material: THREE.LineBasicMaterial;
  private readonly lineMesh: THREE.LineSegments;
  private readonly sourceXs: number[] = [];
  private readonly sourceYs: number[] = [];
  private readonly sourceRadii: number[] = [];
  private readonly intervalStarts: number[] = [];
  private readonly intervalEnds: number[] = [];
  private readonly mode: SensorBoundaryMode;
  private readonly color: { r: number; g: number; b: number };

  constructor(
    parent: THREE.Group,
    getTerrainHeight: (x: number, y: number) => number,
    options: SensorBoundaryRendererOptions = {},
  ) {
    this.parent = parent;
    this.getTerrainHeight = getTerrainHeight;
    this.mode = options.mode ?? 'sight';
    const style = STYLE_BY_MODE[this.mode];
    this.color = hexToRgb01(style.colorHex);
    this.material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: style.opacity,
      depthTest: false,
      depthWrite: false,
    });
    this.lineMesh = new THREE.LineSegments(this.lineBuffer.geometry, this.material);
    this.lineMesh.frustumCulled = false;
    this.lineMesh.renderOrder = RENDER_ORDER_BY_MODE[this.mode];
    this.lineMesh.visible = false;
    parent.add(this.lineMesh);
  }

  update(
    clientViewState: ClientViewState,
    localPlayerId: PlayerId,
    enabled: boolean,
    renderScope: ViewportFootprint,
  ): void {
    if (!enabled) {
      this.clear();
      return;
    }

    this.collectSources(clientViewState, localPlayerId, renderScope);
    this.lineBuffer.resetDrawRange();
    if (this.sourceXs.length === 0) {
      this.lineMesh.visible = false;
      return;
    }

    for (let i = 0; i < this.sourceXs.length; i++) {
      this.drawVisibleBoundaryForSource(i);
    }

    const segmentCount = this.lineBuffer.finishFrame();
    this.lineMesh.visible = segmentCount > 0;
  }

  destroy(): void {
    this.parent.remove(this.lineMesh);
    this.lineBuffer.dispose();
    this.material.dispose();
  }

  private clear(): void {
    if (!this.lineMesh.visible && this.lineBuffer.count === 0) return;
    this.lineBuffer.resetDrawRange();
    this.lineMesh.visible = false;
  }

  private collectSources(
    clientViewState: ClientViewState,
    localPlayerId: PlayerId,
    renderScope: ViewportFootprint,
  ): void {
    this.sourceXs.length = 0;
    this.sourceYs.length = 0;
    this.sourceRadii.length = 0;
    const playerIds = clientViewState.getVisionPlayerIds(localPlayerId);
    for (let i = 0; i < playerIds.length; i++) {
      const playerId = playerIds[i];
      this.collectSightFromOwned(clientViewState.getUnitsByPlayer(playerId), renderScope);
      this.collectSightFromOwned(clientViewState.getBuildingsByPlayer(playerId), renderScope);
      if (this.mode === 'radar') {
        this.collectRadarFromOwned(clientViewState.getUnitsByPlayer(playerId), renderScope);
        this.collectRadarFromOwned(clientViewState.getBuildingsByPlayer(playerId), renderScope);
      }
    }

    const pulses = clientViewState.getScanPulses();
    for (let i = 0; i < pulses.length; i++) {
      const pulse = pulses[i];
      this.pushSource(pulse.x, pulse.y, pulse.radius, renderScope);
    }
  }

  private collectSightFromOwned(entities: readonly Entity[], renderScope: ViewportFootprint): void {
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      if (!canEntityProvideFullVision(entity)) continue;
      this.pushSource(
        entity.transform.x,
        entity.transform.y,
        getEntityFullVisionRadius(entity),
        renderScope,
      );
    }
  }

  private collectRadarFromOwned(entities: readonly Entity[], renderScope: ViewportFootprint): void {
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      if (!canEntityProvideRadarVision(entity)) continue;
      this.pushSource(
        entity.transform.x,
        entity.transform.y,
        getEntityRadarRadius(entity),
        renderScope,
      );
    }
  }

  private pushSource(
    x: number,
    y: number,
    radius: number,
    renderScope: ViewportFootprint,
  ): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(radius) || radius <= 0) {
      return;
    }
    if (!renderScope.inScope(x, y, radius)) return;
    this.sourceXs.push(x);
    this.sourceYs.push(y);
    this.sourceRadii.push(radius);
  }

  private drawVisibleBoundaryForSource(sourceIndex: number): void {
    this.intervalStarts.length = 0;
    this.intervalEnds.length = 0;
    for (let i = 0; i < this.sourceXs.length; i++) {
      if (i === sourceIndex) continue;
      if (this.addCoveredInterval(sourceIndex, i)) return;
    }

    this.mergeIntervals();
    let cursor = 0;
    for (let i = 0; i < this.intervalStarts.length; i++) {
      const start = this.intervalStarts[i];
      if (start > cursor + EPSILON) {
        this.drawArc(sourceIndex, cursor, start);
      }
      cursor = Math.max(cursor, this.intervalEnds[i]);
    }
    if (cursor < TAU - EPSILON) {
      this.drawArc(sourceIndex, cursor, TAU);
    }
  }

  /** Returns true when the source is fully covered by the other source. */
  private addCoveredInterval(sourceIndex: number, otherIndex: number): boolean {
    const sourceX = this.sourceXs[sourceIndex];
    const sourceY = this.sourceYs[sourceIndex];
    const sourceRadius = this.sourceRadii[sourceIndex];
    const otherX = this.sourceXs[otherIndex];
    const otherY = this.sourceYs[otherIndex];
    const otherRadius = this.sourceRadii[otherIndex];
    const dx = otherX - sourceX;
    const dy = otherY - sourceY;
    const d = Math.hypot(dx, dy);

    if (d <= EPSILON) {
      if (otherRadius > sourceRadius + EPSILON) return true;
      return Math.abs(otherRadius - sourceRadius) <= EPSILON && otherIndex < sourceIndex;
    }

    if (d + sourceRadius <= otherRadius + EPSILON) return true;
    if (d >= sourceRadius + otherRadius - EPSILON) return false;
    if (d + otherRadius <= sourceRadius + EPSILON) return false;

    const centerAngle = Math.atan2(dy, dx);
    const halfAngle = Math.acos(clampUnit(
      (sourceRadius * sourceRadius + d * d - otherRadius * otherRadius) /
      (2 * sourceRadius * d),
    ));
    return this.pushInterval(centerAngle - halfAngle, centerAngle + halfAngle);
  }

  /** Returns true when the interval covers the whole circle. */
  private pushInterval(start: number, end: number): boolean {
    const span = end - start;
    if (span >= TAU - EPSILON) return true;

    const s = normalizeAngle(start);
    const e = normalizeAngle(end);
    if (s <= e) {
      this.intervalStarts.push(s);
      this.intervalEnds.push(e);
    } else {
      this.intervalStarts.push(s);
      this.intervalEnds.push(TAU);
      this.intervalStarts.push(0);
      this.intervalEnds.push(e);
    }
    return false;
  }

  private mergeIntervals(): void {
    const starts = this.intervalStarts;
    const ends = this.intervalEnds;
    if (starts.length <= 1) return;
    this.sortIntervals();
    let write = 0;
    for (let read = 1; read < starts.length; read++) {
      if (starts[read] <= ends[write] + EPSILON) {
        ends[write] = Math.max(ends[write], ends[read]);
      } else {
        write++;
        starts[write] = starts[read];
        ends[write] = ends[read];
      }
    }
    starts.length = write + 1;
    ends.length = write + 1;
  }

  private sortIntervals(): void {
    const starts = this.intervalStarts;
    const ends = this.intervalEnds;
    for (let i = 1; i < starts.length; i++) {
      const start = starts[i];
      const end = ends[i];
      let j = i - 1;
      while (j >= 0 && starts[j] > start) {
        starts[j + 1] = starts[j];
        ends[j + 1] = ends[j];
        j--;
      }
      starts[j + 1] = start;
      ends[j + 1] = end;
    }
  }

  private drawArc(sourceIndex: number, start: number, end: number): void {
    const span = end - start;
    if (span <= EPSILON) return;

    const sourceRadius = this.sourceRadii[sourceIndex];
    const segments = Math.max(
      1,
      Math.ceil(span / STYLE.maxArcStepRad),
      Math.ceil((span * sourceRadius) / STYLE.maxSegmentLength),
    );
    const sourceX = this.sourceXs[sourceIndex];
    const sourceY = this.sourceYs[sourceIndex];
    let prevX = sourceX + Math.cos(start) * sourceRadius;
    let prevY = sourceY + Math.sin(start) * sourceRadius;
    let prevHeight = this.getTerrainHeight(prevX, prevY) + STYLE.groundLift;
    const { r, g, b } = this.color;
    for (let i = 1; i <= segments; i++) {
      const angle = start + (span * i) / segments;
      const nextX = sourceX + Math.cos(angle) * sourceRadius;
      const nextY = sourceY + Math.sin(angle) * sourceRadius;
      const nextHeight = this.getTerrainHeight(nextX, nextY) + STYLE.groundLift;
      this.lineBuffer.pushSegment(
        prevX, prevHeight, prevY,
        nextX, nextHeight, nextY,
        r, g, b,
      );
      prevX = nextX;
      prevY = nextY;
      prevHeight = nextHeight;
    }
  }
}
