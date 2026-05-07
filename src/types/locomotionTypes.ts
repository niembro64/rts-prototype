// Runtime locomotion profile used by movement physics and rendering.

export type UnitLocomotion = {
  type: 'wheels' | 'treads' | 'legs';
  /** Authored propulsion scalar supplied by the locomotion blueprint. */
  driveForce: number;
  /** Ground traction coefficient. This is coupling to terrain, not drag. */
  traction: number;
};
