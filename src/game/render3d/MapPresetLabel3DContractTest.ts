import {
  mapPresetLabelCanvasHeight,
  resolveMapPresetLabelPlacement,
} from './MapPresetLabel3D';

function assertContract(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[map preset label contract] ${message}`);
}

export function runMapPresetLabel3DContractTest(): void {
  assertContract(mapPresetLabelCanvasHeight(0) === 0, 'an empty caption has no canvas');
  assertContract(
    mapPresetLabelCanvasHeight(3) > mapPresetLabelCanvasHeight(2)
      && mapPresetLabelCanvasHeight(2) > mapPresetLabelCanvasHeight(1),
    'each extra info line must add canvas height',
  );

  // Smallest and largest stock map axes, against a wide and a narrow caption.
  for (const mapAxis of [1400, 23800]) {
    for (const canvasAspect of [1.2, 9]) {
      const placement = resolveMapPresetLabelPlacement(mapAxis, canvasAspect);
      assertContract(
        placement.worldHeight > 0 && placement.worldWidth > 0,
        'the caption block must have positive world size',
      );
      assertContract(
        Math.abs(placement.worldWidth / placement.worldHeight - canvasAspect) < 1e-6,
        'world size must preserve the canvas aspect so glyphs stay unsquashed',
      );
      // The sign is map signage: it must sit entirely off the playable
      // rectangle, on the near (-Z) side of the map's (0, 0) corner.
      assertContract(
        placement.centerZ + placement.worldHeight / 2 < 0,
        'the whole caption must stay outside the playable area',
      );
      assertContract(
        Math.abs(placement.centerX - placement.worldWidth / 2) < 1e-6,
        'the caption must stay flush with the map corner x = 0 edge',
      );
      assertContract(
        Math.abs(
          placement.worldHeight / mapAxis
            - resolveMapPresetLabelPlacement(1, canvasAspect).worldHeight,
        ) < 1e-9,
        'caption size must scale with the map so its whole-map zoom size is constant',
      );
    }
  }
}
