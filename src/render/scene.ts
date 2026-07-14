import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export interface SceneRig {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  resize: () => void;
  /** Resizes the visual grid/boundary helper to match a new domain radius.
   * Does not move the camera -- a live slider tweak shouldn't yank the
   * user's current view around. */
  setDomainRadius: (radius: number) => void;
}

export function createSceneRig(container: HTMLElement, initialDomainRadius: number): SceneRig {
  const renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.01,
    1000,
  );
  // Same viewing angle regardless of domain size -- just pulled back
  // proportionally so the whole domain is comfortably framed at boot.
  camera.position.set(4, 3, 6).normalize().multiplyScalar(initialDomainRadius * 2.6);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  let grid = new THREE.GridHelper(1, 1, 0x2a2a2a, 0x1a1a1a);
  const setDomainRadius = (radius: number) => {
    scene.remove(grid);
    grid.dispose();
    grid = new THREE.GridHelper(radius * 2, 10, 0x2a2a2a, 0x1a1a1a);
    scene.add(grid);
  };
  setDomainRadius(initialDomainRadius);

  const axes = new THREE.AxesHelper(1.5);
  scene.add(axes);
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(5, 8, 3);
  scene.add(dirLight);

  const resize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', resize);

  return { renderer, scene, camera, controls, resize, setDomainRadius };
}
