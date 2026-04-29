<script setup lang="ts">
import { audioManager } from '../game/audio/AudioManager';
import { AUDIO } from '../audioConfig';
import type { SoundEntry } from '../audioConfig';

defineProps<{ visible: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

// Track which continuous sound is active (for mouseup cleanup)
let activeContinuousId: number | null = null;
let nextContinuousId = 9000;

function ensureAudio() {
  audioManager.init();
  audioManager.setMuted(false);
}

// Deduplicate sound entries: group by unique {synth, playSpeed, volume} → list of IDs that use it
type UniqueSound = { synth: string; playSpeed: number; volume: number; ids: string[] };

function dedup(entries: Record<string, SoundEntry>): UniqueSound[] {
  const map = new Map<string, UniqueSound>();
  for (const [id, entry] of Object.entries(entries)) {
    const key = `${entry.synth}|${entry.playSpeed}|${entry.volume}`;
    const existing = map.get(key);
    if (existing) {
      existing.ids.push(id);
    } else {
      map.set(key, { synth: entry.synth, playSpeed: entry.playSpeed, volume: entry.volume, ids: [id] });
    }
  }
  return [...map.values()];
}

const fireSounds = dedup(AUDIO.event.fire);
const hitSounds = dedup(AUDIO.event.hit);
const deathSounds = dedup(AUDIO.event.death);

// Raw synths (each is a unique synthesis function)
const rawSynths = [
  { name: 'burst-rifle', category: 'fire' },
  { name: 'cannon', category: 'fire' },
  { name: 'laserGun', category: 'fire' },
  { name: 'laser-zap', category: 'fire' },
  { name: 'force-field', category: 'fire' },
  { name: 'minigun', category: 'fire' },
  { name: 'shotgun', category: 'fire' },
  { name: 'grenade', category: 'fire' },
  { name: 'insect', category: 'fire' },
  { name: 'sizzle', category: 'hit' },
  { name: 'bullet', category: 'hit' },
  { name: 'heavy', category: 'hit' },
  { name: 'explosion', category: 'hit' },
  { name: 'small-explosion', category: 'death' },
  { name: 'medium-explosion', category: 'death' },
  { name: 'large-explosion', category: 'death' },
];

function playSynth(name: string) {
  ensureAudio();
  audioManager.playSynth(name, 1, 1);
}

function playSound(entry: UniqueSound, categoryGain: number) {
  ensureAudio();
  audioManager.playSynth(entry.synth, entry.playSpeed, entry.volume * categoryGain);
}

function startBeam() {
  ensureAudio();
  const id = nextContinuousId++;
  activeContinuousId = id;
  audioManager.startLaserSound(id, undefined, AUDIO.beamGain, 1);
}

function startForceField() {
  ensureAudio();
  const id = nextContinuousId++;
  activeContinuousId = id;
  audioManager.startForceFieldSound(id, 1, AUDIO.fieldGain, 1);
}

function stopContinuous() {
  if (activeContinuousId !== null) {
    audioManager.stopLaserSound(activeContinuousId);
    audioManager.stopForceFieldSound(activeContinuousId);
    activeContinuousId = null;
  }
}

function label(s: UniqueSound): string {
  // Collapse beamTurret0-13 / beamShot0-13 ranges
  const ids = s.ids;
  if (ids.length === 1) return ids[0];
  const beamMatch = ids[0].match(/^(beamTurret|beamShot)(\d+)$/);
  if (beamMatch && ids.length > 3) {
    return `${beamMatch[1]}[0-${ids.length - 1}]`;
  }
  return ids.join(', ');
}
</script>

<template>
  <div v-if="visible" class="sound-test-overlay" @click.self="emit('close')">
    <div class="sound-test-modal">
      <div class="st-header">
        <h2>Sound Test</h2>
        <button class="st-close" @click="emit('close')">X</button>
      </div>

      <div class="st-body">
        <section>
          <h3>Raw Synths</h3>
          <div class="st-grid">
            <button v-for="s in rawSynths" :key="s.name" @click="playSynth(s.name)">{{ s.name }}</button>
          </div>
        </section>

        <section>
          <h3>Weapon Fire <span class="st-gain">x{{ AUDIO.fireGain }}</span></h3>
          <div class="st-grid">
            <button
              v-for="s in fireSounds" :key="s.synth + s.playSpeed"
              @click="playSound(s, AUDIO.fireGain)"
              :title="label(s)"
            >
              <span class="st-label">{{ label(s) }}</span>
              <span class="st-meta">{{ s.synth }} @ {{ s.playSpeed }}x</span>
            </button>
          </div>
        </section>

        <section>
          <h3>Hit Sounds <span class="st-gain">x{{ AUDIO.hitGain }}</span></h3>
          <div class="st-grid">
            <button
              v-for="s in hitSounds" :key="s.synth + s.playSpeed"
              @click="playSound(s, AUDIO.hitGain)"
              :title="label(s)"
            >
              <span class="st-label">{{ label(s) }}</span>
              <span class="st-meta">{{ s.synth }} @ {{ s.playSpeed }}x</span>
            </button>
          </div>
        </section>

        <section>
          <h3>Death Sounds <span class="st-gain">x{{ AUDIO.deadGain }}</span></h3>
          <div class="st-grid">
            <button
              v-for="s in deathSounds" :key="s.synth + s.playSpeed"
              @click="playSound(s, AUDIO.deadGain)"
              :title="label(s)"
            >
              <span class="st-label">{{ label(s) }}</span>
              <span class="st-meta">{{ s.synth }} @ {{ s.playSpeed }}x</span>
            </button>
          </div>
        </section>

        <section>
          <h3>Continuous (hold to play)</h3>
          <div class="st-grid">
            <button
              @mousedown="startBeam()"
              @mouseup="stopContinuous()"
              @mouseleave="stopContinuous()"
            >
              <span class="st-label">Beam</span>
              <span class="st-meta">x{{ AUDIO.beamGain }}</span>
            </button>
            <button
              @mousedown="startForceField()"
              @mouseup="stopContinuous()"
              @mouseleave="stopContinuous()"
            >
              <span class="st-label">Force Field</span>
              <span class="st-meta">x{{ AUDIO.fieldGain }}</span>
            </button>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sound-test-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(10, 10, 20, 0.85);
  z-index: 4000;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: monospace;
}

