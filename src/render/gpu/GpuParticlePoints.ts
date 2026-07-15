import * as THREE from 'three/webgpu';
import { float, shapeCircle } from 'three/tsl';

/**
 * M5: renders a GPU-resident position buffer directly -- no CPU copy per
 * frame, unlike CpuParticlePoints. `positionsNode` is GpuBackend's raw TSL
 * instancedArray (typed `any` here for the same reason as in GpuBackend:
 * naming TSL's internal node types in full breaks the type checker on
 * complex chained expressions, see SKILL.md).
 *
 * Reconstructed (not updated in place) whenever N changes, since
 * `positionsNode.toAttribute()` bakes in a reference to a specific
 * fixed-size buffer -- mirrors how CpuParticlePoints.setPositions() swaps
 * the whole BufferAttribute rather than resizing one in place.
 */
export class GpuParticlePoints {
  readonly object: THREE.Sprite;
  private readonly material: THREE.SpriteNodeMaterial;

  constructor(positionsNode: any, count: number) {
    this.material = new THREE.SpriteNodeMaterial();
    this.material.positionNode = positionsNode.toAttribute();
    this.material.scaleNode = float(0.06);
    this.material.opacityNode = shapeCircle();
    this.material.transparent = true;
    this.material.depthWrite = false;

    this.object = new THREE.Sprite(this.material);
    this.object.count = count;
    this.object.frustumCulled = false;
  }

  dispose(): void {
    this.material.dispose();
  }
}
