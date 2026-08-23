import type { MinimapEntity } from '@/types/ui';
import { COLORS } from '@/colorsConfig';
import { PRESENTATION_SNAPSHOT_RATE_DEFAULT } from '@/presentationSnapshotConfig';
import type { EntityId } from '../sim/types';
import { getPlayerPrimaryColor } from '../sim/types';
import type { NetworkServerSnapshotMinimapEntity } from './NetworkTypes';
import { getMinimapCssColor } from '../minimapColor';
import {
  CONTACT_MEDIUM_AIR,
  CONTACT_MEDIUM_WATER,
  normalizeContactMediumMask,
} from './contactMedium';

type ClientMinimapOverrideStoreOptions = {
  isSelected: (id: EntityId) => boolean;
};

/** Contact rows ride the presentation snapshot, which is much slower than the
 *  render loop, and a radar contact has no blueprint, velocity, or orders for
 *  the prediction stepper to work from. The world blip renderer therefore
 *  bridges the gap itself: `sequence` tells it a new sample landed, and `alpha`
 *  is how far the render clock has walked from the previous sample toward it. */
export type ContactSnapshotSampling = Readonly<{
  sequence: number;
  alpha: number;
  /** Measured gap between the last two contact snapshots. Blip velocity is
   *  derived from it: (to - from) / intervalMs, the drift a fading contact
   *  keeps, exactly like a unit leaving vision. */
  intervalMs: number;
}>;

const NOMINAL_SNAPSHOT_INTERVAL_MS = 1000 / PRESENTATION_SNAPSHOT_RATE_DEFAULT;
/** A hitch or a paused debugger must not stretch the glide, and a burst of
 *  back-to-back snapshots must not collapse it. */
const MIN_SNAPSHOT_INTERVAL_MS = 30;
const MAX_SNAPSHOT_INTERVAL_MS = 1000;

export class ClientMinimapOverrideStore {
  private overrideEntities: MinimapEntity[] | null = null;
  private sequence = 0;
  private updatedAtMs = 0;
  private intervalMs = NOMINAL_SNAPSHOT_INTERVAL_MS;
  private readonly sampling = {
    sequence: 0,
    alpha: 1,
    intervalMs: NOMINAL_SNAPSHOT_INTERVAL_MS,
  };

  constructor(private readonly options: ClientMinimapOverrideStoreOptions) {}

  applySnapshot(
    source: readonly NetworkServerSnapshotMinimapEntity[] | undefined,
    nowMs: number = performance.now(),
  ): void {
    this.noteSampleArrival(nowMs);
    if (source) {
      this.applyOverride(source);
    } else {
      this.overrideEntities = null;
    }
  }

  getOverride(): readonly MinimapEntity[] | null {
    return this.overrideEntities;
  }

  /** Clamped rather than extrapolated, matching the render clock the fixed-tick
   *  presentation history uses: a contact whose snapshots stop arriving comes to
   *  rest where it was last heard instead of drifting on past it. */
  getSampling(nowMs: number): ContactSnapshotSampling {
    const sampling = this.sampling;
    sampling.sequence = this.sequence;
    sampling.alpha = this.updatedAtMs === 0
      ? 1
      : Math.min(1, Math.max(0, (nowMs - this.updatedAtMs) / this.intervalMs));
    sampling.intervalMs = this.intervalMs;
    return sampling;
  }

  reset(): void {
    this.overrideEntities = null;
    this.sequence++;
    this.updatedAtMs = 0;
    this.intervalMs = NOMINAL_SNAPSHOT_INTERVAL_MS;
  }

  /** The glide length is measured rather than read off the advertised snapshot
   *  rate, because the gap that has to be covered is the one this client
   *  actually observed, host hitches and network jitter included. */
  private noteSampleArrival(nowMs: number): void {
    if (this.updatedAtMs !== 0) {
      const measured = nowMs - this.updatedAtMs;
      if (measured >= MIN_SNAPSHOT_INTERVAL_MS && measured <= MAX_SNAPSHOT_INTERVAL_MS) {
        this.intervalMs = this.intervalMs * 0.8 + measured * 0.2;
      }
    }
    this.updatedAtMs = nowMs;
    this.sequence++;
  }

  private applyOverride(source: readonly NetworkServerSnapshotMinimapEntity[]): void {
    const out = this.overrideEntities ?? (this.overrideEntities = []);
    out.length = source.length;
    for (let i = 0; i < source.length; i++) {
      const src = source[i];
      let dst = out[i];
      if (!dst) {
        dst = { pos: { x: 0, y: 0 }, type: 'unit', color: '' };
        out[i] = dst;
      }
      dst.pos.x = src.pos.x;
      dst.pos.y = src.pos.y;
      dst.type = src.type;
      // Radar-only contacts (FOW-03a) render as generic blips — strip
      // the team color and clear selection / hover so the player gets
      // positional intel without leaking identity.
      const radarOnly = src.radarOnly === true;
      if (
        radarOnly &&
        (typeof src.contactZ !== 'number' || !Number.isFinite(src.contactZ))
      ) {
        throw new Error(`[minimap contact] entity ${src.id} is missing finite contactZ`);
      }
      const contactMediumMask = radarOnly
        ? normalizeContactMediumMask(src.contactMediumMask)
        : 0;
      dst.radarOnly = radarOnly || undefined;
      dst.color = radarOnly
        ? contactColor(contactMediumMask)
        : getMinimapCssColor(getPlayerPrimaryColor(src.playerId));
      dst.isSelected = radarOnly ? undefined : this.options.isSelected(src.id) || undefined;
      dst.contactId = radarOnly ? src.id : undefined;
      dst.contactMediumMask = radarOnly
        ? contactMediumMask
        : undefined;
      dst.contactZ = radarOnly ? src.contactZ! : undefined;
    }
  }
}

function contactColor(mediumMask: number): string {
  const hasAir = (mediumMask & CONTACT_MEDIUM_AIR) !== 0;
  const hasWater = (mediumMask & CONTACT_MEDIUM_WATER) !== 0;
  if (hasAir && hasWater) return COLORS.ui.minimap.dualContactBlip.cssColor;
  if (hasWater) return COLORS.ui.minimap.sonarBlip.cssColor;
  return COLORS.ui.minimap.radarBlip.cssColor;
}
