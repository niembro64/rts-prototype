export type Input3DSpecialMode =
  | 'repairArea'
  | 'formationMove'
  | 'attack'
  | 'attackArea'
  | 'attackGround'
  | 'guard'
  | 'reclaim'
  | 'ping'
  | 'towerTarget';

type Input3DSpecialModeCallbacks = {
  onRepairAreaModeChange: (active: boolean) => void;
  onFormationMoveModeChange: (active: boolean) => void;
  onAttackModeChange: (active: boolean) => void;
  onAttackAreaModeChange: (active: boolean) => void;
  onAttackGroundModeChange: (active: boolean) => void;
  onGuardModeChange: (active: boolean) => void;
  onReclaimModeChange: (active: boolean) => void;
  onPingModeChange: (active: boolean) => void;
  onTowerTargetModeChange: (active: boolean) => void;
};

type Input3DSpecialModesOptions = Input3DSpecialModeCallbacks & {
  refreshCursor: () => void;
};

const SPECIAL_MODE_ORDER: readonly Input3DSpecialMode[] = [
  'repairArea',
  'formationMove',
  'attack',
  'attackArea',
  'attackGround',
  'guard',
  'reclaim',
  'ping',
  'towerTarget',
];

export class Input3DSpecialModes {
  private active: Record<Input3DSpecialMode, boolean> = {
    repairArea: false,
    formationMove: false,
    attack: false,
    attackArea: false,
    attackGround: false,
    guard: false,
    reclaim: false,
    ping: false,
    towerTarget: false,
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
      if (!includeTowerTarget && mode === 'towerTarget') continue;
      this.exit(mode);
    }
  }

  private notify(mode: Input3DSpecialMode, active: boolean): void {
    switch (mode) {
      case 'repairArea':
        this.options.onRepairAreaModeChange(active);
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
      case 'guard':
        this.options.onGuardModeChange(active);
        break;
      case 'reclaim':
        this.options.onReclaimModeChange(active);
        break;
      case 'ping':
        this.options.onPingModeChange(active);
        break;
      case 'towerTarget':
        this.options.onTowerTargetModeChange(active);
        break;
    }
  }
}
