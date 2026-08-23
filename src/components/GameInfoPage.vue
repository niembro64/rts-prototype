<script setup lang="ts">
// The about side room: what the game is, how a match works, and where it
// comes from. Same side-room rules as the lab and the controls screen —
// no network, no battle, the road to a match always runs through home.
import { sendAppSurface } from '../appSurfaceMachine';
import { AUTHOR_BYLINE } from '../authorBylineConfig';

function openHome(): void {
  sendAppSurface('openHome');
}

function openEntityLab(): void {
  sendAppSurface('openEntityLab');
}

function openGameControls(): void {
  sendAppSurface('openGameControls');
}
</script>

<template>
  <div class="game-info-page">
    <div class="game-info-shell">
      <div class="game-info-header">
        <div>
          <h2>Game Info</h2>
          <p>What Budget Annihilation is, and how a match works</p>
        </div>
        <nav class="mode-nav" aria-label="App modes">
          <button @click="openHome">Home</button>
          <button @click="openEntityLab">Entity Lab</button>
          <button @click="openGameControls">Game Controls</button>
          <button class="active" aria-current="page">Game Info</button>
        </nav>
      </div>

      <div class="info-body">
        <section class="info-section">
          <h3>The game</h3>
          <p>
            Budget Annihilation is a browser real-time strategy game in the
            spirit of Total Annihilation and Beyond All Reason: commanders,
            streaming metal-and-energy economy, factories, swarms, and one
            explosion for every death. It runs entirely in your browser —
            nothing to install, nothing to download.
          </p>
        </section>

        <section class="info-section">
          <h3>Ways to play</h3>
          <ul>
            <li>
              <strong>Skirmish</strong> — a sealed room on this
              machine alone: add bots, pick a map, press Start. Works with no
              internet.
            </li>
            <li>
              <strong>Host</strong> — opens a room with a
              four-letter code and lists it in the lobby directory. Friends
              join by code or by clicking the listing.
            </li>
            <li>
              <strong>Join</strong> — everyone arrives as a spectator; the
              host seats players onto teams. A running game still takes
              watchers, and a player who drops can rejoin into their own army.
            </li>
          </ul>
        </section>

        <section class="info-section">
          <h3>How a match runs</h3>
          <p>
            Online games use deterministic lockstep: every player's machine
            simulates the whole battle and only the commands travel. That is
            why matches stay perfectly in sync, why spectators can watch any
            seat, and why the match politely waits for a player whose
            connection hiccups instead of teleporting their army.
          </p>
        </section>

        <section class="info-section">
          <h3>The side rooms</h3>
          <ul>
            <li>
              <strong>Entity Lab</strong> — every unit, building, and tower in
              the game, inspectable up close.
            </li>
            <li>
              <strong>Game Controls</strong> — hotkey presets and the full
              binding reference.
            </li>
          </ul>
        </section>

        <section class="info-section">
          <h3>Made by</h3>
          <p class="byline">
            <a :href="AUTHOR_BYLINE.siteUrl" target="_blank" rel="noreferrer">{{
              AUTHOR_BYLINE.siteUrl
            }}</a>
            <a :href="`mailto:${AUTHOR_BYLINE.email}`">{{ AUTHOR_BYLINE.email }}</a>
          </p>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.game-info-page {
  width: 100%;
  height: 100%;
  display: flex;
  box-sizing: border-box;
  background: #040609;
  color: #dce6ee;
  font-family: monospace;
}

.game-info-shell {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: rgba(11, 15, 18, 0.98);
}

.game-info-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
  border-bottom: 1px solid rgba(180, 199, 209, 0.2);
  background: rgba(18, 24, 27, 0.98);
}

.game-info-header h2 {
  margin: 0;
  font-size: 17px;
  color: #edf4f7;
}

.game-info-header p {
  margin: 0;
  font-size: 11px;
  color: #93a7b3;
}

.mode-nav {
  display: flex;
  gap: 6px;
}

.mode-nav button {
  background: rgba(32, 42, 48, 0.9);
  border: 1px solid rgba(180, 199, 209, 0.25);
  color: #c8d6de;
  font-family: monospace;
  font-size: 12px;
  padding: 6px 12px;
  cursor: pointer;
}

.mode-nav button:hover {
  background: rgba(52, 66, 74, 0.9);
}

.mode-nav button.active {
  background: rgba(84, 128, 150, 0.55);
  color: #f0f7fa;
  cursor: default;
}

.info-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 24px 32px;
  max-width: 760px;
}

.info-section {
  margin-bottom: 22px;
}

.info-section h3 {
  margin: 0 0 8px;
  font-size: 13px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #8fc2ff;
}

.info-section p,
.info-section li {
  margin: 0 0 8px;
  font-size: 13px;
  line-height: 1.6;
  color: #c8d6de;
}

.info-section ul {
  margin: 0;
  padding-left: 18px;
}

.byline {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
}

.byline a {
  color: #8fc2ff;
  text-decoration: underline;
}
</style>
