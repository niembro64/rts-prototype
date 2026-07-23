<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { AUDIO, type SoundEntry } from '../audioConfig';
import { audioManager } from '../game/audio/AudioManager';
import {
  buildEntityLabSelections,
  buildEntityLabSoundActions,
  dedupeSounds,
  ENTITY_LAB_KINDS,
  getEntityLabSelectionName,
  soundEntryDetail,
  uniqueSoundLabel,
  type EntityLabSoundAction,
  type UniqueSound,
} from './entityAudioDiagnostics';
import { buildLoadingEntityInfo } from './loadingUnitInfo';
import LoadingInfoColumn from './LoadingInfoColumn.vue';
import {
  mountLoadingUnitPreview,
  type LoadingEntityBlueprintId,
  type LoadingPreviewKind,
  type LoadingUnitPreviewControls,
  type LoadingUnitPreviewRuntime,
} from './loadingUnitPreview3d';
import type { TurretBlueprintId } from '@/types/blueprintIds';
import type { PrimitiveGeometryTier } from '@/game/render3d/PrimitiveGeometryQuality3D';

const emit = defineEmits<{
  openDemoBattle: [];
  openLobby: [];
  openOnlineGame: [];
}>();

const firstUnit = buildEntityLabSelections('unit')[0];
const selectedKind = ref<LoadingPreviewKind>('unit');
const selectedEntityId = ref<LoadingEntityBlueprintId>(firstUnit.id);
const previewHost = ref<HTMLElement | null>(null);
const previewReady = ref(false);
const rotate = ref(true);
const rotationSpeed = ref(1);
const yawDegrees = ref(0);
const pitchDegrees = ref(0);
const motion = ref(false);
const motionSpeed = ref(1);
const geometryTier = ref<PrimitiveGeometryTier>('close');
const LOD_TIERS = ['close', 'mid', 'far'] as const;
const activeLoopActionId = ref<string | null>(null);

let previewRuntime: LoadingUnitPreviewRuntime | null = null;
let activeContinuousId: number | null = null;
let nextContinuousId = 9000;

const rawSynths = [
  { name: 'burst-rifle', category: 'fire' },
  { name: 'cannon', category: 'fire' },
  { name: 'laser-zap', category: 'fire' },
  { name: 'shield', category: 'fire' },
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
] as const;

const fireSounds = dedupeSounds(AUDIO.event.fire as Record<string, SoundEntry>);
const hitSounds = dedupeSounds(AUDIO.event.hit as Record<string, SoundEntry>);
const deathSounds = dedupeSounds(AUDIO.event.death as Record<string, SoundEntry>);

const entitySelections = computed(() => buildEntityLabSelections(selectedKind.value));
const selectedEntityName = computed(() => (
  getEntityLabSelectionName(selectedKind.value, selectedEntityId.value)
));
const selectedEntityInfo = computed(() => (
  buildLoadingEntityInfo(selectedKind.value, selectedEntityId.value)
));
const selectedSoundActions = computed(() => (
  buildEntityLabSoundActions(selectedKind.value, selectedEntityId.value)
));
const selectedEntityKey = computed(() => `${selectedKind.value}:${selectedEntityId.value}`);

watch(selectedKind, (kind) => {
  const selections = buildEntityLabSelections(kind);
  const first = selections[0];
  selectedEntityId.value = first.id;
});

onMounted(() => {
  void remountPreview();
});

watch([selectedEntityKey, geometryTier], () => {
  stopContinuous();
  void remountPreview();
});

watch(
  [rotate, rotationSpeed, yawDegrees, pitchDegrees, motion, motionSpeed],
  () => {
    previewRuntime?.setControls(readPreviewControls());
  },
);

onBeforeUnmount(() => {
  destroyPreview();
  stopContinuous();
});

function readPreviewControls(): Partial<LoadingUnitPreviewControls> {
  return {
    rotate: rotate.value,
    rotationSpeed: rotationSpeed.value,
    yaw: degreesToRadians(yawDegrees.value),
    pitch: degreesToRadians(pitchDegrees.value),
    motion: motion.value,
    motionSpeed: motionSpeed.value,
  };
}

async function remountPreview(): Promise<void> {
  destroyPreview();
  previewReady.value = false;
  await nextTick();
  const host = previewHost.value;
  if (host === null) return;
  previewRuntime = mountLoadingUnitPreview(
    host,
    selectedKind.value,
    selectedEntityId.value,
    {
      fullBleed: false,
      controls: readPreviewControls(),
      geometryTier: geometryTier.value,
      onReady: () => {
        previewReady.value = true;
      },
    },
  );
}

