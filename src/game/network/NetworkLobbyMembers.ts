/**
 * Who is attached to a session, and which of them hold seats.
 *
 * Two id spaces live here on purpose (see budget_design_philosophy.html,
 * "Player, team, ally team"):
 *
 *   MEMBER  one connection. Everyone who joins is one, spectators included.
 *           Members address connections, chat, and the roster UI.
 *   SEAT    a PlayerId in the match. Only seated members hold one. Seats
 *           address the simulation: commands, ownership, ally teams, and the
 *           lockstep frame-completion set.
 *
 * Keeping them apart is what makes "a spectator can never stall the match" a
 * structural fact rather than a rule someone has to remember: a spectator has
 * no seat, so it cannot appear in the completion set at all.
 *
 * The HOST is the only writer. A user joins as a spectator and the host moves
 * them onto a team; nobody seats themselves. Clients receive the whole member
 * list atomically and replace theirs, because merging partial roster deltas is
 * exactly how two clients came to disagree about where the same player sat.
 */

import {
  getDefaultPlayerName,
  getInitialLocalUsername,
  MAX_NAME_LENGTH,
} from '@/playerNamesConfig';
import type { PlayerId } from '../sim/types';
import { FIRST_ALLY_TEAM_ID } from '../sim/teamRoster';
import { formatBrowserClockTime, getBrowserTimezone } from '../browserLocale';
import type {
  LobbyMember,
  LobbyMemberInfoPayload,
  LobbyMemberRole,
  LobbyPlayer,
  MemberId,
  SeatToken,
} from '@/types/network';
import { MAX_LOBBY_PLAYERS, MAX_LOBBY_SPECTATORS } from './LobbyDirectory';

/** The host is always member 1 and, in the lobby it created, seat 1. */
export const HOST_MEMBER_ID: MemberId = 1;

/** Every connection a session can hold at once — seats plus benches. */
export const MAX_LOBBY_MEMBERS = MAX_LOBBY_PLAYERS + MAX_LOBBY_SPECTATORS;

export type SeatGrantRefusal =
  | 'not-a-member'
  | 'already-seated'
  | 'no-free-seat';

export type SeatGrant =
  | { readonly seated: true; readonly member: LobbyMember }
  | { readonly seated: false; readonly reason: SeatGrantRefusal };

