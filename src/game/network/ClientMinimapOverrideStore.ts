import type { MinimapEntity } from '@/types/ui';
import type { EntityId } from '../sim/types';
import { getPlayerPrimaryColor } from '../sim/types';
import type { NetworkServerSnapshotMinimapEntity } from './NetworkTypes';

const minimapColorCache = new Map<number, string>();

type ClientMinimapOverrideStoreOptions = {
  isSelected: (id: EntityId) => boolean;
};

export class ClientMinimapOverrideStore {
  private overrideEntities: MinimapEntity[] | null = null;

  constructor(private readonly options: ClientMinimapOverrideStoreOptions) {}

  applySnapshot(
    source: readonly NetworkServerSnapshotMinimapEntity[] | undefined,
    isDelta: boolean,
  ): void {
    if (source) {
      this.applyOverride(source);
    } else if (!isDelta) {
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
      dst.color = minimapColor(getPlayerPrimaryColor(src.playerId));
      dst.isSelected = this.options.isSelected(src.id) || undefined;
    }
  }
}

function minimapColor(color: number): string {
  let cached = minimapColorCache.get(color);
  if (!cached) {
    cached = '#' + color.toString(16).padStart(6, '0');
    minimapColorCache.set(color, cached);
  }
  return cached;
}
