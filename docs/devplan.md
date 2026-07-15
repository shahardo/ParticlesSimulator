# 3D N-Body Particle Simulator — Dev Plan

> Source of truth for scope and sequencing. Updated as milestones complete or reality diverges from the original plan — see **Status** and the "as-built" notes inline.

## Status

| Milestone | State | Notes |
|---|---|---|
| M0 — Vite+TS scaffold, WebGPURenderer + OrbitControls | ✅ Done | WebGPU vs WebGL2-fallback detection confirmed working |
| M1 — Static point cloud + N slider | ✅ Done | Validated render perf up to N=1,000,000 |
| M2 — SimulationBackend skeleton, play/pause/timestep | ✅ Done | Added a CPU/GPU frame-time load indicator (not in the original plan, added on request) |
| M3 — CPU brute-force gravity (small N) | ✅ Done | |
| M4 — CPU gravity via uniform grid | ✅ Done | Two real bugs found and fixed after initial "done" — see **As-built deviations** below |
| M5 — GPU backend skeleton | ✅ Done | Hit a real TypeScript 7 compiler bug along the way — see below. Manual "Use GPU" toggle added (not full M7 adaptive polish) |
| M6 — Port grid-gravity to TSL | ⬜ Not started | |
| M7 — Adaptive-N benchmark + GPU/CPU toggle | ⬜ Not started | |
| M8 — Elastic collisions | ⬜ Not started | |
| M9 — Inelastic collisions + merge-on-contact | ⬜ Not started | |
| M10 — Thermodynamics | ⬜ Not started | |
| M11 — Dark matter species | ⬜ Not started | |
| M12 — Derived stats overlay | ⬜ Not started | |
| M13 — Polish | ⬜ Not started | |

Also added along the way, outside the original milestone list: a **Restart** button (regenerates the cloud at the current N without touching other params) and a live-adjustable **domain box radius** slider (was a fixed constant).

## Context

The user wants to build a 3D physics simulator of up to N=1,000,000 particles, as a **learning project** (new to both TypeScript and GPU/compute programming), delivered in 5 incremental stages of increasing physical realism:

1. Gravity-only N-body attraction
2. + elastic collisions
3. + inelastic collisions (adjustable restitution)
4. + per-particle heating and radiative cooling
5. + a second collisionless species (dark matter) alongside baryonic matter

The simulator must also display live derived statistics (average enclosing sphere radius, average rotation axis + angular speed), look visually polished with easy 3D camera navigation, and let the user toggle GPU use on/off.

Because clarity and incremental buildability were explicitly prioritized over raw performance, every design choice below favors the simpler, more learnable option when it's still fast enough to hit the target scale.

## Tech stack (decided with user)

- **TypeScript + Vite + Three.js `0.185.1` (r185)**, using **`WebGPURenderer`** and **TSL** (Three.js Shading Language — a JS-like node API that compiles to real WGSL compute shaders) for **both** physics compute and rendering. Keeping compute and render in one WebGPU device means particle buffers are shared directly with zero CPU round-trip for display.
- **Controls library: Tweakpane** (supports folders + read-only "monitor"/graph bindings, a good fit for the live stats readouts).
- Camera navigation: Three.js `OrbitControls`.
- Post-processing: `THREE.RenderPipeline` (r183+ name for the old `PostProcessing` class) + TSL `bloom()`.
- All of the following were confirmed directly against live Three.js source/examples (not guessed): `Fn()`, `instancedArray()`, `instanceIndex`, `struct()`, `atomicAdd`/`atomicStore`/`atomicLoad` (explicitly WebGPU-only, no WebGL2 compute fallback exists), `renderer.compute()`/`computeAsync()`, `renderer.getArrayBufferAsync()` for CPU readback, and the `SpriteNodeMaterial` + `instancedArray(...).toAttribute()` pattern for zero-CPU-touch instanced particle rendering.
- **GPU/CPU is a hard binary split, not a 3-tier fallback**: WebGPU compute shaders/atomics have no WebGL2 equivalent, so the CPU backend is a separately hand-written TypeScript implementation of the same algorithm, not "the same shader running slower." Detect `navigator.gpu` at startup and force/gray-out to CPU-only if absent.

