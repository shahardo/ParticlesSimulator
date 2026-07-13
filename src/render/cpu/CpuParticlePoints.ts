import * as THREE from 'three/webgpu';

/** A plain THREE.Points cloud rendering a position buffer owned by a
 * SimulationBackend. Used as the CPU backend's render path (as opposed to
 * the GPU backend's storage-buffer-driven SpriteNodeMaterial from M5+). */
export class CpuParticlePoints {
  readonly object: THREE.Points;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.PointsMaterial;

  constructor() {
    this.material = new THREE.PointsMaterial({
      size: 0.015,
      sizeAttenuation: true,
      color: 0x9fd3ff,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    this.object = new THREE.Points(this.geometry, this.material);
    this.object.frustumCulled = false;
  }

  /** Points the geometry at a (possibly newly-allocated) backend position
   * buffer. Call whenever the backend re-inits (e.g. particle count change). */
  setPositions(positions: Float32Array): void {
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  }

  /** Call once per frame after the backend has mutated the position buffer in place. */
  markDirty(): void {
    (this.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