function destroyPreview(): void {
  if (previewRuntime === null) return;
  previewRuntime.destroy();
  previewRuntime = null;
}

function ensureAudio(): void {
  audioManager.init();
  audioManager.setMuted(false);
}

function openDemoBattle(): void {
  stopContinuous();
  emit('openDemoBattle');
}

function openLobby(): void {
  stopContinuous();
  emit('openLobby');
}

function openOnlineGame(): void {
  stopContinuous();
  emit('openOnlineGame');
}

function playRawSynth(name: string): void {
  ensureAudio();
  audioManager.playSynth(name, 1, 1);
}

function playUniqueSound(sound: UniqueSound, categoryGain: number): void {
  ensureAudio();
  audioManager.playSynth(sound.synth, sound.playSpeed, sound.volume * categoryGain);
}

function playEntityAction(action: EntityLabSoundAction): void {
  if (action.kind === 'beam-loop' || action.kind === 'shield-loop') {
    toggleContinuous(action);
    return;
  }
  ensureAudio();
  if (action.kind === 'fire' && action.turretBlueprintId !== null) {
    audioManager.playWeaponFire(action.turretBlueprintId, 1, 1);
    return;
  }
  if (action.kind === 'hit' && action.emissionBlueprintId !== null) {
    audioManager.playWeaponHit(action.emissionBlueprintId, 1);
    return;
  }
  if (action.kind === 'death') {
    audioManager.playUnitDeath(selectedEntityId.value, 1);
  }
}

function toggleContinuous(action: EntityLabSoundAction): void {
  if (activeLoopActionId.value === action.id) {
    stopContinuous();
    return;
  }
  startContinuous(action);
}

function startContinuous(action: EntityLabSoundAction): void {
  stopContinuous();
  ensureAudio();
  const id = nextContinuousId++;
  activeContinuousId = id;
  activeLoopActionId.value = action.id;
  if (action.kind === 'beam-loop') {
    audioManager.startLaserSoundForTurret(
      id,
      action.turretBlueprintId as TurretBlueprintId | null,
      AUDIO.beamGain,
      1,
    );
    return;
  }
  audioManager.startShieldSound(id, 1, AUDIO.fieldGain, 1);
}

function stopContinuous(): void {
  if (activeContinuousId === null) {
    activeLoopActionId.value = null;
    return;
  }
  audioManager.stopLaserSound(activeContinuousId);
  audioManager.stopShieldSound(activeContinuousId);
  activeContinuousId = null;
  activeLoopActionId.value = null;
}

function actionTone(action: EntityLabSoundAction): string {
  if (action.kind === 'death') return 'danger';
  if (action.kind === 'hit') return 'impact';
  if (action.kind === 'beam-loop' || action.kind === 'shield-loop') return 'loop';
  return 'fire';
}

function entityKindLabel(kind: LoadingPreviewKind): string {
  if (kind === 'unit') return 'Units';
  return 'Buildings';
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}
</script>