.sound-test-modal {
  /* Aligned with the bottom-bar aesthetic: dark semi-transparent
   * base + muted gray border. Rounded corners kept. */
  background: rgba(15, 18, 24, 0.92);
  border: 1px solid #444;
  border-radius: 8px;
  width: 720px;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  color: #ccd;
}

.st-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid #334;
}

.st-header h2 {
  margin: 0;
  font-size: 16px;
  color: #aaf;
}

.st-close {
  background: none;
  border: 1px solid #556;
  color: #aab;
  padding: 2px 8px;
  cursor: pointer;
  font-family: monospace;
  font-size: 12px;
}

.st-close:hover {
  background: #334;
}

.st-body {
  padding: 12px 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.st-body section h3 {
  margin: 0 0 8px;
  font-size: 12px;
  color: #77a;
  text-transform: uppercase;
  letter-spacing: 1px;
}

.st-gain {
  color: #556;
  font-size: 10px;
  font-weight: normal;
  margin-left: 6px;
}

.st-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.st-grid button {
  background: #222238;
  border: 1px solid #445;
  color: #bbc;
  padding: 6px 10px;
  font-family: monospace;
  font-size: 11px;
  cursor: pointer;
  border-radius: 3px;
  transition: background 0.1s;
  user-select: none;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}

.st-grid button:hover {
  background: #333350;
  border-color: #668;
}

.st-grid button:active {
  background: #444468;
  border-color: #88a;
}

.st-label {
  color: #ccd;
}

.st-meta {
  color: #556;
  font-size: 9px;
}
</style>
