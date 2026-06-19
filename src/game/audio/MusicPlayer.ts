// MusicPlayer — orchestrates procedural and MIDI music playback.
// Delegates generation to proceduralMusic.ts and midiPlayback.ts;
// owns AudioContext wiring, gain nodes, and scheduler lifecycle.

import { AUDIO } from '../../audioConfig';
import {
  type ProceduralState,
  createProceduralState,
  scheduleProceduralLoop,
  SCHEDULER_INTERVAL,
} from './proceduralMusic';
import {
  type MidiState,
  type MidiEffectsChain,
  createMidiState,
  buildMidiEffectsChain,
  destroyMidiEffectsChain,
  loadMidi,
  scheduleMidiLoop,
} from './midiPlayback';

class MusicPlayer {
  private ctx: AudioContext | null = null;
  private musicGain: GainNode | null = null;
  private playing = false;
  private wantsPlayback = false;
  private playbackRequestId = 0;
  private schedulerInterval: ReturnType<typeof setInterval> | null = null;
  private pendingCleanups = new Set<ReturnType<typeof setTimeout>>();

  // Procedural state
  private procState: ProceduralState | null = null;

  // MIDI state and effects chain
  private midiState: MidiState = createMidiState();
  private midiEffects: MidiEffectsChain | null = null;

  init(ctx: AudioContext, masterGain: GainNode): void {
    if (this.musicGain) return;
    this.ctx = ctx;
    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = AUDIO.musicGain;
    this.musicGain.connect(masterGain);
    // MIDI fetch/parse and the effects chain (whose reverb impulse
    // buffer alone is ~1MB) are built lazily on the first start() —
    // a player with music disabled never pays for either.
  }

  start(): void {
    if (this.playing || !this.ctx || !this.musicGain) return;
    this.wantsPlayback = true;
    const requestId = ++this.playbackRequestId;

    // If MIDI mode requested but not yet loaded, kick the lazy load
    // (first start only) and begin once it resolves.
    if (AUDIO.musicSource === 'midi' && !this.midiState.loaded) {
      if (this.midiState.loadPromise === null) {
        this.midiState.loadPromise = loadMidi(this.midiState);
      }
      this.midiState.loadPromise.then(() => {
        if (
          this.wantsPlayback &&
          this.playbackRequestId === requestId &&
          !this.playing
        ) {
          this.beginPlayback();
        }
      });
      return;
    }

    this.beginPlayback();
  }

  private beginPlayback(): void {
    if (this.playing || !this.ctx || !this.musicGain) return;
    if (this.midiEffects === null && AUDIO.musicSource === 'midi') {
      this.midiEffects = buildMidiEffectsChain(this.ctx, this.musicGain);
    }
    this.playing = true;

    const now = this.ctx.currentTime;
    this.musicGain.gain.setValueAtTime(0.0001, now);
    this.musicGain.gain.linearRampToValueAtTime(AUDIO.musicGain, now + 2);

    console.log('[MusicPlayer] beginPlayback — source:', AUDIO.musicSource, 'midiLoaded:', this.midiState.loaded, 'notes:', this.midiState.notes?.length ?? 0);

    if (AUDIO.musicSource === 'midi' && this.midiState.loaded && this.midiState.notes) {
      this.midiState.mode = true;
      this.midiState.startOffset = now + 0.1;
      this.midiState.position = 0;
      console.log('[MusicPlayer] Starting MIDI playback');
    } else {
      this.midiState.mode = false;
      this.procState = createProceduralState(now + 0.1);
      console.log('[MusicPlayer] Starting procedural playback');
    }

    if (this.schedulerInterval === null) {
      this.schedulerInterval = setInterval(() => this.scheduleLoop(), SCHEDULER_INTERVAL);
    }
  }

  stop(): void {
    this.wantsPlayback = false;
    this.playbackRequestId++;
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
    }
    if (!this.playing || !this.ctx || !this.musicGain) return;
    this.playing = false;

