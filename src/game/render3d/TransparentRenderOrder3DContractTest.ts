import * as THREE from 'three';
import { OVERLAY_LINE_CONFIG } from '@/config';
import { createScreenSpaceLineMaterial } from './ScreenSpaceLineMaterial';
import { TRANSPARENT_RENDER_ORDER_3D } from './TransparentRenderOrder3D';
import {
  CONTACT_BLIP_DEPTH_TEST,
  CONTACT_BLIP_DEPTH_WRITE,
  CONTACT_BLIP_RENDER_ORDER,
  ENTITY_LOD_PROXY_FINAL_DEPTH_WRITE,
  ENTITY_LOD_PROXY_TRANSITION_DEPTH_WRITE,
  ENTITY_LOD_PROXY_TRANSITION_RENDER_ORDER,
  LodProxyPointBatchRenderer3D,
  createEntityLodProxyMaterial3D,
} from './EntityLodProxyRenderer3D';

function assertContract(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[transparent render order contract] ${message}`);
}

export function runTransparentRenderOrder3DContractTest(): void {
  const overlayMaterial = createScreenSpaceLineMaterial();
  assertContract(
    overlayMaterial.depthTest && !overlayMaterial.depthWrite,
    'selection overlays must respect solid depth without writing a HUD-shaped depth mask',
  );
  overlayMaterial.dispose();
  const proxyMaterial = createEntityLodProxyMaterial3D(false);
  assertContract(
    proxyMaterial.toneMapped === false &&
      proxyMaterial.uniforms.uBrightness === undefined &&
      proxyMaterial.userData.renderLighting === 'self-lit',
    'MIN entity glyphs must preserve their raw white/team/player/black colors independent of scene lighting and exposure',
  );
  proxyMaterial.dispose();
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
  // Radar/sonar blips follow the MIN glyph's world-occlusion rule: hidden
  // by terrain and vegetation in front of them, never burned through.
  assertContract(
    CONTACT_BLIP_DEPTH_TEST,
    'contact blips must depth-test so ridges and forests occlude them like MIN glyphs',
  );
  assertContract(
    !CONTACT_BLIP_DEPTH_WRITE,
    'contact blips are cross-fading overlays and must not write proxy depth over entity parts',
  );
  assertContract(
    TRANSPARENT_RENDER_ORDER_3D.entityParts < CONTACT_BLIP_RENDER_ORDER &&
      CONTACT_BLIP_RENDER_ORDER <= ENTITY_LOD_PROXY_TRANSITION_RENDER_ORDER &&
      CONTACT_BLIP_RENDER_ORDER < TRANSPARENT_RENDER_ORDER_3D.waterSurface,
    'contact blips blend in the glyph band, after entity parts and below the water surface',
  );
  const blipHost = new THREE.Group();
  const blipBatch = new LodProxyPointBatchRenderer3D(blipHost);
  try {
    const policy = blipBatch.depthPolicy;
    assertContract(
      policy.depthTest === CONTACT_BLIP_DEPTH_TEST &&
        policy.depthWrite === CONTACT_BLIP_DEPTH_WRITE &&
        policy.renderOrder === CONTACT_BLIP_RENDER_ORDER,
      'the live contact-blip batch must install the authored depth policy',
    );
  } finally {
    blipBatch.destroy();
  }
  assertContract(
    TRANSPARENT_RENDER_ORDER_3D.entityParts < TRANSPARENT_RENDER_ORDER_3D.waterSurface,
    'faded entity parts must draw before the depth-writing water surface',
  );
  assertContract(
    TRANSPARENT_RENDER_ORDER_3D.waterSurface < TRANSPARENT_RENDER_ORDER_3D.aboveWaterEffects,
    'above-water effects must draw after the water surface',
  );
  assertContract(
    OVERLAY_LINE_CONFIG.kinds.selection.renderOrder ===
      TRANSPARENT_RENDER_ORDER_3D.throughWaterEffects &&
      OVERLAY_LINE_CONFIG.kinds.selection.renderOrder <
        TRANSPARENT_RENDER_ORDER_3D.waterSurface,
    'submerged selection rings must draw before water blends and writes depth',
  );
}
