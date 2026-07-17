import { createSceneRig } from './render/scene.ts';
import { CpuParticlePoints } from './render/cpu/CpuParticlePoints.ts';
import { GpuParticlePoints } from './render/gpu/GpuParticlePoints.ts';
import { createPanel, type PanelMonitors, type PanelHandle } from './ui/Panel.ts';
import { defaultParams, CPU_PARTICLE_COUNT_MAX, GPU_PARTICLE_COUNT_MAX } from './app/Config.ts';
import { isRealWebGPUBackend } from './utils/backend.ts';
import { App } from './app/App.ts';
import { CpuBackend } from './sim/cpu/CpuBackend.ts';
import { GpuBackend } from './sim/gpu/GpuBackend.ts';
import { benchmarkGpuParticleCount } from './app/gpuBenchmark.ts';
import { loadUseGpuPreference, saveUseGpuPreference } from './utils/preferences.ts';
import {
  verifyGpuGravity,
  verifyGpuGrid,
  verifyGpuGravityStages,
  verifyGpuGravityTerms,
  dumpGravityComparison,
} from './debug/verifyGpuGravity.ts';

const appEl = document.querySelector<HTMLDivElement>('#app')!;
const statusEl = document.querySelector<HTMLDivElement>('#boot-status')!;

const params = { ...defaultParams };

const { renderer, scene, camera, controls, setDomainRadius } = createSceneRig(
  appEl,
  params.domainRadius,
);

// Only known for certain after renderer.init() resolves (in boot(), below).
// Until then, requesting GPU mode is safely ignored by rebuild()'s check.
let gpuAvailable = false;
let useGpu = false;

const cpuBackendSingleton = new CpuBackend();
const app = new App(cpuBackendSingleton);

let currentCloud: CpuParticlePoints | GpuParticlePoints | undefined;

function rebuild(): void {
  if (useGpu && !gpuAvailable) {
    console.warn('GPU backend requested but no real WebGPU adapter is available; staying on CPU.');
    useGpu = false;
  }

  if (currentCloud) {
    scene.remove(currentCloud.object);
    currentCloud.dispose();
  }

  if (useGpu) {
    const gpuBackend = new GpuBackend(renderer);
    gpuBackend.init(params.particleCount, params);
    app.setBackend(gpuBackend);
    currentCloud = new GpuParticlePoints(gpuBackend.getPositionsNode(), params.particleCount);
  } else {
    cpuBackendSingleton.init(params.particleCount, params);
    app.setBackend(cpuBackendSingleton);
    const cpuPoints = new CpuParticlePoints();
    cpuPoints.setPositions(app.getSnapshot().positions);
    currentCloud = cpuPoints;
  }

  scene.add(currentCloud.object);
}

rebuild();

const monitors: PanelMonitors = { fps: 0, cpuLoad: 0, gpuLoad: 0 };
const panel: PanelHandle = createPanel(
  app,
  params,
  monitors,
  CPU_PARTICLE_COUNT_MAX,
  (count) => {
    params.particleCount = count;
    rebuild();
  },
  (partial) => {
    Object.assign(params, partial);
    // Forwards to whichever backend is currently active (App keeps that
    // reference, not main.ts).
    app.setParams(partial);
    if (partial.domainRadius !== undefined) setDomainRadius(partial.domainRadius);
  },
  rebuild,
  (nextUseGpu) => {
    switchBackend(nextUseGpu);
    // Persists this *explicit* user click -- see switchBackend()'s own
    // auto-detect call in boot(), which deliberately doesn't persist.
    saveUseGpuPreference(useGpu);
    return useGpu;
  },
);

/** M7: re-clamps N to the target backend's max (CPU and GPU have very
 * different practical ranges -- see Config.ts) and refreshes the panel's N
 * slider to match, then rebuilds. Shared by the panel's manual toggle and
 * boot()'s startup auto-switch, so both go through the same re-clamping
 * rather than duplicating it. */
function switchBackend(requestGpu: boolean): void {
  useGpu = requestGpu && gpuAvailable;
  const max = useGpu ? GPU_PARTICLE_COUNT_MAX : CPU_PARTICLE_COUNT_MAX;
  if (params.particleCount > max) params.particleCount = max;
  panel.setMaxParticleCount(max);
  rebuild();
}

if (import.meta.env.DEV) {
  // Numeric inspection hook for the run-particles-simulator driver (see
  // .claude/skills/run-particles-simulator/SKILL.md) -- lets `eval` read
  // live simulation state without scraping the rendered scene.
  (window as unknown as { __debug: unknown }).__debug = {
    app,
    params,
    monitors,
    // Bypasses the panel entirely (and switchBackend()'s re-clamping) --
    // lets a debug script set an exact N/backend combination in one call
    // for numeric testing, without multi-step UI interaction. Returns what
    // actually happened (rebuild() silently falls back to CPU if GPU was
    // requested but no real adapter is available, same as the panel's own
    // toggle).
    debugRebuild: (count: number, gpu: boolean) => {
      useGpu = gpu;
      params.particleCount = count;
      rebuild();
      return { kind: app.getBackend().kind, count: params.particleCount };
    },
    // Cross-backend gravity parity check -- see verifyGpuGravity's doc
    // comment for why this is a harder/different test than the RMS-radius
    // trace used so far. Returns a rejected promise (not a thrown
    // exception) if there's no real WebGPU adapter, since GpuBackend can't
    // run at all in that case.
    verifyGpuGravity: (count?: number) => {
      if (!gpuAvailable) return Promise.reject(new Error('no real WebGPU adapter available'));
      return verifyGpuGravity(renderer, params, count);
    },
    // Bisects a verifyGpuGravity failure: diffs the GPU-built grid's
    // buffers against a CPU-built grid for the same positions, isolating
    // "grid build is wrong" from "grid is fine, gravityKernel misuses it".
    verifyGpuGrid: (count?: number) => {
      if (!gpuAvailable) return Promise.reject(new Error('no real WebGPU adapter available'));
      return verifyGpuGrid(renderer, params, count);
    },
    // Bisects the other way: is it gravityKernel (near+far-field sum) or
    // the momentum-correction kernels that diverge from the CPU reference?
    verifyGpuGravityStages: (count?: number) => {
      if (!gpuAvailable) return Promise.reject(new Error('no real WebGPU adapter available'));
      return verifyGpuGravityStages(renderer, params, count);
    },
    // Bisects the near-field sum from the far-field sum independently.
    verifyGpuGravityTerms: (count?: number) => {
      if (!gpuAvailable) return Promise.reject(new Error('no real WebGPU adapter available'));
      return verifyGpuGravityTerms(renderer, params, count);
    },
    dumpGravityComparison: (count?: number) => {
      if (!gpuAvailable) return Promise.reject(new Error('no real WebGPU adapter available'));
      return dumpGravityComparison(renderer, params, count);
    },
  };
}

