import * as THREE from 'three';
import { EXTRACTOR_BUILDING_VISUAL_HEIGHT } from '../sim/blueprints';
import type { BuildingShape } from './BuildingShape3D';
import type { ProductionRateIndicatorRig } from './ConstructionEmitterMesh3D';
import { buildProductionRateIndicator } from './ConstructionEmitterMesh3D';
import {
  applyBasis,
  createHexFrustumGeometry,
  cylinderGeom,
  detail,
  extractorBladeMat,
  invisibleMat,
  makeBox,
} from './BuildingMeshPrimitives3D';

const extractorPyramidGeom = createHexFrustumGeometry();

/** Hexagonal frustum proportions (top/bottom radii) hard-coded in
 *  createHexFrustumGeometry. We re-derive the closed-pose blade slope
 *  from the same constants so it stays in lockstep with the pyramid art. */
const PYRAMID_TOP_RADIUS_FRACTION = 0.17;
const PYRAMID_BOTTOM_RADIUS_FRACTION = 0.5;
/** Hexagon edge-midpoint radius = corner radius × cos(π/6) = √3/2 ≈ 0.866.
 *  The pyramid corners sit at the circumscribed radius; each FACE midpoint
 *  sits at the INSCRIBED radius. The closed blade needs to land on the
 *  face midpoint, not the corner ridge, to actually cover the face. */
const HEX_INSCRIBED_RATIO = Math.sqrt(3) / 2;
/** Closed-pose stand-off from the pyramid surface (in world units). Push
 *  the folded blades a small distance OUTWARD along the face normal so
 *  they don't z-fight with the pyramid body and so the slightly-thick
 *  blade reads as a panel sitting on the face rather than embedded in it. */
const CLOSED_BLADE_STANDOFF = 0.4;

/** Per-blade open/closed transform pair. The animator stores the current
 *  blend factor (0 = open, 1 = closed) and slerps/lerps between these on
 *  each frame. Closed pose lays the blade flat against the matching
 *  trapezoidal pyramid face so the six blades together "cover" the
 *  building's sides. Scale is reshaped too — the open blade is a long
 *  paddle while the closed one matches the face's slant length × average
 *  width, so the blades read as plates wrapped around the base. */
export type ExtractorBladeAnim = {
  openPos: THREE.Vector3;
  closedPos: THREE.Vector3;
  openQuat: THREE.Quaternion;
  closedQuat: THREE.Quaternion;
  openScale: THREE.Vector3;
  closedScale: THREE.Vector3;
};

/** Per-LOD rotor meshes for the extractor. The detail system gates
 *  visibility by tier so only ONE rotor is on-screen at a time, but
 *  the animator advances the same yaw on every entry — flipping LOD
 *  bands is a free visibility toggle, no rebuild needed. */
export type ExtractorRig = {
  rotors: THREE.Mesh[];
  rateIndicator?: ProductionRateIndicatorRig;
};

/** Metal extractor detail.
 *
 *  The complete readable extractor silhouette is the six-sided pyramid
 *  plus one rotating shiny hub/blade assembly. That simple version
 *  intentionally remains the frontend shape so the extractor does not
 *  swap into busier decorative variants with camera distance.
 */
export function buildMetalExtractorMesh(
  width: number,
  depth: number,
  primaryMat: THREE.Material,
): BuildingShape {
  const minDim = Math.min(width, depth);
  const pyramidHeight = Math.min(EXTRACTOR_BUILDING_VISUAL_HEIGHT * 0.64, Math.max(28, minDim * 0.78));
  const base = new THREE.Mesh(extractorPyramidGeom, primaryMat);

  const details: BuildingShape['details'] = [];
  const ratePillarBaseY = pyramidHeight + 2;
  const shortRatePillarHeight = Math.max(10, Math.min(16, EXTRACTOR_BUILDING_VISUAL_HEIGHT - ratePillarBaseY - 4));
  const ratePillarHeight = shortRatePillarHeight * 2;
  const ratePillarRadius = Math.max(3.8, minDim * 0.055);
  const metalRateIndicator = buildProductionRateIndicator(
    'metal',
    ratePillarRadius * 1.7,
    ratePillarHeight,
    ratePillarBaseY,
    0,
    0,
    ratePillarRadius,
  );
  for (const mesh of metalRateIndicator.staticMeshes) {
    details.push(detail(mesh, 'low'));
  }
  details.push(detail(metalRateIndicator.rig.shower, 'low'));

  const rotorY = Math.min(
    EXTRACTOR_BUILDING_VISUAL_HEIGHT - 3,
    ratePillarBaseY + ratePillarHeight + Math.max(1.5, ratePillarRadius * 0.35),
  );

  const bladeLen = Math.max(32, minDim * 0.86);
  const bladeWidth = Math.max(10, minDim * 0.2);
  const bladeThickness = Math.max(4.5, minDim * 0.11);
  const bladeRootRadius = Math.max(ratePillarRadius * 2.2, minDim * 0.28);

  // Simple rotor — all six blades remain visible and rotating so the
  // silhouette is stable across LODs. No higher-tier glow/trim variant.
  const simpleRotor = makeExtractorRotor(
    bladeLen, bladeWidth, bladeThickness,
    6, rotorY, Math.PI / 6, bladeRootRadius, 0.5,
    width, depth, pyramidHeight,
  );
  details.push(detail(simpleRotor, 'min', undefined, 'extractorRotor'));

  return {
    primary: base,
    details,
    height: pyramidHeight,
    extractorRig: {
      rotors: [simpleRotor],
      rateIndicator: metalRateIndicator.rig,
    },
  };
}

