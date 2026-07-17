import * as THREE from 'three/webgpu';
import { Fn, If, Loop, cos, dot, float, hash, instanceIndex, instancedArray, int, log, max, pow, sqrt, uniform, vec3 } from 'three/tsl';
import type { SimulationBackend, ParticleSnapshot } from '../SimulationBackend.ts';
import type { SimParams, WallBehavior } from '../../app/Config.ts';
import { WALL_VANISH_DISTANCE } from '../../app/Config.ts';
import { computeGridSizing } from '../cpu/grid/UniformGrid.ts';
import { GpuUniformGrid } from './grid/GpuUniformGrid.ts';
import { createGravityKernel } from './physics/gpuGravity.ts';
import { unpadVec3 } from '../../debug/vec3Buffer.ts';

/** Debug-only: which terms `debugComputeAccelerationsRaw` should include,
 * for bisecting a `verifyGpuGravity` mismatch down to near-field vs
 * far-field (see `src/debug/verifyGpuGravity.ts`). */
export interface GravityDebugMode {
  includeNear?: boolean;
  includeFar?: boolean;
}

/** Maps a WallBehavior to the int code `integrateKernel` branches on --
 * kept as a plain number (not a string) so the wall-behavior check is a
 * uniform comparison inside the compiled kernel, letting the Tweakpane
 * dropdown change behavior live without rebuilding any kernel. */
