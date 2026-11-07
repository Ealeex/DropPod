import { renderGltf } from './model-gltf.mjs';

export function render(context) {
  return renderGltf({ ...context, files: [] }, {
    binary: true, loading: 'Preparing Blender preview…', useServerError: true, neutralLighting: true,
  });
}
