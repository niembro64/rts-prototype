import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import type { PlayerId } from '../sim/types';
import {
  entityBodyColorHexForPlayer,
  turretAccentColorHexForPlayer,
} from './EntityInstanceColor3D';
import { createShieldFallbackPanelMaterial } from './ShieldReflectorVisual3D';

export class EntityMaterialPalette3D {
  private readonly primaryMats = new Map<PlayerId, THREE.MeshLambertMaterial>();
  private readonly turretAccentMats = new Map<number, THREE.MeshLambertMaterial>();
  private readonly neutralMat = new THREE.MeshLambertMaterial({
    color: COLORS.units.neutral.colorHex,
  });
  private readonly mirrorShinyNeutralMat = createShieldFallbackPanelMaterial();
  private readonly barrelMat = new THREE.MeshLambertMaterial({
    color: COLORS.units.turret.barrel.colorHex,
  });

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
      mat = new THREE.MeshLambertMaterial({ color: entityBodyColorHexForPlayer(playerId) });
      this.primaryMats.set(playerId, mat);
    }
    return mat;
  }

  getTurretAccentMat(playerId: PlayerId | undefined): THREE.MeshLambertMaterial {
    const color = turretAccentColorHexForPlayer(playerId);
    let mat = this.turretAccentMats.get(color);
    if (!mat) {
      mat = new THREE.MeshLambertMaterial({ color });
      this.turretAccentMats.set(color, mat);
    }
    return mat;
  }

  dispose(): void {
    this.mirrorShinyNeutralMat.dispose();
    this.barrelMat.dispose();
    for (const mat of this.primaryMats.values()) mat.dispose();
    for (const mat of this.turretAccentMats.values()) mat.dispose();
    this.neutralMat.dispose();
  }
}
