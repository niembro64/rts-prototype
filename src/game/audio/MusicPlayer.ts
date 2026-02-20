import { Midi } from '@tonejs/midi';
import { AUDIO } from '../../audioConfig';

// A minor pentatonic scale MIDI notes by octave
// A=57, C=60, D=62, E=64, G=67 (octave 3)
const SCALE = [0, 3, 5, 7, 10]; // semitone offsets from root A

// 8-bar chord progression: MIDI root notes (octave 3 = 57..67)
// Am, C, Dm, Em, Am, G, Dm, Am
const PROGRESSION = [57, 60, 62, 64, 57, 67, 62, 57];

// Arpeggio patterns (indices into pentatonic scale)
const ARP_PATTERNS = [
  [0, 1, 2, 3, 4, 3, 2, 1],   // ascending-descending
  [0, 2, 4, 2, 0, 1, 3, 1],   // pendulum
  [4, 3, 2, 1, 0, 1, 2, 3],   // descending-ascending
  [0, 4, 1, 3, 2, 4, 0, 3],   // scattered
];

// Melody intervals from root (pentatonic scale degrees, higher octave)
const MELODY_INTERVALS = [0, 3, 5, 7, 10, 12, 15];

const BPM = 110;
const BEAT_DURATION = 60 / BPM;           // ~0.545s
const BAR_DURATION = BEAT_DURATION * 4;    // ~2.18s
const SCHEDULER_INTERVAL = 25;             // ms
const LOOK_AHEAD = 0.1;                    // seconds

interface MidiNote {
  midi: number;
  time: number;
  duration: number;
  velocity: number;
}

export class MusicPlayer {
  private ctx: AudioContext | null = null;
  private musicGain: GainNode | null = null;
  // The node that per-note oscillators connect to (musicGain for procedural, midiNoteTarget for MIDI with effects)
  private midiNoteTarget: GainNode | null = null;
  private playing = false;
  private schedulerInterval: ReturnType<typeof setInterval> | null = null;
  private nextBeatTime = 0;
  private currentBeat = 0;   // 0-3 within bar
  private currentBar = 0;    // 0-7 within progression
  private sectionCount = 0;  // full 8-bar cycle counter
  private arpPatternIndex = 0;
  private melodyNote = 7;    // current melody MIDI offset from root (start on root)
  private pendingCleanups = new Set<ReturnType<typeof setTimeout>>();

  // Track key transposition (semitones up from original)
  private keyOffset = 0;

  // MIDI playback state
  private midiNotes: MidiNote[] | null = null;
  private midiDuration = 0;
  private midiLoaded = false;
  private midiLoadPromise: Promise<void> | null = null;
  private midiStartOffset = 0;
  private midiPosition = 0;
  private midiMode = false; // true when currently playing in MIDI mode

  // MIDI effects chain nodes
  private compressorNode: DynamicsCompressorNode | null = null;
  private reverbConvolver: ConvolverNode | null = null;
  private reverbDryGain: GainNode | null = null;
  private reverbWetGain: GainNode | null = null;

  init(ctx: AudioContext, masterGain: GainNode): void {
    if (this.musicGain) return; // already initialized
    this.ctx = ctx;
    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = AUDIO.musicGain;

    // Build MIDI effects chain: midiNoteTarget → [compressor] → [reverb dry/wet] → musicGain → masterGain
    this.buildMidiEffectsChain(ctx, masterGain);

    // Kick off async MIDI load (non-blocking, but store promise so start() can await it)
    this.midiLoadPromise = this.loadMidi();
  }

  private buildMidiEffectsChain(ctx: AudioContext, masterGain: GainNode): void {
    const mc = AUDIO.midi;

    // midiNoteTarget is what MIDI oscillators connect to
    this.midiNoteTarget = ctx.createGain();
    this.midiNoteTarget.gain.value = 1;

    // Chain: midiNoteTarget → compressor (optional) → reverb dry/wet (optional) → musicGain → masterGain
    let chainTail: AudioNode = this.midiNoteTarget;

    // Compressor
    if (mc.compressor) {
      this.compressorNode = ctx.createDynamicsCompressor();
      this.compressorNode.threshold.value = mc.compressorThreshold;
      this.compressorNode.knee.value = mc.compressorKnee;
      this.compressorNode.ratio.value = mc.compressorRatio;
      this.compressorNode.attack.value = mc.compressorAttack;
      this.compressorNode.release.value = mc.compressorRelease;
      chainTail.connect(this.compressorNode);
      chainTail = this.compressorNode;
    }

    // Reverb (synthetic impulse response with dry/wet mix)
    if (mc.reverb) {
      // Generate impulse response: decaying white noise
      const sampleRate = ctx.sampleRate;
      const length = Math.floor(sampleRate * mc.reverbDecay);
      const impulse = ctx.createBuffer(2, length, sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const data = impulse.getChannelData(ch);
        for (let i = 0; i < length; i++) {
          data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2);
        }
      }

      this.reverbConvolver = ctx.createConvolver();
      this.reverbConvolver.buffer = impulse;

      this.reverbDryGain = ctx.createGain();
      this.reverbDryGain.gain.value = 1 - mc.reverbMix;

      this.reverbWetGain = ctx.createGain();
      this.reverbWetGain.gain.value = mc.reverbMix;

      // Split: chainTail → dry path + wet path → musicGain
      chainTail.connect(this.reverbDryGain);
      chainTail.connect(this.reverbConvolver);
      this.reverbConvolver.connect(this.reverbWetGain);

      this.reverbDryGain.connect(this.musicGain!);
      this.reverbWetGain.connect(this.musicGain!);
    } else {
      // No reverb: straight through
      chainTail.connect(this.musicGain!);
    }

