import {
  buildPlinthGeometry,
  MAP_PRESET_LABEL_ROTATION_X,
  MAP_PRESET_LABEL_ROTATION_Z,
  mapPresetLabelCanvasHeight,
  resolveMapPresetLabelPlacement,
} from './MapPresetLabel3D';
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
import { TERRAIN_GROUND_TEXTURE_TILE_WORLD_SIZE } from '@/config';
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
      // rectangle, on the near (-Z) side of the map's (0, 0) corner — the
      // slab it stands on included, since that is what grew last.
      assertContract(
        placement.centerZ + placement.worldHeight / 2 + placement.plinthPad < 0,
        'the whole caption, plinth border included, must stay outside the playable area',
      );
      assertContract(
        placement.plinthPad > 0 && placement.plinthThickness > 0,
        'the caption must stand on a slab with real depth, not a decal plane',
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

  // The slab is the sign's ground: a closed box whose grassy top face is the
  // plane the caption and its letters are built on.
  const plinth = buildPlinthGeometry(900, 300, 160);
  const plinthPositions = plinth.getAttribute('position');
  const plinthNormals = plinth.getAttribute('normal');
  const plinthUvs = plinth.getAttribute('uv');
  const plinthIndex = plinth.index;
  assertContract(
    plinthPositions.count === 24 && plinthIndex !== null && plinthIndex.count === 36,
    'the plinth must be a closed six-face box',
  );
  assertContract(
    plinth.groups.length === 2
      && plinth.groups.every((group) => group.materialIndex === 0 || group.materialIndex === 1),
    'the plinth must draw as exactly two runs: the grass top and the rock shell',
  );
  const topGroup = plinth.groups.find((group) => group.materialIndex === 0);
  assertContract(
    topGroup !== undefined && topGroup.count === 6,
    'the grass material must cover exactly the one top face',
  );
  const plinthBox = new THREE.Box3().setFromBufferAttribute(
    plinthPositions as THREE.BufferAttribute,
  );
  assertContract(
    Math.abs(plinthBox.max.z) < 1e-6 && Math.abs(plinthBox.min.z + 160) < 1e-6,
    'the plinth must hang below the caption plane, never above it',
  );
  for (let triangle = 0; triangle < plinthIndex.count / 3; triangle++) {
    const a = new THREE.Vector3().fromBufferAttribute(plinthPositions, plinthIndex.getX(triangle * 3));
    const b = new THREE.Vector3().fromBufferAttribute(plinthPositions, plinthIndex.getX(triangle * 3 + 1));
    const c = new THREE.Vector3().fromBufferAttribute(plinthPositions, plinthIndex.getX(triangle * 3 + 2));
    const geometricNormal = b.sub(a).cross(c.sub(a)).normalize();
    const authored = new THREE.Vector3().fromBufferAttribute(
      plinthNormals,
      plinthIndex.getX(triangle * 3),
    );
    assertContract(
      geometricNormal.dot(authored) > 0.999,
      'every plinth face must be wound to agree with its outward normal',
    );
  }
  // UVs are authored in world tiles, so the slab carries the terrain's own
  // grain instead of one stretched copy of the tile per face.
  const topSpanU = Math.abs(plinthUvs.getX(1) - plinthUvs.getX(0));
  assertContract(
    Math.abs(topSpanU - 900 / TERRAIN_GROUND_TEXTURE_TILE_WORLD_SIZE) < 1e-6,
    'the grass face must repeat at the terrain ground tile size',
  );
  plinth.dispose();

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
