import {
  MAP_PRESET_LABEL_ROTATION_X,
  MAP_PRESET_LABEL_ROTATION_Z,
  mapPresetLabelCanvasHeight,
  resolveMapPresetLabelPlacement,
} from './MapPresetLabel3D';
import {
  BATTLE_PRESETS,
  resolveBattleMapPresentation,
  type BattlePresetSnapshot,
} from '@/components/battlePresets';
import { backdropUrlsForPresetName } from './presetBackdrops';
import * as THREE from 'three';

function assertContract(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[map preset label contract] ${message}`);
}

export function runMapPresetLabel3DContractTest(): void {
  assertContract(
    MAP_PRESET_LABEL_ROTATION_X === -Math.PI / 2
      && MAP_PRESET_LABEL_ROTATION_Z === Math.PI,
    'the ground sign must face upward and undo the default-camera mirror/inversion',
  );
  const orientation = new THREE.Quaternion().setFromEuler(new THREE.Euler(
    MAP_PRESET_LABEL_ROTATION_X,
    0,
    MAP_PRESET_LABEL_ROTATION_Z,
  ));
  const canvasRight = new THREE.Vector3(1, 0, 0).applyQuaternion(orientation);
  const canvasTop = new THREE.Vector3(0, 1, 0).applyQuaternion(orientation);
  const paintedFront = new THREE.Vector3(0, 0, 1).applyQuaternion(orientation);
  assertContract(
    canvasRight.x < -0.999 && canvasTop.z > 0.999 && paintedFront.y > 0.999,
    'canvas right/top/front must map to screen-right/mapward/upward world axes',
  );
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

  // The entity count cap is display-only on the caption and takes no part in
  // preset identity, so every preset must resolve at ANY cap.
  for (const preset of BATTLE_PRESETS) {
    const { name, backdropSlug, ...snapshot } = preset;
    const presentation = resolveBattleMapPresentation({ ...snapshot, cap: 10 });
    assertContract(
      resolveBattleMapPresentation({ ...snapshot, cap: 10000 }).presetName === name,
      `${name} must stay on-preset regardless of the entity count cap`,
    );
    assertContract(
      presentation.presetName === name && presentation.labelLines[0] === name.toUpperCase(),
      `${name} must resolve as an exact stock preset`,
    );
    assertContract(
      backdropUrlsForPresetName(presentation.backdropPresetName)[0]
        .includes(`/assets/backdrops/${backdropSlug}-near.ktx2`),
      `${name} must own its special backdrop slug`,
    );
  }

  const source = BATTLE_PRESETS[1];
  const {
    name: _name,
    backdropSlug: _backdropSlug,
    ...stockSnapshot
  } = source;
  const customSnapshot: BattlePresetSnapshot = {
    ...stockSnapshot,
    cap: 500,
    terrainDetail: stockSnapshot.terrainDetail + 1,
  };
  const custom = resolveBattleMapPresentation(customSnapshot);
  assertContract(custom.presetName === null, 'a changed map setting must leave the preset');
  assertContract(custom.labelLines[0] === 'CUSTOM', 'an off-preset map must be named CUSTOM');
  assertContract(
    custom.labelLines.some((line) => line.includes(`DETAIL ${customSnapshot.terrainDetail}`)),
    'the CUSTOM sign must retain the changed current settings',
  );
  assertContract(
    backdropUrlsForPresetName(custom.backdropPresetName)[0]
      .includes('/assets/backdrops/default-near.ktx2'),
    'CUSTOM must use the neutral default backdrop',
  );
}
