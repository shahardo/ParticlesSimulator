import { createSceneRig } from './render/scene.ts';
import { CpuParticlePoints } from './render/cpu/CpuParticlePoints.ts';
import { createPanel, type PanelMonitors } from './ui/Panel.ts';
import { defaultParams } from './app/Config.ts';
import { isRealWebGPUBackend } from './utils/backend.ts';
import { App } from './app/App.ts';
import { CpuBackend } from './sim/cpu/CpuBackend.ts';

const appEl = document.querySelector<HTMLDivElement>('#app')!;
const statusEl = document.querySelector<HTMLDivElement>('#boot-status')!;

const { renderer, scene, camera, controls } = createSceneRig(appEl);

const params = { ...defaultParams };

const backend = new CpuBackend();
backend.init(params.particleCount, params);
const app = new App(backend);

const cloud = new CpuParticlePoints();
cloud.setPositions(app.getSnapshot().positions);
scene.add(cloud.object);

const monitors: PanelMonitors = { fps: 0 };
createPanel(app, params, monitors, (count) => {
  params.particleCount = count;
  backend.init(count, params);
  cloud.setPositions(app.getSnapshot().positions);
});

if (import.meta.env.DEV) {
  // Numeric inspection hook for the run-particles-simulator driver (see
  // .claude/skills/run-particles-simulator/SKILL.md) -- lets `eval` read
  // live simulation state without scraping the rendered scene.
  (window as unknown as { __debug: unknown }).__debug = { app, backend, params };
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

  renderer.setAnimationLoop((time) => {
    const dtMs = time - lastTime;
    lastTime = time;
    frameCount++;
    fpsAccMs += dtMs;
    if (fpsAccMs >= 500) {
      monitors.fps = Math.round((frameCount * 1000) / fpsAccMs);
      frameCount = 0;
      fpsAccMs = 0;
    }

    app.tick(dtMs / 1000);
    cloud.markDirty();

    controls.update();
    renderer.render(scene, camera);
  });
}

boot().catch((err) => {
  console.error(err);
  statusEl.textContent = `boot failed: ${String(err)}`;
  statusEl.style.color = '#ff8080';
});
