import {
  MAP_PRESET_LABEL_ROTATION_X,
  MAP_PRESET_LABEL_ROTATION_Z,
  mapPresetLabelRowStackHeight,
  resolveMapPresetLabelPlacement,
} from './MapPresetLabel3D';
import { resolveMapInfoAnnexFootprint } from './MapInfoAnnex3D';
import {
  groupNestedContours,
  polygonSignedArea,
  traceAlphaMaskContours,
} from './AlphaMaskExtrusion3D';
import {
  BATTLE_PRESETS,
  resolveBattleMapPresentation,
  type BattlePresetSnapshot,
} from '@/components/battlePresets';
import { backdropUrlsForPresetName } from './presetBackdrops';
import * as THREE from 'three';

function assertContract(condition: unknown, message: string): asserts condition {
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
  // The annex's own yaw is what carries that frame onto whichever edge the
  // headland landed on. It is zero for the edge ally team 0 actually backs
  // onto, which is why the base frame above is the readable one today.
  assertContract(
    resolveMapInfoAnnexFootprint(10600, 10600).signYaw === 0,
    'the sign frame must need no extra yaw on the edge the annex uses',
  );
  // The row stack is baseline-to-baseline only: the padding around it is
  // measured against the painted INK at paint time, not counted here.
  assertContract(
    mapPresetLabelRowStackHeight(0) === 0 && mapPresetLabelRowStackHeight(1) === 0,
    'a caption of one line or none stacks no rows',
  );
  assertContract(
    mapPresetLabelRowStackHeight(3) > mapPresetLabelRowStackHeight(2)
      && mapPresetLabelRowStackHeight(2) > mapPresetLabelRowStackHeight(1),
    'each extra info line must add stack height',
  );

  // Smallest and largest stock map axes, against a wide and a narrow caption.
  for (const mapAxis of [1400, 23800]) {
    for (const canvasAspect of [1.2, 9]) {
      const placement = resolveMapPresetLabelPlacement(mapAxis, mapAxis, canvasAspect);
      const annex = placement.annex;
      assertContract(
        placement.worldHeight > 0 && placement.worldWidth > 0,
        'the caption block must have positive world size',
      );
      assertContract(
        Math.abs(placement.worldWidth / placement.worldHeight - canvasAspect) < 1e-6,
        'world size must preserve the canvas aspect so glyphs stay unsquashed',
      );
      // The sign is map signage: it stands entirely on the annex's FLAT
      // table, which is entirely off the playable rectangle. Letters all rise
      // from one plane, so ground still easing into the map edge under them
      // would leave them floating at one end.
      const centerOut =
        (placement.centerX - annex.attachX) * annex.outX +
        (placement.centerZ - annex.attachZ) * annex.outZ;
      assertContract(
        centerOut - placement.worldHeight / 2 >= annex.blendDepth - 1e-6,
        'the caption must stand past the blend band, on the annex\'s flat table',
      );
      assertContract(
        centerOut + placement.worldHeight / 2 <= annex.depth + 1e-6,
        'the caption must stay on the annex, not hang off its far edge',
      );
      const acrossHalf = Math.abs(
        (placement.centerX - annex.attachX) * annex.alongX +
        (placement.centerZ - annex.attachZ) * annex.alongZ,
      ) + placement.worldWidth / 2;
      assertContract(
        acrossHalf <= annex.width / 2 + 1e-6,
        'the caption must stay between the annex\'s flanks',
      );
      assertContract(
        Math.abs(
          placement.worldHeight / mapAxis
            - resolveMapPresetLabelPlacement(1, 1, canvasAspect).worldHeight,
        ) < 1e-9,
        'caption size must scale with the map so its whole-map zoom size is constant',
      );
    }
  }

  // Extruded letters come out of the painted glyph mask, so nested outlines
  // have to survive as holes — otherwise every O, P and 4 extrudes solid.
  const maskSize = 80;
  const ringAlpha = new Uint8Array(maskSize * maskSize);
  for (let y = 0; y < maskSize; y++) {
    for (let x = 0; x < maskSize; x++) {
      const radius = Math.hypot(x - (maskSize - 1) / 2, y - (maskSize - 1) / 2);
      ringAlpha[y * maskSize + x] = radius <= 30 && radius >= 14 ? 255 : 0;
    }
  }
  const ringContours = traceAlphaMaskContours(ringAlpha, maskSize, maskSize, {
    threshold: 0.5,
    simplifyTolerance: 0.4,
    minimumArea: 4,
  });
  assertContract(ringContours.length === 2, 'a ring must trace as an outline plus its counter');
  const ringGroups = groupNestedContours(ringContours);
  assertContract(
    ringGroups.length === 1 && ringGroups[0].holes.length === 1,
    'the counter must attach to its outline as a hole, not extrude as a second island',
  );
  assertContract(
    Math.abs(Math.abs(polygonSignedArea(ringGroups[0].outline)) - Math.PI * 30 * 30)
      < Math.PI * 30 * 30 * 0.01
      && Math.abs(Math.abs(polygonSignedArea(ringGroups[0].holes[0])) - Math.PI * 14 * 14)
      < Math.PI * 14 * 14 * 0.02,
    'traced outlines must follow the mask edge, not its pixel staircase',
  );
  // Antialiasing leaves specks; an empty mask must leave nothing behind.
  assertContract(
    traceAlphaMaskContours(new Uint8Array(maskSize * maskSize), maskSize, maskSize, {
      threshold: 0.5,
      simplifyTolerance: 0.4,
      minimumArea: 4,
    }).length === 0,
    'a blank mask must trace no outlines',
  );

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