<template>
  <div class="entity-lab-page">
    <div class="entity-lab-shell">
      <div class="entity-lab-header">
        <div>
          <h2>Entity Lab</h2>
          <p>{{ selectedEntityName }} / {{ selectedEntityId }}</p>
        </div>
        <nav class="mode-nav" aria-label="App modes">
          <button @click="openDemoBattle">Demo Battle</button>
          <button @click="openLobby">Lobby</button>
          <button @click="openOnlineGame">Online Game</button>
          <button class="active" aria-current="page">Entity Lab</button>
        </nav>
      </div>

      <div class="entity-lab-body">
        <aside class="entity-lab-sidebar">
          <section class="lab-section">
            <h3>Entity</h3>
            <div class="kind-tabs">
              <button
                v-for="kind in ENTITY_LAB_KINDS"
                :key="kind"
                :class="{ active: selectedKind === kind }"
                @click="selectedKind = kind"
              >
                {{ entityKindLabel(kind) }}
              </button>
            </div>
            <label class="select-row">
              <span>Blueprint</span>
              <select v-model="selectedEntityId">
                <option
                  v-for="selection in entitySelections"
                  :key="selection.id"
                  :value="selection.id"
                >
                  {{ selection.name }} / {{ selection.id }}
                </option>
              </select>
            </label>
          </section>

          <section class="lab-section">
            <h3>View</h3>
            <div class="kind-tabs" aria-label="Geometry level of detail">
              <button
                v-for="tier in LOD_TIERS"
                :key="tier"
                :class="{ active: geometryTier === tier }"
                @click="geometryTier = tier"
              >
                {{ tier === 'close' ? 'High' : tier === 'mid' ? 'Medium' : 'Low' }}
              </button>
            </div>
            <label class="toggle-row">
              <input v-model="rotate" type="checkbox">
              <span>Rotate</span>
            </label>
            <label class="control-row">
              <span>Spin</span>
              <input v-model.number="rotationSpeed" type="range" min="0" max="2.5" step="0.05">
              <strong>{{ rotationSpeed.toFixed(2) }}x</strong>
            </label>
            <label class="control-row">
              <span>Yaw</span>
              <input v-model.number="yawDegrees" type="range" min="-180" max="180" step="1">
              <strong>{{ yawDegrees }}°</strong>
            </label>
            <label class="control-row">
              <span>Pitch</span>
              <input v-model.number="pitchDegrees" type="range" min="-25" max="25" step="1">
              <strong>{{ pitchDegrees }}°</strong>
            </label>
          </section>

          <section class="lab-section">
            <h3>Motion</h3>
            <label class="toggle-row">
              <input v-model="motion" type="checkbox">
              <span>{{ motion ? 'Walking' : 'Stopped' }}</span>
            </label>
            <label class="control-row">
              <span>Speed</span>
              <input v-model.number="motionSpeed" type="range" min="0.2" max="3" step="0.05">
              <strong>{{ motionSpeed.toFixed(2) }}x</strong>
            </label>
          </section>

          <section class="lab-section summary">
            <h3>Summary</h3>
            <div class="summary-grid">
              <div
                v-for="item in selectedEntityInfo.summary"
                :key="item.label"
                class="summary-item"
              >
                <span>{{ item.label }}</span>
                <strong>{{ item.value }}</strong>
              </div>
            </div>
          </section>
        </aside>

        <main class="entity-lab-main">
          <section class="preview-panel">
            <div
              ref="previewHost"
              class="entity-preview-host"
              :class="{ ready: previewReady }"
            ></div>
          </section>

          <section class="entity-sounds">
            <div class="section-heading">
              <h3>Entity Audio</h3>
              <button
                class="small-btn"
                :disabled="activeLoopActionId === null"
                @click="stopContinuous"
              >
                Stop Loop
              </button>
            </div>
            <div v-if="selectedSoundActions.length > 0" class="action-grid">
              <button
                v-for="action in selectedSoundActions"
                :key="action.id"
                class="sound-action"
                :class="[actionTone(action), { active: activeLoopActionId === action.id }]"
                @click="playEntityAction(action)"
              >
                <span>{{ action.label }}</span>
                <small>{{ action.detail }}</small>
              </button>
            </div>
            <div v-else class="empty-state">No direct entity sounds</div>
          </section>

          <section class="info-panel">
            <LoadingInfoColumn :sections="selectedEntityInfo.leftSections" />
            <LoadingInfoColumn :sections="selectedEntityInfo.rightSections" />
          </section>
        </main>

        <aside class="sound-catalog">
          <section class="lab-section">
            <h3>Raw Synths</h3>
            <div class="compact-grid">
              <button
                v-for="synth in rawSynths"
                :key="synth.name"
                @click="playRawSynth(synth.name)"
              >
                <span>{{ synth.name }}</span>
                <small>{{ synth.category }}</small>
              </button>
            </div>
          </section>

          <section class="lab-section">
            <h3>Fire Sounds <span>x{{ AUDIO.fireGain }}</span></h3>
            <div class="compact-grid">
              <button
                v-for="sound in fireSounds"
                :key="`${sound.synth}-${sound.playSpeed}-${sound.volume}`"
                :title="uniqueSoundLabel(sound)"
                @click="playUniqueSound(sound, AUDIO.fireGain)"
              >
                <span>{{ uniqueSoundLabel(sound) }}</span>
                <small>{{ soundEntryDetail(sound) }}</small>
              </button>
            </div>
          </section>

          <section class="lab-section">
            <h3>Hit Sounds <span>x{{ AUDIO.hitGain }}</span></h3>
            <div class="compact-grid">
              <button
                v-for="sound in hitSounds"
                :key="`${sound.synth}-${sound.playSpeed}-${sound.volume}`"
                :title="uniqueSoundLabel(sound)"
                @click="playUniqueSound(sound, AUDIO.hitGain)"
              >
                <span>{{ uniqueSoundLabel(sound) }}</span>
                <small>{{ soundEntryDetail(sound) }}</small>
              </button>
            </div>
          </section>

          <section class="lab-section">
            <h3>Death Sounds <span>x{{ AUDIO.deadGain }}</span></h3>
            <div class="compact-grid">
              <button
                v-for="sound in deathSounds"
                :key="`${sound.synth}-${sound.playSpeed}-${sound.volume}`"
                :title="uniqueSoundLabel(sound)"
                @click="playUniqueSound(sound, AUDIO.deadGain)"
              >
                <span>{{ uniqueSoundLabel(sound) }}</span>
                <small>{{ soundEntryDetail(sound) }}</small>
              </button>
            </div>
          </section>
        </aside>
      </div>
    </div>
  </div>
