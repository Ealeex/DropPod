import * as THREE from 'three';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createFlyControls } from './fly-controls.mjs';

const blankTexture = '/blank.png';

function referenceName(value) {
  try {
    const url = new URL(value.replaceAll('\\', '/'), location.href);
    return decodeURIComponent(url.pathname.split('/').pop()).toLowerCase();
  } catch {
    return value.split(/[\\/]/).pop().toLowerCase();
  }
}

function textureNames(text) {
  const document = new DOMParser().parseFromString(text, 'application/xml');
  if (document.querySelector('parsererror')) return [];
  const names = new Set();
  for (const image of document.getElementsByTagName('image')) {
    for (const source of image.getElementsByTagName('init_from')) {
      const value = source.textContent.trim();
      if (!value || value.startsWith('data:')) continue;
      const name = referenceName(value);
      if (name) names.add(name);
    }
  }
  return [...names];
}

export async function loadObjMaterials(text, files) {
  const siblings = new Map(files.filter((file) => /\.mtl$/i.test(file.name)).map((file) => [file.name.toLowerCase(), file]));
  const libraries = new Set();
  for (const match of text.matchAll(/^\s*mtllib[ \t]+([^\r\n]+)$/gm)) {
    const reference = match[1].trim();
    const references = siblings.has(referenceName(reference)) ? [reference] : reference.split(/\s+/);
    for (const name of references) {
      const file = siblings.get(referenceName(name));
      if (file) libraries.add(file.id);
    }
  }
  const materials = await Promise.all([...libraries].map(async (id) => {
    const response = await fetch(`/api/drive/files/${encodeURIComponent(id)}/preview`);
    return response.ok ? response.text() : '';
  }));
  return materials.join('\n');
}

function disposeModel(root) {
  const resources = new Set();
  const bitmaps = new Set();
  root.traverse((object) => {
    if (object.geometry) resources.add(object.geometry);
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material) continue;
      resources.add(material);
      for (const value of Object.values(material)) {
        if (!value?.isTexture) continue;
        resources.add(value);
        const image = value.source?.data;
        if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) bitmaps.add(image);
      }
    }
  });
  for (const resource of resources) resource.dispose();
  for (const bitmap of bitmaps) bitmap.close();
}

export async function createBlendPreview(buffer, name) {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith(`blob:${location.origin}/`)) return url;
    throw new Error('The Blender preview references an external resource.');
  });
  const { scene } = await new GLTFLoader(manager).parseAsync(buffer, '');
  try {
    return createModelPreview({ name, model: scene });
  } catch (error) {
    disposeModel(scene);
    throw error;
  }
}

