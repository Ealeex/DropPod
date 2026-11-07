import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { modelAssets, referenceName, renderModel } from './model.mjs';

export function render(context) {
  const { files, signal } = context;
  return renderModel(context, async (response) => {
    const text = await response.text();
    const materials = await loadObjMaterials(text, files, signal);
    signal.throwIfAborted();
    const { manager, missing } = modelAssets(files);
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
    return { subject: loader.parse(text), missing };
  });
}

async function loadObjMaterials(text, files, signal) {
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
    const response = await fetch(`/api/drive/files/${encodeURIComponent(id)}/preview`, { signal });
    return response.ok ? response.text() : '';
  }));
  return materials.join('\n');
}
