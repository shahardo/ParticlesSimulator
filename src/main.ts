import { createSceneRig } from './render/scene.ts';
import { CpuParticlePoints } from './render/cpu/CpuParticlePoints.ts';
import { GpuParticlePoints } from './render/gpu/GpuParticlePoints.ts';
import { createPanel, type PanelMonitors } from './ui/Panel.ts';
import { defaultParams } from './app/Config.ts';
import { isRealWebGPUBackend } from './utils/backend.ts';
import { App } from './app/App.ts';
import { CpuBackend } from './sim/cpu/CpuBackend.ts';
import { GpuBackend } from './sim/gpu/GpuBackend.ts';

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
createPanel(
  app,
  params,
  monitors,
  (count) => {
    params.particleCount = count;
    rebuild();
  },
  (partial) => {
    Object.assign(params, partial);
    // Forwards to whichever backend is currently active (App keeps that
    // reference, not main.ts). GpuBackend.setParams() only understands
    // domainRadius so far -- no gravity exists on the GPU path until M6 --
    // and harmlessly ignores the rest.
    app.setParams(partial);
    if (partial.domainRadius !== undefined) setDomainRadius(partial.domainRadius);
  },
  rebuild,
  (nextUseGpu) => {
    useGpu = nextUseGpu;
    rebuild();
    // rebuild() may have silently reverted useGpu to false (no real WebGPU
    // adapter) -- report the actual result so the checkbox can correct itself.
    return useGpu;
  },
);

if (import.meta.env.DEV) {
  // Numeric inspection hook for the run-particles-simulator driver (see
  // .claude/skills/run-particles-simulator/SKILL.md) -- lets `eval` read
  // live simulation state without scraping the rendered scene.
  (window as unknown as { __debug: unknown }).__debug = { app, params, monitors };
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

  let lastTime = performance.now();
  let frameCount = 0;
  let fpsAccMs = 0;
  // "CPU load" = share of each frame the JS thread was actually busy (sim
  // step + draw-call submission). Browsers don't expose real GPU hardware
  // utilization to JS, so "GPU load" here is just the rest of the frame --
  // a proxy that's meaningful because requestAnimationFrame pacing reflects
  // vsync/GPU-completion waits, not a true per-API utilization reading.
  let cpuBusyAccMs = 0;

  renderer.setAnimationLoop((time) => {
    const dtMs = time - lastTime;
    lastTime = time;
    frameCount++;
    fpsAccMs += dtMs;

    const stepStart = performance.now();
    app.tick(dtMs / 1000);
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
