import type * as THREE from 'three';
import {
  getLodMode,
  setLodMode,
} from '../../clientBarConfig';
import type { Entity } from '../sim/types';
import {
  ENTITY_LOD_PROXY_GLYPH_CIRCLE,
  ENTITY_LOD_PROXY_GLYPH_CROSS,
  ENTITY_LOD_PROXY_GLYPH_DIAMOND,
  ENTITY_LOD_PROXY_GLYPH_SQUARE,
  ENTITY_LOD_PROXY_GLYPH_TRIANGLE,
  EntityLodState3D,
  entityLodProxyGlyph3D,
} from './EntityLod3D';
import type { RenderViewState3D } from './RenderFrameState3D';
import {
  DETAIL_RUNG_CLOSE,
  DETAIL_RUNG_FAR,
  DETAIL_RUNG_GLYPH,
  DETAIL_RUNG_MID,
} from './EntityDetailLevel3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[entity lod 3d contract] ${message}`);
  }
}

function cameraAt(x: number, y: number, z: number): THREE.Camera {
  return { position: { x, y, z } } as unknown as THREE.Camera;
}

function viewAt(camera: THREE.Camera): RenderViewState3D {
  return {
    viewportHeightPx: 900,
    cameraX: camera.position.x,
    cameraY: camera.position.y,
    cameraZ: camera.position.z,
    forwardX: 0,
    forwardY: 0,
    forwardZ: -1,
    fovYRad: Math.PI / 4,
  };
}

function entityAt(id: number, x: number, y: number, z: number): Entity {
  return {
    id,
    type: 'unit',
    entitySlotId: -1,
    transform: { x, y, z, rotation: 0, rotCos: null, rotSin: null },
    unit: null,
    building: null,
    projectile: null,
    builder: null,
    commander: null,
    factory: null,
    transport: null,
  } as Entity;
}

