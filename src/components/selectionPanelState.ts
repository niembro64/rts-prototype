import type { CombatFireState, UnitAirIdleState, UnitMoveState } from '../game/sim/types';
import type { SelectionInfo } from '@/types/ui';

type BarStateLightTone = 'off' | 'mid' | 'on';

type BarStateLight = {
  key: string;
  tone: BarStateLightTone;
  active: boolean;
};

const BINARY_STATE_LIGHT_TONES = ['off', 'on'] as const satisfies readonly BarStateLightTone[];
const THREE_STATE_LIGHT_TONES = ['off', 'mid', 'on'] as const satisfies readonly BarStateLightTone[];

function stateLights(
  activeIndex: number | null,
  tones: readonly BarStateLightTone[],
): BarStateLight[] {
  return tones.map((tone, index) => ({
    key: `${tone}-${index}`,
    tone,
    active: activeIndex === index,
  }));
}

export function createSelectionPanelStateHelpers(
  isBarHotkeyPreset: () => boolean,
  trajectoryStateCount: () => number,
) {
  function trajectoryModeLabel(mode: SelectionInfo['trajectoryMode']): string {
    if (isBarHotkeyPreset()) {
      switch (mode) {
        case 'high': return 'High Trajectory';
        case 'low': return 'Low Trajectory';
        case 'auto': return trajectoryStateCount() === 3 ? 'Auto Trajectory' : 'High Trajectory';
      }
    }
    return mode === 'high' ? 'Arc Hi' : mode === 'low' ? 'Arc Lo' : 'Arc Auto';
  }

  function moveStateLabel(moveState: SelectionInfo['unitMoveState']): string {
    switch (moveState) {
      case 'holdPosition': return isBarHotkeyPreset() ? 'Hold pos' : 'Hold';
      case 'roam': return 'Roam';
      case 'mixed': return 'Mixed';
      case 'maneuver': return isBarHotkeyPreset() ? 'Maneuver' : 'Move';
    }
  }

  function factoryAirIdleStateLabel(airIdleState: SelectionInfo['factoryAirIdleState']): string {
    return airIdleState === 'fly' ? 'Fly' : 'Land';
  }

  function nextFactoryAirIdleState(
    airIdleState: SelectionInfo['factoryAirIdleState'],
  ): UnitAirIdleState {
    return airIdleState === 'fly' ? 'land' : 'fly';
  }

  function nextMoveStateLabel(moveState: SelectionInfo['unitMoveState']): string {
    switch (moveState) {
      case 'holdPosition': return 'Roam';
      case 'roam': return 'Maneuver';
      case 'maneuver': return isBarHotkeyPreset() ? 'Hold pos' : 'Hold';
      case 'mixed': return isBarHotkeyPreset() ? 'Hold pos' : 'Hold';
    }
  }

  function previousMoveState(moveState: SelectionInfo['unitMoveState']): UnitMoveState {
    switch (moveState) {
      case 'holdPosition': return 'maneuver';
      case 'maneuver': return 'roam';
      case 'roam': return 'holdPosition';
      case 'mixed': return 'roam';
    }
  }

  function fireStateLabel(fireState: SelectionInfo['fireState']): string {
    switch (fireState) {
      case 'fireAtWill': return isBarHotkeyPreset() ? 'Fire at will' : 'Fire';
      case 'returnFire': return isBarHotkeyPreset() ? 'Return fire' : 'Return';
      case 'holdFire': return isBarHotkeyPreset() ? 'Hold fire' : 'Hold';
      case 'defend': return 'Defend';
      case 'fireAtAll': return isBarHotkeyPreset() ? 'Fire at all' : 'Fire all';
      case 'mixed': return 'Mixed';
    }
  }

  function nextFireStateLabel(fireState: SelectionInfo['fireState']): string {
    switch (fireState) {
      case 'fireAtWill': return isBarHotkeyPreset() ? 'Return fire' : 'Return';
      case 'returnFire': return isBarHotkeyPreset() ? 'Hold fire' : 'Hold';
      case 'holdFire': return isBarHotkeyPreset() ? 'Fire at will' : 'Fire';
      case 'defend': return isBarHotkeyPreset() ? 'Hold fire' : 'Hold';
      case 'fireAtAll': return isBarHotkeyPreset() ? 'Hold fire' : 'Hold';
      case 'mixed': return isBarHotkeyPreset() ? 'Fire at will' : 'Fire';
    }
  }

  function previousFireState(fireState: SelectionInfo['fireState']): CombatFireState {
    switch (fireState) {
      case 'fireAtWill': return 'holdFire';
      case 'holdFire': return 'returnFire';
      case 'returnFire': return 'fireAtWill';
      case 'defend': return 'fireAtWill';
      case 'fireAtAll': return 'fireAtWill';
      case 'mixed': return 'holdFire';
    }
  }

  function cloakStateLabel(selection: SelectionInfo): string {
    if (isBarHotkeyPreset()) return selection.wantsCloak || selection.isCloaked ? 'Cloaked' : 'Visible';
    if (selection.isCloaked) return 'Cloaked';
    return selection.wantsCloak ? 'Cloaking' : 'Cloak';
  }

  function repeatStateLabel(active: boolean): string {
    return isBarHotkeyPreset() ? (active ? 'Repeat On' : 'Repeat Off') : 'Repeat';
  }

  function builderPriorityLabel(lowPriority: boolean): string {
    return isBarHotkeyPreset()
      ? lowPriority ? 'Low Priority' : 'High Priority'
      : lowPriority ? 'Low Prio' : 'High Prio';
  }

  function carrierSpawnLabel(enabled: boolean): string {
    return isBarHotkeyPreset()
      ? enabled ? 'Spawning enabled' : 'Spawning disabled'
      : enabled ? 'Spawning Enabled' : 'Spawning Disabled';
  }

  function factoryQueueModeLabel(enabled: boolean): string {
    return isBarHotkeyPreset() ? (enabled ? 'Quota Mode' : 'Queue Mode') : enabled ? 'Quota' : 'Queue';
  }

  function factoryGuardStateLabel(active: boolean): string {
    return isBarHotkeyPreset() ? 'Factory Guard' : active ? 'Factory guard on' : 'Factory guard off';
  }

  function stopFactoryProductionLabel(): string {
    return isBarHotkeyPreset() ? 'Clear Queue' : 'Stop Production';
  }

  function binaryStateLights(active: boolean): BarStateLight[] {
    return stateLights(active ? 1 : 0, BINARY_STATE_LIGHT_TONES);
  }

  function moveStateLights(moveState: SelectionInfo['unitMoveState']): BarStateLight[] {
    switch (moveState) {
      case 'holdPosition': return stateLights(0, THREE_STATE_LIGHT_TONES);
      case 'maneuver': return stateLights(1, THREE_STATE_LIGHT_TONES);
      case 'roam': return stateLights(2, THREE_STATE_LIGHT_TONES);
      case 'mixed': return stateLights(null, THREE_STATE_LIGHT_TONES);
    }
  }

  function fireStateLights(fireState: SelectionInfo['fireState']): BarStateLight[] {
    switch (fireState) {
      case 'holdFire': return stateLights(0, THREE_STATE_LIGHT_TONES);
      case 'returnFire': return stateLights(1, THREE_STATE_LIGHT_TONES);
      case 'fireAtWill': return stateLights(2, THREE_STATE_LIGHT_TONES);
      case 'defend': return stateLights(1, THREE_STATE_LIGHT_TONES);
      case 'fireAtAll': return THREE_STATE_LIGHT_TONES.map((tone, index) => ({
        key: String(index),
        active: true,
        tone,
      }));
      case 'mixed': return stateLights(null, THREE_STATE_LIGHT_TONES);
    }
  }

  function trajectoryStateLights(mode: SelectionInfo['trajectoryMode']): BarStateLight[] {
    if (isBarHotkeyPreset()) {
      if (trajectoryStateCount() === 3) {
        switch (mode) {
          case 'low': return stateLights(0, THREE_STATE_LIGHT_TONES);
          case 'high': return stateLights(1, THREE_STATE_LIGHT_TONES);
          case 'auto': return stateLights(2, THREE_STATE_LIGHT_TONES);
        }
      }
      return stateLights(mode === 'low' ? 0 : 1, BINARY_STATE_LIGHT_TONES);
    }
    switch (mode) {
      case 'low': return stateLights(0, THREE_STATE_LIGHT_TONES);
      case 'auto': return stateLights(1, THREE_STATE_LIGHT_TONES);
      case 'high': return stateLights(2, THREE_STATE_LIGHT_TONES);
    }
  }

  return {
    binaryStateLights,
    builderPriorityLabel,
    carrierSpawnLabel,
    cloakStateLabel,
    factoryAirIdleStateLabel,
    factoryGuardStateLabel,
    factoryQueueModeLabel,
    fireStateLabel,
    fireStateLights,
    moveStateLabel,
    moveStateLights,
    nextFactoryAirIdleState,
    nextFireStateLabel,
    nextMoveStateLabel,
    previousFireState,
    previousMoveState,
    repeatStateLabel,
    stopFactoryProductionLabel,
    trajectoryModeLabel,
    trajectoryStateLights,
  };
}
