# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A 3D N-body particle simulator (Vite + TypeScript + Three.js `WebGPURenderer`/TSL + Tweakpane), built as a learning project in explicit milestones (M0-M13: gravity → collisions → thermodynamics → dark matter → GPU compute → polish). **Read `docs/devplan.md` first** — it's the living source of truth for scope, current progress, and every non-obvious bug/deviation found while building each milestone. Don't duplicate its content here; this file is about how to work in the repo day to day.

## Commands

```bash
npm run dev                          # dev server (Vite, default port 5173)
./node_modules/.bin/tsc.cmd -b --force     # type-check (see TypeScript version gotcha below)
./node_modules/.bin/vitest.cmd run         # run all tests once
./node_modules/.bin/vitest.cmd run gravity.test.ts   # run a single test file
npm run build                        # tsc -b && vite build (production bundle)
```

**Use the local binaries (`./node_modules/.bin/...`), not `npx tsc`/`npx vitest`** — `npx tsc --version` alone has been observed to hang in this environment (separate from the TypeScript 7 issue below). No lint is configured.

To run/screenshot/drive the app in a browser (including headless verification), use the `run-particles-simulator` skill/`.claude/skills/run-particles-simulator/SKILL.md` — it documents the Playwright-based driver (`chromium-cli` isn't available on this host), `window.__debug` for numeric state inspection, and a long list of hard-won Tweakpane/TSL testing gotchas.

## Critical gotcha: TypeScript is pinned to `^6.0.3`

**Do not upgrade `typescript` past the 6.x line.** TypeScript 7's new native Go-based compiler (`typescript-go`) hangs for 5-10 minutes and then crashes with an out-of-memory fatal error when type-checking TSL's heavily-chained/proxied node API (`three/tsl`). Confirmed via the crash's own stack trace — deep recursive type-relation checking, not a mistake in application code. If `tsc -b` ever seems to hang after a dependency bump, this is the first thing to suspect. Relatedly, TSL's node types aren't fully expressible even where `@types/three` tries (e.g. composing `.toAttribute()`'s return type with `ReturnType<>` is what triggers the hang) — GPU-side buffer/kernel handles are deliberately typed `any` in `GpuBackend`/`GpuParticlePoints` rather than fought into precise types.

## Architecture

**`SimulationBackend` is the core abstraction** (`src/sim/SimulationBackend.ts`): `init(count, params)`, `step(dt)`, `setParams(partial)`, `getSnapshot()`, `dispose()`, plus a `kind: 'cpu' | 'gpu'` discriminant. Two implementations:

- **`CpuBackend`** (`src/sim/cpu/`) — plain TypeScript/Float32Array physics. `getSnapshot()` returns a direct array reference (cheap, mutated in place each step).
- **`GpuBackend`** (`src/sim/gpu/`) — TSL compute kernels over `instancedArray` storage buffers. **`getSnapshot()` is a stub here, not implemented** — reading GPU buffers back to the CPU synchronously every frame would defeat the point of GPU compute. The GPU render path instead reads the position buffer directly via `getPositionsNode()` (see `GpuParticlePoints`). An async `debugReadPositions()` exists purely for manual/test verification via `window.__debug`, never called from the render loop.

**`App`** (`src/app/App.ts`) owns the play/pause/timeScale clock around whichever backend is active, and is the single place that holds the "current backend" reference — `main.ts` doesn't keep its own. Switching backends (the "Use GPU" toggle) fully reconstructs the backend, the render object (`CpuParticlePoints` or `GpuParticlePoints`), and calls `app.setBackend(...)`; see `rebuild()` in `main.ts`. GPU mode requires a real WebGPU adapter — no WebGL2 compute fallback exists at all (`isRealWebGPUBackend()` in `src/utils/backend.ts` detects this), so requesting GPU without one silently falls back to CPU with a console warning.

**Shared spatial structure**: both the near-field (direct particle-particle) and far-field (monopole approximation) gravity terms in `CpuBackend` read from one `UniformGrid` (`src/sim/cpu/grid/UniformGrid.ts`) rebuilt every step — a fine grid (~4 particles/cell) for near-field, and a coarser grid (derived from blocks of fine cells) for far-field, sized from N rather than fixed, to keep an O(N²) brute-force reference (`computeBruteForceGravity`, kept in `gravity.ts` for correctness comparisons) tractable at larger N (`computeGridGravity`). The exact cell-sizing constants and two real momentum-conservation/fragmentation bugs found while tuning this are documented at length in `docs/devplan.md` and in comments at the top of `gravity.ts` / `UniformGrid.ts` — read those before changing grid constants, since the "obvious" fix for one failure mode has already been tried and found to cause a different one.

**Rendering** mirrors the backend split: `CpuParticlePoints` (`THREE.Points` + a `BufferAttribute` synced from the CPU array each frame via `markDirty()`) vs. `GpuParticlePoints` (`SpriteNodeMaterial` reading the GPU buffer directly, zero per-frame CPU copy). `src/render/scene.ts` owns the camera/OrbitControls/domain-box grid helper, sized to `domainRadius` and resizable live without moving the camera.

**Milestone-based development**: each milestone in `docs/devplan.md` is built, then verified both visually (screenshot via the run-particles-simulator driver) and numerically (`window.__debug`) before moving on — several real bugs here were only caught by one of the two methods, not both. This dev environment specifically has no real WebGPU adapter (falls back to WebGL2), so anything GPU-compute-specific can be type-checked and pattern-matched against official Three.js examples here, but needs verification on real GPU hardware.
