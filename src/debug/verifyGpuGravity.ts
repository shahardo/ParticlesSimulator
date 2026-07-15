import type * as THREE from 'three/webgpu';
import type { SimParams } from '../app/Config.ts';
import { fillUniformBall } from '../utils/math.ts';
import { computeGridGravity } from '../sim/cpu/physics/gravity.ts';
import { computeGridSizing, UniformGrid } from '../sim/cpu/grid/UniformGrid.ts';
import { GpuBackend } from '../sim/gpu/GpuBackend.ts';

export interface GravityParityResult {
  count: number;
  /** Mean of |gpuAccel - cpuAccel| / |cpuAccel| across all particles. */
  avgRelError: number;
  maxRelError: number;
  /** Index of the worst-offending particle, for follow-up inspection. */
  worstIndex: number;
  gpuHasNaN: boolean;
  /** Sum of coarseCellMass should equal `count` (mass=1/particle, see
   * GpuUniformGrid's doc comment) -- a mismatch means the grid build lost
   * or double-counted particles somewhere (count/scatter/aggregate bug). */
  coarseMassTotal: number;
}

/**
 * Dev-only cross-backend correctness check for the M6 GPU gravity port.
 * Seeds *identical* positions directly onto a throwaway GpuBackend (via
 * `debugSetPositions`, bypassing its own RNG-based init) and compares its
 * one-shot accelerations against `computeGridGravity`'s CPU output for the
 * same positions, same grid sizing, same G/softening/domainRadius --
 * *not* against the brute-force reference, since grid-vs-brute-force has
 * its own expected ~10-40% approximation error (see gravity.test.ts) that
 * would swamp a real GPU-port bug. This isolates "did the GPU faithfully
 * reproduce computeGridGravity's math" from "how good is the grid
 * approximation" (the latter is already covered by the existing CPU test).
 *
 * A single scalar like RMS radius over a run (the M6 verification done so
 * far) can't rule out subtle bugs -- e.g. an off-by-one in fine-cell
 * indexing that only misfires for particles near a cell boundary, or an
 * atomic race in the counting-sort scatter. This is the harder check.
 *
 * Call from a dev console via `window.__debug.verifyGpuGravity(count)`.
 */
export async function verifyGpuGravity(
  renderer: THREE.WebGPURenderer,
  params: SimParams,
  count = 500,
): Promise<GravityParityResult> {
  const positions = new Float32Array(count * 3);
  fillUniformBall(positions, count, params.domainRadius * 0.6);
  const masses = new Float32Array(count).fill(1);
  const gravityParams = { G: params.gravityG, softening: params.softening };

  const cpuGrid = new UniformGrid(count, computeGridSizing(count));
  cpuGrid.build(positions, masses, count, params.domainRadius);
  const cpuAcc = new Float32Array(count * 3);
  computeGridGravity(positions, masses, count, cpuGrid, gravityParams, cpuAcc);

  const gpu = new GpuBackend(renderer);
  gpu.init(count, params);
  gpu.debugSetPositions(positions);
  const gpuAcc = await gpu.debugComputeAccelerations();
  const coarseCellMass = new Float32Array(
    await renderer.getArrayBufferAsync(gpu.debugGrid.coarseCellMass.value as THREE.BufferAttribute),
  );
  let coarseMassTotal = 0;
  for (const m of coarseCellMass) coarseMassTotal += m;
  gpu.dispose();

  let sumRelErr = 0;
  let maxRelErr = 0;
  let worstIndex = -1;
  let gpuHasNaN = false;
  for (let i = 0; i < count; i++) {
    const cx = cpuAcc[i * 3];
    const cy = cpuAcc[i * 3 + 1];
    const cz = cpuAcc[i * 3 + 2];
    const gx = gpuAcc[i * 3];
    const gy = gpuAcc[i * 3 + 1];
    const gz = gpuAcc[i * 3 + 2];
    if (Number.isNaN(gx) || Number.isNaN(gy) || Number.isNaN(gz)) {
      gpuHasNaN = true;
      continue;
    }
    const cpuMag = Math.hypot(cx, cy, cz) || 1e-12;
    const errMag = Math.hypot(gx - cx, gy - cy, gz - cz);
    const relErr = errMag / cpuMag;
    sumRelErr += relErr;
    if (relErr > maxRelErr) {
      maxRelErr = relErr;
      worstIndex = i;
    }
  }

  return {
    count,
    avgRelError: sumRelErr / count,
    maxRelError: maxRelErr,
    worstIndex,
    gpuHasNaN,
    coarseMassTotal,
  };
}

