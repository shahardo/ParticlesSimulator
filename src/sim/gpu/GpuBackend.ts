import * as THREE from 'three/webgpu';
import { Fn, hash, If, instanceIndex, instancedArray, uniform, vec3 } from 'three/tsl';
import type { SimulationBackend, ParticleSnapshot } from '../SimulationBackend.ts';
import type { SimParams } from '../../app/Config.ts';

/**
 * M5: GPU compute skeleton -- no gravity yet (that's M6). Particles drift
 * ballistically and bounce off the cube domain, entirely on the GPU: the
 * position/velocity buffers never touch the CPU after init, and the
 * renderer reads them directly via `positions.toAttribute()`
 * (GpuParticlePoints) instead of through `getSnapshot()`.
 *
 * Structurally mirrors CpuBackend's original M2 zero-force version on
 * purpose -- this milestone is about proving the compute-dispatch and
 * render-binding pipeline works, not about physics fidelity. M6 replaces
 * the per-frame kernel with a TSL port of computeGridGravity.
 *
 * Requires a real WebGPU adapter (compute shaders/storage buffers have no
 * WebGL2 equivalent) -- construct this only when
 * isRealWebGPUBackend(renderer) is true; there is no software fallback.
 */
export class GpuBackend implements SimulationBackend {
  readonly kind = 'gpu' as const;

  private renderer: THREE.WebGPURenderer;
  private count = 0;

  private domainRadius = uniform(1);
  private dt = uniform(0);
  private initSpeed = uniform(0);

  // Rebuilt every init() since instancedArray buffers are fixed-size --
  // `!` is safe because init() always runs before step()/getPositionsNode().
  // Typed `any`: TSL's node types are deeply generic/proxy-based (chained
  // methods like .toAttribute() aren't even fully represented in
  // @types/three -- see the comment where it's used), and composing them
  // with utility types like ReturnType<> here made `tsc` hang rather than
  // just report a mismatch. Not worth fighting for a GPU-only internal
  // handle that's never touched outside this class.
  private positions!: any;
  private velocities!: any;
  private updateKernel!: any;

  constructor(renderer: THREE.WebGPURenderer) {
    this.renderer = renderer;
  }

  init(count: number, params: SimParams): void {
    this.count = count;
    this.domainRadius.value = params.domainRadius;
    // Matches CpuBackend's M2 drift speed scale (domainRadius * 0.15),
    // kept from that milestone since M5 has the same "prove the pipeline"
    // goal, not real initial conditions -- M6's gravity port starts from
    // rest instead, like CpuBackend does now.
    this.initSpeed.value = params.domainRadius * 0.15;

    this.positions = instancedArray(count, 'vec3');
    this.velocities = instancedArray(count, 'vec3');

    const initKernel = Fn(() => {
      const position = this.positions.element(instanceIndex);
      const velocity = this.velocities.element(instanceIndex);

      // hash() is deterministic in its input, so distinct large offsets
      // per component decorrelate x/y/z instead of all reading the same value.
      const rx = hash(instanceIndex);
      const ry = hash(instanceIndex.add(1000003));
      const rz = hash(instanceIndex.add(2000003));
      position.assign(vec3(rx, ry, rz).sub(0.5).mul(this.domainRadius.mul(2)));

      const rvx = hash(instanceIndex.add(3000003));
      const rvy = hash(instanceIndex.add(4000003));
      const rvz = hash(instanceIndex.add(5000003));
      velocity.assign(vec3(rvx, rvy, rvz).sub(0.5).mul(this.initSpeed));
    })().compute(count);

    this.updateKernel = Fn(() => {
      const position = this.positions.element(instanceIndex);
      const velocity = this.velocities.element(instanceIndex);

      position.addAssign(velocity.mul(this.dt));

      // Simple clamp+negate (not CpuBackend's fold-back overshoot
      // correction) -- a deliberate simplification for this skeleton
      // milestone, matching its "trivial drift/bounce kernel" scope.
      const r = this.domainRadius;

      If(position.x.greaterThan(r), () => {
        position.x = r;
        velocity.x = velocity.x.negate();
      });
      If(position.x.lessThan(r.negate()), () => {
        position.x = r.negate();
        velocity.x = velocity.x.negate();
      });
      If(position.y.greaterThan(r), () => {
        position.y = r;
        velocity.y = velocity.y.negate();
      });
      If(position.y.lessThan(r.negate()), () => {
        position.y = r.negate();
        velocity.y = velocity.y.negate();
      });
      If(position.z.greaterThan(r), () => {
        position.z = r;
        velocity.z = velocity.z.negate();
      });
      If(position.z.lessThan(r.negate()), () => {
        position.z = r.negate();
        velocity.z = velocity.z.negate();
      });
    })().compute(count);

    this.renderer.compute(initKernel);
  }

  setParams(params: Partial<SimParams>): void {
    if (params.domainRadius !== undefined) this.domainRadius.value = params.domainRadius;
  }

  step(dt: number): void {
    this.dt.value = dt;
    this.renderer.compute(this.updateKernel);
  }

  getSnapshot(): ParticleSnapshot {
    // Intentionally not implemented synchronously -- see the interface doc
    // on SimulationBackend.getSnapshot(). GpuParticlePoints reads
    // getPositionsNode() directly instead.
    return { count: this.count, positions: new Float32Array(0) };
  }

  /** The GPU-resident positions buffer, for GpuParticlePoints to bind
   * directly via `.toAttribute()` -- never copied through the CPU. */
  getPositionsNode(): any {
    return this.positions;
  }

  get particleCount(): number {
    return this.count;
  }

  /** Async CPU readback, for manual/test verification only (see
   * window.__debug and .claude/skills/run-particles-simulator/SKILL.md) --
   * never call this from the render loop, it stalls waiting on the GPU. */
  async debugReadPositions(): Promise<Float32Array> {
    const attribute = this.positions.value as THREE.BufferAttribute;
    const buffer = await this.renderer.getArrayBufferAsync(attribute);
    return new Float32Array(buffer);
  }

  dispose(): void {
    // instancedArray buffers are garbage-collected with no explicit GPU
    // resource handle exposed at this level; nothing to release here yet.
  }
}
