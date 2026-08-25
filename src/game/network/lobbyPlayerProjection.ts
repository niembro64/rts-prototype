import type { LobbyBotSeat, LobbyMember, LobbyPlayer } from '@/types/network';
import { DEFAULT_HUMAN_INITIAL_STATE } from '../sim/agentSeat';
import { FIRST_ALLY_TEAM_ID } from '../sim/teamRoster';

/** Project a connected member into the seated shape consumed by the match. */
export function lobbyMemberToPlayer(member: LobbyMember): LobbyPlayer | null {
  if (member.playerId === undefined) return null;
  return {
    playerId: member.playerId,
    name: member.name,
    isHost: member.isHost,
    allyTeamId: member.allyTeamId ?? FIRST_ALLY_TEAM_ID,
    initialState: member.initialState ?? DEFAULT_HUMAN_INITIAL_STATE,
    ipAddress: member.ipAddress,
    location: member.location,
    timezone: member.timezone,
    localTime: member.localTime,
  };
}

/** Project a connectionless bot seat into the same match-facing shape. */
export function lobbyBotSeatToPlayer(bot: LobbyBotSeat): LobbyPlayer {
  return {
    playerId: bot.playerId,
    name: `BOT ${bot.playerId}`,
    isHost: false,
    isBot: true,
    allyTeamId: bot.allyTeamId,
    initialState: bot.initialState,
    ipAddress: undefined,
    location: undefined,
    timezone: undefined,
    localTime: undefined,
  };
}
