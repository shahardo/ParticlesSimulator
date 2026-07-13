import type { SimulationBackend } from '../sim/SimulationBackend.ts';

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

  /** Advances the simulation clock by `realDtSeconds` of wall-clock time, if playing. */
  tick(realDtSeconds: number): void {
    if (!this.playing) return;
    this.backend.step(realDtSeconds * this.timeScale);
  }

  getSnapshot() {
    return this.backend.getSnapshot();
  }
}