export interface GridParityResult {
  count: number;
  fineCellCount: number;
  /** First fine cell index (if any) where GPU's [start,end) member set
   * differs from CPU's -- pinpoints whether a mismatch is in the
   * count/scatter passes (this would be non-null) or downstream in the
   * gravity kernel itself (this would stay null while gravity still
   * diverges). */
  firstMismatchedCell: number | null;
  mismatchedCellCount: number;
  /** Max abs diff between GPU and CPU fineCellMass -- should be exactly 0
   * (mass=1/particle, cell mass is just a member count). */
  maxFineMassDiff: number;
  /** Max abs diff between GPU and CPU coarseCellMass -- should be exactly 0. */
  maxCoarseMassDiff: number;
}

/**
 * Bisects `verifyGpuGravity`'s failure: builds the CPU grid and reads back
 * every GPU grid buffer for the *same* positions, then diffs them directly
 * -- isolating "the grid build (GpuUniformGrid) is wrong" from "the grid
 * build is fine but gravityKernel misuses it". Compares cell *membership
 * sets* (not raw `sortedIndices` array equality), since CPU and GPU fill a
 * cell's particles in different orders (CPU: sequential; GPU: whichever
 * order the atomic scatter's threads happen to complete in) -- only the
 * per-cell set and the derived aggregates need to match, not the order.
 */
export async function verifyGpuGrid(
  renderer: THREE.WebGPURenderer,
  params: SimParams,
  count = 500,
): Promise<GridParityResult> {
  const positions = new Float32Array(count * 3);
  fillUniformBall(positions, count, params.domainRadius * 0.6);
  const masses = new Float32Array(count).fill(1);

  const cpuGrid = new UniformGrid(count, computeGridSizing(count));
  cpuGrid.build(positions, masses, count, params.domainRadius);

  const gpu = new GpuBackend(renderer);
  gpu.init(count, params);
  gpu.debugSetPositions(positions);
  // Force one grid build without a full gravity/integrate pass.
  await gpu.debugComputeAccelerations();
  const grid = gpu.debugGrid;

  const gpuFineCellStart = new Int32Array(
    await renderer.getArrayBufferAsync(grid.fineCellStart.value as THREE.BufferAttribute),
  );
  const gpuSortedIndices = new Int32Array(
    await renderer.getArrayBufferAsync(grid.sortedIndices.value as THREE.BufferAttribute),
  );
  const gpuFineCellMass = new Float32Array(
    await renderer.getArrayBufferAsync(grid.fineCellMass.value as THREE.BufferAttribute),
  );
  const gpuCoarseCellMass = new Float32Array(
    await renderer.getArrayBufferAsync(grid.coarseCellMass.value as THREE.BufferAttribute),
  );
  gpu.dispose();

  const fineCellCount = grid.fineCellCount;
  let firstMismatchedCell: number | null = null;
  let mismatchedCellCount = 0;
  let maxFineMassDiff = 0;

  for (let c = 0; c < fineCellCount; c++) {
    maxFineMassDiff = Math.max(maxFineMassDiff, Math.abs(gpuFineCellMass[c] - cpuGrid.fineCellMass[c]));

    const cpuStart = cpuGrid.fineCellStart[c];
    const cpuEnd = cpuGrid.fineCellStart[c + 1];
    const gpuStart = gpuFineCellStart[c];
    const gpuEnd = gpuFineCellStart[c + 1];

    const cpuMembers = new Set(Array.from(cpuGrid.sortedIndices.subarray(cpuStart, cpuEnd)));
    const gpuMembers = new Set(Array.from(gpuSortedIndices.subarray(gpuStart, gpuEnd)));
    const setsMatch =
      cpuMembers.size === gpuMembers.size && [...cpuMembers].every((idx) => gpuMembers.has(idx));

    if (!setsMatch) {
      mismatchedCellCount++;
      if (firstMismatchedCell === null) firstMismatchedCell = c;
    }
  }

  let maxCoarseMassDiff = 0;
  for (let c = 0; c < gpuCoarseCellMass.length; c++) {
    maxCoarseMassDiff = Math.max(maxCoarseMassDiff, Math.abs(gpuCoarseCellMass[c] - cpuGrid.coarseCellMass[c]));
  }

  return { count, fineCellCount, firstMismatchedCell, mismatchedCellCount, maxFineMassDiff, maxCoarseMassDiff };
}

export interface GravityStageResult {
  count: number;
  /** avgRelError comparing CPU's corrected output against GPU's raw
   * (pre-momentum-correction) output with the *same* correction formula
   * re-applied in plain JS -- isolates gravityKernel (near+far-field sum)
   * from momentumReduceKernel/momentumApplyKernel. If this is small while
   * verifyGpuGravity's own avgRelError is large, the bug is in the GPU
   * momentum-correction kernels, not the force sum itself. */
  avgRelErrorGravityOnly: number;
  maxRelErrorGravityOnly: number;
}

