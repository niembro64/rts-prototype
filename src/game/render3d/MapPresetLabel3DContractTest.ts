import {
  MAP_PRESET_LABEL_ROTATION_X,
  MAP_PRESET_LABEL_ROTATION_Z,
  pickCaptionSetting,
  resolveMapPresetLabelCaptionBox,
  resolveMapPresetLabelPlacement,
  wrapCaptionFields,
} from './MapPresetLabel3D';
import {
  mapInfoAnnexHalfWidthAt,
  resolveMapInfoAnnexFootprint,
} from './MapInfoAnnex3D';
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
  // THE SETTING. The wrap is the coarse knob and the leading the fine one,
  // and the leading moves BOTH ways — a page set a little tight to make it
  // fit is ordinary; a band of empty rock down two sides because the leading
  // refused to close is not. Among the wraps the leading can reach, the one
  // needing least of it wins, so the authored rhythm survives where it can.
  //
  // Candidates below are 100 wide with 40 of leading, so the height alone
  // sets each one's aspect: 50 → 2.0, 40 → 2.5, 25 → 4.0.
  const candidate = (height: number): {
    width: number;
    height: number;
    leading: number;
  } => ({ width: 100, height, leading: 40 });
  const exact = pickCaptionSetting([candidate(50), candidate(40)], 2.0, 0.5, 1.6);
  assertContract(
    exact.index === 0 && Math.abs(exact.leadingFactor - 1) < 1e-9,
    'a wrap already on the target aspect must be set at its authored leading',
  );
  const tightened = pickCaptionSetting([candidate(50), candidate(20)], 2.5, 0.5, 1.6);
  assertContract(
    tightened.index === 0 && Math.abs(tightened.leadingFactor - 0.75) < 1e-9,
    'a block a little too tall must be set tighter rather than left uneven',
  );
  // 25 would need the leading opened to 1.625× and 65 closed to 0.375×; both
  // are past the bounds, so the reachable wrap takes it either way.
  const pastCeiling = pickCaptionSetting([candidate(25), candidate(45)], 2.0, 0.5, 1.6);
  const pastFloor = pickCaptionSetting([candidate(65), candidate(44)], 2.5, 0.5, 1.6);
  assertContract(
    pastCeiling.index === 1 && Math.abs(pastCeiling.leadingFactor - 1.125) < 1e-9
      && pastFloor.index === 1 && Math.abs(pastFloor.leadingFactor - 0.9) < 1e-9,
    'a wrap the leading can only reach by stretching past its bounds is not a candidate',
  );
  const leastMeddling = pickCaptionSetting(
    [candidate(50), candidate(44)],
    2.5,
    0.5,
    1.6,
  );
  assertContract(
    leastMeddling.index === 1 && Math.abs(leastMeddling.leadingFactor - 0.9) < 1e-9,
    'the winner must be the wrap that needs the least leading moved',
  );
  const unreachable = pickCaptionSetting([candidate(500), candidate(400)], 2.0, 0.5, 1.6);
  assertContract(
    unreachable.index === 1 && unreachable.leadingFactor === 1,
    'with no wrap the leading can reach, the closest shape is set as authored',
  );

  // The wrap is BALANCED, not greedy-to-an-average: packing to the average
  // overshoots on every row, so the early rows come out short and the last
  // one is left holding whatever nobody else took — which is exactly what a
  // caption thrown together looks like.
  const fields = ['AAAA', 'B', 'CCCCCCCC', 'DD', 'EEE'];
  const measureByLength = (text: string): number => text.length;
  let previousRows = 0;
  for (let rowCount = 1; rowCount <= fields.length; rowCount++) {
    const rows = wrapCaptionFields(measureByLength, fields, rowCount);
    assertContract(
      rows.length >= 1 && rows.length <= rowCount && rows.every((row) => row.length > 0),
      `wrapping into at most ${rowCount} rows must leave no row empty`,
    );
    assertContract(
      rows.length >= previousRows,
      'asking for more rows must never come back with fewer',
    );
    previousRows = rows.length;
    assertContract(
      rows.join('').replace(/[^A-E]/g, '') === fields.join(''),
      'wrapping must keep every field, in order',
    );
  }
  // And it is the NARROWEST such split, not merely a tidy-looking one: the
  // widest row it sets must match the best any in-order split into that many
  // rows can do, brute-forced here. The separator comes from the wrap's own
  // output so the two agree on what a row measures.
  const separator = wrapCaptionFields(measureByLength, ['A', 'B'], 1)[0].slice(1, -1);
  const narrowestPossibleRow = (rowCount: number): number => {
    let best = Infinity;
    const walk = (start: number, rowsLeft: number, worst: number): void => {
      if (rowsLeft === 1) {
        best = Math.min(best, Math.max(worst, fields.slice(start).join(separator).length));
        return;
      }
      for (let end = start + 1; end <= fields.length - (rowsLeft - 1); end++) {
        walk(
          end,
          rowsLeft - 1,
          Math.max(worst, fields.slice(start, end).join(separator).length),
        );
      }
    };
    walk(0, rowCount, 0);
    return best;
  };
  for (const rowCount of [2, 3, 4]) {
    const rows = wrapCaptionFields(measureByLength, fields, rowCount);
    assertContract(
      rows.reduce((most, row) => Math.max(most, row.length), 0)
        <= narrowestPossibleRow(rowCount),
      `a ${rowCount}-row wrap must be the narrowest split into that many rows`,
    );
  }
  assertContract(
    wrapCaptionFields(measureByLength, [], 3).length === 0,
    'a caption with no settings wraps to no rows',
  );

  // Smallest and largest stock map axes, a wide and a narrow caption, and
  // both a flat coast (the sign gets the whole headland) and a coast that
  // ramps the full blend band.
  for (const mapAxis of [1400, 23800]) {
    for (const canvasAspect of [1.2, 9]) {
      const annexForAxis = resolveMapInfoAnnexFootprint(mapAxis, mapAxis);
      for (const settledDepth of [0, annexForAxis.blendDepth]) {
        const placement = resolveMapPresetLabelPlacement(
          mapAxis,
          mapAxis,
          canvasAspect,
          settledDepth,
        );
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
          centerOut - placement.worldHeight / 2 >= settledDepth - 1e-6,
          'the caption must stand past the annex\'s ramp off the coast',
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
              - resolveMapPresetLabelPlacement(
                1,
                1,
                canvasAspect,
                settledDepth / mapAxis,
              ).worldHeight,
          ) < 1e-9,
          'caption size must scale with the map so its whole-map zoom size is constant',
        );
      }
    }

    // THE EVEN MARGIN. A block set to the caption box's own aspect must fill
    // it exactly — that is the target the painter wraps and leads the caption
    // to hit, and the whole reason the gap comes out the same on all four
    // sides rather than three times wider at the flanks than at the rims.
    const box = resolveMapPresetLabelCaptionBox(mapAxis, mapAxis, 0);
    const exact = resolveMapPresetLabelPlacement(
      mapAxis,
      mapAxis,
      box.width / box.depth,
      0,
    );
    assertContract(
      Math.abs(exact.worldWidth - box.width) < 1e-6
        && Math.abs(exact.worldHeight - box.depth) < 1e-6,
      'a block of the caption box\'s aspect must fill it with no slack on either axis',
    );
    const boxOut =
      (box.centerX - box.annex.attachX) * box.annex.outX +
      (box.centerZ - box.annex.attachZ) * box.annex.outZ;
    // A flat coast asks the caption to stand back from nothing, so the box is
    // centred on the whole headland — and every corner of it, the far pair
    // included, has to be standing on land.
    assertContract(
      boxOut - box.depth / 2 > 0
        && boxOut + box.depth / 2 <= box.annex.depth + 1e-6
        && Math.abs(boxOut - box.annex.depth / 2) < 1e-6,
      'a flat coast must centre the caption on the whole headland',
    );
    for (const corner of [-1, 1]) {
      const cornerOut = boxOut + corner * box.depth / 2;
      assertContract(
        box.width / 2 <= mapInfoAnnexHalfWidthAt(box.annex, cornerOut) + 1e-6,
        'no corner of the caption box may hang over the headland\'s taper',
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
