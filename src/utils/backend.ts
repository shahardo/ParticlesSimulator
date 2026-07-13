import type * as THREE from 'three/webgpu';

/**
 * `renderer.backend.isWebGPUBackend` exists at runtime on the concrete
 * WebGPUBackend class (three/src/renderers/webgpu/WebGPUBackend.js), but
 * @types/three only types `renderer.backend` as the base `Backend` class,
 * which doesn't declare this discriminator. Isolate the necessary cast here.
 */
export function isRealWebGPUBackend(renderer: THREE.WebGPURenderer): boolean {
  return (renderer.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
}
