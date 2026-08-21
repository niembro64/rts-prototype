/**
 * The navigation guarantees the app shell leans on: the lab cannot start an
 * online game, nothing leaves an online game except its one exit to the
 * lobby, and the lobby is the hub every flow regroups through. Drives a
 * fresh machine built from the real table, so the live singleton is never
 * disturbed and the table cannot drift from what is tested.
 */

import { createAppSurfaceMachine } from './appSurfaceMachine';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[app-surface] ${message}`);
}

export function runAppSurfaceMachineContractTest(): void {
  const machine = createAppSurfaceMachine();

  // Boot is the only road out of init, and nothing returns there.
  assert(machine.state === 'init', 'the app starts in init');
  assert(machine.send('openEntityLab') === false, 'nothing navigates before boot');
  assert(machine.send('startOnlineGame') === false, 'no match can start before boot');
  assert(machine.send('boot') === true, 'boot lands in the lobby');
  assert(machine.state === 'lobby', 'the lobby is the post-boot surface');
  assert(machine.send('boot') === false, 'boot fires once; a remount cannot re-boot');

  // Lobby <-> demo battle is the menu sliding away and back.
  assert(machine.send('closeMenu') === true, 'closing the menu enters the demo battle');
  assert(machine.state === 'demoBattle', 'demo battle is the closed-menu surface');
  assert(machine.send('startOnlineGame') === false, 'the demo cannot start a match — hosting lives in the menu');
  assert(machine.send('openMenu') === true, 'opening the menu returns to the lobby');

  // The lab is reachable from both non-match surfaces, and both roads back exist.
  assert(machine.send('openEntityLab') === true, 'the lobby can open the entity lab');
  assert(machine.state === 'entityLab', 'and lands in it');
  assert(machine.send('startOnlineGame') === false, 'the lab can NEVER start an online game');
  assert(machine.send('openDemoBattle') === true, 'the lab returns to the demo battle');
  assert(machine.send('openEntityLab') === true, 'the demo battle can open the entity lab');
  assert(machine.send('openLobby') === true, 'the lab returns to the lobby');

  // An online game is entered from the lobby alone and has exactly one exit.
  assert(machine.send('startOnlineGame') === true, 'the lobby starts the online game');
  assert(machine.state === 'onlineGame', 'battle handoff is the entry edge');
  assert(machine.send('startOnlineGame') === false, 'a second start is refused');
  assert(machine.send('openEntityLab') === false, 'the hotkey mid-match is refused — it would disconnect the seat');
  assert(machine.send('openMenu') === false, 'no menu slide leaves a match');
  assert(machine.send('closeMenu') === false, 'in either direction');
  assert(machine.send('openDemoBattle') === false, 'no shortcut to the demo from a match');
  assert(machine.state === 'onlineGame', 'refusals never move the machine');
  assert(machine.send('exitOnlineGame') === true, 'the one exit leads to the lobby');
  assert(machine.state === 'lobby', 'where every flow regroups');
  assert(machine.send('exitOnlineGame') === false, 'a stale exit after leaving is refused');

  console.log('[contract] appSurfaceMachine: navigation table holds');
}
