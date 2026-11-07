function button(label, action) {
  const control = document.createElement('button');
  control.type = 'button';
  control.className = 'text-button';
  control.textContent = label;
  control.addEventListener('click', action);
  return control;
}

function toolbar(...controls) {
  const element = document.createElement('div');
  element.className = 'preview-tools';
  element.append(...controls);
  return element;
}

function caption(text) {
  const element = document.createElement('p');
  element.className = 'preview-message';
  element.textContent = text;
  return element;
}

function cellLabel(index) {
  let label = '';
  for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) {
    label = String.fromCharCode(65 + (n - 1) % 26) + label;
  }
  return label;
}

function grid(rows, truncated = false) {
  if (!rows.length) return caption('This sheet is empty.');
  const container = document.createElement('div');
  container.className = 'preview-grid';
  const table = document.createElement('table');
  const visible = rows.slice(0, 500);
  const columns = Math.min(50, Math.max(...visible.map((row) => row.length)));
  const headers = table.createTHead().insertRow();
  for (let index = -1; index < columns; index++) {
    const header = document.createElement('th');
    header.scope = 'col';
    header.textContent = index < 0 ? '#' : cellLabel(index);
    headers.append(header);
  }
  const body = table.createTBody();
  for (const [index, values] of visible.entries()) {
    const row = body.insertRow();
    const header = document.createElement('th');
    header.scope = 'row';
    header.textContent = String(index + 1);
    row.append(header);
    for (let column = 0; column < columns; column++) {
      row.insertCell().textContent = String(values[column] ?? '');
    }
  }
  container.append(table);
  if (truncated || rows.length > 500 || visible.some((row) => row.length > 50)) {
    container.append(caption('Showing up to 500 rows and 50 columns. Download the file for the full data.'));
  }
  return container;
}

let markdown;
let csv;
export async function createRichText(text, name) {
  if (/\.md$/i.test(name)) {
    markdown ||= import('/vendor/preview/markdown-it.mjs').then(({ default: createMarkdown }) => {
      const parser = createMarkdown({ html: false });
      const validateLink = parser.validateLink;
      parser.validateLink = (url) => validateLink(url) && /^(?:https?:\/\/|mailto:)/i.test(url);
      parser.renderer.rules.image = (tokens, index) => parser.utils.escapeHtml(tokens[index].content);
      parser.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
        tokens[index].attrSet('target', '_blank');
        tokens[index].attrSet('rel', 'noopener noreferrer');
        return renderer.renderToken(tokens, index, options);
      };
      return parser;
    });
    const article = document.createElement('article');
    article.className = 'preview-markdown';
    article.innerHTML = (await markdown).render(text);
    return article;
  }

  csv ||= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/preview/papaparse.js';
    script.onload = () => resolve(window.Papa);
    script.onerror = reject;
    document.head.append(script);
  });
  const parsed = (await csv).parse(text, { delimiter: /\.tsv$/i.test(name) ? '\t' : ',', preview: 501, skipEmptyLines: true });
  return grid(parsed.data, parsed.meta.truncated);
}

export function createSpreadsheet(host, bytes) {
  const worker = new Worker(new URL('./spreadsheet-preview-worker.mjs', import.meta.url), { type: 'module' });
  const tabs = toolbar();
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', 'Worksheet');
  const content = document.createElement('div');
  content.replaceChildren(caption('Reading workbook…'));
  host.replaceChildren(tabs, content);
  let selected = 0;
  let timer = setTimeout(failed, 15_000);

  function failed() {
    clearTimeout(timer);
    worker.terminate();
    content.replaceChildren(caption('This workbook could not be read.'));
  }

  worker.onerror = failed;
  worker.onmessage = ({ data }) => {
    if (data.error) return failed();
    if (data.names) {
      tabs.replaceChildren(...data.names.map((name, index) => button(name, () => select(index))));
      select(0);
    } else if (selected === data.index) {
      clearTimeout(timer);
      content.replaceChildren(grid(data.rows, data.truncated));
    }
  };

  function select(index) {
    selected = index;
    [...tabs.children].forEach((tab, i) => tab.setAttribute('aria-pressed', String(i === selected)));
    content.replaceChildren(caption('Reading worksheet…'));
    clearTimeout(timer);
    timer = setTimeout(failed, 15_000);
    worker.postMessage({ index });
  }

  worker.postMessage({ bytes }, [bytes]);
  return () => {
    clearTimeout(timer);
    worker.terminate();
  };
}

export function createImagePreview(image) {
  const viewport = document.createElement('div');
  viewport.className = 'preview-image-viewport';
  viewport.tabIndex = 0;
  viewport.setAttribute('aria-label', 'Pan image');
  const stage = document.createElement('div');
  stage.className = 'preview-image-stage';
  viewport.append(stage);
  stage.append(image);
  image.draggable = false;

  let zoom = 1;
  let angle = 0;
  let pointer;
  const out = button('−', () => setZoom(zoom / 1.5));
  out.setAttribute('aria-label', 'Zoom out');
  const inwards = button('+', () => setZoom(zoom * 1.5));
  inwards.setAttribute('aria-label', 'Zoom in');
  const tools = toolbar(
    out, inwards,
    button('Rotate', () => { angle = (angle + 90) % 360; layout(); }),
    button('Fit', () => setZoom(1)),
  );
  const element = document.createElement('div');
  element.className = 'preview-image';
  element.append(tools, viewport);

  function setZoom(value) {
    zoom = Math.min(8, Math.max(1, value));
    layout();
  }

  function layout() {
    const { naturalWidth, naturalHeight } = image;
    if (!naturalWidth || !naturalHeight) return;
    const swapped = angle % 180 !== 0;
    const width = swapped ? naturalHeight : naturalWidth;
    const height = swapped ? naturalWidth : naturalHeight;
    const fit = Math.min(viewport.clientWidth / width, viewport.clientHeight / height, 1);
    const scale = fit * zoom;
    stage.style.width = Math.ceil(width * scale) + 'px';
    stage.style.height = Math.ceil(height * scale) + 'px';
    image.style.width = naturalWidth * scale + 'px';
    image.style.height = naturalHeight * scale + 'px';
    image.style.transform = 'translate(-50%, -50%) rotate(' + angle + 'deg)';
    out.disabled = zoom <= 1;
    inwards.disabled = zoom >= 8;
    viewport.classList.toggle('is-zoomed', zoom > 1);
  }

  viewport.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || zoom === 1) return;
    viewport.setPointerCapture(event.pointerId);
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
  });
  viewport.addEventListener('pointermove', (event) => {
    if (pointer?.id !== event.pointerId) return;
    viewport.scrollLeft = pointer.left + pointer.x - event.clientX;
    viewport.scrollTop = pointer.top + pointer.y - event.clientY;
  });
  viewport.addEventListener('lostpointercapture', () => { pointer = null; });
  const observer = new ResizeObserver(layout);
  observer.observe(viewport);
  image.addEventListener('load', layout);
  return { element, dispose: () => observer.disconnect() };
}
