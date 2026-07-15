import type { SimulationBackend, ParticleSnapshot } from '../SimulationBackend.ts';
import type { SimParams } from '../../app/Config.ts';
import { fillUniformBall } from '../../utils/math.ts';
import { computeGridGravity } from './physics/gravity.ts';
import { computeGridSizing, UniformGrid } from './grid/UniformGrid.ts';

/** M4: softened-Newtonian gravity via a shared fine+coarse UniformGrid
 * (rebuilt every step), replacing M3's O(N^2) brute force so N can scale
 * into the tens of thousands. Particles still start from rest. */
export class CpuBackend implements SimulationBackend {
  readonly kind = 'cpu' as const;
  private count = 0;
  private domainRadius = 1;
  private gravityG = 0;
  private softening = 0.01;
  private positions = new Float32Array(0);
  private velocities = new Float32Array(0);
  private accelerations = new Float32Array(0);
  private masses = new Float32Array(0);
  private grid = new UniformGrid(0, { fineCellsPerAxis: 4, coarseCellsPerAxis: 1, blockSize: 4 });

  init(count: number, params: SimParams): void {
    this.count = count;
    this.domainRadius = params.domainRadius;
    this.gravityG = params.gravityG;
    this.softening = params.softening;

    this.positions = new Float32Array(count * 3);
    this.velocities = new Float32Array(count * 3);
    this.accelerations = new Float32Array(count * 3);
    this.masses = new Float32Array(count).fill(1);
    this.grid = new UniformGrid(count, computeGridSizing(count));

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
    this.grid.build(this.positions, this.masses, this.count, this.domainRadius);
    computeGridGravity(
      this.positions,
      this.masses,
      this.count,
      this.grid,
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
