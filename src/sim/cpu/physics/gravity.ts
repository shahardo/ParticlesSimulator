export interface GravityParams {
  G: number;
  /** Plummer softening length -- keeps force finite as two particles approach r=0. */
  softening: number;
}

/**
 * O(N^2) pairwise softened Newtonian gravity, i < j (Newton's third law halves the work).
 * Writes accelerations (not forces) into `outAccelerations`, overwriting it.
 *
 * a_i += G * m_j * (r_j - r_i) / (|r_j - r_i|^2 + eps^2)^1.5
 */
export function computeBruteForceGravity(
  positions: Float32Array,
  masses: Float32Array,
  count: number,
  { G, softening }: GravityParams,
  outAccelerations: Float32Array,
): void {
  const eps2 = softening * softening;
  outAccelerations.fill(0);

  for (let i = 0; i < count; i++) {
    const ix = i * 3;
    const xi = positions[ix];
    const yi = positions[ix + 1];
    const zi = positions[ix + 2];
    let ax = 0;
    let ay = 0;
    let az = 0;

    for (let j = i + 1; j < count; j++) {
      const jx = j * 3;
      const dx = positions[jx] - xi;
      const dy = positions[jx + 1] - yi;
      const dz = positions[jx + 2] - zi;
      const distSq = dx * dx + dy * dy + dz * dz + eps2;
      const invDist3 = 1 / (distSq * Math.sqrt(distSq));

      const gj = G * masses[j] * invDist3;
      ax += gj * dx;
      ay += gj * dy;
      az += gj * dz;

      const gi = G * masses[i] * invDist3;
      outAccelerations[jx] -= gi * dx;
      outAccelerations[jx + 1] -= gi * dy;
      outAccelerations[jx + 2] -= gi * dz;
    }

    outAccelerations[ix] += ax;
    outAccelerations[ix + 1] += ay;
    outAccelerations[ix + 2] += az;
  }
}