function makeExtractorRotor(
  bladeReach: number,
  bladeWidth: number,
  bladeThickness: number,
  bladeCount: number,
  y: number,
  angleOffset: number,
  bladeRootRadius: number,
  bladeLengthScale: number = 1,
  buildingWidth: number,
  buildingDepth: number,
  pyramidHeight: number,
): THREE.Mesh {
  const rotor = new THREE.Mesh(cylinderGeom, invisibleMat);
  rotor.position.set(0, y, 0);

  const groundClearance = Math.max(3.5, bladeThickness * 1.5);
  const fullVerticalDrop = Math.max(12, y - groundClearance);
  const rootRadius = Math.max(0, Math.min(bladeRootRadius, Math.max(0, bladeReach - 16)));
  const fullHorizontalSpan = Math.max(16, Math.min(bladeReach - rootRadius, fullVerticalDrop));
  const horizontalSpan = fullHorizontalSpan * bladeLengthScale;
  const verticalDrop = fullVerticalDrop * bladeLengthScale;
  const bladeAxisLength = Math.hypot(horizontalSpan, verticalDrop);

  // Closed-pose geometry. Each blade lies flat against ONE of the six
  // pyramid faces. Blade i (at rotor open-angle = corner angle) folds
  // outward by +π/6 (half a hex sector) so it lands on the FACE midpoint
  // rather than the corner ridge between two faces — that way the six
  // blades collectively cover the six faces.
  //
  // For a regular hexagonal pyramid:
  //   corner radius (circumscribed) = pyramidTopRadius / pyramidBottomRadius
  //   face-edge midpoint radius (inscribed) = corner radius × √3/2
  // The closed blade endpoints ride the inscribed radius so they sit
  // ON the face surface, not floating outside the corners.
  const halfMinDim = Math.min(buildingWidth, buildingDepth) * 0.5;
  const pyramidTopRadius = PYRAMID_TOP_RADIUS_FRACTION * halfMinDim;
  const pyramidBottomRadius = PYRAMID_BOTTOM_RADIUS_FRACTION * halfMinDim;
  const inscribedTopRadius = pyramidTopRadius * HEX_INSCRIBED_RATIO;
  const inscribedBottomRadius = pyramidBottomRadius * HEX_INSCRIBED_RATIO;

  // Face dimensions used to reshape the closed blade so it FITS the
  // trapezoidal face it lands on. A rectangular blade can't be a perfect
  // rhombus, but matching the face's slant length × average edge width
  // makes the six blades visually wrap the base.
  const faceSlantLength = Math.hypot(
    inscribedBottomRadius - inscribedTopRadius,
    pyramidHeight,
  );
  // Regular hexagon side length equals its circumradius, so the top
  // edge runs at pyramidTopRadius and the bottom edge at
  // pyramidBottomRadius. Pick the average as a uniform blade width.
  const closedBladeWidth = (pyramidTopRadius + pyramidBottomRadius) * 0.5;
  // Thin panel — visible from the outside, doesn't poke through the
  // opposite face when the blade settles flush.
  const closedBladeThickness = Math.max(0.6, bladeThickness * 0.25);

  for (let i = 0; i < bladeCount; i++) {
    const openAngle = angleOffset + (i / bladeCount) * Math.PI * 2;
    const openRadial = new THREE.Vector3(Math.cos(openAngle), 0, Math.sin(openAngle));
    const openTangent = new THREE.Vector3(-Math.sin(openAngle), 0, Math.cos(openAngle));
    const openBladeDir = new THREE.Vector3(
      openRadial.x * horizontalSpan,
      -verticalDrop,
      openRadial.z * horizontalSpan,
    ).normalize();
    const openNormal = new THREE.Vector3().crossVectors(openTangent, openBladeDir).normalize();
    const openCenterRadius = rootRadius + horizontalSpan * 0.5;
    const openCenterX = openRadial.x * openCenterRadius;
    const openCenterY = -verticalDrop * 0.5;
    const openCenterZ = openRadial.z * openCenterRadius;

    const blade = makeBox(
      extractorBladeMat,
      bladeAxisLength,
      bladeThickness,
      bladeWidth,
      openCenterX,
      openCenterY,
      openCenterZ,
    );
    applyBasis(blade, openBladeDir, openNormal, openTangent);

    // Cache the OPEN transform straight off the live mesh — applyBasis
    // has just written it, so a copy is the cheapest way to snapshot
    // both rotation and the offset center we picked above.
    const openPos = blade.position.clone();
    const openQuat = blade.quaternion.clone();
    const openScale = blade.scale.clone();

    // Closed pose: the blade lands on the face midway between open
    // corners (offset by half a hex sector). The face has top edge,
    // bottom edge, and slants between them; the blade center sits on
    // the face's surface midpoint.
    const closedAngle = openAngle + Math.PI / bladeCount; // = openAngle + π/6
    const cosC = Math.cos(closedAngle);
    const sinC = Math.sin(closedAngle);

    // Face edge midpoints in pyramid (building) local coords.
    const faceTopMidX = inscribedTopRadius * cosC;
    const faceTopMidY = pyramidHeight;
    const faceTopMidZ = inscribedTopRadius * sinC;
    const faceBottomMidX = inscribedBottomRadius * cosC;
    const faceBottomMidY = 0;
    const faceBottomMidZ = inscribedBottomRadius * sinC;

    // Face normal — perpendicular to the face surface, pointing outward
    // (radial out + slightly up because the face slopes outward as it
    // descends). Derived from the trapezoid corner geometry: see
    // computeHexFaceNormal proof in the project notes.
    const closedNormalDir = new THREE.Vector3(
      cosC * pyramidHeight,
      inscribedBottomRadius - inscribedTopRadius,
      sinC * pyramidHeight,
    ).normalize();

    // Stand the closed blade slightly proud of the face so it reads as
    // a panel laid on top, not embedded in the pyramid mesh.
    const standoffX = closedNormalDir.x * CLOSED_BLADE_STANDOFF;
    const standoffY = closedNormalDir.y * CLOSED_BLADE_STANDOFF;
    const standoffZ = closedNormalDir.z * CLOSED_BLADE_STANDOFF;

    // Rotor sits at (0, y, 0) in building frame. The blade's local
    // coords are relative to the rotor, so subtract y from Y.
    const closedCenter = new THREE.Vector3(
      (faceTopMidX + faceBottomMidX) * 0.5 + standoffX,
      (faceTopMidY + faceBottomMidY) * 0.5 - y + standoffY,
      (faceTopMidZ + faceBottomMidZ) * 0.5 + standoffZ,
    );

    // Closed-pose orthonormal basis for applyBasis-style construction:
    //   X (length) → down-slope along the face (top→bottom)
    //   Y (thickness) → face outward normal
    //   Z (width) → horizontal tangent across the face
    const closedBladeDir = new THREE.Vector3(
      faceBottomMidX - faceTopMidX,
      faceBottomMidY - faceTopMidY,
      faceBottomMidZ - faceTopMidZ,
    ).normalize();
    const closedTangentDir = new THREE.Vector3()
      .crossVectors(closedNormalDir, closedBladeDir)
      .normalize();
    const closedBasis = new THREE.Matrix4().makeBasis(
      closedBladeDir, closedNormalDir, closedTangentDir,
    );
    const closedQuat = new THREE.Quaternion().setFromRotationMatrix(closedBasis);

    // Scale the box geometry to the trapezoidal face dimensions. The
    // mesh's local-X scale becomes the slant length (top→bottom along
    // the face), local-Y becomes a thin panel, local-Z becomes the
    // face's average horizontal width. Six panels read as a uniform
    // wrap around the base.
    const closedScale = new THREE.Vector3(
      faceSlantLength,
      closedBladeThickness,
      closedBladeWidth,
    );

    const anim: ExtractorBladeAnim = {
      openPos,
      closedPos: closedCenter,
      openQuat,
      closedQuat,
      openScale,
      closedScale,
    };
    blade.userData.extractorBlade = anim;

    rotor.add(blade);
  }

  return rotor;
}

export function disposeMetalExtractorMeshGeoms(): void {
  extractorPyramidGeom.dispose();
}
