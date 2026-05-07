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

/** Per-LOD rotor meshes for the extractor. The detail system gates
 *  visibility by tier so only ONE rotor is on-screen at a time, but
 *  the animator advances the same yaw on every entry — flipping LOD
 *  bands is a free visibility toggle, no rebuild needed. */
export type ExtractorRig = {
  rotors: THREE.Mesh[];
  rateIndicator?: ProductionRateIndicatorRig;
};

/** Metal extractor LOD ladder.
 *
 *  The complete readable extractor silhouette is the six-sided pyramid
 *  plus one rotating shiny hub/blade assembly. That simple version
 *  intentionally remains the ceiling for MEDIUM / HIGH / MAX, so the
 *  extractor does not swap into busier decorative variants as it moves
 *  through camera-sphere tiers.
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

  for (let i = 0; i < bladeCount; i++) {
    const angle = angleOffset + (i / bladeCount) * Math.PI * 2;
    const radialDir = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
    const tangentDir = new THREE.Vector3(-Math.sin(angle), 0, Math.cos(angle));
    const bladeDir = new THREE.Vector3(
      radialDir.x * horizontalSpan,
      -verticalDrop,
      radialDir.z * horizontalSpan,
    ).normalize();
    const normalDir = new THREE.Vector3().crossVectors(tangentDir, bladeDir).normalize();
    const centerRadius = rootRadius + horizontalSpan * 0.5;
    const centerX = radialDir.x * centerRadius;
    const centerY = -verticalDrop * 0.5;
    const centerZ = radialDir.z * centerRadius;

    const blade = makeBox(
      extractorBladeMat,
      bladeAxisLength,
      bladeThickness,
      bladeWidth,
      centerX,
      centerY,
      centerZ,
    );
    applyBasis(blade, bladeDir, normalDir, tangentDir);
    rotor.add(blade);
  }

  return rotor;
}

export function disposeMetalExtractorMeshGeoms(): void {
  extractorPyramidGeom.dispose();
}