/**
 * Bisects a `verifyGpuGravity` failure the other way from `verifyGpuGrid`:
 * assumes the grid is fine (already confirmed separately) and checks
 * whether `gravityKernel`'s near+far-field sum matches CPU's, independent
 * of whether `momentumReduceKernel`/`momentumApplyKernel` are correct --
 * by taking GPU's *raw* per-particle accelerations and applying the same
 * mass=1 net-momentum correction manually in JS (identical to what
 * `computeGridGravity` does internally), then comparing that against
 * `computeGridGravity`'s own (CPU-corrected) output.
 */
export async function verifyGpuGravityStages(
  renderer: THREE.WebGPURenderer,
  params: SimParams,
  count = 500,
): Promise<GravityStageResult> {
  const positions = new Float32Array(count * 3);
  fillUniformBall(positions, count, params.domainRadius * 0.6);
  const masses = new Float32Array(count).fill(1);
  const gravityParams = { G: params.gravityG, softening: params.softening };

  const cpuGrid = new UniformGrid(count, computeGridSizing(count));
  cpuGrid.build(positions, masses, count, params.domainRadius);
  const cpuAcc = new Float32Array(count * 3);
  computeGridGravity(positions, masses, count, cpuGrid, gravityParams, cpuAcc);

  const gpu = new GpuBackend(renderer);
  gpu.init(count, params);
  gpu.debugSetPositions(positions);
  const rawAcc = await gpu.debugComputeAccelerationsRaw();
  gpu.dispose();

  // Same correction computeGridGravity applies internally: subtract the
  // mean acceleration (mass=1/particle, so mass-weighted mean == plain mean).
  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;
  for (let i = 0; i < count; i++) {
    sumX += rawAcc[i * 3];
    sumY += rawAcc[i * 3 + 1];
    sumZ += rawAcc[i * 3 + 2];
  }
  const biasX = sumX / count;
  const biasY = sumY / count;
  const biasZ = sumZ / count;

  let sumRelErr = 0;
  let maxRelErr = 0;
  for (let i = 0; i < count; i++) {
    const gx = rawAcc[i * 3] - biasX;
    const gy = rawAcc[i * 3 + 1] - biasY;
    const gz = rawAcc[i * 3 + 2] - biasZ;
    const cx = cpuAcc[i * 3];
    const cy = cpuAcc[i * 3 + 1];
    const cz = cpuAcc[i * 3 + 2];
    const cpuMag = Math.hypot(cx, cy, cz) || 1e-12;
    const relErr = Math.hypot(gx - cx, gy - cy, gz - cz) / cpuMag;
    sumRelErr += relErr;
    if (relErr > maxRelErr) maxRelErr = relErr;
  }

  return { count, avgRelErrorGravityOnly: sumRelErr / count, maxRelErrorGravityOnly: maxRelErr };
}

/** Near-field-only extract of `computeGridGravity` (src/sim/cpu/physics/gravity.ts),
 * duplicated here (not imported) purely so this debug module can compare
 * against GPU's near-field-only output in isolation -- computeGridGravity
 * itself always computes near+far+correction together. */
function cpuNearFieldOnly(
  positions: Float32Array,
  count: number,
  grid: UniformGrid,
  G: number,
  softening: number,
  out: Float32Array,
): void {
  const eps2 = softening * softening;
  const fineAxis = grid.fineCellsPerAxis;
  const { fineCellStart, sortedIndices, particleFineCell } = grid;
  out.fill(0);

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
            const g = G * invDist3; // mass_j = 1
            ax += g * dxp;
            ay += g * dyp;
            az += g * dzp;
          }
        }
      }
    }

    out[ix] = ax;
    out[ix + 1] = ay;
    out[ix + 2] = az;
  }
}

/** Far-field-only extract of `computeGridGravity`, same rationale as
 * `cpuNearFieldOnly` above. */
function cpuFarFieldOnly(
  positions: Float32Array,
  count: number,
  grid: UniformGrid,
  G: number,
  softening: number,
  out: Float32Array,
): void {
  const eps2 = softening * softening;
  const fineAxis = grid.fineCellsPerAxis;
  const coarseAxis = grid.coarseCellsPerAxis;
  const blockSize = grid.blockSize;
  const { particleFineCell, coarseCellMass, coarseCellComX, coarseCellComY, coarseCellComZ } = grid;
  out.fill(0);

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

    out[ix] = ax;
    out[ix + 1] = ay;
    out[ix + 2] = az;
  }
}

