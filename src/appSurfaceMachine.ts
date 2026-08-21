/**
 * The app's high-level navigation, as one declared finite state machine.
 *
 * BUDGET ANNIHILATION has exactly five surfaces a player can be on, and not
 * every pair of them is connected. Before this machine existed the surface
 * was smeared across an `activeSurface` ref in App.vue, a `menuHidden` flag
 * in the canvas chrome, and the network session's own lifecycle — which is
 * how the entity lab grew an "Online Game" button that teleported past the
 * lobby, and how the `~` hotkey could yank a seated player out of a live
 * match (unmounting GameCanvas disconnects the network) without so much as a
 * prompt. Both of those are simply transitions nobody meant to declare.
 *
 * The states:
 *
 *   init        Boot. Modules loading, the sim WASM compiling, nothing on
 *               screen yet. Exists so "where are we before anyone can
 *               navigate" has an answer; nothing ever returns here.
 *   lobby       The menu. Host/join/browse in the sidebar, and — after
 *               hosting or joining — the seating screen for a networked
 *               match. The demo battle plays behind it, but that is a
 *               backdrop, not a state: the MENU is what you are on.
 *   demoBattle  The demo sandbox as the primary surface: menu slid away,
 *               BATTLE bar live, the demo yours to tune and watch.
 *   onlineGame  A real networked match, from battle handoff until you leave
 *               or it ends. (A solo-hosted real battle counts: it is the
 *               same surface, the same lockstep, one seat.)
 *   entityLab   The inspection lab. No network, no battle.
 *
 * The shape of the map is a hub: LOBBY is the only state connected to
 * everything, because it is the only place every flow can regroup. The two
 * asymmetries are the point of writing this down:
 *
 *   - The lab cannot start an online game. A match needs a host or a code,
 *     and the lab has neither — the road runs lab -> lobby -> host/join.
 *   - Nothing leaves an online game except the one exit to the lobby.
 *     Leaving a match has network consequences (your seat resigns, a host
 *     ejects everyone), so it is an explicit act on the match's own exits —
 *     game over, the LEAVE button, host eviction — never a side effect of
 *     wandering to another surface.
 *
 * Everything undeclared is refused by the machine, which is the safety
 * property: the hotkey mid-match, a second Start, a stale "return to lobby"
 * firing after the player already left — all answered by the table instead
 * of by guards at every call site.
 */

import { ref, type Ref } from 'vue';
import { createStateMachine, type StateMachine } from './game/state/StateMachine';

export type AppSurface = 'init' | 'lobby' | 'demoBattle' | 'onlineGame' | 'entityLab';

export type AppSurfaceEvent =
  | 'boot'
  | 'openMenu'
  | 'closeMenu'
  | 'openEntityLab'
  | 'openLobby'
  | 'openDemoBattle'
  | 'startOnlineGame'
  | 'exitOnlineGame';

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
        boot: 'lobby',
      },
      lobby: {
        closeMenu: 'demoBattle',
        openEntityLab: 'entityLab',
        startOnlineGame: 'onlineGame',
      },
      demoBattle: {
        openMenu: 'lobby',
        openEntityLab: 'entityLab',
      },
      onlineGame: {
        exitOnlineGame: 'lobby',
      },
      entityLab: {
        openLobby: 'lobby',
        openDemoBattle: 'demoBattle',
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

export function getAppSurface(): AppSurface {
  return machine.state;
}