const WALL_BEHAVIOR_CODE: Record<WallBehavior, number> = { bounce: 0, vanish: 1, wraparound: 2 };

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
 * Verified on real GPU hardware (a headed, non-headless browser session on
 * this same machine gets a real WebGPU adapter -- see
 * .claude/skills/run-particles-simulator/SKILL.md's `HEADED=1` note):
 * `gravityKernel`'s output matches `computeGridGravity`'s CPU reference to
 * float32 precision (see `src/debug/verifyGpuGravity.ts` and docs/devplan.md's
 * M6 as-built notes for the full story, including a real bug that check
 * found in the debug readback path itself, not the kernels).
 */
export class GpuBackend implements SimulationBackend {
  readonly kind = 'gpu' as const;

  private renderer: THREE.WebGPURenderer;
  private count = 0;

  private domainRadius = uniform(1);
  private dt = uniform(0);
  private gravityG = uniform(0);
  private softening = uniform(0.01);
  private wallBehaviorMode = uniform(0, 'int');

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
  // Doubles as the "vanish" mode's alive flag, exactly like CpuBackend's
  // masses array -- see GpuUniformGrid's doc comment for why this needs no
  // separate alive buffer.
  private masses!: any;
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
    this.wallBehaviorMode.value = WALL_BEHAVIOR_CODE[params.wallBehavior];

    this.positions = instancedArray(count, 'vec3');
    this.velocities = instancedArray(count, 'vec3');
    this.accelerations = instancedArray(count, 'vec3');
    this.masses = instancedArray(count, 'float');
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
      // Matches Config.ts's INITIAL_CLOUD_RADIUS_FRACTION -- see fillUniformBall's use in CpuBackend.
      const ballRadius: any = this.domainRadius.mul(0.15);
      position.assign(dir.mul(ballRadius.mul(rFrac).div(dirLength)));

      // Start from rest, like CpuBackend -- gravity pulling an initially
      // static cloud into a clump is the simplest visual/numerical
      // correctness check, and it's what the CPU reference does too.
      velocity.assign(vec3(0, 0, 0));
      this.masses.element(instanceIndex).assign(float(1));
    })().compute(count);

    this.grid = new GpuUniformGrid(count, computeGridSizing(count), this.positions, this.masses, this.domainRadius);
    this.gravityKernel = createGravityKernel(
      this.positions,
      this.masses,
      this.accelerations,
      this.grid,
      count,
      this.gravityG,
      this.softening,
    );

    // Single-invocation net-momentum reduction, mirroring
    // computeGridGravity's CPU-side correction: measure the mass-weighted
    // acceleration bias directly and subtract it equally per particle so
    // net momentum change is exactly zero every step, without touching how
    // any individual particle's far-field force varies with its own
    // position. Mass-weighted (not divided by raw count) so a vanished
    // (mass-0) particle's stale acceleration doesn't skew the correction --
    // matches the CPU version's `totalMass`-divided form exactly.
    this.momentumReduceKernel = Fn(() => {
      const sumMA = vec3(0, 0, 0).toVar();
      const sumM: any = float(0).toVar();
      Loop({ start: 0, end: count }, ({ i }: any) => {
        const m: any = this.masses.element(i);
        sumMA.addAssign(this.accelerations.element(i).mul(m));
        sumM.addAssign(m);
      });
      this.netMomentumBias.element(0).assign(sumMA.div(max(sumM, 1e-6)));
    })().compute(1);

    this.momentumApplyKernel = Fn(() => {
      this.accelerations.element(instanceIndex).subAssign(this.netMomentumBias.element(0));
    })().compute(count);

    this.integrateKernel = Fn(() => {
      const position = this.positions.element(instanceIndex);
      const velocity = this.velocities.element(instanceIndex);
      const mass = this.masses.element(instanceIndex);
      const accel = this.accelerations.element(instanceIndex);
      const r = this.domainRadius;
      const mode = this.wallBehaviorMode;

      // Permanently vanished (mass zeroed on some earlier step) -- skip
      // regardless of the *current* mode, so switching modes mid-session
      // doesn't resurrect or otherwise perturb a dead particle. Matches
      // CpuBackend's unconditional `masses[i] === 0` skip exactly.
      If(mass.greaterThan(float(0)), () => {
        // Semi-implicit (symplectic) Euler, same as CpuBackend -- conserves
        // energy far better than explicit Euler over long-running orbital dynamics.
        velocity.addAssign(accel.mul(this.dt));
        position.addAssign(velocity.mul(this.dt));

        If(mode.equal(int(0)), () => {
          // bounce: fold-back (not a plain clamp+negate) so a large
          // single-step overshoot still lands at a physically sane spot.
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
        }).ElseIf(mode.equal(int(2)), () => {
          // wraparound: reappear on the opposite face, velocity unchanged.
          If(position.x.greaterThan(r), () => {
            position.x = position.x.sub(r.mul(2));
          });
          If(position.x.lessThan(r.negate()), () => {
            position.x = position.x.add(r.mul(2));
          });
          If(position.y.greaterThan(r), () => {
            position.y = position.y.sub(r.mul(2));
          });
          If(position.y.lessThan(r.negate()), () => {
            position.y = position.y.add(r.mul(2));
          });
          If(position.z.greaterThan(r), () => {
            position.z = position.z.sub(r.mul(2));
          });
          If(position.z.lessThan(r.negate()), () => {
            position.z = position.z.add(r.mul(2));
          });
        }).ElseIf(mode.equal(int(1)), () => {
          // vanish: any axis past the wall kills the whole particle --
          // zero its mass (excludes it from the grid/gravity math, see
          // GpuUniformGrid/gpuGravity's doc comments), zero velocity, and
          // park it beyond the camera's far plane (see Config.ts's
          // WALL_VANISH_DISTANCE doc comment) so it's effectively hidden.
          const outOfBounds: any = position.x
            .greaterThan(r)
            .or(position.x.lessThan(r.negate()))
            .or(position.y.greaterThan(r))
            .or(position.y.lessThan(r.negate()))
            .or(position.z.greaterThan(r))
            .or(position.z.lessThan(r.negate()));

          If(outOfBounds, () => {
            mass.assign(float(0));
            velocity.assign(vec3(0, 0, 0));
            position.assign(vec3(WALL_VANISH_DISTANCE, WALL_VANISH_DISTANCE, WALL_VANISH_DISTANCE));
          });
        });
      });
    })().compute(count);

    this.renderer.compute(this.initKernel);
  }

  setParams(params: Partial<SimParams>): void {
    if (params.domainRadius !== undefined) this.domainRadius.value = params.domainRadius;
    if (params.gravityG !== undefined) this.gravityG.value = params.gravityG;
    if (params.softening !== undefined) this.softening.value = params.softening;
    if (params.wallBehavior !== undefined) this.wallBehaviorMode.value = WALL_BEHAVIOR_CODE[params.wallBehavior];
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

  /** The GPU-resident grid (for reading back individual grid buffers during
   * manual/test verification -- see `src/debug/verifyGpuGravity.ts`). */
  get debugGrid(): GpuUniformGrid {
    return this.grid;
  }

  /** Reads a `vec3` storage buffer back as a tightly-packed (stride-3)
   * array, undoing the GPU's stride-4 padding -- see `debug/vec3Buffer.ts`.
   * `itemSize` is only 4 once the buffer has actually been used in a
   * dispatch, so this checks it rather than assuming either layout. */
  private async readVec3Buffer(node: any): Promise<Float32Array> {
    const attribute = node.value as THREE.BufferAttribute & { itemSize: number };
    const buffer = await this.renderer.getArrayBufferAsync(attribute);
    const raw = new Float32Array(buffer);
    return attribute.itemSize === 4 ? unpadVec3(raw, this.count) : raw;
  }

  /** Writes a tightly-packed (stride-3) array into a `vec3` storage
   * buffer's backing array -- always tightly packed, *not* pre-padded to
   * stride-4, even though `.array` itself has usually already been
   * upgraded to the padded layout by the time this runs (see
   * `debug/vec3Buffer.ts`). That's not a bug: three's own attribute-update
   * path (`WebGPUAttributeUtils.updateAttribute`, run on the next
   * compute()/render() that references this buffer) always re-derives the
   * padded layout itself by re-chopping `.array` at the *original*
   * (cached, tightly-packed) item size, regardless of what `.array`
   * currently holds. Pre-padding here before that runs feeds it
   * already-padded data as if it were still tightly packed, corrupting it
   * a second time -- confirmed directly by dumping the raw buffer through
   * that exact write-then-compute sequence while chasing down a
   * `verifyGpuGravity` mismatch that turned out to be this, not a real
   * kernel bug (see docs/devplan.md's M6 as-built notes). Writing
   * tightly-packed data and letting the framework's own repad run
   * untouched is the only combination that round-trips correctly. */
  private writeVec3Buffer(node: any, tight: Float32Array): void {
    const attribute = node.value as THREE.BufferAttribute & { array: Float32Array };
    attribute.array.set(tight);
    attribute.needsUpdate = true;
  }

  /** Async CPU readback, for manual/test verification only (see
   * window.__debug and .claude/skills/run-particles-simulator/SKILL.md) --
   * never call this from the render loop, it stalls waiting on the GPU. */
  async debugReadPositions(): Promise<Float32Array> {
    return this.readVec3Buffer(this.positions);
  }

  /** Overwrites the position buffer with CPU-supplied data (e.g. from
   * `fillUniformBall`), for manual/test verification only -- lets a debug
   * script seed identical initial conditions on both backends despite them
   * using different RNGs internally (CPU: `Math.random()`-based Box-Muller;
   * GPU: `hash(instanceIndex)`-based), which otherwise makes a direct
   * per-particle comparison meaningless. See `src/debug/verifyGpuGravity.ts`. */
  debugSetPositions(positions: Float32Array): void {
    this.writeVec3Buffer(this.positions, positions);
  }

  /** Runs the grid build + gravity + momentum correction (everything
   * `step()` does except the final position/velocity integrate) and reads
   * back the resulting accelerations. Isolating this from `step()` lets a
   * debug script diff GPU-computed forces directly against
   * `computeGridGravity`'s CPU output for the same positions, without the
   * integrate step moving particles in between -- for manual/test
   * verification only, same caveats as `debugReadPositions()`. */
  async debugComputeAccelerations(): Promise<Float32Array> {
    this.grid.build(this.renderer);
    this.renderer.compute(this.gravityKernel);
    this.renderer.compute(this.momentumReduceKernel);
    this.renderer.compute(this.momentumApplyKernel);
    return this.readVec3Buffer(this.accelerations);
  }

  /** Same as `debugComputeAccelerations()` but *without* the momentum
   * correction kernels -- isolates `gravityKernel` (near+far-field sum)
   * from `momentumReduceKernel`/`momentumApplyKernel`, for bisecting a
   * `verifyGpuGravity` mismatch down to one stage or the other. */
  async debugComputeAccelerationsRaw(): Promise<Float32Array> {
    this.grid.build(this.renderer);
    this.renderer.compute(this.gravityKernel);
    return this.readVec3Buffer(this.accelerations);
  }

  /** Same as `debugComputeAccelerationsRaw()` but builds a one-off gravity
   * kernel with only the near-field or only the far-field term included --
   * bisects a mismatch down to one of those two sums specifically. Builds a
   * fresh kernel per call; fine for manual/test use, not for the render loop. */
  async debugComputeAccelerationsWithMode(mode: GravityDebugMode): Promise<Float32Array> {
    this.grid.build(this.renderer);
    const kernel = createGravityKernel(
      this.positions,
      this.masses,
      this.accelerations,
      this.grid,
      this.count,
      this.gravityG,
      this.softening,
      mode,
    );
    this.renderer.compute(kernel);
    return this.readVec3Buffer(this.accelerations);
  }

  dispose(): void {
    // instancedArray buffers are garbage-collected with no explicit GPU
    // resource handle exposed at this level; nothing to release here yet.
  }
}
