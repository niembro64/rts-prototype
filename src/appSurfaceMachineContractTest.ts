/**
 * The navigation guarantees the app shell leans on: neither side room (lab,
 * controls) can start a battle or enter a game room, nothing leaves the game
 * room except its declared exits, and HOME is the hub every flow regroups
 * through. Drives a fresh machine built from the real table, so the live
 * singleton is never disturbed and the table cannot drift from what is
 * tested.
 */

import {
  createAppSurfaceMachine,
  isBattleSurface,
  isGameRoomSurface,
} from './appSurfaceMachine';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[app-surface] ${message}`);
}

export function runAppSurfaceMachineContractTest(): void {
  const machine = createAppSurfaceMachine();

  // Boot is the only road out of init, and nothing returns there.
  assert(machine.state === 'init', 'the app starts in init');
  assert(machine.send('openEntityLab') === false, 'nothing navigates before boot');
  assert(machine.send('startBattle') === false, 'no battle can start before boot');
  assert(machine.send('boot') === true, 'boot lands home');
  assert(machine.state === 'home', 'home is the post-boot surface');
  assert(machine.send('boot') === false, 'boot fires once; a remount cannot re-boot');

  // The menu sidebar sliding open or away is CHROME, not navigation: there
  // is no state pair to toggle between any more, so no such event exists on
  // the table at all. Home is home with the sidebar in either position.

  // All three side rooms are reachable from home, from each other, and
  // lead back — and none of them can start a battle or enter a game room.
  assert(machine.send('openEntityLab') === true, 'home can open the entity lab');
  assert(machine.state === 'entityLab', 'and lands in it');
  assert(machine.send('startBattle') === false, 'the lab can NEVER start a battle');
  assert(machine.send('enterLobby') === false, 'nor enter a game room');
  assert(machine.send('openGameControls') === true, 'the lab reaches the controls screen');
  assert(machine.state === 'gameControls', 'and lands in it');
  assert(machine.send('startBattle') === false, 'the controls screen can NEVER start a battle');
  assert(machine.send('enterLobby') === false, 'nor enter a game room');
  assert(machine.send('openGameInfo') === true, 'the controls screen reaches the info page');
  assert(machine.state === 'gameInfo', 'and lands in it');
  assert(machine.send('startBattle') === false, 'the info page can NEVER start a battle');
  assert(machine.send('enterLobby') === false, 'nor enter a game room');
  assert(machine.send('openEntityLab') === true, 'the info page reaches the lab');
  assert(machine.send('openGameInfo') === true, 'the lab reaches the info page');
  assert(machine.send('openHome') === true, 'the info page returns home');
  assert(machine.send('openGameInfo') === true, 'home can open the info page');
  assert(machine.send('openGameControls') === true, 'the info page reaches the controls screen');
  assert(machine.send('openEntityLab') === true, 'the controls screen reaches the lab');
  assert(machine.send('openHome') === true, 'the lab returns home');
  assert(machine.send('openGameControls') === true, 'home can open the controls screen');
  assert(machine.send('openHome') === true, 'the controls screen returns home');

  // Hosting or joining enters the game room's seating screen; cancel comes
  // straight home.
  assert(machine.send('enterLobby') === true, 'host/join enters the seating screen');
  assert(machine.state === 'gameRoomLobby', 'the seating screen is a game room sub-state');
  assert(isGameRoomSurface(machine.state), 'the predicate agrees');
  assert(!isBattleSurface(machine.state), 'but the seating screen is not the battle');
  assert(machine.send('openEntityLab') === false,
    'the lab hotkey is refused from the seating screen — it would silently disconnect the seat');
  assert(machine.send('openGameControls') === false, 'so is the controls screen');
  assert(machine.send('battleReady') === false, 'a battle that never started cannot become ready');
  assert(machine.send('leaveLobby') === true, 'cancel returns home');
  assert(machine.state === 'home', 'where every flow regroups');

  // The battle passes through an explicit loading phase before play.
  assert(machine.send('enterLobby') === true, 're-enter the seating screen');
  assert(machine.send('startBattle') === true, 'the handoff starts the battle');
  assert(machine.state === 'gameRoomBattleLoading', 'which begins in loading');
  assert(isBattleSurface(machine.state), 'loading is part of the battle sub-tree');
  assert(machine.send('startBattle') === false, 'a second start is refused');
  assert(machine.send('openEntityLab') === false, 'the lab hotkey mid-load is refused');
  assert(machine.send('enterLobby') === false, 'enterLobby is host/join only — a battle cannot re-enter that way');
  assert(machine.send('battleReady') === true, 'finished loading means playing');
  assert(machine.state === 'gameRoomBattlePlaying', 'the live match');
  assert(machine.send('battleReady') === false, 'ready fires once');
  assert(machine.send('openEntityLab') === false, 'the hotkey mid-match is refused — it would disconnect the seat');
  assert(machine.send('leaveLobby') === false, 'the lobby cancel means nothing inside a battle');
  assert(machine.state === 'gameRoomBattlePlaying', 'refusals never move the machine');

  // The HOST's whole-room rematch: the battle's one road back to the seating
  // screen, and from there the room can start again.
  assert(machine.send('returnToLobby') === true, 'the host can return the room to its seating screen');
  assert(machine.state === 'gameRoomLobby', 'back in the game room lobby, session intact');
  assert(machine.send('returnToLobby') === false, 'returnToLobby means nothing in a lobby already');
  assert(machine.send('startBattle') === true, 'a rematch starts like any other battle');
  assert(machine.state === 'gameRoomBattleLoading', 'and it loads like any other');
  // A late joiner still loading is brought along too when the host calls the
  // room back.
  assert(machine.send('returnToLobby') === true, 'mid-load the host can still call the room back');
  assert(machine.state === 'gameRoomLobby', 'the loading screen aborts into the lobby, not home');
  assert(machine.send('startBattle') === true, 'and the room can start once more');
  assert(machine.send('battleReady') === true, 'finished loading again');

  assert(machine.send('exitGameRoom') === true, 'the other exit leads home');
  assert(machine.state === 'home', 'home again');
  assert(machine.send('exitGameRoom') === false, 'a stale exit after leaving is refused');
  assert(machine.send('returnToLobby') === false, 'a stale rematch signal after leaving is refused');

  // A solo real battle skips the seating screen: home starts it directly.
  assert(machine.send('startBattle') === true, 'home starts a solo battle without a lobby');
  assert(machine.state === 'gameRoomBattleLoading', 'and it loads like any other');
  assert(machine.send('exitGameRoom') === true, 'a battle abandoned mid-load also exits home');

  // Eviction from the seating screen (the host left) uses the game room exit.
  assert(machine.send('enterLobby') === true, 'enter the seating screen once more');
  assert(machine.send('exitGameRoom') === true, 'host eviction comes home too');

  console.log('[contract] appSurfaceMachine: navigation table holds');
}
