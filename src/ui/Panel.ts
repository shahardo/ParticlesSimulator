import { Pane } from 'tweakpane';
import {
  DOMAIN_RADIUS_MAX,
  DOMAIN_RADIUS_MIN,
  PARTICLE_COUNT_MAX,
  PARTICLE_COUNT_MIN,
  type SimParams,
} from '../app/Config.ts';
import type { App } from '../app/App.ts';

export interface PanelMonitors {
  fps: number;
  /** % of each frame the JS thread was busy (sim step + draw-call submission). */
  cpuLoad: number;
  /** 100 - cpuLoad: a proxy for GPU-bound time, not a true hardware reading
   * (browsers don't expose real GPU utilization to JS). */
  gpuLoad: number;
}

export function createPanel(
  app: App,
  params: SimParams,
  monitors: PanelMonitors,
  onParticleCountChange: (count: number) => void,
  onLiveParamsChange: (partial: Partial<SimParams>) => void,
  onRestart: () => void,
  /** Returns the *actual* resulting state -- main.ts falls back to CPU
   * silently if GPU was requested but unavailable, and the checkbox needs
   * to reflect that rather than keep showing "checked" for a backend
   * that isn't really active. */
  onBackendChange: (useGpu: boolean) => boolean,
): Pane {
  const pane = new Pane({ title: 'Particles Simulator' });

  const perf = pane.addFolder({ title: 'Performance' });
  perf.addBinding(monitors, 'fps', {
    readonly: true,
    view: 'graph',
    min: 0,
    max: 120,
    interval: 200,
  });
  perf.addBinding(monitors, 'cpuLoad', {
    label: 'CPU %',
    readonly: true,
    view: 'graph',
    min: 0,
    max: 100,
    interval: 200,
  });
  perf.addBinding(monitors, 'gpuLoad', {
    label: 'GPU % (est.)',
    readonly: true,
    view: 'graph',
    min: 0,
    max: 100,
    interval: 200,
  });

  const sim = pane.addFolder({ title: 'Simulation' });
  sim.addBinding(app, 'playing', { label: 'Playing' });
  sim.addBinding(app, 'timeScale', { label: 'Speed', min: 0, max: 3, step: 0.1 });
  sim.addButton({ title: 'Restart' }).on('click', onRestart);

  // M5 skeleton: a plain manual toggle, not yet disabled when no real WebGPU
  // adapter is available (silently falls back to CPU instead -- see
  // main.ts). Full "adaptive default N + gray out when unavailable" UX is M7.
  const backendState = { useGpu: false };
  const gpuBinding = sim.addBinding(backendState, 'useGpu', { label: 'Use GPU' });
  gpuBinding.on('change', (ev) => {
    const actual = onBackendChange(ev.value);
    if (actual !== ev.value) {
      backendState.useGpu = actual;
      gpuBinding.refresh();
    }
  });

  const gravity = pane.addFolder({ title: 'Gravity' });
  gravity
    .addBinding(params, 'gravityG', { label: 'G', min: 0, max: 0.01, step: 0.0001 })
    .on('change', (ev) => onLiveParamsChange({ gravityG: ev.value }));
  gravity
    .addBinding(params, 'softening', { label: 'Softening', min: 0.01, max: 1, step: 0.01 })
    .on('change', (ev) => onLiveParamsChange({ softening: ev.value }));

  const cloud = pane.addFolder({ title: 'Point Cloud' });
  cloud
    .addBinding(params, 'particleCount', {
      label: 'N',
      min: PARTICLE_COUNT_MIN,
      max: PARTICLE_COUNT_MAX,
      step: 100,
    })
    .on('change', (ev) => {
      // Only regenerate the buffer once the drag settles, not on every
      // intermediate tick.
      if (ev.last) onParticleCountChange(ev.value);
    });
  cloud
    .addBinding(params, 'domainRadius', {
      label: 'Box Radius',
      min: DOMAIN_RADIUS_MIN,
      max: DOMAIN_RADIUS_MAX,
      step: 0.5,
    })
    .on('change', (ev) => onLiveParamsChange({ domainRadius: ev.value }));

  return pane;
}
