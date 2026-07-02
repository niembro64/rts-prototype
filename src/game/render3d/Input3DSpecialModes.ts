export type Input3DSpecialMode =
  | 'repairArea'
  | 'restoreArea'
  | 'formationAssume'
  | 'formationMove'
  | 'attack'
  | 'attackArea'
  | 'attackGround'
  | 'manualLaunch'
  | 'guard'
  | 'reclaim'
  | 'capture'
  | 'resurrect'
  | 'resurrectArea'
  | 'loadTransport'
  | 'unloadTransport'
  | 'mexUpgrade'
  | 'ping'
  | 'towerTarget'
  | 'towerTargetNoGround';

type Input3DSpecialModeCallbacks = {
  onRepairAreaModeChange: (active: boolean) => void;
  onRestoreAreaModeChange: (active: boolean) => void;
  onFormationAssumeModeChange: (active: boolean) => void;
  onFormationMoveModeChange: (active: boolean) => void;
  onAttackModeChange: (active: boolean) => void;
  onAttackAreaModeChange: (active: boolean) => void;
  onAttackGroundModeChange: (active: boolean) => void;
  onManualLaunchModeChange: (active: boolean) => void;
  onGuardModeChange: (active: boolean) => void;
  onReclaimModeChange: (active: boolean) => void;
  onCaptureModeChange: (active: boolean) => void;
  onResurrectModeChange: (active: boolean) => void;
  onResurrectAreaModeChange: (active: boolean) => void;
  onLoadTransportModeChange: (active: boolean) => void;
  onUnloadTransportModeChange: (active: boolean) => void;
  onMexUpgradeModeChange: (active: boolean) => void;
  onPingModeChange: (active: boolean) => void;
  onTowerTargetModeChange: (active: boolean) => void;
  onTowerTargetNoGroundModeChange: (active: boolean) => void;
};

type Input3DSpecialModesOptions = Input3DSpecialModeCallbacks & {
  refreshCursor: () => void;
};

const SPECIAL_MODE_ORDER: readonly Input3DSpecialMode[] = [
  'repairArea',
  'restoreArea',
  'formationAssume',
  'formationMove',
  'attack',
  'attackArea',
  'attackGround',
  'manualLaunch',
  'guard',
  'reclaim',
  'capture',
  'resurrect',
  'resurrectArea',
  'loadTransport',
  'unloadTransport',
  'mexUpgrade',
  'ping',
  'towerTarget',
  'towerTargetNoGround',
];

export class Input3DSpecialModes {
  private active: Record<Input3DSpecialMode, boolean> = {
    repairArea: false,
    restoreArea: false,
    formationAssume: false,
    formationMove: false,
    attack: false,
    attackArea: false,
    attackGround: false,
    manualLaunch: false,
    guard: false,
    reclaim: false,
    capture: false,
    resurrect: false,
    resurrectArea: false,
    loadTransport: false,
    unloadTransport: false,
    mexUpgrade: false,
    ping: false,
    towerTarget: false,
    towerTargetNoGround: false,
  };

  constructor(private readonly options: Input3DSpecialModesOptions) {}

  isActive(mode: Input3DSpecialMode): boolean {
    return this.active[mode];
  }

  enter(mode: Input3DSpecialMode): void {
    if (this.active[mode]) return;
    this.active[mode] = true;
    this.options.refreshCursor();
    this.notify(mode, true);
  }

  exit(mode: Input3DSpecialMode): void {
    if (!this.active[mode]) return;
    this.active[mode] = false;
    this.options.refreshCursor();
    this.notify(mode, false);
  }

  exitAll(includeTowerTarget = true): void {
    for (const mode of SPECIAL_MODE_ORDER) {
      if (!includeTowerTarget && (mode === 'towerTarget' || mode === 'towerTargetNoGround')) continue;
      this.exit(mode);
    }
  }

  private notify(mode: Input3DSpecialMode, active: boolean): void {
    switch (mode) {
      case 'repairArea':
        this.options.onRepairAreaModeChange(active);
        break;
      case 'restoreArea':
        this.options.onRestoreAreaModeChange(active);
        break;
      case 'formationAssume':
        this.options.onFormationAssumeModeChange(active);
        break;
      case 'formationMove':
        this.options.onFormationMoveModeChange(active);
        break;
      case 'attack':
        this.options.onAttackModeChange(active);
        break;
      case 'attackArea':
        this.options.onAttackAreaModeChange(active);
        break;
      case 'attackGround':
        this.options.onAttackGroundModeChange(active);
        break;
      case 'manualLaunch':
        this.options.onManualLaunchModeChange(active);
        break;
      case 'guard':
        this.options.onGuardModeChange(active);
        break;
      case 'reclaim':
        this.options.onReclaimModeChange(active);
        break;
      case 'capture':
        this.options.onCaptureModeChange(active);
        break;
      case 'resurrect':
        this.options.onResurrectModeChange(active);
        break;
      case 'resurrectArea':
        this.options.onResurrectAreaModeChange(active);
        break;
      case 'loadTransport':
        this.options.onLoadTransportModeChange(active);
        break;
      case 'unloadTransport':
        this.options.onUnloadTransportModeChange(active);
        break;
      case 'mexUpgrade':
        this.options.onMexUpgradeModeChange(active);
        break;
      case 'ping':
        this.options.onPingModeChange(active);
        break;
      case 'towerTarget':
        this.options.onTowerTargetModeChange(active);
        break;
      case 'towerTargetNoGround':
        this.options.onTowerTargetNoGroundModeChange(active);
        break;
    }
  }
}
