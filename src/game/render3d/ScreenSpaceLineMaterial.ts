// ScreenSpaceLineMaterial — the one owned shader behind every ground-drawn
// overlay line/ring (selection rings, weapon/build/radar/reclaim range
// circles, sight/radar coverage boundaries, waypoint/path routes, drag
// previews).
//
// Each line is drawn as instanced segment quads whose CENTERLINE lives in
// the world (terrain-draped by the caller) but whose WIDTH is expanded
// perpendicular to the segment in *screen space* in the vertex shader. That
// gives a constant on-screen pixel width at any camera zoom — unlike a
// world-space tube (TorusGeometry / the old ground ribbon) that thins out
// when zoomed away, and unlike THREE.LineBasicMaterial which is locked to a
// single device pixel and hairlines/vanishes far out.
//
// The expanded vertices keep the centerline's clip-space depth, so the line
// follows natural depth occlusion: nearer geometry hides farther line, exactly
// like solid bodies. depthWrite is off so overlays blend over the scene and
// sort among themselves by renderOrder rather than fighting the depth buffer.
//
// Colour is per-instance RGBA. Colours are passed straight through (no tone
// mapping, no colour-space re-encode) to match the toneMapped:false unlit
// overlays this replaces, so authored hex values render as-authored.

import * as THREE from 'three';

export type ScreenSpaceLineMaterialOptions = {
  /** Initial viewport size in device pixels (kept in sync via setResolution). */
  resolution?: THREE.Vector2;
  /** Soft anti-aliased edge as a fraction of half-width (0 = hard, ~0.15 = soft). */
  feather?: number;
  /** Respect the depth buffer so nearer geometry occludes the line. */
  depthTest?: boolean;
};

/**
 * Builds the shared instanced screen-space-width line material. One instance
 * can be reused across every GroundLineBatch3D / GroundRing3D in the scene.
 */
export function createScreenSpaceLineMaterial(
  options: ScreenSpaceLineMaterialOptions = {},
): THREE.ShaderMaterial {
  const resolution = options.resolution ?? new THREE.Vector2(1, 1);
  const feather = options.feather ?? 0.16;
  const depthTest = options.depthTest ?? true;

  return new THREE.ShaderMaterial({
    uniforms: {
      uResolution: { value: resolution },
      uFeather: { value: feather },
    },
    transparent: true,
    depthTest,
    depthWrite: false,
    // ShaderMaterial auto-declares position/projectionMatrix/modelViewMatrix.
    vertexShader: /* glsl */ `
      uniform vec2 uResolution;
      attribute vec3 instanceStart;
      attribute vec3 instanceEnd;
      attribute vec4 instanceColor;
      attribute float instanceWidth;
      varying vec4 vColor;
      varying float vSide;

      void main() {
        vColor = instanceColor;
        // position.x: 0 at segment start, 1 at end. position.y: -0.5..0.5 side.
        vSide = position.y * 2.0;

        vec4 clipStart = projectionMatrix * modelViewMatrix * vec4(instanceStart, 1.0);
        vec4 clipEnd   = projectionMatrix * modelViewMatrix * vec4(instanceEnd, 1.0);
        vec4 clip = mix(clipStart, clipEnd, position.x);

        // Aspect-correct screen-space segment direction (in pixels).
        vec2 ndcStart = clipStart.xy / clipStart.w;
        vec2 ndcEnd   = clipEnd.xy / clipEnd.w;
        vec2 dirPx = (ndcEnd - ndcStart) * uResolution;
        float len = length(dirPx);
        vec2 dir = len > 1e-6 ? dirPx / len : vec2(1.0, 0.0);
        vec2 normal = vec2(-dir.y, dir.x);

        // Offset this vertex perpendicular by half the pixel width, convert
        // pixels -> NDC (full viewport = uResolution px = 2 NDC) -> clip (x w).
        vec2 offsetPx = normal * instanceWidth * position.y;
        vec2 ndcOffset = (offsetPx / uResolution) * 2.0;
        clip.xy += ndcOffset * clip.w;

        gl_Position = clip;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uFeather;
      varying vec4 vColor;
      varying float vSide;

      void main() {
        // Feather the ribbon edges so the line reads as a clean stroke
        // rather than an aliased band.
        float edge = 1.0 - smoothstep(1.0 - uFeather, 1.0, abs(vSide));
        float a = vColor.a * edge;
        if (a <= 0.002) discard;
        gl_FragColor = vec4(vColor.rgb, a);
      }
    `,
  });
}

/** The unit segment quad shared by every instanced line geometry. position.x
 *  selects the endpoint (0=start, 1=end); position.y selects the side. */
export function createSegmentQuadGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [0, -0.5, 0, 1, -0.5, 0, 1, 0.5, 0, 0, 0.5, 0],
      3,
    ),
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return geometry;
}
