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

export class MusicPlayer {
  private ctx: AudioContext | null = null;
  private musicGain: GainNode | null = null;
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

  init(ctx: AudioContext, masterGain: GainNode): void {
    if (this.musicGain) return; // already initialized
    this.ctx = ctx;
    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = AUDIO.musicGain;
    this.musicGain.connect(masterGain);
  }

  start(): void {
    if (this.playing || !this.ctx || !this.musicGain) return;
    this.playing = true;

    // Fade in music gain
    const now = this.ctx.currentTime;
    this.musicGain.gain.setValueAtTime(0.0001, now);
    this.musicGain.gain.linearRampToValueAtTime(AUDIO.musicGain, now + 2);

    // Start scheduling from next beat
    this.nextBeatTime = now + 0.1; // small delay to let fade-in begin
    this.currentBeat = 0;
    this.currentBar = 0;

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
  }

  // ---- Private: scheduling ----

  private scheduleLoop(): void {
    if (!this.ctx || !this.playing) return;
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

  // ---- Note creation helpers ----

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
