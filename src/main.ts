import { createSceneRig } from './render/scene.ts';
import { CpuParticlePoints } from './render/cpu/CpuParticlePoints.ts';
import { createPanel, type PanelMonitors } from './ui/Panel.ts';
import { defaultParams } from './app/Config.ts';
import { isRealWebGPUBackend } from './utils/backend.ts';

const appEl = document.querySelector<HTMLDivElement>('#app')!;
const statusEl = document.querySelector<HTMLDivElement>('#boot-status')!;

const { renderer, scene, camera, controls } = createSceneRig(appEl);

const params = { ...defaultParams };
const cloud = new CpuParticlePoints(params.particleCount, params.domainRadius);
scene.add(cloud.object);

const monitors: PanelMonitors = { fps: 0 };
createPanel(params, monitors, (count) => {
  params.particleCount = count;
  cloud.setCount(count, params.domainRadius);
});

async function boot() {
  // WebGPURenderer.init() picks a real WebGPU adapter when available, and
  // otherwise transparently falls back to WebGL2 for *rendering*. Compute
  // shaders/atomics (needed by the GPU physics backend from M5 onward) only
  // exist on the real WebGPU path, so we surface which one we landed on.
  await renderer.init();

  const hasWebGPU = 'gpu' in navigator && navigator.gpu !== undefined;
  const backend = isRealWebGPUBackend(renderer) ? 'WebGPU' : 'WebGL2 (fallback)';
  statusEl.textContent = `renderer: ${backend} · navigator.gpu: ${hasWebGPU ? 'available' : 'unavailable'}`;

  let lastTime = performance.now();
  let frameCount = 0;
  let fpsAccMs = 0;

  renderer.setAnimationLoop((time) => {
    const dt = time - lastTime;
    lastTime = time;
    frameCount++;
    fpsAccMs += dt;
    if (fpsAccMs >= 500) {
      monitors.fps = Math.round((frameCount * 1000) / fpsAccMs);
      frameCount = 0;
      fpsAccMs = 0;
    }

    controls.update();
    renderer.render(scene, camera);
  });
}

boot().catch((err) => {
  console.error(err);
  statusEl.textContent = `boot failed: ${String(err)}`;
  statusEl.style.color = '#ff8080';
});
