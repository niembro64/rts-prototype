// VisionDistanceField3D — the DISTANCE vision-fade mode's spatial query.
//
// The local team's sensor discs (the same mounted sources, media, allied
// ownership, operational gates and scan pulses the fog shade and sight
// boundary consume) are bucketed once per fixed tick. Each frame a renderer
// asks how far inside the nearest friendly disc a point sits, and gets an
// alpha that is 1 from the disc centre out to `band` world units short of
// the edge and falls linearly to 0 at the edge itself.
//
// Presentation only. The band lies INSIDE the authoritative radius, never
// beyond it: an entity is only ever drawn where the server already sent it,
// and a client never learns a position it has not earned. Terrain line of
// sight is not modelled here — it is a binary truth the time fade covers.

import { getSensorMediumAtZ, forEachEntityTurretSensorSource, type SensorMedium } from '../sim/sensorCoverage';
import type { Entity, PlayerId } from '../sim/types';
import type { ClientViewState } from '../network/ClientViewState';
import { CONTACT_MEDIUM_AIR, CONTACT_MEDIUM_WATER } from '../network/contactMedium';

/** Bucket size for the disc index. A disc is inserted into every cell it
 *  overlaps, so a query is one cell lookup plus a few distance checks. */
const FIELD_CELL_SIZE = 512;

/** One lane of discs: full sight or contact, for one target medium. */
class DiscLane3D {
  readonly xs: number[] = [];
  readonly ys: number[] = [];
  readonly radii: number[] = [];
  private readonly cells = new Map<number, number[]>();
  private cellW = 1;

  clear(): void {
    this.xs.length = 0;
    this.ys.length = 0;
    this.radii.length = 0;
    this.cells.clear();
  }

  setMapWidth(mapWidth: number): void {
    this.cellW = Math.max(1, Math.ceil(mapWidth / FIELD_CELL_SIZE) + 2);
  }

  private key(cx: number, cy: number): number {
    return (cy + 1) * this.cellW + (cx + 1);
  }

  push(x: number, y: number, radius: number): void {
    if (!(radius > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const index = this.xs.length;
    this.xs.push(x);
    this.ys.push(y);
    this.radii.push(radius);
    const minCx = Math.floor((x - radius) / FIELD_CELL_SIZE);
    const maxCx = Math.floor((x + radius) / FIELD_CELL_SIZE);
    const minCy = Math.floor((y - radius) / FIELD_CELL_SIZE);
    const maxCy = Math.floor((y + radius) / FIELD_CELL_SIZE);
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const key = this.key(cx, cy);
        let bucket = this.cells.get(key);
        if (bucket === undefined) {
          bucket = [];
          this.cells.set(key, bucket);
        }
        bucket.push(index);
      }
    }
  }

  /** 0 outside every disc; inside, the deepest disc wins: 1 when at least
   *  `band` inside the edge, falling linearly to 0 at the edge. A disc
   *  narrower than the band ramps over its whole radius instead. */
  alphaAt(x: number, y: number, band: number): number {
    const bucket = this.cells.get(this.key(
      Math.floor(x / FIELD_CELL_SIZE),
      Math.floor(y / FIELD_CELL_SIZE),
    ));
    if (bucket === undefined) return 0;
    let best = 0;
    for (let i = 0; i < bucket.length; i++) {
      const index = bucket[i];
      const r = this.radii[index];
      const dx = x - this.xs[index];
      const dy = y - this.ys[index];
      const distSq = dx * dx + dy * dy;
      if (distSq > r * r) continue;
      const ramp = Math.min(band, r);
      if (ramp <= 0) return 1;
      const inside = r - Math.sqrt(distSq);
      const alpha = inside >= ramp ? 1 : inside / ramp;
      if (alpha >= 1) return 1;
      if (alpha > best) best = alpha;
    }
    return best;
  }
}

export class VisionDistanceField3D {
  private readonly sightAbove = new DiscLane3D();
  private readonly sightUnder = new DiscLane3D();
  private readonly contactAbove = new DiscLane3D();
  private readonly contactUnder = new DiscLane3D();
  private visionPlayerMask = 0;
  private lastTick = -1;
  private lastEntitySetVersion = -1;
  private lastLocalPlayerId: PlayerId | undefined = undefined;
  private active = false;

  /** True while a rebuild has run for the current inputs and the field is
   *  meant to gate alpha; false clears every query to "fully visible". */
  get isActive(): boolean {
    return this.active;
  }

