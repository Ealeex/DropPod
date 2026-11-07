import { AnnotationMode, getDocument, GlobalWorkerOptions } from '/vendor/pdf/build/pdf.min.mjs';
import { EventBus, FindState, PDFFindController, PDFLinkService, PDFSinglePageViewer } from '/vendor/pdf/web/pdf_viewer.mjs';

import { button, showMessage } from './common.mjs';

GlobalWorkerOptions.workerSrc = '/vendor/pdf/build/pdf.worker.min.mjs';

export function render({ host, url }) {
  showMessage(host, 'Loading PDF…');
  return renderPdf(host, url);
}

export function renderPdf(host, source) {
  const view = document.createElement('div');
  view.className = 'pdf-preview';
  const toolbar = document.createElement('div');
  toolbar.className = 'pdf-toolbar';
  const status = document.createElement('span');
  status.className = 'meta';
  status.setAttribute('role', 'status');
  status.textContent = 'Loading PDF…';
  const page = document.createElement('input');
  page.type = 'number';
  page.min = 1;
  page.setAttribute('aria-label', 'Page number');
  const previous = button('Previous', () => viewer.previousPage());
  const next = button('Next', () => viewer.nextPage());
  const zoomOut = button('−', () => viewer.decreaseScale());
  zoomOut.setAttribute('aria-label', 'Zoom out');
  const zoomIn = button('+', () => viewer.increaseScale());
  zoomIn.setAttribute('aria-label', 'Zoom in');
  const fit = button('Fit width', () => { viewer.currentScaleValue = 'page-width'; });
  toolbar.append(previous, page, next, status, zoomOut, zoomIn, fit);
  const search = document.createElement('form');
  search.className = 'pdf-toolbar';
  const query = document.createElement('input');
  query.type = 'search';
  query.maxLength = 200;
  query.placeholder = 'Find in document';
  query.setAttribute('aria-label', 'Find in document');
  const findPrevious = button('Previous match', () => find(true));
  const findNext = button('Next match', () => find(false));
  const matches = document.createElement('span');
  matches.className = 'meta';
  matches.setAttribute('role', 'status');
  search.append(query, findPrevious, findNext, matches);
  search.addEventListener('submit', (event) => {
    event.preventDefault();
    find(false);
  });
  const controls = [previous, next, page, zoomIn, zoomOut, fit, query, findPrevious, findNext];
  controls.forEach((item) => { item.disabled = true; });

  const pageHost = document.createElement('div');
  pageHost.className = 'pdf-page-host';
  const container = document.createElement('div');
  container.className = 'pdf-page';
  const pages = document.createElement('div');
  pages.className = 'pdfViewer';
  container.append(pages);
  pageHost.append(container);
  view.append(toolbar, search, pageHost);
  host.replaceChildren(view);

  const lifetime = new AbortController();
  const { signal } = lifetime;
  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus });
  const findController = new PDFFindController({ eventBus, linkService });
  const viewer = new PDFSinglePageViewer({
    container, viewer: pages, eventBus, linkService, findController, abortSignal: signal,
    annotationMode: AnnotationMode.DISABLE, maxCanvasPixels: 4096 ** 2,
    enableAutoLinking: false,
  });
  linkService.setViewer(viewer);
  const loading = getDocument({
    ...(typeof source === 'string' ? { url: source } : { data: source }),
    cMapUrl: '/vendor/pdf/cmaps/',
    iccUrl: '/vendor/pdf/iccs/',
    standardFontDataUrl: '/vendor/pdf/standard_fonts/',
    wasmUrl: '/vendor/pdf/wasm/',
    useWasm: false,
    isEvalSupported: false,
  });

  let lastQuery;
  function find(backwards) {
    const value = query.value.trim();
    eventBus.dispatch('find', {
      source: search, query: value, type: value && value === lastQuery ? 'again' : '',
      highlightAll: true, findPrevious: backwards,
    });
    lastQuery = value;
    if (!value) matches.textContent = '';
  }

  query.addEventListener('input', () => {
    if (!query.value) find(false);
  });

  function updatePage() {
    const current = viewer.currentPageNumber;
    page.value = current;
    status.textContent = 'of ' + viewer.pagesCount;
    previous.disabled = current <= 1;
    next.disabled = current >= viewer.pagesCount;
  }

  page.addEventListener('change', () => {
    viewer.currentPageNumber = Math.max(1, Math.min(viewer.pagesCount, Math.trunc(page.valueAsNumber) || viewer.currentPageNumber));
    updatePage();
  });

  eventBus.on('pagesinit', () => {
    viewer.currentScaleValue = 'page-width';
    page.max = viewer.pagesCount;
    controls.forEach((item) => { item.disabled = false; });
    updatePage();
  }, { signal });
  eventBus.on('pagechanging', updatePage, { signal });

  function showMatches({ current, total }) {
    if (lastQuery && total) matches.textContent = current + ' of ' + total + ' matches';
  }
  eventBus.on('updatefindmatchescount', ({ matchesCount }) => showMatches(matchesCount), { signal });
  eventBus.on('updatefindcontrolstate', ({ state, matchesCount }) => {
    if (!query.value.trim()) return;
    if (state === FindState.NOT_FOUND) matches.textContent = 'No matches';
    else if (state === FindState.PENDING) matches.textContent = 'Searching…';
    else showMatches(matchesCount);
  }, { signal });

  loading.promise.then((pdf) => {
    if (signal.aborted) return;
    linkService.setDocument(pdf);
    viewer.setDocument(pdf);
  }).catch(() => {
    if (!signal.aborted) status.textContent = 'The PDF could not be opened.';
  });

  return () => {
    lifetime.abort();
    viewer.setDocument(null);
    linkService.setDocument(null);
    loading.destroy().catch(() => {});
  };
}
