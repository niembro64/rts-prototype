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

type SensorBoundarySource = {
  x: number;
  y: number;
  radius: number;
};

export type SensorBoundaryMode = 'sight' | 'radar';

type SensorBoundaryRendererOptions = {
  mode?: SensorBoundaryMode;
};

type AngleInterval = {
  start: number;
  end: number;
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
  sight: COLORS.effects.selectionOverlay.radiusScale,
  radar: COLORS.effects.selectionOverlay.radar,
} as const;

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
  private readonly sources: SensorBoundarySource[] = [];
  private readonly intervals: AngleInterval[] = [];
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
    this.lineMesh.renderOrder = STYLE.renderOrder;
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
    if (this.sources.length === 0) {
      this.lineMesh.visible = false;
      return;
    }

    for (let i = 0; i < this.sources.length; i++) {
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
    this.sources.length = 0;
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
    this.sources.push({ x, y, radius });
  }

  private drawVisibleBoundaryForSource(sourceIndex: number): void {
    const source = this.sources[sourceIndex];
    this.intervals.length = 0;
    for (let i = 0; i < this.sources.length; i++) {
      if (i === sourceIndex) continue;
      if (this.addCoveredInterval(sourceIndex, i)) return;
    }

    this.mergeIntervals();
    let cursor = 0;
    for (let i = 0; i < this.intervals.length; i++) {
      const interval = this.intervals[i];
      if (interval.start > cursor + EPSILON) {
        this.drawArc(source, cursor, interval.start);
      }
      cursor = Math.max(cursor, interval.end);
    }
    if (cursor < TAU - EPSILON) {
      this.drawArc(source, cursor, TAU);
    }
  }

  /** Returns true when the source is fully covered by the other source. */
  private addCoveredInterval(sourceIndex: number, otherIndex: number): boolean {
    const source = this.sources[sourceIndex];
    const other = this.sources[otherIndex];
    const dx = other.x - source.x;
    const dy = other.y - source.y;
    const d = Math.hypot(dx, dy);

    if (d <= EPSILON) {
      if (other.radius > source.radius + EPSILON) return true;
      return Math.abs(other.radius - source.radius) <= EPSILON && otherIndex < sourceIndex;
    }

    if (d + source.radius <= other.radius + EPSILON) return true;
    if (d >= source.radius + other.radius - EPSILON) return false;
    if (d + other.radius <= source.radius + EPSILON) return false;

    const centerAngle = Math.atan2(dy, dx);
    const halfAngle = Math.acos(clampUnit(
      (source.radius * source.radius + d * d - other.radius * other.radius) /
      (2 * source.radius * d),
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
      this.intervals.push({ start: s, end: e });
    } else {
      this.intervals.push({ start: s, end: TAU });
      this.intervals.push({ start: 0, end: e });
    }
    return false;
  }

  private mergeIntervals(): void {
    const intervals = this.intervals;
    if (intervals.length <= 1) return;
    intervals.sort((a, b) => a.start - b.start);
    let write = 0;
    for (let read = 1; read < intervals.length; read++) {
      const current = intervals[write];
      const next = intervals[read];
      if (next.start <= current.end + EPSILON) {
        current.end = Math.max(current.end, next.end);
      } else {
        write++;
        intervals[write] = next;
      }
    }
    intervals.length = write + 1;
  }

  private drawArc(source: SensorBoundarySource, start: number, end: number): void {
    const span = end - start;
    if (span <= EPSILON) return;

    const segments = Math.max(
      1,
      Math.ceil(span / STYLE.maxArcStepRad),
      Math.ceil((span * source.radius) / STYLE.maxSegmentLength),
    );
    let prev = this.sampleArcPoint(source, start);
    const { r, g, b } = this.color;
    for (let i = 1; i <= segments; i++) {
      const angle = start + (span * i) / segments;
      const next = this.sampleArcPoint(source, angle);
      this.lineBuffer.pushSegment(
        prev.x, prev.height, prev.y,
        next.x, next.height, next.y,
        r, g, b,
      );
      prev = next;
    }
  }

  private sampleArcPoint(source: SensorBoundarySource, angle: number): { x: number; y: number; height: number } {
    const x = source.x + Math.cos(angle) * source.radius;
    const y = source.y + Math.sin(angle) * source.radius;
    return {
      x,
      y,
      height: this.getTerrainHeight(x, y) + STYLE.groundLift,
    };
  }
}
