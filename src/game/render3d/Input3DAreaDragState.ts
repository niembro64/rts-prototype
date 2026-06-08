export type Input3DAreaDragKind =
  | 'repairArea'
  | 'reclaimArea'
  | 'attackArea'
  | 'buildMexArea'
  | 'buildLine';

export type Input3DAreaDragState = {
  active: boolean;
  kind: Input3DAreaDragKind;
  x: number;
  y: number;
  z?: number;
  endX?: number;
  endY?: number;
  endZ?: number;
  radius: number;
};

export const EMPTY_AREA_DRAG_STATE: Input3DAreaDragState = {
  active: false,
  kind: 'repairArea',
  x: 0,
  y: 0,
  radius: 0,
};
