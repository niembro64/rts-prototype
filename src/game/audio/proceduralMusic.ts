// Procedural music generation — scale/progression constants, beat scheduling,
// and four voices (bass, pad, arpeggio, melody).

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

export const SCHEDULER_INTERVAL = 25;      // ms
export const LOOK_AHEAD = 0.1;             // seconds

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function getChordRoot(bar: number): number {
  return PROGRESSION[bar % PROGRESSION.length];
}

/** Mutable state for the procedural generator. */
export interface ProceduralState {
  nextBeatTime: number;
  currentBeat: number;   // 0-3 within bar
  currentBar: number;    // 0-7 within progression
  sectionCount: number;  // full 8-bar cycle counter
  arpPatternIndex: number;
  melodyNote: number;    // current melody MIDI offset from root
  keyOffset: number;     // semitone transposition
}

export function createProceduralState(startTime: number): ProceduralState {
  return {
    nextBeatTime: startTime,
    currentBeat: 0,
    currentBar: 0,
    sectionCount: 0,
    arpPatternIndex: 0,
    melodyNote: 7,
    keyOffset: 0,
  };
}

export type NoteCreator = (
  type: OscillatorType, freq: number, gain: number,
  startTime: number, duration: number, attack?: number, release?: number,
) => void;

export type FilteredNoteCreator = (
  type: OscillatorType, freq: number, gain: number,
  startTime: number, duration: number, filterFreq: number,
  attack?: number, release?: number,
) => void;

/** Run the procedural scheduler — schedules beats up to the look-ahead window. */
export function scheduleProceduralLoop(
  ctxTime: number,
  state: ProceduralState,
  createNote: NoteCreator,
  createFiltered: FilteredNoteCreator,
): void {
  const deadline = ctxTime + LOOK_AHEAD;

  while (state.nextBeatTime < deadline) {
    scheduleBeat(state, state.nextBeatTime, state.currentBeat, state.currentBar, createNote, createFiltered);

    state.currentBeat++;
    if (state.currentBeat >= 4) {
      state.currentBeat = 0;
      state.currentBar++;
      if (state.currentBar >= 8) {
        state.currentBar = 0;
        state.sectionCount++;
        onSectionComplete(state);
      }
    }
    state.nextBeatTime += BEAT_DURATION;
  }
}

function onSectionComplete(state: ProceduralState): void {
  state.arpPatternIndex = (state.arpPatternIndex + 1) % ARP_PATTERNS.length;

  // Every 4 sections (32 bars): shift key up a fourth (+5 semitones), wrap at octave
  if (state.sectionCount % 4 === 0 && state.sectionCount > 0) {
    state.keyOffset = (state.keyOffset + 5) % 12;
  }
}

function scheduleBeat(
  state: ProceduralState, time: number, beat: number, bar: number,
  createNote: NoteCreator, createFiltered: FilteredNoteCreator,
): void {
  scheduleBass(state, time, bar, createNote);
  schedulePad(state, time, bar, createFiltered);
  scheduleArpeggio(state, time, beat, bar, createNote);
  scheduleMelody(state, time, beat, createNote);
}

// ---- Voice: Bass (sine, low octave, sustained per bar) ----
function scheduleBass(state: ProceduralState, time: number, bar: number, createNote: NoteCreator): void {
  if (state.currentBeat !== 0) return;
  if (state.sectionCount % 3 === 2 && bar >= 4) return;

  const root = getChordRoot(bar);
  const freq = midiToFreq(root - 27 + state.keyOffset);
  createNote('triangle', freq, 0.22, time, BAR_DURATION * 0.95, 0.15, 0.3);
}

// ---- Voice: Pad (triangle, mid octave, two-note interval) ----
function schedulePad(state: ProceduralState, time: number, bar: number, createFiltered: FilteredNoteCreator): void {
  if (state.currentBeat !== 0) return;

  const root = getChordRoot(bar);
  const freq1 = midiToFreq(root + state.keyOffset);
  const freq2 = midiToFreq(root + 7 + state.keyOffset);

  createFiltered('triangle', freq1, 0.10, time, BAR_DURATION * 0.9, 800, 0.2, 0.35);
  createFiltered('triangle', freq2, 0.08, time, BAR_DURATION * 0.9, 800, 0.2, 0.35);
}

// ---- Voice: Arpeggio (triangle, mid-high octave, eighth notes) ----
function scheduleArpeggio(state: ProceduralState, time: number, beat: number, bar: number, createNote: NoteCreator): void {
  if (state.sectionCount % 4 === 3 && bar >= 6) return;

  const pattern = ARP_PATTERNS[state.arpPatternIndex];
  const root = getChordRoot(bar);

  for (let eighth = 0; eighth < 2; eighth++) {
    const patIdx = (beat * 2 + eighth) % pattern.length;
    const scaleIdx = pattern[patIdx];
    const midi = root + SCALE[scaleIdx % SCALE.length] + state.keyOffset;
    const freq = midiToFreq(midi);
    const noteTime = time + eighth * (BEAT_DURATION / 2);
    const noteDuration = BEAT_DURATION / 2 * 0.8;

    createNote('triangle', freq, 0.09, noteTime, noteDuration, 0.01, 0.05);
  }
}

// ---- Voice: Melody (triangle, high octave, quarter/half notes with rests) ----
function scheduleMelody(state: ProceduralState, time: number, beat: number, createNote: NoteCreator): void {
  if (Math.random() < 0.3) return;

  const step = Math.floor(Math.random() * 3) - 1;
  const idx = MELODY_INTERVALS.indexOf(state.melodyNote);
  let newIdx = idx + step;
  if (newIdx < 0) newIdx = 0;
  if (newIdx >= MELODY_INTERVALS.length) newIdx = MELODY_INTERVALS.length - 1;
  state.melodyNote = MELODY_INTERVALS[newIdx];

  const root = PROGRESSION[state.currentBar];
  const midi = root + 12 + state.melodyNote + state.keyOffset;
  const freq = midiToFreq(midi);

  const isLong = (beat === 0 || beat === 2) && Math.random() < 0.3;
  const duration = isLong ? BEAT_DURATION * 2 * 0.85 : BEAT_DURATION * 0.85;

  createNote('triangle', freq, 0.07, time, duration, 0.02, 0.1);
}