export function runEntityLod3DContractTest(): void {
  const camera = cameraAt(0, 0, 0);
  const previousLodMode = getLodMode();

  try {
    const bodyLod = new EntityLodState3D();
    const body = entityAt(202, 0, 0, 0);
    setLodMode('low');
    bodyLod.beginFrame();
    assertContract(
      !bodyLod.entityUsesLodProxyForView(viewAt(camera), body) &&
        bodyLod.entityDetailRungForView(viewAt(camera), body) === DETAIL_RUNG_FAR,
      'LOW mode selects real Low geometry for every entity, not a proxy special case',
    );
    setLodMode('medium');
    bodyLod.beginFrame();
    assertContract(
      bodyLod.entityDetailRungForView(viewAt(camera), body) === DETAIL_RUNG_MID,
      'MED mode selects the same Medium rung for a non-host entity',
    );
    setLodMode('high');
    bodyLod.beginFrame();
    assertContract(
      !bodyLod.entityUsesLodProxyForView(viewAt(camera), body) &&
        bodyLod.entityDetailRungForView(viewAt(camera), body) === DETAIL_RUNG_CLOSE,
      'HIGH mode selects the same High rung for a non-host entity',
    );
    setLodMode('off');
    bodyLod.beginFrame();
    assertContract(
      bodyLod.entityUsesLodProxyForView(viewAt(camera), body) &&
        bodyLod.entityDetailRungForView(viewAt(camera), body) === DETAIL_RUNG_GLYPH,
      'OFF mode hides entity models behind their final strategic glyphs',
    );
    setLodMode('auto');
    body.transform.x = 0;
    body.transform.y = -10;
    bodyLod.beginFrame();
    assertContract(
      !bodyLod.entityUsesLodProxyForView(viewAt(camera), body),
      'AUTO mode keeps near entities in full detail',
    );
    body.transform.y = -10000;
    bodyLod.beginFrame();
    assertContract(
      bodyLod.entityUsesLodProxyForView(viewAt(camera), body),
      'AUTO mode switches far entities to proxy selection',
    );

    const groundUnit = entityAt(301, 0, 0, 0);
    groundUnit.unit = {
      locomotion: { type: 'wheels' },
      radius: { other: 20, hitbox: 18, collision: 15 },
    } as NonNullable<Entity['unit']>;
    setLodMode('low');
    bodyLod.beginFrame();
    assertContract(
      !bodyLod.entityUsesLodProxyForView(viewAt(camera), groundUnit),
      'LOW mode keeps units as real low-poly geometry',
    );
    assertContract(
      bodyLod.entityDetailRungForView(viewAt(camera), groundUnit) === DETAIL_RUNG_FAR,
      'LOW mode selects the far geometry tier for units',
    );
    setLodMode('medium');
    bodyLod.beginFrame();
    assertContract(
      !bodyLod.entityUsesLodProxyForView(viewAt(camera), groundUnit) &&
        bodyLod.entityDetailRungForView(viewAt(camera), groundUnit) === DETAIL_RUNG_MID,
      'MED mode freezes units at real medium-resolution geometry',
    );
    // BAR-style behavior: units iconify too. Near units draw no icon;
    // inside the fade band the icon fades in OVER the still-opaque model;
    // at glyph range the model stops drawing and the icon replaces it.
    setLodMode('auto');
    groundUnit.transform.y = -10;
    bodyLod.beginFrame();
    assertContract(
      !bodyLod.entityUsesLodProxyForView(viewAt(camera), groundUnit) &&
        bodyLod.entityLodProxyFadeAlphaForView(viewAt(camera), groundUnit) === 0,
      'AUTO mode draws near units as full models with no icon overlay',
    );
    groundUnit.transform.y = -2000;
    bodyLod.beginFrame();
    assertContract(
      bodyLod.entityDetailRungForView(viewAt(camera), groundUnit) === DETAIL_RUNG_MID &&
        bodyLod.entityLodProxyFadeAlphaForView(viewAt(camera), groundUnit) === 0,
      'AUTO Medium resolves to the exact manual MED rung with no icon covering it',
    );
    groundUnit.transform.y = -4000;
    bodyLod.beginFrame();
    const bandFadeAlpha = bodyLod.entityLodProxyFadeAlphaForView(viewAt(camera), groundUnit);
    assertContract(
      !bodyLod.entityUsesLodProxyForView(viewAt(camera), groundUnit) &&
        bodyLod.entityDetailRungForView(viewAt(camera), groundUnit) === DETAIL_RUNG_FAR &&
        bandFadeAlpha > 0 && bandFadeAlpha < 1,
      'AUTO Low resolves to the exact manual LOW model while its icon cross-fades in',
    );
    groundUnit.transform.y = -10000;
    bodyLod.beginFrame();
    assertContract(
      bodyLod.entityUsesLodProxyForView(viewAt(camera), groundUnit),
      'AUTO mode replaces very distant units with their proxy icons (BAR)',
    );
    assertContract(
      entityLodProxyGlyph3D(groundUnit) === ENTITY_LOD_PROXY_GLYPH_CIRCLE,
      'ground combat units use the default circular proxy glyph',
    );
    setLodMode('off');
    groundUnit.transform.y = -10;
    bodyLod.beginFrame();
    assertContract(
      bodyLod.entityUsesLodProxyForView(viewAt(camera), groundUnit) &&
        bodyLod.entityDetailRungForView(viewAt(camera), groundUnit) === DETAIL_RUNG_GLYPH,
      'OFF mode uses the circle glyph even for a nearby ground unit',
    );

    const airUnit = entityAt(302, 0, 0, 0);
    airUnit.unit = { locomotion: { type: 'flying' } } as NonNullable<Entity['unit']>;
    assertContract(
      entityLodProxyGlyph3D(airUnit) === ENTITY_LOD_PROXY_GLYPH_TRIANGLE,
      'flying units use the triangular proxy glyph',
    );

    const builderUnit = entityAt(303, 0, 0, 0);
    builderUnit.unit = { locomotion: { type: 'hover' } } as NonNullable<Entity['unit']>;
    builderUnit.builder = {} as NonNullable<Entity['builder']>;
    assertContract(
      entityLodProxyGlyph3D(builderUnit) === ENTITY_LOD_PROXY_GLYPH_DIAMOND,
      'builder units use the diamond proxy glyph',
    );

    const transportUnit = entityAt(304, 0, 0, 0);
    transportUnit.unit = { locomotion: { type: 'wheels' } } as NonNullable<Entity['unit']>;
    transportUnit.transport = { capacity: 1, loadedUnits: [] } as NonNullable<Entity['transport']>;
    assertContract(
      entityLodProxyGlyph3D(transportUnit) === ENTITY_LOD_PROXY_GLYPH_SQUARE,
      'transport units use the square proxy glyph',
    );

    const commanderUnit = entityAt(305, 0, 0, 0);
    commanderUnit.unit = { locomotion: { type: 'wheels' } } as NonNullable<Entity['unit']>;
    commanderUnit.builder = {} as NonNullable<Entity['builder']>;
    commanderUnit.commander = { isDGunActive: false, dgunEnergyCost: 0 };
    assertContract(
      entityLodProxyGlyph3D(commanderUnit) === ENTITY_LOD_PROXY_GLYPH_CROSS,
      'commander units take precedence over builder proxy glyphs',
    );

    const structure = entityAt(306, 0, 0, 0);
    structure.type = 'building';
    structure.building = {} as NonNullable<Entity['building']>;
    setLodMode('low');
    bodyLod.beginFrame();
    assertContract(
      !bodyLod.entityUsesLodProxyForView(viewAt(camera), structure),
      'LOW mode keeps structures as real low-poly geometry',
    );
    assertContract(
      bodyLod.entityDetailRungForView(viewAt(camera), structure) === DETAIL_RUNG_FAR,
      'LOW mode selects the far geometry tier for structures',
    );
    assertContract(
      entityLodProxyGlyph3D(structure) === ENTITY_LOD_PROXY_GLYPH_SQUARE,
      'structures use the square proxy glyph',
    );
  } finally {
    setLodMode(previousLodMode);
  }
}
