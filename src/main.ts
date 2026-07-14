import { createSceneRig } from './render/scene.ts';
import { CpuParticlePoints } from './render/cpu/CpuParticlePoints.ts';
import { createPanel, type PanelMonitors } from './ui/Panel.ts';
import { defaultParams } from './app/Config.ts';
import { isRealWebGPUBackend } from './utils/backend.ts';
import { App } from './app/App.ts';
import { CpuBackend } from './sim/cpu/CpuBackend.ts';

const appEl = document.querySelector<HTMLDivElement>('#app')!;
const statusEl = document.querySelector<HTMLDivElement>('#boot-status')!;

const params = { ...defaultParams };

const { renderer, scene, camera, controls, setDomainRadius } = createSceneRig(
  appEl,
  params.domainRadius,
);

const backend = new CpuBackend();
backend.init(params.particleCount, params);
const app = new App(backend);

const cloud = new CpuParticlePoints();
cloud.setPositions(app.getSnapshot().positions);
scene.add(cloud.object);

function reinit(): void {
  backend.init(params.particleCount, params);
  cloud.setPositions(app.getSnapshot().positions);
}

const monitors: PanelMonitors = { fps: 0, cpuLoad: 0, gpuLoad: 0 };
createPanel(
  app,
  params,
  monitors,
  (count) => {
    params.particleCount = count;
    reinit();
  },
  (partial) => {
    Object.assign(params, partial);
    backend.setParams(partial);
    if (partial.domainRadius !== undefined) setDomainRadius(partial.domainRadius);
  },
  reinit,
);

if (import.meta.env.DEV) {
  // Numeric inspection hook for the run-particles-simulator driver (see
  // .claude/skills/run-particles-simulator/SKILL.md) -- lets `eval` read
  // live simulation state without scraping the rendered scene.
  (window as unknown as { __debug: unknown }).__debug = { app, backend, params, monitors };
}

async function boot() {
  // WebGPURenderer.init() picks a real WebGPU adapter when available, and
  // otherwise transparently falls back to WebGL2 for *rendering*. Compute
  // shaders/atomics (needed by the GPU physics backend from M5 onward) only
  // exist on the real WebGPU path, so we surface which one we landed on.
  await renderer.init();

  const hasWebGPU = 'gpu' in navigator && navigator.gpu !== undefined;
  const backendName = isRealWebGPUBackend(renderer) ? 'WebGPU' : 'WebGL2 (fallback)';
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
    cloud.markDirty();
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
