import * as THREE from 'three';
import {
  INSTANCED_COLOR_ALPHA_PARTICLE_FRAGMENT_SHADER,
  INSTANCED_COLOR_ALPHA_PARTICLE_VERTEX_SHADER,
} from './instancedColorAlphaParticleShader';
import {
  applyExposureToRawShader,
  configureSelfLitEffectMaterial,
} from './RenderLighting3D';

type ParticleMaterialOptions = Omit<
  THREE.ShaderMaterialParameters,
  'vertexShader' | 'fragmentShader' | 'transparent' | 'depthWrite'
>;

/**
 * Creates the shared raw-shader material used by instanced particle pools.
 * Keeping shader selection, transparency, depth writes, and the explicit
 * scene-exposed/self-lit policy together prevents effects from silently
 * rendering with different material semantics when a new pool is added.
 */
export function createInstancedColorAlphaParticleMaterial(
  options: ParticleMaterialOptions = {},
  selfLit = false,
): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    vertexShader: INSTANCED_COLOR_ALPHA_PARTICLE_VERTEX_SHADER,
    fragmentShader: INSTANCED_COLOR_ALPHA_PARTICLE_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    ...options,
  });
  if (selfLit) configureSelfLitEffectMaterial(material);
  else applyExposureToRawShader(material);
  return material;
}