function randomToken(): SeatToken {
  // Long enough that guessing another player's seat is not a thing anyone
  // does by accident. This is a session handle, not a credential.
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

export function createLobbyMember(
  memberId: MemberId,
  name: string,
  isHost: boolean,
): LobbyMember {
  return {
    memberId,
    role: 'spectator',
    playerId: undefined,
    allyTeamId: undefined,
    name,
    isHost,
    awaitingRejoin: false,
    ipAddress: undefined,
    location: undefined,
    timezone: undefined,
    localTime: undefined,
  };
}

/** The seated projection a member presents to the match. */
export function toLobbyPlayer(member: LobbyMember): LobbyPlayer | null {
  if (member.playerId === undefined) return null;
  return {
    playerId: member.playerId,
    name: member.name,
    isHost: member.isHost,
    allyTeamId: member.allyTeamId ?? FIRST_ALLY_TEAM_ID,
    ipAddress: member.ipAddress,
    location: member.location,
    timezone: member.timezone,
    localTime: member.localTime,
  };
}

export class NetworkLobbyMembers {
  private readonly members = new Map<MemberId, LobbyMember>();
  /** Seat -> the token that reclaims it. Host-side only; never broadcast in
   *  the roster, only handed to the one member that owns the seat. */
  private readonly seatTokens = new Map<PlayerId, SeatToken>();

  clear(): void {
    this.members.clear();
    this.seatTokens.clear();
  }

  get size(): number {
    return this.members.size;
  }

  get(memberId: MemberId): LobbyMember | undefined {
    return this.members.get(memberId);
  }

  values(): IterableIterator<LobbyMember> {
    return this.members.values();
  }

  set(member: LobbyMember): LobbyMember {
    const copy = { ...member };
    this.members.set(copy.memberId, copy);
    return copy;
  }

  delete(memberId: MemberId): LobbyMember | undefined {
    const member = this.members.get(memberId);
    if (member === undefined) return undefined;
    this.members.delete(memberId);
    return member;
  }

  toArray(): LobbyMember[] {
    const out = new Array<LobbyMember>(this.members.size);
    let index = 0;
    for (const member of this.members.values()) out[index++] = { ...member };
    out.sort((a, b) => a.memberId - b.memberId);
    return out;
  }

  /** Every seated member, ordered by seat, as the match sees them. */
  seatedPlayers(): LobbyPlayer[] {
    const out: LobbyPlayer[] = [];
    for (const member of this.members.values()) {
      const player = toLobbyPlayer(member);
      if (player !== null) out.push(player);
    }
    out.sort((a, b) => a.playerId - b.playerId);
    return out;
  }

  seatedPlayerIds(): PlayerId[] {
    return this.seatedPlayers().map((player) => player.playerId);
  }

  spectatorCount(): number {
    let count = 0;
    for (const member of this.members.values()) {
      if (member.role === 'spectator') count++;
    }
    return count;
  }

  memberForSeat(playerId: PlayerId): LobbyMember | undefined {
    for (const member of this.members.values()) {
      if (member.playerId === playerId) return member;
    }
    return undefined;
  }

  // ── Admission ──────────────────────────────────────────────────────────

  /** The lowest free member id, or null when the session is full. Ids are
   *  reused once a member leaves: a counter that only ever went up meant five
   *  joins and five leaves permanently jammed a two-person lobby. */
  nextFreeMemberId(): MemberId | null {
    for (let id = HOST_MEMBER_ID; id <= MAX_LOBBY_MEMBERS; id++) {
      if (!this.members.has(id)) return id;
    }
    return null;
  }

  /** Whether one more spectator would exceed the bench. Seated members are
   *  counted separately, against the seat table. */
  canAdmitSpectator(): boolean {
    return this.spectatorCount() < MAX_LOBBY_SPECTATORS;
  }

  admit(memberId: MemberId, name: string, isHost = false): LobbyMember {
    return this.set(createLobbyMember(memberId, name, isHost));
  }

  // ── Seating (host only) ────────────────────────────────────────────────

  private lowestFreeSeat(): PlayerId | null {
    const taken = new Set<PlayerId>();
    for (const member of this.members.values()) {
      if (member.playerId !== undefined) taken.add(member.playerId);
    }
    for (let seat = 1; seat <= MAX_LOBBY_PLAYERS; seat++) {
      if (!taken.has(seat as PlayerId)) return seat as PlayerId;
    }
    return null;
  }

  /**
   * The side a newly seated member should land on: the emptiest of
   * `sideCount`, ties going to the lowest id. That is how a lobby fills
   * without anyone touching a control, and it keeps a 2v2v2 balanced.
   *
   * Counts seats, not members — an empty declared side is still the emptiest.
   */
  emptiestAllyTeam(sideCount: number): number {
    const sides = Math.max(1, Math.floor(sideCount) || 1);
    const counts = new Array<number>(sides).fill(0);
    for (const member of this.members.values()) {
      if (member.allyTeamId === undefined) continue;
      const index = member.allyTeamId - FIRST_ALLY_TEAM_ID;
      if (index >= 0 && index < sides) counts[index]++;
    }
    let best = 0;
    for (let i = 1; i < sides; i++) {
      if (counts[i] < counts[best]) best = i;
    }
    return FIRST_ALLY_TEAM_ID + best;
  }

  /** Put a spectator on a team. The seat is the lowest free one, the side is
   *  the emptiest, and a seat token is minted so the member can come back to
   *  this exact seat after a disconnect. */
  seat(memberId: MemberId, sideCount: number, preferredAllyTeamId?: number): SeatGrant {
    const member = this.members.get(memberId);
    if (member === undefined) return { seated: false, reason: 'not-a-member' };
    if (member.playerId !== undefined) return { seated: false, reason: 'already-seated' };
    const seat = this.lowestFreeSeat();
    if (seat === null) return { seated: false, reason: 'no-free-seat' };

    member.role = 'player';
    member.playerId = seat;
    member.allyTeamId = this.clampSide(
      preferredAllyTeamId ?? this.emptiestAllyTeam(sideCount),
      sideCount,
    );
    member.awaitingRejoin = false;
    this.seatTokens.set(seat, randomToken());
    return { seated: true, member };
  }

  /** Take a member's seat away and put them back on the bench. Refused for a
   *  member that holds none, so a double-click is a no-op rather than a
   *  roster edit. */
  unseat(memberId: MemberId): boolean {
    const member = this.members.get(memberId);
    if (member === undefined || member.playerId === undefined) return false;
    this.seatTokens.delete(member.playerId);
    member.role = 'spectator';
    member.playerId = undefined;
    member.allyTeamId = undefined;
    member.awaitingRejoin = false;
    return true;
  }

  /** Seat the host in its own lobby: member 1, seat 1, TEAM 1. */
  seedHost(): LobbyMember {
    const member = this.admit(HOST_MEMBER_ID, getInitialLocalUsername(), true);
    member.role = 'player';
    member.playerId = 1 as PlayerId;
    member.allyTeamId = FIRST_ALLY_TEAM_ID;
    this.seatTokens.set(1 as PlayerId, randomToken());
    return member;
  }

  seatTokenFor(playerId: PlayerId): SeatToken | undefined {
    return this.seatTokens.get(playerId);
  }

  /** The seat a presented token owns, or null. Used at admission so a
   *  returning player reclaims their army instead of arriving as a stranger. */
  seatForToken(token: SeatToken | undefined): PlayerId | null {
    if (typeof token !== 'string' || token.length === 0) return null;
    for (const [playerId, stored] of this.seatTokens) {
      if (stored === token) return playerId;
    }
    return null;
  }

  /** Hand a reserved seat to a returning connection. The side, the army and
   *  the token are all unchanged — only which socket answers for them. */
  reclaimSeat(memberId: MemberId, playerId: PlayerId): boolean {
    const member = this.members.get(memberId);
    if (member === undefined) return false;
    const holder = this.memberForSeat(playerId);
    if (holder !== undefined && holder.memberId !== memberId) {
      // Somebody is still attached to that seat. A token cannot evict them.
      if (!holder.awaitingRejoin) return false;
      this.members.delete(holder.memberId);
      member.allyTeamId = holder.allyTeamId;
      member.name = holder.name;
    }
    member.role = 'player';
    member.playerId = playerId;
    if (member.allyTeamId === undefined) member.allyTeamId = FIRST_ALLY_TEAM_ID;
    member.awaitingRejoin = false;
    return true;
  }

  /** Mark a seated member as gone-but-expected. Its seat stays reserved and
   *  its units keep their orders: the simulation is never told anyone left. */
  markAwaitingRejoin(memberId: MemberId): boolean {
    const member = this.members.get(memberId);
    if (member === undefined || member.playerId === undefined) return false;
    if (member.awaitingRejoin) return false;
    member.awaitingRejoin = true;
    return true;
  }

  setAllyTeam(memberId: MemberId, allyTeamId: number, sideCount: number): boolean {
    const member = this.members.get(memberId);
    if (member === undefined || member.playerId === undefined) return false;
    const next = this.clampSide(allyTeamId, sideCount);
    if (member.allyTeamId === next) return false;
    member.allyTeamId = next;
    return true;
  }

  /** Pull every seat back inside a shrunken side count. */
  reseatOutOfRangeSides(sideCount: number): boolean {
    let changed = false;
    for (const member of this.members.values()) {
      if (member.playerId === undefined || member.allyTeamId === undefined) continue;
      if (member.allyTeamId - FIRST_ALLY_TEAM_ID < sideCount) continue;
      member.allyTeamId = this.emptiestAllyTeam(sideCount);
      changed = true;
    }
    return changed;
  }

  private clampSide(allyTeamId: number, sideCount: number): number {
    const sides = Math.max(1, Math.floor(sideCount) || 1);
    if (!Number.isFinite(allyTeamId)) return FIRST_ALLY_TEAM_ID;
    const id = Math.floor(allyTeamId);
    if (id < FIRST_ALLY_TEAM_ID || id >= FIRST_ALLY_TEAM_ID + sides) {
      return FIRST_ALLY_TEAM_ID;
    }
    return id;
  }

  // ── Self-reported info ─────────────────────────────────────────────────

  /** Apply what a member said about ITSELF. Role, seat and side are absent
   *  from the payload by construction, so there is no rule to remember: a
   *  client cannot seat itself because it has no way to ask. */
  applyMemberInfo(memberId: MemberId, info: LobbyMemberInfoPayload): boolean {
    const member = this.members.get(memberId);
    if (member === undefined) return false;
    let changed = false;
    const setIfChanged = <K extends keyof LobbyMember>(
      key: K,
      value: LobbyMember[K] | undefined,
    ): void => {
      if (value === undefined || member[key] === value) return;
      member[key] = value;
      changed = true;
    };
    setIfChanged('ipAddress', info.ipAddress);
    setIfChanged('location', info.location);
    setIfChanged('timezone', info.timezone);
    setIfChanged('localTime', info.localTime);
    if (info.name !== undefined) {
      const trimmed = info.name.trim().slice(0, MAX_NAME_LENGTH);
      if (trimmed.length > 0 && member.name !== trimmed) {
        member.name = trimmed;
        changed = true;
      }
    }
    return changed;
  }

  buildLocalMemberInfo(localMemberId: MemberId): LobbyMemberInfoPayload {
    const self = this.members.get(localMemberId);
    const timezone = self !== undefined && self.timezone
      ? self.timezone
      : getBrowserTimezone();
    return {
      name: self !== undefined ? self.name : getInitialLocalUsername(),
      ipAddress: self !== undefined ? self.ipAddress : undefined,
      location: self !== undefined ? self.location : undefined,
      timezone: timezone || undefined,
      localTime: timezone ? formatBrowserClockTime(timezone) : undefined,
    };
  }

  buildReportedLocalMemberInfo(
    ipAddress: string | undefined,
    location: string | undefined,
    timezone: string | undefined,
  ): LobbyMemberInfoPayload {
    const resolvedTimezone = timezone || getBrowserTimezone();
    return {
      ipAddress,
      location,
      timezone,
      localTime: resolvedTimezone ? formatBrowserClockTime(resolvedTimezone) : undefined,
      name: getInitialLocalUsername(),
    };
  }

  refreshLocalMemberInfo(localMemberId: MemberId): boolean {
    return this.applyMemberInfo(localMemberId, this.buildLocalMemberInfo(localMemberId));
  }

  getLocalMemberName(localMemberId: MemberId): string {
    const member = this.members.get(localMemberId);
    return member !== undefined ? member.name : getDefaultPlayerName(localMemberId as PlayerId);
  }

  // ── Adoption (clients) ─────────────────────────────────────────────────

  /** Replace the whole roster with the host's announcement. Atomic by design:
   *  there is no field-by-field merge to get wrong, and no ordering between
   *  two announcements that can leave a client showing a stale seat. */
  replaceAll(members: readonly LobbyMember[]): void {
    this.members.clear();
    for (const member of members) {
      if (!Number.isInteger(member.memberId)) continue;
      this.members.set(member.memberId, { ...member });
    }
  }

  /** Seat -> side, for handing this lobby's roster to the sim. */
  allyTeamByPlayerId(): Record<number, number> {
    const out: Record<number, number> = {};
    for (const member of this.members.values()) {
      if (member.playerId === undefined) continue;
      out[member.playerId] = member.allyTeamId ?? FIRST_ALLY_TEAM_ID;
    }
    return out;
  }
}

export type { LobbyMember, LobbyMemberRole, MemberId, SeatToken };
