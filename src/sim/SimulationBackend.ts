import type { SimParams } from '../app/Config.ts';

export interface ParticleSnapshot {
  count: number;
  /** length count*3, x/y/z interleaved. Backends mutate this array in place
   * each step rather than reallocating, so renderers can hold a direct
   * reference instead of copying every frame. */
  positions: Float32Array;
}

export interface SimulationBackend {
  /** (Re)allocates internal buffers for `count` particles and seeds initial state. */
  init(count: number, params: SimParams): void;
  /** Advances the simulation by `dt` seconds. */
  step(dt: number): void;
  /** Applies live-tunable parameter changes without reallocating buffers. */
  setParams(params: Partial<SimParams>): void;
  getSnapshot(): ParticleSnapshot;
  dispose(): void;
}
