import type { UniformGrid } from '../grid/UniformGrid.ts';

export interface GravityParams {
  G: number;
  /** Plummer softening length -- keeps force finite as two particles approach r=0. */
  softening: number;
}

/**
 * O(N^2) pairwise softened Newtonian gravity, i < j (Newton's third law halves the work).
 * Writes accelerations (not forces) into `outAccelerations`, overwriting it.
 *
 * a_i += G * m_j * (r_j - r_i) / (|r_j - r_i|^2 + eps^2)^1.5
 */
export function computeBruteForceGravity(
  positions: Float32Array,
  masses: Float32Array,
  count: number,
  { G, softening }: GravityParams,
  outAccelerations: Float32Array,
): void {
  const eps2 = softening * softening;
  outAccelerations.fill(0);

  for (let i = 0; i < count; i++) {
    const ix = i * 3;
    const xi = positions[ix];
    const yi = positions[ix + 1];
    const zi = positions[ix + 2];
    let ax = 0;
    let ay = 0;
    let az = 0;

    for (let j = i + 1; j < count; j++) {
      const jx = j * 3;
      const dx = positions[jx] - xi;
      const dy = positions[jx + 1] - yi;
      const dz = positions[jx + 2] - zi;
      const distSq = dx * dx + dy * dy + dz * dz + eps2;
      const invDist3 = 1 / (distSq * Math.sqrt(distSq));

      const gj = G * masses[j] * invDist3;
      ax += gj * dx;
      ay += gj * dy;
      az += gj * dz;

      const gi = G * masses[i] * invDist3;
      outAccelerations[jx] -= gi * dx;
      outAccelerations[jx + 1] -= gi * dy;
      outAccelerations[jx + 2] -= gi * dz;
    }

    outAccelerations[ix] += ax;
    outAccelerations[ix + 1] += ay;
    outAccelerations[ix + 2] += az;
  }
}

/**
 * Softened gravity via a shared UniformGrid: near-field direct summation
 * over a particle's own + 26 neighboring fine cells, plus far-field
 * monopole summation over every coarse cell except the one containing the
 * particle (an accepted approximation -- see UniformGrid's block-boundary
 * caveat in the project plan). O(N * (const near-field + coarseCellCount))
 * instead of brute force's O(N^2), so this scales to far larger N.
 *
 * Deliberately computes each particle's total acceleration independently
 * (no Newton's-third-law pairwise halving, unlike computeBruteForceGravity)
 * -- that's the shape a GPU compute kernel needs (M6: one thread per
 * particle, no cross-thread writes), so the CPU and GPU versions of this
 * algorithm stay structurally identical.
 *
 * The far-field monopole sum is not pairwise momentum-conserving on its
 * own (see the comment after the main loop), so a global net-momentum
 * correction is applied afterward. That correction is a single O(N) pass
 * over all particles and stays GPU-portable the same way: a small
 * reduction kernel (sum m*a) followed by a broadcast-subtract kernel,
 * both already the standard "reduce then apply" shape compute shaders use.
 */
