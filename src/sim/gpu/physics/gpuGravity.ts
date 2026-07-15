import { Fn, If, Loop, dot, float, instanceIndex, int, sqrt, vec3 } from 'three/tsl';
import type { GpuUniformGrid } from '../grid/GpuUniformGrid.ts';

/**
 * TSL port of `computeGridGravity` (src/sim/cpu/physics/gravity.ts): one
 * thread per particle, near-field direct summation over the 3x3x3
 * fine-cell neighborhood plus far-field monopole summation over every
 * coarse cell except the particle's own -- same accepted approximation,
 * same reason (see the CPU version's doc comment). Each particle computes
 * its own total acceleration independently, so there's no Newton's-third-
 * law pairwise halving here, exactly like the CPU version already does
 * (that's what makes both versions GPU-portable in the same shape).
 *
 * The far-field sum isn't pairwise momentum-conserving on its own for the
 * same reason as the CPU version -- GpuBackend applies the same global
 * net-momentum correction afterward (see its momentum reduce/apply kernels).
 *
 * Particle mass hardcoded to 1 (see GpuUniformGrid's doc comment).
 *
 * All locals holding TSL node values are explicitly typed `any` -- see the
 * typing-gotcha note at the top of GpuUniformGrid.ts.
 */
export function createGravityKernel(
  positions: any,
  accelerations: any,
  grid: GpuUniformGrid,
  count: number,
  G: any,
  softening: any,
): any {
  const { fineCellsPerAxis, coarseCellsPerAxis, blockSize, coarseCellCount } = grid;

  return Fn(() => {
    const selfIndex: any = int(instanceIndex);
    const pos: any = positions.element(instanceIndex);
    const eps2: any = softening.mul(softening);
    const accel: any = vec3(0, 0, 0).toVar();

    const cell: any = grid.fineCellOf(pos);
    const fx: any = cell.mod(fineCellsPerAxis);
    const fy: any = cell.div(fineCellsPerAxis).mod(fineCellsPerAxis);
    const fz: any = cell.div(fineCellsPerAxis * fineCellsPerAxis);

    // Near-field: direct particle-particle over the 3x3x3 fine-cell
    // neighborhood, unrolled in JS (the offsets are compile-time constants).
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx: any = fx.add(dx);
          const ny: any = fy.add(dy);
          const nz: any = fz.add(dz);
          const inBounds: any = nx
            .greaterThanEqual(int(0))
            .and(nx.lessThan(fineCellsPerAxis))
            .and(ny.greaterThanEqual(int(0)))
            .and(ny.lessThan(fineCellsPerAxis))
            .and(nz.greaterThanEqual(int(0)))
            .and(nz.lessThan(fineCellsPerAxis));

          If(inBounds, () => {
            const neighborCell: any = nz.mul(fineCellsPerAxis).add(ny).mul(fineCellsPerAxis).add(nx);
            const start: any = grid.fineCellStart.element(neighborCell);
            const end: any = grid.fineCellStart.element(neighborCell.add(int(1)));

            Loop({ start, end }, ({ i: k }: any) => {
              const j: any = grid.sortedIndices.element(k);
              If(j.notEqual(selfIndex), () => {
                const d: any = positions.element(j).sub(pos);
                const distSq: any = dot(d, d).add(eps2);
                const invDist3: any = distSq.mul(sqrt(distSq)).reciprocal();
                const g: any = G.mul(invDist3); // mass_j = 1
                accel.addAssign(d.mul(g));
              });
            });
          });
        }
      }
    }

    // Far-field: every coarse cell except the particle's own, using the
    // particle's exact position (not its cell's center of mass) -- see the
    // CPU version's long comment for why, and GpuBackend's momentum
    // correction for how the resulting non-conservation is fixed globally.
    const cfx: any = fx.div(blockSize);
    const cfy: any = fy.div(blockSize);
    const cfz: any = fz.div(blockSize);
    const ownCoarseIdx: any = cfz.mul(coarseCellsPerAxis).add(cfy).mul(coarseCellsPerAxis).add(cfx);

    Loop({ start: 0, end: coarseCellCount }, ({ i: c }: any) => {
      If(c.notEqual(ownCoarseIdx), () => {
        const m: any = grid.coarseCellMass.element(c);
        If(m.greaterThan(float(0)), () => {
          const d: any = grid.coarseCellCom.element(c).sub(pos);
          const distSq: any = dot(d, d).add(eps2);
          const invDist3: any = distSq.mul(sqrt(distSq)).reciprocal();
          const g: any = m.mul(G).mul(invDist3);
          accel.addAssign(d.mul(g));
        });
      });
    });

    accelerations.element(instanceIndex).assign(accel);
  })().compute(count);
}
