import { fetchPreview, showMessage } from './common.mjs';

export async function render(context) {
  const { host, signal } = context;
  showMessage(host, 'Preparing Office preview…');
  const response = await fetchPreview(context, 'This Office file could not be opened.', true);
  const bytes = await response.arrayBuffer();
  signal.throwIfAborted();
  showMessage(host, 'Loading PDF…');
  const { renderPdf } = await import('./pdf.mjs');
  signal.throwIfAborted();
  return renderPdf(host, bytes);
}
