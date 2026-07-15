import type { SimulationBackend } from '../sim/SimulationBackend.ts';
import type { SimParams } from './Config.ts';

/** Owns the play/pause/timestep clock around whichever SimulationBackend is
 * currently active. Renderer and UI code don't need to know backend details
 * -- they call tick() and read getSnapshot(). */
export class App {
  playing = true;
  timeScale = 1;

  constructor(private backend: SimulationBackend) {}

  setBackend(backend: SimulationBackend): void {
    this.backend = backend;
  }

  /** Exposes whichever backend is currently active -- for the
   * window.__debug hook (see SKILL.md) to reach CPU-specific fields
   * (positions/velocities/masses) or GpuBackend's debugReadPositions();
   * not used by any production render/UI code path. */
  getBackend(): SimulationBackend {
    return this.backend;
  }

  /** Advances the simulation clock by `realDtSeconds` of wall-clock time, if playing. */
  tick(realDtSeconds: number): void {
    if (!this.playing) return;
    this.backend.step(realDtSeconds * this.timeScale);
  }

  getSnapshot() {
    return this.backend.getSnapshot();
  }

  /** Forwards live-tunable param changes to whichever backend is currently
   * active -- so callers don't need to keep their own backend reference
   * around just to reach setParams() after a GPU<->CPU switch. */
  setParams(partial: Partial<SimParams>): void {
    this.backend.setParams(partial);
  }
}
