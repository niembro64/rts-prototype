import { TRANSPARENT_RENDER_ORDER_3D } from './TransparentRenderOrder3D';

function assertContract(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[transparent render order contract] ${message}`);
}

export function runTransparentRenderOrder3DContractTest(): void {
  assertContract(
    TRANSPARENT_RENDER_ORDER_3D.entityParts < TRANSPARENT_RENDER_ORDER_3D.waterSurface,
    'faded entity parts must draw before the depth-writing water surface',
  );
  assertContract(
    TRANSPARENT_RENDER_ORDER_3D.waterSurface < TRANSPARENT_RENDER_ORDER_3D.aboveWaterEffects,
    'above-water effects must draw after the water surface',
  );
}

