export interface SimParams {
  particleCount: number;
  domainRadius: number;
}

export const PARTICLE_COUNT_MIN = 1_000;
export const PARTICLE_COUNT_MAX = 1_000_000;

export const defaultParams: SimParams = {
  particleCount: 200_000,
  domainRadius: 3,
};
