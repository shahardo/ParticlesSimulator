import { Fn, If, Loop, atomicAdd, atomicLoad, atomicStore, clamp, float, floor, instanceIndex, instancedArray, int, vec3 } from 'three/tsl';
import type * as THREE from 'three/webgpu';
import type { GridSizing } from '../../cpu/grid/UniformGrid.ts';

/**
 * GPU counting-sort port of `src/sim/cpu/grid/UniformGrid.ts` -- same fine
 * (near-field) + coarse (far-field monopole) two-grid scheme, rebuilt every
 * step, but as a sequence of TSL compute kernels instead of the CPU's
 * single-threaded 5-pass loop. One thread per particle for the count/scatter
 * passes and one thread per cell for the aggregate passes, the same
 * "no cross-thread writes except via atomics" shape the M6 plan calls for.
 *
 * Two passes stay genuinely single-threaded (`.compute(1)`, one GPU
 * invocation looping serially): the prefix sum over fine cells, and (in
 * GpuBackend) the net-momentum reduction. This mirrors the CPU version's
 * already-serial prefix sum -- seen there as an accepted bottleneck (see
 * docs/devplan.md Risks) rather than something to fix here. A parallel
 * (Hillis-Steele) prefix sum / reduction is the same documented future
 * optimization on both backends, not built upfront.
 *
 * `blockSize` (fine cells per coarse cell) is assumed to be exactly 2 here
 * (as `computeGridSizing` always produces) so the fine<->coarse aggregate
 * loop can be unrolled 2x2x2 in plain JS at kernel-build time instead of a
 * dynamic TSL loop -- if `computeGridSizing` ever changes blockSize, this
 * needs to change too.
 *
 * Particle mass is hardcoded to 1 throughout (matching `CpuBackend`, which
 * fills its masses array with 1 and has no per-particle-mass UI yet) --
 * cell mass is just its member count, avoiding a redundant mass buffer.
 *
 * All locals holding TSL node values are explicitly typed `any` throughout
 * this file, not just the buffer handles -- see the TSL typing gotcha in
 * CLAUDE.md/GpuBackend.ts. Without that, chains of `.mul()/.add()/.div()`
 * across int/float/vec3 nodes make the TS structural-type checker try to
 * resolve deeply nested generic overloads and fail (observed here as real
 * `tsc` errors, not just the TS7 hang the project's docs warn about).
 */
export class GpuUniformGrid {
  readonly fineCellsPerAxis: number;
  readonly coarseCellsPerAxis: number;
  readonly blockSize: number;
  readonly fineCellCount: number;
  readonly coarseCellCount: number;

  // GPU-resident buffers/kernels. Typed `any` for the same reason as
  // GpuBackend's own buffer handles -- see the comment there.
  private fineCounts: any;
  private cellCursor: any;
  readonly fineCellStart: any;
  readonly sortedIndices: any;
  readonly fineCellMass: any;
  readonly fineCellCom: any;
  readonly coarseCellMass: any;
  readonly coarseCellCom: any;

  /** Maps a position node to its flat fine-cell index (int). Shared by the
   * count/scatter passes here and by the gravity kernel's own-cell lookup. */
  readonly fineCellOf: (position: any) => any;

  private clearCountsKernel: any;
  private countKernel: any;
  private prefixSumKernel: any;
  private scatterKernel: any;
  private fineAggregateKernel: any;
  private coarseAggregateKernel: any;

