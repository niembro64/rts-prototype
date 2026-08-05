// Cap-aware UV remapping for charted cylinders.
//
// THE PROBLEM. THREE.CylinderGeometry gives its flat end caps a disc of UVs
// centred on (0.5, 0.5) with radius 0.5 — the same coordinates the curved wall
// already occupies. Anything drawn for the cap therefore lands in the middle of
// the tube, and anything drawn for the tube is what the cap actually shows. A
// barrel that wants a bright machined rim around a black bore cannot express it
// at all: the cap can only ever display whatever is at the band's centre.
//
// THE FIX. Split the band's v range. The wall keeps a lower slice, the caps get
// a reserved slice above it, and the cap's UVs are re-derived POLAR: u carries
// the angle around the face, v carries the radius from centre to rim. Two
// things follow, and both are what make the faces work:
//
//   * A horizontal stripe in the cap's zone becomes a concentric RING on the
//     face, so a rim, a bore and the steps between them are just rows.
//   * A feature at a particular u becomes a feature at a particular ANGLE, so a
//     ring of discrete bolts is drawable rather than smearing into a band.
//
// The remap is applied to the geometry, so it costs nothing per frame and
// nothing per instance.

import type * as THREE from 'three';

export type ChartedCylinderUvLayout = {
  /** Fraction of the band's v the curved wall occupies, measured from v = 0.
   *  The remainder is the cap zone. */
  wallVEnd: number;
  /** v of the cap's CENTRE — the middle of the face. */
  capCenterV: number;
  /** v of the cap's RIM — its outer edge. */
  capRimV: number;
};

/**
 * Rewrite a cylinder's UVs so its caps address a reserved radial zone.
 *
 * Wall vertices are identified by their normal being roughly perpendicular to
 * the cylinder's axis; cap vertices point along it. That test is on the
 * geometry's own normals, so it survives whatever segment counts the tier
 * happens to use.
 *
 * Both caps map to the same zone. For a barrel that is correct by luck and by
 * design: the breech cap is buried inside the turret head, so the only face
 * anyone sees is the muzzle.
 */
export function remapChartedCylinderUvs(
  geometry: THREE.BufferGeometry,
  layout: ChartedCylinderUvLayout,
): void {
  const uvAttr = geometry.getAttribute('uv');
  const normalAttr = geometry.getAttribute('normal');
  if (uvAttr === undefined || normalAttr === undefined) return;

  for (let i = 0; i < uvAttr.count; i++) {
    const axial = Math.abs(normalAttr.getY(i));
    if (axial < 0.5) {
      // Curved wall: keep the parameterization, compress it into its slice.
      uvAttr.setY(i, uvAttr.getY(i) * layout.wallVEnd);
      continue;
    }
    // Cap: the incoming uv is a disc about (0.5, 0.5) of radius 0.5. Re-derive
    // it as (angle, radius) so rows become rings and columns become angles.
    const dx = uvAttr.getX(i) - 0.5;
    const dy = uvAttr.getY(i) - 0.5;
    const radius = Math.min(1, Math.hypot(dx, dy) / 0.5);
    const angle = Math.atan2(dy, dx);
    uvAttr.setXY(
      i,
      angle / (Math.PI * 2) + 0.5,
      layout.capCenterV + radius * (layout.capRimV - layout.capCenterV),
    );
  }
  uvAttr.needsUpdate = true;
}
