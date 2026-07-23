import { AUDIO, type SoundEntry } from '@/audioConfig';
import {
  getBuildingBlueprint,
  getRayBlueprint,
  getShotBlueprint,
  getTurretBlueprint,
  getUnitBlueprint,
} from '@/game/sim/blueprints';
import { createBuildingRuntimeTurrets, createUnitRuntimeTurrets } from '@/game/sim/runtimeTurrets';
import {
  BUILDING_BLUEPRINT_IDS,
  UNIT_BLUEPRINT_IDS,
  type StructureBlueprintId,
  type TurretBlueprintId,
  type UnitBlueprintId,
} from '@/types/blueprintIds';
import type { LoadingEntityBlueprintId, LoadingPreviewKind } from './loadingUnitPreviewScene';
import type { Turret } from '@/game/sim/types';
import { getEmissionBlueprintId, isRayConfig, isShieldConfig } from '@/game/sim/types';

type EntityLabSelection = {
  kind: LoadingPreviewKind;
  id: LoadingEntityBlueprintId;
  name: string;
};

export type EntityLabSoundActionKind = 'fire' | 'hit' | 'death' | 'beam-loop' | 'shield-loop';

export type EntityLabSoundAction = {
  id: string;
  kind: EntityLabSoundActionKind;
  label: string;
  detail: string;
  turretBlueprintId: TurretBlueprintId | null;
  emissionBlueprintId: string | null;
  sound: SoundEntry | null;
};

export type UniqueSound = {
  synth: SoundEntry['synth'];
  playSpeed: number;
  volume: number;
  ids: string[];
};

export const ENTITY_LAB_KINDS: readonly LoadingPreviewKind[] = ['unit', 'building'];

export function buildEntityLabSelections(kind: LoadingPreviewKind): EntityLabSelection[] {
  const ids = kind === 'unit'
    ? UNIT_BLUEPRINT_IDS
    : BUILDING_BLUEPRINT_IDS;
  return ids.map((id) => ({
    kind,
    id,
    name: kind === 'unit'
      ? getUnitBlueprint(id as UnitBlueprintId).name
      : getBuildingBlueprint(id as StructureBlueprintId).name,
  }));
}

export function getEntityLabSelectionName(
  kind: LoadingPreviewKind,
  id: LoadingEntityBlueprintId,
): string {
  return kind === 'unit'
    ? getUnitBlueprint(id as UnitBlueprintId).name
    : getBuildingBlueprint(id as StructureBlueprintId).name;
}

export function buildEntityLabSoundActions(
  kind: LoadingPreviewKind,
  id: LoadingEntityBlueprintId,
): EntityLabSoundAction[] {
  const actions: EntityLabSoundAction[] = [];
  if (kind === 'unit') {
    const unitBlueprint = getUnitBlueprint(id as UnitBlueprintId);
    if (unitBlueprint.deathSound !== null) {
      actions.push({
        id: `death-${unitBlueprint.unitBlueprintId}`,
        kind: 'death',
        label: 'Death',
        detail: soundEntryDetail(unitBlueprint.deathSound),
        turretBlueprintId: null,
        emissionBlueprintId: null,
        sound: unitBlueprint.deathSound,
      });
    }
  }

  const turrets = getEntityLabTurrets(kind, id);
  for (let i = 0; i < turrets.length; i++) {
    const turret = turrets[i];
    const turretBlueprintId = turret.config.turretBlueprintId;
    const turretBlueprint = getTurretBlueprint(turretBlueprintId);
    const prefix = `${i + 1}. ${turretBlueprint.name}`;
    const fireSound = turretBlueprint.audio !== null ? turretBlueprint.audio.fireSound : null;
    if (fireSound !== null) {
      actions.push({
        id: `fire-${i}-${turretBlueprintId}`,
        kind: 'fire',
        label: `${prefix} fire`,
        detail: soundEntryDetail(fireSound),
        turretBlueprintId,
        emissionBlueprintId: turretBlueprint.emissionBlueprintId,
        sound: fireSound,
      });
    }

    if (turret.config.shot !== null && !isShieldConfig(turret.config.shot)) {
      const emissionBlueprintId = turretBlueprint.emissionBlueprintId ?? getEmissionBlueprintId(turret.config.shot);
      const hitSound = readHitSound(emissionBlueprintId);
      if (hitSound !== null) {
        actions.push({
          id: `hit-${i}-${emissionBlueprintId}`,
          kind: 'hit',
          label: `${prefix} hit`,
          detail: `${emissionBlueprintId} / ${soundEntryDetail(hitSound)}`,
          turretBlueprintId,
          emissionBlueprintId,
          sound: hitSound,
        });
      }
    }

    if (turret.config.shot !== null && isRayConfig(turret.config.shot) && turret.config.shot.type === 'beam') {
      actions.push({
        id: `beam-${i}-${turretBlueprintId}`,
        kind: 'beam-loop',
        label: `${prefix} beam loop`,
        detail: `${turretBlueprint.emissionBlueprintId ?? 'beam'} / x${AUDIO.beamGain}`,
        turretBlueprintId,
        emissionBlueprintId: turretBlueprint.emissionBlueprintId,
        sound: fireSound,
      });
    }

    if (turret.config.shot !== null && isShieldConfig(turret.config.shot)) {
      actions.push({
        id: `shield-${i}-${turretBlueprintId}`,
        kind: 'shield-loop',
        label: `${prefix} shield loop`,
        detail: `field / x${AUDIO.fieldGain}`,
        turretBlueprintId,
        emissionBlueprintId: turretBlueprint.emissionBlueprintId,
        sound: fireSound,
      });
    }
  }

  return actions;
}

export function dedupeSounds(entries: Record<string, SoundEntry>): UniqueSound[] {
  const sounds = new Map<string, UniqueSound>();
  for (const [id, entry] of Object.entries(entries)) {
    const key = `${entry.synth}|${entry.playSpeed}|${entry.volume}`;
    const existing = sounds.get(key);
    if (existing !== undefined) {
      existing.ids.push(id);
      continue;
    }
    sounds.set(key, {
      synth: entry.synth,
      playSpeed: entry.playSpeed,
      volume: entry.volume,
      ids: [id],
    });
  }
  return [...sounds.values()];
}

export function soundEntryDetail(sound: SoundEntry): string {
  return `${sound.synth} / ${formatNumber(sound.playSpeed, 3)}x / vol ${formatNumber(sound.volume, 2)}`;
}

export function uniqueSoundLabel(sound: UniqueSound): string {
  return sound.ids.join(', ');
}

function getEntityLabTurrets(
  kind: LoadingPreviewKind,
  id: LoadingEntityBlueprintId,
): Turret[] {
  if (kind === 'unit') {
    const unitBlueprint = getUnitBlueprint(id as UnitBlueprintId);
    return createUnitRuntimeTurrets(unitBlueprint.unitBlueprintId, unitBlueprint.radius.other);
  }
  return createBuildingRuntimeTurrets(id as StructureBlueprintId);
}

function readHitSound(emissionBlueprintId: string): SoundEntry | null {
  try {
    return getShotBlueprint(emissionBlueprintId).hitSound;
  } catch {
    try {
      return getRayBlueprint(emissionBlueprintId).hitSound;
    } catch {
      return null;
    }
  }
}

function formatNumber(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return 'n/a';
  return Number(value.toFixed(decimals)).toString();
}
