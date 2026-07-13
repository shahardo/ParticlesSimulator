import { createSceneRig } from './render/scene.ts';

const appEl = document.querySelector<HTMLDivElement>('#app')!;
const statusEl = document.querySelector<HTMLDivElement>('#boot-status')!;

const { renderer, scene, camera, controls } = createSceneRig(appEl);

async function boot() {
  // WebGPURenderer.init() picks a real WebGPU adapter when available, and
  // otherwise transparently falls back to WebGL2 for *rendering*. Compute
  // shaders/atomics (needed by the GPU physics backend from M5 onward) only
  // exist on the real WebGPU path, so we surface which one we landed on.
  await renderer.init();

  const hasWebGPU = 'gpu' in navigator && navigator.gpu !== undefined;
  const backend = renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2 (fallback)';
  statusEl.textContent = `renderer: ${backend} · navigator.gpu: ${hasWebGPU ? 'available' : 'unavailable'}`;

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
}

boot().catch((err) => {
  console.error(err);
  statusEl.textContent = `boot failed: ${String(err)}`;
  statusEl.style.color = '#ff8080';
});
