import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import type { ClientViewState } from '../network/ClientViewState';
import {
  forEachEntityTurretSensorSource,
  type TurretSensorSource,
} from '../sim/sensorCoverage';
import type { Entity, PlayerId } from '../sim/types';
import type { SensorMedium } from '../sim/sensorConfig';
import type { SensorCapabilityConfig } from '../../types/blueprints';
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
/** P0-06: culling pad AND camera-bucket size for the retained rebuild. */
const BOUNDARY_SCOPE_PAD = 512;
const STYLE = {
  initialLineCap: 4096,
  maxSegmentLength: 28,
  maxArcStepRad: Math.PI / 48,
};

const STYLE_BY_MODE_AND_MEDIUM = {
  sight: {
    aboveWater: COLORS.effects.selectionOverlay.radiusOther,
    underwater: COLORS.effects.selectionOverlay.waterSight,
  },
  radar: {
    aboveWater: COLORS.effects.selectionOverlay.radar,
    underwater: COLORS.effects.selectionOverlay.sonar,
  },
} as const;

const RENDER_STYLE_BY_MODE_AND_MEDIUM = {
  sight: {
    aboveWater: {
      color: hexToRgb01(STYLE_BY_MODE_AND_MEDIUM.sight.aboveWater.colorHex),
      alpha: STYLE_BY_MODE_AND_MEDIUM.sight.aboveWater.opacity,
    },
    underwater: {
      color: hexToRgb01(STYLE_BY_MODE_AND_MEDIUM.sight.underwater.colorHex),
      alpha: STYLE_BY_MODE_AND_MEDIUM.sight.underwater.opacity,
    },
  },
  radar: {
    aboveWater: {
      color: hexToRgb01(STYLE_BY_MODE_AND_MEDIUM.radar.aboveWater.colorHex),
      alpha: STYLE_BY_MODE_AND_MEDIUM.radar.aboveWater.opacity,
    },
    underwater: {
      color: hexToRgb01(STYLE_BY_MODE_AND_MEDIUM.radar.underwater.colorHex),
      alpha: STYLE_BY_MODE_AND_MEDIUM.radar.underwater.opacity,
    },
  },
} as const;

const TARGET_MEDIA: readonly SensorMedium[] = ['aboveWater', 'underwater'];

type SensorBoundaryTier = 'fullSight' | 'contactSight';

/** Exact source-medium x target-medium lookup used by coverage presentation.
 * Keeping this as a matrix lookup (never a max across target media) prevents a
 * large air radar circle from erasing or inflating an independent sonar edge. */
