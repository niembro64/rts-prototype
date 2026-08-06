// Player / team / ally team contract.
//
// The three ownership levels are copied from BAR (see
// budget_design_philosophy.html). This pins the two facts every other
// system depends on:
//
//   1. A side is a contiguous block of lobby seats, and alliances are
//      derived from that assignment rather than declared separately, so
//      "A is allied to B" can never disagree with "A and B are on the
//      same side".
//   2. Terrain dividers carve one slice per SIDE, and a side's seats split
//      that slice evenly — teammates share a frontage instead of being
//      separated by a ridge.
import type { PlayerId } from './types';
import {
  buildAlliesByPlayer,
  buildFreeForAllRoster,
  buildTeamRoster,
  buildTeamRosterFromSeatCounts,
  getAllyTeamId,
  getAllyTeamMembers,
  resolveTeamRoster,
} from './teamRoster';
import {
  getAllyTeamBaseAngle,
  getAllyTeamBuildArcAngle,
  getSeatBaseAngle,
  getTerrainDividerTeamCount,
} from './playerLayout';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[team roster contract] ${message}`);
}

function assertNear(actual: number, expected: number, message: string): void {
  if (Math.abs(actual - expected) > 1e-9) {
    throw new Error(`[team roster contract] ${message}: expected ${expected}, got ${actual}`);
  }
}

function seats(count: number): PlayerId[] {
  const out: PlayerId[] = [];
  for (let i = 1; i <= count; i++) out.push(i as PlayerId);
  return out;
}

export function runTeamRosterContractTest(): void {
  // ── 2v2v2: the demo default ────────────────────────────────────────
  const roster = buildTeamRoster(seats(6), 3);
  assertContract(roster.allyTeamIds.length === 3, 'six seats over three sides is three sides');
  assertContract(
    getAllyTeamId(roster, 1 as PlayerId) === getAllyTeamId(roster, 2 as PlayerId) &&
      getAllyTeamId(roster, 3 as PlayerId) === getAllyTeamId(roster, 4 as PlayerId) &&
      getAllyTeamId(roster, 5 as PlayerId) === getAllyTeamId(roster, 6 as PlayerId),
    'sides take contiguous lobby seats',
  );
  assertContract(
    getAllyTeamId(roster, 2 as PlayerId) !== getAllyTeamId(roster, 3 as PlayerId),
    'seats 2 and 3 are on different sides',
  );
  for (const id of roster.allyTeamIds) {
    assertContract(
      (roster.playersByAllyTeam.get(id) ?? []).length === 2,
      'a 6/3 split gives every side two seats',
    );
  }

  // Alliances are the roster, not a second declaration.
  const allies = buildAlliesByPlayer(roster);
  assertContract(
    allies.get(1 as PlayerId)?.has(2 as PlayerId) === true &&
      allies.get(2 as PlayerId)?.has(1 as PlayerId) === true,
    'teammates are mutually allied',
  );
  assertContract(
    allies.get(1 as PlayerId)?.has(1 as PlayerId) !== true,
    'a seat is implicitly self-allied and never lists itself',
  );
  assertContract(
    allies.get(1 as PlayerId)?.has(3 as PlayerId) !== true,
    'seats on different sides are not allied',
  );
  for (const playerId of roster.playerIds) {
    for (const member of getAllyTeamMembers(roster, playerId)) {
      assertContract(
        getAllyTeamId(roster, member) === getAllyTeamId(roster, playerId),
        'every member of a side reports that side',
      );
    }
  }

  // ── Slices are per SIDE, and a side's seats split one slice ────────
  assertContract(
    getTerrainDividerTeamCount(roster.allyTeamIds.length) === 3,
    'a 2v2v2 carves three divider slices, not six',
  );
  const sliceArc = getAllyTeamBuildArcAngle(3, 1);
  const cycle = (Math.PI * 2) / 3;
  for (let side = 0; side < 3; side++) {
    const members = roster.playersByAllyTeam.get(roster.allyTeamIds[side]) ?? [];
    const center = getAllyTeamBaseAngle(side, 3);
    const angles = members.map((id) => getSeatBaseAngle(roster, id));
    // Teammates straddle their slice centre symmetrically...
    assertNear(
      (angles[0] + angles[1]) / 2,
      center,
      'teammates are centred on their own slice',
    );
    // ...and stay inside the slice, never in the divider ridge beside it.
    for (const angle of angles) {
      assertContract(
        Math.abs(angle - center) <= sliceArc * 0.5 + 1e-9,
        'a seat never spills out of its side slice into the divider',
      );
    }
    assertContract(
      Math.abs(angles[1] - angles[0]) > 1e-6,
      'teammates do not stack on one point',
    );
    if (side > 0) {
      assertNear(
        getAllyTeamBaseAngle(side, 3) - getAllyTeamBaseAngle(side - 1, 3),
        cycle,
        'slice centres are evenly spaced around the map',
      );
    }
  }

  // ── Free-for-all is the same code path, not a special case ─────────
  const ffa = buildFreeForAllRoster(seats(6));
  assertContract(ffa.allyTeamIds.length === 6, 'FFA gives every seat its own side');
  for (let i = 0; i < 6; i++) {
    assertNear(
      getSeatBaseAngle(ffa, ffa.playerIds[i]),
      getAllyTeamBaseAngle(i, 6),
      'a lone seat sits exactly on its slice centre, as it did before teams',
    );
  }
  const solo = buildTeamRoster(seats(1), 1);
  assertNear(
    getSeatBaseAngle(solo, solo.playerIds[0]),
    getAllyTeamBaseAngle(0, 1),
    'one player is one seat on one slice, no special case',
  );

  // ── Degenerate rosters clamp instead of throwing ───────────────────
  assertContract(buildTeamRoster(seats(4), 0).allyTeamIds.length === 1, 'zero sides clamps to one');
  assertContract(
    buildTeamRoster(seats(2), 99).allyTeamIds.length === 2,
    'more sides than seats clamps to the seat count',
  );
  assertContract(
    buildTeamRoster([], 3).playerIds.length === 1,
    'an empty roster still yields one playable seat',
  );

  // Uneven splits stay total and stable: 5 seats over 3 sides is 1/2/2.
  const uneven = buildTeamRoster(seats(5), 3);
  const sizes = uneven.allyTeamIds.map((id) => (uneven.playersByAllyTeam.get(id) ?? []).length);
  assertContract(
    sizes.join(',') === '1,2,2',
    `uneven split must be 1,2,2 — got ${sizes.join(',')}`,
  );
  assertContract(
    sizes.reduce((a, b) => a + b, 0) === 5,
    'every seat lands on exactly one side',
  );

  checkSeatCountRosters();
}

/**
 * SEATS PER SIDE — the form that can declare an EMPTY side.
 *
 * This is the only builder whose side count does not come from the seats
 * themselves, and that is the whole point: a zero entry still carves that
 * side's terrain slice, deposit phase and spawn arc, and leaves the ground
 * unoccupied. Deriving sides from seats can express "nobody is here" only by
 * shrinking the map.
 */
function checkSeatCountRosters(): void {
  const evenly = buildTeamRosterFromSeatCounts(seats(6), [2, 2, 2]);
  assertContract(
    evenly.allyTeamIds.length === 3 &&
      evenly.allyTeamIds.every(
        (id) => (evenly.playersByAllyTeam.get(id) ?? []).length === 2,
      ),
    '[2,2,2] over six seats is a 2v2v2',
  );
  assertContract(
    getAllyTeamId(evenly, 1 as PlayerId) === getAllyTeamId(evenly, 2 as PlayerId) &&
      getAllyTeamId(evenly, 2 as PlayerId) !== getAllyTeamId(evenly, 3 as PlayerId),
    'seats fill the sides in lobby order',
  );

  // THE EMPTY SIDE. Five seats declared as [0, 1, 4]: three sides exist, the
  // first has nobody, and every seat still lands on exactly one of them.
  const withEmpty = buildTeamRosterFromSeatCounts(seats(5), [0, 1, 4]);
  const withEmptySizes = withEmpty.allyTeamIds.map(
    (id) => (withEmpty.playersByAllyTeam.get(id) ?? []).length,
  );
  assertContract(
    withEmptySizes.join(',') === '0,1,4',
    `[0,1,4] must seat 0,1,4 — got ${withEmptySizes.join(',')}`,
  );
  assertContract(
    withEmpty.allyTeamIds.length === 3,
    'an empty side still exists, so the map is still carved into three slices',
  );
  assertContract(
    withEmpty.allyTeamByPlayer.size === 5,
    'every declared seat is assigned even when a side is empty',
  );
  assertContract(
    getAllyTeamId(withEmpty, 1 as PlayerId) === withEmpty.allyTeamIds[1],
    'the first seat skips the empty side rather than filling it',
  );

  // Counts that disagree with the seat list must not lose a player: the last
  // side sweeps up the remainder. Losing a seat silently loses a commander.
  const under = buildTeamRosterFromSeatCounts(seats(5), [1, 1]);
  assertContract(
    under.allyTeamByPlayer.size === 5 && under.allyTeamIds.length === 2,
    'under-counted sides still seat every player on the declared sides',
  );
  // ...and counts larger than the seat list simply run out, leaving the
  // trailing sides empty rather than inventing seats.
  const over = buildTeamRosterFromSeatCounts(seats(2), [1, 1, 4]);
  assertContract(
    over.allyTeamIds.length === 3 && over.allyTeamByPlayer.size === 2,
    'over-counted sides run out of seats instead of inventing them',
  );

  // Precedence: an explicit per-seat lobby assignment still wins, because a
  // player who moved themselves between sides must not be overridden by a
  // config-authored shape.
  const assigned = resolveTeamRoster(seats(4), {
    allyTeamSeats: [2, 2],
    allyTeamByPlayerId: { 1: 1, 2: 1, 3: 1, 4: 1 },
  });
  assertContract(
    assigned.allyTeamIds.length === 1,
    'an explicit per-seat assignment outranks a seats-per-side list',
  );
  assertContract(
    resolveTeamRoster(seats(4), { allyTeamSeats: [1, 3], allyTeamCount: 2 })
      .allyTeamIds.map((id) => (
        resolveTeamRoster(seats(4), { allyTeamSeats: [1, 3], allyTeamCount: 2 })
          .playersByAllyTeam.get(id) ?? []
      ).length).join(',') === '1,3',
    'a seats-per-side list outranks a plain side count',
  );
}