  constructor(count: number, sizing: GridSizing, positions: any, domainRadius: any) {
    this.fineCellsPerAxis = sizing.fineCellsPerAxis;
    this.coarseCellsPerAxis = sizing.coarseCellsPerAxis;
    this.blockSize = sizing.blockSize;
    this.fineCellCount = sizing.fineCellsPerAxis ** 3;
    this.coarseCellCount = sizing.coarseCellsPerAxis ** 3;

    const { fineCellCount, coarseCellCount, fineCellsPerAxis, coarseCellsPerAxis, blockSize } = this;

    this.fineCounts = instancedArray(fineCellCount, 'int').toAtomic();
    this.cellCursor = instancedArray(fineCellCount, 'int').toAtomic();
    this.fineCellStart = instancedArray(fineCellCount + 1, 'int');
    this.sortedIndices = instancedArray(count, 'int');
    this.fineCellMass = instancedArray(fineCellCount, 'float');
    this.fineCellCom = instancedArray(fineCellCount, 'vec3');
    this.coarseCellMass = instancedArray(coarseCellCount, 'float');
    this.coarseCellCom = instancedArray(coarseCellCount, 'vec3');

    // fineCellSize depends on the *live* domainRadius uniform (the box
    // radius slider works without a grid rebuild), so it's a node
    // expression re-evaluated per invocation, not a baked-in JS constant --
    // mirrors CPU UniformGrid.build() recomputing it from domainRadius every step.
    const fineCellSize: any = domainRadius.mul(2).div(fineCellsPerAxis);
    // `clamp` cast to `any` at the call site: its overload set resolves
    // mixed int-typed args (via `int()`) into an unrelated float/vec4
    // overload and reports a nonsensical mismatch -- the same TSL
    // typing gotcha CLAUDE.md documents for GPU-side node chains.
    const axisIndex = (coord: any): any =>
      (clamp as any)(int(floor(coord.add(domainRadius).div(fineCellSize))), int(0), int(fineCellsPerAxis - 1));
    this.fineCellOf = (position: any): any => {
      const fx: any = axisIndex(position.x);
      const fy: any = axisIndex(position.y);
      const fz: any = axisIndex(position.z);
      return fz.mul(fineCellsPerAxis).add(fy).mul(fineCellsPerAxis).add(fx);
    };

    this.clearCountsKernel = Fn(() => {
      atomicStore(this.fineCounts.element(instanceIndex), int(0));
    })().compute(fineCellCount);

    this.countKernel = Fn(() => {
      const cell: any = this.fineCellOf(positions.element(instanceIndex));
      atomicAdd(this.fineCounts.element(cell), int(1));
    })().compute(count);

    // Single GPU invocation: exclusive prefix sum over fine-cell counts,
    // plus seeding cellCursor with the same start offsets for the scatter
    // pass below (each thread's atomicAdd on its own cell's cursor hands
    // out a unique, in-range slot -- same trick as the CPU's cursor copy).
    this.prefixSumKernel = Fn(() => {
      const running: any = int(0).toVar();
      Loop({ start: 0, end: fineCellCount }, ({ i }: any) => {
        this.fineCellStart.element(i).assign(running);
        atomicStore(this.cellCursor.element(i), running);
        running.addAssign(atomicLoad(this.fineCounts.element(i)));
      });
      this.fineCellStart.element(int(fineCellCount)).assign(running);
    })().compute(1);

    this.scatterKernel = Fn(() => {
      const cell: any = this.fineCellOf(positions.element(instanceIndex));
      const slot: any = atomicAdd(this.cellCursor.element(cell), int(1));
      this.sortedIndices.element(slot).assign(int(instanceIndex));
    })().compute(count);

    this.fineAggregateKernel = Fn(() => {
      const c: any = int(instanceIndex);
      const start: any = this.fineCellStart.element(c);
      const end: any = this.fineCellStart.element(c.add(int(1)));

      const comX: any = float(0).toVar();
      const comY: any = float(0).toVar();
      const comZ: any = float(0).toVar();
      Loop({ start, end }, ({ i }: any) => {
        const p: any = positions.element(this.sortedIndices.element(i));
        comX.addAssign(p.x);
        comY.addAssign(p.y);
        comZ.addAssign(p.z);
      });

      const cellCount: any = end.sub(start);
      const m: any = float(cellCount);
      this.fineCellMass.element(c).assign(m);
      If(cellCount.greaterThan(int(0)), () => {
        this.fineCellCom.element(c).assign(vec3(comX, comY, comZ).div(m));
      });
    })().compute(fineCellCount);

    this.coarseAggregateKernel = Fn(() => {
      const cIdx: any = int(instanceIndex);
      const cx: any = cIdx.mod(coarseCellsPerAxis);
      const cy: any = cIdx.div(coarseCellsPerAxis).mod(coarseCellsPerAxis);
      const cz: any = cIdx.div(coarseCellsPerAxis * coarseCellsPerAxis);
      const fx0: any = cx.mul(blockSize);
      const fy0: any = cy.mul(blockSize);
      const fz0: any = cz.mul(blockSize);

      const m: any = float(0).toVar();
      const comX: any = float(0).toVar();
      const comY: any = float(0).toVar();
      const comZ: any = float(0).toVar();

      // blockSize is always 2 (see class doc) -- unrolled at kernel-build
      // time rather than a dynamic TSL Loop.
      for (let dz = 0; dz < blockSize; dz++) {
        for (let dy = 0; dy < blockSize; dy++) {
          for (let dx = 0; dx < blockSize; dx++) {
            const fineIdx: any = fz0
              .add(dz)
              .mul(fineCellsPerAxis)
              .add(fy0.add(dy))
              .mul(fineCellsPerAxis)
              .add(fx0.add(dx));
            const fm: any = this.fineCellMass.element(fineIdx);
            const fcom: any = this.fineCellCom.element(fineIdx);
            m.addAssign(fm);
            comX.addAssign(fm.mul(fcom.x));
            comY.addAssign(fm.mul(fcom.y));
            comZ.addAssign(fm.mul(fcom.z));
          }
        }
      }

      this.coarseCellMass.element(cIdx).assign(m);
      If(m.greaterThan(float(0)), () => {
        this.coarseCellCom.element(cIdx).assign(vec3(comX, comY, comZ).div(m));
      });
    })().compute(coarseCellCount);
  }

  /** Rebuilds the grid from this frame's positions -- one renderer.compute()
   * dispatch per pass, run in dependency order (each pass's storage-buffer
   * reads depend on the previous pass's writes completing first). */
  build(renderer: THREE.WebGPURenderer): void {
    renderer.compute(this.clearCountsKernel);
    renderer.compute(this.countKernel);
    renderer.compute(this.prefixSumKernel);
    renderer.compute(this.scatterKernel);
    renderer.compute(this.fineAggregateKernel);
    renderer.compute(this.coarseAggregateKernel);
  }
}
