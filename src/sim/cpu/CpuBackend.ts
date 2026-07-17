import type { SimulationBackend, ParticleSnapshot } from '../SimulationBackend.ts';
import type { SimParams, WallBehavior } from '../../app/Config.ts';
import { INITIAL_CLOUD_RADIUS_FRACTION, WALL_VANISH_DISTANCE } from '../../app/Config.ts';
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
  private wallBehavior: WallBehavior = 'bounce';
  private positions = new Float32Array(0);
  private velocities = new Float32Array(0);
  private accelerations = new Float32Array(0);
  // Doubles as the "vanish" mode's alive flag: dead particles are given
  // mass 0, which the grid/gravity math already treats as "contributes
  // nothing" with no further changes needed there (see gravity.ts's
  // mass-weighted center-of-mass and momentum-correction math) -- no
  // separate alive buffer required.
  private masses = new Float32Array(0);
  private grid = new UniformGrid(0, { fineCellsPerAxis: 4, coarseCellsPerAxis: 1, blockSize: 4 });

  init(count: number, params: SimParams): void {
    this.count = count;
    this.domainRadius = params.domainRadius;
    this.gravityG = params.gravityG;
    this.softening = params.softening;
    this.wallBehavior = params.wallBehavior;

    this.positions = new Float32Array(count * 3);
    this.velocities = new Float32Array(count * 3);
    this.accelerations = new Float32Array(count * 3);
    this.masses = new Float32Array(count).fill(1);
    this.grid = new UniformGrid(count, computeGridSizing(count));

    fillUniformBall(this.positions, count, this.domainRadius * INITIAL_CLOUD_RADIUS_FRACTION);
    // Start from rest: gravity pulling an initially-static cloud into a
    // clump is the simplest possible visual/numerical correctness check.
  }

  setParams(params: Partial<SimParams>): void {
    if (params.domainRadius !== undefined) this.domainRadius = params.domainRadius;
    if (params.gravityG !== undefined) this.gravityG = params.gravityG;
    if (params.softening !== undefined) this.softening = params.softening;
    if (params.wallBehavior !== undefined) this.wallBehavior = params.wallBehavior;
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
    const { positions, velocities, accelerations, masses, wallBehavior } = this;

    for (let i = 0; i < this.count; i++) {
      // Permanently vanished (mass zeroed below on some earlier step) --
      // skip regardless of the *current* wallBehavior, so switching modes
      // mid-session doesn't resurrect or otherwise perturb a dead particle.
      if (masses[i] === 0) continue;

      const ix = i * 3;
      let outOfBounds = false;

      for (let axis = 0; axis < 3; axis++) {
        const k = ix + axis;
        // Semi-implicit (symplectic) Euler: update velocity first, then use
        // the *new* velocity to advance position -- conserves energy far
        // better than explicit Euler over long-running orbital dynamics.
        velocities[k] += accelerations[k] * dt;
        let p = positions[k] + velocities[k] * dt;

        if (wallBehavior === 'bounce') {
          // Fold-back (not just clamp+negate) so a large single-step
          // overshoot still lands at a physically sane spot.
          if (p > R) {
            p = R - (p - R);
            velocities[k] = -velocities[k];
          } else if (p < -R) {
            p = -R - (p + R);
            velocities[k] = -velocities[k];
          }
        } else if (wallBehavior === 'wraparound') {
          if (p > R) p -= 2 * R;
          else if (p < -R) p += 2 * R;
        } else if (p > R || p < -R) {
          // vanish: don't fold/wrap this axis -- just flag it and let the
          // whole particle die below, once all three axes are known.
          outOfBounds = true;
        }

        positions[k] = p;
      }

      if (wallBehavior === 'vanish' && outOfBounds) {
        masses[i] = 0;
        velocities[ix] = 0;
        velocities[ix + 1] = 0;
        velocities[ix + 2] = 0;
        // Parks it beyond the camera's far plane (see Config.ts's
        // WALL_VANISH_DISTANCE doc comment) -- safe now that its mass is 0,
        // since the grid's center-of-mass sums weight this position by
        // that mass.
        positions[ix] = WALL_VANISH_DISTANCE;
        positions[ix + 1] = WALL_VANISH_DISTANCE;
        positions[ix + 2] = WALL_VANISH_DISTANCE;
      }
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
