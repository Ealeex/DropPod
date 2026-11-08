import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { fetchPreview, showMessage } from './common.mjs';
import { createFlyControls } from './fly-controls.mjs';
import { createOutdoorPreview } from './model-outdoors.mjs';

export const blankTexture = '/blank.png';

export function referenceName(value) {
  try {
    const url = new URL(value.replaceAll('\\', '/'), location.href);
    return decodeURIComponent(url.pathname.split('/').pop()).toLowerCase();
  } catch {
    return value.split(/[\\/]/).pop().toLowerCase();
  }
}

export function modelAssets(files, { resolve, onLoad } = {}) {
  const textures = new Map(files.filter((file) => file.preview === 'image').map((file) => [
    file.name.toLowerCase(), '/api/drive/files/' + encodeURIComponent(file.id) + '/preview',
  ]));
  const missing = new Set();
  const manager = new THREE.LoadingManager();
  if (onLoad) manager.onLoad = onLoad;
  manager.setURLModifier((url) => {
    const override = resolve?.(url);
    if (override) return override;
    if (/^(?:data|blob):/i.test(url)) return blankTexture;
    const name = referenceName(url);
    const texture = textures.get(name);
    if (!texture && name) missing.add(name);
    return texture || blankTexture;
  });
  return { manager, missing, textures };
}

export async function renderModel(context, parse, { loading = 'Loading 3D model…', useServerError = false, neutralLighting = false } = {}) {
  const { host, item, signal } = context;
  const errorMessage = 'Preview unavailable. The model could not be rendered.';
  showMessage(host, loading);
  const response = await fetchPreview(context, errorMessage, useServerError);
  let model;
  try {
    model = await parse(response);
    if (signal.aborted) {
      disposeModel(model.subject);
      model.release?.();
      return;
    }
    const subject = new THREE.Group();
    subject.add(model.subject);
    const viewer = createViewer(subject, item.name, model.missing || new Set(), neutralLighting);
    host.classList.add('model-mode');
    host.replaceChildren(viewer.element);
    return () => {
      viewer.dispose();
      model.release?.();
    };
  } catch (error) {
    if (model) {
      disposeModel(model.subject);
      model.release?.();
    }
    if (!signal.aborted && error.name !== 'AbortError') {
      console.error(error);
      throw new Error(errorMessage);
    }
  }
}

