import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import { modelAssets, referenceName, renderModel } from './model.mjs';

export function render(context) {
  return renderModel(context, async (response) => {
    const text = await response.text();
    context.signal.throwIfAborted();
    const { manager, missing, textures } = modelAssets(context.files);
    for (const name of textureNames(text)) {
      if (!textures.has(name)) missing.add(name);
    }
    return { subject: new ColladaLoader(manager).parse(text, '').scene, missing };
  });
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
