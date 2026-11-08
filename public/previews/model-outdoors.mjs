import {
  CanvasTexture, DirectionalLight, Fog, HemisphereLight, Mesh, MeshStandardMaterial,
  PlaneGeometry, RepeatWrapping, SRGBColorSpace, Vector3,
} from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

const sunDirection = new Vector3(0.45, 0.88, 0.25).normalize();
const grassTileSize = 2;

function grassTexture(renderer) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const context = canvas.getContext('2d');
  context.fillStyle = '#53763b';
  context.fillRect(0, 0, 128, 128);
  const colors = ['#658a46', '#3f602f', '#758f50', '#4c7035'];
  let seed = 2639;
  function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  }
  for (let i = 0; i < 2900; i++) {
    const x = Math.floor(random() * 128);
    const y = Math.floor(random() * 128);
    const length = 1 + Math.floor(random() * 4);
    context.fillStyle = colors[i % colors.length];
    context.fillRect(x, y, 1, length);
    if (y + length > 128) context.fillRect(x, y - 128, 1, length);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
  return texture;
}

export function createOutdoorPreview(scene, renderer, camera, radius, level, subject, meshes, studioLights) {
  const sky = new Sky();
  sky.scale.setScalar(camera.far);
  sky.material.uniforms.sunPosition.value.copy(sunDirection).multiplyScalar(450000);
  sky.material.uniforms.cloudCoverage.value = 0;
  sky.material.uniforms.mieCoefficient.value = 0.002;
  sky.visible = false;
  sky.frustumCulled = false;

  // Follow the camera in whole texture tiles so the grass pattern stays fixed in world space.
  const extent = Math.ceil(camera.far / grassTileSize) * grassTileSize;
  const texture = grassTexture(renderer);
  texture.repeat.setScalar(extent * 2 / grassTileSize);
  const grass = new Mesh(new PlaneGeometry(extent * 2, extent * 2), new MeshStandardMaterial({ map: texture }));
  grass.rotation.x = -Math.PI / 2;
  grass.position.y = level;
  grass.receiveShadow = true;
  grass.visible = false;
  const fog = new Fog(0xbad6e6, camera.far * 0.22, camera.far * 0.92);

  const sun = new DirectionalLight(0xfff4dd, 2.8);
  sun.position.copy(sunDirection).multiplyScalar(radius * 4);
  sun.castShadow = true;
  sun.visible = false;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.autoUpdate = false;
  sun.shadow.bias = -0.00015;
  sun.shadow.normalBias = radius * 0.001;
  const shadowSize = radius * 2;
  Object.assign(sun.shadow.camera, {
    left: -shadowSize, right: shadowSize, top: shadowSize, bottom: -shadowSize,
    near: Math.max(radius * 0.01, 0.0001), far: radius * 8,
  });
  sun.shadow.camera.updateProjectionMatrix();
  const fill = new HemisphereLight(0xd5e9ff, 0x65784a, 1);
  fill.visible = false;
  const importedLights = new Map();
  subject.traverse((object) => {
    if (object.isLight) importedLights.set(object, object.intensity);
  });
  scene.add(sky, grass, sun, fill);

  return {
    toggleWorld() {
      sky.visible = grass.visible = !grass.visible;
      scene.fog = grass.visible ? fog : null;
    },
    toggleSun() {
      const enabled = !sun.visible;
      sun.visible = fill.visible = enabled;
      renderer.shadowMap.enabled = enabled;
      for (const light of studioLights) light.visible = !enabled;
      for (const [light, intensity] of importedLights) light.intensity = enabled ? 0 : intensity;
      for (const mesh of meshes) mesh.castShadow = mesh.receiveShadow = enabled;
      if (enabled) sun.shadow.needsUpdate = true;
    },
    setGroundLevel(value) {
      grass.position.y = value;
    },
    update() {
      if (!grass.visible) return;
      sky.position.copy(camera.position);
      grass.position.x = Math.floor(camera.position.x / grassTileSize) * grassTileSize;
      grass.position.z = Math.floor(camera.position.z / grassTileSize) * grassTileSize;
    },
    dispose() {
      sky.geometry.dispose();
      sky.material.dispose();
      grass.geometry.dispose();
      grass.material.dispose();
      texture.dispose();
      sun.dispose();
    },
  };
}