    const now = this.ctx.currentTime;
    this.musicGain.gain.cancelScheduledValues(now);
    this.musicGain.gain.setValueAtTime(this.musicGain.gain.value, now);
    this.musicGain.gain.linearRampToValueAtTime(0.0001, now + 1);
  }

  setVolume(vol: number): void {
    if (this.musicGain && this.playing) {
      this.musicGain.gain.setTargetAtTime(vol, this.ctx!.currentTime, 0.1);
    }
  }

  isActive(): boolean {
    return this.playing;
  }

  destroy(): void {
    this.wantsPlayback = false;
    this.playbackRequestId++;
    this.playing = false;
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
    }
    for (const id of this.pendingCleanups) {
      clearTimeout(id);
    }
    this.pendingCleanups.clear();
    if (this.musicGain) {
      try { this.musicGain.disconnect(); } catch { /* */ }
      this.musicGain = null;
    }
    this.procState = null;
    if (this.midiEffects) {
      destroyMidiEffectsChain(this.midiEffects);
      this.midiEffects = null;
    }
    // Release the parsed MIDI so a destroyed player drops its note
    // data; the next start() after a re-init reloads lazily.
    this.midiState = createMidiState();
    this.ctx = null;
  }

  // ---- Private: scheduling ----

  private scheduleLoop(): void {
    if (!this.ctx || !this.playing) return;

    if (this.midiState.mode) {
      const target = this.midiEffects?.noteTarget ?? this.musicGain!;
      scheduleMidiLoop(this.ctx, this.midiState, target, this.pendingCleanups);
    } else if (this.procState) {
      scheduleProceduralLoop(
        this.ctx.currentTime,
        this.procState,
        (type, freq, gain, startTime, duration, attack, release) =>
          this.createNoteOsc(type, freq, gain, startTime, duration, attack, release),
        (type, freq, gain, startTime, duration, filterFreq, attack, release) =>
          this.createFilteredNote(type, freq, gain, startTime, duration, filterFreq, attack, release),
      );
    }
  }

  // ---- Note creation helpers (procedural voices) ----

  private createNoteOsc(
    type: OscillatorType, freq: number, gain: number,
    startTime: number, duration: number, attack = 0.02, release = 0.05,
  ): void {
    if (!this.ctx || !this.musicGain) return;

    const osc = this.ctx.createOscillator();
    const gainNode = this.ctx.createGain();

    osc.type = type;
    osc.frequency.value = freq;
    gainNode.gain.setValueAtTime(0.0001, startTime);
    gainNode.gain.linearRampToValueAtTime(gain, startTime + attack);
    gainNode.gain.setValueAtTime(gain, startTime + duration - release);
    gainNode.gain.linearRampToValueAtTime(0.0001, startTime + duration);

    osc.connect(gainNode).connect(this.musicGain);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.01);

    const cleanupDelay = (startTime - this.ctx.currentTime + duration + 0.1) * 1000;
    const tid = setTimeout(() => {
      this.pendingCleanups.delete(tid);
      try { gainNode.disconnect(); } catch { /* */ }
    }, Math.max(cleanupDelay, 50));
    this.pendingCleanups.add(tid);
  }

  private createFilteredNote(
    type: OscillatorType, freq: number, gain: number,
    startTime: number, duration: number, filterFreq: number,
    attack = 0.02, release = 0.05,
  ): void {
    if (!this.ctx || !this.musicGain) return;

    const osc = this.ctx.createOscillator();
    const gainNode = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();

    osc.type = type;
    osc.frequency.value = freq;
    filter.type = 'lowpass';
    filter.frequency.value = filterFreq;
    filter.Q.value = 1;

    gainNode.gain.setValueAtTime(0.0001, startTime);
    gainNode.gain.linearRampToValueAtTime(gain, startTime + attack);
    gainNode.gain.setValueAtTime(gain, startTime + duration - release);
    gainNode.gain.linearRampToValueAtTime(0.0001, startTime + duration);

    osc.connect(filter).connect(gainNode).connect(this.musicGain);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.01);

    const cleanupDelay = (startTime - this.ctx.currentTime + duration + 0.1) * 1000;
    const tid = setTimeout(() => {
      this.pendingCleanups.delete(tid);
      try { gainNode.disconnect(); } catch { /* */ }
    }, Math.max(cleanupDelay, 50));
    this.pendingCleanups.add(tid);
  }
}

export const musicPlayer = new MusicPlayer();
