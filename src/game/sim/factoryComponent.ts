import type { Entity } from './types';

type FactoryComponent = NonNullable<Entity['factory']>;

type FactoryComponentOptions = Pick<
  FactoryComponent,
  'rallyX' | 'rallyY' | 'rallyZ' | 'rallyType'
> & Partial<Pick<
  FactoryComponent,
  | 'selectedUnitBlueprintId'
  | 'lowPriority'
  | 'carrierSpawnEnabled'
  | 'moveState'
  | 'airIdleState'
  | 'repeatProduction'
  | 'paused'
  | 'guardTargetId'
  | 'isProducing'
>>;

/**
 * Creates independent runtime state for a newly observed or authored factory.
 * Queue and quota containers must never be shared between entities.
 */
export function createFactoryComponent(
  options: FactoryComponentOptions,
): FactoryComponent {
  return {
    selectedUnitBlueprintId: options.selectedUnitBlueprintId ?? null,
    lowPriority: options.lowPriority ?? false,
    carrierSpawnEnabled: options.carrierSpawnEnabled ?? true,
    moveState: options.moveState ?? 'maneuver',
    airIdleState: options.airIdleState ?? 'fly',
    repeatProduction: options.repeatProduction ?? false,
    paused: options.paused ?? false,
    productionQueue: [],
    productionQuotas: {},
    productionQuotaCounts: {},
    resumeRepeatUnitBlueprintId: null,
    currentShellId: null,
    currentBuildProgress: 0,
    defaultWaypoints: null,
    rallyX: options.rallyX,
    rallyY: options.rallyY,
    rallyZ: options.rallyZ,
    rallyType: options.rallyType,
    guardTargetId: options.guardTargetId ?? null,
    isProducing: options.isProducing ?? false,
    energyRateFraction: 0,
    metalRateFraction: 0,
  };
}