export function getSensorBoundarySourceRadius(
  sensors: SensorCapabilityConfig,
  tier: SensorBoundaryTier,
  sourceMedium: SensorMedium,
  targetMedium: SensorMedium,
): number {
  return sensors[tier][sourceMedium][targetMedium];
}

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
  private lastEnabled: boolean | null = null;
  private lastPlayerId: PlayerId | null = null;
  private lastEntitySetVersion = -1;
  private lastBoundsKey = '';
  private lastTick = -1;
  private readonly sourceXs: number[] = [];
  private readonly sourceYs: number[] = [];
  private readonly sourceRadii: number[] = [];
  private readonly intervalStarts: number[] = [];
  private readonly intervalEnds: number[] = [];
  private readonly mode: SensorBoundaryMode;
  private readonly widthPx: number;
  private readonly groundLift: number;
  private collectRenderScope: ViewportFootprint | undefined;
  private collectTargetMedium: SensorMedium = 'aboveWater';

  private readonly collectSightSource = ({
    position,
    sourceMedium,
    sensors,
    operational,
  }: TurretSensorSource): void => {
    if (!operational.fullSight || this.collectRenderScope === undefined) return;
    this.pushSource(
      position.x,
      position.y,
      getSensorBoundarySourceRadius(
        sensors,
        'fullSight',
        sourceMedium,
        this.collectTargetMedium,
      ),
      this.collectRenderScope,
    );
  };

  private readonly collectContactSource = ({
    position,
    sourceMedium,
    sensors,
    operational,
  }: TurretSensorSource): void => {
    if (!operational.contactSight || this.collectRenderScope === undefined) return;
    this.pushSource(
      position.x,
      position.y,
      getSensorBoundarySourceRadius(
        sensors,
        'contactSight',
        sourceMedium,
        this.collectTargetMedium,
      ),
      this.collectRenderScope,
    );
  };

  constructor(
    parent: THREE.Group,
    overlayLines: OverlayLineSystem,
    getTerrainHeight: (x: number, y: number) => number,
    options: SensorBoundaryRendererOptions = {},
  ) {
    this.parent = parent;
    this.getTerrainHeight = getTerrainHeight;
    this.mode = options.mode ?? 'sight';
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
    // P0-06: the O(S^2) union + terrain resample rebuild is gated on its
    // actual inputs — every new fixed tick (sensor truth), lifecycle/mode/
    // seat changes, or the camera crossing a padded 512-unit bucket (the
    // source culling below is padded by the same margin). Between rebuilds
    // the retained line batch keeps drawing — its points are world-space
    // and reproject under the moving camera for free.
    const tick = clientViewState.getTick();
    const entitySetVersion = clientViewState.getEntitySetVersion();
    const bounds = renderScope.getBounds(BOUNDARY_SCOPE_PAD);
    const boundsKey =
      `${Math.floor(bounds.minX / BOUNDARY_SCOPE_PAD)}:${Math.floor(bounds.minY / BOUNDARY_SCOPE_PAD)}:` +
      `${Math.floor(bounds.maxX / BOUNDARY_SCOPE_PAD)}:${Math.floor(bounds.maxY / BOUNDARY_SCOPE_PAD)}:` +
      `${renderScope.getMode()}`;
    const inputsChanged =
      enabled !== this.lastEnabled ||
      localPlayerId !== this.lastPlayerId ||
      entitySetVersion !== this.lastEntitySetVersion ||
      boundsKey !== this.lastBoundsKey;
    // Sensor truth changes at fixed-tick cadence; rebuild on every new
    // tick (20 Hz) so rings track their movers as tightly as the fog shade
    // does, while idle scenes and pure camera pans keep the retained
    // world-space batch.
    const tickDue = tick !== this.lastTick;
    if (!inputsChanged && !tickDue) return;
    this.lastEnabled = enabled;
    this.lastPlayerId = localPlayerId;
    this.lastEntitySetVersion = entitySetVersion;
    this.lastBoundsKey = boundsKey;
    this.lastTick = tick;

    this.batch.begin();
    if (!enabled) {
      this.batch.finishFrame();
      return;
    }

    // Each target medium gets its own union. Combining these arrays first
    // lets a large air-radar circle incorrectly erase a smaller sonar edge,
    // even though those are orthogonal facts about different targets.
    for (let mediumIndex = 0; mediumIndex < TARGET_MEDIA.length; mediumIndex++) {
      const targetMedium = TARGET_MEDIA[mediumIndex];
      this.collectSources(clientViewState, localPlayerId, renderScope, targetMedium);
      const renderStyle = RENDER_STYLE_BY_MODE_AND_MEDIUM[this.mode][targetMedium];
      for (let i = 0; i < this.sourceXs.length; i++) {
        this.drawVisibleBoundaryForSource(i, renderStyle.color, renderStyle.alpha);
      }
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
    targetMedium: SensorMedium,
  ): void {
    this.sourceXs.length = 0;
    this.sourceYs.length = 0;
    this.sourceRadii.length = 0;
    const playerIds = clientViewState.getVisionPlayerIds(localPlayerId);
    for (let i = 0; i < playerIds.length; i++) {
      const playerId = playerIds[i];
      this.collectSightFromOwned(
        clientViewState.getUnitsByPlayer(playerId),
        renderScope,
        targetMedium,
      );
      this.collectSightFromOwned(
        clientViewState.getBuildingsByPlayer(playerId),
        renderScope,
        targetMedium,
      );
      if (this.mode === 'radar') {
        this.collectRadarFromOwned(
          clientViewState.getUnitsByPlayer(playerId),
          renderScope,
          targetMedium,
        );
        this.collectRadarFromOwned(
          clientViewState.getBuildingsByPlayer(playerId),
          renderScope,
          targetMedium,
        );
      }
    }

    const pulses = clientViewState.getScanPulses();
    for (let i = 0; i < pulses.length; i++) {
      const pulse = pulses[i];
      this.pushSource(pulse.x, pulse.y, pulse.radius, renderScope);
    }
  }

  private collectSightFromOwned(
    entities: readonly Entity[],
    renderScope: ViewportFootprint,
    targetMedium: SensorMedium,
  ): void {
    this.collectRenderScope = renderScope;
    this.collectTargetMedium = targetMedium;
    for (let i = 0; i < entities.length; i++) {
      forEachEntityTurretSensorSource(entities[i], this.collectSightSource);
    }
  }

  private collectRadarFromOwned(
    entities: readonly Entity[],
    renderScope: ViewportFootprint,
    targetMedium: SensorMedium,
  ): void {
    this.collectRenderScope = renderScope;
    this.collectTargetMedium = targetMedium;
    for (let i = 0; i < entities.length; i++) {
      forEachEntityTurretSensorSource(entities[i], this.collectContactSource);
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
    // Padded so the retained batch survives camera drift up to the P0-06
    // rebuild bucket without rings popping in late at the screen edge.
    if (!renderScope.inScope(x, y, radius + BOUNDARY_SCOPE_PAD)) return;
    this.sourceXs.push(x);
    this.sourceYs.push(y);
    this.sourceRadii.push(radius);
  }

  private drawVisibleBoundaryForSource(
    sourceIndex: number,
    color: { r: number; g: number; b: number },
    alpha: number,
  ): void {
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
        this.drawArc(sourceIndex, cursor, start, color, alpha);
      }
      cursor = Math.max(cursor, this.intervalEnds[i]);
    }
    if (cursor < TAU - EPSILON) {
      this.drawArc(sourceIndex, cursor, TAU, color, alpha);
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

  private drawArc(
    sourceIndex: number,
    start: number,
    end: number,
    color: { r: number; g: number; b: number },
    alpha: number,
  ): void {
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
    const { r, g, b } = color;
    for (let i = 1; i <= segments; i++) {
      const angle = start + (span * i) / segments;
      const nextX = sourceX + Math.cos(angle) * sourceRadius;
      const nextY = sourceY + Math.sin(angle) * sourceRadius;
      const nextHeight = this.getTerrainHeight(nextX, nextY) + this.groundLift;
      this.batch.pushSegment(
        prevX, prevHeight, prevY,
        nextX, nextHeight, nextY,
        r, g, b, alpha, this.widthPx,
      );
      prevX = nextX;
      prevY = nextY;
      prevHeight = nextHeight;
    }
  }
}
