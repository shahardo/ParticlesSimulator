export interface GridSizing {
  fineCellsPerAxis: number;
  coarseCellsPerAxis: number;
  /** fine cells per coarse cell, per axis -- fineCellsPerAxis is always coarseCellsPerAxis * blockSize. */
  blockSize: number;
}

/**
 * Picks grid resolutions from particle count: fine cells average ~4
 * particles each (near-field + collision neighbor queries), coarse cells
 * are a fixed-size block of fine cells (far-field gravity monopoles) so
 * their count -- and therefore far-field cost, O(N * coarseCellCount) --
 * scales with N rather than being a fixed 16^3 regardless of N. A literal
 * fixed 4096-cell far field (as sized for GPU-scale N in the project plan)
 * would cost tens of millions of monopole evaluations/frame at CPU-scale N
 * (tens of thousands), which is too slow single-threaded in JS.
 *
 * blockSize is 2, not some larger number, for a load-bearing reason: the
 * near-field neighborhood in computeGridGravity is a fixed radius-1 (3x3x3
 * fine cells) window. For that window to always fully cover a particle's
 * own coarse block (so nothing falls in the gap between "handled by
 * near-field" and "excluded from far-field because it's my own coarse
 * cell"), every fine cell in that block must be within 1 cell of the
 * particle's own fine cell along each axis -- true for a 2-wide block
 * (the only other cell along an axis is always exactly 1 step away) but
 * false for a 4-wide block (the far corner can be 3 steps away). A larger
 * blockSize was tried first and measurably under-counted force (~40%
 * average relative error vs brute force in gravity.test.ts) from exactly
 * this gap, not from the monopole approximation itself.
 */
export function computeGridSizing(count: number): GridSizing {
  const targetPerCell = 4;
  const blockSize = 2;
  const rawFine = Math.cbrt(Math.max(count, 1) / targetPerCell);
  const coarseCellsPerAxis = Math.min(32, Math.max(2, Math.round(rawFine / blockSize)));
  const fineCellsPerAxis = coarseCellsPerAxis * blockSize;
  return { fineCellsPerAxis, coarseCellsPerAxis, blockSize };
}

/**
 * Two uniform grids over the same fixed cube domain, rebuilt every step:
 * a fine grid (near-field gravity + future collision neighbor queries) and
 * a coarse grid derived from blocks of fine cells (far-field gravity
 * monopoles). See computeGridGravity in physics/gravity.ts for how these
 * are consumed, and the project plan's "Architecture" section for why two
 * grids instead of one adaptive octree (Barnes-Hut).
 */
export class UniformGrid {
  readonly fineCellsPerAxis: number;
  readonly coarseCellsPerAxis: number;
  readonly blockSize: number;
  readonly fineCellCount: number;
  readonly coarseCellCount: number;

  /** Exclusive prefix-sum cell ranges into `sortedIndices`, length fineCellCount+1. */
  readonly fineCellStart: Int32Array;
  readonly fineCellMass: Float64Array;
  readonly fineCellComX: Float64Array;
  readonly fineCellComY: Float64Array;
  readonly fineCellComZ: Float64Array;
  /** Particle indices grouped by fine cell (see fineCellStart for ranges). */
  readonly sortedIndices: Int32Array;
  /** Each particle's flat fine-cell index, in original (unsorted) particle order. */
  readonly particleFineCell: Int32Array;

  readonly coarseCellMass: Float64Array;
  readonly coarseCellComX: Float64Array;
  readonly coarseCellComY: Float64Array;
  readonly coarseCellComZ: Float64Array;

  private domainRadius = 1;
  private fineCellSize = 1;
  private readonly cursor: Int32Array;

  constructor(capacity: number, sizing: GridSizing) {
    this.fineCellsPerAxis = sizing.fineCellsPerAxis;
    this.coarseCellsPerAxis = sizing.coarseCellsPerAxis;
    this.blockSize = sizing.blockSize;
    this.fineCellCount = sizing.fineCellsPerAxis ** 3;
    this.coarseCellCount = sizing.coarseCellsPerAxis ** 3;

    this.fineCellStart = new Int32Array(this.fineCellCount + 1);
    this.fineCellMass = new Float64Array(this.fineCellCount);
    this.fineCellComX = new Float64Array(this.fineCellCount);
    this.fineCellComY = new Float64Array(this.fineCellCount);
    this.fineCellComZ = new Float64Array(this.fineCellCount);
    this.sortedIndices = new Int32Array(capacity);
    this.particleFineCell = new Int32Array(capacity);

    this.coarseCellMass = new Float64Array(this.coarseCellCount);
    this.coarseCellComX = new Float64Array(this.coarseCellCount);
    this.coarseCellComY = new Float64Array(this.coarseCellCount);
    this.coarseCellComZ = new Float64Array(this.coarseCellCount);

    this.cursor = new Int32Array(this.fineCellCount);
  }