  /** Disable the field (mode is TIME, fog is off, or the viewer watches
   *  ALL): every query answers 1 until the next `sync`. */
  clear(): void {
    if (!this.active && this.lastTick === -1) return;
    this.active = false;
    this.lastTick = -1;
    this.lastEntitySetVersion = -1;
    this.sightAbove.clear();
    this.sightUnder.clear();
    this.contactAbove.clear();
    this.contactUnder.clear();
  }

  /** Rebuild the disc index when sensor truth may have moved (a new fixed
   *  tick or an entity-set change), from the vision players of the local
   *  seat. Cheap to call every frame. */
  sync(clientViewState: ClientViewState, localPlayerId: PlayerId, mapWidth: number): void {
    const tick = clientViewState.getTick();
    const entitySetVersion = clientViewState.getEntitySetVersion();
    if (
      this.active &&
      tick === this.lastTick &&
      entitySetVersion === this.lastEntitySetVersion &&
      localPlayerId === this.lastLocalPlayerId
    ) {
      return;
    }
    this.lastTick = tick;
    this.lastEntitySetVersion = entitySetVersion;
    this.lastLocalPlayerId = localPlayerId;
    this.active = true;
    this.sightAbove.clear();
    this.sightUnder.clear();
    this.contactAbove.clear();
    this.contactUnder.clear();
    this.sightAbove.setMapWidth(mapWidth);
    this.sightUnder.setMapWidth(mapWidth);
    this.contactAbove.setMapWidth(mapWidth);
    this.contactUnder.setMapWidth(mapWidth);
    let mask = 0;
    const playerIds = clientViewState.getVisionPlayerIds(localPlayerId);
    for (let i = 0; i < playerIds.length; i++) {
      const playerId = playerIds[i];
      mask |= 1 << (playerId - 1);
      this.collectOwned(clientViewState.getUnitsByPlayer(playerId));
      this.collectOwned(clientViewState.getBuildingsByPlayer(playerId));
    }
    this.visionPlayerMask = mask;
    const pulses = clientViewState.getScanPulses();
    for (let i = 0; i < pulses.length; i++) {
      const pulse = pulses[i];
      this.sightAbove.push(pulse.x, pulse.y, pulse.radius);
      this.sightUnder.push(pulse.x, pulse.y, pulse.radius);
    }
  }

  private collectOwned(entities: readonly Entity[]): void {
    for (let i = 0; i < entities.length; i++) {
      forEachEntityTurretSensorSource(entities[i], ({ position, hostMedium, sensors, operational }) => {
        if (operational.vision) {
          (hostMedium === 'aboveWater' ? this.sightAbove : this.sightUnder)
            .push(position.x, position.y, sensors.visionRadius);
        }
        if (operational.radar) {
          (hostMedium === 'aboveWater' ? this.contactAbove : this.contactUnder)
            .push(position.x, position.y, sensors.radarRadius);
        }
      });
    }
  }

  /** Whether an owner belongs to the vision team: own and allied entities
   *  are never faded by distance. */
  isVisionOwner(ownerId: PlayerId | undefined): boolean {
    return ownerId === undefined || (this.visionPlayerMask & (1 << (ownerId - 1))) !== 0;
  }

  /** Alpha of an enemy body at (x, y) whose observation z picks the
   *  full-sight target medium. 1 while the field is inactive. */
  sightAlphaAt(x: number, y: number, z: number, band: number): number {
    if (!this.active) return 1;
    return this.sightAlphaInMedium(x, y, getSensorMediumAtZ(z), band);
  }

  sightAlphaInMedium(x: number, y: number, medium: SensorMedium, band: number): number {
    if (!this.active) return 1;
    return (medium === 'underwater' ? this.sightUnder : this.sightAbove).alphaAt(x, y, band);
  }

  /** Alpha of an anonymous contact at (x, y) earned through the lanes in
   *  `contactMediumMask` (radar → above-water lane, sonar → underwater
   *  lane; a straddler takes the better of the two). 1 while inactive. */
  contactAlphaAt(x: number, y: number, contactMediumMask: number, band: number): number {
    if (!this.active) return 1;
    let best = 0;
    if ((contactMediumMask & CONTACT_MEDIUM_AIR) !== 0) {
      best = Math.max(best, this.contactAbove.alphaAt(x, y, band));
    }
    if ((contactMediumMask & CONTACT_MEDIUM_WATER) !== 0) {
      best = Math.max(best, this.contactUnder.alphaAt(x, y, band));
    }
    if (contactMediumMask === 0) {
      best = Math.max(this.contactAbove.alphaAt(x, y, band), this.contactUnder.alphaAt(x, y, band));
    }
    return best;
  }
}