## Architecture

A `SimulationBackend` interface (`init(N)`, `step(dt)`, `setParams(...)`, `getSnapshot()`, `dispose()`) is implemented twice — `GpuBackend` (TSL compute kernels) and `CpuBackend` (plain TS, optionally Web-Worker-parallelized later). The renderer and UI only ever talk to this interface, so switching GPU↔CPU at runtime doesn't ripple through the rest of the app.

**Shared spatial structure — two uniform grids, rebuilt every frame, reused across every stage:**
- **Fine grid**: sized so each cell holds ~4 particles on average (`cellsPerAxis ≈ cbrt(N/4)`). Used for near-field direct gravity (own cell + 26 neighbors) and *all* collision neighbor queries.
- **Coarse grid**: originally planned as a small fixed resolution independent of N (default 16³ = 4,096 cells). **As built (M4), this changed** — see below.
- Both grids are built via the same 5-pass counting-sort recipe: clear → count per cell → prefix sum → scatter into sorted-index buffer → per-cell mass/center-of-mass aggregate. The coarse grid's aggregates are derived from blocks of fine-cell aggregates rather than binning a second time.
- Simulation domain is a **fixed bounding box with soft bounce walls** on all 6 faces — avoids needing to dynamically resize/rebuild the grid domain. (As built: the box radius is a live-adjustable Tweakpane slider, not a fixed constant — resizing it just changes the wall-bounce boundary and the visual grid helper, no reinit needed.)

### As-built deviations (discovered during M4)

The original plan's fixed-16³-coarse-grid idea doesn't work at CPU-scale N: at N=50,000 that's 50,000 × 4,096 ≈ 200M monopole evaluations/frame, far too slow single-threaded. The as-built `computeGridSizing()` instead derives the coarse resolution from N (`coarseCellsPerAxis ≈ cbrt(N/4)/blockSize`), keeping far-field cost roughly proportional to N rather than fixed — see `src/sim/cpu/grid/UniformGrid.ts`.

Two real bugs surfaced while building this, both worth remembering before the M6 GPU port re-implements the same algorithm:

1. **`blockSize=4` (fine cells per coarse cell) left a coverage gap.** The near-field neighborhood only reaches 1 fine cell in every direction (a 3×3×3 window), which doesn't fully cover a 4-wide coarse block — mass in the gap was invisible to both near-field (too far) and far-field (excluded as the particle's "own" cell). Measured as ~40% average force error vs. an exact brute-force reference. Fixed by using `blockSize=2`, which mathematically guarantees the near-field window always fully covers the particle's own coarse block.
2. **Far-field momentum conservation vs. spatial resolution is a real tension, and the first fix traded one bug for another.** Using each particle's *exact* position against a distant cell's monopole isn't momentum-conserving (particles sharing a cell don't pull equally hard on a distant cell, so the reaction back doesn't balance — compounds every step into unbounded energy injection; invisible over a few seconds, obvious as steady RMS-radius growth over 60+ simulated seconds). The seemingly-obvious fix — use the particle's *own coarse cell's center of mass* instead, which *is* exactly momentum-conserving between any two cells — traded that bug for a different one: every particle sharing a cell now gets an identical far-field vector, so the cloud visibly fragments into one clump per coarse cell (worst at the grid's corner cells). The actual fix keeps exact-position far-field (smooth per-particle variation, no fragmentation) and separately cancels the net momentum bias with a cheap global correction after the main loop (sum of `m·a`, then subtract per unit mass). See the long comment in `src/sim/cpu/physics/gravity.ts` for the full reasoning, and `gravity.test.ts` for the regression test.

Both bugs are the kind that look fine in a quick check and only show up over a longer run or in a corner case — worth a real screenshot a few seconds into playback *and* a numeric energy trace when touching this code again, not just one or the other.

### As-built deviations (discovered during M5)

