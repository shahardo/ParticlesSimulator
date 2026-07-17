import { Pane } from 'tweakpane';
import {
  DOMAIN_RADIUS_MAX,
  DOMAIN_RADIUS_MIN,
  PARTICLE_COUNT_MIN,
  type SimParams,
  type WallBehavior,
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

export interface PanelHandle {
  pane: Pane;
  /** Grays out "Use GPU" when no real WebGPU adapter is available, instead
   * of silently reverting after the fact (M5/M6's placeholder behavior). */
  setGpuAvailable(available: boolean): void;
  /** Reflects the *actual* active backend in the checkbox, for the
   * boot-time auto-switch (M7) and any other programmatic backend change --
   * doesn't fire the `useGpu`-change callback itself. */
  setGpuChecked(checked: boolean): void;
  /** Rebuilds the N slider with a new max -- Tweakpane has no API to change
   * a binding's range in place, so this disposes and re-adds both Point
   * Cloud bindings (N and Box Radius together, to preserve their order). */
  setMaxParticleCount(max: number): void;
}

export function createPanel(
  app: App,
  params: SimParams,
  monitors: PanelMonitors,
  initialMaxParticleCount: number,
  onParticleCountChange: (count: number) => void,
  onLiveParamsChange: (partial: Partial<SimParams>) => void,
  onRestart: () => void,
  /** Returns the *actual* resulting state -- main.ts falls back to CPU
   * silently if GPU was requested but unavailable, and the checkbox needs
   * to reflect that rather than keep showing "checked" for a backend
   * that isn't really active. */
  onBackendChange: (useGpu: boolean) => boolean,
): PanelHandle {
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

  // Starts unchecked regardless of the persisted preference -- main.ts
  // renders on CPU first for instant feedback (see its boot() sequence),
  // then calls setGpuChecked() itself if it auto-switches to GPU a moment
  // later once the adaptive benchmark resolves.
  const backendState = { useGpu: false };
  const gpuBinding = sim.addBinding(backendState, 'useGpu', { label: 'Use GPU' });
  gpuBinding.on('change', (ev) => {
    const actual = onBackendChange(ev.value);
    if (actual !== ev.value) {
      backendState.useGpu = actual;
      gpuBinding.refresh();
    }
  });

  sim
    .addBinding(params, 'wallBehavior', {
      label: 'Wall Behavior',
      options: { Bounce: 'bounce', Vanish: 'vanish', Wraparound: 'wraparound' },
    })
    .on('change', (ev: { value: WallBehavior }) => onLiveParamsChange({ wallBehavior: ev.value }));

  const gravity = pane.addFolder({ title: 'Gravity' });
  gravity
    .addBinding(params, 'gravityG', { label: 'G', min: 0, max: 0.01, step: 0.0001 })
    .on('change', (ev) => onLiveParamsChange({ gravityG: ev.value }));
  gravity
    .addBinding(params, 'softening', { label: 'Softening', min: 0.01, max: 1, step: 0.01 })
    .on('change', (ev) => onLiveParamsChange({ softening: ev.value }));

  const cloud = pane.addFolder({ title: 'Point Cloud' });
  // Typed `any`: Tweakpane's BindingApi generics aren't worth threading
  // through just to hold a disposable reference for rebuilding these two
  // bindings when the N slider's max changes (see buildCloudBindings below).
  let particleCountBinding: any;
  let domainRadiusBinding: any;

  function buildCloudBindings(maxParticleCount: number): void {
    particleCountBinding?.dispose();
    domainRadiusBinding?.dispose();

    particleCountBinding = cloud
      .addBinding(params, 'particleCount', {
        label: 'N',
        min: PARTICLE_COUNT_MIN,
        max: maxParticleCount,
        step: 100,
      })
      .on('change', (ev: { value: number; last: boolean }) => {
        // Only regenerate the buffer once the drag settles, not on every
        // intermediate tick.
        if (ev.last) onParticleCountChange(ev.value);
      });
    domainRadiusBinding = cloud
      .addBinding(params, 'domainRadius', {
        label: 'Box Radius',
        min: DOMAIN_RADIUS_MIN,
        max: DOMAIN_RADIUS_MAX,
        step: 0.5,
      })
      .on('change', (ev: { value: number }) => onLiveParamsChange({ domainRadius: ev.value }));
  }

  buildCloudBindings(initialMaxParticleCount);

  return {
    pane,
    setGpuAvailable: (available) => {
      gpuBinding.disabled = !available;
    },
    setGpuChecked: (checked) => {
      backendState.useGpu = checked;
      gpuBinding.refresh();
    },
    setMaxParticleCount: buildCloudBindings,
  };
}
