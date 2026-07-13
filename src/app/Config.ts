export interface SimParams {
  particleCount: number;
  domainRadius: number;
  gravityG: number;
  softening: number;
}

export const PARTICLE_COUNT_MIN = 100;
// M3's gravity is brute-force O(N^2) -- this ceiling keeps it interactive.
// Rises to the tens of thousands in M4 (uniform-grid CPU gravity), and to
// 1,000,000 in M7 once the GPU backend exists.
export const PARTICLE_COUNT_MAX = 2_000;

export const defaultParams: SimParams = {
  particleCount: 1_000,
  domainRadius: 3,
  gravityG: 0.001,
  softening: 0.08,
};
