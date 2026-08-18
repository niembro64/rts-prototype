import type {
  BuildingAimPieceTurretHostAttachment,
  BuildingTurretHostAttachment,
  BuildingYawPieceTurretHostAttachment,
  TurretHostAttachment,
} from '@/types/blueprints';

type BuildingHostTurretAttachmentSource = {
  mountIndex: number;
  config: {
    hostAttachment: TurretHostAttachment | null;
    articulation: {
      claimGroup: string | null;
      claimPriority: number;
    };
  };
};

export function isBuildingYawPieceAttachment(
  attachment: TurretHostAttachment | null,
): attachment is BuildingYawPieceTurretHostAttachment {
  return attachment?.kind === 'buildingYawPiece';
}

export function isBuildingAimPieceAttachment(
  attachment: TurretHostAttachment | null,
): attachment is BuildingAimPieceTurretHostAttachment {
  return attachment?.kind === 'buildingAimPiece';
}

export function isBuildingHostPieceAttachment(
  attachment: TurretHostAttachment | null,
): attachment is BuildingTurretHostAttachment {
  return isBuildingYawPieceAttachment(attachment) || isBuildingAimPieceAttachment(attachment);
}

/**
 * Choose the stable turret row that stores one building yaw-piece's
 * authoritative motor state. Target ownership is resolved separately each
 * tick; the state row must remain stable even when the active claimant changes.
 */
export function selectBuildingHostPieceTurretIndex(
  turrets: readonly BuildingHostTurretAttachmentSource[],
  piece: string,
): number {
  let fallback = -1;
  let selected = -1;
  let selectedPriority = Number.NEGATIVE_INFINITY;
  let selectedMountIndex = Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < turrets.length; i++) {
    const turret = turrets[i];
    const attachment = turret.config.hostAttachment;
    if (!isBuildingHostPieceAttachment(attachment) || attachment.piece !== piece) continue;
    if (fallback < 0) fallback = i;
    const priority = turret.config.articulation.claimPriority;
    if (priority < selectedPriority) continue;
    if (priority === selectedPriority && turret.mountIndex >= selectedMountIndex) continue;
    selected = i;
    selectedPriority = priority;
    selectedMountIndex = turret.mountIndex;
  }
  return selected >= 0 ? selected : fallback;
}


export function selectBuildingYawPieceTurretIndex(
  turrets: readonly BuildingHostTurretAttachmentSource[],
  piece: string,
): number {
  return selectBuildingHostPieceTurretIndex(turrets, piece);
}

export function buildingYawPieceAttachmentsMatch(
  left: TurretHostAttachment | null,
  right: TurretHostAttachment | null,
): boolean {
  return isBuildingYawPieceAttachment(left) &&
    isBuildingYawPieceAttachment(right) &&
    left.piece === right.piece;
}


export function buildingHostPieceAttachmentsMatch(
  left: TurretHostAttachment | null,
  right: TurretHostAttachment | null,
): boolean {
  return isBuildingHostPieceAttachment(left) &&
    isBuildingHostPieceAttachment(right) &&
    left.kind === right.kind &&
    left.piece === right.piece;
}
