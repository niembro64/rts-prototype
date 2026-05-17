import type { PlayerId } from '../sim/types';

export type CommandAuthority =
  | { mode: 'host-admin' }
  | { mode: 'local-offline'; playerId: PlayerId }
  | { mode: 'player'; playerId: PlayerId }
  | { mode: 'spectator'; playerId?: PlayerId };

export function commandAuthorityPlayerId(
  authority: CommandAuthority,
): PlayerId | undefined {
  return authority.mode === 'player' || authority.mode === 'local-offline'
    ? authority.playerId
    : undefined;
}

export function canApplyServerControlCommand(
  authority: CommandAuthority,
  hostPlayerId: PlayerId,
): boolean {
  switch (authority.mode) {
    case 'host-admin':
    case 'local-offline':
      return true;
    case 'player':
      return authority.playerId === hostPlayerId;
    case 'spectator':
      return false;
  }
}

export function canBypassGameplayOwnership(authority: CommandAuthority): boolean {
  return authority.mode === 'host-admin';
}
