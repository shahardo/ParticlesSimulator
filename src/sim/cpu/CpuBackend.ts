import type { SimulationBackend, ParticleSnapshot } from '../SimulationBackend.ts';
import type { SimParams } from '../../app/Config.ts';
import { fillUniformBall } from '../../utils/math.ts';
import { computeBruteForceGravity } from './physics/gravity.ts';

/** M3: brute-force O(N^2) softened-Newtonian gravity, starting from rest so
 * clumping is easy to eyeball -- the correctness reference before the
 * uniform-grid version (M4) that scales to much larger N. */
export class CpuBackend implements SimulationBackend {
  private count = 0;
  private domainRadius = 1;
  private gravityG = 0;
  private softening = 0.01;
  private positions = new Float32Array(0);
  private velocities = new Float32Array(0);
  private accelerations = new Float32Array(0);
  private masses = new Float32Array(0);

  init(count: number, params: SimParams): void {
    this.count = count;
    this.domainRadius = params.domainRadius;
    this.gravityG = params.gravityG;
    this.softening = params.softening;

    this.positions = new Float32Array(count * 3);
    this.velocities = new Float32Array(count * 3);
    this.accelerations = new Float32Array(count * 3);
    this.masses = new Float32Array(count).fill(1);

    fillUniformBall(this.positions, count, this.domainRadius * 0.6);
    // Start from rest: gravity pulling an initially-static cloud into a
    // clump is the simplest possible visual/numerical correctness check.
  }

  setParams(params: Partial<SimParams>): void {
    if (params.domainRadius !== undefined) this.domainRadius = params.domainRadius;
    if (params.gravityG !== undefined) this.gravityG = params.gravityG;
    if (params.softening !== undefined) this.softening = params.softening;
  }

  step(dt: number): void {
    computeBruteForceGravity(
      this.positions,
      this.masses,
      this.count,
      { G: this.gravityG, softening: this.softening },
      this.accelerations,
    );

    const R = this.domainRadius;
    const { positions, velocities, accelerations } = this;

    for (let i = 0; i < positions.length; i++) {
      // Semi-implicit (symplectic) Euler: update velocity first, then use
      // the *new* velocity to advance position -- conserves energy far
      // better than explicit Euler over long-running orbital dynamics.
      velocities[i] += accelerations[i] * dt;
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
    this.accelerations = new Float32Array(0);
    this.masses = new Float32Array(0);
  }
}
