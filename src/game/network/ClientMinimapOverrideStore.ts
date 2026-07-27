import type { MinimapEntity } from '@/types/ui';
import { COLORS } from '@/colorsConfig';
import type { EntityId } from '../sim/types';
import { getPlayerPrimaryColor } from '../sim/types';
import type { NetworkServerSnapshotMinimapEntity } from './NetworkTypes';
import { getMinimapCssColor } from '../minimapColor';

type ClientMinimapOverrideStoreOptions = {
  isSelected: (id: EntityId) => boolean;
};

export class ClientMinimapOverrideStore {
  private overrideEntities: MinimapEntity[] | null = null;

  constructor(private readonly options: ClientMinimapOverrideStoreOptions) {}

  applySnapshot(source: readonly NetworkServerSnapshotMinimapEntity[] | undefined): void {
    if (source) {
      this.applyOverride(source);
    } else {
      this.overrideEntities = null;
    }
  }

  getOverride(): readonly MinimapEntity[] | null {
    return this.overrideEntities;
  }

  reset(): void {
    this.overrideEntities = null;
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
      dst.radarOnly = radarOnly || undefined;
      dst.color = radarOnly
        ? RADAR_BLIP_COLOR
        : getMinimapCssColor(getPlayerPrimaryColor(src.playerId));
      dst.isSelected = radarOnly ? undefined : this.options.isSelected(src.id) || undefined;
    }
  }
}

const RADAR_BLIP_COLOR = COLORS.ui.minimap.radarBlip.cssColor;
