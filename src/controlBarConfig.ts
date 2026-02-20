/**
 * Control Bar Configuration
 *
 * All bar-related settings in one place: themes, localStorage keys,
 * battle/server/client bar options, and unit short names.
 */

export type SnapshotRate = number | 'none';
export type KeyframeRatio = number | 'ALL' | 'NONE';
export type TickRate = number;

export const CONTROL_BARS = {
  // ── Color themes ──
  themes: {
    battle: {
      barBg: 'rgba(25, 18, 6, 0.7)',
      time: '#cc9944',
      activeBg: 'rgba(170, 120, 40, 0.9)',
      activeBorder: '#cc9944',
      activeHoverBg: 'rgba(190, 138, 50, 0.95)',
      activeHoverBorder: '#ddaa55',
      activePressedBg: 'rgba(145, 100, 32, 0.95)',
      activePressedBorder: '#aa8833',
    },
    server: {
      barBg: 'rgba(8, 8, 25, 0.7)',
      time: '#8888cc',
      activeBg: 'rgba(68, 68, 170, 0.9)',
      activeBorder: '#6666cc',
      activeHoverBg: 'rgba(80, 80, 195, 0.95)',
      activeHoverBorder: '#7777dd',
      activePressedBg: 'rgba(55, 55, 145, 0.95)',
      activePressedBorder: '#5555aa',
    },
    client: {
      barBg: 'rgba(8, 20, 8, 0.7)',
      time: '#6a6',
      activeBg: 'rgba(68, 136, 68, 0.9)',
      activeBorder: '#6a6',
      activeHoverBg: 'rgba(80, 155, 80, 0.95)',
      activeHoverBorder: '#7b7',
      activePressedBg: 'rgba(55, 115, 55, 0.95)',
      activePressedBorder: '#595',
    },
    disabled: {
      barBg: 'rgba(15, 15, 15, 0.7)',
      time: '#888',
      activeBg: 'rgba(80, 80, 80, 0.9)',
      activeBorder: '#888',
      activeHoverBg: 'rgba(80, 80, 80, 0.9)',
      activeHoverBorder: '#888',
      activePressedBg: 'rgba(80, 80, 80, 0.9)',
      activePressedBorder: '#888',
    },
  },

  // ── localStorage keys ──
  storage: {
    snapshotRate: 'rts-snapshot-rate',
    keyframeRatio: 'rts-keyframe-ratio',
    tickRate: 'rts-tick-rate',
    demoUnits: 'rts-demo-units',
    maxTotalUnits: 'rts-max-total-units',
    projVelInherit: 'rts-proj-vel-inherit',
  },

  // ── Battle bar ──
  battle: {
    unitShortNames: {
      jackal: 'JKL',
      lynx: 'LNX',
      daddy: 'DDY',
      badger: 'BDG',
      mongoose: 'MGS',
      recluse: 'RCL',
      mammoth: 'MMT',
      widow: 'WDW',
      tarantula: 'TRN',
    } as Record<string, string>,
    cap: {
      default: 4000,
      options: [
        { value: 4, label: '4' },
        { value: 10, label: '10' },
        { value: 40, label: '40' },
        { value: 100, label: '1h' },
        { value: 400, label: '4h' },
        { value: 1000, label: '1k' },
        { value: 4000, label: '4k' },
        { value: 10000, label: '10k' },
      ],
    },
    projVelInherit: { default: false },
  },

  // ── Server bar ──
  server: {
    tickRate: {
      default: 90 as TickRate,
      options: [1, 5, 10, 20, 30, 60, 90, 120, 240] as readonly TickRate[],
    },
    snapshot: {
      default: 30 as SnapshotRate,
      options: [
        1,
        5,
        10,
        20,
        30,
        45,
        60,
        120,
        'none',
      ] as readonly SnapshotRate[],
    },
    keyframe: {
      default: 0.01 as KeyframeRatio,
      options: [
        'ALL',
        0.1,
        0.01,
        0.001,
        0.0001,
        0.00001,
        'NONE',
      ] as readonly KeyframeRatio[],
    },
  },

  // ── Client bar ──
  client: {
    graphics: {
      options: [
        { value: 'min', label: 'MIN' },
        { value: 'low', label: 'LOW' },
        { value: 'medium', label: 'MED' },
        { value: 'high', label: 'HI' },
        { value: 'max', label: 'MAX' },
      ],
    },
    render: {
      options: [
        { value: 'window', label: 'WIN' },
        { value: 'padded', label: 'PAD' },
        { value: 'all', label: 'ALL' },
      ],
    },
    audio: {
      options: [
        { value: 'off', label: 'OFF' },
        { value: 'window', label: 'WIN' },
        { value: 'padded', label: 'PAD' },
        { value: 'all', label: 'ALL' },
      ],
    },
  },
} as const;
