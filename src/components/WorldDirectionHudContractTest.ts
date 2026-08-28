import { SUN_DIRECTION_SIM, SUN_LIGHT_TRAVEL_SIM } from '@/game/render3d/SunLighting';
import minimapSource from './Minimap.vue?raw';
import worldDirectionHudSource from './WorldDirectionHud.vue?raw';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[world direction HUD contract] ${message}`);
}

export function runWorldDirectionHudContractTest(): void {
  assertContract(
    SUN_LIGHT_TRAVEL_SIM.x === -SUN_DIRECTION_SIM.x &&
      SUN_LIGHT_TRAVEL_SIM.y === -SUN_DIRECTION_SIM.y &&
      SUN_LIGHT_TRAVEL_SIM.z === -SUN_DIRECTION_SIM.z,
    'sunlight travel must remain the exact inverse of the world-to-sun vector',
  );
  assertContract(
    /writeWorldVectorInView\(0, -1, 0, viewDirection\);\s*applyViewArrowDirection\(\s*compassView,\s*compassRig,\s*viewDirection\.x,\s*viewDirection\.y,\s*viewDirection\.z,\s*\)/.test(
      worldDirectionHudSource,
    ) &&
      !/applyViewArrowDirection\(compassView, compassRig, viewDirection\.x, viewDirection\.y, 0\)/.test(
        worldDirectionHudSource,
      ),
    'the top-bar north arrow must preserve its camera-relative toward/away component',
  );
  assertContract(
    worldDirectionHudSource.includes('projectedFraction') &&
      worldDirectionHudSource.includes('direction.z >= 0'),
    'the low-memory direction fallback must encode 3D depth instead of normalizing every arrow in 2D',
  );
  assertContract(
    minimapSource.includes('MINIMAP_COMPASS_STROKE') &&
      minimapSource.includes('MINIMAP_SUN_STROKE') &&
      minimapSource.includes('MINIMAP_WIND_STROKE') &&
      minimapSource.includes('SUN_LIGHT_TRAVEL_SIM.x / sunHorizontalLength') &&
      minimapSource.includes('SUN_LIGHT_TRAVEL_SIM.y / sunHorizontalLength'),
    'the minimap must draw north, sunlight-travel, and wind as 2D plan-view arrows',
  );
}