- **`typescript@7.x` is unusable with this codebase.** The new native Go-based compiler (`typescript-go`) hangs for 5-10 minutes and then crashes with an out-of-memory fatal error when type-checking TSL's heavily-chained/proxied node API (confirmed via the crash's own stack trace — deep recursive type-relation checking hundreds of frames deep inside the Go checker). This didn't show up until M5 because the CPU backend never touches TSL types at all. **`typescript` is pinned to `^6.0.3`** (the last pre-native-rewrite major line) in `package.json` — do not bump past 6.x while this project uses TSL, unless a future TS7 release is confirmed to fix this. Also: prefer `./node_modules/.bin/tsc.cmd` over `npx tsc` in this repo — `npx tsc --version` alone was independently observed to hang too (separate overhead on top of the above).
- **`SimulationBackend.getSnapshot()` doesn't fit GPU-resident data.** Reading GPU buffers back into a CPU `Float32Array` synchronously every frame would defeat the entire point of GPU compute. `GpuBackend.getSnapshot()` returns an empty stub; the real GPU render path (`GpuParticlePoints`) reads the TSL position buffer directly via `getPositionsNode()` instead, bypassing `getSnapshot()` entirely. Added a `kind: 'cpu' | 'gpu'` discriminant to `SimulationBackend` so render/debug code can branch cleanly. `GpuBackend.debugReadPositions()` (async, via `renderer.getArrayBufferAsync()`) exists purely for manual/test verification, never called from the render loop.
- **TSL's node types aren't fully expressible even where `@types/three` tries** (e.g. `.toAttribute()` exists but composing return types with `ReturnType<>` is what triggered the TS7 hang above). GPU-side buffer/kernel handles are typed `any` in `GpuBackend`/`GpuParticlePoints` rather than fought into precise types — deliberate, not an oversight.
- **A "Use GPU" toggle was added to the panel now**, ahead of M7, since some way to exercise the GPU path through the actual UI (not just scripted tests) seemed worth the small cost. It's a plain manual checkbox with a console-warning safety net if no real WebGPU adapter is available (falls back to CPU and self-corrects the checkbox) — no adaptive default-N benchmarking or graying-out yet; that's still M7's job.
- **Could not visually verify the GPU compute/render path at all.** This dev environment's headless Chromium has no real WebGPU adapter (`No available adapters`, falls back to WebGL2 — see M0's note), and WebGL2 has zero support for compute shaders/storage buffers. Everything GPU-specific here (`GpuBackend`, `GpuParticlePoints`) is verified only by: type-checking cleanly, matching patterns fetched directly from the official `webgpu_compute_particles.html` example at the exact installed Three.js version (r185), and confirming the CPU path + graceful-fallback path both work correctly. **The actual GPU rendering/compute needs to be checked on real GPU hardware** — treat it as unverified until someone does.

## Per-stage physics design

- **Stage 1 (gravity)**: softened Newtonian gravity, `F = G·m1·m2·r̂/(|r|²+ε²)^1.5` (Plummer softening), ε exposed as a UI multiplier. *(Done — semi-implicit/symplectic Euler integration, not yet stated explicitly in the original plan but confirmed to conserve energy well over long runs.)*
- **Stage 2/3 (collisions)**: impulse-based sphere-sphere response along the collision normal, generalized with a restitution coefficient `e` (elastic = 1, tunable down for stage 3). **Race-safety detail**: two particles' threads both discover the same pair independently; each thread reads *both* particles' previous-frame state (safe, read-only) but writes only its own new velocity into a separate write buffer, ping-ponging buffers each frame — this is what makes Newton's-third-law-consistent collision response possible without any float atomics. "Merge on contact" avoids GPU stream compaction (a hard parallel algorithm) by using a per-particle `alive` flag instead; dead particles are skipped by physics and scaled to zero size in rendering, with a "reset" button since dead slots aren't reclaimed mid-session.
- **Stage 4 (thermodynamics)**: energy lost per inelastic collision becomes internal energy/temperature on the colliding pair. Radiative cooling uses the **exact closed-form solution** of `dT/dt = −kT⁴`, i.e. `T(t) = T₀ / (1 + 3kT₀³t)^(1/3)`, which is unconditionally stable for any timestep/temperature (unlike explicit-Euler on `T⁴`, which can blow up). Visualized with a small hand-authored 4–5 stop blackbody-ish color ramp (dark red → orange → yellow-white → blue-white).
- **Stage 5 (dark matter)**: one shared particle buffer, partitioned into two contiguous index ranges (baryonic, dark matter) rather than per-particle branching everywhere. Gravity runs over all particles unconditionally (both species have mass). Collision/thermal kernels wrap their body in a species check and skip any dark-matter neighbor, so dark matter is gravity-only with no second physics pipeline. Rendering uses two draw calls (two `Sprite`s) reading the same buffer via an index offset, so each species can be independently colored/toggled.
- **Derived stats (enclosing radius, rotation axis/speed)**: rather than a full GPU parallel-reduction pass (a genuinely harder GPU topic), do a **periodic (~4–6 Hz) CPU-side readback** via `renderer.getArrayBufferAsync()` and compute in plain JS: mass-weighted RMS radius from center of mass; total angular momentum `L = Σm(r−r_com)×v`; inertia tensor `I`; solve `ω = I⁻¹L` (trivial 3×3 inverse). Displayed as a numeric readout plus a wireframe sphere + `ArrowHelper` gizmo in the scene. A full GPU reduction is a documented future optimization if readback cadence ever becomes a bottleneck — not built upfront.

