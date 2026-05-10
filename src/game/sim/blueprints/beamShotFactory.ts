import type { ShotId } from '../../../types/blueprintIds';
import type { BeamShotBlueprint } from './types';

type BeamShotSizePreset = 'mini' | 'base' | 'mega';

type BeamShotSize = Pick<BeamShotBlueprint, 'radius' | 'width' | 'damageSphere'>;

type BeamShotOptions = {
  preset: BeamShotSizePreset;
  dps: number;
  force: number;
  recoil?: number;
  hitSound?: BeamShotBlueprint['hitSound'];
};

function beamShotSize(width: number): BeamShotSize {
  return {
    radius: width / 2,
    width,
    damageSphere: { radius: width * 2 },
  };
}

const BEAM_SHOT_SIZE_PRESETS = {
  mini: beamShotSize(3),
  base: beamShotSize(6),
  mega: beamShotSize(16),
} satisfies Record<BeamShotSizePreset, BeamShotSize>;

export function createBeamShot(
  id: ShotId,
  options: BeamShotOptions,
): BeamShotBlueprint {
  const size = BEAM_SHOT_SIZE_PRESETS[options.preset];
  return {
    type: 'beam',
    id,
    dps: options.dps,
    force: options.force,
    recoil: options.recoil ?? options.force,
    radius: size.radius,
    width: size.width,
    damageSphere: { radius: size.damageSphere.radius },
    hitSound: options.hitSound,
  };
}