</template>

<style scoped>
.entity-lab-page {
  width: 100%;
  height: 100%;
  display: flex;
  box-sizing: border-box;
  background: #040609;
  color: #dce6ee;
  font-family: monospace;
}

.entity-lab-shell {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: rgba(11, 15, 18, 0.98);
}

.entity-lab-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
  border-bottom: 1px solid rgba(180, 199, 209, 0.2);
  background: rgba(18, 24, 27, 0.98);
}

.entity-lab-header h2,
.entity-lab-header p,
.lab-section h3,
.section-heading h3 {
  margin: 0;
}

.entity-lab-header h2 {
  font-size: 17px;
  color: #edf4f7;
}

.entity-lab-header p {
  margin-top: 3px;
  font-size: 11px;
  color: rgba(220, 230, 238, 0.58);
}

.entity-lab-body {
  min-height: 0;
  flex: 1 1 auto;
  display: grid;
  grid-template-columns: 260px minmax(420px, 1fr) 320px;
  gap: 1px;
  background: rgba(180, 199, 209, 0.14);
}

.entity-lab-sidebar,
.sound-catalog,
.entity-lab-main {
  min-height: 0;
  background: rgba(10, 14, 17, 0.97);
}

.entity-lab-sidebar,
.sound-catalog {
  overflow: auto;
  padding: 12px;
}

.entity-lab-main {
  display: grid;
  grid-template-rows: minmax(260px, 1fr) auto minmax(220px, 0.78fr);
  min-width: 0;
}

.lab-section {
  padding: 12px 0;
  border-bottom: 1px solid rgba(180, 199, 209, 0.14);
}

.lab-section:first-child {
  padding-top: 0;
}

.lab-section h3,
.section-heading h3 {
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgba(109, 218, 185, 0.9);
}

.lab-section h3 span {
  color: rgba(220, 230, 238, 0.46);
  font-weight: 400;
  letter-spacing: 0;
}

.kind-tabs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
  margin-top: 10px;
}

.kind-tabs button,
.small-btn,
.mode-nav button {
  border: 1px solid rgba(180, 199, 209, 0.24);
  border-radius: 4px;
  background: rgba(34, 43, 47, 0.9);
  color: rgba(220, 230, 238, 0.76);
  font: inherit;
  cursor: pointer;
}

.kind-tabs button {
  min-height: 30px;
  font-size: 10px;
}

.kind-tabs button.active {
  border-color: rgba(109, 218, 185, 0.78);
  background: rgba(39, 82, 72, 0.68);
  color: #f2fff9;
}

