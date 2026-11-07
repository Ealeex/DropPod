import * as THREE from 'three';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const blankTexture = '/blank.png';

function textureNames(text) {
  const document = new DOMParser().parseFromString(text, 'application/xml');
  if (document.querySelector('parsererror')) return [];
  const names = new Set();
  for (const image of document.getElementsByTagName('image')) {
    for (const source of image.getElementsByTagName('init_from')) {
      const value = source.textContent.trim();
      if (!value || value.startsWith('data:')) continue;
      let name = value;
      try {
        name = decodeURIComponent(new URL(value, location.href).pathname.split('/').pop() || value);
      } catch {
        name = value.split(/[\\/]/).pop() || value;
      }
      if (name) names.add(name.toLowerCase());
    }
  }
  return [...names];
}

export function createModelPreview({ text, name, files = [] }) {
  const container = document.createElement('div');
  container.className = 'model-viewer';
  container.setAttribute('role', 'img');
  container.setAttribute('aria-label', `${name} 3D preview. Drag to rotate and scroll to zoom.`);

  const canvasHost = document.createElement('div');
  canvasHost.className = 'model-canvas';
  container.append(canvasHost);

  const textureUrls = new Map();
  for (const file of files) {
    if (file.preview !== 'image') continue;
    textureUrls.set(file.name.toLowerCase(), `/api/drive/files/${encodeURIComponent(file.id)}/preview`);
  }

  const missing = textureNames(text).filter((reference) => !textureUrls.has(reference));
  if (missing.length) {
    const warning = document.createElement('p');
    warning.className = 'model-warning';
    warning.textContent = `Texture not found in this folder: ${missing.join(', ')}. Add it to see the model's albedo texture.`;
    container.append(warning);
  }

  const hint = document.createElement('p');
  hint.className = 'model-hint';
  hint.textContent = 'Drag to rotate · Scroll to zoom';
  container.append(hint);

  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith('data:') || url.startsWith('blob:')) return blankTexture;
    let fileName = url;
    try {
      fileName = decodeURIComponent(new URL(url, location.href).pathname.split('/').pop() || url);
    } catch {
      fileName = url.split(/[\\/]/).pop() || url;
    }
    return textureUrls.get(fileName.toLowerCase()) || blankTexture;
  });

  const loader = new ColladaLoader(manager);
  const subject = new THREE.Group();
  subject.add(loader.parse(text, '').scene);
  const box = new THREE.Box3().setFromObject(subject);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) {
    throw new Error('The model has no visible geometry.');
  }

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  canvasHost.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.add(subject);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 1000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.rotateSpeed = 0.9;
  controls.zoomSpeed = 0.8;
  controls.autoRotate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  controls.autoRotateSpeed = 0.9;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x3c4050, 2.1));
  const key = new THREE.DirectionalLight(0xffffff, 2.8);
  key.position.set(4, 6, 5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x9db8ff, 1.1);
  fill.position.set(-5, 2, -2);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffd8aa, 1.4);
  rim.position.set(-2, 4, -6);
  scene.add(rim);

  let disposed = false;

  function resize() {
    const width = Math.max(canvasHost.clientWidth, 1);
    const height = Math.max(canvasHost.clientHeight, 1);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  const observer = new ResizeObserver(resize);
  observer.observe(canvasHost);

  subject.position.sub(sphere.center);
  const radius = sphere.radius;
  const distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov) / 2) * 1.15;
  const direction = new THREE.Vector3(0.8, 0.55, 1).normalize();
  const home = direction.multiplyScalar(distance);

  camera.position.copy(home);
  camera.near = Math.max(radius / 100, 0.0001);
  camera.far = Math.max(distance * 10, radius * 100);
  camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0);
  controls.minDistance = radius * 1.15;
  controls.maxDistance = radius * 12;
  controls.update();

  renderer.setAnimationLoop(() => {
    if (disposed) return;
    controls.update();
    renderer.render(scene, camera);
  });
  resize();

  return {
    element: container,
    dispose() {
      if (disposed) return;
      disposed = true;
      renderer.setAnimationLoop(null);
      observer.disconnect();
      controls.dispose();
      scene.traverse((object) => {
        object.geometry?.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          if (!material) continue;
          material.map?.dispose();
          material.dispose();
        }
      });
      renderer.dispose();
    },
  };
}
