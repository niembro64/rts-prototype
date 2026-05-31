export type CameraAnchorScreen = 'cursor' | 'screen-center';

export type CameraAnchorTerrain = 'plane-2d' | 'terrain-3d' | 'terrain-3d-water';

export type CameraAnchor = {
  readonly screen: CameraAnchorScreen;
  readonly terrain: CameraAnchorTerrain;
};

/** How the orbit camera resolves a frame where the eye would sit below
 *  terrain. Every mode keeps the camera looking at the orbit target, and
 *  NONE of them write terrain back into the orbit state (so zoom limits
 *  stay absolute and history-independent). They differ only in which
 *  rendered quantity absorbs the clearance:
 *
 *  - 'none'       — no clearance; the eye may pass under the heightfield.
 *  - 'raiseEye'   — lift only the eye's Y until it clears. Keeps the
 *                   eye's horizontal footprint and the focus centered;
 *                   the true eye→target distance grows and the view
 *                   steepens, so the eye leaves the orbit sphere.
 *  - 'clampPitch' — steepen the pitch (swing the eye up the orbit arc)
 *                   until it clears. Keeps the eye ON the orbit sphere at
 *                   the stored distance and the focus centered; only the
 *                   effective pitch diverges from the stored pitch. */
export type CameraTerrainCollisionMode = 'none' | 'raiseEye' | 'clampPitch';
