/** Standard normal sample via Box-Muller. */
export function randnBoxMuller(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Fill `positions` (a length count*3 buffer) with points uniformly distributed inside a ball of the given radius. */
export function fillUniformBall(positions: Float32Array, count: number, radius: number): void {
  for (let i = 0; i < count; i++) {
    const dx = randnBoxMuller();
    const dy = randnBoxMuller();
    const dz = randnBoxMuller();
    const dirLength = Math.hypot(dx, dy, dz) || 1;
    // cbrt(uniform) gives uniform density by volume, not just by radius.
    const r = radius * Math.cbrt(Math.random());
    const scale = r / dirLength;
    positions[i * 3 + 0] = dx * scale;
    positions[i * 3 + 1] = dy * scale;
    positions[i * 3 + 2] = dz * scale;
  }
}
