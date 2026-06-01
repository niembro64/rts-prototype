// Pale, unlit shell material retained for preview/legacy render paths.
// Live construction rendering for units/buildings uses EntityFade3D's
// alpha materialization fade instead of swapping to this clear shell.
//
// All shell-render colour tuning lives in @/shellConfig.

import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import { SHELL_PALE_HEX } from '@/shellConfig';

export function createShellMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: SHELL_PALE_HEX,
    transparent: true,
    opacity: COLORS.construction.shell.pale.opacity,
    depthWrite: true,
    // Render BOTH sides of every face — chassis sphere geometries are
    // single-sided, but with the shell material's flat colour both
    // sides reading the same is the cleaner visual.
    side: THREE.DoubleSide,
  });
}