.mode-nav {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.mode-nav button {
  min-height: 30px;
  padding: 0 10px;
  font-size: 10px;
  text-transform: uppercase;
}

.mode-nav button.active {
  border-color: rgba(109, 218, 185, 0.84);
  background: rgba(39, 82, 72, 0.7);
  color: #f2fff9;
  cursor: default;
}

.select-row,
.toggle-row,
.control-row {
  display: grid;
  gap: 7px;
  margin-top: 10px;
  font-size: 11px;
  color: rgba(220, 230, 238, 0.7);
}

.select-row select {
  width: 100%;
  min-width: 0;
  height: 32px;
  border: 1px solid rgba(180, 199, 209, 0.24);
  border-radius: 4px;
  background: rgba(20, 27, 30, 0.95);
  color: #e7eef2;
  font: inherit;
}

.toggle-row {
  grid-template-columns: auto 1fr;
  align-items: center;
}

.toggle-row input {
  width: 16px;
  height: 16px;
  accent-color: #6ddab9;
}

.control-row {
  grid-template-columns: 46px minmax(0, 1fr) 54px;
  align-items: center;
}

.control-row input {
  width: 100%;
  accent-color: #6ddab9;
}

.control-row strong {
  color: rgba(237, 244, 247, 0.86);
  font-size: 10px;
  text-align: right;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  margin-top: 10px;
}

.summary-item {
  min-width: 0;
  padding: 7px;
  border: 1px solid rgba(180, 199, 209, 0.16);
  border-radius: 4px;
  background: rgba(28, 35, 39, 0.72);
}

.summary-item span,
.summary-item strong {
  display: block;
  min-width: 0;
  overflow-wrap: anywhere;
}

.summary-item span {
  color: rgba(220, 230, 238, 0.48);
  font-size: 9px;
  text-transform: uppercase;
}

.summary-item strong {
  margin-top: 3px;
  color: rgba(237, 244, 247, 0.9);
  font-size: 11px;
}

.preview-panel {
  position: relative;
  min-height: 0;
  overflow: hidden;
  background:
    linear-gradient(180deg, rgba(12, 18, 20, 0.4), rgba(5, 7, 9, 0.94)),
    repeating-linear-gradient(0deg, rgba(237, 244, 247, 0.035) 0 1px, transparent 1px 14px);
}

.entity-preview-host {
  position: absolute;
  inset: 0;
  opacity: 0;
  transition: opacity 180ms ease-out;
}

.entity-preview-host.ready {
  opacity: 1;
}

.entity-preview-host :deep(.loader-unit-stage) {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

.entity-preview-host :deep(.loader-unit-canvas) {
  width: 100%;
  height: 100%;
  display: block;
}

.entity-sounds {
  padding: 12px;
  border-top: 1px solid rgba(180, 199, 209, 0.14);
  border-bottom: 1px solid rgba(180, 199, 209, 0.14);
  background: rgba(13, 18, 21, 0.98);
}

.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}

.small-btn {
  min-height: 26px;
  padding: 0 10px;
  font-size: 10px;
}

.small-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.action-grid,
.compact-grid {
  display: grid;
  gap: 6px;
}

.action-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.compact-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin-top: 10px;
}

.sound-action,
.compact-grid button {
  min-width: 0;
  min-height: 48px;
  padding: 7px 9px;
  border: 1px solid rgba(180, 199, 209, 0.2);
  border-radius: 4px;
  background: rgba(31, 38, 41, 0.9);
  color: rgba(220, 230, 238, 0.86);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.sound-action span,
.sound-action small,
.compact-grid button span,
.compact-grid button small {
  display: block;
  min-width: 0;
  overflow-wrap: anywhere;
}

.sound-action span,
.compact-grid button span {
  font-size: 11px;
}

.sound-action small,
.compact-grid button small {
  margin-top: 3px;
  color: rgba(220, 230, 238, 0.48);
  font-size: 9px;
  line-height: 1.2;
}

.sound-action.fire {
  border-color: rgba(116, 170, 229, 0.28);
}

.sound-action.impact {
  border-color: rgba(207, 180, 103, 0.34);
}

.sound-action.danger {
  border-color: rgba(226, 108, 98, 0.42);
}

.sound-action.loop {
  border-color: rgba(109, 218, 185, 0.36);
}

.sound-action.active {
  background: rgba(39, 82, 72, 0.72);
  border-color: rgba(109, 218, 185, 0.86);
  color: #f2fff9;
}

.sound-action:hover,
.compact-grid button:hover,
.small-btn:hover,
.mode-nav button:not(.active):hover,
.kind-tabs button:hover {
  border-color: rgba(237, 244, 247, 0.44);
  background: rgba(44, 55, 59, 0.96);
}

.info-panel {
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1px;
  background: rgba(180, 199, 209, 0.14);
}

.info-panel :deep(.loader-info-sections) {
  height: 100%;
  padding: 12px;
  background: rgba(10, 14, 17, 0.97);
}

.empty-state {
  min-height: 48px;
  display: flex;
  align-items: center;
  padding: 0 10px;
  border: 1px solid rgba(180, 199, 209, 0.16);
  border-radius: 4px;
  color: rgba(220, 230, 238, 0.48);
  background: rgba(28, 35, 39, 0.52);
  font-size: 11px;
}

@media (max-width: 1100px) {
  .entity-lab-body {
    grid-template-columns: 220px minmax(360px, 1fr);
  }

  .sound-catalog {
    display: none;
  }

  .action-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 760px) {
  .entity-lab-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .entity-lab-body {
    grid-template-columns: 1fr;
    overflow: auto;
  }

  .entity-lab-sidebar {
    overflow: visible;
  }

  .entity-lab-main {
    grid-template-rows: 280px auto 360px;
  }

  .info-panel {
    grid-template-columns: 1fr;
  }

  .action-grid {
    grid-template-columns: 1fr;
  }
}
</style>
