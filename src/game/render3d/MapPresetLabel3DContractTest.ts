import {
  MAP_PRESET_LABEL_ROTATION_X,
  MAP_PRESET_LABEL_ROTATION_Z,
  pickCaptionWrap,
  resolveMapPresetLabelCaptionBox,
  resolveMapPresetLabelPlacement,
  wrapCaptionFields,
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
  // THE WRAP. Leading can only be ADDED, so the block the painter sets has
  // to be at least as wide as the table wants; among those, the narrowest is
  // the one that needs the least leading and therefore keeps the tightest
  // block. Aspects here are "candidate block width / height" for one row
  // count each, widest first as row counts go up.
  assertContract(
    pickCaptionWrap([8, 4.4, 2.9, 2.0], 2.75) === 1,
    'the wrap must take the narrowest block still wider than the table',
  );
  assertContract(
    pickCaptionWrap([8, 4.4, 2.9, 2.0], 2.9) === 2,
    'a block exactly on the target aspect is a valid wrap',
  );
  assertContract(
    pickCaptionWrap([2.4, 1.8, 1.1], 2.75) === 0,
    'with every candidate too tall, the wrap must take the widest one',
  );

  // The fields are wrapped in order and balanced by measured width, so no row
  // is left empty and reading order survives the wrap.
  const fields = ['AAAA', 'B', 'CCCCCCCC', 'DD', 'EEE'];
  const measureByLength = (text: string): number => text.length;
  for (let rowCount = 1; rowCount <= fields.length; rowCount++) {
    const rows = wrapCaptionFields(measureByLength, fields, rowCount);
    assertContract(
      rows.length === rowCount && rows.every((row) => row.length > 0),
      `wrapping ${fields.length} fields into ${rowCount} rows must fill every row`,
    );
    assertContract(
      rows.join('').replace(/[^A-E]/g, '') === fields.join(''),
      'wrapping must keep every field, in order',
    );
  }
  assertContract(
    wrapCaptionFields(measureByLength, [], 3).length === 0,
    'a caption with no settings wraps to no rows',
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

    // THE EVEN MARGIN. A block set to the caption box's own aspect must fill
    // it exactly — that is the target the painter wraps and leads the caption
    // to hit, and the whole reason the gap comes out the same on all four
    // sides rather than three times wider at the flanks than at the rims.
    const box = resolveMapPresetLabelCaptionBox(mapAxis, mapAxis);
    const exact = resolveMapPresetLabelPlacement(mapAxis, mapAxis, box.width / box.depth);
    assertContract(
      Math.abs(exact.worldWidth - box.width) < 1e-6
        && Math.abs(exact.worldHeight - box.depth) < 1e-6,
      'a block of the caption box\'s aspect must fill it with no slack on either axis',
    );
    const boxOut =
      (box.centerX - box.annex.attachX) * box.annex.outX +
      (box.centerZ - box.annex.attachZ) * box.annex.outZ;
    assertContract(
      boxOut - box.depth / 2 >= box.annex.blendDepth - 1e-6
        && boxOut + box.depth / 2 <= box.annex.depth + 1e-6
        && box.width < box.annex.width,
      'the caption box must be the annex\'s flat table, inset on every side',
    );
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
      presentation.presetName === name
        && presentation.labelCaption.title === name.toUpperCase(),
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
  assertContract(custom.labelCaption.title === 'CUSTOM', 'an off-preset map must be named CUSTOM');
  assertContract(
    custom.labelCaption.info.some(
      (field) => field === `DETAIL ${customSnapshot.terrainDetail}`,
    ),
    'the CUSTOM sign must retain the changed current settings',
  );
  // The byline is its own section, and never a map setting: it is the same
  // under every preset and under CUSTOM alike, and takes no part in preset
  // identity.
  assertContract(
    custom.labelCaption.byline.length === 2
      && custom.labelCaption.byline.every((entry) => entry.length > 0)
      && custom.labelCaption.info.every(
        (field) => !custom.labelCaption.byline.includes(field),
      ),
    'the site and the address must be their own section, not settings rows',
  );
  assertContract(
    backdropUrlsForPresetName(custom.backdropPresetName)[0]
      .includes('/assets/backdrops/default-near.ktx2'),
    'CUSTOM must use the neutral default backdrop',
  );
}