function disposeModel(subject) {
  subject.traverse((object) => {
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
}

function createViewer(subject, name, missing, neutralLighting) {
  const container = document.createElement('div');
  container.className = 'model-viewer';
  container.setAttribute('role', 'group');
  container.setAttribute('aria-label', `${name} 3D preview. Drag to rotate and scroll to zoom.`);

  const canvasHost = document.createElement('div');
  canvasHost.className = 'model-canvas';
  container.append(canvasHost);

  const hint = document.createElement('p');
  hint.className = 'model-hint';
  hint.textContent = 'Drag to rotate · Scroll to zoom · Ctrl+scroll for FOV';
  container.append(hint);

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
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', '3D viewport');
  canvasHost.append(canvas);

  const scene = new THREE.Scene();
  scene.add(subject);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 1000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.rotateSpeed = 0.9;
  controls.zoomSpeed = 0.8;
  controls.autoRotate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  controls.autoRotateSpeed = 0.9;

  if (neutralLighting) {
    // Blender's scene lights were authored for a different exposure and rendering pipeline.
    subject.traverse((object) => {
      if (object.isLight) object.intensity = 0;
    });
  }
  const ambient = new THREE.HemisphereLight(0xffffff, neutralLighting ? 0x404040 : 0x3c4050, neutralLighting ? 0.8 : 2.1);
  const key = new THREE.DirectionalLight(0xffffff, neutralLighting ? 1.6 : 2.8);
  key.position.set(4, 6, 5);
  const fill = new THREE.DirectionalLight(neutralLighting ? 0xffffff : 0x9db8ff, neutralLighting ? 0.55 : 1.1);
  fill.position.set(-5, 2, -2);
  const rim = new THREE.DirectionalLight(neutralLighting ? 0xffffff : 0xffd8aa, neutralLighting ? 0.55 : 1.4);
  rim.position.set(-2, 4, -6);
  const studioLights = [ambient, key, fill, rim];
  scene.add(...studioLights);

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
  subject.updateMatrixWorld(true);
  const groundPlane = box.min.y - sphere.center.y;
  const groundMeshes = [];
  subject.traverseVisible((object) => {
    if (object.isMesh) groundMeshes.push(object);
  });
  const floorRay = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
  const floorHits = [];
  const radius = sphere.radius;
  const gridClearance = Math.min(radius * 0.0001, 0.001);
  const groundGrid = new THREE.GridHelper(radius * 2.4, 24, 0x7cb6c4, 0x526570);
  groundGrid.position.y = groundPlane + gridClearance;
  groundGrid.visible = false;
  scene.add(groundGrid);
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
  const outdoors = createOutdoorPreview(scene, renderer, camera, radius, groundPlane, subject, groundMeshes, studioLights);

  const toolbar = document.createElement('div');
  toolbar.className = 'model-controls';
  toolbar.setAttribute('role', 'group');
  toolbar.setAttribute('aria-label', 'Camera controls');
  toolbar.innerHTML = `
    <button class="text-button" type="button" aria-pressed="true">Orbit</button>
    <button class="text-button" type="button" aria-pressed="false">Fly</button>
    <span class="model-gravity" role="status" hidden>Gravity on</span>
    <label hidden>Speed <input type="range" min="0.1" max="20" step="0.1" value="1"> <output aria-hidden="true">1.0×</output></label>`;
  const [orbitButton, flyButton] = toolbar.querySelectorAll('button');
  const speed = toolbar.querySelector('input');
  const speedLabel = toolbar.querySelector('label');
  const speedOutput = toolbar.querySelector('output');
  const gravityStatus = toolbar.querySelector('.model-gravity');
  let boost = 1;
  function updateSpeedDisplay() {
    speedOutput.value = (speed.valueAsNumber * boost).toFixed(1) + '×';
  }
  speed.addEventListener('input', updateSpeedDisplay);
  const fly = createFlyControls(camera, canvas, {
    findFloor(position, reach) {
      floorRay.ray.origin.copy(position);
      floorRay.far = reach;
      floorHits.length = 0;
      floorRay.intersectObjects(groundMeshes, false, floorHits);
      return floorHits[0]?.point.y ?? groundPlane;
    },
    onGridToggle() {
      groundGrid.visible = !groundGrid.visible;
    },
    onWorldToggle: outdoors.toggleWorld,
    onSunToggle: outdoors.toggleSun,
    onGravityChange(enabled, height, groundOffset) {
      const level = groundPlane + groundOffset;
      groundGrid.position.y = level + gridClearance;
      outdoors.setGroundLevel(level);
      gravityStatus.hidden = !enabled;
      const sign = groundOffset >= 0 ? '+' : '';
      gravityStatus.textContent = `Gravity · Eye ${height.toFixed(1)} m · Ground ${sign}${groundOffset.toFixed(1)} m`;
    },
    onSpeedStep(direction) {
      speed.stepUp(direction * Math.max(1, Math.round(speed.valueAsNumber * 1.5)));
      updateSpeedDisplay();
    },
    onBoostChange(multiplier) {
      boost = multiplier;
      updateSpeedDisplay();
    },
  });
  container.append(toolbar);
  const orbitPosition = new THREE.Vector3();
  const orbitNear = camera.near;
  let flying = false;
  function setFlyMode(enabled) {
    if (flying === enabled) return;
    flying = enabled;
    if (enabled) orbitPosition.copy(camera.position);
    else {
      camera.position.copy(orbitPosition);
      groundGrid.visible = false;
    }
    camera.near = enabled ? Math.max(radius / 10000, 0.00001) : orbitNear;
    camera.updateProjectionMatrix();
    controls.enabled = !enabled;
    fly.setEnabled(enabled);
    orbitButton.setAttribute('aria-pressed', String(!enabled));
    flyButton.setAttribute('aria-pressed', String(enabled));
    speedLabel.hidden = !enabled;
    hint.textContent = enabled
      ? 'WASD to move · Q down · E up · Right-click to capture · Scroll for speed while captured · G toggles gravity · V ground grid · Ctrl+V grass and sky · L sun and shadows · Space to jump · Numpad +/− for eye height · Ctrl+Numpad +/− for ground level · Ctrl+scroll for FOV · Shift doubles speed · Esc releases'
      : 'Drag to rotate · Scroll to zoom · Ctrl+scroll for FOV';
  }
  orbitButton.addEventListener('click', () => setFlyMode(false));
  flyButton.addEventListener('click', () => setFlyMode(true));

  let lastFrame = 0;
  renderer.setAnimationLoop((time) => {
    if (disposed) return;
    const delta = lastFrame ? Math.min((time - lastFrame) / 1000, 0.05) : 0;
    lastFrame = time;
    if (flying) fly.update(delta * radius * 0.6 * speed.valueAsNumber, delta);
    else controls.update();
    outdoors.update();
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
      fly.dispose();
      controls.dispose();
      disposeModel(subject);
      groundGrid.dispose();
      outdoors.dispose();
      renderer.dispose();
    },
  };
}