    // musicGain → masterGain (final output)
    this.musicGain!.connect(masterGain);
  }

  start(): void {
    if (this.playing || !this.ctx || !this.musicGain) return;

    // If MIDI mode requested but not yet loaded, wait for load then start
    if (AUDIO.musicSource === 'midi' && !this.midiLoaded && this.midiLoadPromise) {
      this.midiLoadPromise.then(() => {
        if (!this.playing) this.beginPlayback();
      });
      return;
    }

    this.beginPlayback();
  }

  private beginPlayback(): void {
    if (this.playing || !this.ctx || !this.musicGain) return;
    this.playing = true;

    // Fade in music gain
    const now = this.ctx.currentTime;
    this.musicGain.gain.setValueAtTime(0.0001, now);
    this.musicGain.gain.linearRampToValueAtTime(AUDIO.musicGain, now + 2);

    // Decide mode: use MIDI if configured and loaded, otherwise procedural
    console.log('[MusicPlayer] beginPlayback — source:', AUDIO.musicSource, 'midiLoaded:', this.midiLoaded, 'notes:', this.midiNotes?.length ?? 0);
    if (AUDIO.musicSource === 'midi' && this.midiLoaded && this.midiNotes) {
      this.midiMode = true;
      this.midiStartOffset = now + 0.1;
      this.midiPosition = 0;
      console.log('[MusicPlayer] Starting MIDI playback');
    } else {
      this.midiMode = false;
      // Start scheduling from next beat
      this.nextBeatTime = now + 0.1; // small delay to let fade-in begin
      this.currentBeat = 0;
      this.currentBar = 0;
      console.log('[MusicPlayer] Starting procedural playback');
    }

    this.schedulerInterval = setInterval(() => this.scheduleLoop(), SCHEDULER_INTERVAL);
  }

  stop(): void {
    if (!this.playing || !this.ctx || !this.musicGain) return;
    this.playing = false;

    // Fade out
    const now = this.ctx.currentTime;
    this.musicGain.gain.cancelScheduledValues(now);
    this.musicGain.gain.setValueAtTime(this.musicGain.gain.value, now);
    this.musicGain.gain.linearRampToValueAtTime(0.0001, now + 1);

    // Stop scheduler after fade
    const fadeTimeout = setTimeout(() => {
      this.pendingCleanups.delete(fadeTimeout);
      if (this.schedulerInterval) {
        clearInterval(this.schedulerInterval);
        this.schedulerInterval = null;
      }
    }, 1100);
    this.pendingCleanups.add(fadeTimeout);
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
    if (this.midiNoteTarget) {
      try { this.midiNoteTarget.disconnect(); } catch { /* */ }
      this.midiNoteTarget = null;
    }
    if (this.compressorNode) {
      try { this.compressorNode.disconnect(); } catch { /* */ }
      this.compressorNode = null;
    }
    if (this.reverbConvolver) {
      try { this.reverbConvolver.disconnect(); } catch { /* */ }
      this.reverbConvolver = null;
    }
    if (this.reverbDryGain) {
      try { this.reverbDryGain.disconnect(); } catch { /* */ }
      this.reverbDryGain = null;
    }
    if (this.reverbWetGain) {
      try { this.reverbWetGain.disconnect(); } catch { /* */ }
      this.reverbWetGain = null;
    }
  }

  // ---- MIDI loading ----

  private async loadMidi(): Promise<void> {
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

      // Collect all notes from all tracks, sorted by time
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

      // Duration: end of last note
      const lastNote = notes[notes.length - 1];
      this.midiDuration = lastNote.time + lastNote.duration;
      this.midiNotes = notes;
      this.midiLoaded = true;
      console.log('[MusicPlayer] MIDI ready:', notes.length, 'notes,', this.midiDuration.toFixed(1), 'sec');
    } catch (err) {
      console.error('[MusicPlayer] MIDI load error:', err);
    }
  }

  // ---- Private: scheduling ----

  private scheduleLoop(): void {
    if (!this.ctx || !this.playing) return;

    if (this.midiMode) {
      this.scheduleMidiLoop();
    } else {
      this.scheduleProceduralLoop();
    }
  }

  private scheduleMidiLoop(): void {
    if (!this.ctx || !this.midiNotes) return;
    const mc = AUDIO.midi;

    const now = this.ctx.currentTime;
    const deadline = now + LOOK_AHEAD;

    // Calculate elapsed playback time with looping (speed-adjusted)
    const rawElapsed = (deadline - this.midiStartOffset) * mc.speed;
    if (rawElapsed < 0) return; // haven't started yet

    // Check if we've looped past the end — reset position if needed
    const currentElapsed = (now - this.midiStartOffset) * mc.speed;
    const currentLoopStart = Math.floor(currentElapsed / this.midiDuration) * this.midiDuration;
    const deadlineLoopStart = Math.floor(rawElapsed / this.midiDuration) * this.midiDuration;

    // If we crossed a loop boundary, reset position to start of notes
    if (deadlineLoopStart > currentLoopStart || (this.midiPosition >= this.midiNotes.length)) {
      this.midiPosition = 0;
    }

    // The destination node for MIDI notes (goes through effects chain)
    const target = this.midiNoteTarget ?? this.musicGain!;

    // Schedule notes within the look-ahead window
    while (this.midiPosition < this.midiNotes.length) {
      const note = this.midiNotes[this.midiPosition];
      // Convert MIDI-time note position to real time (accounting for speed)
      const noteRealTime = this.midiStartOffset + (deadlineLoopStart + note.time) / mc.speed;

      if (noteRealTime > deadline) break; // past the look-ahead window
      if (noteRealTime < now - 0.05) {
        // Already past, skip
        this.midiPosition++;
        continue;
      }

      const freq = this.midiToFreq(note.midi + mc.transpose);
      const gain = mc.gain * note.velocity;
      const duration = Math.max(note.duration / mc.speed, 0.05);

      this.createMidiNoteOsc(target, freq, gain, noteRealTime, duration);
      this.midiPosition++;
    }
  }

  /** Create a single MIDI note oscillator using midi config (wave, filter, envelope). */
  private createMidiNoteOsc(
    target: AudioNode,
    freq: number,
    gain: number,
    startTime: number,
    duration: number,
  ): void {
    if (!this.ctx) return;
    const mc = AUDIO.midi;

    const osc = this.ctx.createOscillator();
    const gainNode = this.ctx.createGain();

    osc.type = mc.wave;
    osc.frequency.value = freq;
    gainNode.gain.setValueAtTime(0.0001, startTime);
    gainNode.gain.linearRampToValueAtTime(gain, startTime + mc.attack);
    gainNode.gain.setValueAtTime(gain, startTime + duration - mc.release);
    gainNode.gain.linearRampToValueAtTime(0.0001, startTime + duration);

    if (mc.filter) {
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = mc.filterFreq;
      filter.Q.value = mc.filterQ;
      osc.connect(filter).connect(gainNode).connect(target);
    } else {
      osc.connect(gainNode).connect(target);
    }

    osc.start(startTime);
    osc.stop(startTime + duration + 0.01);

    // Cleanup after note finishes
    const cleanupDelay = (startTime - this.ctx.currentTime + duration + 0.1) * 1000;
    const tid = setTimeout(() => {
      this.pendingCleanups.delete(tid);
      try { gainNode.disconnect(); } catch { /* */ }
    }, Math.max(cleanupDelay, 50));
    this.pendingCleanups.add(tid);
  }

  private scheduleProceduralLoop(): void {
    if (!this.ctx) return;
    const deadline = this.ctx.currentTime + LOOK_AHEAD;

    while (this.nextBeatTime < deadline) {
      this.scheduleBeat(this.nextBeatTime, this.currentBeat, this.currentBar);

      // Advance
      this.currentBeat++;
      if (this.currentBeat >= 4) {
        this.currentBeat = 0;
        this.currentBar++;
        if (this.currentBar >= 8) {
          this.currentBar = 0;
          this.sectionCount++;
          this.onSectionComplete();
        }
      }
      this.nextBeatTime += BEAT_DURATION;
    }
  }

  private onSectionComplete(): void {
    // Rotate arpeggio pattern
    this.arpPatternIndex = (this.arpPatternIndex + 1) % ARP_PATTERNS.length;

    // Every 4 sections (32 bars): shift key up a fourth (+5 semitones), wrap at octave
    if (this.sectionCount % 4 === 0 && this.sectionCount > 0) {
      this.keyOffset = (this.keyOffset + 5) % 12;
    }
  }

  private scheduleBeat(time: number, beat: number, bar: number): void {
    this.scheduleBass(time, bar);
    this.schedulePad(time, bar);
    this.scheduleArpeggio(time, beat, bar);
    this.scheduleMelody(time, beat, bar);
  }

  // ---- Voice: Bass (sine, low octave, sustained per bar) ----

  private scheduleBass(time: number, bar: number): void {
    // Only play on beat 0 of each bar (sustained whole note)
    if (this.currentBeat !== 0) return;

    // Drop bass voice every other section for variation
    if (this.sectionCount % 3 === 2 && bar >= 4) return;

    const root = this.getChordRoot(bar);
    const freq = this.midiToFreq(root - 27 + this.keyOffset); // A2 range

    this.createNoteOsc('triangle', freq, 0.22, time, BAR_DURATION * 0.95, 0.15, 0.3);
  }

  // ---- Voice: Pad (triangle, mid octave, two-note interval) ----

  private schedulePad(time: number, bar: number): void {
    // Sustained per bar, beat 0 only
    if (this.currentBeat !== 0) return;

    const root = this.getChordRoot(bar);
    const freq1 = this.midiToFreq(root + this.keyOffset);       // root
    const freq2 = this.midiToFreq(root + 7 + this.keyOffset);   // perfect fifth

    // Two oscillators for the pad, with lowpass filtering
    this.createFilteredNote('triangle', freq1, 0.10, time, BAR_DURATION * 0.9, 800, 0.2, 0.35);
    this.createFilteredNote('triangle', freq2, 0.08, time, BAR_DURATION * 0.9, 800, 0.2, 0.35);
  }

  // ---- Voice: Arpeggio (triangle, mid-high octave, eighth notes) ----

  private scheduleArpeggio(time: number, beat: number, bar: number): void {
    // Drop arpeggio for variety in certain bars
    if (this.sectionCount % 4 === 3 && bar >= 6) return;

    const pattern = ARP_PATTERNS[this.arpPatternIndex];
    const root = this.getChordRoot(bar);

    // Two eighth notes per beat
    for (let eighth = 0; eighth < 2; eighth++) {
      const patIdx = (beat * 2 + eighth) % pattern.length;
      const scaleIdx = pattern[patIdx];
      const midi = root  + SCALE[scaleIdx % SCALE.length] + this.keyOffset;
      const freq = this.midiToFreq(midi);
      const noteTime = time + eighth * (BEAT_DURATION / 2);
      const noteDuration = BEAT_DURATION / 2 * 0.8; // slight gap between notes

      this.createNoteOsc('triangle', freq, 0.09, noteTime, noteDuration, 0.01, 0.05);
    }
  }

  // ---- Voice: Melody (triangle, high octave, quarter/half notes with rests) ----

  private scheduleMelody(time: number, beat: number, _bar: number): void {
    // 30% chance of rest
    if (Math.random() < 0.3) return;

    // Weighted random walk along melody intervals
    const step = Math.floor(Math.random() * 3) - 1; // -1, 0, or +1
    const idx = MELODY_INTERVALS.indexOf(this.melodyNote);
    let newIdx = idx + step;
    if (newIdx < 0) newIdx = 0;
    if (newIdx >= MELODY_INTERVALS.length) newIdx = MELODY_INTERVALS.length - 1;
    this.melodyNote = MELODY_INTERVALS[newIdx];

    const root = PROGRESSION[this.currentBar]; // use current bar's root
    const midi = root + 12 + this.melodyNote + this.keyOffset; // A5 range
    const freq = this.midiToFreq(midi);

    // Quarter note (occasionally half note on beats 0, 2)
    const isLong = (beat === 0 || beat === 2) && Math.random() < 0.3;
    const duration = isLong ? BEAT_DURATION * 2 * 0.85 : BEAT_DURATION * 0.85;

    this.createNoteOsc('triangle', freq, 0.07, time, duration, 0.02, 0.1);
  }

  // ---- Note creation helpers (procedural voices) ----

  private createNoteOsc(
    type: OscillatorType,
    freq: number,
    gain: number,
    startTime: number,
    duration: number,
    attack = 0.02,
    release = 0.05,
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

    // Cleanup after note finishes
    const cleanupDelay = (startTime - this.ctx.currentTime + duration + 0.1) * 1000;
    const tid = setTimeout(() => {
      this.pendingCleanups.delete(tid);
      try { gainNode.disconnect(); } catch { /* */ }
    }, Math.max(cleanupDelay, 50));
    this.pendingCleanups.add(tid);
  }

  private createFilteredNote(
    type: OscillatorType,
    freq: number,
    gain: number,
    startTime: number,
    duration: number,
    filterFreq: number,
    attack = 0.02,
    release = 0.05,
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

  private midiToFreq(midi: number): number {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  private getChordRoot(bar: number): number {
    return PROGRESSION[bar % PROGRESSION.length];
  }
}

export const musicPlayer = new MusicPlayer();
