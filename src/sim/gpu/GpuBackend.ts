import * as THREE from 'three/webgpu';
import { Fn, If, Loop, cos, dot, hash, instanceIndex, instancedArray, log, max, pow, sqrt, uniform, vec3 } from 'three/tsl';
import type { SimulationBackend, ParticleSnapshot } from '../SimulationBackend.ts';
import type { SimParams } from '../../app/Config.ts';
import { computeGridSizing } from '../cpu/grid/UniformGrid.ts';
import { GpuUniformGrid } from './grid/GpuUniformGrid.ts';
import { createGravityKernel } from './physics/gpuGravity.ts';

/**
 * M6: real softened-Newtonian gravity on the GPU, via `GpuUniformGrid` (a
 * TSL port of the CPU's fine+coarse counting-sort grid) and
 * `createGravityKernel` (a TSL port of `computeGridGravity`). Structurally
 * this replaces M5's ballistic drift-and-bounce kernel with the same
 * physics `CpuBackend` already runs -- see both of those files' doc
 * comments for the near/far-field split and the momentum-correction
 * rationale, which apply identically here.
 *
 * Position/velocity/acceleration buffers never touch the CPU after init();
 * the renderer reads them directly via `getPositionsNode()`
 * (GpuParticlePoints) instead of through `getSnapshot()`.
 *
 * Requires a real WebGPU adapter (compute shaders/atomics/storage buffers
 * have no WebGL2 equivalent) -- construct this only when
 * isRealWebGPUBackend(renderer) is true; there is no software fallback.
 *
 * Unverified on real GPU hardware, same as M5's skeleton (see
 * docs/devplan.md's M5/M6 as-built notes) -- this dev environment has no
 * real WebGPU adapter, so everything here is type-checked and pattern-
 * matched against confirmed TSL API usage (atomics, dynamic-bound `Loop`),
 * not run.
 */
export class GpuBackend implements SimulationBackend {
  readonly kind = 'gpu' as const;

  private renderer: THREE.WebGPURenderer;
  private count = 0;

  private domainRadius = uniform(1);
  private dt = uniform(0);
  private gravityG = uniform(0);
  private softening = uniform(0.01);

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
  private accelerations!: any;
  private netMomentumBias!: any;
  private grid!: GpuUniformGrid;
  private initKernel!: any;
  private gravityKernel!: any;
  private momentumReduceKernel!: any;
  private momentumApplyKernel!: any;
  private integrateKernel!: any;

  constructor(renderer: THREE.WebGPURenderer) {
    this.renderer = renderer;
  }

