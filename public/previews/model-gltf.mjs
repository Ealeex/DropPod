import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { blankTexture, modelAssets, referenceName, renderModel } from './model.mjs';

export function render(context) {
  return renderGltf(context, { binary: /\.glb$/i.test(context.item.name) });
}

export function renderGltf(context, { binary, loading, useServerError, neutralLighting } = {}) {
  const { files, signal } = context;
  return renderModel(context, async (response) => {
    const data = binary ? await response.arrayBuffer() : await response.text();
    signal.throwIfAborted();
    const buffers = new Map(files.filter((file) => /\.bin$/i.test(file.name)).map((file) => [
      file.name.toLowerCase(), '/api/drive/files/' + encodeURIComponent(file.id) + '/model-buffer',
    ]));
    const { manager, missing } = modelAssets(files, {
      resolve(url) {
        if (url.startsWith('blob:' + location.origin + '/')) return url;
        if (/^data:(?:application\/(?:octet-stream|gltf-buffer)|image\/(?:jpeg|png|webp|avif));base64,/i.test(url)) return url;
        if (/^(?:data|blob):/i.test(url)) return blankTexture;
        const name = referenceName(url);
        if (/\.bin$/i.test(name)) return buffers.get(name) || '/api/drive/missing-model-buffer';
      },
    });
    const loader = new GLTFLoader(manager);
    loader.register((parser) => {
      for (const asset of [...(parser.json.buffers || []), ...(parser.json.images || [])]) {
        if (typeof asset.uri === 'string' && /^blob:/i.test(asset.uri)) {
          throw new Error('External blob references are unavailable.');
        }
      }
      return { name: 'DropPodAssetPolicy' };
    });
    const model = await loader.parseAsync(data, '');
    return { subject: model.scene, missing };
  }, { loading, useServerError, neutralLighting });
}
