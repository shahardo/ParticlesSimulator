import { Pane } from 'tweakpane';
import { PARTICLE_COUNT_MAX, PARTICLE_COUNT_MIN, type SimParams } from '../app/Config.ts';
import type { App } from '../app/App.ts';

export interface PanelMonitors {
  fps: number;
}

export function createPanel(
  app: App,
  params: SimParams,
  monitors: PanelMonitors,
  onParticleCountChange: (count: number) => void,
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

  const sim = pane.addFolder({ title: 'Simulation' });
  sim.addBinding(app, 'playing', { label: 'Playing' });
  sim.addBinding(app, 'timeScale', { label: 'Speed', min: 0, max: 3, step: 0.1 });

  const cloud = pane.addFolder({ title: 'Point Cloud' });
  cloud
    .addBinding(params, 'particleCount', {
      label: 'N',
      min: PARTICLE_COUNT_MIN,
      max: PARTICLE_COUNT_MAX,
      step: 1_000,
    })
    .on('change', (ev) => {
      // Only regenerate the (up to 1M-point) buffer once the drag settles,
      // not on every intermediate tick.
      if (ev.last) onParticleCountChange(ev.value);
    });

  return pane;
}