## Project file structure (as built so far)

```
ParticlesSimulator/
  package.json, tsconfig.json, vite.config.ts, index.html
  docs/devplan.md                    this file
  .claude/skills/run-particles-simulator/   agent-facing run/screenshot/test driver (SKILL.md + driver.mjs)
  src/
    main.ts                          entry point; owns renderer/animation loop, wires backend+panel+scene
    app/
      App.ts                         play/pause/timeScale clock around the active backend
      Config.ts                      SimParams type + defaults + min/max constants
    sim/
      SimulationBackend.ts           shared interface
      cpu/
        CpuBackend.ts
        grid/UniformGrid.ts          counting-sort grid (fine + coarse), computeGridSizing()
        physics/gravity.ts           computeBruteForceGravity (M3 reference) + computeGridGravity (M4)
        physics/gravity.test.ts      Vitest: grid-vs-brute-force accuracy + long-run energy-drift regression
      gpu/
        GpuBackend.ts                instancedArray buffers + init/update TSL kernels, drift+bounce only (no gravity until M6)
    render/
      scene.ts                       camera/scene/lights/OrbitControls/domain grid helper
      cpu/CpuParticlePoints.ts       THREE.Points + plain BufferAttribute
      gpu/GpuParticlePoints.ts       SpriteNodeMaterial reading the GPU position buffer directly, no CPU copy
    ui/
      Panel.ts                       Tweakpane bindings → Config/App callbacks
    utils/
      math.ts                       uniform-ball sampling, Box-Muller
      backend.ts                     isRealWebGPUBackend() (works around an @types/three gap)
```

Not yet built (per the milestone list below): `stats/`, `bench/`, GPU gravity kernels, `ui/StatsReadout.ts`, `render/gizmos.ts`, `render/postfx.ts`, `render/colorRamp.ts`.

## UI / controls (Tweakpane) — as built so far

Performance (FPS graph, CPU%/GPU% frame-time estimate), Simulation (Playing, Speed, Restart, **Use GPU** — manual toggle, no adaptive benchmarking/graying-out yet), Gravity (G, Softening — both live, CPU-only until M6), Point Cloud (N, Box Radius — both live). Still to come per the plan: restitution `e` + merge-on-contact toggle, radiation-rate constant, species mix ratio + per-species visibility, stats-overlay toggle, bloom strength/threshold.

## Milestones

Sequenced so a visible result appears as early as possible, and so each algorithm is learned in plain TypeScript before being ported to TSL/GPU:

