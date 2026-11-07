import { getDocument, GlobalWorkerOptions } from '/vendor/pdf/build/pdf.min.mjs';

GlobalWorkerOptions.workerSrc = '/vendor/pdf/build/pdf.worker.min.mjs';

export function createPdfPreview(host, url) {
  const viewer = document.createElement('div');
  viewer.className = 'pdf-preview';
  const toolbar = document.createElement('div');
  toolbar.className = 'pdf-toolbar';
  const previous = document.createElement('button');
  previous.type = 'button';
  previous.className = 'text-button';
  previous.textContent = 'Previous';
  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'text-button';
  next.textContent = 'Next';
  const status = document.createElement('span');
  status.className = 'meta';
  status.setAttribute('role', 'status');
  status.textContent = 'Loading PDF…';
  previous.disabled = next.disabled = true;
  toolbar.append(previous, status, next);

  const pageHost = document.createElement('div');
  pageHost.className = 'pdf-page';
  viewer.append(toolbar, pageHost);
  host.replaceChildren(viewer);

  const loading = getDocument({
    url,
    cMapUrl: '/vendor/pdf/cmaps/',
    iccUrl: '/vendor/pdf/iccs/',
    standardFontDataUrl: '/vendor/pdf/standard_fonts/',
    wasmUrl: '/vendor/pdf/wasm/',
    useWasm: false,
  });
  let pdf;
  let pageNumber = 1;
  let renderTask;
  let version = 0;
  let disposed = false;
  let lastWidth = 0;
  let resizeTimer;

  async function drawPage() {
    if (disposed || !pdf) return;
    const current = ++version;
    const number = pageNumber;
    renderTask?.cancel();
    previous.disabled = number === 1;
    next.disabled = number === pdf.numPages;
    status.textContent = `Page ${number} of ${pdf.numPages}`;
    try {
      const page = await pdf.getPage(number);
      if (disposed || version !== current) return;
      const unscaled = page.getViewport({ scale: 1 });
      const width = Math.max(pageHost.clientWidth - 16, 1);
      const displayScale = width / unscaled.width;
      const resolution = Math.min(
        displayScale * Math.min(devicePixelRatio || 1, 2),
        4096 / Math.max(unscaled.width, unscaled.height),
      );
      const viewport = page.getViewport({ scale: resolution });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      canvas.style.width = `${width}px`;
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `PDF page ${number}`);
      renderTask = page.render({ canvas, viewport });
      await renderTask.promise;
      if (!disposed && version === current) pageHost.replaceChildren(canvas);
    } catch {
      if (!disposed && version === current) {
        pageHost.replaceChildren();
        status.textContent = `Page ${number} could not be rendered.`;
      }
    }
  }

  function turnPage(offset) {
    pageNumber += offset;
    pageHost.scrollTop = 0;
    drawPage();
  }
  previous.addEventListener('click', () => turnPage(-1));
  next.addEventListener('click', () => turnPage(1));

  const observer = new ResizeObserver(() => {
    const width = pageHost.clientWidth;
    if (width === lastWidth) return;
    lastWidth = width;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawPage, 120);
  });
  observer.observe(pageHost);
  loading.promise.then((document) => {
    if (disposed) return;
    pdf = document;
    drawPage();
  }).catch(() => {
    if (!disposed) status.textContent = 'The PDF could not be opened.';
  });

  return () => {
    disposed = true;
    clearTimeout(resizeTimer);
    observer.disconnect();
    renderTask?.cancel();
    loading.destroy().catch(() => {});
  };
}
