<script setup lang="ts">
/**
 * What every side is worth, side by side.
 *
 * The thing a watcher actually wants and a player cannot have: both economies
 * at once. It costs nothing to show — in deterministic lockstep every peer
 * already holds the whole authoritative world, so this is reading local state
 * rather than asking anyone for anything.
 *
 * Grouped by SIDE rather than by seat, because that is the unit a watcher
 * thinks in: a 2v2 is two economies with two players each, and comparing four
 * columns answers a different question than comparing two.
 */
import { computed } from 'vue';
import { economyManager } from '../game/sim/economy';
import type { PlayerId } from '../game/sim/types';
import type { LobbyPlayer } from '../types/network';

const props = defineProps<{
  players: readonly LobbyPlayer[];
  /** Bumped by the caller on every snapshot so the numbers re-read. The
   *  economy singleton is not reactive, and making it so for one overlay
   *  would put Vue in the simulation's way. */
  revision: number;
  getPlayerColor: (playerId: PlayerId) => string;
  /** Live entity count per seat, for the "how big is that army" half of the
   *  question the economy alone does not answer. */
  entityCountFor: (playerId: PlayerId) => number;
}>();

type SideSummary = {
  allyTeamId: number;
  color: string;
  metal: number;
  energy: number;
  metalIncome: number;
  energyIncome: number;
  entities: number;
  names: string[];
};

const sides = computed<SideSummary[]>(() => {
  void props.revision;
  const byAllyTeam = new Map<number, SideSummary>();
  for (const player of props.players) {
    const economy = economyManager.getEconomy(player.playerId);
    let side = byAllyTeam.get(player.allyTeamId);
    if (side === undefined) {
      side = {
        allyTeamId: player.allyTeamId,
        color: props.getPlayerColor(player.playerId),
        metal: 0,
        energy: 0,
        metalIncome: 0,
        energyIncome: 0,
        entities: 0,
        names: [],
      };
      byAllyTeam.set(player.allyTeamId, side);
    }
    side.names.push(player.name);
    side.entities += props.entityCountFor(player.playerId);
    if (economy === undefined) continue;
    side.metal += economy.metal.stockpile.curr;
    side.energy += economy.stockpile.curr;
    side.metalIncome += economy.metal.income.base + economy.metal.income.extraction;
    side.energyIncome += economy.income.base + economy.income.production;
  }
  return [...byAllyTeam.values()].sort((a, b) => a.allyTeamId - b.allyTeamId);
});

function short(value: number): string {
  if (value >= 10000) return `${Math.round(value / 1000)}k`;
  return String(Math.round(value));
}
</script>

<template>
  <div v-if="sides.length > 0" class="spectator-teams" role="table" aria-label="Team economies">
    <div
      v-for="side in sides"
      :key="side.allyTeamId"
      class="spectator-team"
      role="row"
    >
      <span class="spectator-team-band" :style="{ background: side.color }" />
      <span class="spectator-team-name">
        TEAM {{ side.allyTeamId }}
        <span class="spectator-team-members">{{ side.names.join(', ') }}</span>
      </span>
      <span class="spectator-team-stat metal">
        {{ short(side.metal) }}<span class="rate">+{{ short(side.metalIncome) }}</span>
      </span>
      <span class="spectator-team-stat energy">
        {{ short(side.energy) }}<span class="rate">+{{ short(side.energyIncome) }}</span>
      </span>
      <span class="spectator-team-stat units">{{ side.entities }}</span>
    </div>
  </div>
</template>

<style scoped>
.spectator-teams {
  position: absolute;
  top: 12px;
  left: 12px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 6px 8px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 4px;
  background: rgba(10, 12, 16, 0.8);
  font-size: 11px;
  z-index: 34;
  pointer-events: none;
}

.spectator-team {
  display: flex;
  align-items: center;
  gap: 8px;
}

.spectator-team-band {
  width: 4px;
  align-self: stretch;
  border-radius: 2px;
}

.spectator-team-name {
  min-width: 120px;
  display: flex;
  flex-direction: column;
  letter-spacing: 0.06em;
}

.spectator-team-members {
  font-size: 9px;
  opacity: 0.55;
}

.spectator-team-stat {
  min-width: 62px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.spectator-team-stat .rate {
  opacity: 0.55;
  font-size: 9px;
  margin-left: 3px;
}

.spectator-team-stat.metal {
  color: #cfd6dd;
}

.spectator-team-stat.energy {
  color: #ffd25a;
}

.spectator-team-stat.units {
  min-width: 34px;
  opacity: 0.75;
}
</style>
