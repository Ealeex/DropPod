import * as THREE from 'three';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

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

export async function createModelPreview({ text, buffer, name, files = [], materials = '' }) {
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

  const isObj = /\.obj$/i.test(name);
  const isFbx = /\.fbx$/i.test(name);
  const isGltf = /\.gl(?:b|tf)$/i.test(name);
  const isStl = /\.stl$/i.test(name);
  const missing = new Set(/\.dae$/i.test(name) ? textureNames(text).filter((reference) => !textureUrls.has(reference)) : []);
  const buffers = new Map(files.filter((file) => /\.bin$/i.test(file.name)).map((file) => [
    file.name.toLowerCase(), '/api/drive/files/' + encodeURIComponent(file.id) + '/model-buffer',
  ]));
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
    if (isGltf && url.startsWith('blob:' + location.origin + '/')) return url;
    if (isFbx && url.startsWith(`blob:${location.origin}/`)) {
      embeddedUrls.add(url);
      return url;
    }
    if (isFbx && /^data:image\/(?:bmp|jpeg|png|webp);base64,/i.test(url)) return url;
    if (isGltf && /^data:(?:application\/(?:octet-stream|gltf-buffer)|image\/(?:jpeg|png|webp|avif));base64,/i.test(url)) return url;
    if (url.startsWith('data:') || url.startsWith('blob:')) return blankTexture;
    if (isGltf) {
      const fileName = referenceName(url);
      const asset = buffers.get(fileName) || textureUrls.get(fileName);
      if (!asset) missing.add(fileName);
      // Return a local failure for missing binary data and a placeholder for missing images.
      return asset || (/\.bin$/i.test(fileName) ? '/api/drive/missing-model-buffer' : blankTexture);
    }
    const fileName = referenceName(url);
    const texture = textureUrls.get(fileName);
    if (!texture && (isObj || isFbx) && fileName) missing.add(fileName);
    return texture || blankTexture;
  });

  const subject = new THREE.Group();
  if (isFbx) {
    try {
      subject.add(new FBXLoader(manager).parse(buffer, ''));
    } catch (error) {
      releaseEmbeddedTextures();
      throw error;
    }
  } else if (isGltf) {
    const loader = new GLTFLoader(manager);
    loader.register((parser) => {
      for (const asset of [...(parser.json.buffers || []), ...(parser.json.images || [])]) {
        if (typeof asset.uri === 'string' && /^blob:/i.test(asset.uri)) {
          throw new Error('External blob references are unavailable.');
        }
      }
      return { name: 'DropPodAssetPolicy' };
    });
    const model = await loader.parseAsync(buffer || text, '');
    subject.add(model.scene);
  } else if (isStl) {
    const geometry = new STLLoader().parse(buffer);
    subject.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
      color: geometry.hasColors ? 0xffffff : 0xb7c9db,
      vertexColors: Boolean(geometry.hasColors),
      side: THREE.DoubleSide,
    })));
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
    warning.textContent = 'Model textures missing from this folder: ' + [...missing].join(', ');
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
      releaseEmbeddedTextures();
      observer.disconnect();
      controls.dispose();
      scene.traverse((object) => {
        object.geometry?.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          if (!material) continue;
          for (const value of Object.values(material)) {
            if (value?.isTexture) value.dispose();
          }
          material.dispose();
        }
      });
      renderer.dispose();
    },
  };
}
