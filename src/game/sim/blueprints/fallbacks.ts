import type { UnitBodyShape } from './types';

export const FALLBACK_UNIT_BODY_SHAPE = {
  kind: 'composite',
  parts: [
    { kind: 'circle', offsetForward: -1.1, radiusFrac: 1.15, yFrac: 1.15 },
    { kind: 'circle', offsetForward: 0.3, radiusFrac: 0.55, yFrac: 0.55 },
  ],
} satisfies UnitBodyShape;
