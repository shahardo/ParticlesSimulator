import type * as THREE from 'three/webgpu';
import { GpuBackend } from '../sim/gpu/GpuBackend.ts';
import type { SimParams } from './Config.ts';
import { PARTICLE_COUNT_MIN, GPU_PARTICLE_COUNT_MAX } from './Config.ts';

/**
 * M7: adaptive-N startup benchmark. Builds a throwaway `GpuBackend` at a
 * small calibration N, times a few real `step()`s (forcing a GPU sync via
 * `debugReadPositions()` -- `step()` itself only enqueues compute commands,
 * so wall-clock time around bare `step()` calls alone would just measure
 * how fast the CPU can submit them, not real GPU cost), and extrapolates a
 * particle count that should keep each physics step under a target frame
 * budget.
 *
 * Assumes roughly linear cost scaling with N. That's not exact -- far-field
 * cost grows a little worse than linear as documented in docs/devplan.md's
 * Risks section -- but exact scaling would need a second calibration point
 * (two runs at different N to fit the curve), which doubles startup cost
 * for a correction that only matters much closer to the 250k+ range where
 * this estimate's conservative rounding already leaves headroom.
 */
export async function benchmarkGpuParticleCount(
  renderer: THREE.WebGPURenderer,
  params: SimParams,
): Promise<number> {
  const calibrationCount = 20_000;
  const targetMsPerStep = 33; // ~30fps budget for the physics step alone

  const bench = new GpuBackend(renderer);
  bench.init(calibrationCount, params);

  const dt = 1 / 60;
  // Warm up: the first dispatch of each kernel pays a one-time pipeline/
  // shader-compile cost that wouldn't recur in steady-state playback.
  bench.step(dt);
  await bench.debugReadPositions();

  const trials = 5;
  const start = performance.now();
  for (let i = 0; i < trials; i++) bench.step(dt);
  await bench.debugReadPositions();
  const msPerStep = (performance.now() - start) / trials;

  bench.dispose();

  const scale = targetMsPerStep / msPerStep;
  const estimated = Math.round((calibrationCount * scale) / 1000) * 1000;
  return Math.max(PARTICLE_COUNT_MIN, Math.min(GPU_PARTICLE_COUNT_MAX, estimated));
}
