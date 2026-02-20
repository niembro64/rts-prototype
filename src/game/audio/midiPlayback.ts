// MIDI file loading, scheduling, note oscillator creation, and effects chain.

import { Midi } from '@tonejs/midi';
import { AUDIO } from '../../audioConfig';
import { LOOK_AHEAD } from './proceduralMusic';

export interface MidiNote {
  midi: number;
  time: number;
  duration: number;
  velocity: number;
}

/** Mutable state for the MIDI player. */
export interface MidiState {
  notes: MidiNote[] | null;
  duration: number;       // total length of MIDI in seconds
  loaded: boolean;
  loadPromise: Promise<void> | null;
  startOffset: number;    // audioContext time when playback began
  position: number;       // next note index to schedule
  mode: boolean;          // true when currently playing in MIDI mode
}

export function createMidiState(): MidiState {
  return {
    notes: null,
    duration: 0,
    loaded: false,
    loadPromise: null,
    startOffset: 0,
    position: 0,
    mode: false,
  };
}

/** Effects chain nodes created for MIDI playback. */
export interface MidiEffectsChain {
  noteTarget: GainNode;          // oscillators connect here
  compressor: DynamicsCompressorNode | null;
  reverbConvolver: ConvolverNode | null;
  reverbDryGain: GainNode | null;
  reverbWetGain: GainNode | null;
}

/** Build the MIDI effects chain: noteTarget → [compressor] → [reverb dry/wet] → musicGain. */
export function buildMidiEffectsChain(ctx: AudioContext, musicGain: GainNode): MidiEffectsChain {
  const mc = AUDIO.midi;

  const noteTarget = ctx.createGain();
  noteTarget.gain.value = 1;

  let chainTail: AudioNode = noteTarget;
  let compressor: DynamicsCompressorNode | null = null;
  let reverbConvolver: ConvolverNode | null = null;
  let reverbDryGain: GainNode | null = null;
  let reverbWetGain: GainNode | null = null;

  // Compressor
  if (mc.compressor) {
    compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = mc.compressorThreshold;
    compressor.knee.value = mc.compressorKnee;
    compressor.ratio.value = mc.compressorRatio;
    compressor.attack.value = mc.compressorAttack;
    compressor.release.value = mc.compressorRelease;
    chainTail.connect(compressor);
    chainTail = compressor;
  }

  // Reverb (synthetic impulse response with dry/wet mix)
  if (mc.reverb) {
    const sampleRate = ctx.sampleRate;
    const length = Math.floor(sampleRate * mc.reverbDecay);
    const impulse = ctx.createBuffer(2, length, sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2);
      }
    }

    reverbConvolver = ctx.createConvolver();
    reverbConvolver.buffer = impulse;

    reverbDryGain = ctx.createGain();
    reverbDryGain.gain.value = 1 - mc.reverbMix;

    reverbWetGain = ctx.createGain();
    reverbWetGain.gain.value = mc.reverbMix;

    chainTail.connect(reverbDryGain);
    chainTail.connect(reverbConvolver);
    reverbConvolver.connect(reverbWetGain);

    reverbDryGain.connect(musicGain);
    reverbWetGain.connect(musicGain);
  } else {
    chainTail.connect(musicGain);
  }

  return { noteTarget, compressor, reverbConvolver, reverbDryGain, reverbWetGain };
}

/** Disconnect and release all effects chain nodes. */
export function destroyMidiEffectsChain(chain: MidiEffectsChain): void {
  const nodes = [chain.noteTarget, chain.compressor, chain.reverbConvolver, chain.reverbDryGain, chain.reverbWetGain];
  for (const node of nodes) {
    if (node) { try { node.disconnect(); } catch { /* */ } }
  }
}

/** Fetch and parse a MIDI file, populating state.notes/duration/loaded. */
export async function loadMidi(state: MidiState): Promise<void> {
  try {
    const url = `${import.meta.env.BASE_URL}${AUDIO.midiFile}`;
    console.log('[MusicPlayer] Fetching MIDI:', url);
    const response = await fetch(url);
    if (!response.ok) {
      console.warn('[MusicPlayer] MIDI fetch failed:', response.status, response.statusText);
      return;
    }
    const arrayBuffer = await response.arrayBuffer();
    console.log('[MusicPlayer] MIDI fetched, bytes:', arrayBuffer.byteLength);
    const midi = new Midi(arrayBuffer);
    console.log('[MusicPlayer] MIDI parsed, tracks:', midi.tracks.length);

    const notes: MidiNote[] = [];
    for (const track of midi.tracks) {
      console.log('[MusicPlayer] Track:', track.name, 'notes:', track.notes.length);
      for (const note of track.notes) {
        notes.push({
          midi: note.midi,
          time: note.time,
          duration: note.duration,
          velocity: note.velocity,
        });
      }
    }
    notes.sort((a, b) => a.time - b.time);

    if (notes.length === 0) {
      console.warn('[MusicPlayer] MIDI file has no notes');
      return;
    }

    const lastNote = notes[notes.length - 1];
    state.duration = lastNote.time + lastNote.duration;
    state.notes = notes;
    state.loaded = true;
    console.log('[MusicPlayer] MIDI ready:', notes.length, 'notes,', state.duration.toFixed(1), 'sec');
  } catch (err) {
    console.error('[MusicPlayer] MIDI load error:', err);
  }
}

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Schedule MIDI notes within the look-ahead window. */
export function scheduleMidiLoop(
  ctx: AudioContext,
  state: MidiState,
  target: AudioNode,
  pendingCleanups: Set<ReturnType<typeof setTimeout>>,
): void {
  if (!state.notes) return;
  const mc = AUDIO.midi;

  const now = ctx.currentTime;
  const deadline = now + LOOK_AHEAD;

  const rawElapsed = (deadline - state.startOffset) * mc.speed;
  if (rawElapsed < 0) return;

  const currentElapsed = (now - state.startOffset) * mc.speed;
  const currentLoopStart = Math.floor(currentElapsed / state.duration) * state.duration;
  const deadlineLoopStart = Math.floor(rawElapsed / state.duration) * state.duration;

  if (deadlineLoopStart > currentLoopStart || (state.position >= state.notes.length)) {
    state.position = 0;
  }

  while (state.position < state.notes.length) {
    const note = state.notes[state.position];
    const noteRealTime = state.startOffset + (deadlineLoopStart + note.time) / mc.speed;

    if (noteRealTime > deadline) break;
    if (noteRealTime < now - 0.05) {
      state.position++;
      continue;
    }

    const freq = midiToFreq(note.midi + mc.transpose);
    const gain = mc.gain * note.velocity;
    const duration = Math.max(note.duration / mc.speed, 0.05);

    createMidiNoteOsc(ctx, target, freq, gain, noteRealTime, duration, pendingCleanups);
    state.position++;
  }
}

