import type { SimulationBackend, ParticleSnapshot } from '../SimulationBackend.ts';
import type { SimParams } from '../../app/Config.ts';
import { fillUniformBall, randnBoxMuller } from '../../utils/math.ts';

/** M2: zero forces -- particles just drift ballistically and bounce off a
 * fixed cube domain. This exists to prove the backend/App/renderer wiring
 * (play, pause, timestep) works before any real physics (M3+) lands. */
export class CpuBackend implements SimulationBackend {
  private count = 0;
  private domainRadius = 1;
  private positions = new Float32Array(0);
  private velocities = new Float32Array(0);

  init(count: number, params: SimParams): void {
    this.count = count;
    this.domainRadius = params.domainRadius;
    this.positions = new Float32Array(count * 3);
    this.velocities = new Float32Array(count * 3);

    fillUniformBall(this.positions, count, this.domainRadius * 0.6);

    const speed = this.domainRadius * 0.15;
    for (let i = 0; i < count * 3; i++) {
      this.velocities[i] = randnBoxMuller() * speed;
    }
  }

  setParams(params: Partial<SimParams>): void {
    if (params.domainRadius !== undefined) this.domainRadius = params.domainRadius;
  }

  step(dt: number): void {
    const R = this.domainRadius;
    const { positions, velocities } = this;

    for (let i = 0; i < positions.length; i++) {
      let p = positions[i] + velocities[i] * dt;
      // Fold-back bounce off a cube domain wall (not just clamp+negate, so a
      // large single-step overshoot still lands at a physically sane spot).
      if (p > R) {
        p = R - (p - R);
        velocities[i] = -velocities[i];
      } else if (p < -R) {
        p = -R - (p + R);
        velocities[i] = -velocities[i];
      }
      positions[i] = p;
    }
  }

  getSnapshot(): ParticleSnapshot {
    return { count: this.count, positions: this.positions };
  }

  dispose(): void {
    this.positions = new Float32Array(0);
    this.velocities = new Float32Array(0);
  }
}
