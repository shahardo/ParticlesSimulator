/**
 * WGSL storage buffers can't pack `vec3` tightly -- "WGSL does not support
 * packed vec3 data in storage buffers" (see the padding logic in three's
 * WebGPUAttributeUtils) -- so every `instancedArray(count, 'vec3')` buffer
 * (positions, velocities, accelerations, `fineCellCom`/`coarseCellCom`,
 * `netMomentumBias`) ends up on the GPU with `itemSize=4` (xyz + one unused
 * padding float per element) the moment it's first used in a dispatch, not
 * a tightly-packed stride-3 layout. Reading a raw `Float32Array` back from
 * one of these without accounting for that produces a progressively-
 * shifting garble across particles -- discovered via a cross-backend
 * gravity parity check that looked like a real physics bug until traced to
 * this (see `src/debug/verifyGpuGravity.ts`'s history).
 *
 * There is deliberately no matching "pad before writing" helper here: three
 * re-derives the padded layout itself the next time the buffer is used in a
 * dispatch (`WebGPUAttributeUtils.updateAttribute`), by re-chopping
 * `.array` at the *original*, tightly-packed item size -- regardless of
 * what `.array` currently holds. Writing already-padded data feeds that
 * re-chop a buffer it wrongly assumes is still tightly packed, corrupting
 * it a second time. Always write tightly-packed (stride-3) data into
 * `.array` and let that framework path do the one real padding pass -- see
 * `GpuBackend.writeVec3Buffer`'s doc comment for the full trace of this.
 */

/** Raw padded (stride-4) buffer -> tightly-packed (stride-3) array. */
export function unpadVec3(padded: Float32Array, count: number): Float32Array {
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    out[i * 3] = padded[i * 4];
    out[i * 3 + 1] = padded[i * 4 + 1];
    out[i * 3 + 2] = padded[i * 4 + 2];
  }
  return out;
}