async function boot() {
  // WebGPURenderer.init() picks a real WebGPU adapter when available, and
  // otherwise transparently falls back to WebGL2 for *rendering*. Compute
  // shaders/atomics (needed by the GPU physics backend from M5 onward) only
  // exist on the real WebGPU path, so we surface which one we landed on.
  await renderer.init();
  gpuAvailable = isRealWebGPUBackend(renderer);

  const hasWebGPU = 'gpu' in navigator && navigator.gpu !== undefined;
  const backendName = gpuAvailable ? 'WebGPU' : 'WebGL2 (fallback)';
  statusEl.textContent = `renderer: ${backendName} · navigator.gpu: ${hasWebGPU ? 'available' : 'unavailable'}`;

  // M7: gray out the toggle instead of leaving it clickable-but-silently-
  // reverting (M5/M6's placeholder).
  panel.setGpuAvailable(gpuAvailable);

  // M7: no stored preference yet (first-ever run) defaults to "use GPU if
  // this hardware supports it" -- matches the project's overall
  // N=1,000,000 goal. A stored preference (an explicit past user choice)
  // always wins over auto-detection, even "stay on CPU" on a GPU-capable
  // machine -- see saveUseGpuPreference()'s call site for why this doesn't
  // get re-saved here (an automatic switch isn't a user decision).
  const storedPreference = loadUseGpuPreference();
  const wantsGpuByDefault = storedPreference ?? true;

  if (wantsGpuByDefault && gpuAvailable) {
    // Renders on CPU first (the rebuild() call above) so there's something
    // on screen immediately; this benchmark takes a real (if brief) moment,
    // then switches once it resolves.
    params.particleCount = await benchmarkGpuParticleCount(renderer, params);
    switchBackend(true);
    panel.setGpuChecked(true);
  }

  let lastTime = performance.now();
  let frameCount = 0;
  let fpsAccMs = 0;
  // "CPU load" = share of each frame the JS thread was actually busy (sim
  // step + draw-call submission). Browsers don't expose real GPU hardware
  // utilization to JS, so "GPU load" here is just the rest of the frame --
  // a proxy that's meaningful because requestAnimationFrame pacing reflects
  // vsync/GPU-completion waits, not a true per-API utilization reading.
  let cpuBusyAccMs = 0;

  // Caps the physics step's dt independently of the real frame-time used
  // for the FPS/load monitors below -- the very first animation frame
  // routinely has a large real dt (page-load/adapter-negotiation delay
  // before the first callback, measured ~100ms+ here), and a single
  // oversized step is enough to destabilize a tightly-packed cloud (see
  // Config.ts's INITIAL_CLOUD_RADIUS_FRACTION/softening comments) --
  // semi-implicit Euler with strong, short-range softened gravity isn't
  // unconditionally stable for an arbitrarily large dt. 1000/20 keeps a
  // dropped/slow frame from ever injecting more than a 20fps-equivalent
  // step, without touching the *displayed* FPS (which still reflects the
  // real, unclamped frame time).
  const MAX_STEP_DT_MS = 50;

  renderer.setAnimationLoop((time) => {
    const dtMs = time - lastTime;
    lastTime = time;
    frameCount++;
    fpsAccMs += dtMs;

    const stepStart = performance.now();
    app.tick(Math.min(dtMs, MAX_STEP_DT_MS) / 1000);
    if (currentCloud instanceof CpuParticlePoints) currentCloud.markDirty();
    const stepEnd = performance.now();

    controls.update();
    renderer.render(scene, camera);
    const renderEnd = performance.now();

    cpuBusyAccMs += (stepEnd - stepStart) + (renderEnd - stepEnd);

    if (fpsAccMs >= 500) {
      monitors.fps = Math.round((frameCount * 1000) / fpsAccMs);
      const cpuPct = Math.min(100, (cpuBusyAccMs / fpsAccMs) * 100);
      monitors.cpuLoad = Math.round(cpuPct);
      monitors.gpuLoad = Math.round(100 - cpuPct);
      frameCount = 0;
      fpsAccMs = 0;
      cpuBusyAccMs = 0;
    }
  });
}

boot().catch((err) => {
  console.error(err);
  statusEl.textContent = `boot failed: ${String(err)}`;
  statusEl.style.color = '#ff8080';
});
