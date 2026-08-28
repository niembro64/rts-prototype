/**
 * The app's high-level navigation, as one declared finite state machine.
 *
 * The map follows the shape Beyond All Reason players already know: a HOME
 * screen with the sandbox running behind the menus, a GAME ROOM you enter to
 * play with people (its battle room / seating screen), and the battle itself
 * with an explicit loading phase before play. Here that is three top-level
 * surfaces plus two side rooms:
 *
 *   init          Boot. Modules loading, the sim WASM compiling, nothing on
 *                 screen yet. Exists so "where are we before anyone can
 *                 navigate" has an answer; nothing ever returns here.
 *   home          The demo battle, the lobby directory, and host/join — one
 *                 surface. Whether the menu sidebar is slid open or away is
 *                 CHROME, not navigation: either way you are home, watching
 *                 and tuning the demo. (This surface was previously two
 *                 states, `lobby` and `demoBattle`, split on that sidebar.)
 *   gameRoom      A networked session, in one of three sub-states:
 *                   .lobby            the seating screen — teams, presets,
 *                                     the host deciding who plays
 *                   .battle.loading   handoff received; booting, and for a
 *                                     late joiner replaying the archive
 *                   .battle.playing   the live match
 *                 A solo-hosted real battle enters .battle directly from
 *                 home: same surface, same lockstep, one seat.
 *   entityLab     The inspection lab. No network, no battle.
 *   gameControls  The controls reference — hotkey presets and bindings.
 *   gameInfo      The about page — what the game is, how a match works,
 *                 and where it comes from. Same side-room rules as the
 *                 other two.
 *
 * The StateMachine primitive is flat, so the hierarchy is encoded in the
 * state ids (`gameRoomLobby`, `gameRoomBattleLoading`, ...) and read through
 * the `isGameRoomSurface` / `isBattleSurface` predicates. The declaration
 * below is still the single map: every edge the app has, and nothing else.
 *
 * The asymmetries are the point of writing this down:
 *
 *   - None of the side rooms (lab, controls, info) can start a battle or
 *     enter a game room. A match needs a host or a code, and only home has
 *     either — the road always runs through home.
 *   - Nothing leaves the game room except `exitGameRoom` (and the lobby's
 *     own cancel). Leaving has network consequences — a seat resigns, a host
 *     ejects everyone — so it is an explicit act on the match's own exits:
 *     game over, the LEAVE button, host eviction. Wandering to another
 *     surface mid-match (the `~` lab hotkey included, now ALSO from the
 *     seating screen, where it used to silently disconnect you) is refused
 *     by the table.
 *   - The battle's one road back to the seating screen is `returnToLobby`,
 *     and only the HOST's session-level broadcast fires it: the host ends
 *     the match for the whole room and everyone lands back in the lobby with
 *     their seats intact, ready for a rematch. A client has no control that
 *     sends this — its exits are `exitGameRoom` (home) or being brought
 *     along by the host.
 *
 * Everything undeclared is refused by the machine, which is the safety
 * property: a hotkey mid-match, a second Start, a stale "return to lobby"
 * firing after the player already left — all answered by the table instead
 * of by guards at every call site.
 */

import { ref, type Ref } from 'vue';
import { createStateMachine, type StateMachine } from './game/state/StateMachine';

type AppSurface =
  | 'init'
  | 'home'
  | 'gameRoomLobby'
  | 'gameRoomBattleLoading'
  | 'gameRoomBattlePlaying'
  | 'entityLab'
  | 'gameControls'
  | 'gameInfo';

type AppSurfaceEvent =
  | 'boot'
  | 'openHome'
  | 'openEntityLab'
  | 'openGameControls'
  | 'openGameInfo'
  | 'enterLobby'
  | 'leaveLobby'
  | 'startBattle'
  | 'battleReady'
  | 'returnToLobby'
  | 'exitGameRoom';

/** Any of the game room's sub-states: seating screen or battle. */
export function isGameRoomSurface(surface: AppSurface): boolean {
  return (
    surface === 'gameRoomLobby' ||
    surface === 'gameRoomBattleLoading' ||
    surface === 'gameRoomBattlePlaying'
  );
}

/** The battle sub-tree of the game room (loading or playing). */
export function isBattleSurface(surface: AppSurface): boolean {
  return surface === 'gameRoomBattleLoading' || surface === 'gameRoomBattlePlaying';
}

/** The whole map. Exported so the contract test exercises the real table,
 *  not a copy that can drift. */
export function createAppSurfaceMachine(
  onTransition?: (to: AppSurface) => void,
): StateMachine<AppSurface, AppSurfaceEvent> {
  return createStateMachine<AppSurface, AppSurfaceEvent>({
    name: 'appSurface',
    initial: 'init',
    transitions: {
      init: {
        boot: 'home',
      },
      home: {
        openEntityLab: 'entityLab',
        openGameControls: 'gameControls',
        openGameInfo: 'gameInfo',
        // Hosting or joining lands you in the game room's seating screen...
        enterLobby: 'gameRoomLobby',
        // ...while a solo real battle skips it: no seats to negotiate.
        startBattle: 'gameRoomBattleLoading',
      },
      gameRoomLobby: {
        // Cancel and eviction both come home; two names because they are
        // different intents with different senders, and a table that names
        // them both refuses neither by accident.
        leaveLobby: 'home',
        exitGameRoom: 'home',
        startBattle: 'gameRoomBattleLoading',
      },
      gameRoomBattleLoading: {
        battleReady: 'gameRoomBattlePlaying',
        // The host can call the room back while a late joiner is still
        // loading — the abort lands them in the seating screen, not home.
        returnToLobby: 'gameRoomLobby',
        exitGameRoom: 'home',
      },
      gameRoomBattlePlaying: {
        // The HOST's whole-room rematch signal; clients have no control
        // that sends this, they are brought along by the broadcast.
        returnToLobby: 'gameRoomLobby',
        exitGameRoom: 'home',
      },
      entityLab: {
        openHome: 'home',
        openGameControls: 'gameControls',
        openGameInfo: 'gameInfo',
      },
      gameControls: {
        openHome: 'home',
        openEntityLab: 'entityLab',
        openGameInfo: 'gameInfo',
      },
      gameInfo: {
        openHome: 'home',
        openEntityLab: 'entityLab',
        openGameControls: 'gameControls',
      },
    },
    onTransition: (change) => onTransition?.(change.to),
  });
}

const surfaceRef = ref<AppSurface>('init');
const machine = createAppSurfaceMachine((to) => {
  surfaceRef.value = to;
});

/** The current surface, reactive. Read-only by convention: the only writer
 *  is the machine, and the only way to move the machine is sendAppSurface. */
export const appSurface: Readonly<Ref<AppSurface>> = surfaceRef;

/** Apply a navigation event. Returns false — changing nothing — when the
 *  move is not declared from the current surface; callers use that answer
 *  to skip the side effects they would otherwise have to guard by hand. */
export function sendAppSurface(event: AppSurfaceEvent): boolean {
  return machine.send(event);
}
