import { isShotBlueprintId, isTurretBlueprintId, isUnitBlueprintId } from '@/types/blueprintIds';
import { audioManager } from '../../audio/AudioManager';
import type { NetworkServerSnapshotSimEvent } from '../../network/NetworkTypes';

/** Play the audio side of a SimEvent ahead of any visual gating. */
export function playSimEventAudio3D(event: NetworkServerSnapshotSimEvent): void {
  switch (event.type) {
    case 'fire':
      // turretBlueprintId on a 'fire' event is the firing turret blueprint id.
      // Narrow before passing so we don't accidentally feed a shot
      // or unit blueprint id when the event was authored unexpectedly.
      if (event.turretBlueprintId && isTurretBlueprintId(event.turretBlueprintId)) {
        audioManager.playWeaponFire(event.turretBlueprintId);
      }
      return;
    case 'hit':
    case 'projectileExpire':
      // hit / expire audio is keyed by the shot blueprint id. Beam
      // and laser hits carry a turret blueprint id in this same field; the
      // blueprintId helper distinguishes shot vs turret so we route
      // it through the right AudioManager method.
      if (event.turretBlueprintId) {
        if (isShotBlueprintId(event.turretBlueprintId)) audioManager.playWeaponHit(event.turretBlueprintId);
        else if (isTurretBlueprintId(event.turretBlueprintId)) audioManager.playWeaponFire(event.turretBlueprintId);
      }
      return;
    case 'death': {
      const unitBlueprintId = event.deathContext?.unitBlueprintId;
      if (unitBlueprintId && isUnitBlueprintId(unitBlueprintId)) audioManager.playUnitDeath(unitBlueprintId);
      return;
    }
    case 'laserStart':
      if (event.entityId !== null) {
        audioManager.startLaserSoundForTurret(
          event.entityId,
          event.turretBlueprintId && isTurretBlueprintId(event.turretBlueprintId)
            ? event.turretBlueprintId
            : undefined,
        );
      }
      return;
    case 'laserStop':
      if (event.entityId !== null) audioManager.stopLaserSound(event.entityId);
      return;
    case 'shieldStart':
      if (event.entityId !== null) audioManager.startShieldSound(event.entityId);
      return;
    case 'shieldStop':
      if (event.entityId !== null) audioManager.stopShieldSound(event.entityId);
      return;
    // ping / attackAlert / shieldImpact have no one-shot sound
    // wired yet; the visual is the whole UX. Drop through.
  }
}