export function createModelPreview({ text, buffer, name, files = [], materials = '', model }) {
  const container = document.createElement('div');
  container.className = 'model-viewer';
  container.setAttribute('role', 'group');
  container.setAttribute('aria-label', `${name} 3D preview`);

  const canvasHost = document.createElement('div');
  canvasHost.className = 'model-canvas';
  container.append(canvasHost);

  const textureUrls = new Map();
  for (const file of files) {
    if (file.preview !== 'image') continue;
    textureUrls.set(file.name.toLowerCase(), `/api/drive/files/${encodeURIComponent(file.id)}/preview`);
  }

  const isObj = /\.obj$/i.test(name);
  const isFbx = /\.fbx$/i.test(name);
  const missing = new Set(model || isObj || isFbx ? [] : textureNames(text).filter((reference) => !textureUrls.has(reference)));
  const embeddedUrls = new Set();
  function releaseEmbeddedTextures() {
    for (const url of embeddedUrls) URL.revokeObjectURL(url);
    embeddedUrls.clear();
  }

  const hint = document.createElement('p');
  hint.className = 'model-hint';
  hint.textContent = 'Drag to rotate · Scroll to zoom';
  container.append(hint);

  const manager = new THREE.LoadingManager();
  manager.onLoad = releaseEmbeddedTextures;
  manager.setURLModifier((url) => {
    if (isFbx && url.startsWith(`blob:${location.origin}/`)) {
      embeddedUrls.add(url);
      return url;
    }
    if (isFbx && /^data:image\/(?:bmp|jpeg|png|webp);base64,/i.test(url)) return url;
    if (url.startsWith('data:') || url.startsWith('blob:')) return blankTexture;
    const fileName = referenceName(url);
    const texture = textureUrls.get(fileName);
    if (!texture && (isObj || isFbx) && fileName) missing.add(fileName);
    return texture || blankTexture;
  });

  const subject = new THREE.Group();
  if (model) {
    subject.add(model);
  } else if (isFbx) {
    try {
      subject.add(new FBXLoader(manager).parse(buffer, ''));
    } catch (error) {
      releaseEmbeddedTextures();
      throw error;
    }
  } else if (isObj) {
    const loader = new OBJLoader(manager);
    if (materials) {
      const creator = new MTLLoader(manager).parse(materials, '');
      loader.setMaterials({
        create(material) {
          if (Object.hasOwn(creator.materialsInfo, material) && !Object.hasOwn(Object.prototype, material)) {
            return creator.create(material);
          }
          return undefined;
        },
      });
    }
    subject.add(loader.parse(text));
  } else {
    subject.add(new ColladaLoader(manager).parse(text, '').scene);
  }
  if (missing.size) {
    const warning = document.createElement('p');
    warning.className = 'model-warning';
    warning.textContent = `Texture not found in this folder: ${[...missing].join(', ')}. Add it to see the model's albedo texture.`;
    container.insertBefore(warning, hint);
  }
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
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', '3D viewport');
  canvasHost.append(canvas);

  const scene = new THREE.Scene();
  scene.add(subject);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 1000);
  const controls = new OrbitControls(camera, canvas);
  const fly = createFlyControls(camera, canvas);
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

  const toolbar = document.createElement('div');
  toolbar.className = 'model-controls';
  toolbar.setAttribute('role', 'group');
  toolbar.setAttribute('aria-label', 'Camera controls');
  toolbar.innerHTML = `
    <button class="text-button" type="button" aria-pressed="true">Orbit</button>
    <button class="text-button" type="button" aria-pressed="false">Fly</button>
    <label hidden>Speed <input type="range" min="0.1" max="4" step="0.1" value="1"></label>`;
  const [orbitButton, flyButton] = toolbar.querySelectorAll('button');
  const speed = toolbar.querySelector('input');
  const speedLabel = toolbar.querySelector('label');
  container.append(toolbar);
  const orbitPosition = new THREE.Vector3();
  const orbitNear = camera.near;
  let flying = false;
  function setFlyMode(enabled) {
    if (flying === enabled) return;
    flying = enabled;
    if (enabled) orbitPosition.copy(camera.position);
    else camera.position.copy(orbitPosition);
    camera.near = enabled ? Math.max(radius / 10000, 0.00001) : orbitNear;
    camera.updateProjectionMatrix();
    controls.enabled = !enabled;
    fly.setEnabled(enabled);
    orbitButton.setAttribute('aria-pressed', String(!enabled));
    flyButton.setAttribute('aria-pressed', String(enabled));
    speedLabel.hidden = !enabled;
    hint.textContent = enabled
      ? 'WASD to move · R/F up and down · Click or drag to look'
      : 'Drag to rotate · Scroll to zoom';
  }
  orbitButton.addEventListener('click', () => setFlyMode(false));
  flyButton.addEventListener('click', () => setFlyMode(true));

  let lastFrame = 0;
  renderer.setAnimationLoop((time) => {
    if (disposed) return;
    const delta = lastFrame ? Math.min((time - lastFrame) / 1000, 0.05) : 0;
    lastFrame = time;
    if (flying) fly.update(delta * radius * 0.6 * speed.valueAsNumber);
    else controls.update();
    renderer.render(scene, camera);
  });
  resize();

  return {
    element: container,
    dispose() {
      if (disposed) return;
      disposed = true;
      renderer.setAnimationLoop(null);
      releaseEmbeddedTextures();
      observer.disconnect();
      fly.dispose();
      controls.dispose();
      disposeModel(scene);
      renderer.dispose();
    },
  };
}