/**
 * Create MIDI note oscillator(s) with full ADSR envelope, optional vibrato/tremolo,
 * optional per-note filter, and unison voice support.
 */
function createMidiNoteOsc(
  ctx: AudioContext,
  target: AudioNode,
  freq: number,
  peakGain: number,
  startTime: number,
  duration: number,
  pendingCleanups: Set<ReturnType<typeof setTimeout>>,
): void {
  const mc = AUDIO.midi;
  const numVoices = Math.max(1, Math.round(mc.voices));

  // ADSR timing
  const attackEnd = startTime + mc.attack;
  const decayEnd = attackEnd + mc.decay;
  const sustainGain = peakGain * mc.sustain;
  const noteOff = startTime + duration;
  const releaseEnd = noteOff + mc.release;
  const oscStop = releaseEnd + 0.01;

  // Shared ADSR envelope gain node
  const envGain = ctx.createGain();
  envGain.gain.setValueAtTime(0.0001, startTime);
  envGain.gain.linearRampToValueAtTime(peakGain, attackEnd);
  if (mc.decay > 0) {
    envGain.gain.linearRampToValueAtTime(sustainGain, decayEnd);
  }
  envGain.gain.setValueAtTime(sustainGain, noteOff);
  if (mc.release > 0) {
    envGain.gain.linearRampToValueAtTime(0.0001, releaseEnd);
  } else {
    envGain.gain.linearRampToValueAtTime(0.0001, noteOff + 0.005);
  }

  // Optional tremolo LFO
  if (mc.tremolo) {
    const tremoloLfo = ctx.createOscillator();
    const tremoloGainNode = ctx.createGain();
    tremoloLfo.type = 'sine';
    tremoloLfo.frequency.value = mc.tremoloRate;
    tremoloGainNode.gain.value = mc.tremoloDepth * 0.5;
    tremoloLfo.connect(tremoloGainNode).connect(envGain.gain);
    tremoloLfo.start(startTime);
    tremoloLfo.stop(oscStop);
  }

  // Destination after envelope: optional filter → target
  if (mc.filter) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = mc.filterFreq;
    filter.Q.value = mc.filterQ;
    envGain.connect(filter).connect(target);
  } else {
    envGain.connect(target);
  }

  // Create oscillator voices
  const perVoiceGain = 1 / numVoices;
  const period = 1 / freq;
  for (let v = 0; v < numVoices; v++) {
    const osc = ctx.createOscillator();
    osc.type = mc.wave;

    if (numVoices > 1) {
      const t = (v / (numVoices - 1)) * 2 - 1;
      osc.detune.value = t * mc.voiceDetune;
    }
    osc.frequency.value = freq;

    const phaseOffset = numVoices > 1 ? (v / numVoices) * period : 0;

    // Optional vibrato LFO
    if (mc.vibrato) {
      const vibratoLfo = ctx.createOscillator();
      const vibratoGainNode = ctx.createGain();
      vibratoLfo.type = 'sine';
      vibratoLfo.frequency.value = mc.vibratoRate;
      vibratoGainNode.gain.value = freq * (Math.pow(2, mc.vibratoDepth / 1200) - 1);
      vibratoLfo.connect(vibratoGainNode).connect(osc.frequency);
      vibratoLfo.start(startTime - phaseOffset);
      vibratoLfo.stop(oscStop);
    }

    const voiceGainNode = ctx.createGain();
    voiceGainNode.gain.value = perVoiceGain;
    osc.connect(voiceGainNode).connect(envGain);

    osc.start(startTime - phaseOffset);
    osc.stop(oscStop);
  }

  // Cleanup after note + release finishes
  const totalDuration = duration + mc.release;
  const cleanupDelay = (startTime - ctx.currentTime + totalDuration + 0.1) * 1000;
  const tid = setTimeout(() => {
    pendingCleanups.delete(tid);
    try { envGain.disconnect(); } catch { /* */ }
  }, Math.max(cleanupDelay, 50));
  pendingCleanups.add(tid);
}
