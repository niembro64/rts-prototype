import type { MinimapEntity } from '@/types/ui';
import { COLORS } from '@/colorsConfig';
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

export class ClientMinimapOverrideStore {
  private overrideEntities: MinimapEntity[] | null = null;
  private sequence = 0;

  constructor(private readonly options: ClientMinimapOverrideStoreOptions) {}

  applySnapshot(
    source: readonly NetworkServerSnapshotMinimapEntity[] | undefined,
  ): void {
    this.sequence++;
    if (source) {
      this.applyOverride(source);
    } else {
      this.overrideEntities = null;
    }
  }

  getOverride(): readonly MinimapEntity[] | null {
    return this.overrideEntities;
  }

  /** Membership still changes only when a filtered presentation snapshot
   *  lands. Position does not: world/minimap blips read the entity's shared
   *  fixed-tick presentation pose every render frame. */
  getSequence(): number {
    return this.sequence;
  }

  reset(): void {
    this.overrideEntities = null;
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
