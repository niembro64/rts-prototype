import * as THREE from 'three';
import { SHELL_PALE_HEX } from '@/shellConfig';
import { FORCE_FIELD_BARRIER, FORCE_FIELD_VISUAL } from '../../config';
import { getPlayerPrimaryColor, type Entity } from '../sim/types';
import { isConstructionShell } from './EntityInstanceColor3D';

const FORCE_FIELD_OPACITY_BOOST = 2;

export const MIRROR_REFLECTOR_PANEL_COLOR = FORCE_FIELD_VISUAL.fallbackColor;
export const MIRROR_REFLECTOR_PANEL_OPACITY = Math.min(
  1,
  FORCE_FIELD_BARRIER.alpha * FORCE_FIELD_OPACITY_BOOST,
);

export function resolveMirrorReflectorPanelColor(entity: Entity): number {
  if (isConstructionShell(entity)) return SHELL_PALE_HEX;
  return FORCE_FIELD_VISUAL.colorMode === 'player' && entity.ownership
    ? getPlayerPrimaryColor(entity.ownership.playerId)
    : FORCE_FIELD_VISUAL.fallbackColor;
}

export function createMirrorReflectorPanelMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: MIRROR_REFLECTOR_PANEL_COLOR,
    transparent: true,
    opacity: MIRROR_REFLECTOR_PANEL_OPACITY,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}
