import { describe, expect, it } from 'vitest';
import { computeBruteForceGravity, computeGridGravity } from './gravity.ts';
import { computeGridSizing, UniformGrid } from '../grid/UniformGrid.ts';

/** Deterministic PRNG so the test isn't flaky. */
function makeRng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

describe('computeGridGravity vs computeBruteForceGravity', () => {
  it('approximates the exact O(N^2) reference within tolerance', () => {
    // This monopole scheme has no Barnes-Hut-style opening-angle check, so
    // its accuracy comes entirely from cells being small relative to the
    // domain -- it improves as N (and therefore grid resolution) grows,
    // measured directly: avg relative error was ~41% at N=200, ~24% at
    // N=5000, ~12% at N=20,000 (see git history for the scan). N=5000 is a
    // representative CPU-scale size where brute force is still cheap
    // enough to serve as an exact reference in a test.
    const count = 5000;
    const domainRadius = 3;
    const rand = makeRng(42);

    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count * 3; i++) {
      positions[i] = (rand() * 2 - 1) * domainRadius * 0.8;
    }
    const masses = new Float32Array(count).fill(1);
    const params = { G: 0.001, softening: 0.08 };

    const bruteAcc = new Float32Array(count * 3);
    computeBruteForceGravity(positions, masses, count, params, bruteAcc);

    const grid = new UniformGrid(count, computeGridSizing(count));
    grid.build(positions, masses, count, domainRadius);
    const gridAcc = new Float32Array(count * 3);
    computeGridGravity(positions, masses, count, grid, params, gridAcc);

    let sumRelErr = 0;
    let maxRelErr = 0;
    for (let i = 0; i < count; i++) {
      const bx = bruteAcc[i * 3];
      const by = bruteAcc[i * 3 + 1];
      const bz = bruteAcc[i * 3 + 2];
      const gx = gridAcc[i * 3];
      const gy = gridAcc[i * 3 + 1];
      const gz = gridAcc[i * 3 + 2];
      const bMag = Math.hypot(bx, by, bz);
      const errMag = Math.hypot(gx - bx, gy - by, gz - bz);
      const relErr = errMag / (bMag || 1);
      sumRelErr += relErr;
      maxRelErr = Math.max(maxRelErr, relErr);
    }
    const avgRelErr = sumRelErr / count;

    // Average error is the meaningful regression signal (observed ~0.235 at
    // this N; threshold has margin). Max error is left generous -- a lone
    // particle right at a coarse-cell boundary can have a much rougher
    // approximation than average (the adjacent cell's mass doesn't look
    // like a point source from right next to it), which is expected/known
    // roughness, not something a single random seed's worst case should
    // gate the build on. This assertion is really just to catch gross
    // failures (NaN, a systematically flipped sign, a missing contribution).
    expect(avgRelErr).toBeLessThan(0.32);
    expect(maxRelErr).toBeLessThan(5);
  });

  it('does not secularly heat a cold-collapsing cloud over a long run', () => {
    // Regression test for a real bug: an earlier version computed each
    // particle's far-field pull using its *exact* position against a
    // distant coarse cell's center of mass. That's asymmetric (two
    // particles in the same cell don't pull equally hard on a distant
    // cell, so the reaction they get back doesn't balance either), and the
    // imbalance compounded every step into unbounded energy injection -- a
    // cloud that should collapse and virialize instead expanded forever
    // (RMS radius ~1.5 -> ~2.1 over 60 simulated seconds at N=5000).
    //
    // First fix attempt used the particle's own coarse cell's center of
    // mass instead, which does exactly conserve momentum between any two
    // cells -- but it also collapses every particle sharing a cell onto an
    // identical far-field vector, which turned into a *different* visible
    // bug: the cloud fragmenting into one clump per coarse cell (worst at
    // the grid's 8 corner cells) instead of one continuous collapse.
    //
    // Final fix keeps exact-position far-field (smooth per-particle
    // variation, no fragmentation) and instead cancels the resulting net
    // momentum bias with a cheap global correction after the main loop
    // (see computeGridGravity). This test drives the same step loop
    // CpuBackend uses for twice as long and checks energy plateaus rather
    // than climbs.
    const count = 1000;
    const domainRadius = 3;
    const G = 0.001;
    const softening = 0.08;
    const dt = 0.02;
    const halfStepCount = 250; // 250 * 0.02s = 5 simulated seconds per half

    const rand = makeRng(7);
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count * 3; i++) {
      positions[i] = (rand() * 2 - 1) * domainRadius * 0.6 * Math.cbrt(rand());
    }
    const velocities = new Float32Array(count * 3);
    const masses = new Float32Array(count).fill(1);
    const acc = new Float32Array(count * 3);
    const grid = new UniformGrid(count, computeGridSizing(count));

    function totalEnergy(): number {
      let ke = 0;
      for (let i = 0; i < count; i++) {
        const vx = velocities[i * 3];
        const vy = velocities[i * 3 + 1];
        const vz = velocities[i * 3 + 2];
        ke += 0.5 * masses[i] * (vx * vx + vy * vy + vz * vz);
      }
      let pe = 0;
      const eps2 = softening * softening;
      for (let i = 0; i < count; i++) {
        for (let j = i + 1; j < count; j++) {
          const dx = positions[i * 3] - positions[j * 3];
          const dy = positions[i * 3 + 1] - positions[j * 3 + 1];
          const dz = positions[i * 3 + 2] - positions[j * 3 + 2];
          pe -= (G * masses[i] * masses[j]) / Math.sqrt(dx * dx + dy * dy + dz * dz + eps2);
        }
      }
      return ke + pe;
    }

    function stepOnce(): void {
      grid.build(positions, masses, count, domainRadius);
      computeGridGravity(positions, masses, count, grid, { G, softening }, acc);
      for (let i = 0; i < positions.length; i++) {
        velocities[i] += acc[i] * dt;
        let p = positions[i] + velocities[i] * dt;
        if (p > domainRadius) {
          p = domainRadius - (p - domainRadius);
          velocities[i] = -velocities[i];
        } else if (p < -domainRadius) {
          p = -domainRadius - (p + domainRadius);
          velocities[i] = -velocities[i];
        }
        positions[i] = p;
      }
    }

    for (let s = 0; s < halfStepCount; s++) stepOnce();
    const energyAtHalf = totalEnergy();
    for (let s = 0; s < halfStepCount; s++) stepOnce();
    const energyAtFull = totalEnergy();

    const relDrift = Math.abs(energyAtFull - energyAtHalf) / Math.abs(energyAtHalf);
    expect(relDrift).toBeLessThan(0.5);
  });
});
