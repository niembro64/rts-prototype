/** Shared query/exit contract for input controllers that consume commander
 * command modes. Keeping the pairings here prevents keyboard and pointer
 * routing from drifting as modes are added. */
export type Input3DCommandModeControls = {
  isRepairAreaMode: () => boolean;
  isRestoreAreaMode: () => boolean;
  isAttackMode: () => boolean;
  isAttackAreaMode: () => boolean;
  isAttackGroundMode: () => boolean;
  isManualLaunchMode: () => boolean;
  isGuardMode: () => boolean;
  isReclaimMode: () => boolean;
  isCaptureMode: () => boolean;
  isResurrectMode: () => boolean;
  isResurrectAreaMode: () => boolean;
  isLoadTransportMode: () => boolean;
  isUnloadTransportMode: () => boolean;
  isMexUpgradeMode: () => boolean;
  isPingMode: () => boolean;
  isTowerTargetMode: () => boolean;
  isTowerTargetNoGroundMode: () => boolean;
  exitRepairAreaMode: () => void;
  exitRestoreAreaMode: () => void;
  exitAttackMode: () => void;
  exitAttackAreaMode: () => void;
  exitAttackGroundMode: () => void;
  exitManualLaunchMode: () => void;
  exitGuardMode: () => void;
  exitReclaimMode: () => void;
  exitCaptureMode: () => void;
  exitResurrectMode: () => void;
  exitResurrectAreaMode: () => void;
  exitLoadTransportMode: () => void;
  exitUnloadTransportMode: () => void;
  exitMexUpgradeMode: () => void;
  exitPingMode: () => void;
  exitTowerTargetMode: () => void;
  exitTowerTargetNoGroundMode: () => void;
};
