import type { SimParams } from '../app/Config.ts';

export interface ParticleSnapshot {
  count: number;
  /** length count*3, x/y/z interleaved. Backends mutate this array in place
   * each step rather than reallocating, so renderers can hold a direct
   * reference instead of copying every frame. */
  positions: Float32Array;
}

export interface SimulationBackend {
  /** Lets rendering code branch on which render path to use -- GPU-resident
   * data can't be read back into `getSnapshot()` synchronously every frame
   * without defeating the point of GPU compute, so the two backends need
   * genuinely different render wiring (see GpuBackend/GpuParticlePoints). */
  readonly kind: 'cpu' | 'gpu';
  /** (Re)allocates internal buffers for `count` particles and seeds initial state. */
  init(count: number, params: SimParams): void;
  /** Advances the simulation by `dt` seconds. */
  step(dt: number): void;
  /** Applies live-tunable parameter changes without reallocating buffers. */
  setParams(params: Partial<SimParams>): void;
  /** CPU-readable snapshot. Cheap and meaningful for CpuBackend (a direct
   * array reference); GpuBackend doesn't implement this synchronously --
   * see its class doc for why, and its debugReadPositions() for the async
   * alternative used only for manual/test verification. */
  getSnapshot(): ParticleSnapshot;
  dispose(): void;
}