export function computeGridGravity(
  positions: Float32Array,
  masses: Float32Array,
  count: number,
  grid: UniformGrid,
  { G, softening }: GravityParams,
  outAccelerations: Float32Array,
): void {
  const eps2 = softening * softening;
  const fineAxis = grid.fineCellsPerAxis;
  const coarseAxis = grid.coarseCellsPerAxis;
  const blockSize = grid.blockSize;
  const { fineCellStart, sortedIndices, particleFineCell, coarseCellMass, coarseCellComX, coarseCellComY, coarseCellComZ } =
    grid;

  for (let i = 0; i < count; i++) {
    const ix = i * 3;
    const xi = positions[ix];
    const yi = positions[ix + 1];
    const zi = positions[ix + 2];
    let ax = 0;
    let ay = 0;
    let az = 0;

    const flatFine = particleFineCell[i];
    const fx = flatFine % fineAxis;
    const fy = Math.floor(flatFine / fineAxis) % fineAxis;
    const fz = Math.floor(flatFine / (fineAxis * fineAxis));

    // Near-field: direct particle-particle over the 3x3x3 fine-cell neighborhood.
    for (let dz = -1; dz <= 1; dz++) {
      const nz = fz + dz;
      if (nz < 0 || nz >= fineAxis) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = fy + dy;
        if (ny < 0 || ny >= fineAxis) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = fx + dx;
          if (nx < 0 || nx >= fineAxis) continue;

          const neighborCell = (nz * fineAxis + ny) * fineAxis + nx;
          const start = fineCellStart[neighborCell];
          const end = fineCellStart[neighborCell + 1];
          for (let k = start; k < end; k++) {
            const j = sortedIndices[k];
            if (j === i) continue;
            const jx = j * 3;
            const dxp = positions[jx] - xi;
            const dyp = positions[jx + 1] - yi;
            const dzp = positions[jx + 2] - zi;
            const distSq = dxp * dxp + dyp * dyp + dzp * dzp + eps2;
            const invDist3 = 1 / (distSq * Math.sqrt(distSq));
            const g = G * masses[j] * invDist3;
            ax += g * dxp;
            ay += g * dyp;
            az += g * dzp;
          }
        }
      }
    }

    // Far-field: every other coarse cell as a point mass, using this
    // particle's *exact* position (not its coarse cell's center of mass --
    // see the long comment after this loop for why that alternative was
    // tried and reverted).
    const ownCoarseIdx =
      (Math.floor(fz / blockSize) * coarseAxis + Math.floor(fy / blockSize)) * coarseAxis +
      Math.floor(fx / blockSize);

    for (let c = 0; c < coarseCellMass.length; c++) {
      if (c === ownCoarseIdx) continue;
      const m = coarseCellMass[c];
      if (m === 0) continue;
      const dxp = coarseCellComX[c] - xi;
      const dyp = coarseCellComY[c] - yi;
      const dzp = coarseCellComZ[c] - zi;
      const distSq = dxp * dxp + dyp * dyp + dzp * dzp + eps2;
      const invDist3 = 1 / (distSq * Math.sqrt(distSq));
      const g = G * m * invDist3;
      ax += g * dxp;
      ay += g * dyp;
      az += g * dzp;
    }

    outAccelerations[ix] = ax;
    outAccelerations[ix + 1] = ay;
    outAccelerations[ix + 2] = az;
  }

  // The far-field loop above uses each particle's *exact* position against
  // a distant cell's center of mass. That's what keeps individual particles'
  // forces varying smoothly with position (an earlier version instead used
  // the particle's own coarse cell's center of mass for symmetry, which
  // exactly conserves momentum between cell pairs, but collapses every
  // particle sharing a cell onto an identical far-field vector -- visible
  // as the cloud fragmenting into one clump per coarse cell, worst at the 8
  // corner cells of the coarse grid, instead of one continuous collapse).
  //
  // But exact-position far-field reintroduces the original problem: two
  // particles in the same cell don't pull equally hard on a distant cell,
  // so the reaction they get back doesn't balance, and net momentum isn't
  // conserved. Fix both at once with a global correction: the net
  // mass-weighted acceleration bias (which should be exactly zero for an
  // isolated system) is measured directly and subtracted equally per unit
  // mass, so total momentum change is forced to exactly zero every step
  // without touching how any individual particle's force varies with its
  // own position.
  let netAx = 0;
  let netAy = 0;
  let netAz = 0;
  let totalMass = 0;
  for (let i = 0; i < count; i++) {
    const m = masses[i];
    totalMass += m;
    netAx += m * outAccelerations[i * 3];
    netAy += m * outAccelerations[i * 3 + 1];
    netAz += m * outAccelerations[i * 3 + 2];
  }
  if (totalMass > 0) {
    const biasX = netAx / totalMass;
    const biasY = netAy / totalMass;
    const biasZ = netAz / totalMass;
    for (let i = 0; i < count; i++) {
      outAccelerations[i * 3] -= biasX;
      outAccelerations[i * 3 + 1] -= biasY;
      outAccelerations[i * 3 + 2] -= biasZ;
    }
  }
}