  init(count: number, params: SimParams): void {
    this.count = count;
    this.domainRadius.value = params.domainRadius;
    this.gravityG.value = params.gravityG;
    this.softening.value = params.softening;

    this.positions = instancedArray(count, 'vec3');
    this.velocities = instancedArray(count, 'vec3');
    this.accelerations = instancedArray(count, 'vec3');
    this.netMomentumBias = instancedArray(1, 'vec3');

    // Box-Muller via hash(): matches fillUniformBall's CPU distribution
    // (src/utils/math.ts) exactly, not just "some random cloud" -- a
    // standard-normal (dx,dy,dz) direction is spherically symmetric, so
    // normalizing it and scaling by radius*cbrt(uniform) (cbrt for uniform
    // density *by volume*, not just by radius) gives points uniform inside
    // a ball. Each component draws its own independent (u,v) hash pair and
    // only uses the cosine term, discarding the paired sine value --
    // wasteful but it's what the CPU version does too, and matching that
    // (rather than the more efficient two-normals-per-pair trick) keeps
    // the two backends' initial clouds statistically identical.
    const gaussian = (seedA: number, seedB: number): any => {
      const u: any = max(hash(instanceIndex.add(seedA)), 1e-6);
      const v: any = hash(instanceIndex.add(seedB));
      return sqrt(log(u).mul(-2)).mul(cos(v.mul(Math.PI * 2)));
    };

    this.initKernel = Fn(() => {
      const position = this.positions.element(instanceIndex);
      const velocity = this.velocities.element(instanceIndex);

      const dx: any = gaussian(10000019, 10000079);
      const dy: any = gaussian(20000033, 20000101);
      const dz: any = gaussian(30000041, 30000103);
      const dir: any = vec3(dx, dy, dz);
      const dirLength: any = max(sqrt(dot(dir, dir)), 1e-6);
      const rFrac: any = pow(hash(instanceIndex.add(40000063)), 1 / 3);
      const ballRadius: any = this.domainRadius.mul(0.6);
      position.assign(dir.mul(ballRadius.mul(rFrac).div(dirLength)));

      // Start from rest, like CpuBackend -- gravity pulling an initially
      // static cloud into a clump is the simplest visual/numerical
      // correctness check, and it's what the CPU reference does too.
      velocity.assign(vec3(0, 0, 0));
    })().compute(count);

    this.grid = new GpuUniformGrid(count, computeGridSizing(count), this.positions, this.domainRadius);
    this.gravityKernel = createGravityKernel(
      this.positions,
      this.accelerations,
      this.grid,
      count,
      this.gravityG,
      this.softening,
    );

    // Single-invocation net-momentum reduction (mass = 1 per particle, see
    // GpuUniformGrid's doc comment), mirroring computeGridGravity's CPU-side
    // correction: measure the mass-weighted acceleration bias directly and
    // subtract it equally per particle so net momentum change is exactly
    // zero every step, without touching how any individual particle's
    // far-field force varies with its own position.
    this.momentumReduceKernel = Fn(() => {
      const sum = vec3(0, 0, 0).toVar();
      Loop({ start: 0, end: count }, ({ i }: any) => {
        sum.addAssign(this.accelerations.element(i));
      });
      this.netMomentumBias.element(0).assign(sum.div(count));
    })().compute(1);

    this.momentumApplyKernel = Fn(() => {
      this.accelerations.element(instanceIndex).subAssign(this.netMomentumBias.element(0));
    })().compute(count);

    this.integrateKernel = Fn(() => {
      const position = this.positions.element(instanceIndex);
      const velocity = this.velocities.element(instanceIndex);
      const accel = this.accelerations.element(instanceIndex);

      // Semi-implicit (symplectic) Euler, same as CpuBackend -- conserves
      // energy far better than explicit Euler over long-running orbital dynamics.
      velocity.addAssign(accel.mul(this.dt));
      position.addAssign(velocity.mul(this.dt));

      // Fold-back bounce off a cube domain wall (not a plain clamp+negate --
      // matches CpuBackend so a large single-step overshoot still lands at
      // a physically sane spot, now that this is real physics rather than
      // M5's drift skeleton).
      const r = this.domainRadius;

      If(position.x.greaterThan(r), () => {
        position.x = r.sub(position.x.sub(r));
        velocity.x = velocity.x.negate();
      });
      If(position.x.lessThan(r.negate()), () => {
        position.x = r.negate().sub(position.x.add(r));
        velocity.x = velocity.x.negate();
      });
      If(position.y.greaterThan(r), () => {
        position.y = r.sub(position.y.sub(r));
        velocity.y = velocity.y.negate();
      });
      If(position.y.lessThan(r.negate()), () => {
        position.y = r.negate().sub(position.y.add(r));
        velocity.y = velocity.y.negate();
      });
      If(position.z.greaterThan(r), () => {
        position.z = r.sub(position.z.sub(r));
        velocity.z = velocity.z.negate();
      });
      If(position.z.lessThan(r.negate()), () => {
        position.z = r.negate().sub(position.z.add(r));
        velocity.z = velocity.z.negate();
      });
    })().compute(count);

    this.renderer.compute(this.initKernel);
  }

  setParams(params: Partial<SimParams>): void {
    if (params.domainRadius !== undefined) this.domainRadius.value = params.domainRadius;
    if (params.gravityG !== undefined) this.gravityG.value = params.gravityG;
    if (params.softening !== undefined) this.softening.value = params.softening;
  }

  step(dt: number): void {
    this.dt.value = dt;
    this.grid.build(this.renderer);
    this.renderer.compute(this.gravityKernel);
    this.renderer.compute(this.momentumReduceKernel);
    this.renderer.compute(this.momentumApplyKernel);
    this.renderer.compute(this.integrateKernel);
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
