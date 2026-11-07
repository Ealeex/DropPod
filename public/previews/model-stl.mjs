import { DoubleSide, Mesh, MeshStandardMaterial } from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { renderModel } from './model.mjs';

export function render(context) {
  return renderModel(context, async (response) => {
    const buffer = await response.arrayBuffer();
    context.signal.throwIfAborted();
    const geometry = new STLLoader().parse(buffer);
    const material = new MeshStandardMaterial({
      color: geometry.hasColors ? 0xffffff : 0xb7c9db,
      vertexColors: Boolean(geometry.hasColors),
      side: DoubleSide,
    });
    return { subject: new Mesh(geometry, material) };
  });
}
