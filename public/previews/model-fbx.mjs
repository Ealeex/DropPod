import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { modelAssets, renderModel } from './model.mjs';

export function render(context) {
  return renderModel(context, async (response) => {
    const buffer = await response.arrayBuffer();
    context.signal.throwIfAborted();
    const embedded = new Set();
    function release() {
      for (const url of embedded) URL.revokeObjectURL(url);
      embedded.clear();
    }
    const { manager, missing } = modelAssets(context.files, {
      resolve(url) {
        if (url.startsWith('blob:' + location.origin + '/')) {
          embedded.add(url);
          return url;
        }
        if (/^data:image\/(?:bmp|jpeg|png|webp);base64,/i.test(url)) return url;
      },
      onLoad: release,
    });
    try {
      return { subject: new FBXLoader(manager).parse(buffer, ''), missing, release };
    } catch (error) {
      release();
      throw error;
    }
  });
}
