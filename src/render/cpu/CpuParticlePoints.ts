import * as THREE from 'three/webgpu';
import { fillUniformBall } from '../../utils/math.ts';

/** A plain THREE.Points cloud driven by a CPU-side Float32Array. Used for M1's
 * static point cloud, and later as the CPU backend's render path (as opposed
 * to the GPU backend's storage-buffer-driven SpriteNodeMaterial). */
export class CpuParticlePoints {
  readonly object: THREE.Points;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.PointsMaterial;

  constructor(count: number, domainRadius: number) {
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
    this.setCount(count, domainRadius);
  }

  setCount(count: number, domainRadius: number): void {
    const positions = new Float32Array(count * 3);
    fillUniformBall(positions, count, domainRadius);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.computeBoundingSphere();
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
