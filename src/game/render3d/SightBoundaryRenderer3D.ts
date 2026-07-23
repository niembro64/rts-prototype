import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import type { ClientViewState } from '../network/ClientViewState';
import {
  forEachEntityTurretSensorSource,
} from '../sim/sensorCoverage';
import type { Entity, PlayerId } from '../sim/types';
import type { ViewportFootprint } from '../ViewportFootprint';
import type { OverlayLineSystem } from './OverlayLineSystem';
import type { GroundLineBatch3D } from './GroundLineBatch3D';
import { hexToRgb01 } from './colorUtils';

type SensorBoundaryMode = 'sight' | 'radar';

type SensorBoundaryRendererOptions = {
  mode?: SensorBoundaryMode;
};

const TAU = Math.PI * 2;
const EPSILON = 1e-5;
const STYLE = {
  initialLineCap: 4096,
  maxSegmentLength: 28,
  maxArcStepRad: Math.PI / 48,
};

const STYLE_BY_MODE = {
  sight: COLORS.effects.selectionOverlay.radiusOther,
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
 * - radar: total contact-level knowledge, including sight and every active
 *   above-water or underwater contact lane.
 */
export class SightBoundaryRenderer3D {
  private readonly parent: THREE.Group;
  private readonly getTerrainHeight: (x: number, y: number) => number;
  private readonly batch: GroundLineBatch3D;
  private readonly sourceXs: number[] = [];
  private readonly sourceYs: number[] = [];
  private readonly sourceRadii: number[] = [];
  private readonly intervalStarts: number[] = [];
  private readonly intervalEnds: number[] = [];
  private readonly mode: SensorBoundaryMode;
  private readonly color: { r: number; g: number; b: number };
  private readonly alpha: number;
  private readonly widthPx: number;
  private readonly groundLift: number;

  constructor(
    parent: THREE.Group,
    overlayLines: OverlayLineSystem,
    getTerrainHeight: (x: number, y: number) => number,
    options: SensorBoundaryRendererOptions = {},
  ) {
    this.parent = parent;
    this.getTerrainHeight = getTerrainHeight;
    this.mode = options.mode ?? 'sight';
    const colorStyle = STYLE_BY_MODE[this.mode];
    this.color = hexToRgb01(colorStyle.colorHex);
    this.alpha = colorStyle.opacity;
    const kind = this.mode === 'radar' ? 'radarBoundary' : 'sight';
    const style = overlayLines.style(kind);
    this.widthPx = style.widthPx;
    this.groundLift = style.groundLift;
    this.batch = overlayLines.createBatch(kind, STYLE.initialLineCap);
    parent.add(this.batch.mesh);
  }

  update(
    clientViewState: ClientViewState,
    localPlayerId: PlayerId,
    enabled: boolean,
    renderScope: ViewportFootprint,
  ): void {
    this.batch.begin();
    if (!enabled) {
      this.batch.finishFrame();
      return;
    }

    this.collectSources(clientViewState, localPlayerId, renderScope);
    if (this.sourceXs.length === 0) {
      this.batch.finishFrame();
      return;
    }

    for (let i = 0; i < this.sourceXs.length; i++) {
      this.drawVisibleBoundaryForSource(i);
    }

    this.batch.finishFrame();
  }

  destroy(): void {
    this.parent.remove(this.batch.mesh);
    this.batch.dispose();
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
      forEachEntityTurretSensorSource(entity, ({ position, sourceMedium, sensors }) => {
        this.pushSource(
          position.x,
          position.y,
          Math.max(
            sensors.fullSight[sourceMedium].aboveWater,
            sensors.fullSight[sourceMedium].underwater,
          ),
          renderScope,
        );
      });
    }
  }

  private collectRadarFromOwned(entities: readonly Entity[], renderScope: ViewportFootprint): void {
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      forEachEntityTurretSensorSource(entity, ({ position, sourceMedium, sensors }) => {
        const radarRadius = sensors.contactSight[sourceMedium].aboveWater;
        if (radarRadius > 0) {
          this.pushSource(position.x, position.y, radarRadius, renderScope);
        }
        const sonarRadius = sensors.contactSight[sourceMedium].underwater;
        if (sonarRadius > 0) {
          this.pushSource(position.x, position.y, sonarRadius, renderScope);
        }
      });
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
    let prevHeight = this.getTerrainHeight(prevX, prevY) + this.groundLift;
    const { r, g, b } = this.color;
    for (let i = 1; i <= segments; i++) {
      const angle = start + (span * i) / segments;
      const nextX = sourceX + Math.cos(angle) * sourceRadius;
      const nextY = sourceY + Math.sin(angle) * sourceRadius;
      const nextHeight = this.getTerrainHeight(nextX, nextY) + this.groundLift;
      this.batch.pushSegment(
        prevX, prevHeight, prevY,
        nextX, nextHeight, nextY,
        r, g, b, this.alpha, this.widthPx,
      );
      prevX = nextX;
      prevY = nextY;
      prevHeight = nextHeight;
    }
  }
}