1. **M0** ✅ — Vite+TS scaffold, `WebGPURenderer` + `OrbitControls`, confirm both WebGPU and no-WebGPU startup paths work.
2. **M1** ✅ — Static random point cloud via `THREE.Points`, N slider just regenerates. Validates render perf/camera feel at real target N before any physics.
3. **M2** ✅ — `SimulationBackend` skeleton; `CpuBackend` with zero forces; play/pause/timestep wired end-to-end.
4. **M3** ✅ — CPU brute-force gravity at small N (500–2000): correctness reference.
5. **M4** ✅ — CPU gravity via the fine+coarse uniform grid at CPU-interactive N. As built, "CPU-interactive" tops out lower than "tens of thousands" implied — capped at N=20,000 (~8fps worst case measured); still a 3.7×-24× speedup over brute force across the range tested, just not perfectly linear (a full adaptive octree would do better, out of scope here).
6. **M5** ✅ — GPU backend skeleton: `instancedArray` buffers + trivial drift/bounce kernel, validating the compute→render pipeline before real physics. Not verified at N=100k-500k or on real GPU hardware at all — see As-built deviations above; needs checking on a machine with a real WebGPU adapter.
7. **M6** — Port grid-gravity to TSL at N=100k–250k on GPU.
8. **M7** — Adaptive-N startup benchmark + runtime GPU⇄CPU toggle with N re-clamping.
9. **M8** — Elastic collisions: CPU first (checked against M4), then GPU (with the ping-pong velocity buffer).
10. **M9** — Inelastic collisions + merge-on-contact, both backends.
11. **M10** — Thermodynamics: heating, analytic cooling, blackbody color ramp.
12. **M11** — Dark matter species: partitioned buffer, species-gated kernels, two draw calls.
13. **M12** — Derived stats overlay: periodic readback, radius/rotation math, gizmos, Tweakpane monitors.
14. **M13** — Polish: bloom via `RenderPipeline`, final UI pass, README.

Implementation proceeds milestone-by-milestone rather than all at once, with a working, viewable app after each step, and a pause for user go-ahead between milestones.

## Risks / open questions

- **Binary GPU gate**: no WebGL2 compute fallback exists at all — must detect `navigator.gpu` and force CPU-only gracefully rather than assuming WebGPURenderer alone guarantees a working compute path.
- **Single-thread prefix-sum pass** in the grid build could bottleneck at very large N; a parallel (Hillis-Steele/Blelloch) prefix sum is the documented future optimization, not built upfront.
- **Coarse grid resolution scales with N** (as-built, see deviations above), which means far-field cost isn't perfectly O(N) — grows a bit worse than linear. Acceptable for the CPU reference; the GPU port (M6) may want to revisit if N=100k+ far-field cost becomes the bottleneck.
- **Merge-on-contact** doesn't reclaim buffer slots within a session — needs a "reset" affordance (the Restart button covers this today by regenerating the whole cloud, but a lighter per-particle revive isn't built).
- Exact current TSL API names/signatures should be spot-checked against the installed `three` package at the start of each milestone that uses new API surface, since this library moves quickly between releases.
- **TypeScript is pinned to `^6.0.3`** — 7.x's native compiler crashes on this project's TSL usage (see M5 as-built deviations). Don't bump the major version without re-verifying `tsc -b` actually completes on real TSL code, not just a trivial file.
- **The GPU path is unverified on real hardware** (M5 as-built deviations) — this dev environment has no real WebGPU adapter available at all. Treat `GpuBackend`/`GpuParticlePoints` as "type-checks and pattern-matches the official example" rather than "confirmed working" until checked on a machine with a real GPU.

## Verification

- Each milestone runs via `npm run dev` and is checked visually in the browser for the specific new behavior it adds, **and** numerically via the `window.__debug` hook (exposes `{ app, params, monitors }` for `eval`-based inspection, reach the active backend via `app.getBackend()` — see `.claude/skills/run-particles-simulator/SKILL.md`). M4 specifically showed that visual-only or numeric-only checks each missed a real bug the other caught — use both.
- **Vitest** covers the pure-math, backend-agnostic pieces that don't need a GPU context: `src/sim/cpu/physics/gravity.test.ts` checks grid gravity against the brute-force reference and guards against long-run energy drift. More to add as physics stages land: collision restitution/momentum, the inertia-tensor/angular-velocity solve.