  build(positions: Float32Array, masses: Float32Array, count: number, domainRadius: number): void {
    this.domainRadius = domainRadius;
    this.fineCellSize = (2 * domainRadius) / this.fineCellsPerAxis;

    const { fineCellCount, particleFineCell, fineCellStart } = this;

    // Pass 1+2: clear counts, then count particles per fine cell (stored
    // shifted by one slot so the next pass's prefix sum lands in place).
    fineCellStart.fill(0);
    for (let i = 0; i < count; i++) {
      const cellIdx = this.cellIndexOf(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      particleFineCell[i] = cellIdx;
      fineCellStart[cellIdx + 1]++;
    }

    // Pass 3: exclusive prefix sum -> fineCellStart[c] is cell c's start offset.
    for (let c = 0; c < fineCellCount; c++) {
      fineCellStart[c + 1] += fineCellStart[c];
    }

    // Pass 4: scatter particle indices into sortedIndices via a cursor copy
    // (fineCellStart itself must stay untouched -- it's read again below).
    this.cursor.set(fineCellStart.subarray(0, fineCellCount));
    for (let i = 0; i < count; i++) {
      const cellIdx = particleFineCell[i];
      this.sortedIndices[this.cursor[cellIdx]++] = i;
    }

    // Pass 5: per-fine-cell mass + center of mass.
    this.fineCellMass.fill(0);
    this.fineCellComX.fill(0);
    this.fineCellComY.fill(0);
    this.fineCellComZ.fill(0);
    for (let c = 0; c < fineCellCount; c++) {
      const start = fineCellStart[c];
      const end = fineCellStart[c + 1];
      let m = 0;
      let mx = 0;
      let my = 0;
      let mz = 0;
      for (let k = start; k < end; k++) {
        const idx = this.sortedIndices[k];
        const mi = masses[idx];
        m += mi;
        mx += mi * positions[idx * 3];
        my += mi * positions[idx * 3 + 1];
        mz += mi * positions[idx * 3 + 2];
      }
      this.fineCellMass[c] = m;
      if (m > 0) {
        this.fineCellComX[c] = mx / m;
        this.fineCellComY[c] = my / m;
        this.fineCellComZ[c] = mz / m;
      }
    }

    this.aggregateCoarseFromFine();
  }

  private aggregateCoarseFromFine(): void {
    const { blockSize, coarseCellsPerAxis, fineCellsPerAxis } = this;
    this.coarseCellMass.fill(0);
    this.coarseCellComX.fill(0);
    this.coarseCellComY.fill(0);
    this.coarseCellComZ.fill(0);

    for (let cz = 0; cz < coarseCellsPerAxis; cz++) {
      for (let cy = 0; cy < coarseCellsPerAxis; cy++) {
        for (let cx = 0; cx < coarseCellsPerAxis; cx++) {
          const coarseIdx = (cz * coarseCellsPerAxis + cy) * coarseCellsPerAxis + cx;
          const fx0 = cx * blockSize;
          const fy0 = cy * blockSize;
          const fz0 = cz * blockSize;
          let m = 0;
          let mx = 0;
          let my = 0;
          let mz = 0;
          for (let dz = 0; dz < blockSize; dz++) {
            for (let dy = 0; dy < blockSize; dy++) {
              for (let dx = 0; dx < blockSize; dx++) {
                const fineIdx =
                  ((fz0 + dz) * fineCellsPerAxis + (fy0 + dy)) * fineCellsPerAxis + (fx0 + dx);
                const fm = this.fineCellMass[fineIdx];
                if (fm > 0) {
                  m += fm;
                  mx += fm * this.fineCellComX[fineIdx];
                  my += fm * this.fineCellComY[fineIdx];
                  mz += fm * this.fineCellComZ[fineIdx];
                }
              }
            }
          }
          this.coarseCellMass[coarseIdx] = m;
          if (m > 0) {
            this.coarseCellComX[coarseIdx] = mx / m;
            this.coarseCellComY[coarseIdx] = my / m;
            this.coarseCellComZ[coarseIdx] = mz / m;
          }
        }
      }
    }
  }

  private cellIndexOf(x: number, y: number, z: number): number {
    const axis = this.fineCellsPerAxis;
    const fx = this.axisIndex(x, axis);
    const fy = this.axisIndex(y, axis);
    const fz = this.axisIndex(z, axis);
    return (fz * axis + fy) * axis + fx;
  }

  private axisIndex(coord: number, cellsPerAxis: number): number {
    const idx = Math.floor((coord + this.domainRadius) / this.fineCellSize);
    return Math.max(0, Math.min(cellsPerAxis - 1, idx));
  }
}
