import { TRANSPARENT_RENDER_ORDER_3D } from './TransparentRenderOrder3D';
import {
  ENTITY_LOD_PROXY_FINAL_DEPTH_WRITE,
  ENTITY_LOD_PROXY_TRANSITION_DEPTH_WRITE,
  ENTITY_LOD_PROXY_TRANSITION_RENDER_ORDER,
} from './EntityLodProxyRenderer3D';

function assertContract(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[transparent render order contract] ${message}`);
}

export function runTransparentRenderOrder3DContractTest(): void {
  assertContract(
    ENTITY_LOD_PROXY_FINAL_DEPTH_WRITE,
    'fully opaque replacement glyphs must write their physical proxy depth',
  );
  assertContract(
    !ENTITY_LOD_PROXY_TRANSITION_DEPTH_WRITE,
    'cross-fade glyph overlays must not hide entity parts with proxy depth',
  );
  assertContract(
    TRANSPARENT_RENDER_ORDER_3D.entityParts < ENTITY_LOD_PROXY_TRANSITION_RENDER_ORDER,
    'cross-fade glyph overlays must blend after transparent entity parts',
  );
  assertContract(
    ENTITY_LOD_PROXY_TRANSITION_RENDER_ORDER < TRANSPARENT_RENDER_ORDER_3D.waterSurface,
    'cross-fade glyph overlays must remain below the water surface pass',
  );
  assertContract(
    TRANSPARENT_RENDER_ORDER_3D.entityParts < TRANSPARENT_RENDER_ORDER_3D.waterSurface,
    'faded entity parts must draw before the depth-writing water surface',
  );
  assertContract(
    TRANSPARENT_RENDER_ORDER_3D.waterSurface < TRANSPARENT_RENDER_ORDER_3D.aboveWaterEffects,
    'above-water effects must draw after the water surface',
  );
}
