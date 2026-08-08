import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import type { PlayerId } from '../sim/types';
import {
  entityBodyColorHexForPlayer,
  entityTeamColorHexForPlayer,
} from './EntityInstanceColor3D';
import { createShieldFallbackPanelMaterial } from './ShieldReflectorVisual3D';
import { patchSurfaceChartSurface } from './SurfaceChartMaterial3D';

/** Every body surface in the game is made of the same metal, so every body
 *  material is born textured. Doing it here rather than at each call site is
 *  what makes coverage a property of the palette instead of a checklist:
 *  hulls, building shells, turret heads and barrels all draw their material
 *  from this class, and none of them can forget. */
function surfaceMat(color: number): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({ color });
  patchSurfaceChartSurface(material);
  return material;
}

export class EntityMaterialPalette3D {
  private readonly primaryMats = new Map<PlayerId, THREE.MeshLambertMaterial>();
  private readonly teamOrnamentMats = new Map<number, THREE.MeshLambertMaterial>();
  private readonly neutralMat = surfaceMat(COLORS.units.neutral.colorHex);
  private readonly mirrorShinyNeutralMat = createShieldFallbackPanelMaterial();
  private readonly barrelMat = surfaceMat(COLORS.units.turret.barrel.colorHex);

  getBarrelMat(): THREE.MeshLambertMaterial {
    return this.barrelMat;
  }

  getMirrorShinyMat(): THREE.Material {
    return this.mirrorShinyNeutralMat;
  }

  getPrimaryMat(playerId: PlayerId | undefined): THREE.MeshLambertMaterial {
    if (playerId === undefined) return this.neutralMat;
    let mat = this.primaryMats.get(playerId);
    if (!mat) {
      mat = surfaceMat(entityBodyColorHexForPlayer(playerId));
      this.primaryMats.set(playerId, mat);
    }
    return mat;
  }

  getTeamOrnamentMat(playerId: PlayerId | undefined): THREE.MeshLambertMaterial {
    const color = entityTeamColorHexForPlayer(playerId);
    let mat = this.teamOrnamentMats.get(color);
    if (!mat) {
      mat = surfaceMat(color);
      this.teamOrnamentMats.set(color, mat);
    }
    return mat;
  }

  dispose(): void {
    this.mirrorShinyNeutralMat.dispose();
    this.barrelMat.dispose();
    for (const mat of this.primaryMats.values()) mat.dispose();
    for (const mat of this.teamOrnamentMats.values()) mat.dispose();
    this.primaryMats.clear();
    this.teamOrnamentMats.clear();
    this.neutralMat.dispose();
  }
}
