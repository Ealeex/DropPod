import { showMessage } from './common.mjs';

const renderers = {
  archive: 'archive',
  audio: 'audio',
  image: 'png',
  pdf: 'pdf',
  spreadsheet: 'xlsx',
  text: 'text',
  video: 'mp4',
};

const formatRenderers = {
  office: { docx: 'docx', pptx: 'pptx' },
  model: { dae: 'model-dae', obj: 'model-obj', fbx: 'model-fbx', gltf: 'model-gltf', glb: 'model-gltf', stl: 'model-stl' },
};

export async function renderPreview(context) {
  const { item, host, signal, archiveEntry } = context;
  const fallback = archiveEntry
    ? 'Preview unavailable for this entry.'
    : 'Preview unavailable. Download the file to open it.';
  const extension = item.name.split('.').pop().toLowerCase();
  const name = renderers[item.preview] || formatRenderers[item.preview]?.[extension];
  if (!name) {
    showMessage(host, fallback);
    return;
  }
  try {
    const { render } = await import('./' + name + '.mjs');
    if (signal.aborted) return;
    const dispose = await render({ ...context, fallback });
    if (signal.aborted) dispose?.();
    else return dispose;
  } catch (error) {
    if (!signal.aborted) showMessage(host, archiveEntry ? fallback : error.message || fallback);
  }
}