export interface GravityTermResult {
  count: number;
  avgRelErrorNear: number;
  maxRelErrorNear: number;
  avgRelErrorFar: number;
  maxRelErrorFar: number;
}

function relErrorStats(
  gpuAcc: Float32Array,
  cpuAcc: Float32Array,
  count: number,
): { avg: number; max: number } {
  let sum = 0;
  let max = 0;
  for (let i = 0; i < count; i++) {
    const gx = gpuAcc[i * 3];
    const gy = gpuAcc[i * 3 + 1];
    const gz = gpuAcc[i * 3 + 2];
    const cx = cpuAcc[i * 3];
    const cy = cpuAcc[i * 3 + 1];
    const cz = cpuAcc[i * 3 + 2];
    const cpuMag = Math.hypot(cx, cy, cz) || 1e-12;
    const relErr = Math.hypot(gx - cx, gy - cy, gz - cz) / cpuMag;
    sum += relErr;
    if (relErr > max) max = relErr;
  }
  return { avg: sum / count, max };
}

/** Raw per-particle dump for manual inspection at tiny N -- prints
 * positions plus CPU/GPU near-field accelerations side by side so a pattern
 * (wrong sign, extra scale factor, swapped axis, etc.) can be spotted by
 * eye instead of just seeing an aggregate relative-error number. */
export async function dumpGravityComparison(
  renderer: THREE.WebGPURenderer,
  params: SimParams,
  count = 4,
): Promise<unknown> {
  const positions = new Float32Array(count * 3);
  fillUniformBall(positions, count, params.domainRadius * 0.6);
  const masses = new Float32Array(count).fill(1);

  const cpuGrid = new UniformGrid(count, computeGridSizing(count));
  cpuGrid.build(positions, masses, count, params.domainRadius);
  const cpuNear = new Float32Array(count * 3);
  cpuNearFieldOnly(positions, count, cpuGrid, params.gravityG, params.softening, cpuNear);

  const gpu = new GpuBackend(renderer);
  gpu.init(count, params);
  gpu.debugSetPositions(positions);
  const gpuNear = await gpu.debugComputeAccelerationsWithMode({ includeNear: true, includeFar: false });
  gpu.dispose();

  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      i,
      pos: [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]],
      cpuNear: [cpuNear[i * 3], cpuNear[i * 3 + 1], cpuNear[i * 3 + 2]],
      gpuNear: [gpuNear[i * 3], gpuNear[i * 3 + 1], gpuNear[i * 3 + 2]],
      fineCell: cpuGrid.particleFineCell[i],
    });
  }
  return { count, fineCellsPerAxis: cpuGrid.fineCellsPerAxis, rows };
}

/**
 * Bisects `verifyGpuGravityStages`' failure the rest of the way: compares
 * GPU's near-field-only and far-field-only outputs (via
 * `debugComputeAccelerationsWithMode`) against `cpuNearFieldOnly`/
 * `cpuFarFieldOnly` independently, pinning the bug to one term or the other.
 */
export async function verifyGpuGravityTerms(
  renderer: THREE.WebGPURenderer,
  params: SimParams,
  count = 500,
): Promise<GravityTermResult> {
  const positions = new Float32Array(count * 3);
  fillUniformBall(positions, count, params.domainRadius * 0.6);
  const masses = new Float32Array(count).fill(1);

  const cpuGrid = new UniformGrid(count, computeGridSizing(count));
  cpuGrid.build(positions, masses, count, params.domainRadius);

  const cpuNear = new Float32Array(count * 3);
  cpuNearFieldOnly(positions, count, cpuGrid, params.gravityG, params.softening, cpuNear);
  const cpuFar = new Float32Array(count * 3);
  cpuFarFieldOnly(positions, count, cpuGrid, params.gravityG, params.softening, cpuFar);

  const gpu = new GpuBackend(renderer);
  gpu.init(count, params);
  gpu.debugSetPositions(positions);
  const gpuNear = await gpu.debugComputeAccelerationsWithMode({ includeNear: true, includeFar: false });
  const gpuFar = await gpu.debugComputeAccelerationsWithMode({ includeNear: false, includeFar: true });
  gpu.dispose();

  const near = relErrorStats(gpuNear, cpuNear, count);
  const far = relErrorStats(gpuFar, cpuFar, count);

  return {
    count,
    avgRelErrorNear: near.avg,
    maxRelErrorNear: near.max,
    avgRelErrorFar: far.avg,
    maxRelErrorFar: far.max,
  };
}
