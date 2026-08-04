// Team / player identity color contract.
//
// A seat has two identities and every entity shows both: the body wears
// the PLAYER color, the trim wears the TEAM color. The hues nest — the
// wheel splits by team, then a team's slice splits by its own players.
//
// Everything below is asserted as EXACT color identity against the flat
// per-seat wheel rather than by measuring hue off the rendered bytes.
// OKLCH hue is not HSV hue (OKLCH 0 lands near HSV 340), so measuring
// would test the color space, not the nesting. Generating the expected
// color from the same public API at the hue the spec says it should land
// on tests the thing we actually care about, exactly.
import type { PlayerId } from './types';
import {
  getPlayerColors,
  setPlayerCountForColors,
  setTeamLayoutForColors,
} from './types';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[team color contract] ${message}`);
}

function seats(count: number): PlayerId[] {
  const out: PlayerId[] = [];
  for (let i = 1; i <= count; i++) out.push(i as PlayerId);
  return out;
}

/**
 * Colors of an N-seat free-for-all, indexed by hue step. `wheel(N)[k]` is
 * the color at hue k × 360/N — the flat wheel this project has always
 * used, and the reference every nested hue below is checked against.
 */
function wheel(steps: number): { normal: number[]; dark: number[] } {
  setPlayerCountForColors(steps);
  const normal: number[] = [];
  const dark: number[] = [];
  for (let k = 0; k < steps; k++) {
    const colors = getPlayerColors((k + 1) as PlayerId);
    normal.push(colors.primary);
    dark.push(colors.secondary);
  }
  return { normal, dark };
}

export function runTeamColorContractTest(): void {
  try {
    // A 12-step wheel resolves every hue the 2v2v2 case needs: team hues
    // at 0/120/240 are steps 0/4/8, and the four-way sub-slice offsets of
    // +/-30 are steps 1 and 11.
    const w12 = wheel(12);

    const roster = [
      [1, 2] as PlayerId[],
      [3, 4] as PlayerId[],
      [5, 6] as PlayerId[],
    ];
    setTeamLayoutForColors(roster);

    // ── Team color: middle of the team's slice, team 1 red ───────────
    // 3 sides -> slices 120 wide, centres at 0 / 120 / 240.
    const expectedTeamStep = [0, 4, 8];
    for (let side = 0; side < roster.length; side++) {
      const expected = w12.normal[expectedTeamStep[side]];
      const expectedDark = w12.dark[expectedTeamStep[side]];
      for (const seat of roster[side]) {
        const colors = getPlayerColors(seat);
        assertContract(
          colors.colorTeamNormal === expected,
          `side ${side + 1} team color must sit at its slice centre (hue ${side * 120})`,
        );
        assertContract(
          colors.colorTeamDark === expectedDark,
          `side ${side + 1} dark team color must share the team hue`,
        );
      }
    }
    assertContract(
      getPlayerColors(1 as PlayerId).colorTeamNormal === w12.normal[0],
      'team 1 must be the wheel origin — red',
    );
    assertContract(
      getPlayerColors(1 as PlayerId).colorTeamNormal !==
        getPlayerColors(3 as PlayerId).colorTeamNormal,
      'different sides must not share a team color',
    );

    // ── Player color: middle of its sub-slice of the team slice ──────
    // 2 players over a 120 slice -> sub-slices 60 wide, centres at -30
    // and +30 from the team hue. Off team 1 (hue 0) that is 330 and 30,
    // i.e. steps 11 and 1.
    const expectedPlayerStep = [
      [11, 1],  // side 1, team hue 0
      [3, 5],   // side 2, team hue 120
      [7, 9],   // side 3, team hue 240
    ];
    for (let side = 0; side < roster.length; side++) {
      for (let seat = 0; seat < roster[side].length; seat++) {
        const colors = getPlayerColors(roster[side][seat]);
        const step = expectedPlayerStep[side][seat];
        assertContract(
          colors.colorPlayerNormal === w12.normal[step],
          `side ${side + 1} seat ${seat + 1} must sit at its sub-slice centre`,
        );
        assertContract(
          colors.colorPlayerDark === w12.dark[step],
          'the dark player color must share the player hue',
        );
        assertContract(
          colors.primary === colors.colorPlayerNormal &&
            colors.secondary === colors.colorPlayerDark,
          'primary/secondary must stay aliases of the player pair',
        );
      }
    }
    assertContract(
      getPlayerColors(1 as PlayerId).colorPlayerNormal !==
        getPlayerColors(2 as PlayerId).colorPlayerNormal,
      'teammates must not share a player color',
    );
    assertContract(
      getPlayerColors(1 as PlayerId).colorPlayerNormal !==
        getPlayerColors(1 as PlayerId).colorTeamNormal,
      'on a multi-player side the seat color must differ from the team color',
    );

    // ── A one-player side collapses all four colors to two ───────────
    setTeamLayoutForColors(seats(6).map((seat) => [seat]));
    const w6 = { normal: [...wheel(6).normal] };
    setTeamLayoutForColors(seats(6).map((seat) => [seat]));
    for (let k = 0; k < 6; k++) {
      const colors = getPlayerColors((k + 1) as PlayerId);
      assertContract(
        colors.colorPlayerNormal === colors.colorTeamNormal &&
          colors.colorPlayerDark === colors.colorTeamDark,
        'a lone seat on a side has player color == team color',
      );
      assertContract(
        colors.colorPlayerNormal === w6.normal[k],
        'free-for-all must reproduce the flat per-seat wheel exactly',
      );
    }

    // ── Uneven sides still divide their own slice ────────────────────
    // 1/2/2 over three sides: the lone seat lands on its team hue, the
    // paired seats split theirs.
    setTeamLayoutForColors([
      [1] as PlayerId[],
      [2, 3] as PlayerId[],
      [4, 5] as PlayerId[],
    ]);
    const lone = getPlayerColors(1 as PlayerId);
    assertContract(
      lone.colorPlayerNormal === lone.colorTeamNormal,
      'a 1-player side still lands its seat on the team hue',
    );
    assertContract(
      getPlayerColors(2 as PlayerId).colorPlayerNormal !==
        getPlayerColors(3 as PlayerId).colorPlayerNormal,
      'a 2-player side still separates its seats',
    );
    assertContract(
      getPlayerColors(2 as PlayerId).colorTeamNormal ===
        getPlayerColors(3 as PlayerId).colorTeamNormal,
      'a 2-player side still shares one team color',
    );

    // ── An unknown seat never breaks ─────────────────────────────────
    const stranger = getPlayerColors(99 as PlayerId);
    assertContract(
      Number.isFinite(stranger.colorTeamNormal) &&
        Number.isFinite(stranger.colorPlayerNormal),
      'a seat outside the roster must still resolve to real colors',
    );
  } finally {
    // Leave the module the way a fresh boot finds it so this test cannot
    // tint the running battle.
    setPlayerCountForColors(6);
  }
}
