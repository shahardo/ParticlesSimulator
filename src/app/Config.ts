export interface SimParams {
  particleCount: number;
  domainRadius: number;
  gravityG: number;
  softening: number;
}

export const PARTICLE_COUNT_MIN = 100;
// M4's uniform-grid CPU gravity measured (this machine): ~30ms/step at
// N=5,000, ~128ms/step at N=20,000, ~503ms/step at N=50,000 -- a growing
// win over brute force at every size tested (3.7x-24x faster), but not
// perfectly O(N) since coarse-cell count grows with N too (a full adaptive
// octree would do better; out of scope for this simpler 2-level grid, see
// UniformGrid.ts). Capped at 20,000 here to stay watchable (~8fps
// worst-case) rather than the ~2fps 50,000 would give; rises to 1,000,000
// in M7 once the GPU backend exists.
export const PARTICLE_COUNT_MAX = 20_000;

export const DOMAIN_RADIUS_MIN = 1;
export const DOMAIN_RADIUS_MAX = 20;

export const defaultParams: SimParams = {
  particleCount: 5_000,
  domainRadius: 6,
  gravityG: 0.001,
  softening: 0.08,
};
