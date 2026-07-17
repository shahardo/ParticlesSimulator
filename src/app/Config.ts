/** What happens when a particle's position crosses the domain boundary.
 * `bounce` was the only behavior through M7 (a fold-back reflection, see
 * CpuBackend/GpuBackend's integrate step); `vanish` and `wraparound` were
 * added after. */
export type WallBehavior = 'bounce' | 'vanish' | 'wraparound';

export interface SimParams {
  particleCount: number;
  domainRadius: number;
  gravityG: number;
  softening: number;
  wallBehavior: WallBehavior;
}

export const PARTICLE_COUNT_MIN = 100;
// M4's uniform-grid CPU gravity measured (this machine): ~30ms/step at
// N=5,000, ~128ms/step at N=20,000, ~503ms/step at N=50,000 -- a growing
// win over brute force at every size tested (3.7x-24x faster), but not
// perfectly O(N) since coarse-cell count grows with N too (a full adaptive
// octree would do better; out of scope for this simpler 2-level grid, see
// UniformGrid.ts). Capped at 20,000 here to stay watchable (~8fps
// worst-case) rather than the ~2fps 50,000 would give.
export const CPU_PARTICLE_COUNT_MAX = 20_000;
// M6's GPU gravity port measured (this machine, real WebGPU adapter):
// ~41ms/step at N=100,000 (comfortably interactive), ~294ms/step at
// N=250,000 (~3.4fps, not interactive) -- see docs/devplan.md's M6 as-built
// notes. Set to the project's original 1,000,000 target rather than a
// tighter measured cap: M7's adaptive startup benchmark (src/app/gpuBenchmark.ts)
// picks a sane *default* N from real hardware timing, but the slider itself
// still allows dragging up to the full original goal if the user wants to
// push past what's comfortable.
export const GPU_PARTICLE_COUNT_MAX = 1_000_000;

export const DOMAIN_RADIUS_MIN = 1;
export const DOMAIN_RADIUS_MAX = 20;

// Initial cloud radius as a fraction of domainRadius -- was implicitly 0.6
// (a cloud filling most of the box); shrunk so the box-to-cloud ratio is
// clearly larger and gravity has real room to pull the cloud together
// before it reaches a wall.
export const INITIAL_CLOUD_RADIUS_FRACTION = 0.15;

// Where a "vanish"-mode particle gets moved on death, effectively hiding it
// from both render paths for free: CpuParticlePoints/GpuParticlePoints draw
// straight from the position buffer with no separate per-particle
// visibility channel, but the scene camera's far plane is a fixed 1000
// (see render/scene.ts) regardless of domainRadius, so parking a dead
// particle far beyond that gets it clipped by the GPU rasterizer without
// needing one. Mass is zeroed at the same time (see CpuBackend/GpuBackend),
// which is what actually makes this safe for the grid's center-of-mass math
// -- multiplying a huge coordinate by zero mass is exactly zero, not a
// corrupted aggregate.
export const WALL_VANISH_DISTANCE = 5_000;

export const defaultParams: SimParams = {
  particleCount: 5_000,
  domainRadius: 6,
  gravityG: 0.001,
  // Raised from 0.08 alongside INITIAL_CLOUD_RADIUS_FRACTION's shrink: with
  // N fixed, a smaller starting radius packs the same particle count into
  // much less typical spacing, and 0.08 (tuned for the old, roomier cloud)
  // was too small a softening length for that -- starting from rest, the
  // old value caused violent close-encounter slingshots (particles
  // reaching escape velocity within the first few frames).
  //
  // This is a genuinely *stochastic* effect, not a clean function of N or
  // softening -- violent few-body ejections during a dense collapse are a
  // real, chaotic phenomenon (astrophysically: "violent relaxation"),
  // extremely sensitive to the specific random initial positions. Measured
  // directly (this machine, N=5,000, this value): reliably calm across
  // repeated fresh trials and a 900-step/15-simulated-second run (RMS
  // radius flat at ~0.6-0.7, max radius 0.9-2.2, comfortably inside
  // domainRadius=6). But this is *not* a guarantee at every N: the same
  // 0.3 exploded at N=15,000 in testing, and even 0.5 calmly settled at
  // N=15,000 and N=100,000 but exploded at N=50,000 -- there is no fixed
  // softening found so far that eliminates this across the GPU path's full
  // adaptively-benchmarked N range (which regularly picks tens of
  // thousands to 100k+, well above this constant's tuning point). Decided
  // to accept that tradeoff rather than over-soften the common case: 0.3
  // is tuned for the CPU path's typical N (where it's been reliable) and
  // the default any session starts from; an occasional violent GPU-path
  // run at high adaptively-chosen N is a known, accepted possibility, not
  // a bug to keep chasing with a bigger constant.
  softening: 0.3,
  wallBehavior: 'bounce',
};
