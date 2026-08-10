import * as THREE from 'three';
import { getUnitBlueprint } from '../sim/blueprints';
import { getBodyGeom } from './BodyShape3D';
import { CommanderVisualKit3D } from './CommanderVisualKit3D';

const PLANE_EPSILON = 1e-8;

type Point2 = readonly [number, number];

type BoxFace = {
  readonly label: string;
  readonly normal: THREE.Vector3;
  readonly planeDistance: number;
  readonly points: readonly THREE.Vector3[];
};

function assertContract(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`[commander geometry contract] ${message}`);
}

function transformedPoint(
  x: number,
  y: number,
  z: number,
  matrixWorld: THREE.Matrix4,
): THREE.Vector3 {
  return new THREE.Vector3(x, y, z).applyMatrix4(matrixWorld);
}

function boxFaces(mesh: THREE.Mesh, label: string): BoxFace[] {
  mesh.geometry.computeBoundingBox();
  const bounds = mesh.geometry.boundingBox;
  assertContract(bounds !== null, `${label} box geometry has local bounds`);
  const { min, max } = bounds;
  const quads = [
    [[min.x, min.y, min.z], [min.x, max.y, min.z], [min.x, max.y, max.z], [min.x, min.y, max.z]],
    [[max.x, min.y, min.z], [max.x, min.y, max.z], [max.x, max.y, max.z], [max.x, max.y, min.z]],
    [[min.x, min.y, min.z], [min.x, min.y, max.z], [max.x, min.y, max.z], [max.x, min.y, min.z]],
    [[min.x, max.y, min.z], [max.x, max.y, min.z], [max.x, max.y, max.z], [min.x, max.y, max.z]],
    [[min.x, min.y, min.z], [max.x, min.y, min.z], [max.x, max.y, min.z], [min.x, max.y, min.z]],
    [[min.x, min.y, max.z], [min.x, max.y, max.z], [max.x, max.y, max.z], [max.x, min.y, max.z]],
  ] as const;
  const names = ['-X', '+X', '-Y', '+Y', '-Z', '+Z'] as const;
  const result: BoxFace[] = [];
  for (let i = 0; i < quads.length; i++) {
    const points = quads[i].map((point) =>
      transformedPoint(point[0], point[1], point[2], mesh.matrixWorld));
    const normal = points[1].clone().sub(points[0])
      .cross(points[2].clone().sub(points[0]))
      .normalize();
    result.push({
      label: `${label}/${names[i]}`,
      normal,
      planeDistance: normal.dot(points[0]),
      points,
    });
  }
  return result;
}

function projectFace(face: BoxFace, u: THREE.Vector3, v: THREE.Vector3): Point2[] {
  return face.points.map((point) => [point.dot(u), point.dot(v)] as const);
}

function polygonsOverlapWithArea(a: readonly Point2[], b: readonly Point2[]): boolean {
  for (const polygon of [a, b]) {
    for (let i = 0; i < polygon.length; i++) {
      const p0 = polygon[i];
      const p1 = polygon[(i + 1) % polygon.length];
      const edgeX = p1[0] - p0[0];
      const edgeY = p1[1] - p0[1];
      const axisLength = Math.hypot(edgeX, edgeY);
      if (axisLength <= PLANE_EPSILON) continue;
      const axisX = -edgeY / axisLength;
      const axisY = edgeX / axisLength;
      let aMin = Infinity;
      let aMax = -Infinity;
      let bMin = Infinity;
      let bMax = -Infinity;
      for (const point of a) {
        const projection = point[0] * axisX + point[1] * axisY;
        aMin = Math.min(aMin, projection);
        aMax = Math.max(aMax, projection);
      }
      for (const point of b) {
        const projection = point[0] * axisX + point[1] * axisY;
        bMin = Math.min(bMin, projection);
        bMax = Math.max(bMax, projection);
      }
      if (Math.min(aMax, bMax) - Math.max(aMin, bMin) <= PLANE_EPSILON) {
        return false;
      }
    }
  }
  return true;
}

function facesShareOverlappingPlane(a: BoxFace, b: BoxFace): boolean {
  const alignment = a.normal.dot(b.normal);
  if (Math.abs(Math.abs(alignment) - 1) > PLANE_EPSILON) return false;
  const alignedDistance = alignment < 0 ? -b.planeDistance : b.planeDistance;
  if (Math.abs(a.planeDistance - alignedDistance) > PLANE_EPSILON) return false;

  const u = a.points[1].clone().sub(a.points[0]).normalize();
  const v = a.normal.clone().cross(u).normalize();
  return polygonsOverlapWithArea(projectFace(a, u, v), projectFace(b, u, v));
}

/** Every Commander box is a real armored volume. Two distinct pieces may
 * intersect to form a continuous silhouette, but their exterior quads may not
 * occupy the same plane over a positive area: that is ambiguous geometry and
 * produces camera-dependent z-fighting, especially in the layered backpack. */
export function runCommanderGeometry3DContractTest(): void {
  const blueprint = getUnitBlueprint('unitCommander');
  const root = new THREE.Group();
  const body = getBodyGeom(blueprint.bodyShape, 'close');
  let bodyBoxCount = 0;
  for (let i = 0; i < body.parts.length; i++) {
    const part = body.parts[i];
    if (!(part.geometry instanceof THREE.BoxGeometry)) continue;
    const mesh = new THREE.Mesh(part.geometry);
    mesh.name = `body[${i}]`;
    mesh.position.set(part.x, part.y, part.z);
    mesh.scale.set(part.scaleX, part.scaleY, part.scaleZ);
    mesh.rotation.z = part.rotZ ?? 0;
    root.add(mesh);
    bodyBoxCount += 1;
  }

  const primaryMaterial = new THREE.MeshLambertMaterial();
  const commanderKit = new CommanderVisualKit3D();
  const kit = commanderKit.buildKit(primaryMaterial, 'close');
  root.add(kit);
  root.updateMatrixWorld(true);

  try {
    const facesByMesh: BoxFace[][] = [];
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      if (!(object.geometry instanceof THREE.BoxGeometry)) return;
      const label = object.name || `kit[${facesByMesh.length - bodyBoxCount}]`;
      facesByMesh.push(boxFaces(object, label));
    });

    const overlaps: string[] = [];
    for (let i = 0; i < facesByMesh.length; i++) {
      for (let j = i + 1; j < facesByMesh.length; j++) {
        for (const a of facesByMesh[i]) {
          for (const b of facesByMesh[j]) {
            if (facesShareOverlappingPlane(a, b)) {
              overlaps.push(`${a.label} and ${b.label}`);
            }
          }
        }
      }
    }
    assertContract(
      overlaps.length === 0,
      `faces overlap on one 2D plane: ${overlaps.join(', ')}`,
    );
  } finally {
    primaryMaterial.dispose();
    commanderKit.dispose();
  }
}
